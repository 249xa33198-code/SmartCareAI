import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "crypto";

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!serviceAccountJson) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is missing");
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
});
const db = admin.firestore();
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "32kb" }));

const DEPARTMENTS = ["Emergency", "General Medicine", "Pediatrics", "Orthopedics", "Cardiology"];
const PRIORITY_RANK: Record<string, number> = { critical: 0, urgent: 1, standard: 2, routine: 3 };
const OPEN_STATUSES = ["registered", "waiting", "in_triage", "in_consultation"];
type StaffRequest = Request & { staff?: { uid: string; email: string; role: string; displayName: string } };

function error(res: Response, status: number, message: string) { return res.status(status).json({ error: message }); }
function publicPatient(doc: FirebaseFirestore.DocumentSnapshot) {
  const p = doc.data()!;
  return { token: p.token, status: p.status, department: p.department, registeredAt: p.registeredAt };
}
function staffPatient(doc: FirebaseFirestore.DocumentSnapshot) {
  const p = doc.data()!;
  return { id: doc.id, token: p.token, name: p.name, age: p.age, department: p.department,
    symptoms: p.symptoms, contact: p.contact || "", status: p.status, registeredAt: p.registeredAt,
    triage: p.priority ? { priority: p.priority, notes: p.notes || "", assessedBy: p.assessedBy || "", assessedAt: p.assessedAt || "" } : null };
}
async function requireStaff(req: StaffRequest, res: Response, next: NextFunction) {
  try {
    const h = req.header("authorization") || "";
    if (!h.startsWith("Bearer ")) return error(res, 401, "Please sign in with an authorised staff account.");
    const decoded = await admin.auth().verifyIdToken(h.slice(7));
    const profileDoc = await db.collection("staffUsers").doc(decoded.uid).get();
    if (!profileDoc.exists || profileDoc.data()?.active !== true) return error(res, 403, "This account is not authorised as active healthcare staff.");
    const p = profileDoc.data()!;
    req.staff = { uid: decoded.uid, email: decoded.email || "", role: p.role || "staff", displayName: p.displayName || decoded.email || "Staff" };
    next();
  } catch { return error(res, 401, "Your staff session is invalid. Sign in again."); }
}
app.get("/health", (_req, res) => res.json({ ok: true, service: "SmartCare Firebase API" }));
app.get("/departments", (_req, res) => res.json({ departments: DEPARTMENTS }));

app.post("/patients/register", async (req, res) => {
  try {
    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const symptoms = typeof b.symptoms === "string" ? b.symptoms.trim() : "";
    const age = Number(b.age);
    if (name.length < 2 || name.length > 80 || !Number.isInteger(age) || age < 0 || age > 120 ||
      !DEPARTMENTS.includes(b.department) || symptoms.length < 5 || symptoms.length > 1000)
      return error(res, 400, "Please provide a valid name, age, department and symptoms.");
    const contact = typeof b.contact === "string" ? b.contact.trim().slice(0, 150) : "";
    const token = "SC-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const now = new Date().toISOString();
    const doc = await db.collection("patients").add({ token, name, age, department: b.department, symptoms, contact,
      status: "waiting", priority: null, notes: "", assessedBy: "", assessedAt: null,
      registeredAt: now, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.status(201).json({ id: doc.id, token, status: "waiting", department: b.department, registeredAt: now });
  } catch (e) { console.error("registration failed", e); return error(res, 500, "Could not register patient. Please try again."); }
});
app.get("/patients/status/:token", async (req, res) => {
  try {
    const snap = await db.collection("patients").where("token", "==", req.params.token).limit(1).get();
    if (snap.empty) return error(res, 404, "Token not found.");
    return res.json(publicPatient(snap.docs[0]));
  } catch { return error(res, 500, "Could not load token status."); }
});
app.get("/queue/public", async (_req, res) => {
  try {
    const snap = await db.collection("patients").where("status", "in", OPEN_STATUSES).get();
    const entries = snap.docs.map(d => { const p=d.data(); return { token:p.token, department:p.department, status:p.status, priority:p.priority || null, registeredAt:p.registeredAt }; })
      .sort((a,b) => (PRIORITY_RANK[a.priority || ""] ?? 4) - (PRIORITY_RANK[b.priority || ""] ?? 4) || String(a.registeredAt).localeCompare(String(b.registeredAt)));
    return res.json({ updatedAt: new Date().toISOString(), entries });
  } catch { return error(res, 500, "Could not load public queue."); }
});
app.get("/staff/patients", requireStaff, async (_req: StaffRequest, res) => {
  try {
    const snap = await db.collection("patients").orderBy("registeredAt", "desc").limit(500).get();
    const patients = snap.docs.map(staffPatient).sort((a,b) => {
      const openA = !["completed","cancelled"].includes(a.status) ? 0 : 1;
      const openB = !["completed","cancelled"].includes(b.status) ? 0 : 1;
      const rankA = PRIORITY_RANK[a.triage?.priority || ""] ?? 4;
      const rankB = PRIORITY_RANK[b.triage?.priority || ""] ?? 4;
      return openA-openB || rankA-rankB || String(a.registeredAt).localeCompare(String(b.registeredAt));
    });
    return res.json({ patients });
  } catch { return error(res, 500, "Could not load staff queue."); }
});
app.get("/staff/patients/:id", requireStaff, async (req: StaffRequest, res) => {
  try {
    const doc = await db.collection("patients").doc(req.params.id).get();
    return doc.exists ? res.json(staffPatient(doc)) : error(res, 404, "Patient not found.");
  } catch { return error(res, 500, "Could not load patient details."); }
});
app.patch("/staff/patients/:id/triage", requireStaff, async (req: StaffRequest, res) => {
  const b = req.body || {}, statuses = ["registered","waiting","in_triage","in_consultation","completed","cancelled"];
  if (!Object.keys(PRIORITY_RANK).includes(b.priority) || !statuses.includes(b.status) || (typeof b.notes === "string" && b.notes.length > 2000))
    return error(res, 400, "Choose a valid priority and status. Notes must be 2000 characters or fewer.");
  if (!["nurse","physician","admin"].includes(req.staff!.role)) return error(res, 403, "Your staff role cannot record triage assessments.");
  try {
    const ref = db.collection("patients").doc(req.params.id), doc = await ref.get();
    if (!doc.exists) return error(res, 404, "Patient not found.");
    const now = new Date().toISOString();
    await ref.update({ priority:b.priority, status:b.status, notes:typeof b.notes==="string"?b.notes.trim():"", assessedBy:req.staff!.email,
      assessedAt:now, updatedAt:admin.firestore.FieldValue.serverTimestamp() });
    return res.json(staffPatient(await ref.get()));
  } catch { return error(res, 500, "Could not save assessment."); }
});
app.use((_req, res) => error(res, 404, "API route not found."));
export const api = onRequest({ region: "us-central1", maxInstances: 10 }, app);
