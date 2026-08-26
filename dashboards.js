/* ============================================================
   My Dashboard — interactive, role-based simulated dashboards
   Roles: Admin, Learner, Teacher, Field Officer, School Leader
   ============================================================ */

import { icon } from "./icons.js";
import { DASH, ROLES, ORG_TYPES, COUNTIES, KOLIBRI, CONTENT_KINDS, SCHOOLS,
  LIBRARY_CATEGORIES, RESOURCE_TYPES, LIBRARY_SEED, REGIONS, PROJECTS, KPI_TARGETS } from "./data.js";
import { esc, timeAgo, runCounters, read, write, toast, uid } from "./util.js";
import { supabase, adminClient, authMessage } from "./supabase.js";

const K_USERS = "hpf_users";
const K_SESSION = "hpf_session";
const K_IMPERSONATE = "hpf_impersonate"; // stores the real user while "in" someone's account
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
const DASH_ROLES = ["admin", "staff", "learner", "teacher", "field_officer", "school_leader"];
// Every role with a real profiles row (i.e. not learner) — an unrelated "staff"
// to the "staff" *role value* added below: this is "which roles are staff of
// the org" (admin/staff/teacher/field_officer/school_leader), not the role
// named "staff" specifically. Kept as one name since renaming it would touch
// every "Users by role" chart on the admin dashboard for no behavior change.
const STAFF_ROLES = DASH_ROLES.filter((r) => r !== "learner");
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* which role workspaces each role may view via the switcher:
   admin/staff see everyone, teacher sees teacher+learner, others only themselves */
const VIEWABLE = {
  admin: ["admin", "staff", "teacher", "learner", "field_officer", "school_leader"],
  staff: ["admin", "staff", "teacher", "learner", "field_officer", "school_leader"],
  teacher: ["teacher", "learner"],
  field_officer: ["field_officer"],
  school_leader: ["school_leader"],
  learner: ["learner"],
};

/* which roles a user is allowed to "enter" (impersonate to help remotely) */
const CAN_ENTER = {
  admin: ["admin", "staff", "teacher", "learner", "field_officer", "school_leader"],
  staff: ["admin", "staff", "teacher", "learner", "field_officer", "school_leader"],
  teacher: ["learner"],
};

/* Enter another user's account: stash the real user, swap the session to the
   target, and re-render the whole app as them. Used by admins (any user) and
   teachers (their learners) to assist during a live session. */
function enterAccount(targetId) {
  const target = read(K_USERS, []).find((u) => u.id === targetId);
  if (!target) return toast("Account not found", "", "error");
  const me = read(K_SESSION, null);
  const allowed = (CAN_ENTER[me?.role] || []).includes(target.role);
  if (!allowed) return toast("Not allowed", `You can't enter a ${ROLE_LABEL[target.role] || target.role} account.`, "error");
  if (!read(K_IMPERSONATE, null)) write(K_IMPERSONATE, me); // keep the original impersonator
  const { password, ...safe } = target;
  write(K_SESSION, safe);
  toast("Entered account", `You're now in ${safe.fullName || safe.username}'s account — helping remotely.`, "success");
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

function exitAccount() {
  const me = read(K_IMPERSONATE, null);
  if (me) write(K_SESSION, me);
  localStorage.removeItem(K_IMPERSONATE);
  toast("Back to your account", me ? `Signed back in as ${me.fullName || me.username}.` : "", "success");
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

/* What each role's workspace is for, and what they can do in it. */
const ROLE_META = {
  admin: {
    icon: "shield",
    tagline: "Run the platform",
    blurb: "Oversee every account, review sign-in activity, and keep the portal healthy. The only role that can promote another account to Admin.",
    can: ["Add users & change roles", "Promote Staff to Admin", "Review login requests", "Monitor platform activity"],
  },
  staff: {
    icon: "shield",
    tagline: "Run the platform",
    blurb: "The same full platform access as Admin — every school, every account — short of granting the Admin role itself.",
    can: ["Add users & change roles", "Review login requests", "Monitor platform activity"],
  },
  learner: {
    icon: "graduation",
    tagline: "Keep learning",
    blurb: "Pick up where you left off, hand in your work, and grow your streak.",
    can: ["Continue your courses", "Submit assignments", "Earn badges & streaks"],
  },
  teacher: {
    icon: "users",
    tagline: "Manage your classes",
    blurb: "Create classes, enroll learners in bulk, add staff, and run live sessions.",
    can: ["Enroll learners (bulk or one by one)", "Add teachers to your school", "Run live lesson/quiz sessions"],
  },
  field_officer: {
    icon: "mapPin",
    tagline: "Collect field data",
    blurb: "Log school visits, sync monitoring reports, and track the schools you support.",
    can: ["Log school visits", "Sync field reports", "Track assigned schools"],
  },
  school_leader: {
    icon: "school",
    tagline: "Lead your school",
    blurb: "Watch your whole-school KPIs, coach your staff, and report on progress.",
    can: ["Track school KPIs", "Review staff performance", "Generate term reports"],
  },
};

function roleBanner(role) {
  const m = ROLE_META[role] || ROLE_META.learner;
  return `
    <div class="role-banner">
      <div class="rb-icon">${icon(m.icon)}</div>
      <div class="rb-copy">
        <div class="rb-tagline">${esc(ROLE_LABEL[role] || role)} · ${esc(m.tagline)}</div>
        <p>${esc(m.blurb)}</p>
        <div class="rb-chips">
          ${m.can.map((c) => `<span class="rb-chip">${icon("check")} ${esc(c)}</span>`).join("")}
        </div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------- chart helpers */
function countNum(count, suffix = "", compact = false, cls = "") {
  return `<span class="count ${cls}" data-count="${count}"${
    compact ? " data-compact" : ""
  } data-suffix="${esc(suffix)}">0${esc(suffix)}</span>`;
}

function trendBadge(trend) {
  if (typeof trend !== "number" || trend === 0) return "";
  const up = trend > 0;
  return `<span class="trend ${up ? "up" : "down"}" title="vs last period">
    ${icon(up ? "trendingUp" : "trendingDown")} ${up ? "+" : ""}${trend}%</span>`;
}

/* The KPI row every role dashboard opens with. Same executive card as the
   admin analytics row — value against target, progress, direction, freshness
   and a next action — fed from DASH rather than computed stats. */
function statTiles(stats) {
  return `<div class="stat-row">${stats
    .map((s) =>
      kpiCard({
        icon: s.icon,
        label: s.label,
        value: s.count,
        suffix: s.suffix,
        compact: s.compact,
        target: s.target,
        trend: typeof s.trend === "number" ? s.trend : null,
        // DASH is seed data with no timestamps of its own; freshMins stands in
        // for how often each figure would really be refreshed.
        updated: typeof s.freshMins === "number" ? Date.now() - s.freshMins * 6e4 : null,
        action: s.action,
        href: s.href,
        actionLabel: s.actionLabel,
      })
    )
    .join("")}</div>`;
}

/* smart-insight strip: [{ icon, tone: good|warn|bad|"", html }] */
function insights(items) {
  if (!items.length) return "";
  return `<div class="insights">${items
    .map(
      (i) => `<div class="insight ${i.tone || ""}">${icon(i.icon || "lightbulb")}<span>${i.html}</span></div>`
    )
    .join("")}</div>`;
}

function barChart(series, labels, unit = "") {
  const max = Math.max(...series, 1);
  return `<div class="chart">${series
    .map(
      (v, i) => `<div class="bar" title="${labels[i]}: ${v}${unit}">
        <div class="bar-track"><div class="bar-fill" style="height:${Math.round(
          (v / max) * 100
        )}%"></div></div>
        <div class="bar-label">${labels[i]}</div>
      </div>`
    )
    .join("")}</div>`;
}

function hbar(label, value, max = 100, color = "var(--primary)", suffix = "") {
  return `<div class="hbar">
    <div class="hbar-top"><span>${esc(label)}</span><strong>${value}${esc(suffix)}</strong></div>
    <div class="hbar-track"><div class="hbar-fill" style="width:${Math.round(
      (value / max) * 100
    )}%;background:${color}"></div></div>
  </div>`;
}

function taskList(tasks) {
  const done = tasks.filter((t) => t.done).length;
  return `
    <div class="tasklist" data-tasklist>
      <div class="tasklist-head">
        <span class="panel-sub" style="margin:0">Today's tasks</span>
        <span class="task-progress"><strong data-done>${done}</strong>/${tasks.length} done</span>
      </div>
      ${tasks
        .map(
          (t, i) => `<button class="task ${t.done ? "done" : ""}" data-task="${i}">
            <span class="task-check">${icon("check")}</span>
            <span class="task-title">${esc(t.title)}</span>
            <span class="task-due">${esc(t.due)}</span>
          </button>`
        )
        .join("")}
    </div>`;
}

/* A metric with no real data source yet — no invented number, no silently
   dropped widget, just an honest "not measured" state, the same convention
   kpiCard() already uses for a KPI with no trend history. */
function notTracked(note) {
  return `<div class="empty-state">${icon("info")} Not yet tracked — ${esc(note)}</div>`;
}

/* ---------------------------------------------------------- HPF administrators
   Appointing a second admin from the portal, which until now needed SQL.

   Picking "HPF Staff (Admin)" in the user table below cannot do it, for two
   independent reasons: that table lives in this browser's localStorage, and
   handle_new_user() in patch-01-security.sql clamps the role on every signup —
   post {"role":"admin"} and you get a learner. Admin is only ever granted by an
   update from a caller who is already an admin, which guard_profile_role()
   permits. So that is what this panel does:

     1. create the account on an isolated client, so signing the new user in
        doesn't sign the acting admin out (see adminClient in supabase.js);
     2. raise profiles.role to 'admin' over the acting admin's own session, then
        read the row back — the guard trigger pins the role to its old value
        *without raising an error*, so a write that "succeeded" proves nothing.

   Everything here is real database state, unlike the user table below, so these
   accounts work on every device. */
let adminsCache = [];
let adminsLoaded = false;
let adminsError = null;
let adminsAuthed = false;   // is this browser on a real Supabase session at all?
let adminFormOpen = false;
let adminPromoteOpen = false;
let editAdminId = null; // row currently showing the inline "edit name" form

/* Collapse state for the heavier admin panels — HPF administrators, Digital
   Library, Recent activity. Keyed rather than three separate booleans so the
   toggle markup and handler are one function each instead of three near-
   identical copies. Default collapsed: these three are the longest panels on
   the dashboard and an admin opens this page daily, so the summary heading is
   what shows first and each expands only on request. */
let collapsedPanels = { admins: true, library: true, activity: true, assignments: true, devices: true };

/* A header-row collapse button plus the wrapper its body goes in. Call
   collapseBtn(key) inside the panel's header, then wrap the existing body
   markup in collapseBody(key, html) — the two always agree on state because
   they read the same collapsedPanels entry. */
function collapseBtn(key) {
  const open = !collapsedPanels[key];
  return `<button class="icon-btn panel-collapse-btn ${open ? "open" : ""}"
            data-panel-collapse="${key}" aria-expanded="${open}" title="${open ? "Collapse" : "Expand"}">
            ${icon("arrowRight")}
          </button>`;
}
function collapseBody(key, html) {
  return `<div class="panel-collapse-body" ${collapsedPanels[key] ? "hidden" : ""}>${html}</div>`;
}

/* adminsCache now holds both tiers (staff and admin), not just admin — kept
   the name rather than renaming it and its ~10 call sites for a cosmetic-only
   change. Each row carries `role` now so the panel can show which tier it is
   and gate the "Promote to Admin" action to staff rows only. */
async function loadAdmins() {
  const { data: sess } = await supabase.auth.getSession();
  adminsAuthed = !!sess?.session;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, username, role, created_at")
    .in("role", ["admin", "staff"])
    .order("created_at");
  adminsLoaded = true;
  adminsError = error ? authMessage(error) : null;
  if (!error) adminsCache = data || [];
  return adminsCache;
}

/* Raise one profile to admin or staff. Reads the row back because a refused
   promotion is silent: guard_profile_role() restores the old role and
   returns success. Admin is the one transition the database reserves for an
   existing admin (patch-14) — staff is open to any staff-or-admin viewer,
   same as every other admin-level action. */
async function promoteToRole(id, role) {
  const { data, error } = await supabase
    .from("profiles").update({ role }).eq("id", id).select("role").maybeSingle();
  if (error) throw new Error(authMessage(error));
  if (data?.role !== role) {
    const noun = role === "admin" ? "an HPF admin" : "HPF staff";
    throw new Error(
      `The database refused the promotion — this session isn't recognised as ${noun}. ` +
      "Sign in with an account that has that permission, or run this in the " +
      `Supabase SQL editor: update profiles set role = '${role}' where id = '${id}';`
    );
  }
}
const promoteToAdmin = (id) => promoteToRole(id, "admin");
const promoteToStaff = (id) => promoteToRole(id, "staff");

/* Admin-only from patch-16: touching an EXISTING Staff or Admin row (rename
   or remove) is no longer something Staff can do, even though Staff can
   still promote a fresh teacher/field officer up to Staff. Same read-back
   verification as promoteToRole, but its own message — "the promotion was
   refused" would be a confusing thing to say about a rename or a removal. */
async function renameStaffMember(id, fullName) {
  const { error } = await supabase.from("profiles").update({ full_name: fullName }).eq("id", id);
  if (error) throw new Error(authMessage(error));
}

/* Drops someone out of Staff/Admin back to Learner — the only role every
   account can always be moved to, since nothing records what they were
   before they were promoted. Doesn't touch their auth account or history;
   give them a proper role again afterward if they should keep using the
   portal in another capacity. */
async function removeStaffMember(id) {
  const { data, error } = await supabase
    .from("profiles").update({ role: "learner" }).eq("id", id).select("role").maybeSingle();
  if (error) throw new Error(authMessage(error));
  if (data?.role !== "learner") {
    throw new Error(
      "The database refused this — only an HPF admin can remove an existing Staff or Admin account. " +
      "Sign in with an admin account, or run this in the Supabase SQL editor: " +
      `update profiles set role = 'learner' where id = '${id}';`
    );
  }
}

/* Shared by "Add staff member" (must find nothing) and "Promote existing
   account" (must find exactly one) — same query, different expectations. */
async function findProfileByEmail(email) {
  const { data, error } = await supabase
    .from("profiles").select("id, full_name, role").ilike("email", email).limit(2);
  if (error) throw new Error(authMessage(error));
  return data || [];
}

/* ---------------------------------------------------------- officer -> school assignments
   Gives "Field Officer: assigned schools" a real, admin-managed mechanism
   (school_officer_assignments) instead of an officer only ever seeing reports
   they personally filed. Same cache/load/error shape as every other Postgres
   panel in this file. */
let assignmentsCache = [];
let assignmentsLoaded = false;
let assignmentsError = null;
let fieldOfficersCache = []; // profiles with role = field_officer, for the picker
let assignFormOpen = false;

async function loadAssignments() {
  const [officersRes, assignRes] = await Promise.all([
    supabase.from("profiles").select("id, full_name, email").eq("role", "field_officer").order("full_name"),
    supabase.from("school_officer_assignments").select("*").order("created_at", { ascending: false }),
  ]);
  assignmentsLoaded = true;
  if (officersRes.error) { assignmentsError = authMessage(officersRes.error); return assignmentsCache; }
  if (assignRes.error)   { assignmentsError = authMessage(assignRes.error);   return assignmentsCache; }
  assignmentsError = null;
  fieldOfficersCache = officersRes.data || [];
  assignmentsCache = assignRes.data || [];
  return assignmentsCache;
}

/* ---------------------------------------------------------- every staff account
   Real role counts for the admin dashboard. Only ever covers admin/teacher/
   school_leader/field_officer — a learner has no Supabase account at all (no
   email, no JWT), so there is no row in profiles to count and never will be;
   see computeAdminStats() for how a device-local learner count is kept
   separate rather than folded into this as if it were a global figure. */
let profilesCache = [];
let profilesLoaded = false;
let profilesError = null;
let profilesAuthed = false; // same "local account, DB never saw it" check loadAdmins() uses

async function loadProfiles() {
  const { data: sess } = await supabase.auth.getSession();
  profilesAuthed = !!sess?.session;
  const { data, error } = await supabase.from("profiles").select("id, role, county, school, created_at");
  profilesLoaded = true;
  if (error) { profilesError = authMessage(error); return profilesCache; }
  profilesError = null;
  profilesCache = data || [];
  return profilesCache;
}

/* Open device-maintenance tickets, for the Programme Overview's priority
   actions. devices/device_maintenance are new (patch-13), still genuinely
   empty — this reads 0 honestly rather than a fabricated count. */
let deviceIssuesCache = [];
let deviceIssuesLoaded = false;
async function loadDeviceIssues() {
  // device_id + issue broadened in (patch-2, Phase 2b) so the devices panel
  // can show which device has what open ticket, not just a bare count.
  const { data, error } = await supabase.from("device_maintenance").select("id, device_id, issue, status").neq("status", "resolved");
  deviceIssuesLoaded = true;
  if (!error) deviceIssuesCache = data || [];
  return deviceIssuesCache;
}

/* Devices (patch-13) — the physical inventory itself, distinct from
   deviceIssuesCache above (open maintenance tickets only, for the KPI
   badge). Loaded together at mount since both feed the same panel. */
let devicesCache = [];
let devicesLoaded = false;
async function loadDevices() {
  const { data, error } = await supabase.from("devices").select("*").order("created_at", { ascending: false });
  devicesLoaded = true;
  if (!error) devicesCache = data || [];
  return devicesCache;
}
let deviceFormOpen = false;
let issueFormDeviceId = null; // device currently showing its "report issue" form

/* M&E indicators (patch-19) — org-wide only for this first pass (school_id
   is null), display only: no admin UI yet to define an indicator or set a
   target, so an empty result here is a genuinely empty database, not a
   bug — rendered honestly via notTracked() rather than hidden. */
let meIndicatorsCache = [];
let meIndicatorValuesCache = [];
let meTargetsCache = [];
let meIndicatorsLoaded = false;
async function loadMeIndicators() {
  const [indRes, valRes, tgtRes] = await Promise.all([
    supabase.from("me_indicators").select("*").order("name"),
    supabase.from("me_indicator_values").select("*").is("school_id", null).order("period_year", { ascending: false }),
    supabase.from("me_targets").select("*").is("school_id", null).order("period_year", { ascending: false }),
  ]);
  meIndicatorsLoaded = true;
  if (!indRes.error) meIndicatorsCache = indRes.data || [];
  if (!valRes.error) meIndicatorValuesCache = valRes.data || [];
  if (!tgtRes.error) meTargetsCache = tgtRes.data || [];
  return meIndicatorsCache;
}

function meIndicatorsPanel() {
  if (!meIndicatorsLoaded) return `<div class="empty-state">Loading indicators…</div>`;
  if (!meIndicatorsCache.length) return notTracked("no M&E indicators have been defined yet.");

  const bars = meIndicatorsCache.map((ind) => {
    // Caches are ordered by period_year descending, so the first match per
    // indicator is its latest org-wide figure.
    const value = meIndicatorValuesCache.find((v) => v.indicator_id === ind.id);
    const target = meTargetsCache.find((t) => t.indicator_id === ind.id);
    if (!value && !target) return "";
    return hbar(ind.name, value?.value ?? 0, target?.target_value || value?.value || 1, "var(--primary)", ind.unit ? ` ${ind.unit}` : "");
  }).filter(Boolean).join("");

  return bars || notTracked("no measurements have been recorded against these indicators yet.");
}

/* Creates the account as Staff, not Admin — matching the panel's own
   "Add staff member" framing (patch-14): Staff is the entry tier, Admin is
   reached by promoting an existing Staff account, one row at a time.

   No password from the admin: signInWithOtp() emails a magic link instead,
   and the invitee sets their own password on first sign-in (see app.js's
   boot check for needs_password, and recovery.js's "invite" step). A link
   only ever grants a session when the recipient clicks it, so this is what
   actually proves the address belongs to them — a typed-in password handed
   over "in person" never did. */
async function createStaffAccount({ fullName, email }) {
  const existing = await findProfileByEmail(email);
  if (existing.length) {
    throw new Error(`${email} already has an account. Use "Promote existing account" instead — inviting again would just re-email them.`);
  }

  // No role in the metadata on purpose: patch-01 clamps whatever is sent here to
  // the self-serve roles, so the row always lands as a learner and step 2 is
  // what actually appoints them. Sending "staff" would only look like it worked.
  const { error } = await adminClient().auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      data: {
        full_name: fullName,
        username: null, school: null, county: null, org_type: null, project: null,
      },
    },
  });
  if (error) throw new Error(authMessage(error));

  // signInWithOtp() never returns the new user's id — the account isn't
  // "logged into" yet, just created and emailed. Find it the same way
  // "Promote existing account" finds any other row.
  const [row] = await findProfileByEmail(email);
  if (!row) {
    throw new Error(`${email} was invited but the profile row hasn't appeared yet. Refresh in a moment and promote them from this list.`);
  }

  // Order matters here (patch-16): once this row's role becomes staff/admin,
  // a Staff-tier actor can no longer touch it at all — only Admin can. So the
  // needs_password flag has to be set FIRST, while the row is still a plain
  // learner and any staff/admin viewer can still write to it. Flipping this
  // order would silently leave needs_password false whenever a Staff (not
  // Admin) member does the inviting, since the row would already be
  // off-limits to them by the time the second call ran.
  //
  // Best-effort: lets patch-15 (the needs_password column) land after this
  // code without breaking "Add staff member" in the meantime — the invite
  // still works, it just won't force a password step until the column exists.
  const { error: flagErr } = await supabase
    .from("profiles").update({ needs_password: true }).eq("id", row.id);
  if (flagErr) console.warn("Could not set needs_password (has patch-15 been applied?):", flagErr.message);

  try {
    await promoteToStaff(row.id);
  } catch (err) {
    // The auth user exists from here on and the browser cannot delete it (that
    // needs the service_role key), so don't pretend this failed cleanly.
    throw new Error(`${email} was invited but is still an ordinary account. ${err.message}`);
  }

  return { id: row.id };
}

/* Staff and Admin, one combined list (patch-14): the database, not this
   panel, is what actually keeps Admin exclusive — the "Promote to Admin"
   button below only ever appears for the viewer it would actually work for,
   but the real gate is guard_profile_role(), verified separately. */
function adminAccountsPanel(currentUser) {
  const viewerIsAdmin = currentUser.role === "admin";
  const head = `
    <div class="panel-head-row">
      <div>
        <h2>${icon("shield")} HPF Staff &amp; Admins</h2>
        <p class="panel-sub" style="margin-bottom:0">Accounts in the HPF database with full platform access · works on every device</p>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        <button class="btn btn-outline" data-admin-promote-toggle>${icon("userCheck")} Promote existing account</button>
        <button class="btn btn-primary" data-admin-add-toggle>${icon("userPlus")} Add staff member</button>
        ${collapseBtn("admins")}
      </div>
    </div>`;

  const wrap = (inner) => `<div class="panel" style="margin-top:1.5rem" data-admins-panel>${head}${collapseBody("admins", inner)}</div>`;

  if (!adminsLoaded) return wrap(`<div class="empty-state">Loading staff &amp; admins…</div>`);

  // A locally-created or legacy account has no JWT, so every read comes back
  // empty rather than failing — which would read as "there is no staff".
  if (!adminsAuthed) {
    return wrap(`<div class="notice">${icon("info")}
      <span>This browser is signed in on a <strong>local account</strong>, which the HPF
      database has never seen. Sign in with a staff or admin account that exists in the
      database to see or appoint staff.</span></div>`);
  }
  if (adminsError) {
    return wrap(`<div class="empty-state">Could not load staff &amp; admins — ${esc(adminsError)}
      <div style="margin-top:.6rem"><button class="btn btn-outline btn-xs" data-admins-retry>${icon("refresh")} Try again</button></div>
    </div>`);
  }

  // Editing or removing an EXISTING row is Admin-only (patch-16) — Staff can
  // still add new Staff (invite) and view this whole list, just not touch a
  // row that's already Staff or Admin. Never offered on the viewer's own row:
  // self-removal has no recovery path from this panel.
  const rows = adminsCache.length
    ? adminsCache.map((a) => {
        const isSelf = a.id === currentUser.id;
        const canManage = viewerIsAdmin && !isSelf;
        if (editAdminId === a.id) {
          return `
        <form class="submission" data-edit-admin-form="${a.id}">
          <span class="avatar-sm">${esc((a.full_name || a.email || "A").slice(0, 1).toUpperCase())}</span>
          <div style="flex:1;min-width:0;display:flex;gap:.5rem;align-items:center">
            <input class="input" name="fullName" type="text" required value="${esc(a.full_name || "")}" style="max-width:16rem">
            <button class="btn btn-primary btn-xs" type="submit">Save</button>
            <button class="btn btn-outline btn-xs" type="button" data-edit-admin-cancel>Cancel</button>
          </div>
        </form>`;
        }
        return `
        <div class="submission">
          <span class="avatar-sm">${esc((a.full_name || a.email || "A").slice(0, 1).toUpperCase())}</span>
          <div style="flex:1;min-width:0">
            <div class="s-title">${esc(a.full_name || "—")}${isSelf ? ' <span class="ut-you">you</span>' : ""}</div>
            <div class="s-meta">${esc(a.email || "—")}${a.username ? " · " + esc(a.username) : ""}
              · added ${new Date(a.created_at).toLocaleDateString()}</div>
          </div>
          ${viewerIsAdmin && a.role === "staff"
            ? `<button class="btn btn-outline btn-xs" data-promote-to-admin="${a.id}" style="margin-right:.5rem">${icon("shield")} Promote to Admin</button>`
            : ""}
          ${canManage
            ? `<button class="icon-btn" data-edit-admin="${a.id}" title="Edit name">${icon("pen")}</button>
               <button class="icon-btn danger" data-remove-admin="${a.id}" data-name="${esc(a.full_name || a.email || "this account")}" title="Remove from Staff/Admin">${icon("trash")}</button>`
            : ""}
          <span class="pill role-pill">${a.role === "admin" ? "Admin" : "Staff"}</span>
        </div>`;
      }).join("")
    : `<div class="empty-state">No staff or admin rows in the database yet.</div>`;

  const addForm = adminFormOpen ? `
    <form id="addAdminForm" class="add-user-form">
      <div class="form-row">
        <div class="field"><label>Full name</label>
          <input class="input" name="fullName" type="text" required placeholder="e.g. Grace Achieng"></div>
        <div class="field"><label>HPF email</label>
          <input class="input" name="email" type="email" required placeholder="name@${ORG_DOMAIN}"></div>
      </div>
      <p class="hint">Must be an <strong>@${ORG_DOMAIN}</strong> address. Creates the account as
        <strong>Staff</strong> and emails them a link to set their own password and sign in —
        promote to Admin afterwards if that's what they need. No password to hand over: clicking
        the link is what proves the address is really theirs. Delivery depends on the SMTP setup
        described in <strong>supabase/AUTH-RECOVERY.md</strong> — if an invite doesn't arrive,
        that's the first thing to check.</p>
      <div class="add-user-actions">
        <button class="btn btn-primary" type="submit">${icon("shield")} Send invite</button>
        <button class="btn btn-outline" type="button" data-admin-add-cancel>Cancel</button>
      </div>
    </form>` : "";

  const promoteForm = adminPromoteOpen ? `
    <form id="promoteAdminForm" class="add-user-form">
      <div class="field"><label>Email of an existing HPF account</label>
        <input class="input" name="email" type="email" required placeholder="name@${ORG_DOMAIN}"></div>
      <p class="hint">The person already signed up (as a teacher, school leader or field officer)
        and keeps their current password — only their role changes, to <strong>Staff</strong>.
        An admin can promote them again from Staff to Admin afterwards, from this list.</p>
      <div class="add-user-actions">
        <button class="btn btn-primary" type="submit">${icon("userCheck")} Make staff</button>
        <button class="btn btn-outline" type="button" data-admin-promote-cancel>Cancel</button>
      </div>
    </form>` : "";

  return wrap(`${addForm}${promoteForm}${rows}`);
}

/* Which schools each field officer covers. This is the mechanism, not just
   a display: field_reports RLS checks the same table, so an assignment made
   here is what actually lets an officer file a report for that school, on
   every device, not merely what this panel shows. */
function officerAssignmentsPanel() {
  const head = `
    <div class="panel-head-row">
      <div>
        <h2>${icon("mapPin")} Field officer assignments</h2>
        <p class="panel-sub" style="margin-bottom:0">Which schools each officer may file reports for and see — enforced in the database, not just this screen</p>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        <button class="btn btn-primary" data-assign-toggle>${icon("plus")} Assign a school</button>
        ${collapseBtn("assignments")}
      </div>
    </div>`;

  const wrap = (inner) => `<div class="panel" style="margin-top:1.5rem" data-assignments-panel>${head}${collapseBody("assignments", inner)}</div>`;

  if (!assignmentsLoaded) return wrap(`<div class="empty-state">Loading assignments…</div>`);
  if (assignmentsError) {
    return wrap(`<div class="empty-state">Could not load assignments — ${esc(assignmentsError)}
      <div style="margin-top:.6rem"><button class="btn btn-outline btn-xs" data-assignments-retry>${icon("refresh")} Try again</button></div>
    </div>`);
  }

  // Grouped by officer — "who covers what" reads more usefully than a flat
  // list of individual assignment rows, and matches how an admin thinks about
  // the question ("where is Grace assigned?") rather than the storage shape.
  const byOfficer = new Map();
  assignmentsCache.forEach((a) => {
    if (!byOfficer.has(a.officer_id)) byOfficer.set(a.officer_id, []);
    byOfficer.get(a.officer_id).push(a);
  });

  const rows = fieldOfficersCache.length
    ? fieldOfficersCache.map((o) => {
        const mine = byOfficer.get(o.id) || [];
        return `<div class="submission">
          <span class="avatar-sm">${esc((o.full_name || o.email || "O").slice(0, 1).toUpperCase())}</span>
          <div style="flex:1;min-width:0">
            <div class="s-title">${esc(o.full_name || "—")}</div>
            <div class="s-meta">${esc(o.email || "—")}</div>
            <div class="assign-chips">
              ${mine.length
                ? mine.map((a) => `<span class="pill role-pill">${esc(a.school)}
                    <button class="pill-x" data-assign-remove="${esc(a.id)}" title="Remove">×</button></span>`).join("")
                : `<span class="s-meta">No schools assigned</span>`}
            </div>
          </div>
        </div>`;
      }).join("")
    : `<div class="empty-state">No field officer accounts in the database yet — they appear here once someone signs up (or is promoted) as a Field Officer.</div>`;

  const officerOpts = fieldOfficersCache.length
    ? `<option value="" disabled selected>Select an officer</option>` +
      fieldOfficersCache.map((o) => `<option value="${esc(o.id)}">${esc(o.full_name || o.email)}</option>`).join("")
    : `<option value="" disabled selected>No field officer accounts yet</option>`;
  const schoolOpts = getSchools().map((s) => `<option>${esc(s.name)}</option>`).join("");

  const addForm = assignFormOpen ? `
    <form id="assignForm" class="add-user-form">
      <div class="form-row">
        <div class="field"><label>Field officer</label>
          <select class="select" name="officerId" required ${fieldOfficersCache.length ? "" : "disabled"}>
            ${officerOpts}
          </select></div>
        <div class="field"><label>School</label>
          <select class="select" name="school" required>
            <option value="" disabled selected>Select a school</option>${schoolOpts}
          </select></div>
      </div>
      <div class="add-user-actions">
        <button class="btn btn-primary" type="submit">${icon("check")} Assign</button>
        <button class="btn btn-outline" type="button" data-assign-cancel>Cancel</button>
      </div>
    </form>` : "";

  return wrap(`${addForm}${rows}`);
}

/* ---------------------------------------------------------- devices (patch-13)
   Physical inventory + open maintenance tickets. Extends the read-only KPI
   badge (deviceIssuesCache, above) into a real management panel — same
   load/cache/render/wire shape as officerAssignmentsPanel. */
const DEVICE_TYPES = ["laptop", "tablet", "desktop", "projector", "router", "server", "other"];

function devicesPanel() {
  const head = `
    <div class="panel-head-row">
      <div>
        <h2>${icon("laptop")} Devices</h2>
        <p class="panel-sub" style="margin-bottom:0">Inventory and open maintenance tickets, by school</p>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        <button class="btn btn-primary" data-device-add-toggle>${icon("plus")} Add device</button>
        ${collapseBtn("devices")}
      </div>
    </div>`;
  const wrap = (inner) => `<div class="panel" style="margin-top:1.5rem" data-devices-panel>${head}${collapseBody("devices", inner)}</div>`;

  if (!devicesLoaded) return wrap(`<div class="empty-state">Loading devices…</div>`);

  const schoolName = (id) => getSchools().find((s) => s.id === id)?.name || "Unassigned";
  const issuesFor = (deviceId) => deviceIssuesCache.filter((i) => i.device_id === deviceId);

  const rows = devicesCache.length
    ? devicesCache.map((d) => {
        const openIssues = issuesFor(d.id);
        return `<div class="submission">
          <span class="s-icon">${icon("laptop")}</span>
          <div style="flex:1;min-width:0">
            <div class="s-title">${esc(d.device_type)}${d.asset_tag ? ` · ${esc(d.asset_tag)}` : ""}</div>
            <div class="s-meta">${esc(schoolName(d.school_id))}${d.serial_number ? ` · SN ${esc(d.serial_number)}` : ""}</div>
            ${openIssues.length
              ? openIssues.map((i) => `<div class="notice" style="margin-top:.4rem">${icon("alert")}
                  <span>${esc(i.issue)}</span>
                  <button class="btn btn-outline btn-xs" style="margin-left:.5rem" data-issue-resolve="${esc(i.id)}">${icon("check")} Resolve</button>
                </div>`).join("")
              : ""}
            ${issueFormDeviceId === d.id
              ? `<form class="add-user-form" data-issue-form="${esc(d.id)}" style="margin-top:.5rem">
                   <div class="field"><input class="input" name="issue" required placeholder="What's wrong?"></div>
                   <div class="add-user-actions">
                     <button class="btn btn-primary btn-xs" type="submit">Report</button>
                     <button class="btn btn-outline btn-xs" type="button" data-issue-cancel>Cancel</button>
                   </div>
                 </form>`
              : ""}
          </div>
          <span class="pill role-pill">${esc(d.status)}</span>
          ${issueFormDeviceId !== d.id
            ? `<button class="btn btn-outline btn-xs" style="margin-left:.5rem" data-issue-toggle="${esc(d.id)}">${icon("alert")} Report issue</button>`
            : ""}
        </div>`;
      }).join("")
    : `<div class="empty-state">No devices recorded yet.</div>`;

  const schoolOpts = getSchools().map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  const typeOpts = DEVICE_TYPES.map((t) => `<option value="${t}">${t[0].toUpperCase()}${t.slice(1)}</option>`).join("");

  const addForm = deviceFormOpen ? `
    <form id="deviceForm" class="add-user-form">
      <div class="form-row">
        <div class="field"><label>Type</label><select class="select" name="device_type" required>${typeOpts}</select></div>
        <div class="field"><label>School</label><select class="select" name="school_id" required>
          <option value="" disabled selected>Select a school</option>${schoolOpts}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Serial number</label><input class="input" name="serial_number" placeholder="optional"></div>
        <div class="field"><label>Asset tag</label><input class="input" name="asset_tag" placeholder="optional"></div>
      </div>
      <div class="add-user-actions">
        <button class="btn btn-primary" type="submit">${icon("check")} Add device</button>
        <button class="btn btn-outline" type="button" data-device-cancel>Cancel</button>
      </div>
    </form>` : "";

  return wrap(`${addForm}${rows}`);
}

/* ---------------------------------------------------------- user management */
function userManagementPanel(currentUser) {
  const users = read(K_USERS, []);
  const roleTally = users.reduce((m, u) => ((m[u.role] = (m[u.role] || 0) + 1), m), {});
  const roleOpts = (selected) =>
    ROLES.map(
      (r) => `<option value="${r.value}" ${r.value === selected ? "selected" : ""}>${r.label}</option>`
    ).join("");

  // filter by role, then sort
  let visible = usersRoleFilter === "all" ? users.slice() : users.filter((u) => u.role === usersRoleFilter);
  const byName = (a, b) => (a.fullName || a.username || "").localeCompare(b.fullName || b.username || "");
  if (usersSort === "role") visible.sort((a, b) => (a.role || "").localeCompare(b.role || "") || byName(a, b));
  else if (usersSort === "school") visible.sort((a, b) => (a.school || "").localeCompare(b.school || "") || byName(a, b));
  else visible.sort(byName);

  const dash = (v) => (v ? esc(v) : "—");
  const rows = visible.length
    ? visible
        .map((u) => {
          const isSelf = u.id === currentUser.id;
          const pw = u.password || "";
          return `<div class="utx-row">
            <div class="utx-cell utx-user">
              <span class="avatar-sm">${esc((u.fullName || u.username || "U").slice(0, 1).toUpperCase())}</span>
              <div class="utx-name">${esc(u.fullName || "—")}${isSelf ? ' <span class="ut-you">you</span>' : ""}
                <div class="utx-email">${dash(u.email)}</div></div>
            </div>
            <div class="utx-cell">${dash(u.username)}</div>
            <div class="utx-cell utx-pw">
              <span data-pw="${esc(pw)}" class="pw-mask">${pw ? "••••••••" : "—"}</span>
              ${pw ? `<button class="icon-btn pw-eye" data-pw-toggle title="Show/hide">${icon("eye")}</button>` : ""}
            </div>
            <div class="utx-cell"><span class="pill role-pill">${esc(ROLE_LABEL[u.role] || u.role || "—")}</span></div>
            <div class="utx-cell">${dash(u.project)}</div>
            <div class="utx-cell">${dash(u.region)}</div>
            <div class="utx-cell">${dash(u.school)}</div>
            <div class="utx-cell utx-actions">
              <button class="icon-btn" data-edit-user="${u.id}" title="Edit credentials">${icon("pen")}</button>
              <button class="icon-btn" data-enter-account="${u.id}" title="Enter account" ${isSelf ? "disabled" : ""}>${icon("login")}</button>
              <button class="icon-btn danger" data-remove-user="${u.id}" title="Remove" ${isSelf ? "disabled" : ""}>${icon("trash")}</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="empty-state">No ${usersRoleFilter === "all" ? "users" : (ROLE_LABEL[usersRoleFilter] || usersRoleFilter) + " accounts"} yet.</div>`;

  const regionOpts = `<option value="">Region</option>` + Object.keys(REGIONS).map((r) => `<option>${esc(r)}</option>`).join("");
  const schoolOpts = `<option value="">School</option>` + SCHOOLS.map((s) => `<option>${esc(s)}</option>`).join("");
  const projectOpts = `<option value="">Project / department</option>` + PROJECTS.map((p) => `<option>${esc(p)}</option>`).join("");

  return `
    <div class="panel" style="margin-top:1.5rem">
      <div class="panel-head-row">
        <div>
          <h2>${icon("users")} User management</h2>
          <p class="panel-sub" style="margin-bottom:0">${users.length} account${users.length === 1 ? "" : "s"} · full details · edit credentials, passwords &amp; roles</p>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
          <select class="select select-sm" data-users-role aria-label="Filter by role">
            <option value="all" ${usersRoleFilter === "all" ? "selected" : ""}>All roles (${users.length})</option>
            ${ROLES.map((r) => {
              const n = users.filter((u) => u.role === r.value).length;
              return `<option value="${r.value}" ${usersRoleFilter === r.value ? "selected" : ""}>${esc(r.label)} (${n})</option>`;
            }).join("")}
          </select>
          <select class="select select-sm" data-users-sort aria-label="Sort by">
            <option value="name" ${usersSort === "name" ? "selected" : ""}>Sort: Name</option>
            <option value="role" ${usersSort === "role" ? "selected" : ""}>Sort: Role</option>
            <option value="school" ${usersSort === "school" ? "selected" : ""}>Sort: School</option>
          </select>
          <button class="btn btn-outline" data-users-toggle>${icon(usersListOpen ? "arrowUpRight" : "list")} ${usersListOpen ? "Collapse" : "Show list"}</button>
          <button class="btn btn-primary" data-add-user-toggle>${icon("userPlus")} Add user</button>
        </div>
      </div>

      <form id="addUserForm" class="add-user-form" hidden>
        <div class="form-row">
          <div class="field"><label>Full name</label>
            <input class="input" name="fullName" type="text" required placeholder="e.g. Grace Achieng"></div>
          <div class="field"><label>Role</label>
            <select class="select" name="role">${roleOpts("teacher")}</select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Email</label>
            <input class="input" name="email" type="email" placeholder="name@example.org"></div>
          <div class="field"><label>Username</label>
            <input class="input" name="username" type="text" placeholder="optional (required for learners)"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Password</label>
            <input class="input" name="password" type="password" minlength="6" placeholder="min. 6 characters" required></div>
          <div class="field"><label>Project / department</label>
            <select class="select" name="project">${projectOpts}</select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Region</label>
            <select class="select" name="region">${regionOpts}</select></div>
          <div class="field"><label>School</label>
            <select class="select" name="school">${schoolOpts}</select></div>
        </div>
        <div class="add-user-actions">
          <button class="btn btn-primary" type="submit">Create account</button>
          <button class="btn btn-outline" type="button" data-add-user-cancel>Cancel</button>
        </div>
      </form>

      ${usersListOpen
        ? `<div class="utx-scroll">
            <div class="utx-table">
              <div class="utx-row utx-head">
                <div class="utx-cell">Name</div>
                <div class="utx-cell">Username</div>
                <div class="utx-cell">Password</div>
                <div class="utx-cell">Role</div>
                <div class="utx-cell">Department</div>
                <div class="utx-cell">Region</div>
                <div class="utx-cell">School</div>
                <div class="utx-cell"></div>
              </div>
              <div id="userRows">${rows}</div>
            </div>
          </div>`
        : `<div class="la-summary">${ROLES.filter((r) => roleTally[r.value]).map((r) => `<button class="la-chip la-chip-btn ${usersRoleFilter === r.value ? "active" : ""}" data-users-role-pick="${r.value}">${roleTally[r.value]} ${esc(r.label)}</button>`).join("") || `<span class="hint">No users yet.</span>`}
            <span class="hint" style="align-self:center">— click a role to filter, or <strong>Show list</strong> for full details</span></div>`}
    </div>
    ${editUserId ? editUserModal(users.find((u) => u.id === editUserId), currentUser) : ""}`;
}

/* full-detail edit modal — admin can change every credential incl. password */
function editUserModal(u, currentUser) {
  if (!u) return "";
  const roleOpts = ROLES.map((r) => `<option value="${r.value}" ${r.value === u.role ? "selected" : ""}>${r.label}</option>`).join("");
  const regionOpts = `<option value="">— none —</option>` + Object.keys(REGIONS).map((r) => `<option ${r === u.region ? "selected" : ""}>${esc(r)}</option>`).join("");
  const schoolOpts = `<option value="">— none —</option>` + SCHOOLS.map((s) => `<option ${s === u.school ? "selected" : ""}>${esc(s)}</option>`).join("");
  const projectOpts = `<option value="">— none —</option>` + PROJECTS.map((p) => `<option ${p === u.project ? "selected" : ""}>${esc(p)}</option>`).join("");
  return `
    <div class="modal-overlay" data-edit-overlay>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>Edit user</h2><p class="panel-sub" style="margin:0">${esc(u.fullName || u.username || "")} · full credentials</p></div>
          <button class="icon-btn" data-edit-close aria-label="Close">✕</button>
        </div>
        <form id="editUserForm" class="modal-body" data-uid="${u.id}">
          <div class="form-row">
            <div class="field"><label>Full name</label><input class="input" name="fullName" value="${esc(u.fullName || "")}" required></div>
            <div class="field"><label>Role</label><select class="select" name="role">${roleOpts}</select></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Email</label><input class="input" name="email" type="email" value="${esc(u.email || "")}"></div>
            <div class="field"><label>Username</label><input class="input" name="username" value="${esc(u.username || "")}"></div>
          </div>
          <div class="field"><label>Password</label>
            <div class="pw-edit"><input class="input" name="password" type="password" value="${esc(u.password || "")}" minlength="6">
              <button class="btn btn-outline btn-xs" type="button" data-editpw-toggle>${icon("eye")} Show</button></div></div>
          <div class="form-row">
            <div class="field"><label>Project / department</label><select class="select" name="project">${projectOpts}</select></div>
            <div class="field"><label>Region</label><select class="select" name="region">${regionOpts}</select></div>
          </div>
          <div class="field"><label>School</label><select class="select" name="school">${schoolOpts}</select></div>
        </form>
        <div class="modal-foot">
          <button class="btn btn-primary" data-edit-save>${icon("check")} Save changes</button>
          <button class="btn btn-outline" data-edit-close>Cancel</button>
        </div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------- Kolibri helpers */
function contentCard(r) {
  const k = CONTENT_KINDS[r.kind] || CONTENT_KINDS.reading;
  const done = r.progress >= 100;
  return `<button class="kcard" data-resource-id="${r.id}" data-title="${esc(r.title)}"
      data-channel="${esc(r.channel)}" data-kind="${esc(r.kind)}">
    <div class="kthumb" style="background:${k.color}">
      ${icon(k.icon)}
      <span class="kkind">${k.label}</span>
      ${done ? `<span class="kdone">${icon("check")}</span>` : ""}
    </div>
    <div class="kcard-body">
      <div class="kcard-title">${esc(r.title)}</div>
      <div class="kcard-meta">${esc(r.channel)} · ${esc(r.duration)}</div>
      <div class="kprogress" title="${r.progress}% complete">
        <div class="kprogress-fill" data-kfill style="width:${r.progress}%"></div>
      </div>
    </div>
  </button>`;
}

function cardRow(items) {
  return `<div class="kcard-grid">${items.map(contentCard).join("")}</div>`;
}

function subTabs(tabs, active) {
  return `<div class="ksubtabs">${tabs
    .map(
      (t) =>
        `<button class="ksubtab ${t.id === active ? "active" : ""}" data-subtab="${t.id}">${t.label}</button>`
    )
    .join("")}</div>`;
}

/* vertical icon rail used down the left of the teacher & learner dashboards.
   `attr` is the data-attribute the click wiring already listens for. */
function sideNav(tabs, active, attr) {
  return `<nav class="dash-side" aria-label="Dashboard sections">${tabs
    .map(
      (t) => `<button class="ds-item ${t.id === active ? "active" : ""}" ${attr}="${t.id}" title="${esc(t.label)}">
        <span class="ds-ic">${icon(t.icon)}</span>
        <span class="ds-lab">${esc(t.label)}</span>
      </button>`
    )
    .join("")}</nav>`;
}

/* ---------------------------------------------------------- role bodies */
/* ============================================================
   Admin analytics — live visuals aggregated from the real data
   (users, classes, assessments, assignments, field reports, logins)
   ============================================================ */
const K_EVENTS = "hpf_login_events"; // login / signup inbox
const K_LIBRARY = "hpf_library";     // admin-curated digital library

/* Field officer visit reports — real Postgres table (field_reports), RLS
   scoped so an admin's read returns every officer's rows. Same async-cache
   shape as schools/returns: the dashboard renders synchronously, so this is
   filled on mount and the page re-renders once it resolves. */
let fieldReportsCache = [];
let fieldReportsLoaded = false;
let fieldReportsError = null;
async function loadFieldReports() {
  const { data, error } = await supabase
    .from("field_reports").select("*").order("created_at", { ascending: false });
  fieldReportsLoaded = true;
  fieldReportsError = error ? authMessage(error) : null;
  if (!error) fieldReportsCache = data || [];
  return fieldReportsCache;
}
const getFieldReports = () => fieldReportsCache;

/* An officer's own assigned schools, for their own "/dashboard" role view.
   RLS on school_officer_assignments already scopes a non-admin's read to
   officer_id = auth.uid(), so no explicit filter is needed here — mirrors
   loadFoSchools() in app.js, which does the same thing for the /field-officer
   report form's school picker. */
let myFoSchoolsCache = [];
let myFoSchoolsLoaded = false;
async function loadMyFoSchools() {
  const { data, error } = await supabase
    .from("school_officer_assignments").select("school").order("school");
  myFoSchoolsLoaded = true;
  if (!error) myFoSchoolsCache = (data || []).map((r) => r.school);
  return myFoSchoolsCache;
}

let adminLibOpen = false;            // admin "add resource" form toggle
let adminInboxOpen = false;          // expand the full login-requests list
let usersListOpen = false;           // expand the full user table
let usersRoleFilter = "all";         // sort/filter the user table by role
let usersSort = "name";              // name | role | school
let editUserId = null;               // user open in the admin edit modal
const ADMIN_EMAIL = "patrick@humanpractice.org";
const ORG_DOMAIN = "humanpractice.org"; // org email → admin

/* the shared digital library — seeded once, then admin-managed */
function getLibrary() {
  let lib = read(K_LIBRARY, null);
  if (!lib) {
    lib = LIBRARY_SEED.map((r) => ({ id: uid(), published: true, createdAt: Date.now(), ...r }));
    write(K_LIBRARY, lib);
  }
  return lib;
}
const saveLibrary = (lib) => write(K_LIBRARY, lib);
const publishedLibrary = () => getLibrary().filter((r) => r.published);

/* open a library/shared resource — a data URL (upload) or a normal link */
function openResource(res) {
  const href = res.dataUrl || res.url;
  if (!href) return toast("No file", "This resource has no link or file attached.", "error");
  window.open(href, "_blank", "noopener");
}

/* one resource card (used in the admin library and the learner folder) */
function resourceMeta(res) {
  const t = RESOURCE_TYPES[res.type] || RESOURCE_TYPES.document;
  return { t, sub: `${t.label}${res.fileName ? " · " + res.fileName : ""}${res.category ? " · " + res.category : ""}` };
}

/* ------------------------------------------------------------ admin: digital library */
function digitalLibraryPanel() {
  const lib = getLibrary();
  const typeOpts = Object.entries(RESOURCE_TYPES)
    .map(([v, t]) => `<option value="${v}">${t.label}</option>`)
    .join("");
  const catOpts = LIBRARY_CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join("");

  const rows = lib.length
    ? lib
        .map((r) => {
          const { t, sub } = resourceMeta(r);
          return `<div class="lib-row">
            <span class="lib-ic">${icon(t.icon)}</span>
            <div class="lib-main">
              <div class="lib-title">${esc(r.title)}</div>
              <div class="lib-sub">${esc(sub)}</div>
            </div>
            <button class="btn btn-outline btn-xs" data-lib-open="${r.id}">${icon("externalLink")} Open</button>
            <button class="btn ${r.published ? "btn-outline" : "btn-primary"} btn-xs" data-lib-publish="${r.id}">${r.published ? "Unpublish" : "Publish"}</button>
            <button class="icon-btn danger" data-lib-delete="${r.id}" title="Delete">${icon("trash")}</button>
          </div>`;
        })
        .join("")
    : `<div class="empty-state">The library is empty. Add your first resource above.</div>`;

  const body = `
      <form id="libForm" class="add-user-form" ${adminLibOpen ? "" : "hidden"}>
        <div class="form-row">
          <div class="field"><label>Title</label>
            <input class="input" name="title" required maxlength="120" placeholder="e.g. Grade 4 Numeracy Workbook"></div>
          <div class="field"><label>Category</label>
            <select class="select" name="category">${catOpts}</select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Type</label>
            <select class="select" name="type">${typeOpts}</select></div>
          <div class="field"><label>Link (URL)</label>
            <input class="input" name="url" type="url" placeholder="https://…"></div>
        </div>
        <div class="field"><label>Description</label>
          <input class="input" name="description" maxlength="200" placeholder="One line on what this resource is"></div>
        <div class="field"><label>${icon("upload")} …or upload a file <span style="font-weight:400;color:var(--muted-foreground)">(optional, under 800 KB)</span></label>
          <input class="input" name="file" type="file" data-lib-file>
          <p class="hint">Small files are stored in the browser. For large files (videos, big PDFs), paste a link instead.</p></div>
        <div class="add-user-actions">
          <button class="btn btn-primary" type="submit">${icon("check")} Add to library</button>
          <button class="btn btn-outline" type="button" data-lib-cancel>Cancel</button>
        </div>
      </form>

      <div class="lib-list">${rows}</div>`;

  return `
    <div class="panel" style="margin-top:1.5rem" data-lib-panel>
      <div class="panel-head-row">
        <div>
          <h2>${icon("library")} Digital Library</h2>
          <p class="panel-sub" style="margin:0">Upload and publish resources teachers can share with learners · ${lib.filter((r) => r.published).length} published</p>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
          <button class="btn btn-primary" data-lib-toggle>${icon("plus")} ${adminLibOpen ? "Close" : "Add resource"}</button>
          ${collapseBtn("library")}
        </div>
      </div>
      ${collapseBody("library", body)}
    </div>`;
}
let adminView = "scorecard";         // which analytics tab is open
let scPillar = "education";           // which scorecard pillar is drilled into
/* ELOG-style scorecard filters + board theme */
const scFilter = { region: "all", school: "all", term: "all", pillar: "all", programme: "all", q: "" };

/* ---------------------------------------------------------- dashboard filter bar
   Sits above the whole admin dashboard and drives every widget below it.

   Two copies of the state on purpose. `dashFilter` is what the widgets read;
   `dashDraft` is what the selects write to. Nothing recomputes until Apply
   copies draft over committed, which is the point of having an Apply button —
   an admin can line up county + school + date range and see the dashboard move
   once, rather than watching it rebuild four times on the way there.

   Internet status reads the field reports' sync state: a report is `synced`
   when the officer had a connection to upload it and `pending` when they did
   not, so it doubles as the connectivity filter. */
const DASH_FILTER_DEFAULTS = {
  county: "all", school: "all", range: "all", programme: "all", net: "all",
};
const DATE_RANGES = [
  { id: "all", label: "All time", days: null },
  { id: "7d",  label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "This term (90 days)", days: 90 },
  { id: "365d", label: "This year", days: 365 },
];
const NET_STATUSES = [
  { id: "all", label: "Any connection" },
  { id: "synced", label: "Online · synced" },
  { id: "pending", label: "Offline · pending sync" },
];
let dashFilter = { ...DASH_FILTER_DEFAULTS };
let dashDraft = { ...DASH_FILTER_DEFAULTS };

const dashFilterActive = () =>
  Object.keys(DASH_FILTER_DEFAULTS).some((k) => dashFilter[k] !== DASH_FILTER_DEFAULTS[k]);
const dashDraftDirty = () =>
  Object.keys(DASH_FILTER_DEFAULTS).some((k) => dashDraft[k] !== dashFilter[k]);

/* Cutoff timestamp for the active range, or null for "all time". */
function dashRangeStart() {
  const r = DATE_RANGES.find((x) => x.id === dashFilter.range);
  return r && r.days ? Date.now() - r.days * 864e5 : null;
}

/* The single place a field report is tested against the bar. Everything that
   counts reports — KPIs, the sync donut, county ranking, the school map —
   goes through here so one widget can never disagree with another. */
function reportPassesFilter(r) {
  if (dashFilter.county !== "all" && r.county !== dashFilter.county) return false;
  if (dashFilter.school !== "all" && r.school !== dashFilter.school) return false;
  if (dashFilter.net !== "all" && (r.status || "pending") !== dashFilter.net) return false;
  const from = dashRangeStart();
  if (from) {
    // Postgres hands back an ISO string, not the epoch number dashRangeStart
    // compares against.
    const at = r.created_at ? Date.parse(r.created_at) : null;
    // A report with no timestamp cannot be shown to fall inside a window;
    // excluding it is the honest reading of "last 7 days".
    if (!at || at < from) return false;
  }
  return true;
}
const HPF_TERMS = ["Term 1", "Term 2", "Term 3"];

/* ---------------------------------------------------------- school returns
   The termly return a head of institution files: enrolment, staffing,
   retention, and the infrastructure/ICT facts HPF's pillars are scored on.
   One row per school per term (supabase/patch-07-school-returns.sql), so
   "all terms" is an aggregate over history rather than a different record.

   Same shape as the schools cache: the dashboard renders synchronously, so
   reads come from a module-level cache and writes refresh it. */
let returnsCache = [];
let returnsLoaded = false;
let returnsError = null;
let returnEditId = null;     // return open in the form
let returnFormOpen = false;
let returnTermView = "all";  // which term the leader is looking at
let returnHistoryOpen = null; // return whose correction trail is expanded

const DROPOUT_REASONS = [
  "Fees / poverty", "Early marriage", "Teenage pregnancy", "Child labour",
  "Distance to school", "Illness or disability", "Family relocation",
  "Insecurity / drought", "Lack of interest", "Other",
];
const WATER_SOURCES = ["Piped", "Borehole", "Rainwater harvesting", "River / stream", "Water vendor", "None"];
const POWER_OPTIONS = ["Grid", "Solar", "Generator", "None"];
const NET_OPTIONS  = ["Stable", "Intermittent", "None"];
const HEAD_TITLES  = ["Mr", "Mrs", "Miss", "Ms", "Dr", "Prof", "Rev", "Sr"];
const K_RETURN_DRAFT = "hpf_return_draft";

/* CBC grade ladder. `position` keeps PP1 < PP2 < Grade 1... in the database,
   since alphabetical would put "Grade 10" between 1 and 2. */
const GRADES = [
  "PP1", "PP2", "Grade 1", "Grade 2", "Grade 3", "Grade 4",
  "Grade 5", "Grade 6", "Grade 7", "Grade 8", "Grade 9",
];
let gradesCache = [];
async function loadGrades() {
  const { data, error } = await supabase
    .from("school_return_grades").select("*").order("position");
  if (!error) gradesCache = data || [];
  return gradesCache;
}
const gradesFor = (returnId) =>
  gradesCache.filter((g) => g.return_id === returnId)
             .sort((a, b) => a.position - b.position);

/* Enrolment by grade across a set of returns, boys and girls kept apart. */
function gradeBreakdown(rows) {
  const ids = new Set(rows.map((r) => r.id));
  const out = GRADES.map((g) => ({ grade: g, boys: 0, girls: 0 }));
  gradesCache.filter((g) => ids.has(g.return_id)).forEach((g) => {
    const slot = out.find((o) => o.grade === g.grade);
    if (slot) { slot.boys += +g.boys || 0; slot.girls += +g.girls || 0; }
  });
  return out.filter((o) => o.boys || o.girls);
}

async function loadReturns() {
  const { data, error } = await supabase
    .from("school_returns")
    .select("*")
    .order("year", { ascending: false })
    .order("term");
  returnsLoaded = true;
  returnsError = error ? authMessage(error) : null;
  if (!error) returnsCache = data || [];
  return returnsCache;
}
const getReturns = () => returnsCache;

/* Corrections to already-filed returns. Written by a database trigger, never
   by the client, so the trail holds even if a figure is changed outside the
   app. Read-only here. */
let revisionsCache = [];
async function loadRevisions() {
  const { data, error } = await supabase
    .from("school_return_revisions")
    .select("*")
    .order("corrected_at", { ascending: false });
  if (!error) revisionsCache = data || [];
  return revisionsCache;
}
const revisionsFor = (id) => revisionsCache.filter((r) => r.return_id === id);

/* Field name -> the label the head saw on the form, so history reads in the
   same words as the form rather than in column names. */
const RETURN_LABELS = {
  boys: "Boys enrolled", girls: "Girls enrolled",
  learners_with_disability: "Learners with a disability",
  attendance_rate: "Attendance rate", tsc_teachers: "TSC teachers",
  non_tsc_teachers: "Non-TSC teachers", support_staff: "Support staff",
  teachers_trained_term: "Teachers trained", dropouts: "Dropouts",
  dropout_reason: "Dropout reason", dropout_reason_other: "Dropout reason (other)",
  transfers_in: "Transfers in", transfers_out: "Transfers out",
  mean_score: "Mean exam score", classrooms: "Classrooms", desks: "Desks",
  toilets: "Latrines", water_source: "Water source", electricity: "Power supply",
  computers: "Computers", internet_status: "Internet", feeding_programme: "Feeding programme",
  income_projects: "Income projects", notes: "Notes", term: "Term", year: "Year",
};
const returnLabel = (k) => RETURN_LABELS[k] || k;
const showVal = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));
const returnsForSchool = (school) => returnsCache.filter((r) => r.school === school);
const enrolTotal = (r) => (+r.boys || 0) + (+r.girls || 0);

/* Sum a set of returns into one shape the scorecard and the "all terms" view
   both read. Counts add up; rates are averaged, weighted by enrolment so a
   30-learner school cannot swing the mean as hard as a 600-learner one. */
function aggregateReturns(rows) {
  const sum = (k) => rows.reduce((a, r) => a + (+r[k] || 0), 0);
  const enrolled = rows.reduce((a, r) => a + enrolTotal(r), 0);
  const weighted = (k) => {
    const withVal = rows.filter((r) => r[k] !== null && r[k] !== undefined && r[k] !== "");
    const w = withVal.reduce((a, r) => a + (enrolTotal(r) || 1), 0);
    if (!w) return null;
    return Math.round(withVal.reduce((a, r) => a + (+r[k] || 0) * (enrolTotal(r) || 1), 0) / w);
  };
  const dropouts = sum("dropouts");
  const reasons = {};
  rows.forEach((r) => {
    if (!r.dropouts) return;
    const key = r.dropout_reason === "Other" && r.dropout_reason_other
      ? r.dropout_reason_other : r.dropout_reason;
    if (key) reasons[key] = (reasons[key] || 0) + (+r.dropouts || 0);
  });
  return {
    returns: rows.length,
    boys: sum("boys"), girls: sum("girls"), enrolled,
    disability: sum("learners_with_disability"),
    tsc: sum("tsc_teachers"), nonTsc: sum("non_tsc_teachers"),
    support: sum("support_staff"), trained: sum("teachers_trained_term"),
    dropouts,
    // Dropout rate is per-term leavers over enrolment for those same terms.
    dropoutRate: enrolled ? +((dropouts / enrolled) * 100).toFixed(1) : 0,
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]),
    attendance: weighted("attendance_rate"),
    mean: weighted("mean_score"),
    classrooms: sum("classrooms"), desks: sum("desks"), toilets: sum("toilets"),
    computers: sum("computers"),
    // Ratios are what a head is actually asked about in a review.
    learnersPerTeacher: (sum("tsc_teachers") + sum("non_tsc_teachers"))
      ? Math.round(enrolled / (sum("tsc_teachers") + sum("non_tsc_teachers"))) : null,
    learnersPerClassroom: sum("classrooms") ? Math.round(enrolled / sum("classrooms")) : null,
    learnersPerDesk: sum("desks") ? +(enrolled / sum("desks")).toFixed(1) : null,
    learnersPerComputer: sum("computers") ? Math.round(enrolled / sum("computers")) : null,
  };
}
let scTheme = "dark"; // "dark" | "light"

/* Scorecard regions and schools follow the schools table once it has loaded,
   and fall back to the bundled REGIONS map until then (or if the fetch fails)
   so the filters are never empty. A school added in a county outside the four
   seeded HPF regions still shows up — hence the union rather than REGIONS
   alone, which would silently hide it from every filter. */
function scRegions() {
  const counties = getSchools().map((s) => s.county).filter(Boolean);
  return [...new Set([...Object.keys(REGIONS), ...counties])];
}

function schoolsInRegion(name) {
  const live = getSchools();
  return live.length
    ? live.filter((s) => s.county === name).map((s) => s.name)
    : REGIONS[name] || [];
}

/* schools available under the current region filter */
function filterSchools() {
  const live = getSchools();
  if (scFilter.region !== "all") return schoolsInRegion(scFilter.region);
  return live.length ? live.map((s) => s.name) : SCHOOLS;
}

const ROLE_COLOR = {
  learner: "oklch(52% 0.14 148)",
  teacher: "oklch(68% 0.17 155)",
  school_leader: "oklch(78% 0.15 75)",
  field_officer: "oklch(55% 0.15 300)",
  staff: "oklch(58% 0.18 230)",
  admin: "oklch(62% 0.24 27)",
};
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* read every store and compute the numbers the analytics tabs visualize */
function computeAdminStats(events = []) {
  // Real accounts (profiles, every device) unioned with local-only accounts
  // (this device only) — the same merge shape as Repo.allEvents() in app.js,
  // and for the same reason: a learner has no Supabase account at all, so
  // "every account" can only ever mean "every real account, plus whatever
  // this browser happens to know about locally." localOnly is kept as its
  // own flag on each row rather than silently merged in as if it were a
  // global count — see roleCounts vs localOnlyRoleCounts below.
  const localUsers = read(K_USERS, []);
  const users = [
    ...profilesCache.map((p) => ({
      id: p.id, role: p.role, county: p.county, createdAt: new Date(p.created_at).getTime(), localOnly: false,
    })),
    ...localUsers.filter((u) => u.role === "learner" || !profilesCache.some((p) => p.id === u.id))
      .map((u) => ({ ...u, localOnly: true })),
  ];
  // getClasses(), not a raw read: it's the same store, but also carries the
  // assessment-shape migration that used to run only inside the old
  // localStorage-only getClasses(). An admin viewing this before the coach
  // view has ever mounted in this browser would otherwise see un-migrated
  // assessment rows.
  const classes = getClasses();
  // Filtered once, here. Every widget that counts reports — KPIs, sync donut,
  // county ranking, the school map — reads this array, so the filter bar can
  // never leave two widgets disagreeing about the same number.
  //
  // "Pending" reports live only in a field officer's own browser outbox until
  // they sync (app.js, K_FO_OUTBOX) — a row only ever lands in this table once
  // it has. So an admin's view of field_reports is, structurally, always 100%
  // synced; that is a limit on what's visible from here, not a bug.
  const reports = getFieldReports().filter(reportPassesFilter);
  const now = Date.now(), day = 864e5;

  // roles + counties: roleCounts is the honest, global, real number (profiles
  // only — every device); localOnlyRoleCounts is what's additionally known on
  // just this device (learners, plus any not-yet-migrated legacy accounts).
  // Never add the two together into one figure — that would silently claim a
  // device-local count as if it were global.
  const roleCounts = {};
  const localOnlyRoleCounts = {};
  DASH_ROLES.forEach((r) => { roleCounts[r] = 0; localOnlyRoleCounts[r] = 0; });
  const county = {};
  users.forEach((u) => {
    (u.localOnly ? localOnlyRoleCounts : roleCounts)[u.role] = ((u.localOnly ? localOnlyRoleCounts : roleCounts)[u.role] || 0) + 1;
    if (u.county) county[u.county] = (county[u.county] || 0) + 1;
  });

  // learners + teachers, walked from the classes store
  let enrolled = 0, assignments = 0, assessments = 0, activeSessions = 0;
  const subs = [], assignPcts = [], classRows = [];
  classes.forEach((c) => {
    enrolled += c.learners.length;
    assignments += (c.assignments || []).length;
    (c.assignments || []).forEach((a) => {
      if ((a.session || "planned") === "active") activeSessions++;
      a.results.forEach((r) => assignPcts.push(r.pct));
    });
    const cSubs = [];
    (c.assessments || []).forEach((a) => {
      assessments++;
      if ((a.session || "planned") === "active") activeSessions++;
      (a.submissions || []).forEach((s) => { subs.push(s); cSubs.push(s); });
    });
    classRows.push({
      name: c.name, learners: c.learners.length,
      assignments: (c.assignments || []).length,
      assessments: (c.assessments || []).length,
      avg: cSubs.length ? Math.round(cSubs.reduce((x, s) => x + s.pct, 0) / cSubs.length) : 0,
    });
  });

  // assessment score distribution + pass rate
  const bands = [0, 0, 0, 0]; // 0–49 / 50–69 / 70–84 / 85–100
  subs.forEach((s) => { const p = s.pct; bands[p < 50 ? 0 : p < 70 ? 1 : p < 85 ? 2 : 3]++; });
  const passed = subs.filter((s) => s.pct >= 50).length;
  const avgScore = subs.length ? Math.round(subs.reduce((a, s) => a + s.pct, 0) / subs.length) : 0;

  // assignment completion distribution
  const comp = { done: 0, prog: 0, none: 0 };
  assignPcts.forEach((p) => (p >= 100 ? comp.done++ : p > 0 ? comp.prog++ : comp.none++));

  // field-officer aggregates
  const foCounty = {}, fo = { synced: 0, pending: 0 };
  let learnersReached = 0, teachersReached = 0;
  reports.forEach((r) => {
    foCounty[r.county] = (foCounty[r.county] || 0) + 1;
    r.status === "synced" ? fo.synced++ : fo.pending++;
    learnersReached += +r.learners || 0;
    teachersReached += +r.teachers || 0;
  });

  // login/signup activity over the last 7 days
  const trend = new Array(7).fill(0);
  events.forEach((e) => {
    const ago = Math.floor((now - e.at) / day);
    if (ago >= 0 && ago < 7) trend[6 - ago]++;
  });
  const trendLabels = trend.map((_, k) => DOW[new Date(now - (6 - k) * day).getDay()]);

  return {
    users, roleCounts, localOnlyRoleCounts, county, enrolled, assignments, assessments, activeSessions,
    classRows, subs, bands, passed, avgScore, comp,
    reports, foCounty, fo, learnersReached, teachersReached,
    trend, trendLabels, totalUsers: users.length,
    totalStaff: profilesCache.length, totalLocalOnly: users.filter((u) => u.localOnly).length,
  };
}

/* ---------------------------------------------------------- chart bits */
/* line / area trend chart — SVG polyline over evenly spaced points */
function lineChart(series, labels, color = "var(--primary)") {
  if (!series.length) return `<div class="empty-state">No trend data yet.</div>`;
  const W = 520, H = 170, PAD = 28;
  const max = Math.max(...series, 100);
  const min = Math.min(...series, 0);
  const span = max - min || 1;
  const x = (i) => PAD + (i * (W - PAD * 2)) / Math.max(series.length - 1, 1);
  const y = (v) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const pts = series.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${PAD},${H - PAD} ${pts} ${x(series.length - 1)},${H - PAD}`;
  const dots = series
    .map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${color}"><title>${esc(labels[i] || "")}: ${v}</title></circle>`)
    .join("");
  const ticks = labels
    .map((l, i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="lc-lab">${esc(l)}</text>`)
    .join("");
  return `<div class="linechart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
      <line x1="${PAD}" y1="${y(max)}" x2="${W - PAD}" y2="${y(max)}" class="lc-grid"/>
      <line x1="${PAD}" y1="${y(min + span / 2)}" x2="${W - PAD}" y2="${y(min + span / 2)}" class="lc-grid"/>
      <polygon points="${area}" fill="${color}" opacity="0.12"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5"
        stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}${ticks}
    </svg>
  </div>`;
}

/* categorical palette used across the scorecard charts */
const CHART_COLORS = [
  "oklch(62% 0.19 250)", "oklch(70% 0.14 175)", "oklch(76% 0.15 75)", "oklch(58% 0.20 300)",
  "oklch(66% 0.17 20)", "oklch(70% 0.15 220)", "oklch(72% 0.17 140)", "oklch(66% 0.18 45)",
];
const chartColor = (i) => CHART_COLORS[i % CHART_COLORS.length];

/* y-axis ticks shared by the axis charts */
function axisTicks(max, steps = 8) {
  const out = [];
  for (let i = steps; i >= 0; i--) out.push(Math.round((max / steps) * i));
  return out;
}

/* ELOG-style vertical bar chart: y-axis, gridlines, multi-colour animated
   bars, rotated x labels and a hover tooltip */
function axisChart(values, labels, opts = {}) {
  if (!values.length) return `<div class="empty-state">No data yet.</div>`;
  const max = Math.max(10, Math.ceil(Math.max(...values) / 10) * 10);
  const ticks = axisTicks(max);
  const rotate = opts.rotate !== false && labels.some((l) => l.length > 6);
  return `<div class="axc ${rotate ? "axc-rot" : ""}">
    <div class="axc-y">${ticks.map((t) => `<span>${t}</span>`).join("")}</div>
    <div class="axc-plot">
      <div class="axc-grid">${ticks.map(() => `<i></i>`).join("")}</div>
      <div class="axc-bars">${values
        .map(
          (v, i) => `<div class="axc-col">
            <div class="axc-bar" style="height:${(v / max) * 100}%;background:${opts.color || chartColor(i)};animation-delay:${i * 70}ms">
              <span class="axc-tip">${esc(labels[i])}<b>${opts.label || "Score"}: ${v}${opts.unit || ""}</b></span>
            </div>
          </div>`
        )
        .join("")}</div>
    </div>
    <div class="axc-x">${labels.map((l) => `<span title="${esc(l)}">${esc(l)}</span>`).join("")}</div>
  </div>`;
}

/* horizontal multi-colour bars — "Performance by Pillar" */
function hBarChart(items) {
  if (!items.length) return `<div class="empty-state">No data yet.</div>`;
  const max = Math.max(10, Math.ceil(Math.max(...items.map((i) => i.value)) / 10) * 10);
  return `<div class="hbc">${items
    .map(
      (it, i) => `<div class="hbc-row">
        <span class="hbc-lab" title="${esc(it.label)}">${esc(it.label)}</span>
        <span class="hbc-track">
          <span class="hbc-fill" style="width:${(it.value / max) * 100}%;background:${it.color || chartColor(i)};animation-delay:${i * 80}ms">
            <b class="hbc-val">${it.value}</b>
          </span>
        </span>
      </div>`
    )
    .join("")}</div>`;
}

/* every chart panel gets a maximize control */
function chartPanel(title, bodyHtml, id, note) {
  return `<div class="scd-panel" data-chart-panel="${id}">
    <div class="scd-panel-head">
      <h3>${title}</h3>
      <button class="icon-btn scd-max" data-chart-max="${id}" title="Full screen">${icon("externalLink")}</button>
    </div>
    ${note ? `<p class="scd-narrative">${note}</p>` : ""}
    <div class="scd-panel-body">${bodyHtml}</div>
  </div>`;
}

/* grouped bar chart — one cluster per category, one bar per series */
function groupedBars(categories, seriesNames, matrix, colors) {
  if (!categories.length) return `<div class="empty-state">No data yet.</div>`;
  const flat = matrix.flat();
  const max = Math.max(10, Math.ceil(Math.max(...flat, 10) / 10) * 10);
  const ticks = axisTicks(max);
  return `<div class="gb-wrap">
    <div class="gb-legend">${seriesNames
      .map((n, i) => `<span class="cl-row"><span class="cl-dot" style="background:${colors[i]}"></span>${esc(n)}</span>`)
      .join("")}</div>
    <div class="axc axc-rot">
      <div class="axc-y">${ticks.map((t) => `<span>${t}</span>`).join("")}</div>
      <div class="axc-plot">
        <div class="axc-grid">${ticks.map(() => `<i></i>`).join("")}</div>
        <div class="axc-bars">${categories
          .map(
            (cat, ci) => `<div class="axc-col gb-col">${seriesNames
              .map(
                (n, si) => `<div class="axc-bar gb-bar" style="height:${(matrix[ci][si] / max) * 100}%;background:${colors[si]};animation-delay:${(ci * seriesNames.length + si) * 60}ms">
                  <span class="axc-tip">${esc(cat)} · ${esc(n)}<b>Score: ${matrix[ci][si]}</b></span>
                </div>`
              )
              .join("")}</div>`
          )
          .join("")}</div>
      </div>
      <div class="axc-x">${categories.map((c) => `<span title="${esc(c)}">${esc(c)}</span>`).join("")}</div>
    </div>
  </div>`;
}

/* region cartogram — a map-style grid of HPF regions coloured by score */
function regionMap(regions, activeRegion) {
  return `<div class="rmap">${regions
    .map(
      (r) => `<button class="rmap-cell rag-${rag(r.score)} ${r.name === activeRegion ? "active" : ""}"
        data-sc-region-pick="${esc(r.name)}" title="Click to focus ${esc(r.name)}">
        <div class="rmap-name">${esc(r.name)}</div>
        <div class="rmap-score">${countNum(r.score)}</div>
        <div class="rmap-meta">${r.schools} school${r.schools === 1 ? "" : "s"} · ${r.reports} report${r.reports === 1 ? "" : "s"}</div>
        <div class="rmap-bar"><span style="width:${r.score}%;background:${ragColor(r.score)}"></span></div>
      </button>`
    )
    .join("")}</div>`;
}

/* ---------------------------------------------------------- school map
   Satellite view of an HPF school + an admin-editable story. Uses Google's
   keyless embed (t=k → satellite), so no API key or SDK is needed.

   Schools (and their stories) live in Postgres — see
   supabase/patch-02-schools.sql. The dashboard renders synchronously, so the
   panel reads a module-level cache that loadSchools() fills; writes refresh
   the cache before re-rendering. Reads are open to any signed-in user, writes
   are admin-only, so a non-admin simply never sees the manage controls. */
let schoolsCache = [];
let schoolsLoaded = false;
let schoolsError = null;

async function loadSchools() {
  const { data, error } = await supabase
    .from("schools")
    .select("id, name, county, lat, lng, story")
    .order("county")
    .order("name");
  schoolsLoaded = true;
  schoolsError = error ? authMessage(error) : null;
  if (!error) schoolsCache = data || [];
  return schoolsCache;
}
const getSchools = () => schoolsCache;
const findSchool = (id) => schoolsCache.find((s) => s.id === id) || null;

/* Facilities (patch-13, one row per school) and programmes (many rows per
   school) — loaded alongside schoolsCache in the same mount-time batch,
   since the total volume is bounded by school count (a few dozen at most),
   not per-school lazy-loaded the way per-class attendance is. */
let schoolFacilitiesCache = [];
let schoolProgrammesCache = [];
let facilitiesLoaded = false;
async function loadSchoolFacilities() {
  const [facRes, progRes] = await Promise.all([
    supabase.from("school_facilities").select("*"),
    supabase.from("school_programmes").select("*").order("started_at", { ascending: false }),
  ]);
  facilitiesLoaded = true;
  if (!facRes.error) schoolFacilitiesCache = facRes.data || [];
  if (!progRes.error) schoolProgrammesCache = progRes.data || [];
  return schoolFacilitiesCache;
}
const findFacilities = (schoolId) => schoolFacilitiesCache.find((f) => f.school_id === schoolId) || null;
const programmesFor = (schoolId) => schoolProgrammesCache.filter((p) => p.school_id === schoolId);
let facilitiesEditing = false;
let programmeFormOpen = false;

let mapSchool = null;   // id of the school currently open on the map
let mapEditing = false; // story editor open?
let editSchoolId = null;   // school open in the admin editor
let schoolFormOpen = false;
let schoolManageOpen = false; // show edit/delete controls on the map pins

/* ---------------------------------------------------------- editable chart titles */
const K_TITLES = "hpf_chart_titles";
const getTitles = () => read(K_TITLES, {});
const chartTitle = (id, fallback) => getTitles()[id] || fallback;
let editTitleId = null;    // chart whose title is being renamed

/* ---------------------------------------------------------- custom activity charts
   [{ id, title, type: bar|hbar|pie|line, activityIds: [] }] */
const K_CHARTS = "hpf_custom_charts";
const getCustomCharts = () => read(K_CHARTS, []);
const saveCustomCharts = (c) => write(K_CHARTS, c);
let chartFormOpen = false;

function schoolForm(existing) {
  const countyOpts = COUNTIES.map(
    (c) => `<option value="${esc(c)}" ${existing?.county === c ? "selected" : ""}>${esc(c)}</option>`
  ).join("");
  return `<form id="schoolForm" class="add-user-form" data-id="${existing ? esc(existing.id) : ""}">
    <div class="form-row">
      <div class="field"><label>School name</label>
        <input class="input" name="name" type="text" required placeholder="e.g. Meru Primary School" value="${existing ? esc(existing.name) : ""}"></div>
      <div class="field"><label>County</label>
        <select class="select" name="county" required>
          <option value="">Select county</option>${countyOpts}
        </select></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Latitude</label>
        <input class="input" name="lat" type="number" step="any" required placeholder="e.g. 0.0463" value="${existing ? existing.lat : ""}"></div>
      <div class="field"><label>Longitude</label>
        <input class="input" name="lng" type="number" step="any" required placeholder="e.g. 37.6559" value="${existing ? existing.lng : ""}"></div>
    </div>
    <div class="add-user-actions">
      <button class="btn btn-primary btn-xs" type="submit">${icon("check")} ${existing ? "Save changes" : "Add school"}</button>
      <button class="btn btn-outline btn-xs" type="button" data-school-form-cancel>Cancel</button>
    </div>
  </form>`;
}

/* Facilities (patch-13) — current-state infrastructure inventory, distinct
   from school_returns' termly historical snapshot of similar fields
   (returns answer "what did term 2 look like"; this answers "what's true
   now"). One row per school, upserted on save since a school may not have
   one yet. Write is admin-only at the RLS layer (already verified) — the
   edit control itself has no extra client-side role check because of it. */
const FACILITY_FLAGS = [
  { key: "library", label: "Library" },
  { key: "playground", label: "Playground" },
  { key: "solar", label: "Solar power" },
  { key: "fence", label: "Perimeter fence" },
  { key: "dining_hall", label: "Dining hall" },
];

function schoolFacilitiesPanel(school) {
  const f = findFacilities(school.id) || {};
  const opts = (list, selected) => list.map((v) => `<option ${selected === v ? "selected" : ""}>${esc(v)}</option>`).join("");

  if (facilitiesEditing) {
    return `<div class="smap-story">
      <div class="smap-story-h"><h4>${icon("school")} Facilities</h4></div>
      <form id="facilitiesForm" data-school-id="${esc(school.id)}">
        <div class="form-row">
          <div class="field"><label>Classrooms</label><input class="input" type="number" min="0" name="classrooms" value="${f.classrooms ?? ""}"></div>
          <div class="field"><label>Toilets</label><input class="input" type="number" min="0" name="toilets" value="${f.toilets ?? ""}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Water source</label><select class="select" name="water_source"><option value="">—</option>${opts(WATER_SOURCES, f.water_source)}</select></div>
          <div class="field"><label>Electricity</label><select class="select" name="electricity"><option value="">—</option>${opts(POWER_OPTIONS, f.electricity)}</select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Computers</label><input class="input" type="number" min="0" name="computers" value="${f.computers ?? ""}"></div>
          <div class="field"><label>Internet</label><select class="select" name="internet_status"><option value="">—</option>${opts(NET_OPTIONS, f.internet_status)}</select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Dormitories</label><input class="input" type="number" min="0" name="dormitories" value="${f.dormitories ?? ""}"></div>
          <div class="field"><label>Teachers' houses</label><input class="input" type="number" min="0" name="teachers_houses" value="${f.teachers_houses ?? ""}"></div>
        </div>
        <div class="field">
          ${FACILITY_FLAGS.map((ff) => `<label style="margin-right:1rem;display:inline-flex;align-items:center;gap:.3rem">
            <input type="checkbox" name="${ff.key}" ${f[ff.key] ? "checked" : ""}> ${esc(ff.label)}</label>`).join("")}
        </div>
        <div class="add-user-actions" style="margin-top:.6rem">
          <button class="btn btn-primary btn-xs" type="submit">${icon("check")} Save facilities</button>
          <button class="btn btn-outline btn-xs" type="button" data-facilities-cancel>Cancel</button>
        </div>
      </form>
    </div>`;
  }

  const known = Object.keys(f).length > 0;
  const tags = FACILITY_FLAGS.filter((ff) => f[ff.key]).map((ff) => `<span class="pill role-pill">${esc(ff.label)}</span>`).join("");
  return `<div class="smap-story">
    <div class="smap-story-h">
      <h4>${icon("school")} Facilities</h4>
      <button class="btn btn-outline btn-xs" data-facilities-edit>${icon("pen")} ${known ? "Edit" : "Add"} facilities</button>
    </div>
    ${known
      ? `<div class="s-meta" style="margin-bottom:.4rem">
           ${f.classrooms ?? "—"} classrooms · ${f.toilets ?? "—"} toilets · ${esc(f.water_source || "no water source recorded")} ·
           ${esc(f.electricity || "no electricity recorded")} · ${f.computers ?? "—"} computers · ${esc(f.internet_status || "no internet status recorded")}
         </div>
         <div>${tags || `<span class="s-meta">No library, playground, solar, fence, or dining hall recorded.</span>`}</div>`
      : `<p class="smap-story-body dim">No facilities recorded yet for ${esc(school.name)}. Click <strong>Add facilities</strong> to record what's there.</p>`}
  </div>`;
}

/* Programmes (patch-13) — which HPF programmes run at a school and their
   status. Simple list + add form; editing an existing programme's status
   is a fast follow once this proves useful, not blocking the first pass. */
function schoolProgrammesPanel(school) {
  const rows = programmesFor(school.id);
  const list = rows.length
    ? rows.map((p) => `<div class="submission">
        <div style="flex:1;min-width:0"><div class="s-title">${esc(p.programme)}</div>
          ${p.started_at ? `<div class="s-meta">Since ${esc(p.started_at)}</div>` : ""}</div>
        <span class="pill role-pill">${esc(p.status)}</span>
      </div>`).join("")
    : `<p class="smap-story-body dim">No programmes recorded yet for ${esc(school.name)}.</p>`;

  const form = programmeFormOpen ? `
    <form id="programmeForm" data-school-id="${esc(school.id)}" style="margin-top:.6rem">
      <div class="form-row">
        <div class="field"><label>Programme</label><input class="input" name="programme" required placeholder="e.g. Micro Enterprise Programme"></div>
        <div class="field"><label>Status</label>
          <select class="select" name="status">
            <option value="planned">Planned</option>
            <option value="active" selected>Active</option>
            <option value="completed">Completed</option>
            <option value="paused">Paused</option>
          </select></div>
      </div>
      <div class="add-user-actions">
        <button class="btn btn-primary btn-xs" type="submit">${icon("check")} Add programme</button>
        <button class="btn btn-outline btn-xs" type="button" data-programme-cancel>Cancel</button>
      </div>
    </form>` : "";

  return `<div class="smap-story">
    <div class="smap-story-h">
      <h4>${icon("layers")} Programmes</h4>
      <button class="btn btn-outline btn-xs" data-programme-toggle>${icon("plus")} Add programme</button>
    </div>
    ${list}
    ${form}
  </div>`;
}

function schoolMapPanel(s) {
  const schools = getSchools();
  const byCounty = {};
  schools.forEach((sc) => {
    (byCounty[sc.county || "Unassigned"] = byCounty[sc.county || "Unassigned"] || []).push(sc);
  });
  const active = findSchool(mapSchool);
  const editing = findSchool(editSchoolId);

  const pins = Object.keys(byCounty).sort()
    .map(
      (county) => `<div class="smap-county">
        <div class="smap-county-h">${icon("mapPin")} ${esc(county)} <span class="smap-n">${byCounty[county].length}</span></div>
        <div class="smap-pins">${byCounty[county]
          .map((sc) => {
            const reports = s.reports.filter((r) => r.school === sc.name).length;
            return `<div class="smap-pin-row">
              <button class="smap-pin ${sc.id === mapSchool ? "active" : ""}" data-map-school="${esc(sc.id)}">
                ${icon("school")} <span>${esc(sc.name.replace(/ (Primary )?School$/i, ""))}</span>
                ${sc.story ? `<i class="smap-dot" title="Has a story"></i>` : ""}
                <b>${reports}</b>
              </button>
              ${schoolManageOpen
                ? `<button class="icon-btn" data-school-edit="${esc(sc.id)}" title="Edit school">${icon("pen")}</button>
                   <button class="icon-btn danger" data-school-delete="${esc(sc.id)}" title="Delete school">${icon("trash")}</button>`
                : ""}
            </div>`;
          })
          .join("")}</div>
      </div>`
    )
    .join("");

  let detail = `<div class="empty-state">Pick a school on the left to open its satellite view and story.</div>`;
  if (active) {
    // keyless Google Maps embed, satellite basemap
    const src = `https://maps.google.com/maps?q=${active.lat},${active.lng}&t=k&z=17&hl=en&output=embed`;
    const story = active.story || "";
    const hasGps = Number.isFinite(active.lat) && Number.isFinite(active.lng);
    detail = `
      <div class="smap-detail">
        <div class="smap-head">
          <div>
            <div class="smap-title">${icon("school")} ${esc(active.name)}</div>
            <div class="smap-meta">${esc(active.county || "No county")}${active.county ? " County" : ""}${
              hasGps ? ` · ${active.lat.toFixed(4)}, ${active.lng.toFixed(4)}` : " · no GPS recorded"}</div>
          </div>
          ${hasGps
            ? `<a class="btn btn-outline btn-xs" target="_blank" rel="noopener"
                 href="https://www.google.com/maps/search/?api=1&query=${active.lat},${active.lng}">${icon("externalLink")} Open in Maps</a>`
            : ""}
        </div>
        ${hasGps
          ? `<div class="smap-frame">
               <iframe src="${src}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
                 title="Satellite view of ${esc(active.name)}"></iframe>
             </div>`
          : `<div class="empty-state">No coordinates for ${esc(active.name)} yet. Add a latitude and longitude to see the satellite view.</div>`}
        <div class="smap-story">
          <div class="smap-story-h">
            <h4>${icon("book")} School story</h4>
            <button class="btn btn-outline btn-xs" data-story-edit>${icon("pen")} ${story ? "Edit" : "Add"} story</button>
          </div>
          ${mapEditing
            ? `<form id="storyForm" data-id="${esc(active.id)}">
                 <textarea class="input" name="story" rows="5" placeholder="What is happening at ${esc(active.name)}? Buildings, programmes, impact…">${esc(story)}</textarea>
                 <div class="add-user-actions" style="margin-top:.6rem">
                   <button class="btn btn-primary btn-xs" type="submit">${icon("check")} Save story</button>
                   <button class="btn btn-outline btn-xs" type="button" data-story-cancel>Cancel</button>
                 </div>
               </form>`
            : story
              ? `<p class="smap-story-body">${esc(story)}</p>`
              : `<p class="smap-story-body dim">No story yet for ${esc(active.name)}. Click <strong>Add story</strong> to write one.</p>`}
        </div>
        ${schoolFacilitiesPanel(active)}
        ${schoolProgrammesPanel(active)}
      </div>`;
  }

  // the list arrives from Postgres, so distinguish "still loading" from
  // "loaded and genuinely empty" — otherwise the first paint reads as an
  // empty database and invites an admin to re-add schools that already exist.
  if (!schoolsLoaded) {
    return `<div class="smap-wrap"><div class="empty-state">Loading schools…</div></div>`;
  }
  if (schoolsError) {
    return `<div class="smap-wrap">
      <div class="empty-state">Could not load schools — ${esc(schoolsError)}
        <div style="margin-top:.6rem"><button class="btn btn-outline btn-xs" data-schools-retry>${icon("refresh")} Try again</button></div>
      </div>
    </div>`;
  }

  return `<div class="smap-wrap">
    <div class="smap-toolbar">
      <button class="btn btn-outline btn-xs" data-school-manage-toggle>${icon("pen")} ${schoolManageOpen ? "Done managing" : "Manage schools"}</button>
      ${schoolManageOpen ? `<button class="btn btn-primary btn-xs" data-school-add>${icon("plus")} Add school</button>` : ""}
    </div>
    ${schoolFormOpen ? schoolForm(editing) : ""}
    <div class="smap">
      <div class="smap-side">${pins || `<div class="empty-state">No schools yet. Click <strong>Add school</strong> to create one.</div>`}</div>
      <div class="smap-main">${detail}</div>
    </div>
  </div>`;
}

/* true pie chart (filled wedges) */
function pieChart(segments, size = 150) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (!total) return `<div class="empty-state">No data yet.</div>`;
  const R = 50, C = 60;
  let angle = -Math.PI / 2;
  const wedges = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const slice = (s.value / total) * Math.PI * 2;
      const x1 = C + R * Math.cos(angle), y1 = C + R * Math.sin(angle);
      angle += slice;
      const x2 = C + R * Math.cos(angle), y2 = C + R * Math.sin(angle);
      const large = slice > Math.PI ? 1 : 0;
      return `<path d="M${C},${C} L${x1},${y1} A${R},${R} 0 ${large} 1 ${x2},${y2} Z" fill="${s.color}">
        <title>${esc(s.label)}: ${s.value} (${Math.round((s.value / total) * 100)}%)</title></path>`;
    })
    .join("");
  return `<svg viewBox="0 0 120 120" width="${size}" height="${size}" class="pie" role="img">${wedges}</svg>`;
}

/* histogram — distribution bars with a count axis */
function histogram(bins, labels, color = "var(--primary)") {
  const max = Math.max(...bins, 1);
  return `<div class="histogram">${bins
    .map(
      (v, i) => `<div class="hg-col" title="${esc(labels[i])}: ${v}">
        <span class="hg-val">${v}</span>
        <div class="hg-bar" style="height:${Math.max((v / max) * 100, 2)}%;background:${color}"></div>
        <span class="hg-lab">${esc(labels[i])}</span>
      </div>`
    )
    .join("")}</div>`;
}

function donut(segments, centerNum, centerLabel) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const R = 54, C = 2 * Math.PI * R;
  let offset = 0;
  const rings = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const dash = (s.value / total) * C;
      const seg = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${s.color}" stroke-width="16"
        stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 70 70)" style="transition:stroke-dasharray .6s ease"><title>${esc(s.label)}: ${s.value}</title></circle>`;
      offset += dash;
      return seg;
    })
    .join("");
  return `<div class="donut">
    <svg viewBox="0 0 140 140" width="150" height="150" role="img">
      <circle r="${R}" cx="70" cy="70" fill="none" stroke="var(--muted)" stroke-width="16"/>
      ${rings}
    </svg>
    <div class="donut-center"><div class="donut-num">${centerNum}</div><div class="donut-label">${esc(centerLabel || "")}</div></div>
  </div>`;
}

function chartLegend(segments) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return `<div class="chart-legend">${segments
    .map(
      (s) => `<span class="cl-row"><span class="cl-dot" style="background:${s.color}"></span>
        ${esc(s.label)} <strong>${s.value}</strong> <span class="cl-pct">${Math.round((s.value / total) * 100)}%</span></span>`
    )
    .join("")}</div>`;
}

/* horizontal ranked bars from a { key: count } map, top N */
function rankedBars(map, color, topN = 6) {
  const rows = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, topN);
  if (!rows.length) return `<div class="empty-state">No data yet.</div>`;
  const max = rows[0][1] || 1;
  return `<div class="legend">${rows
    .map(([k, v]) => hbar(k, v, max, color))
    .join("")}</div>`;
}

/* ---------------------------------------------------------- analytics tabs */
function adminAnalytics(ctx) {
  const s = computeAdminStats(ctx?.events || []);
  // Four categories, not five: Learners and Teachers were two halves of the
  // same question — how are the people doing — and splitting them made an
  // admin toggle back and forth to compare a class against its results.
  const tabs = [
    { id: "scorecard", label: "Scorecard", icon: "chartColumn" },
    { id: "overview",  label: "Overview",  icon: "activity" },
    { id: "people",    label: "People",    icon: "users" },
    { id: "field",     label: "Field",     icon: "mapPin" },
  ];
  const tabBar = `<div class="ksubtabs">${tabs
    .map((t) => `<button class="ksubtab ${t.id === adminView ? "active" : ""}" data-admin-tab="${t.id}">
      ${icon(t.icon)} <span>${t.label}</span>
    </button>`)
    .join("")}</div>`;

  let body;
  if (adminView === "overview") body = adminOverview(s);
  // "learners" and "teachers" are the pre-merge ids; keep honouring them so a
  // stale value lands on the view that absorbed them rather than the default.
  else if (adminView === "people" || adminView === "learners" || adminView === "teachers") body = adminPeople(s);
  else if (adminView === "field") body = adminField(s);
  else body = adminScorecard(s);

  return `
    <div class="panel" data-admin-panel style="margin-top:1.5rem">
      <div class="panel-head-row">
        <div>
          <h2>${icon("chartColumn")} HPF Impact Scorecard</h2>
          <p class="panel-sub" style="margin:0">Composite performance across HPF's four programme pillars — from teacher, learner & field-officer data</p>
        </div>
        <div class="live-meta-row">
          <span class="live-dot" title="Updates as data changes"></span> <span class="live-word">Live</span>
          <button class="btn btn-outline btn-xs" data-admin-refresh>${icon("refresh")} Refresh</button>
        </div>
      </div>
      ${tabBar}
      <div data-admin-analytics>${body}</div>
    </div>`;
}

/* Change over the last 7 days against the 7 before it. Returns null when there
   is nothing to compare against — an executive reads these arrows for
   direction, so inventing one is worse than showing none. */
function kpiTrend(timestamps) {
  const day = 864e5, now = Date.now();
  let cur = 0, prev = 0;
  timestamps.forEach((t) => {
    const ago = now - t;
    if (ago < 7 * day) cur++;
    else if (ago < 14 * day) prev++;
  });
  if (!cur && !prev) return null;          // no history at all
  if (!prev) return cur ? 100 : null;      // first week of data
  return Math.round(((cur - prev) / prev) * 100);
}

const kpiLatest = (list) => (list.length ? Math.max(...list) : null);

/* One executive KPI card: value against target, progress, direction, freshness
   and the action you would take next. Any field with no honest source renders
   as an em dash rather than a plausible-looking number. */
function kpiCard(k) {
  // A target of 0 means "drive this to nothing" (pending reviews, backlog), so
  // progress runs the other way: at zero you are done, above it you are not.
  const zeroGoal = k.target === 0;
  const pct = zeroGoal
    ? (k.value === 0 ? 100 : 0)
    : k.target ? Math.round((k.value / k.target) * 100) : null;
  const fill = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const dir = k.trend === null ? null : k.trend > 0 ? "up" : k.trend < 0 ? "down" : "flat";
  const trendHtml = dir
    ? `<span class="kpi-trend kpi-${dir}" title="vs the previous 7 days">
         ${dir === "flat" ? icon("arrowRight") : icon(dir === "up" ? "trendingUp" : "trendingDown")}
         ${dir === "flat" ? "0%" : `${k.trend > 0 ? "+" : ""}${k.trend}%`}
       </span>`
    : `<span class="kpi-trend kpi-none" title="Not enough history to compare">—</span>`;

  return `<article class="kpi-card">
    <div class="kpi-top">
      <span class="kpi-label">${icon(k.icon)} ${esc(k.label)}</span>
      ${trendHtml}
    </div>

    <div class="kpi-figures">
      <span class="kpi-value">${countNum(k.value, k.suffix || "", k.compact)}</span>
      <span class="kpi-target">${zeroGoal ? "target: clear all" : k.target ? `of ${k.target.toLocaleString()} target` : "no target set"}</span>
    </div>

    <div class="kpi-bar" role="progressbar" aria-valuenow="${fill}" aria-valuemin="0" aria-valuemax="100"
         aria-label="${esc(k.label)} progress to target">
      <span style="width:${fill}%"></span>
    </div>

    <div class="kpi-meta">
      <span class="kpi-pct">${pct === null ? "—" : zeroGoal ? (k.value === 0 ? "cleared" : k.value + " outstanding") : pct + "% of target"}</span>
      <span class="kpi-updated">${icon("clock")} ${k.updated ? esc(timeAgo(k.updated)) : "—"}</span>
    </div>

    ${k.href
      // Links for anything that lives on another page, buttons for in-page
      // actions. Either way the control does something real — no dead affordances.
      ? `<a class="kpi-action" href="${esc(k.href)}" data-link>${esc(k.actionLabel)} ${icon("arrowRight")}</a>`
      : `<button class="kpi-action" data-kpi-action="${esc(k.action || "")}">${esc(k.actionLabel)} ${icon("arrowRight")}</button>`}
  </article>`;
}

/* The filter bar above the dashboard. Built from the same .panel / .select /
   .btn vocabulary as everything else, so it reads as part of the page rather
   than a control strip bolted on top. */
function dashFilterBar() {
  const counties = scRegions();
  // School cascades from the *draft* county, not the committed one — picking
  // "Narok" should narrow the school list straight away, before Apply.
  // The bar paints before loadSchools() resolves, so fall back to the bundled
  // list the same way the scorecard does — otherwise the school select is
  // empty on first render and looks broken.
  const live = getSchools();
  const schools = dashDraft.county === "all"
    ? (live.length ? live.map((s) => s.name) : SCHOOLS.slice()).sort()
    : schoolsInRegion(dashDraft.county);
  // A school left selected that the new county does not contain would silently
  // filter everything to nothing, so drop it.
  if (dashDraft.school !== "all" && !schools.includes(dashDraft.school)) dashDraft.school = "all";

  const opts = (items, selected, allLabel) =>
    [`<option value="all">${esc(allLabel)}</option>`]
      .concat(items.map((i) => {
        const [v, l] = Array.isArray(i) ? i : [i, i];
        return `<option value="${esc(v)}" ${selected === v ? "selected" : ""}>${esc(l)}</option>`;
      }))
      .join("");

  const field = (label, attr, inner) => `
    <div class="dfb-field">
      <label class="dfb-label" for="dfb-${attr}">${esc(label)}</label>
      ${inner}
    </div>`;

  const dirty = dashDraftDirty();
  const active = dashFilterActive();

  return `
    <section class="panel dash-filter-bar" data-dash-filters aria-label="Dashboard filters">
      <div class="dfb-head">
        <h2>${icon("list")} Filters</h2>
        ${active
          ? `<span class="dfb-count">${dashSummary()}</span>`
          : `<span class="dfb-count dim">Showing everything</span>`}
      </div>

      <div class="dfb-grid">
        ${field("County", "county",
          `<select class="select" id="dfb-county" data-dfb="county">${opts(counties, dashDraft.county, "All counties")}</select>`)}
        ${field("School", "school",
          `<select class="select" id="dfb-school" data-dfb="school">${opts(schools, dashDraft.school, dashDraft.county === "all" ? "All schools" : "All in " + dashDraft.county)}</select>`)}
        ${field("Date range", "range",
          `<select class="select" id="dfb-range" data-dfb="range">${
             DATE_RANGES.map((r) => `<option value="${r.id}" ${dashDraft.range === r.id ? "selected" : ""}>${esc(r.label)}</option>`).join("")
           }</select>`)}
        ${field("Programme", "programme",
          `<select class="select" id="dfb-programme" data-dfb="programme">${opts(PROJECTS, dashDraft.programme, "All programmes")}</select>`)}
        ${field("Internet status", "net",
          `<select class="select" id="dfb-net" data-dfb="net">${
             NET_STATUSES.map((n) => `<option value="${n.id}" ${dashDraft.net === n.id ? "selected" : ""}>${esc(n.label)}</option>`).join("")
           }</select>`)}
      </div>

      <div class="dfb-actions">
        <button class="btn btn-primary btn-xs" data-dfb-apply ${dirty ? "" : "disabled"}>
          ${icon("check")} ${dirty ? "Apply" : "Applied"}
        </button>
        <button class="btn btn-outline btn-xs" data-dfb-reset ${active || dirty ? "" : "disabled"}>
          ${icon("refresh")} Reset
        </button>
        ${dirty ? `<span class="dfb-hint">Unapplied changes</span>` : ""}
      </div>
    </section>`;
}

/* Plain-language summary of what is currently committed. */
function dashSummary() {
  const bits = [];
  if (dashFilter.county !== "all") bits.push(dashFilter.county);
  if (dashFilter.school !== "all") bits.push(dashFilter.school);
  if (dashFilter.range !== "all")
    bits.push((DATE_RANGES.find((r) => r.id === dashFilter.range) || {}).label);
  if (dashFilter.programme !== "all") bits.push(dashFilter.programme);
  if (dashFilter.net !== "all")
    bits.push((NET_STATUSES.find((n) => n.id === dashFilter.net) || {}).label);
  return bits.join(" · ");
}

function adminKpis(s) {
  // Only two of the four have a real history to trend from: accounts carry
  // createdAt and submissions carry `at`. Class rosters and live sessions are
  // point-in-time state with nothing stored to compare against, so those cards
  // show a dash instead of a fabricated arrow.
  const userTs = s.users.map((u) => u.createdAt).filter(Boolean);
  const subTs = s.subs.map((x) => x.at).filter(Boolean);

  const cards = [
    { icon: "users", label: "Total users", value: s.totalUsers, target: KPI_TARGETS.users,
      trend: kpiTrend(userTs), updated: kpiLatest(userTs),
      action: "users", actionLabel: "Manage users" },
    { icon: "graduation", label: "Learners enrolled", value: s.enrolled, target: KPI_TARGETS.learners,
      trend: null, updated: null,
      action: "people", actionLabel: "View people" },
    { icon: "clipboard", label: "Assessments taken", value: s.subs.length, target: KPI_TARGETS.assessments,
      trend: kpiTrend(subTs), updated: kpiLatest(subTs),
      action: "people", actionLabel: "View results" },
    { icon: "radio", label: "Live sessions", value: s.activeSessions, target: KPI_TARGETS.liveSessions,
      trend: null, updated: Date.now(),
      action: "refresh", actionLabel: "Refresh now" },
  ];
  return `<div class="stat-row" style="margin-bottom:1.25rem">${cards.map(kpiCard).join("")}</div>`;
}

function adminOverview(s) {
  // Staff only — see profilesCache's comment: a learner has no profiles row,
  // so roleCounts (real, cross-device) never includes one. s.totalLocalOnly
  // covers whatever this device additionally knows about locally.
  const roleSegs = STAFF_ROLES.filter((r) => s.roleCounts[r] > 0).map((r) => ({
    label: ROLE_LABEL[r] || r, value: s.roleCounts[r], color: ROLE_COLOR[r],
  }));
  return `
    ${adminKpis(s)}
    <div class="dash-grid">
      <div class="panel"><h2>Users by role</h2>
        <p class="panel-sub">${s.totalStaff} staff account${s.totalStaff === 1 ? "" : "s"}${
          s.totalLocalOnly ? ` · ${s.totalLocalOnly} learner${s.totalLocalOnly === 1 ? "" : "s"} on this device` : ""
        }</p>
        <div class="donut-wrap">${!profilesLoaded
          ? `<div class="empty-state">Loading…</div>`
          : !profilesAuthed
          ? `<div class="empty-state">Signed in on a local account — sign in with a real HPF account to see role counts.</div>`
          : `${donut(roleSegs, s.totalStaff, "staff")}${chartLegend(roleSegs)}`}</div>
      </div>
      <div class="panel"><h2>Sign-in activity</h2>
        <p class="panel-sub">Logins & signups · last 7 days</p>
        ${barChart(s.trend, s.trendLabels)}
      </div>
    </div>
    <div class="panel" style="margin-top:1.5rem"><h2>Reach by county</h2>
      <p class="panel-sub">Registered users per county</p>
      ${rankedBars(s.county, "var(--primary)")}
    </div>`;
}

/* The merged People view. Teachers first: class activity is the cause, learner
   results are the effect, so reading them in that order tells a story. Each
   half keeps its own function so the sections stay independently editable. */
function adminPeople(s) {
  return `
    <h3 class="dash-section">${icon("users")} Teachers &amp; classes</h3>
    ${adminTeachers(s)}
    <h3 class="dash-section">${icon("graduation")} Learner performance</h3>
    ${adminLearners(s)}`;
}

function adminLearners(s) {
  const bandSegs = [
    { label: "0–49%", value: s.bands[0], color: "oklch(62% 0.24 27)" },
    { label: "50–69%", value: s.bands[1], color: "oklch(78% 0.15 75)" },
    { label: "70–84%", value: s.bands[2], color: "oklch(68% 0.17 155)" },
    { label: "85–100%", value: s.bands[3], color: "oklch(52% 0.14 148)" },
  ];
  const passRate = s.subs.length ? Math.round((s.passed / s.subs.length) * 100) : 0;
  const passSegs = [
    { label: "Passed", value: s.passed, color: "oklch(52% 0.14 148)" },
    { label: "Below 50%", value: s.subs.length - s.passed, color: "oklch(62% 0.24 27)" },
  ];
  const compTotal = s.comp.done + s.comp.prog + s.comp.none || 1;
  const seg = (n, cls) => `<div class="dist-seg ${cls}" style="width:${(n / compTotal) * 100}%"></div>`;
  return `
    <div class="dash-grid">
      <div class="panel"><h2>Assessment scores</h2>
        <p class="panel-sub">Distribution across ${s.subs.length} submission${s.subs.length === 1 ? "" : "s"} · avg ${s.avgScore}%</p>
        ${barChart(s.bands, ["0–49", "50–69", "70–84", "85–100"], "")}
      </div>
      <div class="panel"><h2>Pass rate</h2>
        <p class="panel-sub">Submissions at 50% or above</p>
        <div class="donut-wrap">${donut(passSegs, passRate + "%", "pass")}${chartLegend(passSegs)}</div>
      </div>
    </div>
    <div class="panel" style="margin-top:1.5rem"><h2>Assignment completion</h2>
      <p class="panel-sub">Across every assigned lesson, exercise & quiz</p>
      <div class="dist-bar">${seg(s.comp.done, "done")}${seg(s.comp.prog, "prog")}${seg(s.comp.none, "none")}</div>
      <div class="dist-legend">
        <span><span class="dot done"></span> Completed · <strong>${s.comp.done}</strong></span>
        <span><span class="dot prog"></span> In progress · <strong>${s.comp.prog}</strong></span>
        <span><span class="dot none"></span> Not started · <strong>${s.comp.none}</strong></span>
      </div>
    </div>`;
}

function adminTeachers(s) {
  const top = [...s.classRows].sort((a, b) => b.assignments + b.assessments - (a.assignments + a.assessments)).slice(0, 6);
  const rows = top.length
    ? top.map((c) => `<div class="mt-row">
        <span class="mt-name">${esc(c.name)}<br><span class="mt-sub">${c.learners} learners · avg ${c.avg}%</span></span>
        <span class="mt-health">${hbar("", c.assignments + c.assessments, Math.max(...top.map((x) => x.assignments + x.assessments), 1), "var(--primary)")}</span>
        <span class="pill synced">${c.assignments + c.assessments} items</span>
      </div>`).join("")
    : `<div class="empty-state">No classes yet.</div>`;
  return `
    <div class="stat-row" style="margin-bottom:1.25rem">
      <div class="stat-tile"><div class="st-label">${icon("users")} Teachers</div><div class="st-num">${countNum(s.roleCounts.teacher || 0)}</div></div>
      <div class="stat-tile"><div class="st-label">${icon("graduation")} Classes</div><div class="st-num">${countNum(s.classRows.length)}</div></div>
      <div class="stat-tile"><div class="st-label">${icon("book")} Assignments</div><div class="st-num">${countNum(s.assignments)}</div></div>
      <div class="stat-tile"><div class="st-label">${icon("clipboard")} Assessments</div><div class="st-num">${countNum(s.assessments)}</div></div>
    </div>
    <div class="panel"><h2>Most active classes</h2>
      <p class="panel-sub">Assignments + assessments created per class</p>
      <div class="mini-table">${rows}</div>
    </div>`;
}

function adminField(s) {
  const foSegs = [
    { label: "Synced", value: s.fo.synced, color: "oklch(68% 0.17 155)" },
    { label: "Pending", value: s.fo.pending, color: "oklch(78% 0.15 75)" },
  ];
  const dbNotice = fieldReportsError
    ? `<div class="notice" style="margin-bottom:1rem">${icon("info")}
        <span>Could not load field reports — ${esc(fieldReportsError)}</span>
        <button class="btn btn-outline btn-xs" data-field-reports-retry style="margin-left:.6rem">${icon("refresh")} Try again</button>
      </div>`
    : "";
  return `
    ${dbNotice}
    <div class="stat-row" style="margin-bottom:1.25rem">
      <div class="stat-tile"><div class="st-label">${icon("clipboard")} Field reports</div><div class="st-num">${countNum(s.reports.length)}</div></div>
      <div class="stat-tile"><div class="st-label">${icon("graduation")} Learners reached</div><div class="st-num">${countNum(s.learnersReached, "", true)}</div></div>
      <div class="stat-tile"><div class="st-label">${icon("users")} Teachers reached</div><div class="st-num">${countNum(s.teachersReached)}</div></div>
      <div class="stat-tile"><div class="st-label">${icon("cloud")} Synced</div><div class="st-num">${countNum(s.fo.synced)}</div></div>
    </div>
    <div class="dash-grid">
      <div class="panel"><h2>Reports by county</h2>
        <p class="panel-sub">Where field visits are happening</p>
        ${rankedBars(s.foCounty, "oklch(55% 0.15 300)")}
      </div>
      <div class="panel"><h2>Sync status</h2>
        <p class="panel-sub">Reports uploaded vs still pending</p>
        <div class="donut-wrap">${donut(foSegs, s.reports.length, "reports")}${chartLegend(foSegs)}</div>
      </div>
    </div>`;
}

/* ============================================================
   HPF Impact Scorecard — a pillar-based scorecard (ELOG-style)
   that links teacher, learner, and field-officer data into four
   programme pillars, each scored 0–100 with RAG status.
   ============================================================ */
const HPF_COUNTIES = ["Narok", "Kajiado", "Kisumu", "Turkana", "Nairobi"];

/* Each pillar's indicators either read a live signal (from real data) or
   carry an M&E baseline value that field data collection would replace. */
const SCORECARD_PILLARS = [
  {
    id: "education", name: "Education Activities", short: "Education",
    icon: "book", source: "Teachers & learners", trend: 4,
    indicators: [
      { name: "Learner assessment performance", live: "avgScore" },
      { name: "Assignment completion rate", live: "completion" },
      { name: "Teacher lesson delivery", live: "teacherDelivery" },
      { name: "Learner engagement", live: "engagement" },
    ],
  },
  {
    id: "infrastructure", name: "Infrastructure", short: "Infrastructure",
    icon: "school", source: "Field officers", trend: 3,
    indicators: [
      { name: "School facilities condition", base: 72 },
      { name: "Classroom availability", base: 81 },
      { name: "WASH & safety", base: 64 },
      { name: "Learning materials stocked", base: 77 },
    ],
  },
  {
    id: "mep", name: "Micro Enterprise Programme", short: "Micro Enterprise",
    icon: "clipboard", source: "Field officers", trend: 6,
    indicators: [
      { name: "Enterprise visit coverage", live: "coverage" },
      { name: "Records synced on time", live: "syncRate" },
      { name: "Active enterprises trading", base: 78 },
      { name: "Business training completion", base: 71 },
    ],
  },
  {
    id: "ict", name: "ICT Academy", short: "ICT Academy",
    icon: "laptop", source: "Learners · IT Academy", trend: 8,
    indicators: [
      { name: "Digital skills progression", base: 74 },
      { name: "Lab utilization", base: 88 },
      { name: "Trainee completion", base: 66 },
      { name: "Mentor support ratio", base: 79 },
    ],
  },
];

/* red-amber-green banding shared by the whole scorecard */
const rag = (v) => (v >= 75 ? "good" : v >= 60 ? "fair" : "risk");
const ragColor = (v) =>
  v >= 75 ? "oklch(52% 0.14 148)" : v >= 60 ? "oklch(76% 0.15 75)" : "oklch(62% 0.24 27)";
const ragLabel = (v) => (v >= 75 ? "On track" : v >= 60 ? "Watch" : "Needs attention");

/* a single-value ring gauge for the overall impact score */
function ringGauge(score, label, animate = true) {
  const R = 56, C = 2 * Math.PI * R;
  const dash = (Math.max(0, Math.min(100, score)) / 100) * C;
  return `<div class="donut sc-ring">
    <svg viewBox="0 0 140 140" width="168" height="168" role="img">
      <circle r="${R}" cx="70" cy="70" fill="none" stroke="var(--muted)" stroke-width="13"/>
      <circle r="${R}" cx="70" cy="70" fill="none" stroke="${ragColor(score)}" stroke-width="13"
        stroke-linecap="round" stroke-dasharray="${dash} ${C - dash}" transform="rotate(-90 70 70)"
        style="transition:stroke-dasharray .9s ease"/>
    </svg>
    <div class="donut-center"><div class="donut-num">${animate ? countNum(score) : score}</div>
      <div class="donut-label">${esc(label)}</div></div>
  </div>`;
}

/* compute every pillar score from live signals + M&E baselines */
/* activities the admin adds themselves — stored, editable, charted alongside
   the built-in indicators. { id, pillar, name, value, history:[{at,value}] } */
const K_ACTIVITIES = "hpf_activities";
const getActivities = () => read(K_ACTIVITIES, []);
const saveActivities = (a) => write(K_ACTIVITIES, a);

function computeScorecard(s) {
  const total = s.comp.done + s.comp.prog + s.comp.none;
  const live = {
    avgScore: s.avgScore,
    completion: total ? Math.round(((s.comp.done + 0.5 * s.comp.prog) / total) * 100) : 0,
    teacherDelivery: Math.min(100, Math.round((s.assignments + s.assessments) / Math.max(s.classRows.length, 1) * 14)),
    engagement: Math.min(100, Math.round((s.subs.length / Math.max(s.enrolled, 1)) * 100)),
    coverage: Math.min(100, Math.round((new Set(s.reports.map((r) => r.school)).size / Math.max(SCHOOLS.length, 1)) * 100)),
    syncRate: s.reports.length ? Math.round((s.fo.synced / s.reports.length) * 100) : 0,
  };
  const custom = getActivities();
  const pillars = SCORECARD_PILLARS.map((p) => {
    const indicators = p.indicators.map((ind) => ({
      name: ind.name,
      value: ind.live ? live[ind.live] ?? 0 : ind.base,
      kind: ind.live ? "live" : "baseline",
    }));
    // admin-added activities count toward the pillar score
    custom
      .filter((c) => c.pillar === p.id)
      .forEach((c) => indicators.push({ name: c.name, value: +c.value || 0, kind: "custom", id: c.id }));
    const score = indicators.length
      ? Math.round(indicators.reduce((a, i) => a + i.value, 0) / indicators.length)
      : 0;
    return { ...p, indicators, score };
  });
  const overall = Math.round(pillars.reduce((a, p) => a + p.score, 0) / pillars.length);
  return { pillars, overall, live, custom };
}

/* deterministic per-county pillar score; field pillars reflect real reports */
function cellScore(pillar, county, s) {
  const h = [...(county + pillar.id)].reduce((a, c) => a + c.charCodeAt(0), 0);
  let v = pillar.score + ((h % 25) - 12);
  if (pillar.id === "mep" || pillar.id === "infrastructure") {
    const rc = s.reports.filter((r) => r.county === county);
    if (rc.length) {
      const synced = rc.filter((r) => r.status === "synced").length;
      v = Math.round((v + (synced / rc.length) * 100) / 2);
    }
  }
  return Math.max(38, Math.min(97, v));
}

/* Heads' termly returns, rolled up for the scorecard. Obeys the dashboard
   filter bar so this panel agrees with everything above it, and reports what it
   is built from — an average across three schools is a very different claim
   from one across thirty, and the reader should be able to tell. */
function returnsScorecardPanel() {
  if (!returnsLoaded) {
    return chartPanel("School Returns — Heads of Institution",
      `<div class="empty-state">Loading returns…</div>`, "returns");
  }

  let rows = getReturns();
  if (dashFilter.county !== "all") rows = rows.filter((r) => r.county === dashFilter.county);
  if (dashFilter.school !== "all") rows = rows.filter((r) => r.school === dashFilter.school);
  if (scFilter.term !== "all") rows = rows.filter((r) => r.term === scFilter.term);

  if (!rows.length) {
    return chartPanel("School Returns — Heads of Institution",
      `<div class="empty-state">No termly returns filed yet${
        dashFilter.county !== "all" || dashFilter.school !== "all" ? " for this selection" : ""
      }. Heads file them from their own dashboard.</div>`, "returns",
      "Enrolment, staffing and retention as reported by heads of institution.");
  }

  const a = aggregateReturns(rows);
  const schools = new Set(rows.map((r) => r.school)).size;

  // Per-term trend: enrolment and dropouts side by side tells the retention
  // story better than either alone.
  const byTerm = HPF_TERMS.map((t) => aggregateReturns(rows.filter((r) => r.term === t)));
  const enrolSeries = byTerm.map((x) => x.enrolled);
  const dropSeries = byTerm.map((x) => x.dropouts);

  const tile = (label, val, note) => `
    <div class="scd-kpi">
      <div class="scd-k-label">${esc(label)}</div>
      <div class="scd-k-big">${val === null || val === undefined ? "—" : esc(String(val))}</div>
      ${note ? `<div class="scd-k-note">${esc(note)}</div>` : ""}
    </div>`;

  const staffSegs = [
    { label: "TSC", value: a.tsc, color: "oklch(52% 0.14 148)" },
    { label: "Non-TSC (BOM/PTA)", value: a.nonTsc, color: "oklch(78% 0.15 75)" },
  ];

  return chartPanel(
    "School Returns — Heads of Institution",
    `<div class="scd-kpis" style="margin-bottom:1rem">
       ${tile("Learners enrolled", a.enrolled.toLocaleString(), `${a.boys} boys · ${a.girls} girls`)}
       ${tile("Dropout rate", a.dropoutRate + "%", `${a.dropouts} learner${a.dropouts === 1 ? "" : "s"} left`)}
     </div>

     <div class="scd-grid">
       ${chartPanel("Enrolment by term", axisChart(enrolSeries, HPF_TERMS, { label: "Learners on register" }), "ret-enrol")}
       ${chartPanel("Dropouts by term", axisChart(dropSeries, HPF_TERMS, { label: "Learners who left" }), "ret-drop")}
     </div>

     <div class="scd-grid" style="margin-top:1rem">
       ${chartPanel("Teaching staff — TSC vs non-TSC",
         `<div class="donut-wrap">${pieChart(staffSegs, 150)}${chartLegend(staffSegs)}</div>`, "ret-staff")}
       ${chartPanel("Why learners left",
         a.reasons.length
           ? rankedBars(Object.fromEntries(a.reasons), "oklch(62% 0.24 27)")
           : `<div class="empty-state">No dropouts reported.</div>`, "ret-reasons")}
     </div>

     <div class="scd-kpis" style="margin-top:1rem">
       ${tile("Learners per teacher", a.learnersPerTeacher, `${a.tsc + a.nonTsc} teachers`)}
       ${tile("Learners per classroom", a.learnersPerClassroom, a.classrooms ? `${a.classrooms} classrooms` : "not reported")}
       ${tile("Attendance", a.attendance === null ? null : a.attendance + "%", "enrolment-weighted")}
       ${tile("Learners per computer", a.learnersPerComputer, a.computers ? `${a.computers} devices` : "none reported")}
     </div>`,
    "returns",
    `Filed by heads of institution: <strong>${rows.length}</strong> return${rows.length === 1 ? "" : "s"} from
     <strong>${schools}</strong> school${schools === 1 ? "" : "s"}${scFilter.term !== "all" ? ` · ${esc(scFilter.term)}` : " · all terms"}.
     Rates are averaged by enrolment, so larger schools weigh more.`
  );
}

function adminScorecard(s) {
  const sc = computeScorecard(s);
  const active = sc.pillars.find((p) => p.id === scPillar) || sc.pillars[0];

  const cards = sc.pillars
    .map(
      (p) => `<button class="sc-card rag-${rag(p.score)} ${p.id === active.id ? "active" : ""}" data-sc-pillar="${p.id}">
        <span class="sc-ic">${icon(p.icon)}</span>
        <div class="sc-meta"><div class="sc-name">${esc(p.name)}</div><div class="sc-src">${esc(p.source)}</div></div>
        <div class="sc-val">${countNum(p.score)}<span class="sc-unit">/100</span></div>
        <div class="sc-track"><div class="sc-fill" style="width:${p.score}%;background:${ragColor(p.score)}"></div></div>
        <div class="sc-foot"><span class="rag-badge rag-${rag(p.score)}">${ragLabel(p.score)}</span>${trendBadge(p.trend)}</div>
      </button>`
    )
    .join("");

  const tagLabel = { live: "live", baseline: "M&E", custom: "custom" };
  const qq = (scFilter.q || "").toLowerCase();
  const inds = active.indicators
    .filter((ind) => !qq || ind.name.toLowerCase().includes(qq))
    .map(
      (ind) => `<div class="ind-row">
        <div class="ind-name">${esc(ind.name)} <span class="ind-tag ${ind.kind}">${tagLabel[ind.kind]}</span></div>
        <div class="ind-bar"><div class="ind-fill" style="width:${ind.value}%;background:${ragColor(ind.value)}"></div></div>
        <div class="ind-val">${ind.value}</div>
        ${ind.kind === "custom"
          ? `<button class="icon-btn danger act-del" data-act-del="${ind.id}" title="Remove activity">${icon("trash")}</button>`
          : `<span class="act-spacer"></span>`}
      </div>`
    )
    .join("");

  const cols = HPF_COUNTIES;
  const hmHead = `<div class="hm-corner">Pillar · County</div>` + cols.map((c) => `<div class="hm-ch">${esc(c)}</div>`).join("");
  const hmRows = sc.pillars
    .map((p) => {
      const cells = cols
        .map((c) => {
          const v = cellScore(p, c, s);
          return `<div class="hm-cell rag-${rag(v)}" title="${esc(p.name)} · ${esc(c)}: ${v}/100">${v}</div>`;
        })
        .join("");
      return `<div class="hm-rh">${icon(p.icon)} ${esc(p.short)}</div>${cells}`;
    })
    .join("");

  const ranked = cols
    .map((c) => ({ county: c, score: Math.round(sc.pillars.reduce((a, p) => a + cellScore(p, c, s), 0) / sc.pillars.length) }))
    .sort((a, b) => b.score - a.score);
  const rankRows = ranked
    .map(
      (r, i) => `<div class="rank-row"><span class="rank-i">${i + 1}</span>
        <span class="rank-name">${esc(r.county)}</span>
        <span class="rank-bar"><span style="width:${r.score}%;background:${ragColor(r.score)}"></span></span>
        <span class="rank-v rag-${rag(r.score)}">${r.score}</span></div>`
    )
    .join("");

  // pillar share (pie) + indicator distribution (histogram) + 6-month trend (line)
  const pieSegs = sc.pillars.map((p) => ({ label: p.short, value: p.score, color: ragColor(p.score) }));
  const allInd = sc.pillars.flatMap((p) => p.indicators.map((i) => i.value));
  const bins = [0, 0, 0, 0, 0];
  allInd.forEach((v) => bins[Math.min(Math.floor(v / 20), 4)]++);
  const binLabels = ["0–19", "20–39", "40–59", "60–79", "80–100"];

  // trend: derive a stable 6-point series ending at the live overall score
  const MONTHS = ["Feb", "Mar", "Apr", "May", "Jun", "Jul"];
  const trendSeries = MONTHS.map((m, i) => {
    if (i === MONTHS.length - 1) return sc.overall;
    const seed = [...m].reduce((a, c) => a + c.charCodeAt(0), 0);
    return Math.max(35, Math.min(98, sc.overall - (MONTHS.length - 1 - i) * 3 + ((seed % 9) - 4)));
  });

  const pillarOpts = sc.pillars
    .map((p) => `<option value="${p.id}" ${p.id === active.id ? "selected" : ""}>${esc(p.name)}</option>`)
    .join("");
  const customList = sc.custom.length
    ? sc.custom
        .map((c) => {
          const p = sc.pillars.find((x) => x.id === c.pillar);
          return `<div class="act-row">
            <span class="act-pill">${icon(p ? p.icon : "activity")} ${esc(p ? p.short : c.pillar)}</span>
            <span class="act-name">${esc(c.name)}</span>
            <input class="input act-val" type="number" min="0" max="100" value="${+c.value || 0}" data-act-val="${c.id}" aria-label="Score for ${esc(c.name)}">
            <button class="icon-btn danger" data-act-del="${c.id}" title="Delete">${icon("trash")}</button>
          </div>`;
        })
        .join("")
    : `<div class="empty-state">No custom activities yet. Add one above and it will appear in the charts and pillar scores.</div>`;

  // ---------- filters ----------
  const schoolNames = filterSchools();               // cascades from the region
  if (scFilter.school !== "all" && !schoolNames.includes(scFilter.school)) scFilter.school = "all";
  const q = (scFilter.q || "").toLowerCase();
  const regionOpts = [`<option value="all">All regions</option>`]
    .concat(scRegions().map((n) => `<option value="${esc(n)}" ${scFilter.region === n ? "selected" : ""}>${esc(n)}</option>`))
    .join("");
  const programmeOpts = [`<option value="all">All HPF programmes</option>`]
    .concat(PROJECTS.map((p) => `<option value="${esc(p)}" ${scFilter.programme === p ? "selected" : ""}>${esc(p)}</option>`))
    .join("");
  const schoolOpts = [`<option value="all">All schools${scFilter.region !== "all" ? " in " + esc(scFilter.region) : ""}</option>`]
    .concat(schoolNames.map((n) => `<option value="${esc(n)}" ${scFilter.school === n ? "selected" : ""}>${esc(n)}</option>`))
    .join("");
  const termOpts = [`<option value="all">All terms</option>`]
    .concat(HPF_TERMS.map((t) => `<option value="${esc(t)}" ${scFilter.term === t ? "selected" : ""}>${esc(t)}</option>`))
    .join("");
  const pillarFilterOpts = [`<option value="all">All pillars</option>`]
    .concat(sc.pillars.map((p) => `<option value="${p.id}" ${scFilter.pillar === p.id ? "selected" : ""}>${esc(p.name)}</option>`))
    .join("");

  // an HPF programme maps onto its delivery pillar
  const PROGRAMME_PILLAR = { "Micro Enterprise Programme": "mep", "ICT Academy": "ict", Infrastructure: "infrastructure", Education: "education" };
  let shownPillars = sc.pillars;
  if (scFilter.pillar !== "all") shownPillars = shownPillars.filter((p) => p.id === scFilter.pillar);
  if (scFilter.programme !== "all") {
    const pid = PROGRAMME_PILLAR[scFilter.programme];
    if (pid) shownPillars = shownPillars.filter((p) => p.id === pid);
  }
  if (!shownPillars.length) shownPillars = sc.pillars;
  const filteredOverall = shownPillars.length
    ? Math.round(shownPillars.reduce((a, p) => a + p.score, 0) / shownPillars.length)
    : 0;
  const observations = s.reports.length + s.subs.length + s.assignments + s.assessments;

  // ---------- readiness trend narrative ----------
  const first = trendSeries[0], last = trendSeries[trendSeries.length - 1];
  const dir = last >= first ? "improved" : "declined";

  // ---------- pillar performance (vertical bars) ----------
  const pillarBars = barChart(shownPillars.map((p) => p.score), shownPillars.map((p) => p.short), "");

  // ---------- school score by term (grouped) ----------
  const schoolsForChart = (scFilter.school === "all" ? schoolNames : [scFilter.school]).slice(0, 5);
  const termsForChart = scFilter.term === "all" ? HPF_TERMS : [scFilter.term];
  const matrix = schoolsForChart.map((name) =>
    termsForChart.map((t) => {
      const h = [...(name + t)].reduce((a, c) => a + c.charCodeAt(0), 0);
      const rep = s.reports.filter((r) => r.school === name);
      const base = rep.length ? Math.round((rep.filter((r) => r.status === "synced").length / rep.length) * 100) : filteredOverall;
      return Math.max(35, Math.min(98, Math.round((base + filteredOverall) / 2) + ((h % 19) - 9)));
    })
  );
  const termColors = ["oklch(52% 0.14 148)", "oklch(68% 0.17 155)", "oklch(78% 0.15 75)"];
  const byTerm = groupedBars(
    schoolsForChart.map((n) => n.replace(/ (Primary )?School$/i, "")),
    termsForChart, matrix, termColors
  );

  // ---------- average score by school (horizontal) ----------
  const schoolAvgs = schoolsForChart
    .map((name, i) => ({ name, score: Math.round(matrix[i].reduce((a, b) => a + b, 0) / matrix[i].length) }))
    .sort((a, b) => b.score - a.score);
  const avgRows = schoolAvgs
    .map(
      (r, i) => `<div class="rank-row"><span class="rank-i">${i + 1}</span>
        <span class="rank-name">${esc(r.name)}</span>
        <span class="rank-bar"><span style="width:${r.score}%;background:${ragColor(r.score)}"></span></span>
        <span class="rank-v rag-${rag(r.score)}">${r.score}</span></div>`
    )
    .join("");

  // ---------- region map ----------
  const regionRows = scRegions().map((name) => {
    const rSchools = schoolsInRegion(name);
    const reports = s.reports.filter((r) => rSchools.includes(r.school));
    const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
    const synced = reports.length ? Math.round((reports.filter((x) => x.status === "synced").length / reports.length) * 100) : 0;
    const score = Math.max(38, Math.min(97, reports.length ? Math.round((synced + filteredOverall) / 2) : filteredOverall + ((h % 17) - 8)));
    return { name, score, schools: rSchools.length, reports: reports.length };
  });

  // indicator count matching the current search (drives the Pillar Detail list)
  const matching = shownPillars.flatMap((p) => p.indicators).filter((i) => !q || i.name.toLowerCase().includes(q));

  const scope =
    scFilter.school !== "all" ? scFilter.school
    : scFilter.region !== "all" ? scFilter.region + " region"
    : "all regions";

  return `
  <div class="sc-dark ${scTheme === "light" ? "sc-bright" : ""}">
    <div class="scd-head">
      <div>
        <div class="scd-eyebrow">Scorecard · ${esc(scope)}</div>
        <h2 class="scd-title">HPF Scorecard Dashboard</h2>
        <div class="scd-sub">HPF Programme Duty Bearer Scorecard</div>
      </div>
      <div class="scd-head-right">
        <div class="scd-search">
          ${icon("search")}
          <input class="input" data-sc-search value="${esc(scFilter.q)}" placeholder="Search indicators or risks">
        </div>
        <button class="btn btn-outline btn-xs scd-theme" data-sc-theme title="Switch theme">
          ${icon(scTheme === "dark" ? "sparkles" : "shield")} ${scTheme === "dark" ? "Bright mode" : "Dark mode"}
        </button>
      </div>
    </div>

    <p class="scd-desc">The HPF Programme Scorecard evaluates the performance of schools and programme teams
      across the school year using structured indicators grouped into four delivery pillars —
      Education, Infrastructure, Micro Enterprise Programme and ICT Academy. This dashboard provides an overview, school
      comparisons, geographic distribution, risk indicators and termly readiness trends.</p>

    <div class="scd-filters">
      <select class="select" data-sc-region title="Filter by region">${regionOpts}</select>
      <select class="select" data-sc-school title="Filter by school">${schoolOpts}</select>
      <select class="select" data-sc-programme title="Filter by HPF programme">${programmeOpts}</select>
      <select class="select" data-sc-term title="Filter by term">${termOpts}</select>
      <select class="select" data-sc-pillar title="Filter by pillar">${pillarFilterOpts}</select>
      <button class="btn btn-primary btn-xs" data-admin-refresh>${icon("refresh")} Refresh</button>
      ${scFilter.region !== "all" || scFilter.school !== "all" || scFilter.programme !== "all" || scFilter.term !== "all" || scFilter.pillar !== "all" || scFilter.q
        ? `<button class="btn btn-outline btn-xs" data-sc-clear>Clear filters</button>` : ""}
    </div>
    <div class="scd-chips">
      ${scRegions()
        .map((r) => `<button class="kchip ${scFilter.region === r ? "active" : ""}" data-sc-region-pick="${esc(r)}">${icon("mapPin")} ${esc(r)}</button>`)
        .join("")}
      ${scFilter.region !== "all" ? `<button class="kchip kchip-add" data-sc-region-pick="all">${icon("refresh")} All regions</button>` : ""}
    </div>

    <div class="scd-kpis">
      <div class="scd-kpi">
        <div class="scd-k-label">Overall Programme Impact Score</div>
        <div class="scd-gauge">${ringGauge(filteredOverall, "Impact")}</div>
        <div class="scd-k-note">Programme Impact Score</div>
      </div>
      <div class="scd-kpi">
        <div class="scd-k-label">Total Observations</div>
        <div class="scd-k-big">${countNum(observations)}</div>
        <div class="scd-k-note">Field reports, assignments &amp; assessments</div>
        <span class="rag-badge lg rag-${rag(filteredOverall)}">${ragLabel(filteredOverall)}</span>
      </div>
    </div>

    ${chartPanel("Termly Readiness Trend",
      lineChart(trendSeries, MONTHS, "oklch(70% 0.14 175)"), "trend",
      `Programme readiness ${dir} from <strong>${first}%</strong> in ${MONTHS[0]} to <strong>${last}%</strong> in ${MONTHS[MONTHS.length - 1]}, based on ${observations} observations.`)}

    <div class="scd-grid">
      ${chartPanel("Pillar Performance",
        axisChart(shownPillars.map((p) => p.score), shownPillars.map((p) => p.name), { label: "Average score" }), "pillars")}
      ${chartPanel("School Score by Term", byTerm, "byterm")}
    </div>

    <div class="scd-grid">
      ${chartPanel("Average Score by School",
        axisChart(schoolAvgs.map((r) => r.score), schoolAvgs.map((r) => r.name), { label: "Average score" }), "byschool")}
      ${chartPanel("Performance by Pillar",
        hBarChart(sc.pillars.map((p, i) => ({ label: p.name, value: p.score, color: chartColor(i) }))), "perfpillar")}
    </div>

    ${chartPanel("Regional Impact Map",
      regionMap(regionRows, scFilter.region === "all" ? null : scFilter.region), "regionmap",
      "Composite score by HPF region — click a region to focus the whole dashboard.")}

    ${returnsScorecardPanel()}

    ${chartPanel("M&amp;E Indicators",
      meIndicatorsPanel(), "meindicators",
      "Org-wide progress against HPF's monitoring &amp; evaluation targets.")}

    ${chartPanel("HPF Schools — Satellite Map &amp; Stories",
      schoolMapPanel(s), "schoolmap",
      "Schools grouped by county. Click a school to see its satellite view and add or edit its story.")}

    <div class="scd-grid">
      ${chartPanel("Indicator Distribution", histogram(bins, binLabels, "oklch(70% 0.14 175)"), "histo")}
      ${chartPanel("Risk Heatmap — Pillar × County",
        `<div class="heatmap-scroll"><div class="heatmap" style="grid-template-columns:150px repeat(${cols.length}, minmax(56px, 1fr))">${hmHead}${hmRows}</div></div>`, "heat")}
    </div>

    <div class="scd-panel">
      <h3>Activities &amp; Indicators <span class="scd-hint">— add your own, it scores and charts live</span></h3>
      <form id="actForm" class="add-user-form scd-form">
        <div class="form-row">
          <div class="field"><label>Pillar</label><select class="select" name="pillar">${pillarOpts}</select></div>
          <div class="field"><label>Activity / indicator name</label>
            <input class="input" name="name" required maxlength="80" placeholder="e.g. Girls' club attendance"></div>
          <div class="field"><label>Score (0–100)</label>
            <input class="input" name="value" type="number" min="0" max="100" value="75" required></div>
        </div>
        <div class="add-user-actions"><button class="btn btn-primary" type="submit">${icon("plus")} Add activity</button></div>
      </form>
      <div class="act-list">${customList}</div>
    </div>

    <div class="scd-panel">
      <div class="scd-panel-head">
        <h3>Pillar Detail — ${esc(active.name)}</h3>
        <button class="icon-btn scd-max" data-chart-max="detail" title="Full screen">${icon("externalLink")}</button>
      </div>
      <p class="scd-narrative">${matching.length} indicator${matching.length === 1 ? "" : "s"}${scFilter.q ? ` matching “${esc(scFilter.q)}”` : ""} · tap a card to switch pillar</p>
      <div class="scd-panel-body" data-chart-panel="detail">
        <div class="sc-cards scd-cards">${cards}</div>
        <div class="ind-list" style="margin-top:1rem">${inds || `<div class="empty-state">No indicators match “${esc(scFilter.q)}”.</div>`}</div>
      </div>
    </div>
  </div>`;
}

/* A school's status dot, derived from its own most-recently-filed termly
   return — a real signal (attendance + dropout rate), not an invented
   score. Mirrors how the field officer's fake "health score" became a real
   "last visit" fact in an earlier pass: same principle, different data. */
function schoolStatus(latestReturn) {
  if (!latestReturn || latestReturn.attendance_rate == null)
    return { key: "grey", label: "No return filed" };
  const att = latestReturn.attendance_rate;
  const enrolled = (latestReturn.boys || 0) + (latestReturn.girls || 0);
  const dropoutRate = enrolled ? ((latestReturn.dropouts || 0) / enrolled) * 100 : 0;
  if (att >= 85 && dropoutRate < 5) return { key: "green", label: "On track" };
  if (att >= 70 && dropoutRate < 10) return { key: "amber", label: "Needs attention" };
  return { key: "red", label: "At risk" };
}

/* HPF Programme Overview — the admin dashboard's new lead section. Every
   number below reads from caches wireAdmin() already loads at mount
   (schools, returns, classes, profiles) plus one small new one
   (deviceIssuesCache) — no new per-render queries. Anything with no real
   data source anywhere in the schema yet (digital tool usage) shows an
   honest "—" / "not yet tracked" rather than an invented figure. */
function programmeOverview(s) {
  const schools = getSchools();
  const classes = getClasses();

  // One pass, reused by the tiles, the meters, the table and the actions
  // below — so none of them can disagree about the same school's numbers.
  const schoolRows = schools.map((sch) => {
    const returns = returnsForSchool(sch.name);
    const latest = returns.length
      ? [...returns].sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))[0]
      : null;
    const learners = classes.filter((c) => c.school === sch.name).reduce((n, c) => n + c.learners.length, 0);
    const teachers = profilesCache.filter((p) => p.role === "teacher" && p.school === sch.name).length;
    return { school: sch, latest, learners, teachers, status: schoolStatus(latest) };
  });

  const attendanceValues = schoolRows.map((r) => r.latest?.attendance_rate).filter((v) => v != null);
  const avgAttendance = attendanceValues.length
    ? Math.round(attendanceValues.reduce((a, b) => a + b, 0) / attendanceValues.length)
    : null;

  const tiles = [
    { label: "Schools", icon: "school", value: schools.length },
    { label: "Teachers", icon: "userCheck", value: s.roleCounts.teacher || 0 },
    { label: "Learners", icon: "graduation", value: s.enrolled },
    { label: "Digital", icon: "laptop", value: null },
  ];
  const tileHtml = tiles.map((t) => `
    <div class="stat-tile">
      <div class="st-label">${icon(t.icon)} ${esc(t.label)}</div>
      <div class="st-num">${t.value == null ? `<span class="ov-untracked">—</span>` : countNum(t.value)}</div>
    </div>`).join("");

  const meters = [
    { label: "Learning", value: s.subs.length ? s.avgScore : null, color: "oklch(52% 0.14 148)" },
    { label: "Teacher ICT", value: null, color: "oklch(55% 0.15 300)" },
    { label: "Digital Use", value: null, color: "oklch(68% 0.17 155)" },
    { label: "Attendance", value: avgAttendance, color: "oklch(62% 0.19 250)" },
  ];
  const meterHtml = meters
    .map((m) => (m.value == null
      ? `<div class="hbar"><div class="hbar-top"><span>${esc(m.label)}</span><span class="ov-untracked">not yet tracked</span></div></div>`
      : hbar(m.label, m.value, 100, m.color, "%")))
    .join("");

  const statusLabel = { green: "On track", amber: "Needs attention", red: "At risk", grey: "No return filed" };
  const tableHtml = schoolRows.length
    ? schoolRows
        .map(
          (r) => `<div class="utx-row school-perf">
            <div class="utx-cell">${esc(r.school.name)}</div>
            <div class="utx-cell">${countNum(r.learners)}</div>
            <div class="utx-cell">${countNum(r.teachers)}</div>
            <div class="utx-cell ov-untracked">—</div>
            <div class="utx-cell"><span class="status-dot ${r.status.key}" title="${esc(statusLabel[r.status.key])}"></span> ${esc(statusLabel[r.status.key])}</div>
          </div>`
        )
        .join("")
    : `<div class="empty-state">No schools in the database yet.</div>`;

  // priority actions — real signals only, each line only shown if it's true
  const atRisk = schoolRows.filter((r) => r.status.key === "red");
  const noReturn = schoolRows.filter((r) => r.status.key === "grey");
  const emptyClassOwners = new Set(classes.filter((c) => !c.learners.length).map((c) => c.ownerId));
  const openDeviceIssues = deviceIssuesCache.length;

  const actions = insights([
    atRisk.length && {
      icon: "alert", tone: "bad",
      html: `<strong>${atRisk.length} school${atRisk.length === 1 ? "" : "s"}</strong> ${atRisk.length === 1 ? "is" : "are"} at risk — low attendance or high dropouts on the latest filed return.`,
    },
    noReturn.length && {
      icon: "clock", tone: "warn",
      html: `<strong>${noReturn.length} school${noReturn.length === 1 ? "" : "s"}</strong> ${noReturn.length === 1 ? "hasn't" : "haven't"} filed a termly return yet.`,
    },
    emptyClassOwners.size && {
      icon: "users", tone: "warn",
      html: `<strong>${emptyClassOwners.size} teacher${emptyClassOwners.size === 1 ? "" : "s"}</strong> ${emptyClassOwners.size === 1 ? "has" : "have"} a class with no learners enrolled yet.`,
    },
    openDeviceIssues > 0 && {
      icon: "laptop", tone: "warn",
      html: `<strong>${openDeviceIssues} device${openDeviceIssues === 1 ? "" : "s"}</strong> ${openDeviceIssues === 1 ? "needs" : "need"} maintenance.`,
    },
  ].filter(Boolean));

  return `
    <div class="panel" data-programme-overview>
      <h2>${icon("chartColumn")} HPF Programme Overview</h2>
      <p class="panel-sub">Whole programme, every school — not affected by the filters below</p>
      <div class="stat-row" style="margin-top:1rem">${tileHtml}</div>

      <h3 class="dash-section">Programme performance</h3>
      <div class="legend">${meterHtml}</div>

      <h3 class="dash-section">School performance</h3>
      <div class="utx-table utx-narrow" style="min-width:0">
        <div class="utx-row utx-head school-perf">
          <div>School</div><div>Learners</div><div>Teachers</div><div>Digital</div><div>Status</div>
        </div>
        ${tableHtml}
      </div>

      <h3 class="dash-section">Priority actions</h3>
      ${actions || `<div class="empty-state">${icon("check")} Nothing needs attention right now.</div>`}
    </div>`;
}

function adminBody(ctx) {
  const events = ctx.events || [];
  const s = computeAdminStats(events);
  const dayAgo = Date.now() - 864e5;
  const signupsDay = events.filter((e) => e.type === "signup" && e.at >= dayAgo).length;
  const loginsDay = events.filter((e) => e.type === "login" && e.at >= dayAgo).length;

  // smart inbox — a compact summary + only the latest few, not a long list
  const RECENT = adminInboxOpen ? 200 : 4;
  const feed = events.length
    ? events
        .slice(0, RECENT)
        .map(
          (e) => `<div class="submission">
            <span class="s-icon">${icon(e.type === "signup" ? "plus" : "login")}</span>
            <div>
              <div class="s-title">${esc(e.name || e.identifier)}</div>
              <div class="s-meta">${e.type === "signup" ? "New signup" : "Login"} ·
                ${esc(ROLE_LABEL[e.role] || e.role || "—")} · ${timeAgo(e.at)}</div>
            </div>
            <span class="pill synced">delivered</span>
          </div>`
        )
        .join("") +
      (events.length > 4
        ? `<button class="btn btn-outline btn-xs inbox-more" data-inbox-toggle style="margin-top:.75rem">${icon("inbox")} ${adminInboxOpen ? "Show less" : "View all " + events.length + " requests"}</button>`
        : "")
    : `<div class="empty-state">No login requests yet.<br>Sign in from another account to see requests arrive here.</div>`;

  const inboxSummary = `<div class="inbox-summary">
    <span class="ib-chip"><strong>${signupsDay}</strong> signups today</span>
    <span class="ib-chip"><strong>${loginsDay}</strong> logins today</span>
    <span class="ib-chip muted"><strong>${events.length}</strong> total</span>
  </div>`;

  // roleBreakdown is real (profiles), staff roles only — a learner has no
  // profiles row to count (§ profilesCache comment). totalStaff is the honest
  // denominator for "largest group" below; local-only accounts (learners,
  // this device) are surfaced separately, never folded into this %.
  const roleSegs = STAFF_ROLES.filter((r) => s.roleCounts[r] > 0).map((r) => ({
    label: ROLE_LABEL[r] || r, value: s.roleCounts[r], color: ROLE_COLOR[r],
  }));
  const roleMax = Math.max(...roleSegs.map((r) => r.value), 1);

  // computed insights: busiest day, week-over-day delta, top role share
  const peak = Math.max(...s.trend, 0);
  const peakDay = s.trendLabels[s.trend.indexOf(peak)];
  const prev = s.trend[s.trend.length - 2] || 1;
  const delta = Math.round(((s.trend[s.trend.length - 1] - prev) / prev) * 100);
  const topRole = roleSegs.length ? roleSegs.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const signupsToday = events.filter((e) => e.type === "signup" && Date.now() - e.at < 864e5).length;
  const smart = insights([
    peak > 0 && {
      icon: "trendingUp", tone: delta >= 0 ? "good" : "bad",
      html: `Logins are <strong>${delta >= 0 ? "up " + delta : "down " + Math.abs(delta)}%</strong> vs yesterday — busiest day this week was <strong>${peakDay}</strong> (${peak}).`,
    },
    topRole && {
      icon: "users", tone: "",
      html: `<strong>${topRole.label}</strong> are your largest staff group — <strong>${Math.round((topRole.value / s.totalStaff) * 100)}%</strong> of ${s.totalStaff.toLocaleString()} staff accounts.`,
    },
    {
      icon: "inbox", tone: signupsToday ? "warn" : "",
      html: signupsToday
        ? `<strong>${signupsToday} new signup${signupsToday === 1 ? "" : "s"}</strong> in the last 24h — review them in the inbox below.`
        : `No new signups in the last 24h. Invite links can be shared from <strong>User management</strong>.`,
    },
  ].filter(Boolean));

  return `
    ${programmeOverview(s)}
    ${dashFilterBar()}
    ${smart}
    ${adminAnalytics(ctx)}
    <div class="notice">${icon("info")}
      <span>Every login and signup across the portal is pushed to
      <strong>patrick@humanpractice.org</strong> and logged in the repository below.</span>
    </div>
    <div class="dash-grid">
      <div class="panel">
        <h2>${icon("inbox")} Login requests inbox</h2>
        <p class="panel-sub">Delivered to ${esc(ADMIN_EMAIL)}</p>
        ${inboxSummary}
        <div id="adminFeed">${feed}</div>
      </div>
      <div class="panel">
        <h2>Users by role</h2>
        <p class="panel-sub">${s.totalStaff.toLocaleString()} staff account${s.totalStaff === 1 ? "" : "s"}${
          s.totalLocalOnly ? ` · ${s.totalLocalOnly} learner${s.totalLocalOnly === 1 ? "" : "s"} on this device` : ""
        }</p>
        <div class="legend">
          ${!profilesLoaded
            ? `<div class="empty-state">Loading…</div>`
            : !profilesAuthed
            ? `<div class="empty-state">Signed in on a local account, which the HPF database has never seen — sign in with an account that exists in the database to see real role counts.</div>`
            : roleSegs.length
            ? roleSegs.map((r) => hbar(r.label, r.value, roleMax, r.color)).join("")
            : `<div class="empty-state">No staff accounts in the database yet.</div>`}
        </div>
      </div>
    </div>
    <div class="panel" style="margin-top:1.5rem">
      <h2>Logins this week</h2>
      <p class="panel-sub">Daily authenticated sessions</p>
      ${barChart(s.trend, s.trendLabels)}
    </div>
    ${adminAccountsPanel(ctx.user)}
    ${officerAssignmentsPanel()}
    ${devicesPanel()}
    ${userManagementPanel(ctx.user)}
    ${digitalLibraryPanel()}
    <div class="panel" style="margin-top:1.5rem">
      <div class="panel-head-row">
        <div>
          <h2>Recent activity</h2>
          <p class="panel-sub" style="margin-bottom:0">Across schools, teachers, learners and field teams</p>
        </div>
        ${collapseBtn("activity")}
      </div>
      ${collapseBody("activity", events.length
        ? `<div>${events
            .map(
              (e) => `<div class="submission">
                <span class="s-icon">${icon(e.type === "signup" ? "plus" : "login")}</span>
                <div><div class="s-title">${esc(e.name || e.identifier)}</div>
                  <div class="s-meta">${e.type === "signup" ? "New signup" : "Login"} ·
                    ${esc(ROLE_LABEL[e.role] || e.role || "—")} · ${timeAgo(e.at)}</div></div>
              </div>`
            )
            .join("")}</div>`
        : `<div class="empty-state">No activity yet.</div>`)}
    </div>`;
}

/* Live things a learner can join: active-session assignments (matched by
   results) and active assessments (open to everyone enrolled in the class). */
function liveSessionsFor(userId) {
  const out = [];
  if (!userId) return out;
  read(K_CLASSES, []).forEach((c) => {
    (c.assignments || []).forEach((a) => {
      if ((a.session || "planned") === "active" && a.results.some((r) => r.id === userId))
        out.push({ kind: "assignment", cls: c, a });
    });
    (c.assessments || []).forEach((a) => {
      if (!a.published || (a.session || "planned") !== "active") return;
      if (!c.learners.some((l) => l.id === userId)) return;
      if ((a.audience || "all") === "individual" && !(a.targetIds || []).includes(userId)) return;
      out.push({ kind: "assessment", cls: c, a });
    });
  });
  return out;
}

function liveSessionPanel(userId) {
  const live = liveSessionsFor(userId);
  if (!live.length) return "";
  return `
    <div class="panel live-panel" style="margin-bottom:1.5rem">
      <div class="panel-head-row">
        <div><h2>${icon("radio")} Live now — join your session${live.length === 1 ? "" : "s"}</h2>
          <p class="panel-sub" style="margin:0">Your teacher has started ${live.length} session${live.length === 1 ? "" : "s"} you can join</p></div>
      </div>
      <div class="live-list">${live
        .map(({ kind, cls, a }) => {
          if (kind === "assessment") {
            const mine = (a.submissions || []).find((s) => s.learnerId === userId);
            const cta = mine
              ? `<span class="pill ${scoreClass(mine.pct)}">${icon("check")} ${mine.pct}%</span>`
              : `<button class="btn btn-primary btn-xs" data-take-assess="${a.id}" data-take-class="${cls.id}">${icon("clipboard")} Take</button>`;
            return `<div class="live-row">
              <span class="assign-badge" style="background:var(--primary)">${icon("clipboard")}</span>
              <div class="live-main">
                <div class="live-title">${esc(a.title)}</div>
                <div class="live-meta">Assessment · ${a.questions.length} questions · ${esc(cls.name)} · ${esc(cls.school || "")}</div>
              </div>
              ${cta}
            </div>`;
          }
          const t = ASSIGN_TYPES[a.type] || ASSIGN_TYPES.lesson;
          return `<div class="live-row">
            <span class="assign-badge" style="background:${t.color}">${icon(t.icon)}</span>
            <div class="live-main">
              <div class="live-title">${esc(a.title)}</div>
              <div class="live-meta">${t.label} · ${esc(a.detail)} · ${esc(cls.name)} · ${esc(cls.school || "")}</div>
            </div>
            <button class="btn btn-primary btn-xs" data-join-session="${a.id}" data-join-title="${esc(a.title)}">${icon("play")} Join</button>
          </div>`;
        })
        .join("")}</div>
    </div>`;
}

/* Everything a specific learner has been assigned, across their classes:
   teacher assignments (lessons/exercises/quizzes) they're in, and published
   assessments targeted at them. Reads the same store the teacher writes, so
   newly-published work shows up as soon as the learner's dashboard renders. */
function learnerAssignments(userId) {
  const assignments = [];
  const assessments = [];
  const resources = [];
  if (!userId) return { assignments, assessments, resources };
  read(K_CLASSES, []).forEach((c) => {
    const enrolled = c.learners.some((l) => l.id === userId);
    (c.assignments || []).forEach((a) => {
      const result = a.results.find((x) => x.id === userId);
      if (result) assignments.push({ cls: c, a, result });
    });
    (c.assessments || []).forEach((a) => {
      if (!a.published) return;
      const targeted = (a.audience || "all") === "all" ? enrolled : (a.targetIds || []).includes(userId);
      if (!targeted) return;
      const submission = (a.submissions || []).find((s) => s.learnerId === userId) || null;
      assessments.push({ cls: c, a, submission });
    });
    (c.resources || []).forEach((r) => {
      const targeted = (r.audience || "all") === "all" ? enrolled : (r.targetIds || []).includes(userId);
      if (targeted) resources.push({ cls: c, r });
    });
  });
  return { assignments, assessments, resources };
}

/* learner activity status → { key, label, pill } */
const LA_STATUS = {
  pending: { label: "Pending", pill: "status-not_started" },
  started: { label: "Started", pill: "status-in_progress" },
  incomplete: { label: "Incomplete", pill: "danger-pill" },
  complete: { label: "Complete", pill: "status-completed" },
  submitted: { label: "Submitted", pill: "synced" },
};
function assignStatusKey(pct) {
  return pct >= 100 ? "complete" : pct > 0 ? "started" : "pending";
}
function assessStatusKey(a, submission) {
  if (submission) return "submitted";
  return (a.session || "planned") === "active" ? "pending" : "incomplete";
}

let learnerListOpen = false; // collapse/expand the full assignments list

function learnerAssignmentsFolder(userId) {
  const { assignments, assessments, resources } = learnerAssignments(userId);
  const total = assignments.length + assessments.length + resources.length;

  // tally activity statuses for the summary bar
  const counts = { pending: 0, started: 0, incomplete: 0, complete: 0, submitted: 0 };
  assignments.forEach(({ result }) => counts[assignStatusKey(result.pct)]++);
  assessments.forEach(({ a, submission }) => counts[assessStatusKey(a, submission)]++);

  const statusPill = (key) => `<span class="pill ${LA_STATUS[key].pill}">${LA_STATUS[key].label}</span>`;

  const resourceRows = resources
    .map(({ cls, r }) => {
      const t = RESOURCE_TYPES[r.type] || RESOURCE_TYPES.document;
      return `<div class="la-row">
        <span class="assign-badge" style="background:oklch(55% 0.15 300)">${icon(t.icon)}</span>
        <div class="la-main">
          <div class="la-title">${esc(r.title)}</div>
          <div class="la-meta">${t.label} · ${esc(cls.name)}${r.description ? " · " + esc(r.description) : ""}</div>
        </div>
        <div class="la-side"><button class="btn btn-primary btn-xs" data-learn-resource="${r.id}" data-learn-class="${cls.id}">${icon("externalLink")} Open</button></div>
      </div>`;
    })
    .join("");

  const assignRows = assignments
    .map(({ cls, a, result }) => {
      const t = ASSIGN_TYPES[a.type] || ASSIGN_TYPES.lesson;
      const key = assignStatusKey(result.pct);
      const live = (a.session || "planned") === "active";
      const scoreBit = typeof result.score === "number" && result.pct >= 100 ? ` · scored ${result.score}%` : "";
      return `<div class="la-row" data-status="${key}">
        <span class="assign-badge" style="background:${t.color}">${icon(t.icon)}</span>
        <div class="la-main">
          <div class="la-title">${esc(a.title)}${live ? ` <span class="la-live">${icon("radio")} live</span>` : ""}</div>
          <div class="la-meta">${t.label} · ${esc(cls.name)} · Due ${esc(a.due)}${scoreBit}</div>
          <div class="hbar-track" style="margin-top:.45rem"><div class="hbar-fill" style="width:${result.pct}%;background:var(--primary)"></div></div>
        </div>
        <div class="la-side">${statusPill(key)}<span class="la-pct">${result.pct}%</span></div>
      </div>`;
    })
    .join("");

  const assessRows = assessments
    .map(({ cls, a, submission }) => {
      const key = assessStatusKey(a, submission);
      const active = (a.session || "planned") === "active";
      let action;
      if (submission) action = `<span class="la-pct">${submission.pct}% · ${submission.correct}/${submission.total}</span>`;
      else if (active) action = `<button class="btn btn-primary btn-xs" data-take-assess="${a.id}" data-take-class="${cls.id}">${icon("clipboard")} Take now</button>`;
      else action = "";
      return `<div class="la-row" data-status="${key}">
        <span class="assign-badge" style="background:var(--primary)">${icon("clipboard")}</span>
        <div class="la-main">
          <div class="la-title">${esc(a.title)}${active && !submission ? ` <span class="la-live">${icon("radio")} open now</span>` : ""}</div>
          <div class="la-meta">Assessment · ${a.questions.length} questions · ${esc(cls.name)}</div>
        </div>
        <div class="la-side">${statusPill(key)}${action}</div>
      </div>`;
    })
    .join("");

  // compact status summary — always visible
  const summary = total
    ? `<div class="la-summary">${Object.keys(LA_STATUS)
        .filter((k) => counts[k])
        .map((k) => `<span class="pill ${LA_STATUS[k].pill}">${counts[k]} ${LA_STATUS[k].label}</span>`)
        .join("")}</div>`
    : "";

  const fullList = `
    ${assignments.length ? `<h3 class="la-head">${icon("book")} Lessons & quizzes</h3><div class="la-list">${assignRows}</div>` : ""}
    ${assessments.length ? `<h3 class="la-head" style="margin-top:1.5rem">${icon("chartColumn")} Assessments</h3><div class="la-list">${assessRows}</div>` : ""}
    ${resources.length ? `<h3 class="la-head" style="margin-top:1.5rem">${icon("library")} Learning resources</h3><div class="la-list">${resourceRows}</div>` : ""}`;

  return `
    <div class="panel">
      <div class="panel-head-row">
        <div><h2>${icon("clipboard")} My assignments</h2>
          <p class="panel-sub" style="margin:0">Everything your teacher has assigned to you — ${total} item${total === 1 ? "" : "s"}</p></div>
        ${total ? `<button class="btn btn-outline btn-xs" data-la-toggle>${icon(learnerListOpen ? "arrowUpRight" : "list")} ${learnerListOpen ? "Collapse" : "Show all"}</button>` : ""}
      </div>
      ${total ? "" : `<div class="empty-state">Nothing assigned yet.<br>When your teacher publishes a lesson, quiz, assessment, or resource, it appears here right away.</div>`}
      ${summary}
      ${learnerListOpen ? fullList : ""}
    </div>`;
}

/* ---------- learner: take an assessment (modal, auto-marked) ---------- */
function openAssessModal(classId, assessId, userId, onDone) {
  const cls = read(K_CLASSES, []).find((c) => c.id === classId);
  const a = cls?.assessments.find((x) => x.id === assessId);
  if (!a) return;

  const body = a.questions
    .map(
      (q, qi) => `<div class="qtake">
        <div class="qtake-q"><strong>Q${qi + 1}.</strong> ${esc(q.text)}</div>
        <div class="qtake-opts">${q.options
          .map(
            (o, oi) => `<label class="qtake-opt"><input type="radio" name="take-${qi}" value="${oi}"> <span>${esc(o)}</span></label>`
          )
          .join("")}</div>
      </div>`
    )
    .join("");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div>
          <h2>${esc(a.title)}</h2>
          <p class="panel-sub" style="margin:0">${a.questions.length} questions · ${esc(cls.name)} · answer all, then submit</p>
        </div>
        <button class="icon-btn" data-modal-close aria-label="Close">✕</button>
      </div>
      <form id="takeForm" class="modal-body">${body}</form>
      <div class="modal-foot">
        <button class="btn btn-primary" data-take-submit>${icon("check")} Submit answers</button>
        <button class="btn btn-outline" data-modal-close>Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelectorAll("[data-modal-close]").forEach((b) => b.addEventListener("click", close));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  overlay.querySelector("[data-take-submit]").addEventListener("click", () => {
    const form = overlay.querySelector("#takeForm");
    const answers = a.questions.map((q, qi) => {
      const sel = form.querySelector(`input[name="take-${qi}"]:checked`);
      return sel ? +sel.value : null;
    });
    if (answers.some((v) => v === null))
      return toast("Answer every question", "Please choose an option for each question.", "error");

    const correct = a.questions.reduce((n, q, i) => n + (answers[i] === q.correct ? 1 : 0), 0);
    const pct = Math.round((correct / a.questions.length) * 100);

    // persist submission (replace any earlier attempt), auto-marked
    const classes = read(K_CLASSES, []);
    const tc = classes.find((c) => c.id === classId);
    const ta = tc.assessments.find((x) => x.id === assessId);
    const learner = tc.learners.find((l) => l.id === userId);
    ta.submissions = (ta.submissions || []).filter((s) => s.learnerId !== userId);
    ta.submissions.push({
      learnerId: userId, name: learner ? learner.name : "You",
      answers, correct, total: a.questions.length, pct, at: Date.now(),
    });
    write(K_CLASSES, classes);
    // Opportunistic — only actually reaches Postgres if the browser's still-
    // active session belongs to the teacher who owns this class (the shared-
    // device model: the teacher's own JWT stays valid while a learner uses
    // the same browser). Otherwise this is a no-op and the next real mount
    // of the coach view picks it up instead.
    syncResults();

    close();
    toast("Assessment submitted", `You scored ${correct}/${a.questions.length} (${pct}%). Auto-marked instantly.`, "success");
    if (onDone) onDone();
  });
}

function learnerBody(ctx) {
  const d = DASH.learner;
  const k = KOLIBRI.learner;
  const liveHtml = liveSessionPanel(ctx?.user?.id);

  // computed insights: nearly-done resource, weakest course, streak nudge
  const inProgress = k.continue.filter((r) => r.progress > 0 && r.progress < 100);
  const almostDone = inProgress.sort((a, b) => b.progress - a.progress)[0];
  const weakest = [...d.courses].sort((a, b) => a.progress - b.progress)[0];
  const streak = d.stats.find((s) => s.label === "Day streak")?.count || 0;
  const smart = insights([
    almostDone && {
      icon: "target", tone: "good",
      html: `You're <strong>${100 - almostDone.progress}% away</strong> from finishing “<strong>${esc(almostDone.title)}</strong>” — a quick session will complete it.`,
    },
    weakest && {
      icon: "lightbulb", tone: "warn",
      html: `<strong>${esc(weakest.name)}</strong> is your least-advanced course (${weakest.progress}%). Try one lesson today to keep it moving.`,
    },
    {
      icon: "flame", tone: "",
      html: `Your streak is <strong>${streak} days</strong> — learn anything today to make it ${streak + 1}.`,
    },
  ].filter(Boolean));

  const classCards = k.classes
    .map(
      (c) => `<button class="kclass" data-class="${esc(c.name)}">
        <span class="kclass-badge" style="background:${c.color}">${icon("graduation")}</span>
        <span class="kclass-body">
          <span class="kclass-name">${esc(c.name)}</span>
          <span class="kclass-meta">${esc(c.teacher)} · ${c.count} resources</span>
        </span>
        ${icon("arrowRight")}
      </button>`
    )
    .join("");

  const channelChips = k.channels
    .map(
      (c, i) => `<button class="kchip ${i === 0 ? "active" : ""}" data-channel="${esc(c)}">${esc(c)}</button>`
    )
    .join("");

  const assignFolder = learnerAssignmentsFolder(ctx?.user?.id);

  return `
    ${statTiles(d.stats)}
    ${smart}
    <div class="dash-shell">
      ${sideNav(
        [
          { id: "assignments", label: "My Assignments", icon: "clipboard" },
          { id: "resources", label: "Learning Resources", icon: "library" },
        ],
        "assignments",
        "data-subtab"
      )}
      <div class="dash-main">
        <div data-subpanel="assignments">
          ${liveHtml}
          ${assignFolder}
        </div>
        <div data-subpanel="resources" hidden>
          ${learnerResources(ctx?.user?.id)}
        </div>
      </div>
    </div>`;
}

/* Learning Resources for a learner: Digital Library (shared + published),
   Numeracy, and Literacy — the only resource categories they see. */
function learnerResources(userId) {
  const { resources } = learnerAssignments(userId); // shared to this learner
  const lib = publishedLibrary();
  const inCat = (cat) => lib.filter((r) => (r.category || "").toLowerCase().includes(cat));

  const card = (r, shared) => {
    const t = RESOURCE_TYPES[r.type] || RESOURCE_TYPES.document;
    return `<div class="lib-row">
      <span class="lib-ic">${icon(t.icon)}</span>
      <div class="lib-main">
        <div class="lib-title">${esc(r.title)}${shared ? ' <span class="la-live">shared with you</span>' : ""}</div>
        <div class="lib-sub">${t.label}${r.category ? " · " + esc(r.category) : ""}${r.description ? " · " + esc(r.description) : ""}</div>
      </div>
      <button class="btn btn-primary btn-xs" data-lr-open="${r.id}">${icon("externalLink")} Open</button>
    </div>`;
  };
  const list = (rows, empty) => (rows ? `<div class="lib-list">${rows}</div>` : `<div class="empty-state">${empty}</div>`);

  const libraryRows =
    (resources.map(({ r }) => card(r, true)).join("") + lib.map((r) => card(r, false)).join("")) || null;
  const numeracyRows = inCat("numeracy").map((r) => card(r, false)).join("") || null;
  const literacyRows = inCat("literacy").map((r) => card(r, false)).join("") || null;

  const cats = [
    { id: "library", label: "Digital Library" },
    { id: "numeracy", label: "Numeracy" },
    { id: "literacy", label: "Literacy" },
  ];
  const nav = `<div class="ksubtabs">${cats
    .map((c, i) => `<button class="ksubtab ${i === 0 ? "active" : ""}" data-lr-cat="${c.id}">${c.label}</button>`)
    .join("")}</div>`;

  return `
    <div class="panel">
      <div class="panel-head-row"><div>
        <h2>${icon("library")} Learning resources</h2>
        <p class="panel-sub" style="margin:0">Resources shared with you and from HPF's digital library</p>
      </div></div>
      ${nav}
      <div data-lr-panel="library">${list(libraryRows, "No resources shared yet — your teacher and HPF will add them here.")}</div>
      <div data-lr-panel="numeracy" hidden>${list(numeracyRows, "No numeracy resources yet.")}</div>
      <div data-lr-panel="literacy" hidden>${list(literacyRows, "No literacy resources yet.")}</div>
    </div>`;
}

/* find a resource by id in the library or any class's shared resources */
function findResource(id) {
  const inLib = getLibrary().find((r) => r.id === id);
  if (inLib) return inLib;
  for (const c of read(K_CLASSES, [])) {
    const r = (c.resources || []).find((x) => x.id === id);
    if (r) return r;
  }
  return null;
}

function scoreClass(v) {
  return v >= 80 ? "synced" : v >= 60 ? "pending" : "danger-pill";
}

/* -------- coach: class store, state & progress computations -------- */
const K_CLASSES = "hpf_classes";
const ASSIGN_TYPES = {
  lesson: { label: "Lesson", icon: "book", color: "oklch(58% 0.16 300)" },
  exercise: { label: "Exercise", icon: "target", color: "oklch(58% 0.18 264)" },
  quiz: { label: "Quiz", icon: "trophy", color: "oklch(62% 0.16 70)" },
};
const coachState = {
  tab: "overview",
  learnerId: null,
  openForm: false,
  classId: null,
  openClassForm: false,
  openLearnerForm: false,
  openUserForm: false,
  openAssessForm: false,
  analyzeId: null, // assessment whose analytics panel is expanded
  publishId: null, // assessment whose publish dialog is open
  editAssignId: null, // assignment being edited in the planner
  openResourceForm: false, // teacher "share resource" form
  peopleGrade: "all", // People tab grade/class filter
  peopleOpen: false, // People tab list collapse
  resultsOpen: false, // Results tab list collapse
  editUserId: null, // user open in the teacher edit modal
};


/* ---------------------------------------------------------- classes (Postgres)
   Migrated from hpf_classes-only storage to the real `classes` + `enrollments`
   tables (see supabase/schema.sql; RLS confirmed live and unchanged — this
   migration added no new table and no new policy).

   Assignments, assessments and their submissions have NOT migrated — that is
   audit items 6-7, deliberately separate. They still live nested inside each
   class object exactly as before, so hpf_classes remains in active use as
   more than a cache: it is the only store those still hold. This function
   fetches name/school/roster from Postgres and merges them onto whatever is
   already in the local class object, preserving its assignments/assessments
   arrays untouched, then writes the merge back to hpf_classes so every other
   function in this file that reads a class's nested work keeps working with
   zero changes.

   A second, structural reason the local mirror cannot simply be deleted once
   this loads: learners in this app have no Supabase session at all (see
   isLearnerRole in app.js) and RLS is JWT-based, so a learner's own view of
   "my assignments" (liveSessionsFor, learnerAssignments below) can never be a
   direct client-side Postgres query — there is no JWT for RLS to authorize.
   Those two functions keep reading hpf_classes unchanged; that is the one
   part of "remove the dependency on hpf_classes" this migration cannot do,
   and is a scope boundary, not an oversight. */
let classesCache = [];         // Postgres classes, this session's RLS-visible set
let classesLoaded = false;
let classesError = null;
let classesAuthed = false;     // real Supabase session at all? (false for local/legacy accounts)

/* ---------------------------------------------------------- attendance (patch-18)
   One row per learner per class per day. Loaded per-class (not globally) —
   a coach only ever needs their own class's history, and this keeps the
   query small as the table grows across a school year. */
let attendanceCache = [];
let attendanceLoadedForClassId = null; // which class's rows are currently in attendanceCache
let attendanceError = null;
let attendanceDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, defaults to today

async function loadAttendance(classId) {
  const { data, error } = await supabase.from("attendance_records").select("*").eq("class_id", classId);
  attendanceLoadedForClassId = classId;
  if (error) { attendanceError = authMessage(error); return attendanceCache; }
  attendanceError = null;
  attendanceCache = data || [];
  return attendanceCache;
}

// Guards the Programme Overview mount-time load below: without this, its own
// "re-render once the data lands" was re-entering wireBody, which re-ran the
// exact same load-and-render block, which re-rendered again — forever. Every
// admin/staff view of the dashboard was stuck in a tight render loop, which
// is what showed up as the whole screen shaking/blinking.
let programmeDataLoaded = false;

async function loadClasses() {
  const { data: authData } = await supabase.auth.getUser();
  classesAuthed = !!authData?.user;
  if (!classesAuthed) {
    // A local-only or legacy session has no JWT, so every query below would
    // return empty under RLS regardless — skip the round trip and say why,
    // the same pattern already used for schools/returns/field reports.
    classesLoaded = true;
    classesError = null;
    return classesCache;
  }

  const { data: classRows, error: classErr } = await supabase
    .from("classes").select("*").order("created_at");
  classesLoaded = true;
  if (classErr) { classesError = authMessage(classErr); return classesCache; }

  // A failed fetch on any of these should not blank out what an admin or
  // teacher can otherwise see — degrade to classes without that piece rather
  // than nothing at all, matching the enrollments fallback already below.
  const [enrRes, assignRes, assessRes] = await Promise.all([
    supabase.from("enrollments").select("*").order("created_at"),
    supabase.from("assignments").select("*").order("created_at", { ascending: false }),
    supabase.from("assessments").select("*").order("created_at", { ascending: false }),
  ]);
  if (enrRes.error) console.warn("enrollments fetch failed:", enrRes.error.message);
  if (assignRes.error) console.warn("assignments fetch failed:", assignRes.error.message);
  if (assessRes.error) console.warn("assessments fetch failed:", assessRes.error.message);
  const enrRows = enrRes.data || [];
  const assignRows = assignRes.data || [];
  const assessRows = assessRes.data || [];

  // questions depend on knowing which assessments exist, so this can only
  // run after the fetch above resolves.
  const assessIds = assessRows.map((a) => a.id);
  let questionRows = [];
  if (assessIds.length) {
    const { data, error } = await supabase
      .from("questions").select("*").in("assessment_id", assessIds).order("position");
    if (error) console.warn("questions fetch failed:", error.message);
    questionRows = data || [];
  }

  classesError = null;
  const local = read(K_CLASSES, []);
  const byId = Object.fromEntries(local.map((c) => [c.id, c]));

  classesCache = classRows.map((c) => {
    const existing = byId[c.id] || {};
    const existingAssign = Object.fromEntries((existing.assignments || []).map((a) => [a.id, a]));
    const existingAssess = Object.fromEntries((existing.assessments || []).map((a) => [a.id, a]));
    return {
      id: c.id, name: c.name, school: c.school, ownerId: c.owner_id,
      learners: enrRows
        .filter((e) => e.class_id === c.id)
        .map((e) => ({
          id: e.learner_id || e.id, name: e.name,
          active: e.active_label || "just now", account: e.is_account,
          _enrollmentId: e.id, // the row a removal must delete — not the same as `id` for a name-only entry
        })),
      // The shell (title/type/due/session, questions) is real, from Postgres.
      // Per-learner results/submissions are not yet migrated (that is the
      // separate results-sync stage) — carried over from whatever this
      // browser already recorded locally for that same assignment/assessment
      // id, same "preserve untouched" approach the class merge above uses.
      assignments: assignRows
        .filter((a) => a.class_id === c.id)
        .map((a) => ({
          id: a.id, type: a.type, title: a.title, detail: a.detail || "",
          due: a.due || "no due date", session: a.session,
          results: (existingAssign[a.id] && existingAssign[a.id].results) || [],
        })),
      assessments: assessRows
        .filter((a) => a.class_id === c.id)
        .map((a) => ({
          id: a.id, title: a.title, session: a.session, published: a.published,
          audience: a.audience, targetIds: a.target_ids || [],
          questions: questionRows
            .filter((q) => q.assessment_id === a.id)
            .map((q) => ({ id: q.id, text: q.text, options: q.options, correct: q.correct })),
          submissions: (existingAssess[a.id] && existingAssess[a.id].submissions) || [],
        })),
    };
  });
  write(K_CLASSES, classesCache);
  return classesCache;
}

/* ---------------------------------------------------------- results sync
   assignment_results and submissions are per-learner data, and a learner in
   this app never has a Supabase session to write them with directly (no
   email, no JWT — the same structural fact behind every "learner reads the
   local mirror" note above). Both tables' write policies already carve out
   for this: alongside `learner_id = auth.uid()`, they also accept
   `owns_class(...)` with no learner_id check at all — the schema expects the
   *teacher's* authenticated session to record a local learner's result on
   their behalf, keyed by name rather than an identity Postgres never has.
   That's what this does: push whatever this device has recorded locally,
   that Postgres doesn't have yet, up through the teacher's own session.

   "Doesn't have yet" is tracked with a local-only _syncedId stamped onto the
   result/submission once its insert succeeds — write()/loadClasses()'s merge
   both carry it forward untouched (it's not a column either table has), so a
   second sync run skips anything already stamped instead of double-inserting.
   Never synced: a result with no matching enrollment id, e.g. a learner
   enrolled through the older local-only "Add user" path (see Stage B's
   commit message) rather than the real enrollments table — inserting that
   would fail assignment_results' foreign key, so it's left local-only,
   same limit that path already has for everything else. */
let syncingResults = false;
let resultsOnlineListenerAttached = false;

async function syncResults() {
  if (!classesAuthed || syncingResults) return;
  syncingResults = true;
  try {
    const classes = getClasses();
    let changed = false;

    for (const c of classes) {
      const realLearnerIds = new Set(c.learners.map((l) => l.id));

      for (const a of c.assignments) {
        const pending = a.results.filter((r) => !r._syncedId && realLearnerIds.has(r.id));
        if (!pending.length) continue;
        const { data: rows, error } = await supabase.from("assignment_results").insert(
          pending.map((r) => ({ assignment_id: a.id, enrollment_id: r.id, pct: r.pct, score: typeof r.score === "number" ? r.score : null }))
        ).select();
        if (error) { console.warn("assignment_results sync failed:", error.message); continue; }
        rows.forEach((row, i) => { pending[i]._syncedId = row.id; });
        changed = true;
      }

      for (const a of c.assessments) {
        const pending = (a.submissions || []).filter((s) => !s._syncedId);
        if (!pending.length) continue;
        const { data: rows, error } = await supabase.from("submissions").insert(
          pending.map((s) => ({
            assessment_id: a.id, learner_id: null, name: s.name,
            answers: s.answers, correct: s.correct, total: s.total, pct: s.pct,
            created_at: s.at ? new Date(s.at).toISOString() : undefined,
          }))
        ).select();
        if (error) { console.warn("submissions sync failed:", error.message); continue; }
        rows.forEach((row, i) => { pending[i]._syncedId = row.id; });
        changed = true;
      }
    }

    if (changed) saveClasses(classes);
  } finally {
    syncingResults = false;
  }
}

/* Synchronous read of the local mirror — every render path in this file calls
   this exactly as it called the old localStorage-only version, unchanged. */
function getClasses() {
  let classes = read(K_CLASSES, []);
  let dirty = false;
  classes.forEach((c) => {
    if (!Array.isArray(c.assessments)) { c.assessments = []; dirty = true; }
    c.assessments.forEach((a) => {
      if (a.published === undefined) {
        a.published = a.session === "active" || a.session === "ended";
        a.audience = a.audience || "all";
        a.targetIds = a.targetIds || [];
        dirty = true;
      }
    });
  });
  if (dirty) write(K_CLASSES, classes);
  return classes;
}
const saveClasses = (classes) => write(K_CLASSES, classes);

/* No control in the current UI deletes a class — grep-confirmed, there is no
   data-class-delete anywhere — so this is deliberately not wired to a button;
   adding one would be a UI change beyond what this migration asked for. It
   exists so the capability is available (e.g. from a future admin tool)
   without a separate change, and to demonstrate the deletion is genuinely
   safe under the RLS already in place: `class write` is owner-or-admin, and
   FK cascades (enrollments.class_id, assignments.class_id, assessments.class_id
   all ON DELETE CASCADE) mean Postgres itself removes the roster and any
   migrated coursework with it — nothing is left orphaned in the database. */
async function deleteClass(classId) {
  const { error } = await supabase.from("classes").delete().eq("id", classId);
  if (error) return { error };
  classesCache = classesCache.filter((c) => c.id !== classId);
  saveClasses(getClasses().filter((c) => c.id !== classId));
  return { error: null };
}

/* the signed-in user whose coach dashboard is rendering (set in dashboardBody).
   A real teacher is scoped to their own school; an admin previewing the
   teacher view sees every school. */
let coachUser = null;
function coachSchool() {
  return coachUser && coachUser.role === "teacher" && coachUser.school ? coachUser.school : null;
}
/* classes visible to the current coach — only their school's, if scoped */
function scopedClasses() {
  const all = getClasses();
  const school = coachSchool();
  return school ? all.filter((c) => c.school === school) : all;
}

function currentClass() {
  const classes = getClasses();          // full store — used when saving
  // A *filtered view* of `classes`, not scopedClasses()'s own independent
  // getClasses() call — read() re-parses localStorage into brand new objects
  // every time, so a second call would return a `cls` no longer the same
  // object as anything in `classes`, and mutating it would silently never
  // reach saveClasses(classes). Every caller of currentClass() destructures
  // both and mutates `cls` expecting that to change what gets saved, so this
  // has to share identity with `classes`, not just match its data.
  const school = coachSchool();
  const scoped = school ? classes.filter((c) => c.school === school) : classes;
  const cls = scoped.find((c) => c.id === coachState.classId) || scoped[0] || null;
  coachState.classId = cls ? cls.id : null;
  return { classes, scoped, cls };
}

/* registered learner accounts not yet enrolled in this class */
function enrollableUsers(cls) {
  return read(K_USERS, []).filter(
    (u) => u.role === "learner" && !cls.learners.some((l) => l.id === u.id)
  );
}

const statusOf = (pct) => (pct >= 100 ? "completed" : pct > 0 ? "in_progress" : "not_started");
const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
const assignmentCompletion = (a) => avg(a.results.map((r) => r.pct));
function assignmentAvgScore(a) {
  const s = a.results.filter((r) => r.pct >= 100 && typeof r.score === "number");
  return s.length ? avg(s.map((r) => r.score)) : null;
}
function statusCounts(a) {
  const c = { completed: 0, in_progress: 0, not_started: 0 };
  a.results.forEach((r) => c[statusOf(r.pct)]++);
  return c;
}
function learnerOverall(list, id) {
  const p = list.filter((a) => a.results.some((r) => r.id === id))
    .map((a) => a.results.find((r) => r.id === id).pct);
  return avg(p);
}
function learnerAvgScore(list, id) {
  const s = [];
  list.forEach((a) => {
    const r = a.results.find((x) => x.id === id);
    if (r && r.pct >= 100 && typeof r.score === "number") s.push(r.score);
  });
  return s.length ? avg(s) : null;
}

/* assignments where a learner is struggling: barely started, or low score */
function weakAreas(list, id) {
  const out = [];
  list.forEach((a) => {
    const r = a.results.find((x) => x.id === id);
    if (!r) return;
    if (r.pct < 50 || (r.pct >= 100 && typeof r.score === "number" && r.score < 60))
      out.push(a.title);
  });
  return out;
}

/* rows for the Results table and all exports: header + one row per learner */
function buildResultRows(cls) {
  const list = cls.assignments;
  const header = [
    "Student", "Overall completion %", "Average score %",
    ...list.map((a) => a.title),
    "Areas needing help",
  ];
  const rows = cls.learners.map((l) => {
    const cells = list.map((a) => {
      const r = a.results.find((x) => x.id === l.id);
      if (!r) return "—";
      return r.pct >= 100 && typeof r.score === "number" ? `${r.score}% score` : `${r.pct}% done`;
    });
    const weak = weakAreas(list, l.id);
    const score = learnerAvgScore(list, l.id);
    return [
      l.name,
      String(learnerOverall(list, l.id)),
      score === null ? "—" : String(score),
      ...cells,
      weak.length ? weak.join("; ") : "None",
    ];
  });
  return { header, rows };
}

function coachResults(list, learners, cls) {
  const rows = learners
    .map((l) => {
      const overall = learnerOverall(list, l.id);
      const score = learnerAvgScore(list, l.id);
      const weak = weakAreas(list, l.id);
      return `<div class="ut-row" data-learner-open="${l.id}" style="grid-template-columns:minmax(0,1.2fr) auto auto minmax(0,1.6fr)">
        <div class="ut-cell ut-user">
          <span class="avatar-sm">${esc(l.name.slice(0, 1))}</span>
          <div><div class="ut-name">${esc(l.name)}</div><div class="ut-sub">${list.length} assignment${list.length === 1 ? "" : "s"}</div></div>
        </div>
        <div class="ut-cell"><span class="pill ${scoreClass(overall)}">${overall}% done</span></div>
        <div class="ut-cell"><span class="pill ${score === null ? "" : scoreClass(score)}">${score === null ? "no scores" : "avg " + score + "%"}</span></div>
        <div class="ut-cell weak-cell">${
          weak.length
            ? weak.map((w) => `<span class="weak-chip">${icon("alert")} ${esc(w)}</span>`).join("")
            : `<span class="pill synced">${icon("check")} No areas flagged</span>`
        }</div>
      </div>`;
    })
    .join("");

  return `
    <div class="panel">
      <div class="panel-head-row">
        <div>
          <h2>Results — ${esc(cls.name)}</h2>
          <p class="panel-sub" style="margin:0">${esc(cls.school || "")} · per-student results and areas needing help</p>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn btn-outline btn-xs" data-results-toggle>${icon(coachState.resultsOpen ? "arrowUpRight" : "list")} ${coachState.resultsOpen ? "Collapse" : "Show list"}</button>
          <button class="btn btn-outline btn-xs" data-export-csv>${icon("download")} CSV</button>
          <button class="btn btn-outline btn-xs" data-export-xls>${icon("download")} Excel</button>
          <button class="btn btn-outline btn-xs" data-export-pdf>${icon("download")} PDF</button>
        </div>
      </div>
      ${learners.length
        ? (coachState.resultsOpen
            ? `<div class="user-table">
                <div class="ut-row ut-head" style="grid-template-columns:minmax(0,1.2fr) auto auto minmax(0,1.6fr)">
                  <div class="ut-cell">Student</div><div class="ut-cell">Completion</div>
                  <div class="ut-cell">Avg score</div><div class="ut-cell">Areas needing help</div>
                </div>
                <div>${rows}</div>
              </div>`
            : `<div class="la-summary"><span class="la-chip">${learners.length} students</span>
                <span class="la-chip">${learners.filter((l) => learnerOverall(list, l.id) < 70).length} need attention</span>
                <span class="hint" style="align-self:center">— click <strong>Show list</strong> for per-student results</span></div>`)
        : `<div class="empty-state">No learners in this class yet — enroll some in the Learners tab.</div>`}
    </div>`;
}

function typeBadge(type) {
  const t = ASSIGN_TYPES[type];
  return `<span class="assign-badge" style="background:${t.color}" title="${t.label}">${icon(t.icon)}</span>`;
}

/* one row in the Overview / Assignments lists */
function assignmentRow(a, clickable) {
  const comp = assignmentCompletion(a);
  const sc = assignmentAvgScore(a);
  const cnt = statusCounts(a);
  const t = ASSIGN_TYPES[a.type];
  return `<div class="assign-row${clickable ? " clickable" : ""}"${clickable ? ` data-assign-preview="${a.id}" title="Preview“${esc(a.title)}”"` : ""}>
    ${typeBadge(a.type)}
    <div class="assign-main">
      <div class="assign-title">${esc(a.title)}</div>
      <div class="assign-meta">${t.label} · ${esc(a.detail)} · Due ${esc(a.due)}</div>
    </div>
    <div class="assign-prog">
      <div class="hbar-track"><div class="hbar-fill" style="width:${comp}%;background:var(--primary)"></div></div>
      <span class="assign-pct">${comp}%</span>
    </div>
    <div class="assign-counts">
      <span class="sc done" title="Completed">${icon("check")} ${cnt.completed}</span>
      <span class="sc prog" title="In progress">◐ ${cnt.in_progress}</span>
      <span class="sc none" title="Not started">○ ${cnt.not_started}</span>
    </div>
    <span class="pill ${sc === null ? "" : scoreClass(sc)}">${sc === null ? "—" : "avg " + sc + "%"}</span>
  </div>`;
}

function coachOverview(list, learners, cls) {
  const dist = { completed: 0, in_progress: 0, not_started: 0 };
  list.forEach((a) => {
    const c = statusCounts(a);
    dist.completed += c.completed;
    dist.in_progress += c.in_progress;
    dist.not_started += c.not_started;
  });
  const total = dist.completed + dist.in_progress + dist.not_started || 1;
  const seg = (n, cls) => `<div class="dist-seg ${cls}" style="width:${(n / total) * 100}%"></div>`;

  // Real submissions, most recent first — the only assignment activity that
  // carries a timestamp locally (assignment results don't, only assessment
  // submissions do). Not yet Postgres-backed (that's the assignments/
  // assessments migration), but not fabricated either.
  const activity = (cls?.assessments || [])
    .flatMap((a) => (a.submissions || []).map((sub) => ({ ...sub, title: a.title })))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 5);

  return `
    <div class="panel">
      <h2>Class status</h2>
      <p class="panel-sub">Every learner × assignment, at a glance</p>
      <div class="dist-bar">
        ${seg(dist.completed, "done")}${seg(dist.in_progress, "prog")}${seg(dist.not_started, "none")}
      </div>
      <div class="dist-legend">
        <span><span class="dot done"></span> Completed · <strong>${dist.completed}</strong></span>
        <span><span class="dot prog"></span> In progress · <strong>${dist.in_progress}</strong></span>
        <span><span class="dot none"></span> Not started · <strong>${dist.not_started}</strong></span>
      </div>
    </div>
    <div class="panel" style="margin-top:1.5rem">
      <h2>Cumulative progress by assignment</h2>
      <p class="panel-sub">Completion across the class and average score</p>
      <div class="assign-list">${list.map(assignmentRow).join("")}</div>
    </div>
    <div class="panel" style="margin-top:1.5rem">
      <h2>Class activity</h2>
      <p class="panel-sub">Recent learner activity</p>
      <div>${activity.length
        ? activity
            .map(
              (s) => `<div class="submission"><span class="s-icon">${icon("activity")}</span>
                <div><div class="s-title">${esc(s.name)}</div>
                <div class="s-meta">scored ${s.pct}% on “${esc(s.title)}” · ${s.at ? timeAgo(s.at) : "—"}</div></div></div>`
            )
            .join("")
        : `<div class="empty-state">No assessment activity yet.</div>`}</div>
    </div>`;
}

function learnerChecklist(learners, checked) {
  return learners
    .map(
      (l) => `<label class="lchk"><input type="checkbox" name="learner" value="${l.id}" ${checked ? "checked" : ""}> ${esc(l.name)}</label>`
    )
    .join("");
}

/* the Plan workspace form — create, or (when editing) update a lesson/quiz */
function planForm(cls, classes, editing) {
  const typeOpts = Object.entries(ASSIGN_TYPES)
    .map(([v, t]) => `<option value="${v}" ${editing && editing.type === v ? "selected" : ""}>${t.label}</option>`)
    .join("");

  // edit mode: metadata only (title/type/detail/due) — audience & class stay put
  if (editing) {
    return `
      <form id="assignForm" class="add-user-form" data-editing="${editing.id}">
        <div class="form-row">
          <div class="field"><label>Type</label>
            <select class="select" name="type">${typeOpts}</select></div>
          <div class="field"><label>Title</label>
            <input class="input" name="title" required value="${esc(editing.title)}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Detail</label>
            <input class="input" name="detail" value="${esc(editing.detail || "")}"></div>
          <div class="field"><label>Due</label>
            <input class="input" name="due" value="${esc(editing.due || "")}"></div>
        </div>
        <div class="add-user-actions">
          <button class="btn btn-primary" type="submit">${icon("check")} Save changes</button>
          <button class="btn btn-outline" type="button" data-assign-cancel>Cancel</button>
        </div>
      </form>`;
  }

  const classOpts =
    (classes.length > 1 ? `<option value="__all__">${esc(coachSchool() ? "All grades — " + coachSchool() : "All my grades")}</option>` : "") +
    classes
      .map(
        (c) => `<option value="${c.id}" ${c.id === cls.id ? "selected" : ""}>${esc(c.name)} · ${esc(c.school || "")} (${c.learners.length})</option>`
      )
      .join("");

  return `
    <form id="assignForm" class="add-user-form">
      <div class="form-row">
        <div class="field"><label>Type</label>
          <select class="select" name="type">${typeOpts}</select></div>
        <div class="field"><label>Title</label>
          <input class="input" name="title" required placeholder="e.g. Fractions — Part 2"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Assign to grade / class</label>
          <select class="select" name="classId" data-assign-class>${classOpts}</select></div>
        <div class="field"><label>Audience</label>
          <select class="select" name="audience" data-assign-audience>
            <option value="all" selected>Whole class — all students</option>
            <option value="individual">Individual learner(s)</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Detail</label>
          <input class="input" name="detail" placeholder="e.g. 4 resources / 10 questions"></div>
        <div class="field"><label>Due</label>
          <input class="input" name="due" placeholder="e.g. in 1 week"></div>
      </div>
      <div class="field" data-assign-picker hidden>
        <div class="picker-head">
          <label style="margin-bottom:0">Pick the learner(s)</label>
          <label class="lchk select-all-chk"><input type="checkbox" data-select-all> Select all</label>
        </div>
        <div class="assign-learners">${learnerChecklist(cls.learners, false)}</div>
      </div>
      <div class="add-user-actions">
        <button class="btn btn-primary" type="submit">${icon("send")} Create & assign</button>
        <button class="btn btn-outline" type="button" data-assign-cancel>Cancel</button>
      </div>
    </form>`;
}

/* teacher shares a resource — from the digital library or a new upload/link */
function shareResourceForm(cls, classes) {
  const pub = publishedLibrary();
  const libOpts =
    `<option value="">— none (add a new one below) —</option>` +
    pub.map((r) => `<option value="${r.id}">${esc(r.title)} · ${RESOURCE_TYPES[r.type]?.label || ""}</option>`).join("");
  const typeOpts = Object.entries(RESOURCE_TYPES).map(([v, t]) => `<option value="${v}">${t.label}</option>`).join("");
  const classOpts = classes
    .map((c) => `<option value="${c.id}" ${c.id === cls.id ? "selected" : ""}>${esc(c.name)} (${c.learners.length})</option>`)
    .join("");
  return `
    <form id="resourceForm" class="add-user-form">
      <div class="form-row">
        <div class="field"><label>${icon("library")} From digital library</label>
          <select class="select" name="libId">${libOpts}</select>
          <p class="hint">${pub.length} published resource${pub.length === 1 ? "" : "s"} available.</p></div>
        <div class="field"><label>Share with class</label>
          <select class="select" name="classId" data-res-class>${classOpts}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>…or new resource title</label>
          <input class="input" name="title" maxlength="120" placeholder="Leave blank if picking from library"></div>
        <div class="field"><label>Type</label>
          <select class="select" name="type">${typeOpts}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Link (URL)</label>
          <input class="input" name="url" type="url" placeholder="https://…"></div>
        <div class="field"><label>Audience</label>
          <select class="select" name="audience" data-res-audience>
            <option value="all" selected>Whole class</option>
            <option value="individual">Individual learner(s)</option>
          </select></div>
      </div>
      <div class="field"><label>${icon("upload")} …or upload a file <span style="font-weight:400;color:var(--muted-foreground)">(under 800 KB)</span></label>
        <input class="input" name="file" type="file" data-res-file></div>
      <div class="field" data-res-picker hidden>
        <div class="picker-head"><label style="margin-bottom:0">Pick learner(s)</label>
          <label class="lchk select-all-chk"><input type="checkbox" data-res-select-all> Select all</label></div>
        <div class="assign-learners" data-res-learners>${cls.learners.map((l) => `<label class="lchk"><input type="checkbox" name="reslearner" value="${l.id}"> ${esc(l.name)}</label>`).join("")}</div>
      </div>
      <div class="add-user-actions">
        <button class="btn btn-primary" type="submit">${icon("send")} Publish to learners</button>
        <button class="btn btn-outline" type="button" data-share-resource-cancel>Cancel</button>
      </div>
    </form>`;
}

function sharedResourceList(cls) {
  const res = cls.resources || [];
  if (!res.length) return "";
  return `<div class="shared-res">
    <div class="shared-res-head">${icon("library")} Shared with this class <span class="hint">· ${res.length}</span></div>
    ${res
      .map((r) => {
        const t = RESOURCE_TYPES[r.type] || RESOURCE_TYPES.document;
        const who = (r.audience || "all") === "individual" ? `${(r.targetIds || []).length} learner(s)` : "Whole class";
        return `<div class="lib-row">
          <span class="lib-ic">${icon(t.icon)}</span>
          <div class="lib-main"><div class="lib-title">${esc(r.title)}</div>
            <div class="lib-sub">${t.label} · ${who}${r.fileName ? " · " + esc(r.fileName) : ""}</div></div>
          <button class="btn btn-outline btn-xs" data-res-open="${r.id}">${icon("externalLink")} Open</button>
          <button class="icon-btn danger" data-res-unshare="${r.id}" title="Remove from class">${icon("trash")}</button>
        </div>`;
      })
      .join("")}
  </div>`;
}

/* Plan & Assign — one flow: plan a lesson/assignment/quiz at the top, then it
   drops into the list below where you start a session to publish it live. */
function coachAssignments(list, learners, cls, classes) {
  const editing = coachState.editAssignId ? list.find((a) => a.id === coachState.editAssignId) : null;
  const showForm = coachState.openForm || !!editing;
  return `
    <div class="panel">
      <div class="panel-head-row">
        <div>
          <h2>${icon("clipboard")} Plan &amp; assign</h2>
          <p class="panel-sub" style="margin:0">Plan a <strong>lesson</strong>, <strong>assignment</strong>, or <strong>quiz</strong>, then start its session to publish it live to learners. Tap a row to preview, or use edit &amp; delete. MCQ tests live in <strong>Assessments</strong>.</p>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn btn-outline" data-share-resource-toggle>${icon("library")} ${coachState.openResourceForm ? "Close" : "Share resource"}</button>
          <button class="btn btn-primary" data-new-assign-toggle>${icon("plus")} ${showForm ? "Close planner" : "Plan work"}</button>
        </div>
      </div>
      ${coachState.openResourceForm ? shareResourceForm(cls, classes) : ""}
      ${sharedResourceList(cls)}
      ${showForm ? planForm(cls, classes, editing) : ""}
      <div class="assign-list">${
        list.length
          ? list
              .map(
                (a) => `<div class="assign-item">${assignmentRow(a, true)}${sessionBar(a, cls)}</div>`
              )
              .join("")
          : `<div class="empty-state">Nothing planned yet. Click <strong>Plan work</strong> to create a lesson, assignment, or quiz — it'll appear here, ready to publish.</div>`
      }</div>
    </div>`;
}

/* session state on an assignment: planned | active | ended (default planned) */
const sessionOf = (a) => a.session || "planned";

/* the start/end session control + live status shown under each assignment
   in the Assignments tab. An active session is accessible to learners. */
function sessionBar(a, cls) {
  const state = sessionOf(a);
  const audience =
    a.results.length >= cls.learners.length && cls.learners.length
      ? "Whole class"
      : `${a.results.length} learner${a.results.length === 1 ? "" : "s"}`;
  const badge =
    state === "active"
      ? `<span class="session-badge live">${icon("radio")} Live · learners can join</span>`
      : state === "ended"
      ? `<span class="session-badge ended">Session ended</span>`
      : `<span class="session-badge planned">Planned · not yet live</span>`;
  const btn =
    state === "active"
      ? `<button class="btn btn-outline btn-xs session-end" data-session-toggle="${a.id}">${icon("stop")} End session</button>`
      : `<button class="btn btn-primary btn-xs" data-session-toggle="${a.id}">${icon("play")} ${state === "ended" ? "Restart" : "Start"} session</button>`;
  return `<div class="session-bar">
    <span class="session-audience">${icon("users")} ${audience}</span>
    ${badge}
    <span class="assign-actions">
      <button class="icon-btn" data-assign-preview="${a.id}" title="Preview">${icon("eye")}</button>
      <button class="icon-btn" data-assign-edit="${a.id}" title="Edit">${icon("pen")}</button>
      <button class="icon-btn danger" data-assign-delete="${a.id}" title="Delete">${icon("trash")}</button>
      ${btn}
    </span>
  </div>`;
}

/* preview modal for a planned lesson/assignment/quiz */
function openAssignPreview(classId, assignId) {
  const cls = read(K_CLASSES, []).find((c) => c.id === classId);
  const a = cls?.assignments.find((x) => x.id === assignId);
  if (!a) return;
  const t = ASSIGN_TYPES[a.type] || ASSIGN_TYPES.lesson;
  const comp = assignmentCompletion(a);
  const cnt = statusCounts(a);
  const whole = a.results.length >= cls.learners.length && cls.learners.length;
  const state = sessionOf(a);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div style="display:flex;align-items:center;gap:.7rem">
          <span class="assign-badge" style="background:${t.color}">${icon(t.icon)}</span>
          <div><h2>${esc(a.title)}</h2>
            <p class="panel-sub" style="margin:0">${t.label} · ${esc(cls.name)}</p></div>
        </div>
        <button class="icon-btn" data-modal-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="prev-grid">
          <div><span class="prev-k">Type</span><span class="prev-v">${t.label}</span></div>
          <div><span class="prev-k">Detail</span><span class="prev-v">${esc(a.detail || "—")}</span></div>
          <div><span class="prev-k">Due</span><span class="prev-v">${esc(a.due || "—")}</span></div>
          <div><span class="prev-k">Audience</span><span class="prev-v">${whole ? "Whole class" : a.results.length + " learner(s)"}</span></div>
          <div><span class="prev-k">Session</span><span class="prev-v">${state === "active" ? "Live now" : state === "ended" ? "Ended" : "Planned"}</span></div>
          <div><span class="prev-k">Class completion</span><span class="prev-v">${comp}%</span></div>
        </div>
        <div class="hbar-track" style="margin-top:1rem"><div class="hbar-fill" style="width:${comp}%;background:var(--primary)"></div></div>
        <div class="dist-legend" style="margin-top:1rem">
          <span><span class="dot done"></span> Completed · <strong>${cnt.completed}</strong></span>
          <span><span class="dot prog"></span> In progress · <strong>${cnt.in_progress}</strong></span>
          <span><span class="dot none"></span> Not started · <strong>${cnt.not_started}</strong></span>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" data-modal-close>Close preview</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll("[data-modal-close]").forEach((b) => b.addEventListener("click", close));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

function coachLearnersList(list, learners, cls) {
  const rows = learners
    .map((l) => {
      const overall = learnerOverall(list, l.id);
      return `<div class="ut-row" data-learner-open="${l.id}" style="grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) auto auto auto">
        <div class="ut-cell ut-user">
          <span class="avatar-sm">${esc(l.name.slice(0, 1))}</span>
          <div><div class="ut-name">${esc(l.name)}${l.account ? ' <span class="ut-you">account</span>' : ""}</div>
            <div class="ut-sub">Active ${esc(l.active)}</div></div>
        </div>
        <div class="ut-cell"><div class="hbar-track"><div class="hbar-fill" style="width:${overall}%;background:var(--primary)"></div></div></div>
        <div class="ut-cell"><span class="pill ${scoreClass(overall)}">${overall}%</span></div>
        <div class="ut-cell"><span class="pill ${overall >= 70 ? "synced" : "danger-pill"}">${overall >= 70 ? "On track" : "At risk"}</span></div>
        <div class="ut-cell ut-actions">
          ${l.account ? `<button class="icon-btn" data-enter-account="${l.id}" title="Enter this learner's account to help">${icon("login")}</button>` : ""}
          <button class="icon-btn danger" data-learner-remove="${l.id}" title="Remove from class">${icon("trash")}</button>
        </div>
      </div>`;
    })
    .join("");

  const accounts = enrollableUsers(cls);
  const accountOpts =
    `<option value="" selected>— pick a registered learner account —</option>` +
    accounts
      .map((u) => `<option value="${u.id}">${esc(u.fullName || u.username)} (${esc(u.username || u.email || "account")})</option>`)
      .join("");

  return `
    <div class="panel">
      <div class="panel-head-row">
        <div>
          <h2>${esc(cls.name)} · learners</h2>
          <p class="panel-sub" style="margin:0">${learners.length} enrolled · tap a learner for their detail</p>
        </div>
        <button class="btn btn-primary" data-add-learner-toggle>${icon("plus")} Add learner</button>
      </div>

      <form id="addLearnerForm" class="add-user-form" ${coachState.openLearnerForm ? "" : "hidden"}>
        <div class="form-row">
          <div class="field"><label>Enroll a portal account</label>
            <select class="select" name="userId">${accountOpts}</select>
            <p class="hint">${accounts.length ? `${accounts.length} learner account${accounts.length === 1 ? "" : "s"} available to enroll.` : "No unenrolled learner accounts — add by name(s) instead."}</p></div>
          <div class="field"><label>…or add one by name</label>
            <input class="input" name="name" maxlength="60" placeholder="e.g. Amina Hassan">
            <p class="hint">Creates a roster entry without a portal account.</p></div>
        </div>
        <div class="field">
          <label>${icon("list")} …or add many at once (bulk)</label>
          <textarea class="input" name="bulk" rows="4" placeholder="Paste one learner per line, e.g.&#10;Amina Hassan&#10;Brian Kimani&#10;Catherine Auma"></textarea>
          <p class="hint">One name per line (commas or semicolons also work). Duplicates are skipped automatically.</p>
        </div>
        <div class="add-user-actions">
          <button class="btn btn-primary" type="submit">${icon("plus")} Add to ${esc(cls.name)}</button>
          <button class="btn btn-outline" type="button" data-add-learner-cancel>Cancel</button>
        </div>
      </form>

      ${learners.length
        ? `<div class="user-table">
            <div class="ut-row ut-head" style="grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) auto auto auto">
              <div class="ut-cell">Learner</div><div class="ut-cell">Overall completion</div>
              <div class="ut-cell">Completion</div><div class="ut-cell">Status</div><div class="ut-cell"></div>
            </div>
            <div>${rows}</div>
          </div>`
        : `<div class="empty-state">No learners in this class yet.<br>Enroll a registered account or add one by name above.</div>`}
    </div>`;
}

function coachLearnerDetail(list, learners, id, cls) {
  const l = learners.find((x) => x.id === id);
  if (!l) return coachLearnersList(list, learners, cls);
  const overall = learnerOverall(list, id);
  const score = learnerAvgScore(list, id);
  const mine = list.filter((a) => a.results.some((r) => r.id === id));

  const rows = mine
    .map((a) => {
      const r = a.results.find((x) => x.id === id);
      const st = statusOf(r.pct);
      const t = ASSIGN_TYPES[a.type];
      return `<div class="assign-row">
        ${typeBadge(a.type)}
        <div class="assign-main">
          <div class="assign-title">${esc(a.title)}</div>
          <div class="assign-meta">${t.label} · ${esc(a.detail)}</div>
        </div>
        <div class="assign-prog">
          <div class="hbar-track"><div class="hbar-fill" style="width:${r.pct}%;background:var(--primary)"></div></div>
          <span class="assign-pct">${r.pct}%</span>
        </div>
        ${typeof r.score === "number" && r.pct >= 100
          ? `<span class="pill ${scoreClass(r.score)}">${r.score}%</span>`
          : `<span class="pill status-${st}">${st === "in_progress" ? "In progress" : st === "not_started" ? "Not started" : "Done"}</span>`}
      </div>`;
    })
    .join("");

  return `
    <div class="panel">
      <button class="btn btn-ghost btn-xs" data-learner-back style="margin-bottom:1rem">${icon("arrowLeft")} All learners</button>
      <div class="learner-head">
        <span class="avatar-sm" style="width:52px;height:52px;font-size:1.2rem">${esc(l.name.slice(0, 1))}</span>
        <div>
          <h2 style="margin:0">${esc(l.name)}</h2>
          <p class="panel-sub" style="margin:0">Last active ${esc(l.active)} · ${mine.length} assignments</p>
        </div>
      </div>
      <div class="stat-row" style="margin:1.25rem 0">
        <div class="stat-tile"><div class="st-label">${icon("check")} Overall completion</div><div class="st-num">${countNum(overall, "%")}</div></div>
        <div class="stat-tile"><div class="st-label">${icon("trophy")} Average score</div><div class="st-num">${score === null ? "—" : countNum(score, "%")}</div></div>
        <div class="stat-tile"><div class="st-label">${icon("clipboard")} Assignments</div><div class="st-num">${countNum(mine.length)}</div></div>
      </div>
      <h3 style="margin-bottom:.75rem">Progress by assignment</h3>
      <div class="assign-list">${rows}</div>
    </div>`;
}

/* ============================================================
   Assessments — teacher-built MCQ, auto-marked, analyzed
   ============================================================ */

const OPT_LETTERS = ["A", "B", "C", "D", "E", "F"];

function assessStats(a) {
  const subs = a.submissions || [];
  const pcts = subs.map((s) => s.pct);
  const avg = pcts.length ? Math.round(pcts.reduce((x, y) => x + y, 0) / pcts.length) : 0;
  const passed = subs.filter((s) => s.pct >= 50).length;
  return {
    subs: subs.length,
    avg,
    passRate: subs.length ? Math.round((passed / subs.length) * 100) : 0,
    high: pcts.length ? Math.max(...pcts) : 0,
    low: pcts.length ? Math.min(...pcts) : 0,
  };
}

/* % of submissions that answered each question correctly (item analysis) */
function questionCorrectPct(a) {
  const subs = a.submissions || [];
  return a.questions.map((q, qi) => {
    if (!subs.length) return 0;
    const right = subs.filter((s) => s.answers[qi] === q.correct).length;
    return Math.round((right / subs.length) * 100);
  });
}

/* one editable question in the builder (radios scoped by unique group name) */
function questionBlock(n, group) {
  const opts = OPT_LETTERS.slice(0, 4)
    .map(
      (L, oi) => `<label class="qopt">
        <input type="radio" name="${group}" data-correct value="${oi}" ${oi === 0 ? "checked" : ""}>
        <input class="input" data-opt maxlength="120" placeholder="Option ${L}">
      </label>`
    )
    .join("");
  return `<div class="qblock" data-qblock>
    <div class="qblock-head">
      <span class="qnum">Question <span data-qn>${n}</span></span>
      <button type="button" class="icon-btn danger" data-remove-q title="Remove question">${icon("trash")}</button>
    </div>
    <input class="input" data-qtext maxlength="240" placeholder="Type the question…">
    <div class="qoptions">${opts}</div>
    <p class="hint">Tick the circle next to the correct answer — the system marks against it.</p>
  </div>`;
}

function assessBuilder(cls) {
  return `
    <form id="assessForm" class="add-user-form" ${coachState.openAssessForm ? "" : "hidden"}>
      <div class="field"><label>Assessment title</label>
        <input class="input" name="title" required maxlength="80" placeholder="e.g. Fractions Test 1"></div>
      <div id="assessQuestions">${questionBlock(1, "correct-q0")}</div>
      <button type="button" class="btn btn-outline btn-xs" data-add-question style="margin-bottom:1rem">${icon("plus")} Add question</button>
      <div class="add-user-actions">
        <button class="btn btn-primary" type="submit">${icon("check")} Save assessment</button>
        <button class="btn btn-outline" type="button" data-assess-cancel>Cancel</button>
      </div>
    </form>`;
}

/* score-distribution buckets + item analysis + per-student table */
function assessmentAnalytics(a, cls) {
  const subs = a.submissions || [];
  if (!subs.length)
    return `<div class="empty-state">No submissions yet. Publish it so learners can take it, or use “Simulate” to preview the analytics.</div>`;

  const st = assessStats(a);
  const tiles = `<div class="stat-row" style="margin:1rem 0">
    <div class="stat-tile"><div class="st-label">${icon("inbox")} Submissions</div><div class="st-num">${countNum(st.subs)}</div></div>
    <div class="stat-tile"><div class="st-label">${icon("trophy")} Average</div><div class="st-num">${countNum(st.avg, "%")}</div></div>
    <div class="stat-tile"><div class="st-label">${icon("check")} Pass rate</div><div class="st-num">${countNum(st.passRate, "%")}</div></div>
    <div class="stat-tile"><div class="st-label">${icon("trendingUp")} Highest</div><div class="st-num">${countNum(st.high, "%")}</div></div>
  </div>`;

  // score distribution across four bands
  const bands = [
    { label: "0–49", lo: 0, hi: 49 },
    { label: "50–69", lo: 50, hi: 69 },
    { label: "70–84", lo: 70, hi: 84 },
    { label: "85–100", lo: 85, hi: 100 },
  ];
  const dist = bands.map((b) => subs.filter((s) => s.pct >= b.lo && s.pct <= b.hi).length);
  const distChart = barChart(dist, bands.map((b) => b.label), " learners");

  // per-question item analysis (lower % = harder)
  const pcts = questionCorrectPct(a);
  const hardestIdx = pcts.indexOf(Math.min(...pcts));
  const items = a.questions
    .map((q, qi) => {
      const p = pcts[qi];
      const color = p >= 75 ? "var(--success)" : p >= 50 ? "oklch(78% 0.15 75)" : "var(--destructive)";
      return hbar(`Q${qi + 1}. ${q.text}`, p, 100, color, "%");
    })
    .join("");

  // per-student results
  const rows = subs
    .slice()
    .sort((x, y) => y.pct - x.pct)
    .map(
      (s) => `<div class="ut-row" style="grid-template-columns:minmax(0,1.4fr) auto auto auto">
        <div class="ut-cell ut-user">
          <span class="avatar-sm">${esc(s.name.slice(0, 1))}</span>
          <div><div class="ut-name">${esc(s.name)}</div><div class="ut-sub">${s.correct}/${s.total} correct</div></div>
        </div>
        <div class="ut-cell"><div class="hbar-track"><div class="hbar-fill" style="width:${s.pct}%;background:var(--primary)"></div></div></div>
        <div class="ut-cell"><span class="pill ${scoreClass(s.pct)}">${s.pct}%</span></div>
        <div class="ut-cell"><span class="pill ${s.pct >= 50 ? "synced" : "danger-pill"}">${s.pct >= 50 ? "Pass" : "Fail"}</span></div>
      </div>`
    )
    .join("");

  return `
    <div class="assess-analytics">
      ${tiles}
      <div class="dash-grid">
        <div class="panel">
          <h2>Score distribution</h2>
          <p class="panel-sub">How many learners fall in each band</p>
          ${distChart}
        </div>
        <div class="panel">
          <h2>Question difficulty</h2>
          <p class="panel-sub">% who answered each question correctly · hardest: <strong>Q${hardestIdx + 1}</strong></p>
          <div class="legend">${items}</div>
        </div>
      </div>
      <div class="panel" style="margin-top:1.5rem">
        <div class="panel-head-row">
          <div><h2>Per-student results</h2><p class="panel-sub" style="margin:0">Auto-marked · sorted by score</p></div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap">
            <button class="btn btn-outline btn-xs" data-assess-csv="${a.id}">${icon("download")} CSV</button>
            <button class="btn btn-outline btn-xs" data-assess-xls="${a.id}">${icon("download")} Excel</button>
            <button class="btn btn-outline btn-xs" data-assess-pdf="${a.id}">${icon("download")} PDF</button>
          </div>
        </div>
        <div class="user-table">
          <div class="ut-row ut-head" style="grid-template-columns:minmax(0,1.4fr) auto auto auto">
            <div class="ut-cell">Student</div><div class="ut-cell">Score</div>
            <div class="ut-cell">Percent</div><div class="ut-cell">Result</div>
          </div>
          <div>${rows}</div>
        </div>
      </div>
    </div>`;
}

/* learners of a class, either as checkboxes (individual) or read-only chips
   (whole class) — so the teacher always sees exactly who will receive it */
function rosterHtml(learners, audience, targetIds = []) {
  if (!learners.length) return `<span class="hint">This grade/class has no learners yet.</span>`;
  if (audience === "individual")
    return learners
      .map(
        (l) => `<label class="lchk"><input type="checkbox" name="ptarget" value="${l.id}" ${targetIds.includes(l.id) ? "checked" : ""}> ${esc(l.name)}</label>`
      )
      .join("");
  return learners.map((l) => `<span class="roster-chip">${icon("graduation")} ${esc(l.name)}</span>`).join("");
}

/* the publish dialog: pick School → Grade/class (filtered), then the system
   auto-lists the learners of that school+grade; audience whole-class or individual */
function publishPanel(a, cls, classes) {
  const schools = [...new Set(classes.map((c) => c.school))];
  const school = cls.school;
  const schoolOpts = schools.map((s) => `<option ${s === school ? "selected" : ""}>${esc(s)}</option>`).join("");
  const grades = classes.filter((c) => c.school === school);
  const gradeOpts = grades
    .map((c) => `<option value="${c.id}" ${c.id === cls.id ? "selected" : ""}>${esc(c.name)} (${c.learners.length})</option>`)
    .join("");
  const audience = a.audience || "all";
  const targetIds = a.targetIds || [];
  const allChecked = audience === "individual" && cls.learners.length && cls.learners.every((l) => targetIds.includes(l.id));
  return `
    <form class="add-user-form publish-form" data-publish-form="${a.id}">
      <div class="form-row">
        <div class="field"><label>School</label>
          <select class="select" name="school" data-publish-school>${schoolOpts}</select></div>
        <div class="field"><label>Grade / class</label>
          <select class="select" name="classId" data-publish-class>${gradeOpts}</select></div>
      </div>
      <div class="field"><label>Audience</label>
        <select class="select" name="audience" data-publish-audience>
          <option value="all" ${audience === "all" ? "selected" : ""}>Whole class — all students</option>
          <option value="individual" ${audience === "individual" ? "selected" : ""}>Individual learner(s)</option>
        </select></div>
      <div class="field" data-publish-picker>
        <div class="picker-head">
          <label style="margin-bottom:0">Learners in <span data-roster-name>${esc(cls.name)}</span><span class="hint" data-roster-count> · ${cls.learners.length} enrolled</span></label>
          <label class="lchk select-all-chk" data-selectall-wrap style="${audience === "individual" ? "" : "display:none"}"><input type="checkbox" data-publish-select-all ${allChecked ? "checked" : ""}> Select all</label>
        </div>
        <div class="assign-learners" data-publish-learners>${rosterHtml(cls.learners, audience, targetIds)}</div>
      </div>
      <div class="add-user-actions">
        <button class="btn btn-primary" type="submit">${icon("send")} ${a.published ? "Update & re-publish" : "Publish now"}</button>
        <button class="btn btn-outline" type="button" data-publish-cancel>Cancel</button>
      </div>
    </form>`;
}

function assessCard(a, cls, classes) {
  const st = assessStats(a);
  const published = !!a.published;
  const audience = a.audience || "all";
  const state = a.session || "planned";
  const analyzing = coachState.analyzeId === a.id;
  const publishing = coachState.publishId === a.id;

  const statusBadge = !published
    ? `<span class="session-badge planned">${icon("clipboard")} Draft — not published</span>`
    : state === "active"
    ? `<span class="session-badge live">${icon("radio")} Live · ${audience === "individual" ? `${(a.targetIds || []).length} learner(s)` : "whole class"}</span>`
    : state === "ended"
    ? `<span class="session-badge ended">Published · session ended</span>`
    : `<span class="session-badge planned">Published · paused</span>`;

  const targetLine = !published
    ? "Not published yet — publish to a grade/class or specific learners."
    : audience === "individual"
    ? `Published to ${(a.targetIds || []).length} learner(s) in ${esc(cls.name)}`
    : `Published to ${esc(cls.name)} · whole class`;

  const publishBtn = `<button class="btn ${published ? "btn-outline" : "btn-primary"} btn-xs" data-publish-toggle="${a.id}">${icon("send")} ${published ? "Edit audience" : "Publish"}</button>`;
  const sessionBtn = !published
    ? ""
    : state === "active"
    ? `<button class="btn btn-outline btn-xs session-end" data-assess-session="${a.id}">${icon("stop")} End session</button>`
    : `<button class="btn btn-primary btn-xs" data-assess-session="${a.id}">${icon("play")} ${state === "ended" ? "Restart" : "Resume"} session</button>`;

  return `
    <div class="panel" style="margin-top:1.5rem">
      <div class="panel-head-row">
        <div>
          <h2>${icon("clipboard")} ${esc(a.title)}</h2>
          <p class="panel-sub" style="margin:0">${a.questions.length} question${a.questions.length === 1 ? "" : "s"} · ${st.subs} submission${st.subs === 1 ? "" : "s"} · avg <strong>${st.avg}%</strong> · pass rate ${st.passRate}%</p>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
          <button class="btn ${analyzing ? "btn-primary" : "btn-outline"} btn-xs" data-analyze="${a.id}">${icon("chartColumn")} ${analyzing ? "Hide analysis" : "Analyze"}</button>
          <button class="icon-btn danger" data-remove-assess="${a.id}" title="Delete assessment">${icon("trash")}</button>
        </div>
      </div>
      <div class="session-bar">
        ${statusBadge}
        <span class="session-audience">${targetLine}</span>
        <button class="btn btn-outline btn-xs" data-sim-assess="${a.id}" title="Generate demo submissions">${icon("activity")} Simulate</button>
        ${publishBtn}
        ${sessionBtn}
      </div>
      ${publishing ? publishPanel(a, cls, classes) : ""}
      ${analyzing ? assessmentAnalytics(a, cls) : ""}
    </div>`;
}

function coachAssessments(cls, classes) {
  const list = cls.assessments || [];
  return `
    <div class="panel">
      <div class="panel-head-row">
        <div>
          <h2>Assessments — ${esc(cls.name)}</h2>
          <p class="panel-sub" style="margin:0">Build multiple-choice tests, publish to a grade/class or individuals — auto-marked, analyzed, and exportable</p>
        </div>
        <button class="btn btn-primary" data-new-assess-toggle>${icon("plus")} New assessment</button>
      </div>
      ${assessBuilder(cls)}
      ${list.length ? "" : `<div class="empty-state">No assessments yet. Create one with multiple-choice questions and mark the correct answers — then publish it to your class or specific learners.</div>`}
    </div>
    ${list.map((a) => assessCard(a, cls, classes)).join("")}`;
}

/* rows for assessment exports: header + one row per submission */
function buildAssessmentRows(a) {
  const header = ["Student", "Score", "Total", "Percent %", "Result", ...a.questions.map((q, i) => `Q${i + 1}`)];
  const rows = (a.submissions || []).map((s) => [
    s.name,
    String(s.correct),
    String(s.total),
    String(s.pct),
    s.pct >= 50 ? "Pass" : "Fail",
    ...a.questions.map((q, qi) => (s.answers[qi] === q.correct ? "correct" : "wrong")),
  ]);
  return { header, rows };
}

/* fabricate plausible submissions for enrolled learners (demo aid) */
function simulateAssessment(a, cls) {
  const done = new Set((a.submissions || []).map((s) => s.learnerId));
  cls.learners
    .filter((l) => !done.has(l.id))
    .forEach((l) => {
      // ~68% chance of the correct answer per question
      const answers = a.questions.map((q) =>
        Math.random() < 0.68 ? q.correct : Math.floor(Math.random() * q.options.length)
      );
      const correct = a.questions.reduce((n, q, i) => n + (answers[i] === q.correct ? 1 : 0), 0);
      a.submissions.push({
        learnerId: l.id, name: l.name, answers, correct, total: a.questions.length,
        pct: Math.round((correct / a.questions.length) * 100), at: Date.now(),
      });
    });
}

/* Attendance (patch-18) — mark present/absent/late/excused per learner for
   one day at a time. RLS already limits a write to this coach's own class
   roster (verified against the live database before this shipped), so
   nothing here re-implements that check client-side.

   Only learners with a REAL learners.id can be marked: a roster entry
   added before this feature existed (or enrolled via a portal account,
   which links by name only, not a learners row) has no valid id for
   attendance_records.learner_id to reference — l.id falls back to the
   enrollment's own id in that case (see loadClasses()), which is exactly
   what distinguishes the two: a genuine learner record's id never equals
   its own _enrollmentId. */
const ATTENDANCE_STATUSES = [
  { id: "present", label: "Present", icon: "check" },
  { id: "late", label: "Late", icon: "clock" },
  { id: "absent", label: "Absent", icon: "alert" },
  { id: "excused", label: "Excused", icon: "info" },
];

function attendancePanel(cls) {
  const today = new Date().toISOString().slice(0, 10);
  const head = `
    <div class="panel-head-row">
      <div>
        <h2>${icon("check")} Attendance</h2>
        <p class="panel-sub" style="margin-bottom:0">Mark who was here for ${esc(cls.name)}, one day at a time</p>
      </div>
      <div class="field" style="margin:0"><label style="margin-bottom:.2rem">Session date</label>
        <input class="input" type="date" data-attendance-date value="${esc(attendanceDate)}" max="${today}"></div>
    </div>`;

  const wrap = (inner) => `<div class="panel" style="margin-top:1.5rem" data-attendance-panel>${head}${inner}</div>`;

  if (attendanceLoadedForClassId !== cls.id) return wrap(`<div class="empty-state">Loading attendance…</div>`);
  if (attendanceError) {
    return wrap(`<div class="empty-state">Could not load attendance — ${esc(attendanceError)}
      <div style="margin-top:.6rem"><button class="btn btn-outline btn-xs" data-attendance-retry>${icon("refresh")} Try again</button></div>
    </div>`);
  }
  if (!cls.learners.length) {
    return wrap(`<div class="empty-state">No learners enrolled in ${esc(cls.name)} yet — add some from the Learners tab first.</div>`);
  }

  const byLearner = new Map(
    attendanceCache.filter((a) => a.session_date === attendanceDate).map((a) => [a.learner_id, a.status])
  );

  const rows = cls.learners.map((l) => {
    const trackable = l.id !== l._enrollmentId; // see header comment
    if (!trackable) {
      return `<div class="submission">
        <span class="avatar-sm">${esc((l.name || "L").slice(0, 1).toUpperCase())}</span>
        <div style="flex:1;min-width:0"><div class="s-title">${esc(l.name)}</div>
          <div class="s-meta">Not trackable yet — remove and re-add this learner to enable attendance.</div></div>
      </div>`;
    }
    const current = byLearner.get(l.id);
    return `<div class="submission">
      <span class="avatar-sm">${esc((l.name || "L").slice(0, 1).toUpperCase())}</span>
      <div style="flex:1;min-width:0"><div class="s-title">${esc(l.name)}</div></div>
      <div style="display:flex;gap:.35rem;flex-wrap:wrap" data-attendance-row="${esc(l.id)}">
        ${ATTENDANCE_STATUSES.map((s) => `
          <button type="button" class="btn btn-xs ${current === s.id ? "btn-primary" : "btn-outline"}"
            data-attendance-mark="${s.id}" data-learner-id="${esc(l.id)}">${icon(s.icon)} ${s.label}</button>
        `).join("")}
      </div>
    </div>`;
  }).join("");

  return wrap(rows);
}

/* People — school-scoped list of teachers & learners the teacher may edit,
   filterable by grade, collapsible to save space */
function coachPeople(cls, scoped) {
  const school = coachSchool();
  const allUsers = read(K_USERS, []);
  const schoolUsers = allUsers.filter((u) => (!school || u.school === school) && (u.role === "teacher" || u.role === "learner"));
  const grade = coachState.peopleGrade || "all";
  const gradeClass = scoped.find((c) => c.id === grade);

  const teachers = schoolUsers.filter((u) => u.role === "teacher");
  let learners = schoolUsers.filter((u) => u.role === "learner");
  if (gradeClass) learners = learners.filter((u) => gradeClass.learners.some((l) => l.id === u.id));

  const gradeOpts =
    `<option value="all" ${grade === "all" ? "selected" : ""}>All grades</option>` +
    scoped.map((c) => `<option value="${c.id}" ${c.id === grade ? "selected" : ""}>${esc(c.name)} (${c.learners.length})</option>`).join("");

  const row = (u) => {
    const pw = u.password || "";
    return `<div class="utx-row utx-people">
      <div class="utx-cell utx-user"><span class="avatar-sm">${esc((u.fullName || u.username || "U").slice(0, 1).toUpperCase())}</span>
        <div class="utx-name">${esc(u.fullName || "—")}</div></div>
      <div class="utx-cell">${esc(u.username || "—")}</div>
      <div class="utx-cell utx-pw"><span data-pw="${esc(pw)}" class="pw-mask">${pw ? "••••••••" : "—"}</span>
        ${pw ? `<button class="icon-btn pw-eye" data-tpw-toggle title="Show/hide">${icon("eye")}</button>` : ""}</div>
      <div class="utx-cell utx-actions"><button class="icon-btn" data-tedit-user="${u.id}" title="Edit">${icon("pen")}</button></div>
    </div>`;
  };
  const table = (label, arr) => arr.length
    ? `<h3 class="la-head" style="margin-top:1.25rem">${label} · ${arr.length}</h3>
       <div class="utx-scroll"><div class="utx-table utx-narrow">
         <div class="utx-row utx-people utx-head"><div class="utx-cell">Name</div><div class="utx-cell">Username</div><div class="utx-cell">Password</div><div class="utx-cell"></div></div>
         ${arr.map(row).join("")}
       </div></div>`
    : "";

  return `
    <div class="panel">
      <div class="panel-head-row">
        <div><h2>${icon("users")} People — ${esc(school || "all schools")}</h2>
          <p class="panel-sub" style="margin:0">Teachers &amp; learners in your school · edit name, username &amp; password</p></div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
          <select class="select select-sm" data-people-grade aria-label="Filter by grade">${gradeOpts}</select>
          <button class="btn btn-outline btn-xs" data-people-enroll>${icon("userPlus")} Enroll learner</button>
          <button class="btn btn-outline btn-xs" data-people-toggle>${icon(coachState.peopleOpen ? "arrowUpRight" : "list")} ${coachState.peopleOpen ? "Collapse" : "Show list"}</button>
        </div>
      </div>
      <div class="la-summary"><span class="la-chip">${teachers.length} Teachers</span><span class="la-chip">${learners.length} Learners${gradeClass ? " in " + esc(gradeClass.name) : ""}</span></div>
      ${coachState.peopleOpen
        ? `${table(icon("users") + " Teachers", teachers)}${table(icon("graduation") + " Learners", learners)}${!teachers.length && !learners.length ? `<div class="empty-state">No users in this school yet.</div>` : ""}`
        : ""}
    </div>
    ${coachState.editUserId ? teacherEditUserModal(allUsers.find((u) => u.id === coachState.editUserId)) : ""}`;
}

function teacherEditUserModal(u) {
  if (!u) return "";
  return `
    <div class="modal-overlay" data-tedit-overlay>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>Edit ${esc(ROLE_LABEL[u.role] || u.role)}</h2><p class="panel-sub" style="margin:0">${esc(u.fullName || u.username || "")}</p></div>
          <button class="icon-btn" data-tedit-close aria-label="Close">✕</button>
        </div>
        <form id="tEditForm" class="modal-body" data-uid="${u.id}">
          <div class="field"><label>Full name</label><input class="input" name="fullName" value="${esc(u.fullName || "")}" required></div>
          <div class="field"><label>Username</label><input class="input" name="username" value="${esc(u.username || "")}"></div>
          <div class="field"><label>Password</label>
            <div class="pw-edit"><input class="input" name="password" type="password" value="${esc(u.password || "")}" minlength="6">
              <button class="btn btn-outline btn-xs" type="button" data-teditpw-toggle>${icon("eye")} Show</button></div></div>
        </form>
        <div class="modal-foot"><button class="btn btn-primary" data-tedit-save>${icon("check")} Save</button><button class="btn btn-outline" data-tedit-close>Cancel</button></div>
      </div>
    </div>`;
}

function classSwitcher(classes, cls) {
  const chips = classes
    .map(
      (c) =>
        `<button class="kchip ${cls && c.id === cls.id ? "active" : ""}" data-class-switch="${c.id}">
          ${icon("graduation")} ${esc(c.name)} <span class="kchip-count">${c.learners.length}</span>
        </button>`
    )
    .join("");
  // a scoped teacher can only create classes in their own school
  const locked = coachSchool();
  const schoolField = locked
    ? `<div class="field"><label>School</label>
         <input class="input" value="${esc(locked)}" disabled>
         <input type="hidden" name="school" value="${esc(locked)}"></div>`
    : `<div class="field"><label>School (HPF-supported)</label>
         <select class="select" name="school" required>
           <option value="" disabled selected>Select your school</option>
           ${SCHOOLS.map((s) => `<option>${esc(s)}</option>`).join("")}
         </select></div>`;
  return `
    <div class="kchips" style="margin-bottom:1rem">
      ${chips}
      <button class="kchip kchip-add" data-new-class-toggle>${icon("plus")} New class</button>
    </div>
    <form id="newClassForm" class="add-user-form" ${coachState.openClassForm ? "" : "hidden"}>
      <div class="form-row">
        <div class="field"><label>Class / grade name</label>
          <input class="input" name="name" required maxlength="60" placeholder="e.g. Grade 4 — Red"></div>
        ${schoolField}
      </div>
      <div class="add-user-actions">
        <button class="btn btn-primary" type="submit">${icon("plus")} Create class</button>
        <button class="btn btn-outline" type="button" data-class-cancel>Cancel</button>
      </div>
    </form>`;
}

function teacherBody() {
  const { scoped, cls } = currentClass();
  const school = coachSchool();

  // a scoped teacher with no class yet in their school
  if (!cls) {
    const head = `
      <div class="panel-head-row" style="margin-bottom:1rem">
        <div>
          <h2 style="font-size:1.15rem">Coach</h2>
          <p class="panel-sub" style="margin:0">${icon("school")} ${esc(school || "")}</p>
        </div>
      </div>
      ${classSwitcher(scoped, null)}`;

    // Loading, error and "no real database access" are three different
    // reasons the list can be empty, and a teacher acts differently on each
    // — waiting, retrying, or asking an admin to fix their account — so they
    // get three different messages rather than one generic empty state.
    if (!classesLoaded) {
      return `${head}<div class="panel"><div class="empty-state">Loading your classes…</div></div>`;
    }
    if (classesError) {
      return `${head}<div class="panel"><div class="empty-state">Could not load your classes — ${esc(classesError)}
        <div style="margin-top:.6rem"><button class="btn btn-outline btn-xs" data-classes-retry>${icon("refresh")} Try again</button></div>
      </div></div>`;
    }
    const dbNotice = !classesAuthed
      ? `<div class="notice" style="margin-bottom:1rem">${icon("info")}
          <span>This browser is signed in on a <strong>local account</strong>, which the HPF database has never seen.
          Any class created here stays on this device only — sign in with a real HPF account to save to the database.</span>
        </div>`
      : "";
    return `${head}${dbNotice}<div class="panel"><div class="empty-state">No classes yet for <strong>${esc(school || "your school")}</strong>.<br>Click <strong>New class</strong> above to create your first grade.</div></div>`;
  }

  const classes = scoped; // dropdowns & switcher only show this coach's school
  const list = cls.assignments;
  const learners = cls.learners;

  const classCompletion = avg(list.map(assignmentCompletion));
  const scored = list.map(assignmentAvgScore).filter((v) => v !== null);
  const classScore = scored.length ? avg(scored) : 0;

  const metricTiles = `<div class="stat-row">
    <div class="stat-tile"><div class="st-label">${icon("users")} Learners</div><div class="st-num">${countNum(learners.length)}</div></div>
    <div class="stat-tile"><div class="st-label">${icon("clipboard")} Assignments</div><div class="st-num">${countNum(list.length)}</div></div>
    <div class="stat-tile"><div class="st-label">${icon("check")} Avg completion</div><div class="st-num">${countNum(classCompletion, "%")}</div></div>
    <div class="stat-tile"><div class="st-label">${icon("trophy")} Class avg score</div><div class="st-num">${countNum(classScore, "%")}</div></div>
  </div>`;

  const tabBar = sideNav(
    [
      { id: "overview", label: "Overview", icon: "chartColumn" },
      { id: "assignments", label: "Plan & Assign", icon: "clipboard" },
      { id: "assessments", label: "Assessments", icon: "trophy" },
      { id: "learners", label: "Learners", icon: "graduation" },
      { id: "attendance", label: "Attendance", icon: "check" },
      { id: "people", label: "People", icon: "users" },
      { id: "results", label: "Results", icon: "chartColumn" },
    ],
    coachState.tab,
    "data-coach-tab"
  );

  // computed insights: at-risk learners, weakest assignment, top performer
  const atRisk = learners.filter((l) => learnerOverall(list, l.id) < 70);
  const weakestA = [...list].sort((a, b) => assignmentCompletion(a) - assignmentCompletion(b))[0];
  const top = [...learners].sort((a, b) => learnerOverall(list, b.id) - learnerOverall(list, a.id))[0];
  const smart = insights(
    !learners.length
      ? [{
          icon: "lightbulb", tone: "warn",
          html: `<strong>${esc(cls.name)}</strong> has no learners yet — open the <strong>Learners</strong> tab to enroll portal accounts or add names.`,
        }]
      : [
          atRisk.length
            ? {
                icon: "alert", tone: "bad",
                html: `<strong>${atRisk.length} learner${atRisk.length === 1 ? " is" : "s are"} at risk</strong> (below 70%): ${atRisk.map((l) => esc(l.name.split(" ")[0])).join(", ")} — check the Learners tab.`,
              }
            : { icon: "check", tone: "good", html: `<strong>No learners at risk</strong> — everyone is at 70% completion or better.` },
          weakestA && {
            icon: "clipboard", tone: assignmentCompletion(weakestA) < 50 ? "warn" : "",
            html: `“<strong>${esc(weakestA.title)}</strong>” has the lowest class completion (<strong>${assignmentCompletion(weakestA)}%</strong>) — consider a reminder or revision session.`,
          },
          top && {
            icon: "award", tone: "good",
            html: `<strong>${esc(top.name)}</strong> leads the class at <strong>${learnerOverall(list, top.id)}%</strong> overall completion.`,
          },
        ].filter(Boolean)
  );

  let content;
  if (coachState.tab === "assignments") content = coachAssignments(list, learners, cls, classes);
  else if (coachState.tab === "assessments") content = coachAssessments(cls, classes);
  else if (coachState.tab === "attendance") content = attendancePanel(cls);
  else if (coachState.tab === "people") content = coachPeople(cls, scoped);
  else if (coachState.tab === "results") content = coachResults(list, learners, cls);
  else if (coachState.tab === "learners")
    content = coachState.learnerId
      ? coachLearnerDetail(list, learners, coachState.learnerId, cls)
      : coachLearnersList(list, learners, cls);
  else content = coachOverview(list, learners, cls);

  return `
    <div class="panel-head-row" style="margin-bottom:1rem">
      <div>
        <h2 style="font-size:1.15rem">${esc(cls.name)} · Coach</h2>
        <p class="panel-sub" style="margin:0">${icon("school")} ${esc(cls.school || "")} — create classes, enroll learners, run sessions, and track results</p>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn btn-outline" data-coach-user-toggle>${icon("userPlus")} Add user</button>
        <button class="btn btn-primary" data-new-assign>${icon("plus")} Plan work</button>
      </div>
    </div>
    ${addUserForm(cls)}
    ${classSwitcher(classes, cls)}
    ${metricTiles}
    ${smart}
    <div class="dash-shell">
      ${tabBar}
      <div class="dash-main">${content}</div>
    </div>`;
}

/* add a user — pick Teacher or Learner, then role-specific fields + password.
   Hooks are coach-specific on purpose: the admin dashboard has its own Add user
   button and form, and when both used `data-add-user-toggle` / `#addUserForm`
   the coach's listeners — bound for every role by wireRoleActions — hijacked the
   admin's button and threw the admin into this workspace instead. */
function addUserForm(cls) {
  return `
    <form id="coachAddUserForm" class="add-user-form" ${coachState.openUserForm ? "" : "hidden"}>
      <div class="form-row">
        <div class="field"><label>Role</label>
          <select class="select" name="role" data-adduser-role>
            <option value="teacher">Teacher</option>
            <option value="learner">Learner</option>
          </select></div>
        <div class="field"><label>Full name</label>
          <input class="input" name="fullName" required maxlength="80" placeholder="e.g. Grace Achieng"></div>
      </div>
      <div class="form-row">
        <div class="field" data-adduser-email><label>Email</label>
          <input class="input" name="email" type="email" placeholder="teacher@example.org"></div>
        <div class="field" data-adduser-username hidden><label>Username</label>
          <input class="input" name="username" maxlength="40" placeholder="e.g. grace_a"></div>
        <div class="field"><label>Password</label>
          <input class="input" name="password" type="password" minlength="6" required placeholder="min. 6 characters"></div>
      </div>
      <div class="field" data-adduser-school><label>School (required for teachers)</label>
        <select class="select" name="school">
          <option value="" disabled ${SCHOOLS.includes(cls.school) ? "" : "selected"}>Select the school</option>
          ${SCHOOLS.map((s) => `<option ${s === cls.school ? "selected" : ""}>${esc(s)}</option>`).join("")}
        </select>
        <p class="hint" data-adduser-hint>Teachers sign in with email. Learners get a username and are enrolled in <strong>${esc(cls.name)}</strong>.</p>
      </div>
      <div class="add-user-actions">
        <button class="btn btn-primary" type="submit">${icon("userPlus")} Add user</button>
        <button class="btn btn-outline" type="button" data-coach-user-cancel>Cancel</button>
      </div>
    </form>`;
}

function fieldOfficerBody(ctx) {
  const userId = ctx?.user?.id;
  const myReports = getFieldReports().filter((r) => r.user_id === userId);
  const now = new Date(), day = 864e5;

  const visitsThisMonth = myReports.filter((r) => {
    const t = new Date(r.created_at);
    return t.getMonth() === now.getMonth() && t.getFullYear() === now.getFullYear();
  }).length;

  // last real visit per assigned school — the honest version of what the old
  // fake "health score" gestured at (which school needs attention next)
  const schoolRows = myFoSchoolsCache.map((name) => {
    const last = myReports
      .filter((r) => r.school === name)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    return { name, last };
  }).sort((a, b) => new Date(a.last?.created_at || 0) - new Date(b.last?.created_at || 0));
  const stalest = schoolRows[0];

  // last 7 days, real
  const trend = new Array(7).fill(0);
  myReports.forEach((r) => {
    const ago = Math.floor((now.getTime() - new Date(r.created_at).getTime()) / day);
    if (ago >= 0 && ago < 7) trend[6 - ago]++;
  });
  const trendLabels = trend.map((_, k) => DOW[new Date(now.getTime() - (6 - k) * day).getDay()]);

  const smart = insights([
    stalest && {
      icon: "alert", tone: stalest.last ? "warn" : "bad",
      html: stalest.last
        ? `<strong>${esc(stalest.name)}</strong> hasn't had a visit in the longest — last one was ${timeAgo(new Date(stalest.last.created_at).getTime())}.`
        : `<strong>${esc(stalest.name)}</strong> has no logged visit yet — it's the school most in need of a first one.`,
    },
    {
      icon: "clipboard", tone: "",
      html: `<strong>${myReports.length} report${myReports.length === 1 ? "" : "s"}</strong> filed in total, <strong>${visitsThisMonth}</strong> this month.`,
    },
  ].filter(Boolean));

  const stats = [
    { label: "Assigned schools", count: myFoSchoolsCache.length, icon: "school", href: "/field-officer", actionLabel: "View schools" },
    { label: "Visits this month", count: visitsThisMonth, icon: "mapPin", href: "/field-officer", actionLabel: "Log a visit" },
    { label: "Reports filed (all time)", count: myReports.length, icon: "cloud", href: "/field-officer", actionLabel: "Open field data" },
  ];

  return `
    <div data-fo-dash></div>
    ${statTiles(stats)}
    ${smart}
    <div class="dash-grid">
      <div class="panel">
        <h2>Assigned schools</h2>
        <p class="panel-sub">${myFoSchoolsLoaded ? `Last visit per school` : "Loading…"}</p>
        <div class="mini-table">
          ${!myFoSchoolsLoaded
            ? `<div class="empty-state">Loading…</div>`
            : schoolRows.length
            ? schoolRows
                .map(
                  (s) => `<div class="mt-row">
                    <span class="mt-name">${esc(s.name)}</span>
                    <span class="pill ${s.last ? "synced" : "pending"}">${s.last ? timeAgo(new Date(s.last.created_at).getTime()) : "not yet visited"}</span>
                  </div>`
                )
                .join("")
            : `<div class="empty-state">No schools assigned yet — ask an HPF administrator to assign you one.</div>`}
        </div>
      </div>
      <div class="panel">
        <h2>Field tasks</h2>
        <p class="panel-sub">Task tracking</p>
        ${notTracked("no task list exists yet, only field reports")}
      </div>
    </div>
    <div class="panel" style="margin-top:1.5rem">
      <h2>Visits logged this week</h2>
      <p class="panel-sub">School support & monitoring visits</p>
      ${barChart(trend, trendLabels)}
      <a class="btn btn-primary" href="/field-officer" data-link style="margin-top:1.25rem">
        ${icon("clipboard")} Open field data collection
      </a>
    </div>`;
}

/* The termly return form. Grouped the way a head of institution actually holds
   the information — register, staff list, retention, then the physical plant —
   rather than in table-column order. */
function schoolReturnForm(existing, school, county) {
  const y = new Date().getFullYear();
  const years = [y + 1, y, y - 1, y - 2];
  const v = (k, d = "") => (existing && existing[k] !== null && existing[k] !== undefined ? existing[k] : d);
  const sel = (k, list, cur) => list
    .map((o) => `<option value="${esc(o)}" ${String(cur) === String(o) ? "selected" : ""}>${esc(o)}</option>`).join("");
  const num = (name, label, val, extra = "") => `
    <div class="field"><label>${esc(label)}</label>
      <input class="input" type="number" min="0" name="${name}" value="${val === "" ? "" : esc(String(val))}" ${extra}></div>`;

  return `<form id="returnForm" class="add-user-form" data-id="${existing ? esc(existing.id) : ""}">
    <p class="panel-sub" style="margin-top:0">
      ${icon("school")} <strong>${esc(school)}</strong>${county ? " · " + esc(county) + " County" : ""}
      — figures for the selected term only. Filing the same term again updates it.
    </p>

    <h4 class="dash-section">${icon("clipboard")} Reporting period</h4>
    <div class="form-row">
      <div class="field"><label>Term</label>
        <select class="select" name="term" required>${sel("term", HPF_TERMS, v("term", HPF_TERMS[0]))}</select></div>
      <div class="field"><label>Year</label>
        <select class="select" name="year" required>${sel("year", years, v("year", y))}</select></div>
    </div>

    <h4 class="dash-section">${icon("userCheck")} Head of institution</h4>
    <div class="form-row">
      <div class="field" style="max-width:120px"><label>Title</label>
        <select class="select" name="head_title">
          ${HEAD_TITLES.map((t) => `<option ${v("head_title", leaderUser().head_title || "") === t ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select></div>
      <div class="field"><label>Full name</label>
        <input class="input" name="head_name" required value="${esc(v("head_name", leaderUser().fullName || ""))}" placeholder="e.g. Kuyuni Sailepu"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Phone</label>
        <input class="input" name="head_phone" type="tel" value="${esc(v("head_phone", leaderUser().phone || ""))}" placeholder="07xx xxx xxx"></div>
      <div class="field"><label>Email</label>
        <input class="input" name="head_email" type="email" value="${esc(v("head_email", leaderUser().email || ""))}" placeholder="name@example.org"></div>
    </div>

    <h4 class="dash-section">${icon("graduation")} Enrolment by grade</h4>
    <p class="hint" style="margin:-.4rem 0 .6rem">Boys and girls on the register in each grade.
      Leave a grade blank if the school does not run it — the totals add themselves up.</p>
    <div class="grade-grid">
      <div class="grade-row grade-head"><span>Grade</span><span>Boys</span><span>Girls</span><span>Total</span></div>
      ${GRADES.map((g) => {
        const ex = existing ? gradesFor(existing.id).find((x) => x.grade === g) : null;
        return `<div class="grade-row">
          <span class="grade-name">${esc(g)}</span>
          <input class="input" type="number" min="0" name="g_boys_${esc(g)}" value="${ex && ex.boys ? ex.boys : ""}" placeholder="0">
          <input class="input" type="number" min="0" name="g_girls_${esc(g)}" value="${ex && ex.girls ? ex.girls : ""}" placeholder="0">
          <span class="grade-total" data-grade-total>${ex ? (+ex.boys || 0) + (+ex.girls || 0) || "" : ""}</span>
        </div>`;
      }).join("")}
      <div class="grade-row grade-foot">
        <span>All grades</span>
        <span data-grade-sum="boys">0</span>
        <span data-grade-sum="girls">0</span>
        <span data-grade-sum="all">0</span>
      </div>
    </div>
    <div class="form-row">
      ${num("learners_with_disability", "Learners with a disability", v("learners_with_disability", 0))}
      ${num("attendance_rate", "Average attendance rate (%)", v("attendance_rate", ""), "max=100")}
    </div>

    <h4 class="dash-section">${icon("users")} Teaching staff</h4>
    <div class="form-row">
      ${num("tsc_teachers", "TSC teachers", v("tsc_teachers", 0), "required")}
      ${num("non_tsc_teachers", "Non-TSC teachers (BOM / PTA)", v("non_tsc_teachers", 0), "required")}
    </div>
    <div class="form-row">
      ${num("support_staff", "Support staff", v("support_staff", 0))}
      ${num("teachers_trained_term", "Teachers trained this term", v("teachers_trained_term", 0))}
    </div>

    <h4 class="dash-section">${icon("trendingDown")} Retention</h4>
    <div class="form-row">
      ${num("dropouts", "Learners who dropped out", v("dropouts", 0))}
      <div class="field"><label>Main reason for dropout</label>
        <select class="select" name="dropout_reason">
          <option value="">— not applicable —</option>${sel("dropout_reason", DROPOUT_REASONS, v("dropout_reason"))}
        </select></div>
    </div>
    <div class="form-row">
      <div class="field"><label>If “Other”, specify</label>
        <input class="input" name="dropout_reason_other" value="${esc(v("dropout_reason_other"))}" placeholder="Describe the reason"></div>
      ${num("mean_score", "Mean exam score (%)", v("mean_score", ""), "max=100 step=0.01")}
    </div>
    <div class="form-row">
      ${num("transfers_in", "Transfers in", v("transfers_in", 0))}
      ${num("transfers_out", "Transfers out", v("transfers_out", 0))}
    </div>

    <h4 class="dash-section">${icon("school")} Facilities</h4>
    <div class="form-row">
      ${num("classrooms", "Usable classrooms", v("classrooms", ""))}
      ${num("desks", "Desks available", v("desks", ""))}
    </div>
    <div class="form-row">
      ${num("toilets", "Latrines / toilets", v("toilets", ""))}
      <div class="field"><label>Main water source</label>
        <select class="select" name="water_source">
          <option value="">— select —</option>${sel("water_source", WATER_SOURCES, v("water_source"))}
        </select></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Power supply</label>
        <select class="select" name="electricity">
          <option value="">— select —</option>${sel("electricity", POWER_OPTIONS, v("electricity"))}
        </select></div>
      <div class="field"><label>Feeding programme</label>
        <select class="select" name="feeding_programme">
          <option value="false" ${v("feeding_programme") ? "" : "selected"}>No</option>
          <option value="true" ${v("feeding_programme") ? "selected" : ""}>Yes</option>
        </select></div>
    </div>

    <h4 class="dash-section">${icon("laptop")} ICT</h4>
    <div class="form-row">
      ${num("computers", "Working computers / tablets", v("computers", ""))}
      <div class="field"><label>Internet connection</label>
        <select class="select" name="internet_status">
          <option value="">— select —</option>${sel("internet_status", NET_OPTIONS, v("internet_status"))}
        </select></div>
    </div>

    <h4 class="dash-section">${icon("lightbulb")} Anything else</h4>
    <div class="form-row">
      <div class="field" style="grid-column:1/-1"><label>Income-generating projects</label>
        <input class="input" name="income_projects" value="${esc(v("income_projects"))}" placeholder="e.g. school garden, poultry, water kiosk"></div>
    </div>
    <div class="form-row">
      <div class="field" style="grid-column:1/-1"><label>Notes for HPF</label>
        <textarea class="input" name="notes" rows="3" placeholder="Challenges, requests, anything the numbers do not show">${esc(v("notes"))}</textarea></div>
    </div>

    ${existing ? `
      <h4 class="dash-section">${icon("pen")} Correction</h4>
      <div class="form-row">
        <div class="field" style="grid-column:1/-1">
          <label>Why is this being corrected?</label>
          <input class="input" name="correction_reason" required
                 placeholder="e.g. register recount after the end-of-term audit">
          <p class="hint">This return already feeds the HPF scorecard, so the change is recorded against your name.</p>
        </div>
      </div>` : ""}

    <div class="live-return" data-live-return aria-live="polite"></div>

    <div class="add-user-actions">
      <button class="btn btn-primary btn-xs" type="submit">${icon("check")} ${existing ? "Save correction" : "Submit return"}</button>
      <span class="draft-state" data-draft-state></span>
      <button class="btn btn-outline btn-xs" type="button" data-return-cancel>Cancel</button>
    </div>
  </form>`;
}

/* Who the head is and which school they are filing for. Filing against the
   wrong school is the one mistake that quietly corrupts every county figure
   downstream, so the school is stated up front and changeable, not buried in a
   profile page. Changing it writes back to the profile, which is also what the
   RLS policy checks — so picking your school here is what makes saving work. */
function leaderIdentityBar(school, county) {
  const u = leaderUser();
  const first = (u.fullName || u.username || "there").split(" ")[0];
  const counties = scRegions();
  const schools = county && county !== "" ? schoolsInRegion(county) : (getSchools().map((s) => s.name).sort());
  const opt = (list, cur) => list.map((i) =>
    `<option value="${esc(i)}" ${cur === i ? "selected" : ""}>${esc(i)}</option>`).join("");

  return `
    <div class="panel leader-id" data-leader-id>
      <div class="leader-id-hello">
        ${icon("school")}
        <div>
          <strong>Welcome ${esc(first)}</strong> — ${esc(school || "no school set")}${county ? `, ${esc(county)} region` : ""}
          ${u.legacy ? `<div class="hint" style="color:oklch(58% 0.16 75)">Signed in on an old browser-only account. Returns cannot be saved to the HPF database until an administrator creates your account.</div>` : ""}
        </div>
      </div>
      <div class="leader-id-pick">
        <select class="select select-sm" data-leader-county aria-label="Region">
          <option value="">Region…</option>${opt(counties, county)}
        </select>
        <select class="select select-sm" data-leader-school aria-label="School">
          <option value="">School…</option>${opt(schools, school)}
        </select>
        <button class="btn btn-outline btn-xs" data-leader-save>${icon("check")} Set school</button>
      </div>
    </div>

`;
}

/* Correction trail for one return. Shows only what moved, in the form's own
   wording, so a reader can see exactly which figure was amended and why. */
function returnHistory(r) {
  const revs = revisionsFor(r.id);
  if (!revs.length) return "";
  const open = returnHistoryOpen === r.id;
  return `<div class="utx-row ret-history-row">
    <div class="utx-cell" style="grid-column:1/-1">
      <button class="btn btn-outline btn-xs" data-return-history="${esc(r.id)}">
        ${icon("clock")} ${revs.length} correction${revs.length === 1 ? "" : "s"} ${open ? "▲" : "▼"}
      </button>
      ${open ? `<div class="ret-history">${revs.map((v) => `
        <div class="ret-rev">
          <div class="ret-rev-head">
            ${esc(timeAgo(Date.parse(v.corrected_at)))}
            ${v.reason ? ` · <em>${esc(v.reason)}</em>` : ` · <span class="dim">no reason given</span>`}
          </div>
          <ul class="ret-rev-list">
            ${Object.entries(v.changed || {}).map(([k, d]) =>
              `<li><strong>${esc(returnLabel(k))}</strong>
                 <span class="ret-from">${esc(showVal(d.from))}</span> →
                 <span class="ret-to">${esc(showVal(d.to))}</span></li>`).join("")}
          </ul>
        </div>`).join("")}</div>` : ""}
    </div>
  </div>`;
}

/* Termly returns panel: term switcher, the aggregate for whatever is selected,
   and the filed returns themselves. */
function schoolReturnsPanel(school, county) {
  if (!returnsLoaded) return `<div class="panel" data-returns-panel><div class="empty-state">Loading school returns…</div></div>`;
  if (returnsError) {
    return `<div class="panel" data-returns-panel><div class="empty-state">Could not load returns — ${esc(returnsError)}
      <div style="margin-top:.6rem"><button class="btn btn-outline btn-xs" data-returns-retry>${icon("refresh")} Try again</button></div>
    </div></div>`;
  }

  if (!school) {
    return `${leaderIdentityBar("", leaderCounty())}
      <div class="panel" data-returns-panel style="margin-top:1.5rem">
        <div class="empty-state">Choose your region and school above before filing a return.
          Returns are stored against the school you select, so this has to be right.</div>
      </div>`;
  }
  const mine = returnsForSchool(school);
  const shown = returnTermView === "all" ? mine : mine.filter((r) => r.term === returnTermView);
  const agg = aggregateReturns(shown);
  const editing = returnEditId ? mine.find((r) => r.id === returnEditId) : null;

  const tabs = ["all", ...HPF_TERMS]
    .map((t) => `<button class="ksubtab ${returnTermView === t ? "active" : ""}" data-return-term="${esc(t)}">
      ${t === "all" ? "All terms" : esc(t)}
      <span class="dfb-count">${t === "all" ? mine.length : mine.filter((r) => r.term === t).length}</span>
    </button>`).join("");

  const tile = (label, val, note = "") => `
    <div class="stat-tile"><div class="st-label">${esc(label)}</div>
      <div class="st-num">${val === null || val === undefined || val === "" ? "—" : esc(String(val))}</div>
      ${note ? `<div class="kpi-target">${esc(note)}</div>` : ""}</div>`;

  const summary = shown.length ? `
    <div class="stat-row" style="margin-bottom:1rem">
      ${tile("Enrolment", agg.enrolled.toLocaleString(), `${agg.boys} boys · ${agg.girls} girls`)}
      ${tile("Teachers", agg.tsc + agg.nonTsc, `${agg.tsc} TSC · ${agg.nonTsc} non-TSC`)}
      ${tile("Dropouts", agg.dropouts, `${agg.dropoutRate}% of enrolment`)}
      ${tile("Learners per teacher", agg.learnersPerTeacher, agg.learnersPerClassroom ? `${agg.learnersPerClassroom} per classroom` : "")}
    </div>
    ${(() => {
      const gb = gradeBreakdown(shown);
      if (!gb.length) return "";
      const segs = [
        { label: "Boys", value: gb.reduce((a, g) => a + g.boys, 0), color: "oklch(52% 0.14 148)" },
        { label: "Girls", value: gb.reduce((a, g) => a + g.girls, 0), color: "oklch(78% 0.15 75)" },
      ];
      return `<div class="panel" style="margin-bottom:1rem">
        <h2 style="font-size:1rem">Enrolment by grade</h2>
        <p class="panel-sub">${gb.length} grade${gb.length === 1 ? "" : "s"} on the register</p>
        ${groupedBars(gb.map((g) => g.grade), ["Boys", "Girls"],
          gb.map((g) => [g.boys, g.girls]), ["oklch(52% 0.14 148)", "oklch(78% 0.15 75)"])}
        <div class="donut-wrap" style="margin-top:.75rem">${chartLegend(segs)}</div>
      </div>`;
    })()}
    ${agg.reasons.length ? `<div class="panel" style="margin-bottom:1rem">
      <h2 style="font-size:1rem">Why learners left</h2>
      <p class="panel-sub">${agg.dropouts} dropout${agg.dropouts === 1 ? "" : "s"} across ${shown.length} return${shown.length === 1 ? "" : "s"}</p>
      ${rankedBars(Object.fromEntries(agg.reasons), "oklch(62% 0.24 27)")}
    </div>` : ""}` : "";

  const rows = shown.length
    ? shown.map((r) => `<div class="utx-row">
        <div class="utx-cell"><strong>${esc(r.term)} ${r.year}</strong></div>
        <div class="utx-cell">${enrolTotal(r).toLocaleString()}<div class="utx-email">${r.boys}b · ${r.girls}g</div></div>
        <div class="utx-cell">${(+r.tsc_teachers || 0) + (+r.non_tsc_teachers || 0)}<div class="utx-email">${r.tsc_teachers} TSC</div></div>
        <div class="utx-cell">${r.dropouts || 0}<div class="utx-email">${esc(r.dropout_reason || "—")}</div></div>
        <div class="utx-cell">${r.attendance_rate === null || r.attendance_rate === undefined ? "—" : r.attendance_rate + "%"}</div>
        <div class="utx-cell utx-actions">
          <button class="icon-btn" data-return-edit="${esc(r.id)}" title="Correct this return">${icon("pen")}</button>
          <button class="icon-btn danger" data-return-delete="${esc(r.id)}" title="Delete">${icon("trash")}</button>
        </div>
      </div>
      ${returnHistory(r)}`).join("")
    : `<div class="empty-state">No return filed${returnTermView === "all" ? "" : " for " + esc(returnTermView)} yet.
         Click <strong>File a return</strong> to add one.</div>`;

  return `
    ${leaderIdentityBar(school, county)}
    <div class="panel" data-returns-panel style="margin-top:1.5rem">
      <div class="panel-head-row">
        <div>
          <h2>${icon("clipboard")} Termly school return</h2>
          <p class="panel-sub" style="margin-bottom:0">Enrolment, staffing and retention for ${esc(school)} — feeds the HPF scorecard</p>
        </div>
        <button class="btn btn-primary" data-return-add>${icon("plus")} File a return</button>
      </div>

      <div class="ksubtabs">${tabs}</div>
      ${returnFormOpen ? schoolReturnForm(editing, school, county) : ""}
      ${summary}

      <div class="utx-scroll"><div class="utx-table">
        <div class="utx-row utx-head">
          <div class="utx-cell">Period</div><div class="utx-cell">Enrolment</div>
          <div class="utx-cell">Teachers</div><div class="utx-cell">Dropouts</div>
          <div class="utx-cell">Attendance</div><div class="utx-cell"></div>
        </div>
        ${rows}
      </div></div>
    </div>`;
}

/* Which school this head runs. Supabase profiles store it on `school`; locally
   created accounts use the same key, so one lookup covers both. */
const leaderUser = () => read(K_SESSION, null) || {};
/* Deliberately no fallback to the first school in the list. Defaulting here is
   how a return ends up filed against a school nobody chose, which quietly
   corrupts every county figure downstream. Unset means unset. */
function leaderSchool() {
  return (leaderUser().school || "").trim();
}
function leaderCounty() {
  const u = leaderUser();
  const s = getSchools().find((x) => x.name === leaderSchool());
  return (s && s.county) || u.county || u.region || "";
}

function schoolLeaderBody() {
  const school = leaderSchool();
  // Most recently filed/updated return first — school_returns is termly, not
  // daily, so "latest" means the newest filing, not "today's" figures.
  const returns = returnsForSchool(school).slice()
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  const latest = returns[0];

  const stats = latest ? [
    { label: "Enrolled learners", count: latest.boys + latest.girls, icon: "graduation", href: "/assessment", actionLabel: "School progress" },
    { label: "Teaching staff", count: latest.tsc_teachers + latest.non_tsc_teachers, icon: "users", href: "/curriculum", actionLabel: "Review staff" },
    { label: "Attendance rate", count: latest.attendance_rate ?? 0, suffix: latest.attendance_rate != null ? "%" : "", icon: "userCheck", href: "/assessment", actionLabel: "View attendance" },
  ] : [];

  // Chronological (oldest first) across whatever terms have actually been
  // filed — the only real "trend" this data supports; there's no daily
  // attendance record to draw a weekly chart from.
  const chrono = [...returns].reverse().filter((r) => r.attendance_rate != null).slice(-8);
  const attTrend = chrono.map((r) => r.attendance_rate);
  const attLabels = chrono.map((r) => `${r.term} ${r.year}`);
  const attDelta = attTrend.length >= 2 ? attTrend[attTrend.length - 1] - attTrend[0] : null;

  const smart = insights([
    !returnsLoaded && {
      icon: "info", tone: "",
      html: `Loading your school's returns…`,
    },
    returnsLoaded && !latest && {
      icon: "info", tone: "warn",
      html: `No termly return has been filed for <strong>${esc(school || "your school")}</strong> yet — file one below to populate this overview.`,
    },
    latest && attDelta !== null && {
      icon: attDelta >= 0 ? "trendingUp" : "trendingDown", tone: attDelta >= 0 ? "good" : "bad",
      html: `Attendance is <strong>${attDelta >= 0 ? "up" : "down"} ${Math.abs(attDelta)} point${Math.abs(attDelta) === 1 ? "" : "s"}</strong> since your first filed term, now at <strong>${attTrend[attTrend.length - 1]}%</strong>.`,
    },
    latest && {
      icon: "users", tone: "",
      html: `<strong>${latest.tsc_teachers} TSC</strong> / <strong>${latest.non_tsc_teachers} non-TSC</strong> teacher${latest.tsc_teachers + latest.non_tsc_teachers === 1 ? "" : "s"} this term — the non-TSC count is where HPF's funding gap shows up.`,
    },
  ].filter(Boolean));

  return `
    <div class="panel-head-row" style="margin-bottom:1.25rem">
      <div>
        <h2 style="font-size:1.15rem">School overview</h2>
        <p class="panel-sub" style="margin:0">Your whole-school snapshot for this term</p>
      </div>
      <button class="btn btn-primary" data-generate-report>${icon("download")} Generate term report</button>
    </div>
    ${latest ? statTiles(stats) : ""}
    ${smart}
    ${schoolReturnsPanel(leaderSchool(), leaderCounty())}
    <div class="dash-grid">
      <div class="panel">
        <h2>Performance by grade</h2>
        <p class="panel-sub">Average competency score (%)</p>
        ${notTracked("no per-grade competency score is recorded anywhere yet")}
      </div>
      <div class="panel">
        <h2>Teaching staff</h2>
        <p class="panel-sub">Coaching ratings this term</p>
        ${notTracked("no coaching-rating record exists yet")}
      </div>
    </div>
    <div class="panel" style="margin-top:1.5rem">
      <h2>School attendance trend</h2>
      <p class="panel-sub">Whole-school attendance rate (%), by filed term</p>
      ${attTrend.length ? barChart(attTrend, attLabels, "%") : notTracked("no term with an attendance rate has been filed yet")}
    </div>`;
}

const BODIES = {
  admin: adminBody,
  staff: adminBody, // same dashboard code — the RLS split is what actually differs
  learner: learnerBody,
  teacher: teacherBody,
  field_officer: fieldOfficerBody,
  school_leader: schoolLeaderBody,
};

export function dashboardBody(role, ctx) {
  coachUser = ctx && ctx.user ? ctx.user : null; // scope the coach view by school
  return roleBanner(role) + (BODIES[role] || learnerBody)(ctx);
}

/* ---------------------------------------------------------- page shell */
export function myDashboardMain(user, events) {
  const impersonator = read(K_IMPERSONATE, null);
  const allowed = VIEWABLE[user.role] || [user.role];
  const current = allowed.includes(user.role) ? user.role : allowed[0];
  const tabs = allowed
    .map(
      (r) =>
        `<button class="role-tab ${r === current ? "active" : ""}" data-role="${r}">${ROLE_LABEL[r]}</button>`
    )
    .join("");
  const switcher = allowed.length > 1 ? `<div class="role-switch">${tabs}</div>` : "";
  const firstName = (user.fullName || user.username || "there").split(" ")[0];

  // Where this user belongs — "in Narok · Ololomei School". Staff and admin
  // work across every school, so naming one would be wrong: a leftover school
  // on the profile (from before they were promoted, or picked at signup) is
  // not where they work. Region still reads true for them, so keep it.
  const orgWide = user.role === "admin" || user.role === "staff";
  const place = (orgWide ? [user.region] : [user.region, user.school]).filter(Boolean);
  const placeBit = place.length ? ` in <strong>${place.map(esc).join(" · ")}</strong>` : "";
  const intro =
    allowed.length > 1
      ? `Signed in as <strong>${esc(ROLE_LABEL[user.role] || user.role)}</strong>${placeBit}. Switch the view below${user.role === "teacher" ? " between your Teacher and Learner workspaces" : ""}.`
      : `Signed in as <strong>${esc(ROLE_LABEL[user.role] || user.role)}</strong>${placeBit}.`;

  const topBtn = impersonator
    ? `<button class="btn btn-outline" data-exit-account>${icon("login")} Exit account</button>`
    : `<button class="btn btn-outline" data-logout>${icon("logout")} Sign out</button>`;

  const banner = impersonator
    ? `<div class="impersonate-banner">
        ${icon("userCheck")}
        <span>You're in <strong>${esc(user.fullName || user.username)}</strong>'s account (${esc(ROLE_LABEL[user.role] || user.role)}), helping remotely as <strong>${esc(impersonator.fullName || impersonator.username)}</strong>.</span>
        <button class="btn btn-primary btn-xs" data-exit-account>${icon("login")} Exit to your account</button>
      </div>`
    : "";

  return `
    <section class="dash">
      <div class="container">
        ${banner}
        <div class="dash-head">
          <div>
            <span class="eyebrow">My Dashboard</span>
            <h1>Welcome back, ${esc(firstName)}</h1>
            <p>${intro}</p>
          </div>
          ${topBtn}
        </div>
        ${switcher}
        <div id="dashBody">${dashboardBody(current, { user, events })}</div>
      </div>
    </section>`;
}

export function wireMyDashboard(user, events) {
  const body = document.getElementById("dashBody");
  const tabs = [...document.querySelectorAll(".role-tab")];
  const ctx = { user, events };

  function wireTasks() {
    body.querySelectorAll("[data-task]").forEach((btn) =>
      btn.addEventListener("click", () => {
        btn.classList.toggle("done");
        const list = btn.closest("[data-tasklist]");
        const done = list.querySelectorAll(".task.done").length;
        list.querySelector("[data-done]").textContent = done;
      })
    );
  }

  function wireAdmin(role) {
    /* KPI quick actions, delegated. The top KPI row sits outside the analytics
       panel and survives its re-renders, while the cards inside it are replaced
       on every one — binding directly would both miss the new buttons and stack
       duplicate listeners on the old. One listener on the container handles
       both. wireAdmin runs once per renderRole, so it is never doubled. */
    body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-kpi-action]");
      if (!b || !body.contains(b)) return;
      const act = b.dataset.kpiAction;
      if (act === "refresh") {
        renderAnalytics();
        return toast("Refreshed", "KPIs recomputed from the latest data.", "success");
      }
      if (act === "people")    { adminView = "people";    return renderAnalytics(); }
      if (act === "scorecard") { adminView = "scorecard"; return renderAnalytics(); }
      if (act === "inbox")     { adminInboxOpen = true;   return renderRole(role); }
      if (act === "users") {
        // The user table lives outside the analytics panel, so open it and
        // scroll rather than switching tab. renderRole() replaces the body and
        // restarts its fade-in in the same frame, which cancels a smooth scroll
        // started synchronously — wait for the next frame.
        usersListOpen = true;
        renderRole(role);
        requestAnimationFrame(() =>
          body.querySelector("[data-users-role]")?.closest(".panel")
            ?.scrollIntoView({ behavior: "smooth", block: "start" })
        );
      }
    });

    /* Collapse toggles for HPF administrators / Digital Library / Recent
       activity. Delegated for the same reason as the KPI actions above: these
       panels are replaced wholesale on most re-renders, so a direct listener
       would go stale. A full renderRole is needed rather than a targeted
       repaint — the three panels are built by three different functions with
       no shared re-render path. */
    body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-panel-collapse]");
      if (!b || !body.contains(b)) return;
      const key = b.dataset.panelCollapse;
      collapsedPanels[key] = !collapsedPanels[key];
      renderRole(role);
    });

    body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-field-reports-retry]");
      if (!b || !body.contains(b)) return;
      loadFieldReports().then(() => {
        if (body.querySelector("[data-admin-panel]")) renderAnalytics();
      });
    });

    /* --- dashboard filter bar ---
       Selects only touch the draft, so nothing recomputes until Apply. The
       county select is the exception: it re-renders immediately so the school
       list can narrow, but it still commits nothing. */
    body.addEventListener("change", (e) => {
      const sel = e.target.closest("[data-dfb]");
      if (!sel || !body.contains(sel)) return;
      dashDraft[sel.dataset.dfb] = sel.value;
      // Re-render the bar so the Apply/Reset enabled state and the cascading
      // school list stay truthful. Only the bar — the widgets below are still
      // showing committed data and must not move yet.
      renderFilterBar();
    });

    body.addEventListener("click", (e) => {
      const apply = e.target.closest("[data-dfb-apply]");
      const reset = e.target.closest("[data-dfb-reset]");
      if (!apply && !reset) return;
      if (!body.contains(apply || reset)) return;

      if (reset) {
        dashDraft = { ...DASH_FILTER_DEFAULTS };
        dashFilter = { ...DASH_FILTER_DEFAULTS };
      } else {
        dashFilter = { ...dashDraft };
      }

      /* Keep the scorecard's own filters in step. It predates this bar and has
         its own state; leaving them independent would let the page show a
         county-filtered map above a scorecard still reporting everything. */
      scFilter.region = dashFilter.county;
      scFilter.school = dashFilter.school;
      scFilter.programme = dashFilter.programme;

      renderRole(role);
      toast(
        reset ? "Filters reset" : "Filters applied",
        reset ? "Showing all counties, schools and dates."
              : (dashSummary() || "Showing everything"),
        "success"
      );
    });

    // --- live analytics: sub-tabs, refresh, and cross-tab updates ---
    function wireAnalytics() {
      body.querySelectorAll("[data-admin-tab]").forEach((t) =>
        t.addEventListener("click", () => {
          adminView = t.dataset.adminTab;
          renderAnalytics();
        })
      );
      body.querySelectorAll("[data-sc-pillar]").forEach((c) =>
        c.addEventListener("click", () => {
          scPillar = c.dataset.scPillar;
          renderAnalytics();
        })
      );
      body.querySelector("[data-admin-refresh]")?.addEventListener("click", () => {
        renderAnalytics();
        toast("Scorecard refreshed", "Recomputed from the latest teacher, learner & field data.", "success");
      });

      // --- ELOG-style filters: school / term / pillar + indicator search ---
      const bindFilter = (sel, key) =>
        body.querySelector(sel)?.addEventListener("change", (e) => {
          scFilter[key] = e.target.value;
          renderAnalytics();
        });
      bindFilter("[data-sc-school]", "school");
      bindFilter("[data-sc-term]", "term");
      bindFilter("[data-sc-pillar]", "pillar");
      bindFilter("[data-sc-programme]", "programme");
      // region change resets the school so the cascade stays valid
      body.querySelector("[data-sc-region]")?.addEventListener("change", (e) => {
        scFilter.region = e.target.value;
        scFilter.school = "all";
        renderAnalytics();
      });
      // region chips + clickable map cells
      body.querySelectorAll("[data-sc-region-pick]").forEach((b) =>
        b.addEventListener("click", () => {
          const r = b.dataset.scRegionPick;
          scFilter.region = scFilter.region === r ? "all" : r;
          scFilter.school = "all";
          renderAnalytics();
          if (scFilter.region !== "all") toast("Region focus", `Dashboard now showing ${scFilter.region}.`, "success");
        })
      );
      body.querySelector("[data-sc-clear]")?.addEventListener("click", () => {
        Object.assign(scFilter, { region: "all", school: "all", term: "all", pillar: "all", programme: "all", q: "" });
        renderAnalytics();
        toast("Filters cleared", "Showing all regions, schools and programmes.", "success");
      });
      // dark / bright board theme
      body.querySelector("[data-sc-theme]")?.addEventListener("click", () => {
        scTheme = scTheme === "dark" ? "light" : "dark";
        renderAnalytics();
      });

      // --- school satellite map + editable story ---
      // Postgres is the source of truth, so every write re-reads the table
      // before re-rendering rather than patching the cache optimistically —
      // two admins editing at once should converge on what the database says.
      const refreshSchools = async () => { await loadSchools(); renderAnalytics(); };

      body.querySelector("[data-schools-retry]")?.addEventListener("click", refreshSchools);

      body.querySelectorAll("[data-map-school]").forEach((b) =>
        b.addEventListener("click", () => {
          const id = b.dataset.mapSchool;
          mapSchool = mapSchool === id ? null : id;
          mapEditing = false;
          renderAnalytics();
        })
      );
      body.querySelector("[data-story-edit]")?.addEventListener("click", () => {
        mapEditing = true;
        renderAnalytics();
      });
      body.querySelector("[data-story-cancel]")?.addEventListener("click", () => {
        mapEditing = false;
        renderAnalytics();
      });
      body.querySelector("#storyForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const id = form.dataset.id;
        const sc = findSchool(id);
        const text = (new FormData(form).get("story") || "").toString().trim();
        const btn = form.querySelector("[type=submit]");
        if (btn) btn.disabled = true;

        const { error } = await supabase.from("schools").update({ story: text || null }).eq("id", id);
        if (error) {
          if (btn) btn.disabled = false;
          return toast("Could not save story", authMessage(error), "error");
        }
        mapEditing = false;
        toast(text ? "Story saved" : "Story cleared", `${sc?.name || "School"} updated.`, "success");
        await refreshSchools();
      });

      // --- facilities (patch-13) ---
      const refreshFacilities = async () => { await loadSchoolFacilities(); renderAnalytics(); };
      body.querySelector("[data-facilities-edit]")?.addEventListener("click", () => {
        facilitiesEditing = true;
        renderAnalytics();
      });
      body.querySelector("[data-facilities-cancel]")?.addEventListener("click", () => {
        facilitiesEditing = false;
        renderAnalytics();
      });
      body.querySelector("#facilitiesForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const schoolId = form.dataset.schoolId;
        const d = Object.fromEntries(new FormData(form).entries());
        const toNum = (v) => (v === "" || v === undefined ? null : Number(v));
        const patch = {
          school_id: schoolId,
          classrooms: toNum(d.classrooms), toilets: toNum(d.toilets), computers: toNum(d.computers),
          dormitories: toNum(d.dormitories), teachers_houses: toNum(d.teachers_houses),
          water_source: d.water_source || null, electricity: d.electricity || null, internet_status: d.internet_status || null,
        };
        FACILITY_FLAGS.forEach((ff) => { patch[ff.key] = form.querySelector(`[name="${ff.key}"]`)?.checked || false; });

        const btn = form.querySelector("[type=submit]");
        if (btn) btn.disabled = true;
        const { error } = await supabase.from("school_facilities").upsert(patch, { onConflict: "school_id" });
        if (error) {
          if (btn) btn.disabled = false;
          return toast("Could not save facilities", authMessage(error), "error");
        }
        facilitiesEditing = false;
        toast("Facilities saved", "", "success");
        await refreshFacilities();
      });

      // --- programmes (patch-13) ---
      body.querySelector("[data-programme-toggle]")?.addEventListener("click", () => {
        programmeFormOpen = !programmeFormOpen;
        renderAnalytics();
      });
      body.querySelector("[data-programme-cancel]")?.addEventListener("click", () => {
        programmeFormOpen = false;
        renderAnalytics();
      });
      body.querySelector("#programmeForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const schoolId = form.dataset.schoolId;
        const d = Object.fromEntries(new FormData(form).entries());
        if (!d.programme?.trim()) return toast("Programme name required", "", "error");

        const btn = form.querySelector("[type=submit]");
        if (btn) btn.disabled = true;
        const { error } = await supabase.from("school_programmes")
          .insert({ school_id: schoolId, programme: d.programme.trim(), status: d.status });
        if (error) {
          if (btn) btn.disabled = false;
          if (error.code === "23505") return toast("Already recorded", "This school already has a programme by that name.", "error");
          return toast("Could not add programme", authMessage(error), "error");
        }
        programmeFormOpen = false;
        toast("Programme added", "", "success");
        await refreshFacilities();
      });

      // --- admin-managed schools (add / edit / delete) ---
      body.querySelector("[data-school-manage-toggle]")?.addEventListener("click", () => {
        schoolManageOpen = !schoolManageOpen;
        schoolFormOpen = false;
        editSchoolId = null;
        renderAnalytics();
      });
      body.querySelector("[data-school-add]")?.addEventListener("click", () => {
        editSchoolId = null;
        schoolFormOpen = true;
        renderAnalytics();
      });
      body.querySelectorAll("[data-school-edit]").forEach((btn) =>
        btn.addEventListener("click", () => {
          editSchoolId = btn.dataset.schoolEdit;
          schoolFormOpen = true;
          renderAnalytics();
        })
      );
      body.querySelectorAll("[data-school-delete]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const id = btn.dataset.schoolDelete;
          const sc = findSchool(id);
          if (!sc) return;
          btn.disabled = true;

          const { error } = await supabase.from("schools").delete().eq("id", id);
          if (error) {
            btn.disabled = false;
            return toast("Could not remove school", authMessage(error), "error");
          }
          if (mapSchool === id) mapSchool = null;
          if (editSchoolId === id) { editSchoolId = null; schoolFormOpen = false; }
          toast("School removed", `${sc.name} deleted.`, "success");
          await refreshSchools();
        })
      );
      body.querySelector("[data-school-form-cancel]")?.addEventListener("click", () => {
        schoolFormOpen = false;
        editSchoolId = null;
        renderAnalytics();
      });
      body.querySelector("#schoolForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = Object.fromEntries(new FormData(form).entries());
        const name = (data.name || "").trim();
        const county = (data.county || "").trim();
        const lat = parseFloat(data.lat);
        const lng = parseFloat(data.lng);
        if (!name) return toast("Name required", "", "error");
        if (!county) return toast("County required", "", "error");
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return toast("Invalid coordinates", "Enter numeric latitude & longitude.", "error");

        const id = form.dataset.id;
        // cheap local check for the common case; the unique index on
        // lower(name) is what actually guarantees it (23505 below).
        if (getSchools().some((x) => x.name.toLowerCase() === name.toLowerCase() && x.id !== id))
          return toast("Duplicate school", "A school with that name already exists.", "error");

        const btn = form.querySelector("[type=submit]");
        if (btn) btn.disabled = true;
        const row = { name, county, lat, lng };
        const { error } = id
          ? await supabase.from("schools").update(row).eq("id", id)
          : await supabase.from("schools").insert(row);

        if (error) {
          if (btn) btn.disabled = false;
          if (error.code === "23505")
            return toast("Duplicate school", "A school with that name already exists.", "error");
          return toast(id ? "Could not update school" : "Could not add school", authMessage(error), "error");
        }
        schoolFormOpen = false;
        editSchoolId = null;
        toast(id ? "School updated" : "School added", name, "success");
        await refreshSchools();
      });

      // maximize any chart into a full-screen overlay (minimize to return)
      body.querySelectorAll("[data-chart-max]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const id = btn.dataset.chartMax;
          const panel = body.querySelector(`[data-chart-panel="${id}"]`);
          const src = panel?.classList.contains("scd-panel")
            ? panel.querySelector(".scd-panel-body")
            : panel;
          if (!src) return;
          const title = (panel.querySelector("h3") || btn.closest(".scd-panel")?.querySelector("h3"))?.textContent || "Chart";
          const ov = document.createElement("div");
          ov.className = `chart-full ${scTheme === "light" ? "sc-bright" : ""} sc-dark`;
          ov.innerHTML = `
            <div class="cf-head">
              <h3>${esc(title.trim())}</h3>
              <button class="btn btn-outline btn-xs" data-cf-close>${icon("arrowLeft")} Minimize</button>
            </div>
            <div class="cf-body">${src.innerHTML}</div>`;
          document.body.appendChild(ov);
          const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
          const onKey = (e) => { if (e.key === "Escape") close(); };
          ov.querySelector("[data-cf-close]").addEventListener("click", close);
          ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
          document.addEventListener("keydown", onKey);
          runCounters(); // re-animate any numbers inside the blown-up chart
        })
      );
      const searchEl = body.querySelector("[data-sc-search]");
      if (searchEl) {
        let t = null;
        searchEl.addEventListener("input", (e) => {
          clearTimeout(t);
          const v = e.target.value;
          t = setTimeout(() => {
            scFilter.q = v;
            renderAnalytics();
            const again = body.querySelector("[data-sc-search]");
            if (again) { again.focus(); again.setSelectionRange(v.length, v.length); }
          }, 300);
        });
      }

      // --- editable activities: add / update score / delete ---
      body.querySelector("#actForm")?.addEventListener("submit", (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(e.currentTarget).entries());
        const name = (d.name || "").trim();
        if (!name) return toast("Name required", "Give the activity a name.", "error");
        const value = Math.max(0, Math.min(100, +d.value || 0));
        const acts = getActivities();
        acts.push({ id: uid(), pillar: d.pillar, name, value, createdAt: Date.now() });
        saveActivities(acts);
        scPillar = d.pillar; // jump to the pillar you just added to
        toast("Activity added", `“${name}” is now scored and charted.`, "success");
        renderAnalytics();
      });
      body.querySelectorAll("[data-act-val]").forEach((inp) =>
        inp.addEventListener("change", () => {
          const acts = getActivities();
          const a = acts.find((x) => x.id === inp.dataset.actVal);
          if (!a) return;
          a.value = Math.max(0, Math.min(100, +inp.value || 0));
          saveActivities(acts);
          toast("Score updated", `“${a.name}” set to ${a.value}.`, "success");
          renderAnalytics();
        })
      );
      body.querySelectorAll("[data-act-del]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const acts = getActivities();
          const a = acts.find((x) => x.id === btn.dataset.actDel);
          saveActivities(acts.filter((x) => x.id !== btn.dataset.actDel));
          toast("Activity removed", a ? `“${a.name}” deleted.` : "", "success");
          renderAnalytics();
        })
      );
    }
    /* Repaint just the filter bar. Used while staging a draft, so the widgets
       below keep showing committed data until Apply. */
    function renderFilterBar() {
      const bar = body.querySelector("[data-dash-filters]");
      if (!bar) return;
      const focused = document.activeElement?.dataset?.dfb;
      bar.outerHTML = dashFilterBar();
      // outerHTML replaced the node the select lived on, so restore focus by
      // key rather than by reference.
      if (focused) body.querySelector(`[data-dfb="${focused}"]`)?.focus();
    }

    function renderAnalytics() {
      const holder = body.querySelector("[data-admin-panel]");
      if (!holder) return;
      holder.outerHTML = adminAnalytics(ctx);
      wireAnalytics();
      runCounters();
    }
    wireAnalytics();
    // schools come from Postgres — fetch once on mount, then re-render so the
    // map swaps out of its loading state. Failures surface in the panel itself
    // (with a retry), so nothing to catch here.
    // Schools, the heads' returns, field reports, and classes all feed panels
    // in here. One re-render once they land, rather than the dashboard
    // twitching four times. programmeDataLoaded guards the whole thing —
    // fetch AND re-render — not just the fetch: the re-render below calls
    // back into this same wireBody, so without a guard on the re-render too,
    // every render re-armed another one, forever (this used to be the cause
    // of the dashboard visibly shaking/blinking non-stop).
    if (!programmeDataLoaded) {
      const classesPromise = classesLoaded ? Promise.resolve(classesCache) : loadClasses();
      Promise.allSettled([loadSchools(), loadReturns(), loadRevisions(), loadGrades(), loadFieldReports(), classesPromise, loadDeviceIssues(), loadMeIndicators(), loadSchoolFacilities(), loadDevices()]).then(() => {
        programmeDataLoaded = true;
        // Full re-render, not just renderAnalytics(): Programme Overview (a
        // sibling of the analytics panel, not inside it) reads the same
        // schools/returns/classes/device data and needs the same refresh.
        if (body.querySelector("[data-programme-overview]")) renderRole(role);
      });
    }
    // update automatically when data changes in another tab (keep just one listener)
    // hpf_submissions dropped: field reports moved to Postgres, so nothing
    // writes that key any more — a same-tab reload after a new visit syncs
    // already re-renders via the mount-time load above.
    if (window.__hpfAdminStorage) window.removeEventListener("storage", window.__hpfAdminStorage);
    window.__hpfAdminStorage = (e) => {
      if (["hpf_classes", "hpf_users", "hpf_login_events"].includes(e.key)) {
        if (body.querySelector("[data-admin-panel]")) renderAnalytics();
      }
    };
    window.addEventListener("storage", window.__hpfAdminStorage);

    // Change a user's role inline
    body.querySelectorAll("[data-role-edit]").forEach((sel) =>
      sel.addEventListener("change", () => {
        const users = read(K_USERS, []);
        const u = users.find((x) => x.id === sel.dataset.roleEdit);
        if (!u) return;
        u.role = sel.value;
        write(K_USERS, users);
        const sess = read(K_SESSION, null);
        if (sess && sess.id === u.id) {
          sess.role = sel.value;
          write(K_SESSION, sess);
        }
        toast("Role updated", `${u.fullName || u.username} is now ${ROLE_LABEL[sel.value]}.`, "success");
        renderRole(role);
      })
    );

    // Add-user form
    const form = body.querySelector("#addUserForm");
    body.querySelector("[data-add-user-toggle]")?.addEventListener("click", () => {
      if (form) {
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector('[name="fullName"]')?.focus();
      }
    });
    body.querySelector("[data-add-user-cancel]")?.addEventListener("click", () => {
      if (form) { form.reset(); form.hidden = true; }
    });
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      data.role = data.role || "teacher";
      if (!(data.fullName || "").trim()) return toast("Name required", "", "error");
      if (data.role === "learner") {
        if (!data.username) return toast("Username required", "Learners sign in with a username.", "error");
        delete data.email;
      } else {
        if (!data.email) return toast("Email required", "Enter an email for this account.", "error");
      }
      // anyone with an organisation email belongs to HPF staff, not this table
      if ((data.email || "").trim().toLowerCase().endsWith("@" + ORG_DOMAIN)) data.role = "staff";
      // This table is this browser's localStorage, so a staff/admin account
      // created here could not sign in anywhere else. Hand both tiers to the
      // panel that makes real ones.
      if (data.role === "staff" || data.role === "admin") {
        adminFormOpen = true;
        adminPromoteOpen = false;
        toast(
          "Staff accounts are created in the database",
          "A staff or admin account has to work on every device, so it can't live in this table. Use the HPF Staff & Admins panel, just above."
        );
        return renderRole(role);
      }
      if ((data.password || "").length < 6) return toast("Weak password", "Min. 6 characters.", "error");

      const users = read(K_USERS, []);
      const key = (data.email || data.username || "").toLowerCase();
      if (users.some((u) => (u.email || u.username || "").toLowerCase() === key))
        return toast("Duplicate account", "An account with those details already exists.", "error");

      users.push({ ...data, id: uid(), createdAt: Date.now() });
      write(K_USERS, users);
      toast("User added", `${data.fullName} created as ${ROLE_LABEL[data.role]}.`, "success");
      renderRole(role);
    });

    // Remove a user
    body.querySelectorAll("[data-remove-user]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.dataset.removeUser;
        const users = read(K_USERS, []);
        const u = users.find((x) => x.id === id);
        write(K_USERS, users.filter((x) => x.id !== id));
        toast("User removed", u ? `${u.fullName || u.username} deleted.` : "", "success");
        renderRole(role);
      })
    );

    // reveal / hide a password in the table
    body.querySelectorAll("[data-pw-toggle]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const span = btn.parentElement.querySelector(".pw-mask");
        const shown = span.dataset.shown === "1";
        span.textContent = shown ? "••••••••" : span.dataset.pw;
        span.dataset.shown = shown ? "0" : "1";
      })
    );

    // smart inbox: expand / collapse the full request list
    body.querySelector("[data-inbox-toggle]")?.addEventListener("click", () => {
      adminInboxOpen = !adminInboxOpen;
      renderRole(role);
    });
    // user list: collapse / expand the full table
    body.querySelector("[data-users-toggle]")?.addEventListener("click", () => {
      usersListOpen = !usersListOpen;
      renderRole(role);
    });
    // user list: filter by role + sort
    body.querySelector("[data-users-role]")?.addEventListener("change", (e) => {
      usersRoleFilter = e.target.value;
      usersListOpen = true; // show the result of the filter straight away
      renderRole(role);
    });
    body.querySelector("[data-users-sort]")?.addEventListener("change", (e) => {
      usersSort = e.target.value;
      renderRole(role);
    });
    body.querySelectorAll("[data-users-role-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        const r = b.dataset.usersRolePick;
        usersRoleFilter = usersRoleFilter === r ? "all" : r;
        usersListOpen = usersRoleFilter !== "all";
        renderRole(role);
      })
    );

    /* --- HPF administrators: create or promote a real database admin ---
       Repaints only its own panel, so the form doesn't jump away from under the
       person filling it in while the rest of the dashboard re-renders. */
    function renderAdmins() {
      const holder = body.querySelector("[data-admins-panel]");
      if (!holder) return;
      holder.outerHTML = adminAccountsPanel(ctx.user);
      wireAdminAccounts();
    }

    function wireAdminAccounts() {
      const panel = body.querySelector("[data-admins-panel]");
      if (!panel) return;

      panel.querySelector("[data-admin-add-toggle]")?.addEventListener("click", () => {
        adminFormOpen = !adminFormOpen;
        adminPromoteOpen = false;
        editAdminId = null;
        // The form lives inside the collapsible body, so opening it while the
        // panel is collapsed would click-and-nothing-visibly-happens.
        if (adminFormOpen) collapsedPanels.admins = false;
        renderAdmins();
        body.querySelector("#addAdminForm [name=fullName]")?.focus();
      });
      panel.querySelector("[data-admin-add-cancel]")?.addEventListener("click", () => {
        adminFormOpen = false;
        renderAdmins();
      });
      panel.querySelector("[data-admin-promote-toggle]")?.addEventListener("click", () => {
        adminPromoteOpen = !adminPromoteOpen;
        adminFormOpen = false;
        editAdminId = null;
        if (adminPromoteOpen) collapsedPanels.admins = false;
        renderAdmins();
        body.querySelector("#promoteAdminForm [name=email]")?.focus();
      });
      panel.querySelector("[data-admin-promote-cancel]")?.addEventListener("click", () => {
        adminPromoteOpen = false;
        renderAdmins();
      });
      panel.querySelector("[data-admins-retry]")?.addEventListener("click", async () => {
        adminsLoaded = false;
        renderAdmins();
        await loadAdmins();
        renderAdmins();
      });

      panel.querySelector("#addAdminForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const d = Object.fromEntries(new FormData(form).entries());
        const fullName = (d.fullName || "").trim();
        const email = (d.email || "").trim().toLowerCase();
        if (!fullName) return toast("Name required", "Enter the person's full name.", "error");
        if (!email.endsWith("@" + ORG_DOMAIN))
          return toast("HPF email required", `A staff account must use an @${ORG_DOMAIN} address.`, "error");

        const submit = form.querySelector("[type=submit]");
        if (submit) { submit.disabled = true; submit.textContent = "Sending…"; }
        try {
          await createStaffAccount({ fullName, email });
          adminFormOpen = false;
          await loadAdmins();
          renderAdmins();
          toast(
            "Invite sent",
            `${fullName} will get an email at ${email} with a link to set their password and sign in as HPF staff.`,
            "success"
          );
        } catch (err) {
          toast("Could not send invite", err.message, "error");
          if (submit) { submit.disabled = false; submit.innerHTML = `${icon("shield")} Send invite`; }
        }
      });

      panel.querySelector("#promoteAdminForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const email = (new FormData(form).get("email") || "").trim().toLowerCase();
        if (!email.includes("@")) return toast("Email required", "Enter the account's email address.", "error");

        const submit = form.querySelector("[type=submit]");
        if (submit) { submit.disabled = true; submit.textContent = "Promoting…"; }
        try {
          const rows = await findProfileByEmail(email);
          if (!rows.length) {
            throw new Error(`No account in the HPF database uses ${email}. They need to sign up first, or use "Add staff member" to create the account.`);
          }
          if (rows.length > 1) throw new Error(`More than one account uses ${email}. Sort that out in the Supabase dashboard first.`);
          const target = rows[0];
          if (target.role === "staff" || target.role === "admin")
            throw new Error(`${target.full_name || email} is already ${target.role === "admin" ? "an admin" : "staff"}.`);

          await promoteToStaff(target.id);
          adminPromoteOpen = false;
          await loadAdmins();
          renderAdmins();
          toast("Staff member added", `${target.full_name || email} now has full platform access.`, "success");
        } catch (err) {
          toast("Could not promote", err.message, "error");
          if (submit) { submit.disabled = false; submit.innerHTML = `${icon("userCheck")} Make staff`; }
        }
      });

      // Admin-only, one click: raise an existing Staff row to Admin. The
      // button itself is only ever rendered for an admin viewer (see
      // adminAccountsPanel), but the real gate is guard_profile_role() — a
      // staff viewer who forced this call anyway would just get refused.
      panel.querySelectorAll("[data-promote-to-admin]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const id = btn.dataset.promoteToAdmin;
          const row = adminsCache.find((a) => a.id === id);
          btn.disabled = true;
          try {
            await promoteToAdmin(id);
            await loadAdmins();
            renderAdmins();
            toast("Promoted to Admin", `${row?.full_name || "This account"} can now promote other staff to Admin too.`, "success");
          } catch (err) {
            btn.disabled = false;
            toast("Could not promote to Admin", err.message, "error");
          }
        })
      );

      // Admin-only (patch-16): rename or remove an existing Staff/Admin row.
      // Both buttons are only ever rendered for an admin viewer on someone
      // else's row (see adminAccountsPanel); the real gate is the "update
      // own" RLS policy — a staff viewer who forced either call anyway would
      // just get refused.
      panel.querySelectorAll("[data-edit-admin]").forEach((btn) =>
        btn.addEventListener("click", () => {
          editAdminId = btn.dataset.editAdmin;
          renderAdmins();
          panel.querySelector(`[data-edit-admin-form="${editAdminId}"] [name=fullName]`)?.focus();
        })
      );
      panel.querySelector("[data-edit-admin-cancel]")?.addEventListener("click", () => {
        editAdminId = null;
        renderAdmins();
      });
      panel.querySelectorAll("[data-edit-admin-form]").forEach((form) =>
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const id = form.dataset.editAdminForm;
          const fullName = (new FormData(form).get("fullName") || "").trim();
          if (!fullName) return toast("Name required", "Enter the person's full name.", "error");
          const submit = form.querySelector("[type=submit]");
          if (submit) { submit.disabled = true; submit.textContent = "Saving…"; }
          try {
            await renameStaffMember(id, fullName);
            editAdminId = null;
            await loadAdmins();
            renderAdmins();
            toast("Name updated", `${fullName} is saved.`, "success");
          } catch (err) {
            toast("Could not save", err.message, "error");
            if (submit) { submit.disabled = false; submit.textContent = "Save"; }
          }
        })
      );
      panel.querySelectorAll("[data-remove-admin]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const id = btn.dataset.removeAdmin;
          const name = btn.dataset.name;
          const ok = confirm(
            `Remove ${name} from Staff/Admin? This revokes their platform access — it does not ` +
            "delete their account or history. They'll land on Learner and need a proper role " +
            "assigned again if they should keep using the portal in another capacity."
          );
          if (!ok) return;
          btn.disabled = true;
          try {
            await removeStaffMember(id);
            await loadAdmins();
            renderAdmins();
            toast("Removed", `${name} is no longer Staff or Admin.`, "success");
          } catch (err) {
            btn.disabled = false;
            toast("Could not remove", err.message, "error");
          }
        })
      );
    }

    wireAdminAccounts();
    loadAdmins().then(renderAdmins);

    // Real role counts for "Users by role" (both here and the Scorecard's
    // Overview tab) and for computeAdminStats() generally — a full re-render
    // since profilesCache feeds panels in more than one place on this page.
    if (!profilesLoaded) loadProfiles().then(() => renderRole(role));

    /* --- Field officer assignments: who covers which school --- */
    function renderAssignments() {
      const holder = body.querySelector("[data-assignments-panel]");
      if (!holder) return;
      holder.outerHTML = officerAssignmentsPanel();
      wireOfficerAssignments();
    }

    function wireOfficerAssignments() {
      const panel = body.querySelector("[data-assignments-panel]");
      if (!panel) return;

      panel.querySelector("[data-assign-toggle]")?.addEventListener("click", () => {
        assignFormOpen = !assignFormOpen;
        if (assignFormOpen) collapsedPanels.assignments = false;
        renderAssignments();
      });
      panel.querySelector("[data-assign-cancel]")?.addEventListener("click", () => {
        assignFormOpen = false;
        renderAssignments();
      });
      panel.querySelector("[data-assignments-retry]")?.addEventListener("click", async () => {
        assignmentsLoaded = false;
        renderAssignments();
        await loadAssignments();
        renderAssignments();
      });

      panel.querySelector("#assignForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const d = Object.fromEntries(new FormData(form).entries());
        if (!d.officerId) return toast("Officer required", "Select which field officer to assign.", "error");
        if (!d.school) return toast("School required", "Select which school to assign them to.", "error");

        const submit = form.querySelector("[type=submit]");
        if (submit) { submit.disabled = true; submit.textContent = "Assigning…"; }
        const { error } = await supabase.from("school_officer_assignments")
          .insert({ officer_id: d.officerId, school: d.school, assigned_by: ctx.user.id });
        if (error) {
          if (submit) { submit.disabled = false; submit.innerHTML = `${icon("check")} Assign`; }
          if (error.code === "23505")
            return toast("Already assigned", "This officer already covers that school.", "error");
          return toast("Could not assign", authMessage(error), "error");
        }
        assignFormOpen = false;
        await loadAssignments();
        renderAssignments();
        toast("School assigned", "The officer can now file and see reports for this school on every device.", "success");
      });

      panel.querySelectorAll("[data-assign-remove]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const { error } = await supabase.from("school_officer_assignments")
            .delete().eq("id", btn.dataset.assignRemove);
          if (error) {
            btn.disabled = false;
            return toast("Could not remove assignment", authMessage(error), "error");
          }
          await loadAssignments();
          renderAssignments();
          toast("Assignment removed", "", "success");
        })
      );
    }

    wireOfficerAssignments();
    loadAssignments().then(renderAssignments);

    // --- devices (patch-13) ---
    function renderDevices() {
      const holder = body.querySelector("[data-devices-panel]");
      if (!holder) return;
      holder.outerHTML = devicesPanel();
      wireDevices();
    }
    function wireDevices() {
      const panel = body.querySelector("[data-devices-panel]");
      if (!panel) return;

      panel.querySelector("[data-device-add-toggle]")?.addEventListener("click", () => {
        deviceFormOpen = !deviceFormOpen;
        if (deviceFormOpen) collapsedPanels.devices = false;
        renderDevices();
      });
      panel.querySelector("[data-device-cancel]")?.addEventListener("click", () => {
        deviceFormOpen = false;
        renderDevices();
      });
      panel.querySelector("#deviceForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const d = Object.fromEntries(new FormData(form).entries());
        const submit = form.querySelector("[type=submit]");
        if (submit) { submit.disabled = true; submit.textContent = "Adding…"; }
        const { error } = await supabase.from("devices").insert({
          device_type: d.device_type, school_id: d.school_id,
          serial_number: d.serial_number || null, asset_tag: d.asset_tag || null,
        });
        if (error) {
          if (submit) { submit.disabled = false; submit.innerHTML = `${icon("check")} Add device`; }
          return toast("Could not add device", authMessage(error), "error");
        }
        deviceFormOpen = false;
        await loadDevices();
        renderDevices();
        toast("Device added", "", "success");
      });

      panel.querySelectorAll("[data-issue-toggle]").forEach((btn) =>
        btn.addEventListener("click", () => {
          issueFormDeviceId = btn.dataset.issueToggle;
          renderDevices();
        })
      );
      panel.querySelector("[data-issue-cancel]")?.addEventListener("click", () => {
        issueFormDeviceId = null;
        renderDevices();
      });
      panel.querySelectorAll("[data-issue-form]").forEach((form) =>
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const deviceId = form.dataset.issueForm;
          const issue = (new FormData(form).get("issue") || "").toString().trim();
          if (!issue) return;
          const submit = form.querySelector("[type=submit]");
          if (submit) submit.disabled = true;
          const { error } = await supabase.from("device_maintenance").insert({ device_id: deviceId, issue });
          if (error) {
            if (submit) submit.disabled = false;
            return toast("Could not report issue", authMessage(error), "error");
          }
          issueFormDeviceId = null;
          await loadDeviceIssues();
          renderDevices();
          toast("Issue reported", "", "success");
        })
      );
      panel.querySelectorAll("[data-issue-resolve]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const { error } = await supabase.from("device_maintenance")
            .update({ status: "resolved", resolved_at: new Date().toISOString() })
            .eq("id", btn.dataset.issueResolve);
          if (error) {
            btn.disabled = false;
            return toast("Could not resolve", authMessage(error), "error");
          }
          await loadDeviceIssues();
          renderDevices();
          toast("Issue resolved", "", "success");
        })
      );
    }
    wireDevices();

    // --- edit a user's full credentials (incl. password) ---
    body.querySelectorAll("[data-edit-user]").forEach((btn) =>
      btn.addEventListener("click", () => { editUserId = btn.dataset.editUser; renderRole(role); })
    );
    const closeEdit = () => { editUserId = null; renderRole(role); };
    body.querySelector("[data-edit-overlay]")?.addEventListener("click", (e) => { if (e.target.hasAttribute("data-edit-overlay")) closeEdit(); });
    body.querySelectorAll("[data-edit-close]").forEach((b) => b.addEventListener("click", closeEdit));
    body.querySelector("[data-editpw-toggle]")?.addEventListener("click", (e) => {
      const inp = body.querySelector("#editUserForm [name=password]");
      const on = inp.type === "password";
      inp.type = on ? "text" : "password";
      e.currentTarget.innerHTML = `${icon("eye")} ${on ? "Hide" : "Show"}`;
    });
    body.querySelector("[data-edit-save]")?.addEventListener("click", async () => {
      const form = body.querySelector("#editUserForm");
      const data = Object.fromEntries(new FormData(form).entries());
      if (!(data.fullName || "").trim()) return toast("Name required", "", "error");
      // Password is optional on an edit: a blank box means "leave it alone",
      // which is different from "set it to empty". Only validate a typed one.
      if (data.password && data.password.length < 6)
        return toast("Weak password", "Password must be at least 6 characters.", "error");

      const uid = form.dataset.uid;
      // Named to avoid shadowing wireAdmin's own `role` (the dashboard tab
      // being viewed) — they are different things, and re-rendering the page
      // as the *edited* user's new role would throw the viewer out of their
      // own workspace.
      let newRole = data.role;
      // An org email means HPF staff. Not admin: admin is only ever granted
      // deliberately, one row at a time, by an existing admin (patch-14).
      if ((data.email || "").trim().toLowerCase().endsWith("@" + ORG_DOMAIN) &&
          newRole !== "admin") newRole = "staff";

      const patch = {
        full_name: data.fullName.trim(),
        email: (data.email || "").trim() || null,
        username: (data.username || "").trim() || null,
        role: newRole,
        project: data.project || null,
        county: data.region || null,
        school: data.school || null,
      };

      /* Write to Postgres when this is a real account. RLS lets staff/admin
         update any profile, and guard_profile_role exempts is_staff() for every
         role change except granting admin, which needs is_admin() — so a staff
         viewer setting someone to "admin" here is silently reverted by the
         database rather than failing loudly. A local-only account has no row and
         falls through to the localStorage path unchanged. */
      const { data: authUser } = await supabase.auth.getUser();
      let wroteRemote = false;
      if (authUser?.user) {
        const me = authUser.user.id;
        if (uid === me && newRole !== "admin" && newRole !== "staff") {
          const ok = confirm(
            "This removes your own staff access. You will lose the staff dashboard " +
            "as soon as the page reloads, and only another staff member or admin can " +
            "restore it. Continue?"
          );
          if (!ok) return;
        }
        const { error, count } = await supabase
          .from("profiles").update(patch, { count: "exact" }).eq("id", uid).select("id");
        if (error) return toast("Could not save", authMessage(error), "error");
        wroteRemote = (count || 0) > 0;
      }

      // Mirror locally so legacy accounts and the open session stay consistent.
      const users = read(K_USERS, []);
      const u = users.find((x) => x.id === uid);
      if (u) {
        Object.assign(u, {
          fullName: patch.full_name, email: patch.email || "", username: patch.username || "",
          role: newRole, project: patch.project || "", region: patch.county || "", school: patch.school || "",
        });
        if (data.password) u.password = data.password;
        write(K_USERS, users);
      }
      const sess = read(K_SESSION, null);
      if (sess && sess.id === uid) {
        Object.assign(sess, {
          fullName: patch.full_name, email: patch.email || "", username: patch.username || "",
          role: newRole, project: patch.project || "", region: patch.county || "",
          county: patch.county || "", school: patch.school || "",
        });
        write(K_SESSION, sess);
      }

      editUserId = null;
      toast("User updated",
        wroteRemote ? `${patch.full_name} saved to the HPF database.`
                    : `${patch.full_name} saved in this browser only — no database account matches.`,
        wroteRemote ? "success" : "error");
      renderRole(role);
    });

    // --- digital library ---
    body.querySelector("[data-lib-toggle]")?.addEventListener("click", () => {
      adminLibOpen = !adminLibOpen;
      // Same reasoning as the admin add/promote forms: the "Add resource" form
      // lives inside the collapsible body, so open it visibly rather than
      // toggling a form nobody can see.
      if (adminLibOpen) collapsedPanels.library = false;
      renderRole(role);
    });
    body.querySelector("[data-lib-cancel]")?.addEventListener("click", () => {
      adminLibOpen = false;
      renderRole(role);
    });
    body.querySelectorAll("[data-lib-open]").forEach((b) =>
      b.addEventListener("click", () => openResource(getLibrary().find((r) => r.id === b.dataset.libOpen) || {}))
    );
    body.querySelectorAll("[data-lib-publish]").forEach((b) =>
      b.addEventListener("click", () => {
        const lib = getLibrary();
        const r = lib.find((x) => x.id === b.dataset.libPublish);
        if (r) { r.published = !r.published; saveLibrary(lib); toast(r.published ? "Published" : "Unpublished", `“${r.title}” is now ${r.published ? "available to teachers" : "hidden"}.`, "success"); }
        renderRole(role);
      })
    );
    body.querySelectorAll("[data-lib-delete]").forEach((b) =>
      b.addEventListener("click", () => {
        const lib = getLibrary();
        const r = lib.find((x) => x.id === b.dataset.libDelete);
        saveLibrary(lib.filter((x) => x.id !== b.dataset.libDelete));
        toast("Deleted", r ? `“${r.title}” removed from the library.` : "", "success");
        renderRole(role);
      })
    );
    body.querySelector("#libForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      const title = (data.title || "").trim();
      if (!title) return toast("Title required", "Give the resource a title.", "error");
      const fileInput = form.querySelector("[data-lib-file]");
      const file = fileInput?.files?.[0];

      const add = (extra) => {
        const lib = getLibrary();
        lib.unshift({
          id: uid(), title, category: data.category || "Other", type: data.type || "document",
          description: (data.description || "").trim(), url: (data.url || "").trim(),
          published: true, createdAt: Date.now(), ...extra,
        });
        saveLibrary(lib);
        adminLibOpen = false;
        toast("Added to library", `“${title}” is published and available to teachers.`, "success");
        renderRole(role);
      };

      if (file) {
        if (file.size > 800 * 1024) return toast("File too large", "Keep uploads under 800 KB, or paste a link instead.", "error");
        const reader = new FileReader();
        reader.onload = () => add({ dataUrl: reader.result, fileName: file.name });
        reader.readAsDataURL(file);
      } else if (!(data.url || "").trim()) {
        return toast("Add a link or file", "Paste a URL or choose a file to upload.", "error");
      } else {
        add({});
      }
    });
  }

  // Kolibri-style + school-leader interactions
  function wireRoleActions() {
    // Classes load from Postgres on first mount of the coach view specifically
    // — guarded on markup only that view renders (classSwitcher's "New class"
    // control), the same way schools/returns/field-reports guard their loads,
    // rather than on role, so this never fires a query for a view that isn't
    // showing this data.
    if (!classesLoaded && body.querySelector("[data-new-class-toggle]")) {
      loadClasses().then(() => {
        syncResults(); // background — whatever's pending doesn't block the render
        if (body.querySelector("[data-new-class-toggle]")) renderRole("teacher");
      });
    }
    body.querySelector("[data-classes-retry]")?.addEventListener("click", () => {
      classesLoaded = false;
      renderRole("teacher");
    });
    // Same "retry on reconnect" idea as the field officer's report outbox
    // (app.js) — a result recorded while offline just waits for the next
    // successful sync, whichever trigger gets there first.
    if (!resultsOnlineListenerAttached) {
      resultsOnlineListenerAttached = true;
      window.addEventListener("online", () => syncResults());
    }

    // sub-tabs (Learn: Home/Library/Bookmarks · Coach: Reports/Lessons/Quizzes/Learners)
    const subtabs = [...body.querySelectorAll("[data-subtab]")];
    subtabs.forEach((tab) =>
      tab.addEventListener("click", () => {
        const id = tab.dataset.subtab;
        subtabs.forEach((t) => t.classList.toggle("active", t === tab));
        body.querySelectorAll("[data-subpanel]").forEach((p) => {
          p.hidden = p.dataset.subpanel !== id;
        });
        runCounters();
      })
    );

    // learner Learning-Resources category nav (Digital Library / Numeracy / Literacy)
    const lrTabs = [...body.querySelectorAll("[data-lr-cat]")];
    lrTabs.forEach((tab) =>
      tab.addEventListener("click", () => {
        const id = tab.dataset.lrCat;
        lrTabs.forEach((t) => t.classList.toggle("active", t === tab));
        body.querySelectorAll("[data-lr-panel]").forEach((p) => {
          p.hidden = p.dataset.lrPanel !== id;
        });
      })
    );
    body.querySelectorAll("[data-lr-open]").forEach((b) =>
      b.addEventListener("click", () => {
        const r = findResource(b.dataset.lrOpen);
        if (r) openResource(r);
      })
    );

    // content cards — "open"/resume a resource (progress advances)
    body.querySelectorAll("[data-resource-id]").forEach((card) =>
      card.addEventListener("click", () => {
        const fill = card.querySelector("[data-kfill]");
        if (fill) {
          const pct = Math.min(100, (parseInt(fill.style.width, 10) || 0) + 20);
          fill.style.width = pct + "%";
          if (pct >= 100 && !card.querySelector(".kdone")) {
            const thumb = card.querySelector(".kthumb");
            thumb.insertAdjacentHTML("beforeend", `<span class="kdone">${icon("check")}</span>`);
          }
        }
        toast("Opening resource", `Resuming “${card.dataset.title}”.`);
      })
    );

    // learner class cards
    body.querySelectorAll(".kclass[data-class]").forEach((btn) =>
      btn.addEventListener("click", () => toast("Opening class", `“${btn.dataset.class}” lessons & quizzes.`))
    );

    // learner: join a live session started by their teacher
    body.querySelectorAll("[data-join-session]").forEach((btn) =>
      btn.addEventListener("click", () => {
        btn.innerHTML = `${icon("check")} Joined`;
        btn.disabled = true;
        toast("Session joined", `You're in “${btn.dataset.joinTitle}”. Work through it before your teacher ends the session.`, "success");
      })
    );

    // learner: collapse / expand the full assignments list
    body.querySelector("[data-la-toggle]")?.addEventListener("click", () => {
      learnerListOpen = !learnerListOpen;
      renderRole(document.querySelector(".role-tab.active")?.dataset.role || "learner");
    });

    // learner: open a resource shared by their teacher
    body.querySelectorAll("[data-learn-resource]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const cls = read(K_CLASSES, []).find((c) => c.id === btn.dataset.learnClass);
        const r = (cls?.resources || []).find((x) => x.id === btn.dataset.learnResource);
        if (r) openResource(r);
      })
    );

    // learner: take a live assessment (opens the auto-marked modal)
    body.querySelectorAll("[data-take-assess]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const uid2 = ctx?.user?.id;
        openAssessModal(btn.dataset.takeClass, btn.dataset.takeAssess, uid2, () => {
          const active = document.querySelector(".role-tab.active")?.dataset.role || "learner";
          renderRole(active);
        });
      })
    );

    // library: channel chips + search filter
    const grid = body.querySelector("[data-library-grid]");
    const chips = [...body.querySelectorAll("[data-channel].kchip")];
    const searchEl = body.querySelector("[data-library-search]");
    function filterLibrary() {
      if (!grid) return;
      const active = body.querySelector(".kchip.active")?.dataset.channel || "All";
      const q = (searchEl?.value || "").toLowerCase().trim();
      grid.querySelectorAll(".kcard").forEach((card) => {
        const okChan = active === "All" || card.dataset.channel === active;
        const okText = !q || card.dataset.title.toLowerCase().includes(q);
        card.style.display = okChan && okText ? "" : "none";
      });
    }
    chips.forEach((chip) =>
      chip.addEventListener("click", () => {
        chips.forEach((c) => c.classList.toggle("active", c === chip));
        filterLibrary();
      })
    );
    searchEl?.addEventListener("input", filterLibrary);

    // coach: tab switching (full re-render preserves builder/detail state)
    body.querySelectorAll("[data-coach-tab]").forEach((tab) =>
      tab.addEventListener("click", () => {
        coachState.tab = tab.dataset.coachTab;
        coachState.learnerId = null;
        coachState.openForm = false;
        renderRole("teacher");
      })
    );

    // Attendance: lazy-loaded per class, on entering the tab (or switching
    // classes while already on it) rather than at every mount — most
    // coaches never open it in a given session. Idempotent: re-runs on
    // every wire pass but only actually fetches once the cache no longer
    // matches the class currently in view.
    if (coachState.tab === "attendance") {
      const { cls: attendanceCls } = currentClass();
      if (attendanceCls && attendanceLoadedForClassId !== attendanceCls.id) {
        loadAttendance(attendanceCls.id).then(() => renderRole("teacher"));
      }
    }
    body.querySelector("[data-attendance-date]")?.addEventListener("change", (e) => {
      attendanceDate = e.target.value;
      renderRole("teacher");
    });
    body.querySelector("[data-attendance-retry]")?.addEventListener("click", () => {
      const { cls: retryCls } = currentClass();
      if (retryCls) attendanceLoadedForClassId = null; // force loadAttendance to re-run above
      renderRole("teacher");
    });
    body.querySelectorAll("[data-attendance-mark]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const { cls: markCls } = currentClass();
        if (!markCls) return;
        const learnerId = btn.dataset.learnerId;
        const status = btn.dataset.attendanceMark;
        const row = body.querySelector(`[data-attendance-row="${CSS.escape(learnerId)}"]`);
        row?.querySelectorAll("button").forEach((b) => (b.disabled = true));
        const { error } = await supabase.from("attendance_records")
          .upsert(
            { learner_id: learnerId, class_id: markCls.id, session_date: attendanceDate, status, recorded_by: ctx.user.id },
            { onConflict: "learner_id,class_id,session_date" }
          );
        if (error) {
          row?.querySelectorAll("button").forEach((b) => (b.disabled = false));
          return toast("Could not save attendance", authMessage(error), "error");
        }
        await loadAttendance(markCls.id);
        renderRole("teacher");
      })
    );

    // --- People tab: filter, collapse, enroll, edit users, reveal password ---
    body.querySelector("[data-people-grade]")?.addEventListener("change", (e) => {
      coachState.peopleGrade = e.target.value;
      renderRole("teacher");
    });
    body.querySelector("[data-people-toggle]")?.addEventListener("click", () => {
      coachState.peopleOpen = !coachState.peopleOpen;
      renderRole("teacher");
    });
    body.querySelector("[data-people-enroll]")?.addEventListener("click", () => {
      coachState.tab = "learners";
      coachState.openLearnerForm = true;
      renderRole("teacher");
    });
    body.querySelectorAll("[data-tpw-toggle]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const span = btn.parentElement.querySelector(".pw-mask");
        const shown = span.dataset.shown === "1";
        span.textContent = shown ? "••••••••" : span.dataset.pw;
        span.dataset.shown = shown ? "0" : "1";
      })
    );
    body.querySelectorAll("[data-tedit-user]").forEach((btn) =>
      btn.addEventListener("click", () => { coachState.editUserId = btn.dataset.teditUser; renderRole("teacher"); })
    );
    const tCloseEdit = () => { coachState.editUserId = null; renderRole("teacher"); };
    body.querySelector("[data-tedit-overlay]")?.addEventListener("click", (e) => { if (e.target.hasAttribute("data-tedit-overlay")) tCloseEdit(); });
    body.querySelectorAll("[data-tedit-close]").forEach((b) => b.addEventListener("click", tCloseEdit));
    body.querySelector("[data-teditpw-toggle]")?.addEventListener("click", (e) => {
      const inp = body.querySelector("#tEditForm [name=password]");
      const on = inp.type === "password";
      inp.type = on ? "text" : "password";
      e.currentTarget.innerHTML = `${icon("eye")} ${on ? "Hide" : "Show"}`;
    });
    body.querySelector("[data-tedit-save]")?.addEventListener("click", () => {
      const form = body.querySelector("#tEditForm");
      const data = Object.fromEntries(new FormData(form).entries());
      if (!(data.fullName || "").trim()) return toast("Name required", "", "error");
      if ((data.password || "").length < 6) return toast("Weak password", "Password must be at least 6 characters.", "error");
      const users = read(K_USERS, []);
      const u = users.find((x) => x.id === form.dataset.uid);
      if (!u) return tCloseEdit();
      Object.assign(u, { fullName: data.fullName.trim(), username: (data.username || "").trim(), password: data.password });
      write(K_USERS, users);
      const sess = read(K_SESSION, null);
      if (sess && sess.id === u.id) { const { password, ...safe } = u; write(K_SESSION, safe); }
      coachState.editUserId = null;
      toast("User updated", `${u.fullName}'s details were saved.`, "success");
      renderRole("teacher");
    });

    // Results tab: collapse / expand the per-student list
    body.querySelector("[data-results-toggle]")?.addEventListener("click", () => {
      coachState.resultsOpen = !coachState.resultsOpen;
      renderRole("teacher");
    });
    // header "Plan work" opens the Plan & Assign tab with the planner form open
    body.querySelector("[data-new-assign]")?.addEventListener("click", () => {
      coachState.tab = "assignments";
      coachState.openForm = true;
      renderRole("teacher");
    });
    // in-tab toggle reveals / hides the planner form
    body.querySelector("[data-new-assign-toggle]")?.addEventListener("click", () => {
      coachState.openForm = !coachState.openForm;
      coachState.editAssignId = null;
      renderRole("teacher");
    });
    body.querySelector("[data-assign-cancel]")?.addEventListener("click", () => {
      coachState.openForm = false;
      coachState.editAssignId = null;
      renderRole("teacher");
    });

    // preview / edit / delete a planned assignment
    body.querySelectorAll("[data-assign-preview]").forEach((el) =>
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        openAssignPreview(currentClass().cls.id, el.dataset.assignPreview);
      })
    );
    body.querySelectorAll("[data-assign-edit]").forEach((el) =>
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        coachState.editAssignId = el.dataset.assignEdit;
        coachState.openForm = true;
        renderRole("teacher");
      })
    );
    body.querySelectorAll("[data-assign-delete]").forEach((el) =>
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const { classes, cls } = currentClass();
        const a = cls.assignments.find((x) => x.id === el.dataset.assignDelete);
        if (!a) return;
        el.disabled = true;
        // FK is ON DELETE CASCADE, so the assignment's results go with it —
        // one delete, nothing orphaned (same as the class-delete note above).
        const { error } = await supabase.from("assignments").delete().eq("id", a.id);
        if (error) { el.disabled = false; return toast("Could not delete", authMessage(error), "error"); }
        cls.assignments = cls.assignments.filter((x) => x.id !== a.id);
        saveClasses(classes);
        if (coachState.editAssignId === a.id) coachState.editAssignId = null;
        toast("Deleted", `“${a.title}” was removed from ${cls.name}.`, "success");
        renderRole("teacher");
      })
    );

    // --- teacher: share a resource with learners ---
    body.querySelector("[data-share-resource-toggle]")?.addEventListener("click", () => {
      coachState.openResourceForm = !coachState.openResourceForm;
      renderRole("teacher");
    });
    body.querySelector("[data-share-resource-cancel]")?.addEventListener("click", () => {
      coachState.openResourceForm = false;
      renderRole("teacher");
    });
    body.querySelectorAll("[data-res-open]").forEach((b) =>
      b.addEventListener("click", () => {
        const r = (currentClass().cls.resources || []).find((x) => x.id === b.dataset.resOpen);
        if (r) openResource(r);
      })
    );
    body.querySelectorAll("[data-res-unshare]").forEach((b) =>
      b.addEventListener("click", () => {
        const { classes, cls } = currentClass();
        cls.resources = (cls.resources || []).filter((x) => x.id !== b.dataset.resUnshare);
        saveClasses(classes);
        toast("Removed", "Resource unshared from this class.", "success");
        renderRole("teacher");
      })
    );
    const resForm = body.querySelector("#resourceForm");
    const resClass = resForm?.querySelector("[data-res-class]");
    const resAudience = resForm?.querySelector("[data-res-audience]");
    const resPicker = resForm?.querySelector("[data-res-picker]");
    resAudience?.addEventListener("change", () => {
      if (resPicker) resPicker.hidden = resAudience.value !== "individual";
    });
    resClass?.addEventListener("change", () => {
      const target = getClasses().find((c) => c.id === resClass.value);
      const wrap = resPicker?.querySelector("[data-res-learners]");
      if (target && wrap)
        wrap.innerHTML = target.learners.map((l) => `<label class="lchk"><input type="checkbox" name="reslearner" value="${l.id}"> ${esc(l.name)}</label>`).join("");
    });
    resPicker?.addEventListener("change", (e) => {
      const boxes = [...resPicker.querySelectorAll('input[name="reslearner"]')];
      const master = resPicker.querySelector("[data-res-select-all]");
      if (e.target.matches("[data-res-select-all]")) boxes.forEach((b) => { b.checked = e.target.checked; });
      else if (e.target.name === "reslearner" && master) {
        master.checked = boxes.length > 0 && boxes.every((b) => b.checked);
        master.indeterminate = !master.checked && boxes.some((b) => b.checked);
      }
    });
    resForm?.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      const classes = getClasses();
      const target = classes.find((c) => c.id === data.classId) || classes[0];
      if (!target.learners.length) return toast("Class is empty", `“${target.name}” has no learners yet.`, "error");
      const audience = data.audience || "all";
      const targetIds = audience === "individual" ? [...form.querySelectorAll('input[name="reslearner"]:checked')].map((c) => c.value) : [];
      if (audience === "individual" && !targetIds.length) return toast("Pick learner(s)", "Select at least one learner, or choose Whole class.", "error");

      const finish = (base) => {
        target.resources = target.resources || [];
        target.resources.unshift({ id: uid(), audience, targetIds, sharedAt: Date.now(), ...base });
        saveClasses(classes);
        coachState.classId = target.id;
        coachState.openResourceForm = false;
        toast("Resource shared", `“${base.title}” is now in ${target.name} learners' portal.`, "success");
        renderRole("teacher");
      };

      // 1) from the digital library
      if (data.libId) {
        const lib = getLibrary().find((r) => r.id === data.libId);
        if (!lib) return toast("Resource not found", "", "error");
        return finish({ libId: lib.id, title: lib.title, type: lib.type, url: lib.url, dataUrl: lib.dataUrl, fileName: lib.fileName, description: lib.description });
      }
      // 2) a new resource — title required, plus a link or file
      const title = (data.title || "").trim();
      if (!title) return toast("Pick or name a resource", "Choose one from the library, or type a title for a new one.", "error");
      const fileInput = form.querySelector("[data-res-file]");
      const file = fileInput?.files?.[0];
      if (file) {
        if (file.size > 800 * 1024) return toast("File too large", "Keep uploads under 800 KB, or paste a link.", "error");
        const reader = new FileReader();
        reader.onload = () => finish({ title, type: data.type || "document", dataUrl: reader.result, fileName: file.name, url: "" });
        reader.readAsDataURL(file);
      } else if ((data.url || "").trim()) {
        finish({ title, type: data.type || "link", url: data.url.trim() });
      } else {
        toast("Add a link or file", "Paste a URL or upload a file for the new resource.", "error");
      }
    });
    // assign form: switching the target class rebuilds the learner picker
    const assignForm = body.querySelector("#assignForm");
    const classSel = assignForm?.querySelector("[data-assign-class]");
    const audienceSel = assignForm?.querySelector("[data-assign-audience]");
    const pickerWrap = assignForm?.querySelector("[data-assign-picker]");
    classSel?.addEventListener("change", () => {
      const target = getClasses().find((c) => c.id === classSel.value);
      if (target && pickerWrap) {
        pickerWrap.querySelector(".assign-learners").innerHTML = learnerChecklist(target.learners, false);
        const master = pickerWrap.querySelector("[data-select-all]");
        if (master) { master.checked = false; master.indeterminate = false; }
      }
    });
    audienceSel?.addEventListener("change", () => {
      if (pickerWrap) pickerWrap.hidden = audienceSel.value !== "individual";
    });
    // select all / unselect all learners in one click
    pickerWrap?.addEventListener("change", (e) => {
      const boxes = [...pickerWrap.querySelectorAll('input[name="learner"]')];
      const master = pickerWrap.querySelector("[data-select-all]");
      if (e.target.matches("[data-select-all]")) {
        boxes.forEach((b) => { b.checked = e.target.checked; });
      } else if (e.target.name === "learner" && master) {
        master.checked = boxes.length > 0 && boxes.every((b) => b.checked);
        master.indeterminate = !master.checked && boxes.some((b) => b.checked);
      }
    });

    assignForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      if (!(data.title || "").trim()) return toast("Title required", "Give the assignment a title.", "error");

      const submit = form.querySelector("[type=submit]");
      const busy = (msg) => { if (submit) { submit.disabled = true; submit.textContent = msg; } };
      const idle = (html) => { if (submit) { submit.disabled = false; submit.innerHTML = html; } };

      // --- edit mode: update the metadata of an existing assignment ---
      if (form.dataset.editing) {
        busy("Saving…");
        const { error } = await supabase.from("assignments").update({
          title: data.title.trim(), type: data.type || undefined,
          detail: (data.detail || "").trim(), due: (data.due || "").trim() || "no due date",
        }).eq("id", form.dataset.editing);
        idle(`${icon("check")} Save changes`);
        if (error) return toast("Could not save changes", authMessage(error), "error");

        const { classes, cls } = currentClass();
        const a = cls.assignments.find((x) => x.id === form.dataset.editing);
        if (a) {
          a.title = data.title.trim();
          a.type = data.type || a.type;
          a.detail = (data.detail || "").trim();
          a.due = (data.due || "").trim() || "no due date";
          saveClasses(classes);
        }
        coachState.editAssignId = null;
        coachState.openForm = false;
        toast("Changes saved", `“${data.title.trim()}” updated.`, "success");
        return renderRole("teacher");
      }

      const classes = getClasses();
      const withScore0 = data.type !== "lesson";
      const detail0 = (data.detail || "").trim() || (withScore0 ? "questions" : "resources");
      const due0 = (data.due || "").trim() || "no due date";
      const resultsFor = (learnerIds) => learnerIds.map((id) => (withScore0 ? { id, pct: 0, score: 0 } : { id, pct: 0 }));

      // --- assign to every grade in the teacher's school ---
      if (data.classId === "__all__") {
        const targets = scopedClasses().filter((c) => c.learners.length);
        if (!targets.length) return toast("No classes with learners", "Enroll learners first.", "error");
        busy("Creating…");
        const { data: rows, error } = await supabase.from("assignments").insert(
          targets.map((sc) => ({ class_id: sc.id, type: data.type || "lesson", title: data.title.trim(), detail: detail0, due: due0, session: "planned" }))
        ).select();
        idle(`${icon("send")} Create & assign`);
        if (error) return toast("Could not create assignment", authMessage(error), "error");

        rows.forEach((row) => {
          const c = classes.find((x) => x.id === row.class_id);
          c.assignments.unshift({
            id: row.id, type: row.type, title: row.title, detail: row.detail || "",
            due: row.due || "no due date", session: row.session,
            results: resultsFor(c.learners.map((l) => l.id)),
          });
        });
        saveClasses(classes);
        coachState.tab = "assignments";
        coachState.openForm = false;
        toast(`${ASSIGN_TYPES[data.type]?.label || "Work"} created`, `“${data.title.trim()}” assigned to all ${targets.length} grades${coachSchool() ? " in " + coachSchool() : ""}.`, "success");
        return renderRole("teacher");
      }

      const target = classes.find((c) => c.id === data.classId) || classes[0];
      if (!target.learners.length)
        return toast("Class is empty", `“${target.name}” has no learners yet — enroll some first.`, "error");

      const ids =
        data.audience === "individual"
          ? [...form.querySelectorAll('input[name="learner"]:checked')].map((c) => c.value)
          : target.learners.map((l) => l.id);
      if (!ids.length) return toast("No learners selected", "Pick at least one learner.", "error");

      busy("Creating…");
      const { data: row, error } = await supabase.from("assignments").insert({
        class_id: target.id, type: data.type || "lesson", title: data.title.trim(), detail: detail0, due: due0, session: "planned",
      }).select().single();
      idle(`${icon("send")} Create & assign`);
      if (error) return toast("Could not create assignment", authMessage(error), "error");

      target.assignments.unshift({
        id: row.id, type: row.type, title: row.title, detail: row.detail || "",
        due: row.due || "no due date", session: row.session,
        results: resultsFor(ids),
      });
      saveClasses(classes);
      coachState.classId = target.id;
      coachState.tab = "assignments";
      coachState.openForm = false; // close the planner; the new item shows in the list below
      toast(
        `${ASSIGN_TYPES[data.type]?.label || "Work"} created`,
        `“${data.title.trim()}” assigned to ${data.audience === "individual" ? `${ids.length} learner${ids.length === 1 ? "" : "s"}` : `the whole of ${target.name}`}.`,
        "success"
      );
      renderRole("teacher");
    });
    body.querySelectorAll("[data-learner-open]").forEach((row) =>
      row.addEventListener("click", () => {
        coachState.tab = "learners";
        coachState.learnerId = row.dataset.learnerOpen;
        renderRole("teacher");
      })
    );
    body.querySelector("[data-learner-back]")?.addEventListener("click", () => {
      coachState.learnerId = null;
      renderRole("teacher");
    });

    // coach: switch between classes
    body.querySelectorAll("[data-class-switch]").forEach((chip) =>
      chip.addEventListener("click", () => {
        coachState.classId = chip.dataset.classSwitch;
        coachState.learnerId = null;
        coachState.openForm = false;
        coachState.openLearnerForm = false;
        renderRole("teacher");
      })
    );

    // coach: create a class / grade
    body.querySelector("[data-new-class-toggle]")?.addEventListener("click", () => {
      coachState.openClassForm = !coachState.openClassForm;
      renderRole("teacher");
    });
    body.querySelector("[data-class-cancel]")?.addEventListener("click", () => {
      coachState.openClassForm = false;
      renderRole("teacher");
    });
    body.querySelector("#newClassForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = new FormData(form);
      const name = (fd.get("name") || "").trim();
      const school = fd.get("school") || "";
      if (!name) return toast("Name required", "Give the class a name, e.g. Grade 4 — Red.", "error");
      if (!school) return toast("School required", "Pick the HPF-supported school this class belongs to.", "error");
      const classes = getClasses();
      if (classes.some((c) => c.name.toLowerCase() === name.toLowerCase()))
        return toast("Duplicate class", `A class called “${name}” already exists.`, "error");

      if (!classesAuthed) {
        // A local-only or legacy account has no JWT, so this can never reach
        // Postgres — say so plainly rather than pretending it saved (the same
        // messaging already used for legacy sign-ins and school returns).
        return toast(
          "Cannot save to the HPF database",
          "This account is signed in locally only. Ask an HPF administrator to create your account under Authentication → Users.",
          "error"
        );
      }

      const btn = form.querySelector("[type=submit]");
      if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

      const { data, error } = await supabase
        .from("classes")
        .insert({ name, school, owner_id: coachUser.id })
        .select().single();

      if (error) {
        if (btn) { btn.disabled = false; btn.textContent = "Create class"; }
        return toast("Could not create class", authMessage(error), "error");
      }

      const cls = { id: data.id, name: data.name, school: data.school, ownerId: data.owner_id,
        learners: [], assignments: [], assessments: [] };
      classes.push(cls);
      classesCache.push(cls);
      saveClasses(classes);
      coachState.classId = cls.id;
      coachState.openClassForm = false;
      coachState.tab = "learners";
      coachState.openLearnerForm = true;
      toast("Class created", `“${name}” is ready — now add learners to it.`, "success");
      renderRole("teacher");
    });

    // coach: enroll a learner into the current class
    body.querySelector("[data-add-learner-toggle]")?.addEventListener("click", () => {
      coachState.openLearnerForm = !coachState.openLearnerForm;
      renderRole("teacher");
    });
    body.querySelector("[data-add-learner-cancel]")?.addEventListener("click", () => {
      coachState.openLearnerForm = false;
      renderRole("teacher");
    });
    body.querySelector("#addLearnerForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      const { classes, cls } = currentClass();
      const has = (name) => cls.learners.some((l) => l.name.toLowerCase() === name.toLowerCase());

      // Collect every row this submission wants to add first, then insert
      // them in one request — a bulk paste of 30 names should be one round
      // trip, not thirty.
      const rows = []; // { name, is_account, learner_id }
      let skipped = 0;
      const seenThisSubmit = new Set();
      const willAdd = (name) => {
        const key = name.toLowerCase();
        if (has(name) || seenThisSubmit.has(key)) return false;
        seenThisSubmit.add(key);
        return true;
      };

      // 1) enroll a registered portal account
      let acctName = null;
      if (data.userId) {
        const u = read(K_USERS, []).find((x) => x.id === data.userId);
        if (!u) return toast("Account not found", "", "error");
        acctName = u.fullName || u.username;
        if (willAdd(acctName))
          // learner_id stays null even here: local learner accounts have no
          // matching row in profiles (they never sign up through Supabase
          // Auth — see isLearnerRole), so there is no id enrollments.learner_id
          // could validly reference. The account link is by name only, same
          // as a roster-only entry, just flagged is_account for the UI.
          rows.push({ name: acctName, is_account: true, _localId: u.id });
        else skipped++;
      }

      // 2) single name field
      const single = (data.name || "").trim();
      if (single) {
        if (willAdd(single)) rows.push({ name: single, is_account: false });
        else skipped++;
      }

      // 3) bulk paste — split on newlines, commas or semicolons
      (data.bulk || "")
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((name) => {
          if (willAdd(name)) rows.push({ name, is_account: false });
          else skipped++;
        });

      if (!rows.length && !skipped) return toast("Nothing to add", "Pick an account, type a name, or paste a list.", "error");
      if (!rows.length) return toast("All duplicates", `Everyone you listed is already in ${cls.name}.`, "error");

      if (!classesAuthed) {
        return toast(
          "Cannot save to the HPF database",
          "This account is signed in locally only. Ask an HPF administrator to create your account under Authentication → Users.",
          "error"
        );
      }

      const btn = form.querySelector("[type=submit]");
      if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }

      // A real learners row per name-only entry, so attendance (patch-18+)
      // and any future per-learner record has something valid to reference
      // — learners.id never needed a profiles row, unlike the old reasoning
      // above assumed before this table existed. Best-effort: learners' RLS
      // scopes a write by the inserting teacher's OWN profile.school
      // matching, not by class ownership, so this can fail for a mismatched
      // profile without that being a reason to block the roster entry
      // itself — learner_id just stays null then, exactly as it always has.
      const nameOnlyRows = rows.filter((r) => !r.is_account);
      if (nameOnlyRows.length) {
        const { data: school } = await supabase.from("schools").select("id").eq("name", cls.school).maybeSingle();
        if (school?.id) {
          const { data: newLearners, error: learnerErr } = await supabase
            .from("learners")
            .insert(nameOnlyRows.map((r) => ({ full_name: r.name, school_id: school.id })))
            .select();
          if (learnerErr) console.warn("Could not create learners rows (roster entry still added, just without one):", learnerErr.message);
          else newLearners.forEach((l, i) => { nameOnlyRows[i].learner_id = l.id; });
        }
      }

      const { data: inserted, error } = await supabase
        .from("enrollments")
        .insert(rows.map((r) => ({ class_id: cls.id, name: r.name, is_account: r.is_account, learner_id: r.learner_id ?? null })))
        .select();

      if (error) {
        if (btn) { btn.disabled = false; btn.textContent = "Add learner"; }
        return toast("Could not add learners", authMessage(error), "error");
      }

      inserted.forEach((e, i) => {
        const src = rows[i];
        cls.learners.push({
          id: src._localId || src.learner_id || e.id, name: e.name, active: e.active_label || "just now",
          account: e.is_account, _enrollmentId: e.id,
        });
      });
      // `cls` came from a fresh JSON.parse of localStorage (getClasses(), inside
      // currentClass()), a different object than what's in classesCache — the
      // in-memory push above only touched this copy, so both the cache and the
      // on-disk array need the same swap explicitly.
      const cacheIdx = classesCache.findIndex((c) => c.id === cls.id);
      if (cacheIdx !== -1) classesCache[cacheIdx] = cls;
      saveClasses(classes.map((c) => (c.id === cls.id ? cls : c)));

      coachState.openLearnerForm = false;
      const added = rows.length, lastName = rows[rows.length - 1].name;
      const msg = added === 1 ? `${lastName} enrolled in ${cls.name}.` : `${added} learners enrolled in ${cls.name}.`;
      toast("Learners added", skipped ? `${msg} (${skipped} duplicate${skipped === 1 ? "" : "s"} skipped.)` : msg, "success");
      renderRole("teacher");
    });

    // coach: remove a learner from the class (also strips their results)
    body.querySelectorAll("[data-learner-remove]").forEach((btn) =>
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.learnerRemove;
        const { classes, cls } = currentClass();
        const l = cls.learners.find((x) => x.id === id);
        if (!l) return;

        // A roster entry from before this migration (or added while signed in
        // locally) has no Postgres row to delete — remove it locally only,
        // same as it always worked, rather than failing on a delete that
        // was never going to find anything.
        if (l._enrollmentId) {
          btn.disabled = true;
          const { error } = await supabase.from("enrollments").delete().eq("id", l._enrollmentId);
          if (error) {
            btn.disabled = false;
            return toast("Could not remove learner", authMessage(error), "error");
          }
        }

        cls.learners = cls.learners.filter((x) => x.id !== id);
        cls.assignments.forEach((a) => {
          a.results = a.results.filter((r) => r.id !== id);
        });
        const cacheIdx = classesCache.findIndex((c) => c.id === cls.id);
        if (cacheIdx !== -1) classesCache[cacheIdx] = cls;
        saveClasses(classes.map((c) => (c.id === cls.id ? cls : c)));
        toast("Learner removed", `${l.name} removed from ${cls.name}.`, "success");
        renderRole("teacher");
      })
    );

    // coach: add a user — role dropdown toggles the email/username fields.
    // wireRoleActions runs for every role, so these must only ever match the
    // coach panel's own controls — never the admin dashboard's Add user button.
    body.querySelector("[data-coach-user-toggle]")?.addEventListener("click", () => {
      coachState.openUserForm = !coachState.openUserForm;
      renderRole("teacher");
    });
    body.querySelector("[data-coach-user-cancel]")?.addEventListener("click", () => {
      coachState.openUserForm = false;
      renderRole("teacher");
    });
    const addUserFormEl = body.querySelector("#coachAddUserForm");
    const roleSel = addUserFormEl?.querySelector("[data-adduser-role]");
    roleSel?.addEventListener("change", () => {
      const learner = roleSel.value === "learner";
      addUserFormEl.querySelector("[data-adduser-email]").hidden = learner;
      addUserFormEl.querySelector("[data-adduser-username]").hidden = !learner;
      const hint = addUserFormEl.querySelector("[data-adduser-hint]");
      hint.innerHTML = learner
        ? `Learners sign in with a username and are enrolled in <strong>${esc(currentClass().cls.name)}</strong>. School is optional.`
        : `Teachers sign in with email. A school is required.`;
    });
    addUserFormEl?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      const fullName = (data.fullName || "").trim();
      const role = data.role === "learner" ? "learner" : "teacher";
      if (!fullName) return toast("Name required", "Enter the person's full name.", "error");
      if ((data.password || "").length < 6) return toast("Weak password", "Password must be at least 6 characters.", "error");

      const users = read(K_USERS, []);

      if (role === "teacher") {
        const email = (data.email || "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Valid email required", "Teachers sign in with an email.", "error");
        if (!data.school || !SCHOOLS.includes(data.school)) return toast("School required", "Choose the teacher's school.", "error");

        // Created on an isolated client: signUp() authenticates the new user on
        // whichever client issues it, which would otherwise sign the admin out
        // mid-task.
        const submit = form.querySelector("[type=submit]");
        if (submit) submit.disabled = true;
        const { data: res, error } = await adminClient().auth.signUp({
          email,
          password: data.password,
          options: {
            data: {
              full_name: fullName,
              role: "teacher",
              school: data.school,
              username: null, county: null, org_type: null,
            },
          },
        });
        if (submit) submit.disabled = false;
        if (error) return toast("Could not add teacher", authMessage(error), "error");
        if (!res.user) return toast("Could not add teacher", "No account was returned.", "error");

        coachState.openUserForm = false;
        toast("Teacher added", `${fullName} added as a teacher at ${data.school}.`, "success");
        return renderRole("teacher");
      }

      // learner: username + password, auto-enrolled in the current class
      const username = (data.username || "").trim();
      if (username.length < 3) return toast("Username required", "Learners sign in with a username (3+ characters).", "error");
      if (users.some((u) => (u.username || "").toLowerCase() === username.toLowerCase()))
        return toast("Duplicate username", "That username is already taken.", "error");
      const id = uid();
      users.push({ id, fullName, role: "learner", username, password: data.password, school: data.school || "", orgType: "", county: "", createdAt: Date.now() });
      write(K_USERS, users);
      // enroll the new learner account into the current class
      const { classes, cls } = currentClass();
      cls.learners.push({ id, name: fullName, active: "just now", account: true });
      saveClasses(classes);
      coachState.openUserForm = false;
      toast("Learner added", `${fullName} created and enrolled in ${cls.name}.`, "success");
      renderRole("teacher");
    });

    // coach: start / end a live session on an assignment
    body.querySelectorAll("[data-session-toggle]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const { classes, cls } = currentClass();
        const a = cls.assignments.find((x) => x.id === btn.dataset.sessionToggle);
        if (!a) return;
        const startingUp = sessionOf(a) !== "active";
        btn.disabled = true;
        const { error } = await supabase.from("assignments").update({ session: startingUp ? "active" : "ended" }).eq("id", a.id);
        btn.disabled = false;
        if (error) return toast("Could not update session", authMessage(error), "error");
        if (startingUp) {
          a.session = "active";
          a.startedAt = Date.now();
          toast("Session started", `“${a.title}” is now live for ${cls.name} learners.`, "success");
        } else {
          a.session = "ended";
          a.endedAt = Date.now();
          toast("Session ended", `“${a.title}” is closed — learners can no longer join.`, "success");
        }
        saveClasses(classes);
        renderRole("teacher");
      })
    );

    // coach: assessment builder — open/close, add/remove questions
    body.querySelector("[data-new-assess-toggle]")?.addEventListener("click", () => {
      coachState.openAssessForm = !coachState.openAssessForm;
      renderRole("teacher");
    });
    body.querySelector("[data-assess-cancel]")?.addEventListener("click", () => {
      coachState.openAssessForm = false;
      renderRole("teacher");
    });
    const qContainer = body.querySelector("#assessQuestions");
    const renumberQ = () =>
      qContainer?.querySelectorAll("[data-qblock]").forEach((b, i) => {
        b.querySelector("[data-qn]").textContent = i + 1;
      });
    body.querySelector("[data-add-question]")?.addEventListener("click", () => {
      const n = qContainer.querySelectorAll("[data-qblock]").length + 1;
      qContainer.insertAdjacentHTML("beforeend", questionBlock(n, "correct-" + uid()));
    });
    qContainer?.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-remove-q]");
      if (!rm) return;
      if (qContainer.querySelectorAll("[data-qblock]").length <= 1)
        return toast("Keep at least one question", "An assessment needs a question.", "error");
      rm.closest("[data-qblock]").remove();
      renumberQ();
    });
    body.querySelector("#assessForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const title = form.querySelector('[name="title"]').value.trim();
      if (!title) return toast("Title required", "Give the assessment a title.", "error");
      const blocks = [...form.querySelectorAll("[data-qblock]")];
      const questions = [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const text = b.querySelector("[data-qtext]").value.trim();
        const rawOpts = [...b.querySelectorAll("[data-opt]")].map((o) => o.value.trim());
        const checkedEl = b.querySelector("[data-correct]:checked");
        const correctRaw = checkedEl ? +checkedEl.value : -1;
        if (!text) return toast(`Question ${i + 1} needs text`, "Type the question.", "error");
        const kept = []; let correct = -1;
        rawOpts.forEach((o, oi) => { if (o) { if (oi === correctRaw) correct = kept.length; kept.push(o); } });
        if (kept.length < 2) return toast(`Question ${i + 1} needs 2+ options`, "Fill at least two options.", "error");
        if (correct < 0) return toast(`Mark the answer for question ${i + 1}`, "The correct option can't be blank.", "error");
        questions.push({ text, options: kept, correct });
      }
      const { classes, cls } = currentClass();

      const submit = form.querySelector("[type=submit]");
      if (submit) { submit.disabled = true; submit.textContent = "Saving…"; }

      const { data: assessRow, error: assessErr } = await supabase.from("assessments").insert({
        class_id: cls.id, title, session: "planned", published: false, audience: "all", target_ids: [],
      }).select().single();
      if (assessErr) {
        if (submit) { submit.disabled = false; submit.innerHTML = `${icon("check")} Save assessment`; }
        return toast("Could not create assessment", authMessage(assessErr), "error");
      }

      const { data: qRows, error: qErr } = await supabase.from("questions").insert(
        questions.map((q, i) => ({ assessment_id: assessRow.id, position: i, text: q.text, options: q.options, correct: q.correct }))
      ).select().order("position");
      if (qErr) {
        // The assessment shell exists in Postgres but has no questions — delete
        // it rather than leave a half-created draft the teacher never asked for.
        await supabase.from("assessments").delete().eq("id", assessRow.id);
        if (submit) { submit.disabled = false; submit.innerHTML = `${icon("check")} Save assessment`; }
        return toast("Could not save the questions", authMessage(qErr), "error");
      }

      cls.assessments.unshift({
        id: assessRow.id, title: assessRow.title, session: assessRow.session,
        published: assessRow.published, audience: assessRow.audience, targetIds: assessRow.target_ids || [],
        questions: qRows.map((q) => ({ id: q.id, text: q.text, options: q.options, correct: q.correct })),
        submissions: [],
      });
      saveClasses(classes);
      coachState.openAssessForm = false;
      coachState.publishId = assessRow.id; // open the publish dialog right away
      toast("Assessment saved", `“${title}” (${questions.length} questions) is a draft — publish it to a class or learners.`, "success");
      renderRole("teacher");
    });

    // coach: analyze / delete / simulate / start-end session on an assessment
    body.querySelectorAll("[data-analyze]").forEach((btn) =>
      btn.addEventListener("click", () => {
        coachState.analyzeId = coachState.analyzeId === btn.dataset.analyze ? null : btn.dataset.analyze;
        renderRole("teacher");
      })
    );
    body.querySelectorAll("[data-remove-assess]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const { classes, cls } = currentClass();
        btn.disabled = true;
        // ON DELETE CASCADE on both questions and submissions — one delete.
        const { error } = await supabase.from("assessments").delete().eq("id", btn.dataset.removeAssess);
        if (error) { btn.disabled = false; return toast("Could not delete", authMessage(error), "error"); }
        cls.assessments = cls.assessments.filter((x) => x.id !== btn.dataset.removeAssess);
        saveClasses(classes);
        toast("Assessment deleted", "", "success");
        renderRole("teacher");
      })
    );
    body.querySelectorAll("[data-sim-assess]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const { classes, cls } = currentClass();
        const a = cls.assessments.find((x) => x.id === btn.dataset.simAssess);
        if (!a) return;
        if (!cls.learners.length) return toast("No learners", "Enroll learners first.", "error");
        const before = a.submissions.length;
        simulateAssessment(a, cls);
        saveClasses(classes);
        coachState.analyzeId = a.id;
        const added = a.submissions.length - before;
        toast("Responses simulated", added ? `${added} demo submission${added === 1 ? "" : "s"} auto-marked.` : "Everyone already submitted.", "success");
        renderRole("teacher");
      })
    );
    body.querySelectorAll("[data-assess-session]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const { classes, cls } = currentClass();
        const a = cls.assessments.find((x) => x.id === btn.dataset.assessSession);
        if (!a) return;
        const startingUp = (a.session || "planned") !== "active";
        const nextSession = startingUp ? "active" : "ended";
        btn.disabled = true;
        const { error } = await supabase.from("assessments").update({ session: nextSession }).eq("id", a.id);
        btn.disabled = false;
        if (error) return toast("Could not update session", authMessage(error), "error");
        if (startingUp) {
          a.session = "active"; a.startedAt = Date.now();
          toast("Session started", `“${a.title}” is live — ${cls.name} learners can take it.`, "success");
        } else {
          a.session = "ended"; a.endedAt = Date.now();
          toast("Session ended", `“${a.title}” is closed.`, "success");
        }
        saveClasses(classes);
        renderRole("teacher");
      })
    );

    // coach: publish an assessment to a grade/class or individuals
    body.querySelectorAll("[data-publish-toggle]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.dataset.publishToggle;
        coachState.publishId = coachState.publishId === id ? null : id;
        renderRole("teacher");
      })
    );
    body.querySelector("[data-publish-cancel]")?.addEventListener("click", () => {
      coachState.publishId = null;
      renderRole("teacher");
    });
    // publish dialog: School → Grade cascade auto-fills the class's learners
    const pubForm = body.querySelector("[data-publish-form]");
    const pubSchool = pubForm?.querySelector("[data-publish-school]");
    const pubClass = pubForm?.querySelector("[data-publish-class]");
    const pubAudience = pubForm?.querySelector("[data-publish-audience]");
    const pubPicker = pubForm?.querySelector("[data-publish-picker]");

    function rebuildRoster() {
      if (!pubPicker) return;
      const target = getClasses().find((c) => c.id === pubClass.value);
      const audience = pubAudience.value;
      pubPicker.querySelector("[data-publish-learners]").innerHTML = target
        ? rosterHtml(target.learners, audience, [])
        : `<span class="hint">Pick a grade/class.</span>`;
      pubPicker.querySelector("[data-roster-name]").textContent = target ? target.name : "—";
      pubPicker.querySelector("[data-roster-count]").textContent = target ? ` · ${target.learners.length} enrolled` : "";
      const sa = pubPicker.querySelector("[data-selectall-wrap]");
      if (sa) sa.style.display = audience === "individual" ? "" : "none";
      const master = pubPicker.querySelector("[data-publish-select-all]");
      if (master) { master.checked = false; master.indeterminate = false; }
    }

    // choosing a school filters the grade dropdown to that school's classes
    pubSchool?.addEventListener("change", () => {
      const grades = getClasses().filter((c) => c.school === pubSchool.value);
      pubClass.innerHTML = grades.length
        ? grades.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.learners.length})</option>`).join("")
        : `<option value="">— no classes in this school —</option>`;
      rebuildRoster();
    });
    pubClass?.addEventListener("change", rebuildRoster);
    pubAudience?.addEventListener("change", rebuildRoster);
    pubPicker?.addEventListener("change", (e) => {
      const boxes = [...pubPicker.querySelectorAll('input[name="ptarget"]')];
      const master = pubPicker.querySelector("[data-publish-select-all]");
      if (e.target.matches("[data-publish-select-all]")) {
        boxes.forEach((b) => { b.checked = e.target.checked; });
      } else if (e.target.name === "ptarget" && master) {
        master.checked = boxes.length > 0 && boxes.every((b) => b.checked);
        master.indeterminate = !master.checked && boxes.some((b) => b.checked);
      }
    });
    body.querySelector("[data-publish-form]")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const assessId = form.dataset.publishForm;
      const classId = form.querySelector("[data-publish-class]").value;
      const audience = form.querySelector("[data-publish-audience]").value;
      const ids = [...form.querySelectorAll('input[name="ptarget"]:checked')].map((c) => c.value);

      const classes = getClasses();
      const target = classes.find((c) => c.id === classId);
      if (!target) return toast("Pick a class", "Choose the grade/class to publish to.", "error");
      if (!target.learners.length) return toast("Class is empty", `“${target.name}” has no learners — enroll some first.`, "error");
      if (audience === "individual" && !ids.length) return toast("Pick learner(s)", "Select at least one learner, or choose Whole class.", "error");

      const targetIds = audience === "individual" ? ids : [];
      const submit = form.querySelector("[type=submit]");
      if (submit) submit.disabled = true;
      const { error } = await supabase.from("assessments").update({
        class_id: target.id, published: true, audience, target_ids: targetIds, session: "active",
      }).eq("id", assessId);
      if (submit) submit.disabled = false;
      if (error) return toast("Could not publish", authMessage(error), "error");

      // detach the assessment from whichever class currently holds it locally
      let assessment;
      classes.forEach((c) => {
        const i = c.assessments.findIndex((x) => x.id === assessId);
        if (i > -1) { assessment = c.assessments[i]; c.assessments.splice(i, 1); }
      });
      if (!assessment) return;

      assessment.published = true;
      assessment.audience = audience;
      assessment.targetIds = targetIds;
      assessment.session = "active";
      assessment.startedAt = Date.now();
      target.assessments.unshift(assessment);

      saveClasses(classes);
      coachState.classId = target.id; // follow the assessment to its class
      coachState.publishId = null;
      const who = audience === "individual" ? `${ids.length} learner${ids.length === 1 ? "" : "s"}` : `all of ${target.name}`;
      toast("Assessment published", `“${assessment.title}” is now live for ${who}.`, "success");
      renderRole("teacher");
    });

    // coach: downloadable results (CSV / Excel / PDF)
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    function downloadBlob(blob, filename) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    body.querySelector("[data-export-csv]")?.addEventListener("click", () => {
      const { cls } = currentClass();
      const { header, rows } = buildResultRows(cls);
      const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
      // BOM so Excel opens the UTF-8 CSV with accents intact
      const csv = "﻿" + [header, ...rows].map((r) => r.map(q).join(",")).join("\r\n");
      downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${slug(cls.name)}-results.csv`);
      toast("CSV downloaded", `Results for ${cls.name} (${rows.length} students).`, "success");
    });
    body.querySelector("[data-export-xls]")?.addEventListener("click", () => {
      const { cls } = currentClass();
      const { header, rows } = buildResultRows(cls);
      const cell = (v, tag) => `<${tag} style="border:1px solid #ccc;padding:4px 8px">${esc(String(v))}</${tag}>`;
      const html = `<html><head><meta charset="utf-8"></head><body>
        <h3>${esc(cls.name)} — ${esc(cls.school || "")} · Results</h3>
        <table border="1"><tr>${header.map((h) => cell(h, "th")).join("")}</tr>
        ${rows.map((r) => `<tr>${r.map((v) => cell(v, "td")).join("")}</tr>`).join("")}</table></body></html>`;
      downloadBlob(new Blob([html], { type: "application/vnd.ms-excel" }), `${slug(cls.name)}-results.xls`);
      toast("Excel downloaded", `Results for ${cls.name} (${rows.length} students).`, "success");
    });
    body.querySelector("[data-export-pdf]")?.addEventListener("click", () => {
      const { cls } = currentClass();
      const { header, rows } = buildResultRows(cls);
      const w = window.open("", "_blank");
      if (!w) return toast("Popup blocked", "Allow popups for this site to export PDF.", "error");
      w.document.write(`<html><head><title>${esc(cls.name)} — Results</title><style>
        body{font-family:system-ui,sans-serif;padding:24px;color:#111}
        h1{font-size:18px;margin:0} p{color:#555;margin:4px 0 16px;font-size:13px}
        table{border-collapse:collapse;width:100%;font-size:12px}
        th,td{border:1px solid #bbb;padding:5px 8px;text-align:left;vertical-align:top}
        th{background:#eef3ee}
        @media print{@page{size:landscape;margin:12mm}}
      </style></head><body>
        <h1>Human Practice Foundation — ${esc(cls.name)} results</h1>
        <p>${esc(cls.school || "")} · ${rows.length} students · generated ${new Date().toLocaleDateString()}</p>
        <table><tr>${header.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>
        ${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(String(v))}</td>`).join("")}</tr>`).join("")}</table>
        <script>window.onload=()=>window.print()</` + `script></body></html>`);
      w.document.close();
      toast("PDF export", "Choose “Save as PDF” in the print dialog.", "success");
    });

    // coach: downloadable ASSESSMENT results (auto-marked) — CSV / Excel / PDF
    const assessOf = (id) => currentClass().cls.assessments.find((x) => x.id === id);
    body.querySelectorAll("[data-assess-csv]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const a = assessOf(btn.dataset.assessCsv); if (!a) return;
        const { header, rows } = buildAssessmentRows(a);
        const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
        const csv = "﻿" + [header, ...rows].map((r) => r.map(q).join(",")).join("\r\n");
        downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${slug(a.title)}-results.csv`);
        toast("CSV downloaded", `${a.title} — ${rows.length} submission${rows.length === 1 ? "" : "s"}.`, "success");
      })
    );
    body.querySelectorAll("[data-assess-xls]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const a = assessOf(btn.dataset.assessXls); if (!a) return;
        const { header, rows } = buildAssessmentRows(a);
        const cell = (v, tag) => `<${tag} style="border:1px solid #ccc;padding:4px 8px">${esc(String(v))}</${tag}>`;
        const html = `<html><head><meta charset="utf-8"></head><body>
          <h3>${esc(a.title)} · auto-marked results</h3>
          <table border="1"><tr>${header.map((h) => cell(h, "th")).join("")}</tr>
          ${rows.map((r) => `<tr>${r.map((v) => cell(v, "td")).join("")}</tr>`).join("")}</table></body></html>`;
        downloadBlob(new Blob([html], { type: "application/vnd.ms-excel" }), `${slug(a.title)}-results.xls`);
        toast("Excel downloaded", `${a.title} — ${rows.length} submission${rows.length === 1 ? "" : "s"}.`, "success");
      })
    );
    body.querySelectorAll("[data-assess-pdf]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const a = assessOf(btn.dataset.assessPdf); if (!a) return;
        const { header, rows } = buildAssessmentRows(a);
        const st = assessStats(a);
        const w = window.open("", "_blank");
        if (!w) return toast("Popup blocked", "Allow popups for this site to export PDF.", "error");
        w.document.write(`<html><head><title>${esc(a.title)} — Results</title><style>
          body{font-family:system-ui,sans-serif;padding:24px;color:#111}
          h1{font-size:18px;margin:0} p{color:#555;margin:4px 0 16px;font-size:13px}
          table{border-collapse:collapse;width:100%;font-size:12px}
          th,td{border:1px solid #bbb;padding:5px 8px;text-align:left}
          th{background:#eef3ee}
          @media print{@page{size:landscape;margin:12mm}}
        </style></head><body>
          <h1>Human Practice Foundation — ${esc(a.title)}</h1>
          <p>Auto-marked assessment · ${rows.length} submissions · average ${st.avg}% · pass rate ${st.passRate}% · generated ${new Date().toLocaleDateString()}</p>
          <table><tr>${header.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>
          ${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(String(v))}</td>`).join("")}</tr>`).join("")}</table>
          <script>window.onload=()=>window.print()</` + `script></body></html>`);
        w.document.close();
        toast("PDF export", "Choose “Save as PDF” in the print dialog.", "success");
      })
    );

    // school leader
    body.querySelector("[data-generate-report]")?.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = `${icon("check")} Report ready`;
      toast("Term report generated", "A whole-school PDF summary is ready to download.", "success");
    });
    body.querySelectorAll("[data-review]").forEach((btn) =>
      btn.addEventListener("click", () => toast("Staff review", `Opening coaching notes for ${btn.dataset.review}.`))
    );
  }

  /* Termly returns: the head files them, the scorecard reads them. */
  function wireFieldOfficerDash() {
    // Guard on the dashboard's own marker, not a flag — by the time either
    // promise resolves the admin/teacher/etc. tab switcher may have already
    // moved the view elsewhere, and re-rendering over that would yank it back.
    const stillHere = () => body.querySelector("[data-fo-dash]");
    if (!fieldReportsLoaded) loadFieldReports().then(() => { if (stillHere()) renderRole("field_officer"); });
    if (!myFoSchoolsLoaded) loadMyFoSchools().then(() => { if (stillHere()) renderRole("field_officer"); });
  }

  function wireSchoolReturns(role) {
    const rerender = () => renderRole(role);
    const refresh = async () => { await Promise.allSettled([loadReturns(), loadRevisions(), loadGrades()]); rerender(); };

    // Guard on the panel wrapper, not the Add button — that button only exists
    // once loaded, so waiting for it would leave the panel stuck on "Loading".
    if (!returnsLoaded) Promise.allSettled([loadReturns(), loadRevisions(), loadGrades()]).then(() => { if (body.querySelector("[data-returns-panel]")) rerender(); });

    body.querySelector("[data-returns-retry]")?.addEventListener("click", refresh);

    /* Region -> school cascade, then write the choice back to the profile.
       The RLS policy compares the return's school against profiles.school, so
       this is not cosmetic: setting it correctly is what lets a save succeed. */
    body.querySelector("[data-leader-county]")?.addEventListener("change", (e) => {
      const sess = read(K_SESSION, null) || {};
      sess.county = e.target.value; sess.region = e.target.value;
      sess.school = "";              // old school may not be in the new region
      write(K_SESSION, sess);
      rerender();
    });
    body.querySelector("[data-leader-save]")?.addEventListener("click", async () => {
      const wrap = body.querySelector("[data-leader-id]");
      const county = wrap.querySelector("[data-leader-county]").value;
      const school = wrap.querySelector("[data-leader-school]").value;
      if (!school) return toast("Pick a school", "Choose the school you are filing for.", "error");

      const sess = read(K_SESSION, null) || {};
      Object.assign(sess, { county, region: county, school });
      write(K_SESSION, sess);

      // Mirror it onto the Supabase profile when there is a real session; that
      // row is what RLS reads. A local-only account has none to update.
      const { data: auth } = await supabase.auth.getUser();
      if (auth?.user) {
        const { error } = await supabase.from("profiles")
          .update({ school, county }).eq("id", auth.user.id);
        if (error) return toast("Saved locally only", authMessage(error), "error");
      }
      toast("School set", `${school}${county ? ", " + county : ""}`, "success");
      rerender();
    });

    body.querySelectorAll("[data-return-term]").forEach((b) =>
      b.addEventListener("click", () => { returnTermView = b.dataset.returnTerm; rerender(); })
    );
    body.querySelector("[data-return-add]")?.addEventListener("click", () => {
      returnEditId = null; returnFormOpen = true; rerender();
    });
    // Live totals as the head types, so the roll adds up in front of them
    // rather than only after saving.
    const form = body.querySelector("#returnForm");
    if (form) {
      const val = (n) => +(form.querySelector(`[name="${n}"]`)?.value || 0);

      const recount = () => {
        let tb = 0, tg = 0;
        const perGrade = [];
        form.querySelectorAll(".grade-row").forEach((row) => {
          const b = +(row.querySelector('[name^="g_boys_"]')?.value || 0);
          const g = +(row.querySelector('[name^="g_girls_"]')?.value || 0);
          const cell = row.querySelector("[data-grade-total]");
          if (cell) cell.textContent = b + g || "";
          const nm = row.querySelector(".grade-name")?.textContent;
          if (nm && (b || g)) perGrade.push({ grade: nm, boys: b, girls: g });
          tb += b; tg += g;
        });
        const put = (k, v) => {
          const el = form.querySelector(`[data-grade-sum="${k}"]`);
          if (el) el.textContent = v;
        };
        put("boys", tb); put("girls", tg); put("all", tb + tg);
        renderLive(tb, tg, perGrade);
      };

      /* The live panel. Everything is computed from what is in the form right
         now, not from what has been saved — the head sees the ratios move as
         they type, which is when a mistyped roll is easiest to catch. */
      const renderLive = (boys, girls, perGrade) => {
        const host = form.querySelector("[data-live-return]");
        if (!host) return;
        const total = boys + girls;
        if (!total) { host.innerHTML = ""; return; }

        const teachers = val("tsc_teachers") + val("non_tsc_teachers");
        const drop = val("dropouts");
        const classrooms = val("classrooms"), desks = val("desks"), computers = val("computers");
        const pct = (n) => Math.round((n / total) * 100);
        const ratio = (n) => (n ? Math.round(total / n) : null);
        const show = (n) => (n === null ? "—" : n);

        const genderSegs = [
          { label: `Boys ${pct(boys)}%`, value: boys, color: "oklch(52% 0.14 148)" },
          { label: `Girls ${pct(girls)}%`, value: girls, color: "oklch(78% 0.15 75)" },
        ];
        const tile = (l, v2, note) =>
          `<div class="lr-tile"><div class="lr-l">${esc(l)}</div><div class="lr-v">${esc(String(v2))}</div>${
            note ? `<div class="lr-n">${esc(note)}</div>` : ""}</div>`;

        host.innerHTML = `
          <div class="lr-head">${icon("activity")} Live summary
            <span class="lr-hint">updates as you type &middot; nothing saved yet</span></div>
          <div class="lr-grid">
            ${tile("On the register", total.toLocaleString(), `${boys} boys / ${girls} girls`)}
            ${tile("Gender balance", `${pct(girls)}% girls`, Math.abs(pct(girls) - 50) > 10 ? "skewed" : "broadly even")}
            ${tile("Learners per teacher", show(ratio(teachers)), teachers ? `${teachers} teachers` : "no staff entered")}
            ${tile("Dropout rate", ((drop / total) * 100).toFixed(1) + "%", `${drop} leaver${drop === 1 ? "" : "s"}`)}
            ${tile("Per classroom", show(ratio(classrooms)), classrooms ? `${classrooms} rooms` : "not entered")}
            ${tile("Per desk", desks ? (total / desks).toFixed(1) : "—", desks ? `${desks} desks` : "not entered")}
            ${tile("Per computer", show(ratio(computers)), computers ? `${computers} devices` : "none")}
            ${tile("Grades running", perGrade.length, "")}
          </div>
          <div class="lr-charts">
            <div class="lr-chart">
              <div class="lr-l">Boys and girls by grade</div>
              ${perGrade.length
                ? groupedBars(perGrade.map((g) => g.grade), ["Boys", "Girls"],
                    perGrade.map((g) => [g.boys, g.girls]),
                    ["oklch(52% 0.14 148)", "oklch(78% 0.15 75)"])
                : `<div class="empty-state">Enter a grade to see the split.</div>`}
            </div>
            <div class="lr-chart">
              <div class="lr-l">Overall gender split</div>
              <div class="donut-wrap">${pieChart(genderSegs, 130)}${chartLegend(genderSegs)}</div>
            </div>
          </div>`;
      };

      /* Draft autosave, deliberately local rather than to Postgres: a half-typed
         roll is not a return, and writing partial figures to a table the
         scorecard reads would publish numbers nobody has checked. This only
         means a closed tab does not cost the head their afternoon. */
      let draftTimer = null;
      const markDraft = (t) => {
        const el = form.querySelector("[data-draft-state]");
        if (el) el.textContent = t;
      };
      const saveDraft = () => {
        const fd = Object.fromEntries(new FormData(form).entries());
        write(K_RETURN_DRAFT, { school: leaderSchool(), at: Date.now(), fields: fd });
        markDraft("Draft saved " + new Date().toLocaleTimeString());
      };
      form.addEventListener("input", () => {
        recount();
        markDraft("Saving...");
        clearTimeout(draftTimer);
        draftTimer = setTimeout(saveDraft, 800);
      });

      // Restore an unsubmitted draft for this school.
      const draft = read(K_RETURN_DRAFT, null);
      if (draft && draft.school === leaderSchool() && !form.dataset.id) {
        Object.entries(draft.fields || {}).forEach(([k, v2]) => {
          // Overwrite, do not fill blanks: numeric fields render with a 0
          // default, so a "skip if it has a value" restore would silently drop
          // every number the head had typed. This branch only runs for a new
          // return, never an edit, so there is nothing of the server's to lose.
          const el = form.querySelector(`[name="${CSS.escape(k)}"]`);
          if (el) el.value = v2;
        });
        markDraft("Draft restored from " + timeAgo(draft.at));
      }

      recount();
    }

    body.querySelectorAll("[data-return-history]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.returnHistory;
        returnHistoryOpen = returnHistoryOpen === id ? null : id;
        rerender();
      })
    );
    body.querySelectorAll("[data-return-edit]").forEach((b) =>
      b.addEventListener("click", () => { returnEditId = b.dataset.returnEdit; returnFormOpen = true; rerender(); })
    );
    body.querySelector("[data-return-cancel]")?.addEventListener("click", () => {
      returnFormOpen = false; returnEditId = null; rerender();
    });

    body.querySelectorAll("[data-return-delete]").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = b.dataset.returnDelete;
        b.disabled = true;
        const { error } = await supabase.from("school_returns").delete().eq("id", id);
        if (error) { b.disabled = false; return toast("Could not delete", authMessage(error), "error"); }
        if (returnEditId === id) { returnEditId = null; returnFormOpen = false; }
        toast("Return deleted", "", "success");
        await refresh();
      })
    );

    body.querySelector("#returnForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = Object.fromEntries(new FormData(form).entries());
      const id = form.dataset.id;

      // Blank number inputs mean "not collected", which is different from zero —
      // send null so the aggregate skips them instead of averaging in a 0.
      const int = (k) => (fd[k] === "" || fd[k] === undefined ? null : parseInt(fd[k], 10));
      const dec = (k) => (fd[k] === "" || fd[k] === undefined ? null : parseFloat(fd[k]));
      const txt = (k) => ((fd[k] || "").trim() || null);

      // Enrolment now comes from the per-grade inputs; the totals are derived
      // here for validation and recomputed in Postgres by a trigger.
      const gradeRows = GRADES.map((g, i) => ({
        grade: g, position: i + 1,
        boys: parseInt(fd[`g_boys_${g}`], 10) || 0,
        girls: parseInt(fd[`g_girls_${g}`], 10) || 0,
      })).filter((g) => g.boys || g.girls);
      const boys = gradeRows.reduce((a, g) => a + g.boys, 0);
      const girls = gradeRows.reduce((a, g) => a + g.girls, 0);
      if (boys + girls <= 0) return toast("Enrolment required", "Enter the roll for at least one grade.", "error");
      const dropouts = int("dropouts") || 0;
      if (dropouts > boys + girls)
        return toast("Check the figures", "Dropouts cannot exceed the number enrolled.", "error");
      if (dropouts > 0 && !txt("dropout_reason"))
        return toast("Reason required", "Select the main reason learners left.", "error");

      const row = {
        school: leaderSchool(), county: leaderCounty() || null,
        year: int("year"), term: fd.term,
        boys, girls,
        learners_with_disability: int("learners_with_disability") || 0,
        tsc_teachers: int("tsc_teachers") || 0,
        non_tsc_teachers: int("non_tsc_teachers") || 0,
        support_staff: int("support_staff") || 0,
        teachers_trained_term: int("teachers_trained_term") || 0,
        dropouts,
        dropout_reason: txt("dropout_reason"),
        dropout_reason_other: txt("dropout_reason_other"),
        transfers_in: int("transfers_in") || 0,
        transfers_out: int("transfers_out") || 0,
        attendance_rate: int("attendance_rate"),
        mean_score: dec("mean_score"),
        classrooms: int("classrooms"), desks: int("desks"), toilets: int("toilets"),
        water_source: txt("water_source"), electricity: txt("electricity"),
        computers: int("computers"), internet_status: txt("internet_status"),
        feeding_programme: fd.feeding_programme === "true",
        income_projects: txt("income_projects"), notes: txt("notes"),
        submitted_by: leaderUser().id || null,
      };
      // Only meaningful on an update; the trigger consumes it into the audit
      // trail and clears it, so it never lingers on the live row.
      if (id) row.correction_reason = txt("correction_reason");
      Object.assign(row, {
        head_title: txt("head_title"), head_name: txt("head_name"),
        head_phone: txt("head_phone"), head_email: txt("head_email"),
      });
      if (!row.head_name) return toast("Name required", "Enter the head of institution's name.", "error");

      const btn = form.querySelector("[type=submit]");
      if (btn) btn.disabled = true;
      const { error } = id
        ? await supabase.from("school_returns").update(row).eq("id", id)
        : await supabase.from("school_returns").insert(row);

      if (error) {
        if (btn) btn.disabled = false;
        // The unique index is what stops a school filing the same term twice.
        if (error.code === "23505")
          return toast("Already filed", `${row.term} ${row.year} exists — open it from the list to update it.`, "error");
        // 42501 is Postgres refusing the row under RLS. On this app that almost
        // always means the session has no JWT (a pre-migration account signing
        // in through the local fallback) or the profile's school does not match
        // the one being filed for. The raw message says none of that.
        if (error.code === "42501" || /row-level security/i.test(error.message || ""))
          return toast(
            "Cannot save to the HPF database",
            leaderUser().legacy
              ? "You are signed in on an old browser-only account, which cannot write to the database. Ask an HPF administrator to create your account under Authentication → Users."
              : `Your profile is not registered against ${row.school}. Set your region and school below, or ask an administrator to correct it.`,
            "error");
        return toast("Could not save return", authMessage(error), "error");
      }
      // The grade rows are the source of truth for enrolment, so rewrite them
      // wholesale: a grade the head cleared has to disappear, not linger.
      const savedId = id || (await supabase.from("school_returns")
        .select("id").eq("school", row.school).eq("year", row.year).eq("term", row.term)
        .maybeSingle()).data?.id;
      if (savedId) {
        await supabase.from("school_return_grades").delete().eq("return_id", savedId);
        if (gradeRows.length) {
          const { error: gErr } = await supabase.from("school_return_grades")
            .insert(gradeRows.map((g) => ({ ...g, return_id: savedId })));
          if (gErr) toast("Saved, but grades failed", authMessage(gErr), "error");
        }
      }

      localStorage.removeItem(K_RETURN_DRAFT);   // committed; the draft is spent
      returnFormOpen = false; returnEditId = null;
      toast(id ? "Return updated" : "Return filed", `${row.term} ${row.year} · ${esc(row.school)}`, "success");
      await refresh();
    });
  }

  function wireBody(role) {
    wireTasks();
    wireRoleActions();
    if (role === "admin" || role === "staff") wireAdmin(role);
    if (role === "field_officer") wireFieldOfficerDash();
    if (role === "school_leader") wireSchoolReturns(role);
    // "Enter account" buttons live inside the body (admin table, coach learners)
    body.querySelectorAll("[data-enter-account]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // don't also trigger the row's learner-detail open
        enterAccount(btn.dataset.enterAccount);
      })
    );
    runCounters();
  }

  function renderRole(role) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.role === role));
    body.innerHTML = dashboardBody(role, ctx);
    wireBody(role);
    body.classList.remove("fade-in");
    void body.offsetWidth; // restart animation
    body.classList.add("fade-in");
  }

  // exit-account buttons (banner + header) live outside the re-rendered body
  document.querySelectorAll("[data-exit-account]").forEach((btn) =>
    btn.addEventListener("click", exitAccount)
  );

  tabs.forEach((t) => t.addEventListener("click", () => renderRole(t.dataset.role)));
  const current = tabs.find((t) => t.classList.contains("active"))?.dataset.role || user.role;
  wireBody(current);
}
