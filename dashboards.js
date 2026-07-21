/* ============================================================
   My Dashboard — interactive, role-based simulated dashboards
   Roles: Admin, Learner, Teacher, Field Officer, School Leader
   ============================================================ */

import { icon } from "./icons.js";
import { DASH, ROLES, ORG_TYPES, COUNTIES, KOLIBRI, CONTENT_KINDS } from "./data.js";
import { esc, timeAgo, runCounters, read, write, toast, uid } from "./util.js";

const K_USERS = "hpf_users";
const K_SESSION = "hpf_session";
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
const DASH_ROLES = ["admin", "learner", "teacher", "field_officer", "school_leader"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
    blurb: "Create classes, enroll learners, assign work, and mark it.",
    can: ["Create classes & grades", "Enroll learners in a class", "Assign & grade work"],
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
  const roleOpts = (selected) =>
    ROLES.map(
      (r) => `<option value="${r.value}" ${r.value === selected ? "selected" : ""}>${r.label}</option>`
    ).join("");

  const rows = users.length
    ? users
        .map((u) => {
          const isSelf = u.id === currentUser.id;
          return `<div class="ut-row">
            <div class="ut-cell ut-user">
              <span class="avatar-sm">${esc((u.fullName || u.username || "U").slice(0, 1).toUpperCase())}</span>
              <div>
                <div class="ut-name">${esc(u.fullName || "—")}${isSelf ? ' <span class="ut-you">you</span>' : ""}</div>
                <div class="ut-sub">${esc(u.email || u.username || "—")}</div>
              </div>
            </div>
            <div class="ut-cell ut-county">${esc(u.county || "—")}</div>
            <div class="ut-cell">
              <select class="select select-sm" data-role-edit="${u.id}" aria-label="Role for ${esc(u.fullName || u.username)}">
                ${roleOpts(u.role)}
              </select>
            </div>
            <div class="ut-cell ut-actions">
              <button class="icon-btn danger" data-remove-user="${u.id}" title="Remove user" ${
                isSelf ? "disabled" : ""
              }>${icon("trash")}</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="empty-state">No users yet.</div>`;

  const orgOpts =
    `<option value="" selected>Organization type</option>` +
    ORG_TYPES.map((o) => `<option>${o}</option>`).join("");
  const countyOpts =
    `<option value="" selected>County / region</option>` +
    COUNTIES.map((c) => `<option>${c}</option>`).join("");

  return `
    <div class="panel" style="margin-top:1.5rem">
      <div class="panel-head-row">
        <div>
          <h2>User management</h2>
          <p class="panel-sub" style="margin-bottom:0">${users.length} account${
            users.length === 1 ? "" : "s"
          } · view, add, and change roles</p>
        </div>
        <button class="btn btn-primary" data-add-user-toggle>${icon("users")} Add user</button>
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
          <div class="field"><label>County</label>
            <select class="select" name="county">${countyOpts}</select></div>
        </div>
        <div class="field"><label>Organization</label>
          <select class="select" name="orgType">${orgOpts}</select></div>
        <div class="add-user-actions">
          <button class="btn btn-primary" type="submit">Create account</button>
          <button class="btn btn-outline" type="button" data-add-user-cancel>Cancel</button>
        </div>
      </form>

      <div class="user-table">
        <div class="ut-row ut-head">
          <div class="ut-cell">User</div>
          <div class="ut-cell">County</div>
          <div class="ut-cell">Role</div>
          <div class="ut-cell"></div>
        </div>
        <div id="userRows">${rows}</div>
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

/* ---------------------------------------------------------- role bodies */
function adminBody(ctx) {
  const d = DASH.admin;
  const events = ctx.events || [];
  const feed = events.length
    ? events
        .slice(0, 8)
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
        .join("")
    : `<div class="empty-state">No login requests yet.<br>Sign in from another account to see requests arrive here.</div>`;

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
    <div class="notice">${icon("info")}
      <span>Every login and signup across the portal is pushed to
      <strong>patrick@humanpractice.org</strong> and logged in the repository below.</span>
    </div>
    <div class="dash-grid">
      <div class="panel">
        <h2>Login requests inbox</h2>
        <p class="panel-sub">Delivered to patrick@humanpractice.org · ${events.length} total</p>
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

function learnerBody() {
  const d = DASH.learner;
  const k = KOLIBRI.learner;

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

  return `
    ${statTiles(d.stats)}
    ${smart}
    ${subTabs(
      [
        { id: "home", label: "Home" },
        { id: "library", label: "Library" },
        { id: "bookmarks", label: "Bookmarks" },
      ],
      "home"
    )}

    <div data-subpanel="home">
      <div class="panel">
        <h2>Your classes</h2>
        <p class="panel-sub">Classes your teacher has enrolled you in</p>
        <div class="kclass-list">${classCards}</div>
      </div>
      <div class="panel" style="margin-top:1.5rem">
        <div class="panel-head-row">
          <div><h2>Continue learning</h2><p class="panel-sub" style="margin:0">Pick up where you left off</p></div>
        </div>
        ${cardRow(k.continue)}
      </div>
      <div class="panel" style="margin-top:1.5rem">
        <h2>Recommended for you</h2>
        <p class="panel-sub">Popular resources from your library</p>
        ${cardRow(k.library.slice(0, 6))}
      </div>
    </div>

    <div data-subpanel="library" hidden>
      <div class="panel">
        <div class="ksearch">
          <span class="ksearch-icon">${icon("search")}</span>
          <input class="input" data-library-search placeholder="Search the library…" aria-label="Search the library">
        </div>
        <div class="kchips">${channelChips}</div>
        <div data-library-grid>${cardRow(k.library)}</div>
      </div>
    </div>

    <div data-subpanel="bookmarks" hidden>
      <div class="panel">
        <h2>Bookmarks</h2>
        <p class="panel-sub">Resources you've saved for later</p>
        ${k.bookmarks.length ? cardRow(k.bookmarks) : `<div class="empty-state">No bookmarks yet.</div>`}
      </div>
    </div>`;
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
};

/* Classes persist in localStorage; the demo class (and any legacy
   assignment store) is migrated in on first run. */
function getClasses() {
  let classes = read(K_CLASSES, null);
  if (!classes || !classes.length) {
    classes = [
      {
        id: uid(),
        name: KOLIBRI.coach.className,
        learners: KOLIBRI.coach.learners,
        assignments: read(K_ASSIGN, null) || KOLIBRI.coach.assignments,
      },
    ];
    write(K_CLASSES, classes);
  }
  return classes;
}
const saveClasses = (classes) => write(K_CLASSES, classes);

function currentClass() {
  const classes = getClasses();
  const cls = classes.find((c) => c.id === coachState.classId) || classes[0];
  coachState.classId = cls.id;
  return { classes, cls };
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

function typeBadge(type) {
  const t = ASSIGN_TYPES[type];
  return `<span class="assign-badge" style="background:${t.color}" title="${t.label}">${icon(t.icon)}</span>`;
}

/* one row in the Overview / Assignments lists */
function assignmentRow(a) {
  const comp = assignmentCompletion(a);
  const sc = assignmentAvgScore(a);
  const cnt = statusCounts(a);
  const t = ASSIGN_TYPES[a.type];
  return `<div class="assign-row">
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

function coachAssignments(list, learners) {
  const typeOpts = Object.entries(ASSIGN_TYPES)
    .map(([v, t]) => `<option value="${v}">${t.label}</option>`)
    .join("");
  const learnerChecks = learners
    .map(
      (l) => `<label class="lchk"><input type="checkbox" name="learner" value="${l.id}" checked> ${esc(l.name)}</label>`
    )
    .join("");

  return `
    <div class="panel">
      <div class="panel-head-row">
        <div><h2>Assignments</h2><p class="panel-sub" style="margin:0">Assign a lesson, exercise, or quiz — then track it</p></div>
        <button class="btn btn-primary" data-new-assign-toggle>${icon("plus")} New assignment</button>
      </div>

      <form id="assignForm" class="add-user-form" ${coachState.openForm ? "" : "hidden"}>
        <div class="form-row">
          <div class="field"><label>Type</label>
            <select class="select" name="type">${typeOpts}</select></div>
          <div class="field"><label>Title</label>
            <input class="input" name="title" required placeholder="e.g. Fractions — Part 2"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Detail</label>
            <input class="input" name="detail" placeholder="e.g. 4 resources / 10 questions"></div>
          <div class="field"><label>Due</label>
            <input class="input" name="due" placeholder="e.g. in 1 week"></div>
        </div>
        <div class="field">
          <label>Assign to <span style="font-weight:400;color:var(--muted-foreground)">(uncheck to exclude a learner)</span></label>
          <div class="assign-learners">${learnerChecks}</div>
        </div>
        <div class="add-user-actions">
          <button class="btn btn-primary" type="submit">${icon("send")} Assign to class</button>
          <button class="btn btn-outline" type="button" data-assign-cancel>Cancel</button>
        </div>
      </form>

      <div class="assign-list">${list.map(assignmentRow).join("")}</div>
    </div>`;
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
        <div class="ut-cell ut-actions"><button class="icon-btn danger" data-learner-remove="${l.id}" title="Remove from class">${icon("trash")}</button></div>
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
            <p class="hint">${accounts.length ? `${accounts.length} learner account${accounts.length === 1 ? "" : "s"} available to enroll.` : "No unenrolled learner accounts — add one by name instead."}</p></div>
          <div class="field"><label>…or add by name</label>
            <input class="input" name="name" maxlength="60" placeholder="e.g. Amina Hassan">
            <p class="hint">Creates a roster entry without a portal account.</p></div>
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

function classSwitcher(classes, cls) {
  const chips = classes
    .map(
      (c) =>
        `<button class="kchip ${c.id === cls.id ? "active" : ""}" data-class-switch="${c.id}">
          ${icon("graduation")} ${esc(c.name)} <span class="kchip-count">${c.learners.length}</span>
        </button>`
    )
    .join("");
  return `
    <div class="kchips" style="margin-bottom:1rem">
      ${chips}
      <button class="kchip kchip-add" data-new-class-toggle>${icon("plus")} New class</button>
    </div>
    <form id="newClassForm" class="add-user-form" ${coachState.openClassForm ? "" : "hidden"}>
      <div class="form-row">
        <div class="field"><label>Class / grade name</label>
          <input class="input" name="name" required maxlength="60" placeholder="e.g. Grade 4 — Red"></div>
        <div class="add-user-actions" style="align-self:end;margin-bottom:1rem">
          <button class="btn btn-primary" type="submit">${icon("plus")} Create class</button>
          <button class="btn btn-outline" type="button" data-class-cancel>Cancel</button>
        </div>
      </div>
    </form>`;
}

function teacherBody() {
  const { classes, cls } = currentClass();
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

  const tabBar = `<div class="ksubtabs">${[
    { id: "overview", label: "Overview" },
    { id: "assignments", label: "Assignments" },
    { id: "learners", label: "Learners" },
  ]
    .map(
      (t) => `<button class="ksubtab ${t.id === coachState.tab ? "active" : ""}" data-coach-tab="${t.id}">${t.label}</button>`
    )
    .join("")}</div>`;

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
  if (coachState.tab === "assignments") content = coachAssignments(list, learners);
  else if (coachState.tab === "learners")
    content = coachState.learnerId
      ? coachLearnerDetail(list, learners, coachState.learnerId, cls)
      : coachLearnersList(list, learners, cls);
  else content = coachOverview(list, learners);

  return `
    <div class="panel-head-row" style="margin-bottom:1rem">
      <div>
        <h2 style="font-size:1.15rem">${esc(cls.name)} · Coach</h2>
        <p class="panel-sub" style="margin:0">Create classes, enroll learners, assign work, and track results</p>
      </div>
      <button class="btn btn-primary" data-new-assign>${icon("plus")} New assignment</button>
    </div>
    ${classSwitcher(classes, cls)}
    ${metricTiles}
    ${smart}
    ${tabBar}
    <div>${content}</div>`;
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
  return roleBanner(role) + (BODIES[role] || learnerBody)(ctx);
}

/* ---------------------------------------------------------- page shell */
export function myDashboardMain(user, events) {
  const current = DASH_ROLES.includes(user.role) ? user.role : "admin";
  const tabs = DASH_ROLES.map(
    (r) =>
      `<button class="role-tab ${r === current ? "active" : ""}" data-role="${r}">${ROLE_LABEL[r]}</button>`
  ).join("");

  return `
    <section class="dash">
      <div class="container">
        <div class="dash-head">
          <div>
            <span class="eyebrow">My Dashboard</span>
            <h1>Welcome back, ${esc((user.fullName || user.username || "there").split(" ")[0])}</h1>
            <p>Signed in as <strong>${esc(ROLE_LABEL[user.role] || user.role)}</strong>.
              Switch the view below to explore each role's workspace.</p>
          </div>
          <button class="btn btn-outline" data-logout>${icon("logout")} Sign out</button>
        </div>
        <div class="role-switch">${tabs}</div>
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
        if (data.role === "admin" && !/@humanpractice\.org$/i.test(data.email))
          return toast("Invalid staff email", "Admins require an @humanpractice.org email.", "error");
      }
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
    body.querySelector("[data-new-assign]")?.addEventListener("click", () => {
      coachState.tab = "assignments";
      coachState.openForm = true;
      renderRole("teacher");
    });
    body.querySelector("[data-new-assign-toggle]")?.addEventListener("click", () => {
      coachState.openForm = !coachState.openForm;
      renderRole("teacher");
    });
    body.querySelector("[data-assign-cancel]")?.addEventListener("click", () => {
      coachState.openForm = false;
      renderRole("teacher");
    });
    body.querySelector("#assignForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      const ids = [...form.querySelectorAll('input[name="learner"]:checked')].map((c) => c.value);
      if (!(data.title || "").trim()) return toast("Title required", "Give the assignment a title.", "error");
      if (!ids.length) return toast("No learners selected", "Pick at least one learner.", "error");
      const withScore = data.type !== "lesson";
      const results = ids.map((id) => (withScore ? { id, pct: 0, score: 0 } : { id, pct: 0 }));
      const { classes, cls } = currentClass();
      cls.assignments.unshift({
        id: uid(),
        type: data.type || "lesson",
        title: data.title.trim(),
        detail: (data.detail || "").trim() || (withScore ? "questions" : "resources"),
        due: (data.due || "").trim() || "no due date",
        results,
      });
      saveClasses(classes);
      coachState.openForm = false;
      toast("Assignment created", `“${data.title.trim()}” assigned to ${ids.length} learner${ids.length === 1 ? "" : "s"}.`, "success");
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
      const name = (new FormData(e.currentTarget).get("name") || "").trim();
      if (!name) return toast("Name required", "Give the class a name, e.g. Grade 4 — Red.", "error");
      const classes = getClasses();
      if (classes.some((c) => c.name.toLowerCase() === name.toLowerCase()))
        return toast("Duplicate class", `A class called “${name}” already exists.`, "error");
      const cls = { id: uid(), name, learners: [], assignments: [] };
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
      let entry;
      if (data.userId) {
        const u = read(K_USERS, []).find((x) => x.id === data.userId);
        if (!u) return toast("Account not found", "", "error");
        entry = { id: u.id, name: u.fullName || u.username, active: "just now", account: true };
      } else {
        const name = (data.name || "").trim();
        if (!name) return toast("Pick an account or type a name", "", "error");
        if (cls.learners.some((l) => l.name.toLowerCase() === name.toLowerCase()))
          return toast("Already enrolled", `${name} is already in ${cls.name}.`, "error");
        entry = { id: uid(), name, active: "just now" };
      }
      cls.learners.push(entry);
      saveClasses(classes);
      coachState.openLearnerForm = false;
      toast("Learner added", `${entry.name} enrolled in ${cls.name}.`, "success");
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

  tabs.forEach((t) => t.addEventListener("click", () => renderRole(t.dataset.role)));
  const current = tabs.find((t) => t.classList.contains("active"))?.dataset.role || user.role;
  wireBody(current);
}
