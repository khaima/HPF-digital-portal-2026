/* ============================================================
   My Dashboard — interactive, role-based simulated dashboards
   Roles: Admin, Learner, Teacher, Field Officer, School Leader
   ============================================================ */

import { icon } from "./icons.js";
import { DASH, ROLES, ORG_TYPES, COUNTIES, KOLIBRI, CONTENT_KINDS, SCHOOLS,
  LIBRARY_CATEGORIES, RESOURCE_TYPES, LIBRARY_SEED, REGIONS, PROJECTS, SCHOOL_COORDS } from "./data.js";
import { esc, timeAgo, runCounters, read, write, toast, uid } from "./util.js";
import { adminClient, authMessage } from "./supabase.js";

const K_USERS = "hpf_users";
const K_SESSION = "hpf_session";
const K_IMPERSONATE = "hpf_impersonate"; // stores the real user while "in" someone's account
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
const DASH_ROLES = ["admin", "learner", "teacher", "field_officer", "school_leader"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* which role workspaces each role may view via the switcher:
   admin sees everyone, teacher sees teacher+learner, others only themselves */
const VIEWABLE = {
  admin: ["admin", "teacher", "learner", "field_officer", "school_leader"],
  teacher: ["teacher", "learner"],
  field_officer: ["field_officer"],
  school_leader: ["school_leader"],
  learner: ["learner"],
};

/* which roles a user is allowed to "enter" (impersonate to help remotely) */
const CAN_ENTER = {
  admin: ["admin", "teacher", "learner", "field_officer", "school_leader"],
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
    blurb: "Oversee every account, review sign-in activity, and keep the portal healthy.",
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

function statTiles(stats) {
  return `<div class="stat-row">${stats
    .map(
      (s) => `<div class="stat-tile">
        <div class="st-label">${icon(s.icon)} ${esc(s.label)}</div>
        <div class="st-num">${countNum(s.count, s.suffix, s.compact)}${trendBadge(s.trend)}</div>
      </div>`
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
const K_SUBS = "hpf_submissions";   // field-officer reports
const K_EVENTS = "hpf_login_events"; // login / signup inbox
const K_LIBRARY = "hpf_library";     // admin-curated digital library

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

  return `
    <div class="panel" style="margin-top:1.5rem" data-lib-panel>
      <div class="panel-head-row">
        <div>
          <h2>${icon("library")} Digital Library</h2>
          <p class="panel-sub" style="margin:0">Upload and publish resources teachers can share with learners · ${lib.filter((r) => r.published).length} published</p>
        </div>
        <button class="btn btn-primary" data-lib-toggle>${icon("plus")} ${adminLibOpen ? "Close" : "Add resource"}</button>
      </div>

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

      <div class="lib-list">${rows}</div>
    </div>`;
}
let adminView = "scorecard";         // which analytics tab is open
let scPillar = "education";           // which scorecard pillar is drilled into
/* ELOG-style scorecard filters + board theme */
const scFilter = { region: "all", school: "all", term: "all", pillar: "all", programme: "all", q: "" };
const HPF_TERMS = ["Term 1", "Term 2", "Term 3"];
let scTheme = "dark"; // "dark" | "light"

/* schools available under the current region filter */
function filterSchools() {
  return scFilter.region === "all" ? SCHOOLS : REGIONS[scFilter.region] || [];
}

const ROLE_COLOR = {
  learner: "oklch(52% 0.14 148)",
  teacher: "oklch(68% 0.17 155)",
  school_leader: "oklch(78% 0.15 75)",
  field_officer: "oklch(55% 0.15 300)",
  admin: "oklch(62% 0.24 27)",
};
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* seed a few field reports so the field-officer visuals aren't empty on a
   fresh browser (same demo-seed approach as the demo class). */
function seedFieldReports() {
  if (read(K_SUBS, []).length) return;
  const now = Date.now(), day = 864e5;
  const seed = [
    ["Aitong School", "Monitoring & Evaluation Visit", "Narok", 6, 180, "synced", 2],
    ["Naboisho School", "School Support Visit", "Narok", 4, 120, "synced", 4],
    ["Ololomei School", "Teacher Coaching Session", "Narok", 5, 95, "pending", 1],
    ["Olkimitare School", "Baseline Data Collection", "Kajiado", 3, 140, "synced", 6],
    ["Aitong School", "Classroom Observation", "Narok", 7, 200, "synced", 8],
    ["Naboisho School", "Infrastructure Assessment", "Kajiado", 2, 60, "pending", 9],
    ["Ololomei School", "Monitoring & Evaluation Visit", "Kisumu", 5, 160, "synced", 11],
    ["Olkimitare School", "School Support Visit", "Turkana", 4, 110, "pending", 13],
  ].map(([school, visitType, county, teachers, learners, status, ago]) => ({
    id: uid(), userId: "seed", school, visitType, county, teachers, learners,
    notes: "", status, createdAt: now - ago * day,
  }));
  write(K_SUBS, seed);
}

/* read every store and compute the numbers the analytics tabs visualize */
function computeAdminStats() {
  seedFieldReports();
  const users = read(K_USERS, []);
  const classes = read(K_CLASSES, []);
  const reports = read(K_SUBS, []);
  const events = read(K_EVENTS, []);
  const now = Date.now(), day = 864e5;

  // roles + counties from the user table
  const roleCounts = {};
  DASH_ROLES.forEach((r) => (roleCounts[r] = 0));
  const county = {};
  users.forEach((u) => {
    roleCounts[u.role] = (roleCounts[u.role] || 0) + 1;
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
    users, roleCounts, county, enrolled, assignments, assessments, activeSessions,
    classRows, subs, bands, passed, avgScore, comp,
    reports, foCounty, fo, learnersReached, teachersReached,
    trend, trendLabels, totalUsers: users.length,
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
   keyless embed (t=k → satellite), so no API key or SDK is needed. */
const K_STORIES = "hpf_school_stories";
const getStories = () => read(K_STORIES, {});
const saveStories = (s) => write(K_STORIES, s);
let mapSchool = null;   // school currently open on the map
let mapEditing = false; // story editor open?

function schoolMapPanel(s) {
  const stories = getStories();
  const byCounty = {};
  Object.entries(SCHOOL_COORDS).forEach(([name, c]) => {
    (byCounty[c.county] = byCounty[c.county] || []).push(name);
  });
  const active = mapSchool && SCHOOL_COORDS[mapSchool] ? mapSchool : null;

  const pins = Object.keys(byCounty)
    .map(
      (county) => `<div class="smap-county">
        <div class="smap-county-h">${icon("mapPin")} ${esc(county)} <span class="smap-n">${byCounty[county].length}</span></div>
        <div class="smap-pins">${byCounty[county]
          .map((name) => {
            const reports = s.reports.filter((r) => r.school === name).length;
            return `<button class="smap-pin ${name === active ? "active" : ""}" data-map-school="${esc(name)}">
              ${icon("school")} <span>${esc(name.replace(/ (Primary )?School$/i, ""))}</span>
              ${stories[name] ? `<i class="smap-dot" title="Has a story"></i>` : ""}
              <b>${reports}</b>
            </button>`;
          })
          .join("")}</div>
      </div>`
    )
    .join("");

  let detail = `<div class="empty-state">Pick a school on the left to open its satellite view and story.</div>`;
  if (active) {
    const c = SCHOOL_COORDS[active];
    // keyless Google Maps embed, satellite basemap
    const src = `https://maps.google.com/maps?q=${c.lat},${c.lng}&t=k&z=17&hl=en&output=embed`;
    const story = stories[active] || "";
    detail = `
      <div class="smap-detail">
        <div class="smap-head">
          <div>
            <div class="smap-title">${icon("school")} ${esc(active)}</div>
            <div class="smap-meta">${esc(c.county)} County · ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}</div>
          </div>
          <a class="btn btn-outline btn-xs" target="_blank" rel="noopener"
             href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}">${icon("externalLink")} Open in Maps</a>
        </div>
        <div class="smap-frame">
          <iframe src="${src}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
            title="Satellite view of ${esc(active)}"></iframe>
        </div>
        <div class="smap-story">
          <div class="smap-story-h">
            <h4>${icon("book")} School story</h4>
            <button class="btn btn-outline btn-xs" data-story-edit>${icon("pen")} ${story ? "Edit" : "Add"} story</button>
          </div>
          ${mapEditing
            ? `<form id="storyForm" data-school="${esc(active)}">
                 <textarea class="input" name="story" rows="5" placeholder="What is happening at ${esc(active)}? Buildings, programmes, impact…">${esc(story)}</textarea>
                 <div class="add-user-actions" style="margin-top:.6rem">
                   <button class="btn btn-primary btn-xs" type="submit">${icon("check")} Save story</button>
                   <button class="btn btn-outline btn-xs" type="button" data-story-cancel>Cancel</button>
                 </div>
               </form>`
            : story
              ? `<p class="smap-story-body">${esc(story)}</p>`
              : `<p class="smap-story-body dim">No story yet for ${esc(active)}. Click <strong>Add story</strong> to write one.</p>`}
        </div>
      </div>`;
  }

  return `<div class="smap">
    <div class="smap-side">${pins}</div>
    <div class="smap-main">${detail}</div>
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
function adminAnalytics() {
  const s = computeAdminStats();
  const tabs = [
    { id: "scorecard", label: "Scorecard" },
    { id: "overview", label: "Overview" },
    { id: "learners", label: "Learners" },
    { id: "teachers", label: "Teachers" },
    { id: "field", label: "Field Officers" },
  ];
  const tabBar = `<div class="ksubtabs">${tabs
    .map((t) => `<button class="ksubtab ${t.id === adminView ? "active" : ""}" data-admin-tab="${t.id}">${t.label}</button>`)
    .join("")}</div>`;

  let body;
  if (adminView === "overview") body = adminOverview(s);
  else if (adminView === "learners") body = adminLearners(s);
  else if (adminView === "teachers") body = adminTeachers(s);
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

function adminKpis(s) {
  return `<div class="stat-row" style="margin-bottom:1.25rem">
    <div class="stat-tile"><div class="st-label">${icon("users")} Total users</div><div class="st-num">${countNum(s.totalUsers)}</div></div>
    <div class="stat-tile"><div class="st-label">${icon("graduation")} Learners enrolled</div><div class="st-num">${countNum(s.enrolled)}</div></div>
    <div class="stat-tile"><div class="st-label">${icon("clipboard")} Assessments taken</div><div class="st-num">${countNum(s.subs.length)}</div></div>
    <div class="stat-tile"><div class="st-label">${icon("radio")} Live sessions</div><div class="st-num">${countNum(s.activeSessions)}</div></div>
  </div>`;
}

function adminOverview(s) {
  const roleSegs = DASH_ROLES.filter((r) => s.roleCounts[r] > 0).map((r) => ({
    label: ROLE_LABEL[r] || r, value: s.roleCounts[r], color: ROLE_COLOR[r],
  }));
  return `
    ${adminKpis(s)}
    <div class="dash-grid">
      <div class="panel"><h2>Users by role</h2>
        <p class="panel-sub">${s.totalUsers} registered accounts</p>
        <div class="donut-wrap">${donut(roleSegs, s.totalUsers, "users")}${chartLegend(roleSegs)}</div>
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
  return `
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
    id: "mep", name: "Micro Enterprise Programme", short: "MEP",
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
    .concat(Object.keys(REGIONS).map((n) => `<option value="${esc(n)}" ${scFilter.region === n ? "selected" : ""}>${esc(n)}</option>`))
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
  const regionRows = Object.keys(REGIONS).map((name) => {
    const rSchools = REGIONS[name];
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
      ${Object.keys(REGIONS)
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

function adminBody(ctx) {
  const d = DASH.admin;
  const events = ctx.events || [];
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

  const totalRoles = d.roleBreakdown.reduce((a, b) => a + b.value, 0);

  // computed insights: busiest day, week-over-day delta, top role share
  const peak = Math.max(...d.weekly);
  const peakDay = DAYS[d.weekly.indexOf(peak)];
  const prev = d.weekly[d.weekly.length - 2] || 1;
  const delta = Math.round(((d.weekly[d.weekly.length - 1] - prev) / prev) * 100);
  const topRole = d.roleBreakdown.reduce((a, b) => (b.value > a.value ? b : a));
  const signupsToday = events.filter((e) => e.type === "signup" && Date.now() - e.at < 864e5).length;
  const smart = insights([
    {
      icon: "trendingUp", tone: delta >= 0 ? "good" : "bad",
      html: `Logins are <strong>${delta >= 0 ? "up " + delta : "down " + Math.abs(delta)}%</strong> vs yesterday — busiest day this week was <strong>${peakDay}</strong> (${peak}).`,
    },
    {
      icon: "users", tone: "",
      html: `<strong>${topRole.label}</strong> are your largest group — <strong>${Math.round((topRole.value / totalRoles) * 100)}%</strong> of all ${totalRoles.toLocaleString()} accounts.`,
    },
    {
      icon: "inbox", tone: signupsToday ? "warn" : "",
      html: signupsToday
        ? `<strong>${signupsToday} new signup${signupsToday === 1 ? "" : "s"}</strong> in the last 24h — review them in the inbox below.`
        : `No new signups in the last 24h. Invite links can be shared from <strong>User management</strong>.`,
    },
  ]);

  return `
    ${statTiles(d.stats)}
    ${smart}
    ${adminAnalytics()}
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
        <p class="panel-sub">${totalRoles.toLocaleString()} registered accounts</p>
        <div class="legend">
          ${d.roleBreakdown
            .map((r) => hbar(r.label, r.value, d.roleBreakdown[0].value, r.color))
            .join("")}
        </div>
      </div>
    </div>
    <div class="panel" style="margin-top:1.5rem">
      <h2>Logins this week</h2>
      <p class="panel-sub">Daily authenticated sessions</p>
      ${barChart(d.weekly, DAYS)}
    </div>
    ${userManagementPanel(ctx.user)}
    ${digitalLibraryPanel()}
    <div class="panel" style="margin-top:1.5rem">
      <h2>Recent activity</h2>
      <p class="panel-sub">Across schools, teachers, learners and field teams</p>
      <div>${d.activity
        .map(
          (a) => `<div class="submission">
            <span class="s-icon">${icon("activity")}</span>
            <div><div class="s-title">${esc(a.who)}</div>
              <div class="s-meta">${esc(a.act)} · ${esc(ROLE_LABEL[a.role] || a.role)}</div></div>
          </div>`
        )
        .join("")}</div>
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
const K_ASSIGN = "hpf_assignments"; // legacy single-class store (migrated below)
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

/* A seeded MCQ assessment (with auto-marked submissions) so the demo class
   shows the assessment analytics out of the box. */
function seedAssessment() {
  const L = KOLIBRI.coach.learners; // l1..l6
  const questions = [
    { id: "q1", text: "What is 1/2 + 1/4?", options: ["1/6", "2/6", "3/4", "1/3"], correct: 2 },
    { id: "q2", text: "Which fraction is largest?", options: ["1/2", "2/3", "1/4", "3/8"], correct: 1 },
    { id: "q3", text: "Simplify 4/8.", options: ["1/2", "2/4", "4/8", "1/4"], correct: 0 },
    { id: "q4", text: "What is 3/5 of 20?", options: ["10", "12", "15", "9"], correct: 1 },
    { id: "q5", text: "0.75 as a fraction is…", options: ["3/4", "7/5", "1/4", "2/3"], correct: 0 },
  ];
  // pre-filled answers per learner (indexes) → auto-marked below
  const picks = {
    l1: [2, 1, 0, 1, 0], // 5/5
    l2: [2, 1, 0, 1, 3], // 4/5
    l3: [2, 0, 0, 1, 0], // 4/5
    l4: [0, 1, 2, 3, 0], // 2/5
    l5: [2, 1, 0, 0, 0], // 4/5
    l6: [1, 0, 2, 3, 1], // 0/5
  };
  const submissions = L.map((l) => {
    const answers = picks[l.id] || [];
    const correct = questions.reduce((n, q, i) => n + (answers[i] === q.correct ? 1 : 0), 0);
    return { learnerId: l.id, name: l.name, answers, correct, total: questions.length,
      pct: Math.round((correct / questions.length) * 100), at: Date.now() - 864e5 };
  });
  return { id: uid(), title: "Fractions Check — MCQ", session: "ended",
    published: true, audience: "all", targetIds: [], questions, submissions };
}

/* Classes persist in localStorage; the demo class (and any legacy
   assignment store) is migrated in on first run. */
function getClasses() {
  let classes = read(K_CLASSES, null);
  if (!classes || !classes.length) {
    classes = [
      {
        id: uid(),
        name: KOLIBRI.coach.className,
        school: SCHOOLS[0],
        learners: KOLIBRI.coach.learners,
        assignments: read(K_ASSIGN, null) || KOLIBRI.coach.assignments,
        assessments: [seedAssessment()],
      },
    ];
    write(K_CLASSES, classes);
  }
  let dirty = false;
  classes.forEach((c) => {
    // migrate classes created before schools / assessments existed
    if (!SCHOOLS.includes(c.school)) { c.school = SCHOOLS[0]; dirty = true; }
    if (!Array.isArray(c.assessments)) { c.assessments = []; dirty = true; }
    // migrate assessments created before publish/audience existed
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
  const scoped = scopedClasses();        // only what this coach may see
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

function coachOverview(list, learners) {
  const dist = { completed: 0, in_progress: 0, not_started: 0 };
  list.forEach((a) => {
    const c = statusCounts(a);
    dist.completed += c.completed;
    dist.in_progress += c.in_progress;
    dist.not_started += c.not_started;
  });
  const total = dist.completed + dist.in_progress + dist.not_started || 1;
  const seg = (n, cls) => `<div class="dist-seg ${cls}" style="width:${(n / total) * 100}%"></div>`;

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
      <div>${KOLIBRI.coach.activity
        .map(
          (a) => `<div class="submission"><span class="s-icon">${icon("activity")}</span>
            <div><div class="s-title">${esc(a.who)}</div>
            <div class="s-meta">${esc(a.what)} · ${esc(a.when)}</div></div></div>`
        )
        .join("")}</div>
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
    return `
      <div class="panel-head-row" style="margin-bottom:1rem">
        <div>
          <h2 style="font-size:1.15rem">Coach</h2>
          <p class="panel-sub" style="margin:0">${icon("school")} ${esc(school || "")}</p>
        </div>
      </div>
      ${classSwitcher(scoped, null)}
      <div class="panel"><div class="empty-state">No classes yet for <strong>${esc(school || "your school")}</strong>.<br>Click <strong>New class</strong> above to create your first grade.</div></div>`;
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
  else if (coachState.tab === "people") content = coachPeople(cls, scoped);
  else if (coachState.tab === "results") content = coachResults(list, learners, cls);
  else if (coachState.tab === "learners")
    content = coachState.learnerId
      ? coachLearnerDetail(list, learners, coachState.learnerId, cls)
      : coachLearnersList(list, learners, cls);
  else content = coachOverview(list, learners);

  return `
    <div class="panel-head-row" style="margin-bottom:1rem">
      <div>
        <h2 style="font-size:1.15rem">${esc(cls.name)} · Coach</h2>
        <p class="panel-sub" style="margin:0">${icon("school")} ${esc(cls.school || "")} — create classes, enroll learners, run sessions, and track results</p>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn btn-outline" data-add-user-toggle>${icon("userPlus")} Add user</button>
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

/* add a user — pick Teacher or Learner, then role-specific fields + password */
function addUserForm(cls) {
  return `
    <form id="addUserForm" class="add-user-form" ${coachState.openUserForm ? "" : "hidden"}>
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
        <button class="btn btn-outline" type="button" data-add-user-cancel>Cancel</button>
      </div>
    </form>`;
}

function fieldOfficerBody() {
  const d = DASH.field_officer;

  // computed insights: priority visit, unsynced reports, weekly pace
  const priority = [...d.schools].sort((a, b) => a.health - b.health)[0];
  const unsynced = d.stats.find((s) => s.label === "Reports synced");
  const visits = d.stats.find((s) => s.label === "Visits this month");
  const backlog = visits && unsynced ? visits.count - unsynced.count : 0;
  const openTasks = d.tasks.filter((t) => !t.done).length;
  const smart = insights([
    priority && {
      icon: "alert", tone: priority.health < 60 ? "bad" : "warn",
      html: `<strong>${esc(priority.name)}</strong> has the lowest school-health score (<strong>${priority.health}%</strong>) — schedule it as your next visit.`,
    },
    {
      icon: "cloud", tone: backlog > 0 ? "warn" : "good",
      html: backlog > 0
        ? `<strong>${backlog} report${backlog === 1 ? "" : "s"} not yet synced</strong> — connect to sync before your next field day.`
        : `All field reports are synced — you're fully up to date.`,
    },
    {
      icon: "clipboard", tone: "",
      html: `<strong>${openTasks} open task${openTasks === 1 ? "" : "s"}</strong> today — tick them off in the Field tasks panel.`,
    },
  ].filter(Boolean));

  return `
    ${statTiles(d.stats)}
    ${smart}
    <div class="dash-grid">
      <div class="panel">
        <h2>Assigned schools</h2>
        <p class="panel-sub">School health & visit status</p>
        <div class="mini-table">
          ${d.schools
            .map(
              (s) => `<div class="mt-row">
                <span class="mt-name">${esc(s.name)}<br><span class="mt-sub">${esc(s.county)}</span></span>
                <span class="mt-health">${hbar("", s.health, 100,
                  s.health >= 75 ? "var(--success)" : s.health >= 60 ? "oklch(70% 0.16 75)" : "var(--destructive)",
                  "%")}</span>
                <span class="pill ${s.status === "Visited" ? "synced" : "pending"}">${esc(s.status)}</span>
              </div>`
            )
            .join("")}
        </div>
      </div>
      <div class="panel">
        <h2>Field tasks</h2>
        <p class="panel-sub">Tap a task to mark it complete</p>
        ${taskList(d.tasks)}
      </div>
    </div>
    <div class="panel" style="margin-top:1.5rem">
      <h2>Visits logged this week</h2>
      <p class="panel-sub">School support & monitoring visits</p>
      ${barChart(d.weekly, DAYS)}
      <a class="btn btn-primary" href="/field-officer" data-link style="margin-top:1.25rem">
        ${icon("clipboard")} Open field data collection
      </a>
    </div>`;
}

function schoolLeaderBody() {
  const d = DASH.school_leader;

  // computed insights: strongest/weakest grade, attendance trend, top teacher
  const best = d.grades.reduce((a, b) => (b.value > a.value ? b : a));
  const worst = d.grades.reduce((a, b) => (b.value < a.value ? b : a));
  const att = d.weekly;
  const attDelta = att[att.length - 1] - att[0];
  const topT = d.teachers.reduce((a, b) => (b.rating > a.rating ? b : a));
  const smart = insights([
    {
      icon: "lightbulb", tone: "warn",
      html: `<strong>${esc(worst.label)}</strong> is your weakest grade (${worst.value}%) — <strong>${best.value - worst.value} points</strong> behind ${esc(best.label)}. Consider targeted coaching there.`,
    },
    {
      icon: attDelta >= 0 ? "trendingUp" : "trendingDown", tone: attDelta >= 0 ? "good" : "bad",
      html: `Attendance is <strong>${attDelta >= 0 ? "up" : "down"} ${Math.abs(attDelta)} point${Math.abs(attDelta) === 1 ? "" : "s"}</strong> across the week, ending at <strong>${att[att.length - 1]}%</strong>.`,
    },
    {
      icon: "star", tone: "good",
      html: `<strong>${esc(topT.name)}</strong> (${esc(topT.subject)}) is your top-rated teacher at <strong>★ ${topT.rating}</strong> — a great peer-coaching lead.`,
    },
  ]);

  return `
    <div class="panel-head-row" style="margin-bottom:1.25rem">
      <div>
        <h2 style="font-size:1.15rem">School overview</h2>
        <p class="panel-sub" style="margin:0">Your whole-school snapshot for this term</p>
      </div>
      <button class="btn btn-primary" data-generate-report>${icon("download")} Generate term report</button>
    </div>
    ${statTiles(d.stats)}
    ${smart}
    <div class="dash-grid">
      <div class="panel">
        <h2>Performance by grade</h2>
        <p class="panel-sub">Average competency score (%)</p>
        ${barChart(d.grades.map((g) => g.value), d.grades.map((g) => g.label), "%")}
      </div>
      <div class="panel">
        <h2>Teaching staff</h2>
        <p class="panel-sub">Coaching ratings this term</p>
        <div class="mini-table">
          ${d.teachers
            .map(
              (t) => `<div class="mt-row">
                <span class="mt-name">${esc(t.name)}<br><span class="mt-sub">${esc(t.subject)}</span></span>
                <button class="btn btn-outline btn-xs" data-review="${esc(t.name)}">Review</button>
                <span class="pill synced">★ ${t.rating}</span>
              </div>`
            )
            .join("")}
        </div>
      </div>
    </div>
    <div class="panel" style="margin-top:1.5rem">
      <h2>School attendance trend</h2>
      <p class="panel-sub">Whole-school attendance rate (%)</p>
      ${barChart(d.weekly, DAYS, "%")}
    </div>`;
}

const BODIES = {
  admin: adminBody,
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

  // where this user belongs — "in Narok · Ololomei School"
  const place = [user.region, user.school].filter(Boolean);
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

  function wireAdmin() {
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
      body.querySelectorAll("[data-map-school]").forEach((b) =>
        b.addEventListener("click", () => {
          const name = b.dataset.mapSchool;
          mapSchool = mapSchool === name ? null : name;
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
      body.querySelector("#storyForm")?.addEventListener("submit", (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const school = form.dataset.school;
        const text = (new FormData(form).get("story") || "").toString().trim();
        const stories = getStories();
        if (text) stories[school] = text;
        else delete stories[school];
        saveStories(stories);
        mapEditing = false;
        toast(text ? "Story saved" : "Story cleared", `${school} updated.`, "success");
        renderAnalytics();
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
    function renderAnalytics() {
      const holder = body.querySelector("[data-admin-panel]");
      if (!holder) return;
      holder.outerHTML = adminAnalytics();
      wireAnalytics();
      runCounters();
    }
    wireAnalytics();
    // update automatically when data changes in another tab (keep just one listener)
    if (window.__hpfAdminStorage) window.removeEventListener("storage", window.__hpfAdminStorage);
    window.__hpfAdminStorage = (e) => {
      if (["hpf_classes", "hpf_users", "hpf_submissions", "hpf_login_events"].includes(e.key)) {
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
        renderRole("admin");
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
      // anyone with an organisation email is an admin
      if ((data.email || "").trim().toLowerCase().endsWith("@" + ORG_DOMAIN)) data.role = "admin";
      if ((data.password || "").length < 6) return toast("Weak password", "Min. 6 characters.", "error");

      const users = read(K_USERS, []);
      const key = (data.email || data.username || "").toLowerCase();
      if (users.some((u) => (u.email || u.username || "").toLowerCase() === key))
        return toast("Duplicate account", "An account with those details already exists.", "error");

      users.push({ ...data, id: uid(), createdAt: Date.now() });
      write(K_USERS, users);
      toast("User added", `${data.fullName} created as ${ROLE_LABEL[data.role]}.`, "success");
      renderRole("admin");
    });

    // Remove a user
    body.querySelectorAll("[data-remove-user]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.dataset.removeUser;
        const users = read(K_USERS, []);
        const u = users.find((x) => x.id === id);
        write(K_USERS, users.filter((x) => x.id !== id));
        toast("User removed", u ? `${u.fullName || u.username} deleted.` : "", "success");
        renderRole("admin");
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
      renderRole("admin");
    });
    // user list: collapse / expand the full table
    body.querySelector("[data-users-toggle]")?.addEventListener("click", () => {
      usersListOpen = !usersListOpen;
      renderRole("admin");
    });
    // user list: filter by role + sort
    body.querySelector("[data-users-role]")?.addEventListener("change", (e) => {
      usersRoleFilter = e.target.value;
      usersListOpen = true; // show the result of the filter straight away
      renderRole("admin");
    });
    body.querySelector("[data-users-sort]")?.addEventListener("change", (e) => {
      usersSort = e.target.value;
      renderRole("admin");
    });
    body.querySelectorAll("[data-users-role-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        const r = b.dataset.usersRolePick;
        usersRoleFilter = usersRoleFilter === r ? "all" : r;
        usersListOpen = usersRoleFilter !== "all";
        renderRole("admin");
      })
    );

    // --- edit a user's full credentials (incl. password) ---
    body.querySelectorAll("[data-edit-user]").forEach((btn) =>
      btn.addEventListener("click", () => { editUserId = btn.dataset.editUser; renderRole("admin"); })
    );
    const closeEdit = () => { editUserId = null; renderRole("admin"); };
    body.querySelector("[data-edit-overlay]")?.addEventListener("click", (e) => { if (e.target.hasAttribute("data-edit-overlay")) closeEdit(); });
    body.querySelectorAll("[data-edit-close]").forEach((b) => b.addEventListener("click", closeEdit));
    body.querySelector("[data-editpw-toggle]")?.addEventListener("click", (e) => {
      const inp = body.querySelector("#editUserForm [name=password]");
      const on = inp.type === "password";
      inp.type = on ? "text" : "password";
      e.currentTarget.innerHTML = `${icon("eye")} ${on ? "Hide" : "Show"}`;
    });
    body.querySelector("[data-edit-save]")?.addEventListener("click", () => {
      const form = body.querySelector("#editUserForm");
      const data = Object.fromEntries(new FormData(form).entries());
      if (!(data.fullName || "").trim()) return toast("Name required", "", "error");
      if ((data.password || "").length < 6) return toast("Weak password", "Password must be at least 6 characters.", "error");
      const users = read(K_USERS, []);
      const u = users.find((x) => x.id === form.dataset.uid);
      if (!u) return closeEdit();
      let role = data.role;
      if ((data.email || "").trim().toLowerCase().endsWith("@" + ORG_DOMAIN)) role = "admin";
      Object.assign(u, {
        fullName: data.fullName.trim(), email: (data.email || "").trim(), username: (data.username || "").trim(),
        password: data.password, role, project: data.project || "", region: data.region || "", school: data.school || "",
      });
      write(K_USERS, users);
      // keep the live session in sync if the admin edited their own account
      const sess = read(K_SESSION, null);
      if (sess && sess.id === u.id) { const { password, ...safe } = u; write(K_SESSION, safe); }
      editUserId = null;
      toast("User updated", `${u.fullName}'s details were saved.`, "success");
      renderRole("admin");
    });

    // --- digital library ---
    body.querySelector("[data-lib-toggle]")?.addEventListener("click", () => {
      adminLibOpen = !adminLibOpen;
      renderRole("admin");
    });
    body.querySelector("[data-lib-cancel]")?.addEventListener("click", () => {
      adminLibOpen = false;
      renderRole("admin");
    });
    body.querySelectorAll("[data-lib-open]").forEach((b) =>
      b.addEventListener("click", () => openResource(getLibrary().find((r) => r.id === b.dataset.libOpen) || {}))
    );
    body.querySelectorAll("[data-lib-publish]").forEach((b) =>
      b.addEventListener("click", () => {
        const lib = getLibrary();
        const r = lib.find((x) => x.id === b.dataset.libPublish);
        if (r) { r.published = !r.published; saveLibrary(lib); toast(r.published ? "Published" : "Unpublished", `“${r.title}” is now ${r.published ? "available to teachers" : "hidden"}.`, "success"); }
        renderRole("admin");
      })
    );
    body.querySelectorAll("[data-lib-delete]").forEach((b) =>
      b.addEventListener("click", () => {
        const lib = getLibrary();
        const r = lib.find((x) => x.id === b.dataset.libDelete);
        saveLibrary(lib.filter((x) => x.id !== b.dataset.libDelete));
        toast("Deleted", r ? `“${r.title}” removed from the library.` : "", "success");
        renderRole("admin");
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
        renderRole("admin");
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
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const { classes, cls } = currentClass();
        const a = cls.assignments.find((x) => x.id === el.dataset.assignDelete);
        if (!a) return;
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

    assignForm?.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      if (!(data.title || "").trim()) return toast("Title required", "Give the assignment a title.", "error");

      // --- edit mode: update the metadata of an existing assignment ---
      if (form.dataset.editing) {
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
      const makeWork = (learnerIds) => ({
        id: uid(), type: data.type || "lesson", title: data.title.trim(),
        detail: (data.detail || "").trim() || (withScore0 ? "questions" : "resources"),
        due: (data.due || "").trim() || "no due date", session: "planned",
        results: learnerIds.map((id) => (withScore0 ? { id, pct: 0, score: 0 } : { id, pct: 0 })),
      });

      // --- assign to every grade in the teacher's school ---
      if (data.classId === "__all__") {
        const targets = scopedClasses().filter((c) => c.learners.length);
        if (!targets.length) return toast("No classes with learners", "Enroll learners first.", "error");
        targets.forEach((sc) => {
          const c = classes.find((x) => x.id === sc.id);
          c.assignments.unshift(makeWork(c.learners.map((l) => l.id)));
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

      const withScore = data.type !== "lesson";
      const results = ids.map((id) => (withScore ? { id, pct: 0, score: 0 } : { id, pct: 0 }));
      target.assignments.unshift({
        id: uid(),
        type: data.type || "lesson",
        title: data.title.trim(),
        detail: (data.detail || "").trim() || (withScore ? "questions" : "resources"),
        due: (data.due || "").trim() || "no due date",
        session: "planned",
        results,
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
    body.querySelector("#newClassForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const name = (fd.get("name") || "").trim();
      const school = fd.get("school") || "";
      if (!name) return toast("Name required", "Give the class a name, e.g. Grade 4 — Red.", "error");
      if (!school) return toast("School required", "Pick the HPF-supported school this class belongs to.", "error");
      const classes = getClasses();
      if (classes.some((c) => c.name.toLowerCase() === name.toLowerCase()))
        return toast("Duplicate class", `A class called “${name}” already exists.`, "error");
      const cls = { id: uid(), name, school, learners: [], assignments: [] };
      classes.push(cls);
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
    body.querySelector("#addLearnerForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.currentTarget).entries());
      const { classes, cls } = currentClass();
      const has = (name) => cls.learners.some((l) => l.name.toLowerCase() === name.toLowerCase());
      let added = 0, skipped = 0, lastName = "";

      // 1) enroll a registered portal account
      if (data.userId) {
        const u = read(K_USERS, []).find((x) => x.id === data.userId);
        if (!u) return toast("Account not found", "", "error");
        cls.learners.push({ id: u.id, name: u.fullName || u.username, active: "just now", account: true });
        added++; lastName = u.fullName || u.username;
      }

      // 2) single name field
      const single = (data.name || "").trim();
      if (single) {
        if (has(single)) skipped++;
        else { cls.learners.push({ id: uid(), name: single, active: "just now" }); added++; lastName = single; }
      }

      // 3) bulk paste — split on newlines, commas or semicolons
      (data.bulk || "")
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((name) => {
          if (has(name)) { skipped++; return; }
          cls.learners.push({ id: uid(), name, active: "just now" });
          added++; lastName = name;
        });

      if (!added && !skipped) return toast("Nothing to add", "Pick an account, type a name, or paste a list.", "error");
      if (!added) return toast("All duplicates", `Everyone you listed is already in ${cls.name}.`, "error");

      saveClasses(classes);
      coachState.openLearnerForm = false;
      const msg = added === 1 ? `${lastName} enrolled in ${cls.name}.` : `${added} learners enrolled in ${cls.name}.`;
      toast("Learners added", skipped ? `${msg} (${skipped} duplicate${skipped === 1 ? "" : "s"} skipped.)` : msg, "success");
      renderRole("teacher");
    });

    // coach: remove a learner from the class (also strips their results)
    body.querySelectorAll("[data-learner-remove]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.learnerRemove;
        const { classes, cls } = currentClass();
        const l = cls.learners.find((x) => x.id === id);
        cls.learners = cls.learners.filter((x) => x.id !== id);
        cls.assignments.forEach((a) => {
          a.results = a.results.filter((r) => r.id !== id);
        });
        saveClasses(classes);
        toast("Learner removed", l ? `${l.name} removed from ${cls.name}.` : "", "success");
        renderRole("teacher");
      })
    );

    // coach: add a user — role dropdown toggles the email/username fields
    body.querySelector("[data-add-user-toggle]")?.addEventListener("click", () => {
      coachState.openUserForm = !coachState.openUserForm;
      renderRole("teacher");
    });
    body.querySelector("[data-add-user-cancel]")?.addEventListener("click", () => {
      coachState.openUserForm = false;
      renderRole("teacher");
    });
    const addUserFormEl = body.querySelector("#addUserForm");
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
      btn.addEventListener("click", () => {
        const { classes, cls } = currentClass();
        const a = cls.assignments.find((x) => x.id === btn.dataset.sessionToggle);
        if (!a) return;
        const now = sessionOf(a);
        if (now === "active") {
          a.session = "ended";
          a.endedAt = Date.now();
          toast("Session ended", `“${a.title}” is closed — learners can no longer join.`, "success");
        } else {
          a.session = "active";
          a.startedAt = Date.now();
          toast("Session started", `“${a.title}” is now live for ${cls.name} learners.`, "success");
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
    body.querySelector("#assessForm")?.addEventListener("submit", (e) => {
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
        questions.push({ id: uid(), text, options: kept, correct });
      }
      const { classes, cls } = currentClass();
      const newId = uid();
      cls.assessments.unshift({
        id: newId, title, session: "planned",
        published: false, audience: "all", targetIds: [],
        questions, submissions: [],
      });
      saveClasses(classes);
      coachState.openAssessForm = false;
      coachState.publishId = newId; // open the publish dialog right away
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
      btn.addEventListener("click", () => {
        const { classes, cls } = currentClass();
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
      btn.addEventListener("click", () => {
        const { classes, cls } = currentClass();
        const a = cls.assessments.find((x) => x.id === btn.dataset.assessSession);
        if (!a) return;
        if ((a.session || "planned") === "active") {
          a.session = "ended"; a.endedAt = Date.now();
          toast("Session ended", `“${a.title}” is closed.`, "success");
        } else {
          a.session = "active"; a.startedAt = Date.now();
          toast("Session started", `“${a.title}” is live — ${cls.name} learners can take it.`, "success");
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
    body.querySelector("[data-publish-form]")?.addEventListener("submit", (e) => {
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

      // detach the assessment from whichever class currently holds it
      let assessment;
      classes.forEach((c) => {
        const i = c.assessments.findIndex((x) => x.id === assessId);
        if (i > -1) { assessment = c.assessments[i]; c.assessments.splice(i, 1); }
      });
      if (!assessment) return;

      assessment.published = true;
      assessment.audience = audience;
      assessment.targetIds = audience === "individual" ? ids : [];
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

  function wireBody(role) {
    wireTasks();
    wireRoleActions();
    if (role === "admin") wireAdmin();
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
