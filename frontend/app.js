/* SmartCare AI frontend. Plain JavaScript, no build step, no framework.
 * Works when index.html is opened straight from disk.
 *
 * ASSUMED API CONTRACT (all paths under {SMARTCARE_API_BASE}/api). Adjust in the `api` object below.
 *   GET  /departments                  -> { departments: string[] }
 *   POST /patients/register            -> { token, status, department, registeredAt, position? }
 *   GET  /patients/status/:token       -> same shape
 *   GET  /queue/public                 -> { updatedAt?, entries: [{ token, department, status }] }
 *   POST /staff/login                  -> { accessToken, displayName? }
 *   GET  /staff/patients   (Bearer)    -> { patients: PatientRecord[] }
 *   GET  /staff/patients/:id (Bearer)  -> PatientRecord
 *   PATCH /staff/patients/:id/triage (Bearer) body { priority, status, notes? } -> PatientRecord
 * PatientRecord: { id, token, name, age, department, symptoms, contact?, status, registeredAt,
 *                  triage?: { priority, notes?, assessedBy?, assessedAt? } | null }
 * Nothing here is mocked: if the backend is unreachable the UI says so.
 */
(function () {
  "use strict";

  var BASE = String(window.SMARTCARE_API_BASE || "").replace(/\/$/, "");
  var $app = document.getElementById("app");

  /* ---------- labels ---------- */
  var STATUS = {
    registered: ["Registered", "bg-slate-100 text-slate-700 ring-slate-300"],
    waiting: ["Waiting", "bg-amber-50 text-amber-900 ring-amber-300"],
    in_triage: ["In triage", "bg-sky-50 text-sky-900 ring-sky-300"],
    in_consultation: ["With doctor", "bg-teal-50 text-teal-900 ring-teal-300"],
    completed: ["Completed", "bg-emerald-50 text-emerald-900 ring-emerald-300"],
    cancelled: ["Cancelled", "bg-stone-100 text-stone-600 ring-stone-300"],
  };
  var STATUS_ORDER = ["registered", "waiting", "in_triage", "in_consultation", "completed", "cancelled"];
  var PRIORITY = {
    critical: { label: "Critical", rank: 0, cls: "text-critical", glyph: "▲▲" },
    urgent: { label: "Urgent", rank: 1, cls: "text-urgent", glyph: "▲" },
    standard: { label: "Standard", rank: 2, cls: "text-standard", glyph: "●" },
    routine: { label: "Routine", rank: 3, cls: "text-routine", glyph: "○" },
  };
  var PRIORITY_ORDER = ["critical", "urgent", "standard", "routine"];

  var BTN_PRIMARY = "inline-flex items-center justify-center gap-2 rounded-xl bg-teal px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60";
  var BTN_SECONDARY = "inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-white px-5 py-3 font-semibold text-ink transition hover:border-teal hover:text-teal-deep disabled:opacity-60";
  var INPUT = "w-full rounded-xl border border-line bg-white px-4 py-3 text-base text-ink placeholder:text-muted/70 focus:border-teal";

  /* ---------- helpers ---------- */
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function statusLabel(s) { return STATUS[s] ? STATUS[s][0] : String(s); }
  function formatDateTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }

  /* ---------- staff session (token is issued by the backend; we only store and forward it) ---------- */
  var KEY = "smartcare.staff.accessToken", NAME = "smartcare.staff.displayName";
  function getToken() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } }
  function getName() { try { return sessionStorage.getItem(NAME); } catch (e) { return null; } }
  function setSession(t, n) { try { sessionStorage.setItem(KEY, t); if (n) sessionStorage.setItem(NAME, n); } catch (e) { /* storage unavailable */ } }
  function clearSession() { try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(NAME); } catch (e) { /* ignore */ } }

  /* ---------- API ---------- */
  function ApiError(kind, message, status) { this.kind = kind; this.message = message; this.status = status; }

  async function request(path, opts, auth) {
    opts = opts || {};
    var headers = { Accept: "application/json" };
    if (opts.body) headers["Content-Type"] = "application/json";
    if (auth) { var t = getToken(); if (t) headers.Authorization = "Bearer " + t; }
    var res;
    try {
      if (!BASE || BASE.indexOf("REPLACE_WITH") !== -1) {
        throw new ApiError("config", "Firebase setup is incomplete. Follow FIREBASE-SETUP.md and update frontend/config.js.");
      }
      if (auth && window.firebaseAuth && window.firebaseAuth.currentUser) {
        var freshToken = await window.firebaseAuth.currentUser.getIdToken();
        setSession(freshToken, getName());
        headers.Authorization = "Bearer " + freshToken;
      }
      res = await fetch(BASE + path, { method: opts.method || "GET", headers: headers, body: opts.body });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError("network", "Can't reach the SmartCare Firebase API. Check your internet connection, Firebase configuration and deployment.");
    }
    if (!res.ok) {
      var detail = "";
      try { var b = await res.json(); detail = (b && (b.error || b.message)) || ""; if (typeof detail !== "string") detail = ""; } catch (e) { /* not JSON */ }
      if (res.status === 401 || res.status === 403) { if (auth) clearSession(); throw new ApiError("unauthorized", detail || "Your staff session isn't valid. Sign in again.", res.status); }
      if (res.status === 404) throw new ApiError("not_found", detail || "We couldn't find that.", 404);
      if (res.status === 400 || res.status === 422) throw new ApiError("validation", detail || "The server rejected the details submitted.", res.status);
      throw new ApiError("server", detail || "The server had a problem. Try again shortly.", res.status);
    }
    try { return await res.json(); } catch (e) { throw new ApiError("parse", "The server sent a response this app couldn't read.", res.status); }
  }

  var api = {
    departments: function () { return request("/departments").then(function (r) { return r.departments; }); },
    register: function (input) { return request("/patients/register", { method: "POST", body: JSON.stringify(input) }); },
    tokenStatus: function (token) { return request("/patients/status/" + encodeURIComponent(token)); },
    publicQueue: function () { return request("/queue/public"); },
    staffLogin: function (email, password) { return request("/staff/login", { method: "POST", body: JSON.stringify({ email: email, password: password }) }); },
    staffPatients: function () { return request("/staff/patients", {}, true).then(function (r) { return r.patients; }); },
    staffPatient: function (id) { return request("/staff/patients/" + encodeURIComponent(id), {}, true); },
    staffTriage: function (id, update) { return request("/staff/patients/" + encodeURIComponent(id) + "/triage", { method: "PATCH", body: JSON.stringify(update) }, true); },
  };

  function asApiError(e, fallback) { return e instanceof ApiError ? e : new ApiError("server", fallback || "Something went wrong."); }

  /* ---------- shared UI fragments ---------- */
  var SPINNER = '<svg class="animate-spin size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".25" stroke-width="3"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';

  function loading(label) {
    return '<div role="status" class="flex items-center justify-center gap-3 py-16 text-muted">' + SPINNER + "<span>" + esc(label || "Loading…") + "</span></div>";
  }
  function skeleton(rows) {
    var out = '<div role="status" aria-label="Loading" class="divide-y divide-line">';
    for (var i = 0; i < (rows || 5); i++) out += '<div class="flex animate-pulse items-center gap-4 px-4 py-4"><div class="h-5 w-20 rounded bg-line"></div><div class="h-5 flex-1 rounded bg-line/70"></div><div class="h-6 w-20 rounded-full bg-line"></div></div>';
    return out + "</div>";
  }
  function errorState(err, opts) {
    opts = opts || {};
    var title = opts.title || (err.kind === "network" ? "Can't reach the server" : err.kind === "not_found" ? "Not found" : "Something went wrong");
    return '<div role="alert" class="mx-auto max-w-xl rounded-2xl border border-critical/30 bg-white p-6 text-center"><h2 class="text-xl font-semibold text-critical">' + esc(title) + '</h2><p class="mt-2 text-muted">' + esc(err.message) + "</p>" +
      (opts.retry ? '<button type="button" data-retry class="' + BTN_SECONDARY + ' mt-5">Try again</button>' : "") + "</div>";
  }
  function emptyState(title, body, actionHtml) {
    return '<div class="mx-auto max-w-md px-4 py-14 text-center"><h2 class="text-xl font-semibold">' + esc(title) + '</h2><p class="mt-2 text-muted">' + esc(body) + "</p>" + (actionHtml ? '<div class="mt-5">' + actionHtml + "</div>" : "") + "</div>";
  }
  function statusBadge(s) {
    var t = STATUS[s] || STATUS.registered;
    return '<span class="inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-sm font-medium ring-1 ring-inset ' + t[1] + '">' + esc(statusLabel(s)) + "</span>";
  }
  function priorityBadge(p) {
    var d = PRIORITY[p];
    if (!d) return '<span class="text-sm text-muted">Not assessed</span>';
    return '<span class="inline-flex items-center gap-1.5 text-sm font-semibold ' + d.cls + '"><span aria-hidden="true" class="text-xs">' + d.glyph + "</span>" + d.label + "</span>";
  }
  function field(id, label, control, hint) {
    return '<div><label for="' + id + '" class="mb-1.5 block font-semibold">' + esc(label) + "</label>" + control +
      (hint ? '<p id="' + id + '-hint" class="mt-1.5 text-sm text-muted" data-hint>' + esc(hint) + "</p>" : "") +
      '<p id="' + id + '-error" role="alert" class="mt-1.5 hidden text-sm font-medium text-critical"></p></div>';
  }
  function setFieldErrors(errors, ids) {
    ids.forEach(function (id) {
      var el = $("#" + id), msg = $("#" + id + "-error"), hint = $("#" + id + "-hint");
      if (!el || !msg) return;
      var e = errors[id];
      msg.textContent = e || "";
      msg.classList.toggle("hidden", !e);
      if (hint) hint.classList.toggle("hidden", !!e);
      if (e) { el.setAttribute("aria-invalid", "true"); el.setAttribute("aria-describedby", id + "-error"); }
      else { el.removeAttribute("aria-invalid"); el.removeAttribute("aria-describedby"); }
    });
  }
  function ticket(token, department, status, extraCls) {
    return '<div class="ticket ' + (extraCls || "") + '"><div class="px-8 pb-6 pt-8"><p class="text-sm text-white/70">Your token</p>' +
      '<p class="tabular mt-1 break-all font-display text-5xl font-extrabold tracking-tight sm:text-6xl" aria-label="Token ' + esc(token) + '">' + esc(token) + "</p></div>" +
      '<div class="ticket-perf flex items-center justify-between gap-3 px-8 py-5"><span class="text-white/85">' + esc(department) + '</span><span class="rounded-full bg-white/15 px-3 py-1 text-sm font-medium">' + esc(statusLabel(status)) + "</span></div></div>";
  }
  function staffBar(title) {
    var n = getName();
    return '<div class="flex flex-wrap items-center justify-between gap-3"><h1 class="text-3xl font-extrabold sm:text-4xl">' + esc(title) + '</h1><div class="flex items-center gap-3">' +
      (n ? '<span class="text-sm text-muted">Signed in as ' + esc(n) + "</span>" : "") +
      '<button type="button" id="signout" class="' + BTN_SECONDARY + ' !px-4 !py-2">Sign out</button></div></div>';
  }
  function bindSignOut() { var b = $("#signout"); if (b) b.addEventListener("click", function () {
    clearSession();
    if (window.firebaseAuth) window.firebaseAuth.signOut().catch(function () {});
    go("/staff/login");
  }); }

  /* ---------- validation ---------- */
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var PHONE = /^\+?[0-9][0-9\s-]{6,17}[0-9]$/;
  function validateRegistration(v) {
    var e = {};
    var name = v.name.trim();
    if (name.length < 2) e.name = "Enter the patient's full name."; else if (name.length > 80) e.name = "Name must be 80 characters or fewer.";
    var age = v.age.trim();
    if (!age) e.age = "Enter the patient's age."; else if (!/^\d{1,3}$/.test(age) || Number(age) > 120) e.age = "Enter an age between 0 and 120.";
    if (!v.department) e.department = "Choose a department.";
    var s = v.symptoms.trim();
    if (s.length < 5) e.symptoms = "Describe the symptoms in a few words."; else if (s.length > 1000) e.symptoms = "Symptoms must be 1000 characters or fewer.";
    var c = v.contact.trim();
    if (c && !EMAIL.test(c) && !PHONE.test(c)) e.contact = "Enter a valid phone number or email, or leave this blank.";
    return e;
  }

  /* ---------- router ---------- */
  var routeId = 0, cleanups = [], lastRegistration = null;

  function go(path) { location.hash = "#" + path; }
  function onCleanup(fn) { cleanups.push(fn); }
  function poll(fn, ms) { var id = setInterval(fn, ms); onCleanup(function () { clearInterval(id); }); }
  function mount(html) { $app.innerHTML = html; }
  function isCurrent(id) { return id === routeId; }

  function route() {
    cleanups.forEach(function (f) { f(); }); cleanups = [];
    var id = ++routeId;
    var path = (location.hash.replace(/^#/, "") || "/").replace(/\/+$/, "") || "/";
    var parts = path.split("/").filter(Boolean).map(decodeURIComponent);

    document.querySelectorAll("a[data-nav]").forEach(function (a) {
      var target = a.getAttribute("href").slice(1);
      a.classList.toggle("active", path === target || path.indexOf(target + "/") === 0);
    });
    var mobile = $("#mobile-nav"); if (mobile) { mobile.classList.add("hidden"); mobile.classList.remove("flex"); }
    var mb = $("#menu-btn"); if (mb) { mb.setAttribute("aria-expanded", "false"); mb.textContent = "Menu"; }

    var title = "SmartCare AI";
    if (!parts.length) { viewLanding(); }
    else if (parts[0] === "register") { title = "Register · SmartCare AI"; viewRegister(id); }
    else if (parts[0] === "token" && parts[1]) { title = "Your token · SmartCare AI"; viewToken(id, parts[1]); }
    else if (parts[0] === "queue") { title = "Live queue · SmartCare AI"; viewQueue(id); }
    else if (parts[0] === "staff" && parts[1] === "login") { title = "Staff sign-in · SmartCare AI"; viewLogin(); }
    else if (parts[0] === "staff" && parts[1] === "patients" && parts[2]) { title = "Triage · SmartCare AI"; viewDetail(id, parts[2]); }
    else if (parts[0] === "staff" && parts.length === 1) { title = "Staff dashboard · SmartCare AI"; viewDashboard(id); }
    else { mount(emptyState("Page not found", "That address doesn't exist in SmartCare AI.", '<a href="#/" class="' + BTN_PRIMARY + '">Go to home</a>')); }
    document.title = title;
    window.scrollTo(0, 0);
  }

  /* ---------- views ---------- */
  function viewLanding() {
    var steps = [
      ["Register", "Enter your name, age, department and symptoms. Contact details are optional."],
      ["Get your token", "You receive a unique token. Keep it, because it is how you are called."],
      ["Watch the queue", "Follow tokens and statuses on the public board from any screen."],
      ["Be assessed", "Staff triage you and the queue updates as your status changes."],
    ];
    mount(
      '<section class="mx-auto grid max-w-6xl items-center gap-10 px-4 py-12 md:grid-cols-[1.15fr_0.85fr] md:py-20"><div>' +
      '<h1 class="text-5xl font-extrabold leading-[1.02] sm:text-6xl lg:text-7xl">Smarter Queues.<br>Faster Care.</h1>' +
      '<p class="mt-6 max-w-xl text-lg text-muted">SmartCare AI lets patients register from any phone, get a token, and follow the queue without crowding the waiting room. Staff see who needs attention first.</p>' +
      '<div class="mt-8 flex flex-wrap gap-3"><a href="#/register" class="' + BTN_PRIMARY + '">Register as a patient</a><a href="#/queue" class="' + BTN_SECONDARY + '">View live queue</a></div></div>' +
      /* Decorative ticket only: shows what you get after registering, not real data. */
      '<div class="ticket ticket-in mx-auto w-full max-w-sm rotate-2" aria-hidden="true"><div class="px-8 pb-7 pt-8"><p class="text-sm text-white/70">Your token</p><p class="mt-1 font-display text-5xl font-extrabold tracking-[0.2em] text-white/90">· · · ·</p></div><div class="ticket-perf px-8 py-5 text-white/85">Issued when you register</div></div></section>' +
      '<section class="border-y border-line bg-white"><div class="mx-auto max-w-6xl px-4 py-14"><h2 class="text-3xl font-bold">How a visit works</h2><ol class="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">' +
      steps.map(function (s, i) { return '<li class="border-l-4 border-teal pl-4"><p class="tabular font-display text-sm font-bold text-teal">Step ' + (i + 1) + '</p><h3 class="mt-1 text-xl font-bold">' + s[0] + '</h3><p class="mt-2 text-muted">' + s[1] + "</p></li>"; }).join("") +
      "</ol></div></section>" +
      '<section class="mx-auto grid max-w-6xl gap-8 px-4 py-14 md:grid-cols-2"><div><h2 class="text-3xl font-bold">Private by design</h2><p class="mt-3 max-w-prose text-muted">The public queue shows tokens, departments and statuses only. Names, ages, symptoms and contact details are visible to signed-in staff only.</p></div>' +
      '<div class="rounded-2xl bg-teal-wash p-6"><h2 class="text-2xl font-bold">Are you on the care team?</h2><p class="mt-2 text-muted">Sign in to see the full queue, filter by department, and record triage assessments.</p><a href="#/staff" class="' + BTN_PRIMARY + ' mt-5">Open staff dashboard</a></div></section>'
    );
  }

  function viewRegister(id) {
    var header = '<div class="mx-auto max-w-2xl px-4 py-10"><h1 class="text-4xl font-extrabold">Patient registration</h1><p class="mt-2 text-muted">Takes about a minute. You\'ll get a token to track your place in the queue.</p><div id="reg-body"></div></div>';
    mount(header);
    var body = $("#reg-body");

    function load() {
      body.innerHTML = loading("Loading departments…");
      api.departments().then(function (depts) {
        if (!isCurrent(id)) return;
        renderForm(depts);
      }).catch(function (e) {
        if (!isCurrent(id)) return;
        body.innerHTML = '<div class="mt-8">' + errorState(asApiError(e), { title: "Can't load departments", retry: true }) + "</div>";
        $("[data-retry]", body).addEventListener("click", load);
      });
    }

    function renderForm(depts) {
      var opts = '<option value="">Choose a department</option>' + depts.map(function (d) { return '<option value="' + esc(d) + '">' + esc(d) + "</option>"; }).join("");
      body.innerHTML =
        '<form id="reg" novalidate class="mt-8 space-y-6 rounded-2xl border border-line bg-white p-5 sm:p-8">' +
        field("name", "Full name", '<input id="name" class="' + INPUT + '" autocomplete="name">') +
        '<div class="grid gap-6 sm:grid-cols-[8rem_1fr]">' +
        field("age", "Age", '<input id="age" class="' + INPUT + '" inputmode="numeric">') +
        field("department", "Department", '<select id="department" class="' + INPUT + '">' + opts + "</select>") + "</div>" +
        (depts.length === 0 ? '<p role="alert" class="text-sm font-medium text-critical">The server returned no departments, so registration isn\'t possible yet.</p>' : "") +
        field("symptoms", "Symptoms", '<textarea id="symptoms" rows="4" class="' + INPUT + '"></textarea>', "What's wrong, and for how long?") +
        field("contact", "Phone or email (optional)", '<input id="contact" class="' + INPUT + '" autocomplete="email">', "Only used by staff to reach you about this visit.") +
        '<div id="reg-error"></div>' +
        '<button type="submit" id="reg-submit" class="' + BTN_PRIMARY + ' w-full sm:w-auto"' + (depts.length === 0 ? " disabled" : "") + ">Register and get token</button></form>";

      var ids = ["name", "age", "department", "symptoms", "contact"];
      ids.forEach(function (f) { $("#" + f).addEventListener("input", function () { var o = {}; o[f] = ""; setFieldErrors(o, [f]); }); });

      $("#reg").addEventListener("submit", async function (ev) {
        ev.preventDefault();
        $("#reg-error").innerHTML = "";
        var v = { name: $("#name").value, age: $("#age").value, department: $("#department").value, symptoms: $("#symptoms").value, contact: $("#contact").value };
        var errs = validateRegistration(v);
        setFieldErrors(errs, ids);
        var first = ids.filter(function (f) { return errs[f]; })[0];
        if (first) { $("#" + first).focus(); return; }

        var btn = $("#reg-submit"); btn.disabled = true; btn.innerHTML = SPINNER + " Registering…";
        var payload = { name: v.name.trim(), age: Number(v.age.trim()), department: v.department, symptoms: v.symptoms.trim() };
        if (v.contact.trim()) payload.contact = v.contact.trim();
        try {
          var info = await api.register(payload);
          lastRegistration = info;
          go("/token/" + encodeURIComponent(info.token));
        } catch (e) {
          if (!isCurrent(id)) return;
          $("#reg-error").innerHTML = errorState(asApiError(e, "Registration failed."), { title: "Registration didn't go through" });
          btn.disabled = false; btn.textContent = "Register and get token";
        }
      });
    }
    load();
  }

  function viewToken(id, token) {
    var fromReg = lastRegistration && lastRegistration.token === token ? lastRegistration : null;
    mount('<div class="mx-auto max-w-xl px-4 py-10"><div id="tok"></div></div>');
    var box = $("#tok"), current = fromReg, stale = "";

    function draw(err) {
      if (!current) {
        if (err) { box.innerHTML = errorState(err, { title: err.kind === "not_found" ? "Token not found" : undefined, retry: true }); $("[data-retry]", box).addEventListener("click", refresh); }
        else box.innerHTML = loading("Checking your token…");
        return;
      }
      var i = current;
      box.innerHTML =
        '<h1 class="text-3xl font-extrabold">' + (fromReg ? "You're registered" : "Token status") + "</h1>" +
        '<p class="mt-2 text-muted">' + (fromReg ? "Keep this token. It's how you're called, and it never shows your name." : "This page updates automatically.") + "</p>" +
        ticket(i.token, i.department, i.status, "ticket-in mt-8") +
        '<dl class="mt-6 grid grid-cols-2 gap-4 rounded-2xl border border-line bg-white p-5"><div><dt class="text-sm text-muted">Registered</dt><dd class="font-semibold">' + esc(formatDateTime(i.registeredAt) || "Just now") + "</dd></div>" +
        (i.position != null ? '<div><dt class="text-sm text-muted">People ahead of you</dt><dd class="tabular font-semibold">' + esc(i.position) + "</dd></div>" : "") + "</dl>" +
        (err ? '<p role="status" class="mt-4 text-sm text-urgent">Couldn\'t refresh just now. Showing the last update. ' + esc(err.message) + "</p>" : "") +
        '<div class="no-print mt-8 flex flex-wrap gap-3"><a href="#/queue" class="' + BTN_PRIMARY + '">Watch the live queue</a><button type="button" id="print" class="' + BTN_SECONDARY + '">Print token</button></div>';
      $("#print").addEventListener("click", function () { window.print(); });
    }
    function refresh() {
      api.tokenStatus(token).then(function (d) { if (!isCurrent(id)) return; current = d; draw(null); })
        .catch(function (e) { if (!isCurrent(id)) return; draw(asApiError(e)); });
    }
    draw(null); refresh(); poll(refresh, 15000);
    void stale;
  }

  function viewQueue(id) {
    mount(
      '<div class="mx-auto max-w-6xl px-4 py-10"><div class="flex flex-wrap items-end justify-between gap-4"><div><h1 class="text-4xl font-extrabold">Live queue</h1><p class="mt-2 text-muted">Tokens and statuses only. Updates every 10 seconds.</p></div>' +
      '<div id="dept-wrap" class="hidden"><label for="dept" class="mb-1 block text-sm font-semibold">Department</label><select id="dept" class="rounded-xl border border-line bg-white px-4 py-2.5"></select></div></div>' +
      '<p id="stale" role="status" class="mt-4 hidden text-sm text-urgent"></p><div id="q-body" class="mt-8"><div class="rounded-2xl border border-line bg-white">' + skeleton(5) + "</div></div></div>"
    );
    var data = null, dept = "";
    var $body = $("#q-body"), $sel = $("#dept");
    $sel.addEventListener("change", function () { dept = $sel.value; draw(); });

    function draw() {
      var entries = data.entries || [];
      var depts = entries.map(function (e) { return e.department; }).filter(function (d, i, a) { return a.indexOf(d) === i; }).sort();
      if (dept && depts.indexOf(dept) === -1) dept = "";
      $sel.innerHTML = '<option value="">All departments</option>' + depts.map(function (d) { return '<option value="' + esc(d) + '"' + (d === dept ? " selected" : "") + ">" + esc(d) + "</option>"; }).join("");
      $("#dept-wrap").classList.toggle("hidden", depts.length < 2);

      var shown = dept ? entries.filter(function (e) { return e.department === dept; }) : entries;
      if (!shown.length) {
        $body.innerHTML = '<div class="rounded-2xl border border-line bg-white">' + emptyState(dept ? "No one in " + dept : "The queue is empty", "No tokens are active right now. New registrations appear here as they come in.", '<a href="#/register" class="' + BTN_PRIMARY + '">Register as a patient</a>') + "</div>";
        return;
      }
      var active = shown.filter(function (e) { return e.status === "in_consultation" || e.status === "in_triage"; });
      var waiting = shown.filter(function (e) { return e.status === "waiting" || e.status === "registered"; });
      /* Only token, department and status are ever read from the response. */
      $body.innerHTML = '<div class="grid gap-8 lg:grid-cols-[1fr_1.4fr]"><section aria-labelledby="active-h"><h2 id="active-h" class="text-xl font-bold">Being seen</h2>' +
        (active.length ? '<ul class="mt-3 grid grid-cols-2 gap-3">' + active.map(function (e) {
          return '<li class="rounded-2xl bg-teal-deep p-4 text-white"><p class="tabular break-all font-display text-2xl font-extrabold sm:text-3xl">' + esc(e.token) + '</p><p class="mt-1 text-sm text-white/80">' + esc(e.department) + '</p><p class="mt-2 text-sm font-medium">' + (e.status === "in_consultation" ? "With doctor" : "In triage") + "</p></li>";
        }).join("") + "</ul>" : '<p class="mt-3 text-muted">No one is being seen right now.</p>') +
        '</section><section aria-labelledby="wait-h"><h2 id="wait-h" class="text-xl font-bold">Waiting <span class="tabular text-muted">(' + waiting.length + ")</span></h2>" +
        (waiting.length ? '<ul class="mt-3 divide-y divide-line rounded-2xl border border-line bg-white">' + waiting.map(function (e) {
          return '<li class="flex items-center justify-between gap-3 px-4 py-3"><span class="tabular font-display text-xl font-bold">' + esc(e.token) + '</span><span class="hidden flex-1 text-muted sm:block">' + esc(e.department) + "</span>" + statusBadge(e.status) + "</li>";
        }).join("") + "</ul>" : '<p class="mt-3 text-muted">No one is waiting.</p>') + "</section></div>";
    }
    function refresh() {
      api.publicQueue().then(function (d) {
        if (!isCurrent(id)) return;
        data = d; $("#stale").classList.add("hidden"); draw();
      }).catch(function (e) {
        if (!isCurrent(id)) return;
        var err = asApiError(e);
        if (data) { var s = $("#stale"); s.textContent = "Couldn't refresh. Showing the last update" + (data.updatedAt ? " from " + formatDateTime(data.updatedAt) : "") + "."; s.classList.remove("hidden"); }
        else { $body.innerHTML = errorState(err, { title: "Can't load the queue", retry: true }); $("[data-retry]", $body).addEventListener("click", function () { $body.innerHTML = '<div class="rounded-2xl border border-line bg-white">' + skeleton(5) + "</div>"; refresh(); }); }
      });
    }
    refresh(); poll(refresh, 10000);
  }

  function viewLogin() {
    if (getToken()) { go("/staff"); return; }
    mount(
      '<div class="mx-auto max-w-md px-4 py-12"><h1 class="text-3xl font-extrabold">Staff sign-in</h1><p class="mt-2 text-muted">Patient details and triage tools are for authorised staff only. Your credentials are checked by the server.</p>' +
      '<form id="login" novalidate class="mt-8 space-y-5 rounded-2xl border border-line bg-white p-6">' +
      field("email", "Email", '<input id="email" type="email" autocomplete="username" class="' + INPUT + '">') +
      field("password", "Password", '<input id="password" type="password" autocomplete="current-password" class="' + INPUT + '">') +
      '<div id="login-error"></div><button type="submit" id="login-btn" class="' + BTN_PRIMARY + ' w-full">Sign in</button></form></div>'
    );
    $("#login").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var email = $("#email").value.trim(), pw = $("#password").value, errs = {};
      if (!email) errs.email = "Enter your staff email.";
      if (!pw) errs.password = "Enter your password.";
      setFieldErrors(errs, ["email", "password"]);
      $("#login-error").innerHTML = "";
      if (errs.email || errs.password) return;
      var btn = $("#login-btn"); btn.disabled = true; btn.innerHTML = SPINNER + " Signing in…";
      try {
        if (!window.firebaseAuth) throw new ApiError("config", "Firebase is not configured. Complete frontend/config.js first.");
        var credential = await window.firebaseAuth.signInWithEmailAndPassword(email, pw);
        var s = { accessToken: await credential.user.getIdToken(true), displayName: credential.user.displayName || credential.user.email };
        setSession(s.accessToken, s.displayName);
        go("/staff");
      } catch (e) {
        var err = asApiError(e, "Sign-in failed.");
        if (e && e.code) {
          var authMessage = ({ "auth/invalid-credential": "Email or password is incorrect.", "auth/user-not-found": "No staff account exists for this email.", "auth/wrong-password": "Email or password is incorrect.", "auth/too-many-requests": "Too many attempts. Try again later.", "auth/network-request-failed": "Network error. Check your internet connection." })[e.code];
          if (authMessage) err = new ApiError("unauthorized", authMessage);
        }
        $("#login-error").innerHTML = errorState(err, { title: err.kind === "unauthorized" ? "Sign-in failed" : undefined });
        btn.disabled = false; btn.textContent = "Sign in";
      }
    });
  }

  function isOpen(s) { return s !== "completed" && s !== "cancelled"; }
  function rank(p) { return (isOpen(p.status) ? 0 : 100) + (p.triage && PRIORITY[p.triage.priority] ? PRIORITY[p.triage.priority].rank : 50); }

  function viewDashboard(id) {
    if (!getToken()) { go("/staff/login"); return; }
    var tileDefs = [["open", "Open"], ["waiting", "Waiting"], ["unassessed", "Not yet assessed"], ["high", "Critical or urgent"], ["done", "Completed"]];
    mount(
      '<div class="mx-auto max-w-6xl px-4 py-8">' + staffBar("Staff dashboard") +
      '<div id="tiles" class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">' +
      tileDefs.map(function (t) { return '<div class="rounded-2xl border border-line bg-white p-4"><p class="text-sm text-muted">' + t[1] + '</p><p class="tabular mt-1 font-display text-3xl font-extrabold" data-tile="' + t[0] + '">–</p></div>'; }).join("") + "</div>" +
      '<form role="search" id="filters" class="mt-6 grid gap-3 sm:grid-cols-[1fr_12rem_12rem]">' +
      '<div><label for="q" class="sr-only">Search by name or token</label><input id="q" type="search" placeholder="Search by name or token" class="' + INPUT + '"></div>' +
      '<div><label for="f-dept" class="sr-only">Filter by department</label><select id="f-dept" class="' + INPUT + '"><option value="">All departments</option></select></div>' +
      '<div><label for="f-status" class="sr-only">Filter by status</label><select id="f-status" class="' + INPUT + '"><option value="">All statuses</option>' +
      STATUS_ORDER.map(function (s) { return '<option value="' + s + '">' + STATUS[s][0] + "</option>"; }).join("") + "</select></div></form>" +
      '<p id="stale" role="status" class="mt-4 hidden text-sm text-urgent"></p>' +
      '<div id="results" class="mt-4 overflow-hidden rounded-2xl border border-line bg-white">' + skeleton(6) + "</div></div>"
    );
    bindSignOut();
    var patients = null;
    var $q = $("#q"), $d = $("#f-dept"), $s = $("#f-status"), $res = $("#results");
    $("#filters").addEventListener("submit", function (e) { e.preventDefault(); });
    [$q, $d, $s].forEach(function (el) { el.addEventListener("input", draw); });

    function draw() {
      var list = patients;
      var counts = {
        open: list.filter(function (p) { return isOpen(p.status); }).length,
        waiting: list.filter(function (p) { return p.status === "waiting" || p.status === "registered"; }).length,
        unassessed: list.filter(function (p) { return isOpen(p.status) && !p.triage; }).length,
        high: list.filter(function (p) { return isOpen(p.status) && p.triage && (p.triage.priority === "critical" || p.triage.priority === "urgent"); }).length,
        done: list.filter(function (p) { return p.status === "completed"; }).length,
      };
      Object.keys(counts).forEach(function (k) { $('[data-tile="' + k + '"]').textContent = counts[k]; });

      var cur = $d.value;
      var depts = list.map(function (p) { return p.department; }).filter(function (d, i, a) { return a.indexOf(d) === i; }).sort();
      $d.innerHTML = '<option value="">All departments</option>' + depts.map(function (d) { return '<option value="' + esc(d) + '"' + (d === cur ? " selected" : "") + ">" + esc(d) + "</option>"; }).join("");

      var term = $q.value.trim().toLowerCase(), dept = $d.value, st = $s.value;
      var rows = list.filter(function (p) {
        return (!dept || p.department === dept) && (!st || p.status === st) &&
          (!term || String(p.name).toLowerCase().indexOf(term) !== -1 || String(p.token).toLowerCase().indexOf(term) !== -1);
      }).sort(function (a, b) { return rank(a) - rank(b) || String(a.registeredAt).localeCompare(String(b.registeredAt)); });

      var filtered = !!(term || dept || st);
      if (!rows.length) {
        $res.innerHTML = emptyState(filtered ? "No patients match" : "No patients registered yet", filtered ? "Try a different search or clear the filters." : "New registrations will appear here as soon as patients register.", filtered ? '<button type="button" id="clear" class="' + BTN_SECONDARY + '">Clear filters</button>' : "");
        var c = $("#clear"); if (c) c.addEventListener("click", function () { $q.value = ""; $d.value = ""; $s.value = ""; draw(); });
        return;
      }
      function link(p) { return "#/staff/patients/" + encodeURIComponent(p.id); }
      $res.innerHTML =
        '<table class="hidden w-full text-left md:table"><caption class="sr-only">Patient queue, sorted by priority then registration time</caption>' +
        '<thead class="border-b border-line bg-teal-wash/60 text-sm"><tr>' + ["Token", "Patient", "Department", "Priority", "Status", "Registered"].map(function (h) { return '<th scope="col" class="px-4 py-3">' + h + "</th>"; }).join("") + "</tr></thead>" +
        '<tbody class="divide-y divide-line">' + rows.map(function (p) {
          return '<tr class="hover:bg-paper"><td class="tabular px-4 py-3 font-display text-lg font-bold">' + esc(p.token) + '</td><td class="px-4 py-3"><a href="' + link(p) + '" class="font-semibold text-teal-deep underline-offset-2 hover:underline">' + esc(p.name) + '</a><span class="text-muted">, ' + esc(p.age) + '</span></td><td class="px-4 py-3">' + esc(p.department) + '</td><td class="px-4 py-3">' + priorityBadge(p.triage && p.triage.priority) + '</td><td class="px-4 py-3">' + statusBadge(p.status) + '</td><td class="px-4 py-3 text-sm text-muted">' + esc(formatDateTime(p.registeredAt)) + "</td></tr>";
        }).join("") + "</tbody></table>" +
        '<ul class="divide-y divide-line md:hidden">' + rows.map(function (p) {
          return '<li><a href="' + link(p) + '" class="block px-4 py-4"><div class="flex items-center justify-between gap-3"><span class="tabular font-display text-xl font-bold">' + esc(p.token) + "</span>" + statusBadge(p.status) + '</div><p class="mt-1 font-semibold">' + esc(p.name) + '<span class="font-normal text-muted">, ' + esc(p.age) + '</span></p><div class="mt-1 flex items-center justify-between gap-3 text-sm text-muted"><span>' + esc(p.department) + "</span>" + priorityBadge(p.triage && p.triage.priority) + "</div></a></li>";
        }).join("") + "</ul>";
    }
    function refresh() {
      api.staffPatients().then(function (d) {
        if (!isCurrent(id)) return;
        patients = d; $("#stale").classList.add("hidden"); draw();
      }).catch(function (e) {
        if (!isCurrent(id)) return;
        var err = asApiError(e);
        if (err.kind === "unauthorized") { go("/staff/login"); return; }
        if (patients) { var s = $("#stale"); s.textContent = "Couldn't refresh. Showing the last update. " + err.message; s.classList.remove("hidden"); }
        else { $res.innerHTML = '<div class="p-6">' + errorState(err, { title: "Can't load the queue", retry: true }) + "</div>"; $("[data-retry]", $res).addEventListener("click", function () { $res.innerHTML = skeleton(6); refresh(); }); }
      });
    }
    refresh(); poll(refresh, 20000);
  }

  function viewDetail(id, pid) {
    if (!getToken()) { go("/staff/login"); return; }
    mount('<div class="mx-auto max-w-4xl px-4 py-8"><a href="#/staff" class="text-sm font-medium text-teal-deep hover:underline">Back to dashboard</a><div class="mt-3">' + staffBar("Triage assessment") + '</div><div id="pt" class="mt-6">' + loading("Loading patient…") + "</div></div>");
    bindSignOut();
    var $pt = $("#pt");

    function load() {
      $pt.innerHTML = loading("Loading patient…");
      api.staffPatient(pid).then(function (rec) { if (isCurrent(id)) render(rec); })
        .catch(function (e) {
          if (!isCurrent(id)) return;
          var err = asApiError(e);
          if (err.kind === "unauthorized") { go("/staff/login"); return; }
          $pt.innerHTML = errorState(err, { title: err.kind === "not_found" ? "Patient not found" : undefined, retry: true });
          $("[data-retry]", $pt).addEventListener("click", load);
        });
    }

    function render(rec) {
      var tri = rec.triage || null;
      $pt.innerHTML =
        '<div class="grid gap-6 md:grid-cols-2"><section aria-labelledby="pt-h" class="rounded-2xl border border-line bg-white p-5"><div class="flex items-start justify-between gap-3"><div><h2 id="pt-h" class="text-2xl font-bold">' + esc(rec.name) + '</h2><p class="text-muted">' + esc(rec.age) + " years · " + esc(rec.department) + "</p></div>" + statusBadge(rec.status) + "</div>" +
        '<dl class="mt-5 space-y-4"><div><dt class="text-sm text-muted">Token</dt><dd class="tabular font-display text-2xl font-bold">' + esc(rec.token) + "</dd></div>" +
        '<div><dt class="text-sm text-muted">Symptoms reported</dt><dd class="whitespace-pre-wrap">' + esc(rec.symptoms) + "</dd></div>" +
        '<div><dt class="text-sm text-muted">Contact</dt><dd>' + (rec.contact ? esc(rec.contact) : '<span class="text-muted">Not provided</span>') + "</dd></div>" +
        '<div><dt class="text-sm text-muted">Registered</dt><dd>' + esc(formatDateTime(rec.registeredAt)) + "</dd></div>" +
        '<div><dt class="text-sm text-muted">Current assessment</dt><dd>' + priorityBadge(tri && tri.priority) + (tri && tri.assessedBy ? '<span class="block text-sm text-muted">By ' + esc(tri.assessedBy) + (tri.assessedAt ? ", " + esc(formatDateTime(tri.assessedAt)) : "") + "</span>" : "") + "</dd></div></dl></section>" +

        '<form id="triage" novalidate aria-label="Triage assessment form" class="space-y-5 rounded-2xl border border-line bg-white p-5"><h2 class="text-2xl font-bold">Record assessment</h2>' +
        field("priority", "Priority", '<select id="priority" class="' + INPUT + '"><option value="">Choose priority</option>' + PRIORITY_ORDER.map(function (p) { return '<option value="' + p + '"' + (tri && tri.priority === p ? " selected" : "") + ">" + PRIORITY[p].label + "</option>"; }).join("") + "</select>") +
        field("status", "Status", '<select id="status" class="' + INPUT + '">' + STATUS_ORDER.map(function (s) { return '<option value="' + s + '"' + (rec.status === s ? " selected" : "") + ">" + STATUS[s][0] + "</option>"; }).join("") + "</select>") +
        field("notes", "Clinical notes", '<textarea id="notes" rows="5" class="' + INPUT + '">' + esc(tri && tri.notes) + "</textarea>", "Visible to staff only.") +
        '<div id="save-msg"></div><button type="submit" id="save" class="' + BTN_PRIMARY + ' w-full">Save assessment</button></form></div>';

      $("#priority").addEventListener("input", function () { setFieldErrors({ priority: "" }, ["priority"]); });
      $("#triage").addEventListener("submit", async function (ev) {
        ev.preventDefault();
        var priority = $("#priority").value, status = $("#status").value, notes = $("#notes").value.trim(), errs = {};
        $("#save-msg").innerHTML = "";
        if (!priority) errs.priority = "Choose a priority before saving.";
        if (notes.length > 2000) errs.notes = "Notes must be 2000 characters or fewer.";
        setFieldErrors(errs, ["priority", "notes"]);
        if (errs.priority) { $("#priority").focus(); return; }
        if (errs.notes) { $("#notes").focus(); return; }
        var btn = $("#save"); btn.disabled = true; btn.innerHTML = SPINNER + " Saving…";
        try {
          /* Only report success if the server accepted it, and show what the server returned. */
          var updated = await api.staffTriage(pid, { priority: priority, status: status || rec.status, notes: notes || undefined });
          if (!isCurrent(id)) return;
          render(updated);
          $("#save-msg").innerHTML = '<p role="status" class="rounded-xl bg-teal-wash p-3 font-medium text-teal-deep">Assessment saved.</p>';
        } catch (e) {
          if (!isCurrent(id)) return;
          var err = asApiError(e, "Couldn't save the assessment.");
          if (err.kind === "unauthorized") { go("/staff/login"); return; }
          $("#save-msg").innerHTML = errorState(err, { title: "Assessment not saved" });
          btn.disabled = false; btn.textContent = "Save assessment";
        }
      });
    }
    load();
  }

  /* ---------- boot ---------- */
  var menuBtn = $("#menu-btn"), mobileNav = $("#mobile-nav");
  menuBtn.addEventListener("click", function () {
    var open = mobileNav.classList.contains("hidden");
    mobileNav.classList.toggle("hidden", !open); mobileNav.classList.toggle("flex", open);
    menuBtn.setAttribute("aria-expanded", String(open)); menuBtn.textContent = open ? "Close" : "Menu";
  });
  window.addEventListener("hashchange", route);
  route();
})();
