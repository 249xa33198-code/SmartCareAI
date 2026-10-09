import * as admin from "firebase-admin";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "crypto";

// Firebase Admin configuration
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!admin.apps.length) {
  if (serviceAccountJson) {
    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(serviceAccountJson)
      ),
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  } else {
    throw new Error(
      "Configure FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS."
    );
  }
}

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "32kb" }));

const DEPARTMENTS = [
  "Emergency",
  "General Medicine",
  "Pediatrics",
  "Orthopedics",
  "Cardiology",
];

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  urgent: 1,
  standard: 2,
  routine: 3,
};

const OPEN_STATUSES = [
  "registered",
  "waiting",
  "in_triage",
  "in_consultation",
];

type StaffRequest = Request & {
  staff?: {
    uid: string;
    email: string;
    role: string;
    displayName: string;
  };
};

function sendError(
  res: Response,
  status: number,
  message: string
) {
  return res.status(status).json({ error: message });
}

function publicPatient(
  doc: FirebaseFirestore.DocumentSnapshot
) {
  const p = doc.data()!;

  return {
    token: p.token,
    status: p.status,
    department: p.department,
    registeredAt: p.registeredAt,
  };
}

function staffPatient(
  doc: FirebaseFirestore.DocumentSnapshot
) {
  const p = doc.data()!;

  return {
    id: doc.id,
    token: p.token,
    name: p.name,
    age: p.age,
    department: p.department,
    symptoms: p.symptoms,
    contact: p.contact || "",
    status: p.status,
    registeredAt: p.registeredAt,
    triage: p.priority
      ? {
          priority: p.priority,
          notes: p.notes || "",
          assessedBy: p.assessedBy || "",
          assessedAt: p.assessedAt || "",
        }
      : null,
  };
}

// Authenticate active healthcare staff.
async function requireStaff(
  req: StaffRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authorization = req.header("authorization") || "";

    if (!authorization.startsWith("Bearer ")) {
      return sendError(
        res,
        401,
        "Please sign in with an authorised staff account."
      );
    }

    const decoded = await admin
      .auth()
      .verifyIdToken(authorization.slice(7));

    const profileDoc = await db
      .collection("staffUsers")
      .doc(decoded.uid)
      .get();

    if (
      !profileDoc.exists ||
      profileDoc.data()?.active !== true
    ) {
      return sendError(
        res,
        403,
        "This account is not authorised as active healthcare staff."
      );
    }

    const profile = profileDoc.data()!;

    req.staff = {
      uid: decoded.uid,
      email: decoded.email || "",
      role: profile.role || "staff",
      displayName:
        profile.displayName || decoded.email || "Staff",
    };

    return next();
  } catch (error) {
    console.error("Staff authentication failed:", error);

    return sendError(
      res,
      401,
      "Your staff session is invalid. Sign in again."
    );
  }
}

// Health check
app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    service: "SmartCare API",
  });
});

// Available departments
app.get("/departments", (_req, res) => {
  return res.json({ departments: DEPARTMENTS });
});

// Register a patient
app.post("/patients/register", async (req, res) => {
  try {
    const body = req.body || {};

    const name =
      typeof body.name === "string"
        ? body.name.trim()
        : "";

    const symptoms =
      typeof body.symptoms === "string"
        ? body.symptoms.trim()
        : "";

    const age = Number(body.age);

    if (
      name.length < 2 ||
      name.length > 80 ||
      !Number.isInteger(age) ||
      age < 0 ||
      age > 120 ||
      !DEPARTMENTS.includes(body.department) ||
      symptoms.length < 5 ||
      symptoms.length > 1000
    ) {
      return sendError(
        res,
        400,
        "Please provide a valid name, age, department and symptoms."
      );
    }

    const contact =
      typeof body.contact === "string"
        ? body.contact.trim().slice(0, 150)
        : "";

    const token =
      "SC-" +
      randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

    const now = new Date().toISOString();

    const doc = await db.collection("patients").add({
      token,
      name,
      age,
      department: body.department,
      symptoms,
      contact,
      status: "waiting",
      priority: null,
      notes: "",
      assessedBy: "",
      assessedAt: null,
      registeredAt: now,
      createdAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(201).json({
      id: doc.id,
      token,
      status: "waiting",
      department: body.department,
      registeredAt: now,
    });
  } catch (error) {
    console.error("Patient registration failed:", error);

    return sendError(
      res,
      500,
      "Could not register patient. Please try again."
    );
  }
});

// Check a patient's token
app.get("/patients/status/:token", async (req, res) => {
  try {
    const snap = await db
      .collection("patients")
      .where("token", "==", req.params.token)
      .limit(1)
      .get();

    if (snap.empty) {
      return sendError(res, 404, "Token not found.");
    }

    return res.json(publicPatient(snap.docs[0]));
  } catch (error) {
    console.error("Status lookup failed:", error);

    return sendError(
      res,
      500,
      "Could not load token status."
    );
  }
});

// Public patient queue
app.get("/queue/public", async (_req, res) => {
  try {
    const snap = await db
      .collection("patients")
      .where("status", "in", OPEN_STATUSES)
      .get();

    const entries = snap.docs
      .map((doc) => {
        const p = doc.data();

        return {
          token: p.token,
          department: p.department,
          status: p.status,
          priority: p.priority || null,
          registeredAt: p.registeredAt,
        };
      })
      .sort(
        (a, b) =>
          (PRIORITY_RANK[a.priority || ""] ?? 4) -
            (PRIORITY_RANK[b.priority || ""] ?? 4) ||
          String(a.registeredAt).localeCompare(
            String(b.registeredAt)
          )
      );

    return res.json({
      updatedAt: new Date().toISOString(),
      entries,
    });
  } catch (error) {
    console.error("Public queue failed:", error);

    return sendError(
      res,
      500,
      "Could not load public queue."
    );
  }
});

// Staff patient queue
app.get(
  "/staff/patients",
  requireStaff,
  async (_req: StaffRequest, res) => {
    try {
      const snap = await db
        .collection("patients")
        .orderBy("registeredAt", "desc")
        .limit(500)
        .get();

      const patients = snap.docs
        .map(staffPatient)
        .sort((a, b) => {
          const closedStatuses = ["completed", "cancelled"];
          const openA = closedStatuses.includes(a.status) ? 1 : 0;
          const openB = closedStatuses.includes(b.status) ? 1 : 0;

          const rankA =
            PRIORITY_RANK[a.triage?.priority || ""] ?? 4;
          const rankB =
            PRIORITY_RANK[b.triage?.priority || ""] ?? 4;

          return (
            openA - openB ||
            rankA - rankB ||
            String(a.registeredAt).localeCompare(
              String(b.registeredAt)
            )
          );
        });

      return res.json({ patients });
    } catch (error) {
      console.error("Staff queue failed:", error);

      return sendError(
        res,
        500,
        "Could not load staff queue."
      );
    }
  }
);

// Get one patient (staff only)
app.get(
  "/staff/patients/:id",
  requireStaff,
  async (req: StaffRequest, res) => {
    try {
      const doc = await db
        .collection("patients")
        .doc(req.params.id)
        .get();

      if (!doc.exists) {
        return sendError(res, 404, "Patient not found.");
      }

      return res.json(staffPatient(doc));
    } catch (error) {
      console.error("Patient details failed:", error);

      return sendError(
        res,
        500,
        "Could not load patient details."
      );
    }
  }
);

// Update triage (authorised staff only)
app.patch(
  "/staff/patients/:id/triage",
  requireStaff,
  async (req: StaffRequest, res) => {
    const body = req.body || {};

    const statuses = [
      "registered",
      "waiting",
      "in_triage",
      "in_consultation",
      "completed",
      "cancelled",
    ];

    if (
      !Object.prototype.hasOwnProperty.call(
        PRIORITY_RANK,
        body.priority
      ) ||
      !statuses.includes(body.status) ||
      (body.notes !== undefined &&
        typeof body.notes !== "string") ||
      (typeof body.notes === "string" &&
        body.notes.length > 2000)
    ) {
      return sendError(
        res,
        400,
        "Choose a valid priority and status. Notes must be 2000 characters or fewer."
      );
    }

    if (
      !["nurse", "physician", "admin"].includes(
        req.staff!.role
      )
    ) {
      return sendError(
        res,
        403,
        "Your staff role cannot record triage assessments."
      );
    }

    try {
      const ref = db.collection("patients").doc(req.params.id);
      const doc = await ref.get();

      if (!doc.exists) {
        return sendError(res, 404, "Patient not found.");
      }

      const now = new Date().toISOString();

      await ref.update({
        priority: body.priority,
        status: body.status,
        notes:
          typeof body.notes === "string"
            ? body.notes.trim()
            : "",
        assessedBy: req.staff!.email,
        assessedAt: now,
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      const updatedDoc = await ref.get();

      return res.json(staffPatient(updatedDoc));
    } catch (error) {
      console.error("Triage update failed:", error);

      return sendError(
        res,
        500,
        "Could not save assessment."
      );
    }
  }
);

// Unknown routes
app.use((_req, res) => {
  return sendError(res, 404, "API route not found.");
});

// Start the server
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SmartCare API listening on port ${PORT}`);
});
