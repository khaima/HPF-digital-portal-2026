/* ============================================================
   HPF Digital Portal — SPA controller
   Router, auth + login repository, views, and interactions.
   ============================================================ */

import { icon } from "./icons.js";
import {
  PORTAL_CARDS, CURRICULUM, RESOURCES, ASSESSMENT, IMPACT,
  ROLES, SELF_SERVE_ROLES, ORG_TYPES, COUNTIES, VISIT_TYPES, HERO_SLIDES, HERO_QUOTES,
  REGIONS, PROJECTS, EMPOWERMENT_MODEL,
} from "./data.js";
import {
  $, $$, read, write, esc, initials, uid, BASE,
  startGlobalCounters, runCounters, toast,
} from "./util.js";
import { myDashboardMain, wireMyDashboard } from "./dashboards.js";
import { supabase, adminClient, authMessage } from "./supabase.js";
import {
  isRecoveryOpen, openRecovery, closeRecovery, openPasswordReset, openEmailConfirm,
  openStaffInvite, resumeUsernameRecovery, recoveryOwnsSession,
  recoveryHtml, recoveryTitle, wireRecovery,
} from "./recovery.js";

/* ------------------------------------------------------------ storage keys */
const K_USERS = "hpf_users";
const K_SESSION = "hpf_session";
const K_EVENTS = "hpf_login_events"; // dummy repository of all login requests
const ADMIN_EMAIL = "patrick@humanpractice.org";
const K_FO_OUTBOX = "hpf_fo_outbox"; // field reports written offline, waiting to sync

/* ------------------------------------------------------------ officer's assigned schools
   Which schools this field officer covers — school_officer_assignments,
   admin-managed, RLS lets an officer read only their own rows. Drives the
   report form's school picker: an officer can only file a NEW report for a
   school they are assigned to (server-enforced, not just a UI nicety — the
   "fr insert" policy checks the same assignment table), so a free-text field
   here would just produce a confusing RLS rejection instead of a clear list. */
let foSchoolsCache = [];
let foSchoolsLoaded = false;

async function loadFoSchools() {
  const { data, error } = await supabase
    .from("school_officer_assignments").select("school").order("school");
  foSchoolsLoaded = true;
  if (!error) foSchoolsCache = (data || []).map((r) => r.school);
  return foSchoolsCache;
}

/* ------------------------------------------------------------ field reports
   Real Postgres table (field_reports), RLS-scoped so a field officer sees
   their own visits and an admin sees every officer's. The page renders
   synchronously, so reads come from a module-level cache filled on mount —
   the same pattern schools and school_returns already use. */
let foReportsCache = [];
let foReportsLoaded = false;
let foReportsError = null;

async function loadFoReports() {
  const { data, error } = await supabase
    .from("field_reports").select("*").order("created_at", { ascending: false });
  foReportsLoaded = true;
  foReportsError = error ? authMessage(error) : null;
  if (!error) foReportsCache = data || [];
  return foReportsCache;
}

/* A report only ever reaches Postgres if the browser had a connection at the
   moment it was submitted — field officers work in places that often don't.
   A report that fails for that reason is queued here rather than lost, and
   flushed automatically the next time the browser comes online or this page
   loads. A report Postgres refuses for any OTHER reason (no JWT, RLS) is a
   problem retrying can never fix, so it is never queued — see
   foReportIsConnectivityFailure below. */
const foOutbox = () => read(K_FO_OUTBOX, []);
const foReportIsConnectivityFailure = (error) =>
  // A genuine network failure never reaches PostgREST, so supabase-js has no
  // structured error to hand back — only a message like "Failed to fetch".
  // An RLS refusal (42501) or any other structured Postgres error is real: the
  // request arrived and was declined, which offline retry cannot change.
  !error.code && /fetch|network/i.test(error.message || "");

/* Returns { synced, changed } rather than just a sync count. A pending item
   that turns out to be blocked is not a sync, but the outbox state still
   changed — the row needs to stop showing as "pending" and start showing why
   it's stuck, so callers must re-render on either, not only on success. */
async function flushFoOutbox() {
  const queue = foOutbox();
  if (!queue.length) return { synced: 0, changed: false };
  const remaining = [];
  let synced = 0, newlyBlocked = 0;
  for (const item of queue) {
    const { error } = await supabase.from("field_reports").insert(item.row);
    if (error) {
      if (foReportIsConnectivityFailure(error)) remaining.push(item);
      // else: a real refusal (e.g. the session lost its JWT) — surfacing this
      // silently on every page load would be noise; it shows next time the
      // officer opens the field portal and sees it still pending.
      else { remaining.push({ ...item, blocked: authMessage(error) }); newlyBlocked++; }
    } else synced++;
  }
  write(K_FO_OUTBOX, remaining);
  if (synced) await loadFoReports();
  return { synced, changed: synced > 0 || newlyBlocked > 0 };
}

/* ------------------------------------------------------------ user shape
   Views read camelCase (user.fullName, user.orgType); the profiles table is
   snake_case. Translate once, here. */
const toUiUser = (row, fallbackEmail = "") => ({
  id: row.id,
  fullName: row.full_name || "",
  role: row.role || "learner",
  email: row.email || fallbackEmail,
  username: row.username || "",
  school: row.school || "",
  orgType: row.org_type || "",
  county: row.county || "",
  // locally-created accounts carry `region`; Supabase stores the same value in
  // `county`. Expose both so the admin table reads one field for either kind.
  region: row.county || "",
  project: row.project || "",
  createdAt: row.created_at ? Date.parse(row.created_at) : Date.now(),
  // Set by an admin invite (patch-15) and cleared once the invitee chooses
  // their own password (recovery.js "invite" step). Absent pre-patch-15
  // columns read as undefined, which is falsy here — safe by default.
  needsPassword: !!row.needs_password,
});

/* Profile of the signed-in Supabase user, loaded on sign-in and at boot.
   Cached so Auth.current() can stay synchronous for the many views that call
   it inline while building HTML. */
let supaUser = null;

async function refreshProfile(session) {
  if (!session?.user) { supaUser = null; return null; }
  const { data, error } = await supabase
    .from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error || !data) { supaUser = null; return null; }
  supaUser = toUiUser(data, session.user.email);
  return supaUser;
}

/* Learners are not Supabase accounts (see supabase/SETUP.md): they have no JWT,
   so every RLS policy — all granted `to authenticated` — denies them. Their
   accounts and session stay in localStorage exactly as before. */
const isLearnerRole = (role) => role === "learner";

/* ------------------------------------------------------------ legacy accounts
   Staff accounts created before the Supabase migration exist only in this
   browser's localStorage; Postgres has never heard of them. Without this path
   the migration locks those people out of the site on the day it ships.

   Supabase stays authoritative — the caller only reaches here once Supabase has
   rejected the credentials — so anyone whose account has been recreated
   properly always gets the real one, never this stale copy.

   The catch, and why the session is flagged: a legacy sign-in produces no JWT,
   and every RLS policy in schema.sql is granted `to authenticated`. So Postgres
   returns nothing to these users. The localStorage-backed parts of the app work
   as they always did; anything served from the database stays empty. `legacy`
   lets the UI say that plainly instead of leaving someone staring at blank
   panels wondering what broke. */
function legacyLogin(id, password) {
  const user = Auth.users().find(
    (u) => !isLearnerRole(u.role) &&
      ((u.email || "").toLowerCase() === id || (u.username || "").toLowerCase() === id)
  );
  if (!user || user.password !== password) return null;
  const { password: _p, ...safe } = user;
  safe.legacy = true;
  write(K_SESSION, safe);
  Repo.recordLocal(safe, "login");
  return safe;
}

/* ------------------------------------------------------------ login repository
   Every login / signup is recorded for the admin inbox: in login_events for
   real accounts, in localStorage for learners. */
const Repo = {
  events: () => read(K_EVENTS, []),
  /* A learner has no Supabase account, so they cannot satisfy login_events'
     `to authenticated` insert policy. patch-21's record_local_login() RPC is
     the narrow, anon-callable exception that gives their sign-ins the same
     Postgres home every other role's already had — without it, a learner's
     login existed only in that learner's own browser, and the admin's
     "Logins this week" chart silently counted only the sign-ins that had
     happened on the admin's own device.

     The localStorage copy stays, but it is now a cache, not the record: the
     admin inbox reads Postgres (see allEvents), and this local array only
     backs the same-device offline case and the cross-tab storage listener. */
  recordLocal(user, type) {
    const events = Repo.events();
    events.unshift({
      id: uid(),
      type, // "login" | "signup"
      name: user.fullName || user.username || user.email || "Unknown",
      identifier: user.email || user.username || "",
      role: user.role || "learner",
      at: Date.now(),
      status: "delivered",
      to: ADMIN_EMAIL,
    });
    write(K_EVENTS, events.slice(0, 200));
    // Best-effort, same as record(): a failed audit write must never block a
    // valid sign-in, and offline is the normal case for these accounts.
    supabase
      .rpc("record_local_login", {
        p_type: type,
        p_name: user.fullName || user.username || "Unknown",
        p_identifier: user.username || user.email || "",
      })
      .then(({ error }) => { if (error) console.warn("record_local_login failed:", error.message); });
  },
  async record(user, type) {
    if (isLearnerRole(user.role)) return Repo.recordLocal(user, type);
    // Best-effort: a failed audit insert must never block a valid sign-in.
    const { error } = await supabase.from("login_events").insert({
      type,
      name: user.fullName || user.email || "Unknown",
      identifier: user.email || user.username || "",
      role: user.role,
      delivered_to: ADMIN_EMAIL,
    });
    if (error) console.warn("login_events insert failed:", error.message);
  },
  /* The admin inbox, merged. Staff logins are written straight to Postgres by
     record() above and were never read back — the inbox showed only
     recordLocal()'s learner/legacy events, a different and much smaller slice
     of activity than what the table actually holds (see AUDIT.md §3).
     Normalized onto the local shape (`at` as an epoch number, `to` not
     `delivered_to`) so adminBody()'s existing rendering needs no changes.
     Only fetches for an admin viewing their own dashboard — every other role
     receives `events` but never reads it, so a query nobody will see would
     just be a wasted round trip on every dashboard load. */
  async allEvents(user) {
    const local = Repo.events();
    if (!user || user.role !== "admin") return local;
    const { data, error } = await supabase
      .from("login_events").select("*").order("created_at", { ascending: false }).limit(200);
    if (error) {
      console.warn("login_events fetch failed:", error.message);
      return local; // degrade to the partial local picture rather than an empty inbox
    }
    // Postgres is the whole picture now: patch-21 gave learner/legacy logins
    // their own rows (source='local') via record_local_login(), so this no
    // longer merges in Repo.events(). Merging would double-count every local
    // sign-in that happened in *this* browser while under-counting every one
    // that happened in someone else's — the exact asymmetry that made the
    // admin's login chart device-dependent before this patch.
    return (data || []).map((e) => ({
      id: e.id, type: e.type, name: e.name, identifier: e.identifier,
      role: e.role, at: Date.parse(e.created_at), status: "delivered", to: e.delivered_to,
      source: e.source || "supabase",
    }));
  },
};

/* ------------------------------------------------------------ auth store
   Staff (teacher / school_leader / field_officer / admin) authenticate against
   Supabase. Learners authenticate against localStorage. Auth.current() returns
   whichever applies — K_SESSION also carries admin impersonation, so it wins. */
const Auth = {
  users: () => read(K_USERS, []),
  current: () => read(K_SESSION, null) || supaUser,
  isAuthed: () => !!Auth.current(),

  async register(data) {
    if (isLearnerRole(data.role)) return Auth.registerLearner(data);

    const { data: res, error } = await supabase.auth.signUp({
      email: data.email,
      password: data.password,
      // Keys read by handle_new_user() in supabase/schema.sql. `role` is
      // clamped server-side by patch-01-security.sql — admin is never granted
      // from here, whatever the client sends.
      options: {
        // Where the confirmation link comes back to. Must be allow-listed under
        // Authentication → URL Configuration, or Supabase uses the Site URL.
        emailRedirectTo: `${location.origin}${BASE}/auth`,
        data: {
          full_name: data.fullName || "",
          username: data.username || null,
          role: data.role,
          school: data.school || null,
          // the form's "County / region" select lists counties, so it feeds
          // profiles.county — see supabase/patch-03-profile-fields.sql
          county: data.region || data.county || null,
          org_type: data.orgType || null,
          project: data.project || null,
        },
      },
    });
    if (error) throw new Error(authMessage(error));
    /* This project has "Confirm email" on, so a successful signUp() returns the
       account but no session. That is not a failure — the person is registered.
       Hand the address back so the caller can ask for the emailed link or code
       instead of leaving someone registered and locked out at the same time. */
    if (!res.session) {
      return { needsConfirm: true, email: data.email, fullName: data.fullName || "" };
    }
    const user = await refreshProfile(res.session);
    if (!user) throw new Error("Account created, but the profile could not be loaded. Please sign in.");
    await Repo.record(user, "signup");
    return user;
  },

  /* unchanged localStorage path, learners only */
  registerLearner(data) {
    const users = Auth.users();
    const key = (data.username || "").toLowerCase();
    if (users.some((u) => (u.username || "").toLowerCase() === key)) {
      throw new Error("An account with those details already exists.");
    }
    const user = { ...data, id: uid(), role: "learner", createdAt: Date.now() };
    users.push(user);
    write(K_USERS, users);
    const { password, ...safe } = user;
    write(K_SESSION, safe);
    Repo.recordLocal(safe, "signup");
    return safe;
  },

  async login(identifier, password) {
    const id = identifier.trim().toLowerCase();

    // A local learner account takes precedence — that is the only way a
    // username (rather than an email) can resolve without a session.
    const local = Auth.users().find(
      (u) => isLearnerRole(u.role) &&
        ((u.username || "").toLowerCase() === id || (u.email || "").toLowerCase() === id)
    );
    if (local) {
      if (local.password !== password) {
        throw new Error("Invalid credentials. Check your details and try again.");
      }
      const { password: _p, ...safe } = local;
      write(K_SESSION, safe);
      Repo.recordLocal(safe, "login");
      return safe;
    }

    // No email means this cannot be a Supabase sign-in, but it may still be a
    // staff account created here before the migration.
    if (!id.includes("@")) {
      const legacy = legacyLogin(id, password);
      if (legacy) return legacy;
      throw new Error("Staff sign in with their email address. Learners use their username.");
    }

    const { data: res, error } = await supabase.auth.signInWithPassword({ email: id, password });
    if (!error) {
      const user = await refreshProfile(res.session);
      if (!user) throw new Error("Signed in, but no profile row exists for this account.");
      await Repo.record(user, "login");
      return user;
    }

    // Fall back only when Supabase specifically rejects the credentials, which
    // is what it says for an account it has never seen. A network failure or a
    // rate limit must surface as itself — silently treating those as "try the
    // old account" would hand someone a degraded session during an outage.
    if ((error.message || "").toLowerCase().includes("invalid login credentials")) {
      const legacy = legacyLogin(id, password);
      if (legacy) return legacy;
    }
    // The password was right; the address was never confirmed. Flag it so the UI
    // can offer the confirmation email rather than treating it as a bad login.
    if ((error.message || "").toLowerCase().includes("email not confirmed")) {
      const err = new Error(authMessage(error));
      err.needsConfirm = true;
      err.email = id;
      throw err;
    }
    throw new Error(authMessage(error));
  },

  async logout() {
    localStorage.removeItem(K_SESSION);
    localStorage.removeItem("hpf_impersonate"); // never leave an orphan impersonation
    supaUser = null;
    await supabase.auth.signOut();
  },
};

/* ------------------------------------------------------------ shared chrome */
const NAV = [
  { label: "Home", href: "/" },
  { label: "Curriculum", href: "/curriculum" },
  { label: "Learning Resources", href: "/resources" },
  { label: "Assessment Tools", href: "/assessment" },
  { label: "Field Officer App", href: "/field-officer" },
  { label: "Community Resources", href: "/community-resources" },
];

/* shown only when signed in */
const NAV_AUTHED = [...NAV, { label: "My Dashboard", href: "/dashboard" }];

function brand() {
  return `
    <a class="brand" href="/" data-link>
      <span class="brand-mark">HPF</span>
      <span class="brand-text">
        <strong>Human Practice</strong>
        <span>Digital Portal</span>
      </span>
    </a>`;
}

/* the Field Officer App is only relevant to field officers and admins */
const HIDE_FIELD_OFFICER = new Set(["teacher", "learner", "school_leader"]);
/* field officers only see their own field — hide the education pages */
const EDU_NAV = new Set(["/curriculum", "/resources", "/assessment"]);

function header(path) {
  const user = Auth.current();
  const nav = (user ? NAV_AUTHED : NAV).filter((n) => {
    if (n.href === "/field-officer" && user && HIDE_FIELD_OFFICER.has(user.role)) return false;
    if (user && user.role === "field_officer" && EDU_NAV.has(n.href)) return false;
    return true;
  });
  const links = nav
    .map(
      (n) =>
        `<a href="${n.href}" data-link class="${path === n.href ? "active" : ""}">${n.label}</a>`
    )
    .join("");

  const action = user
    ? `<a class="user-chip" href="/dashboard" data-link title="${esc(user.fullName || user.username || "")}">
         <span class="avatar">${initials(user.fullName || user.username)}</span>
         <span>${esc((user.fullName || user.username || "Account").split(" ")[0])}</span>
       </a>
       <button class="btn btn-ghost" data-logout title="Log out">${icon("logout")}</button>`
    : `<a class="btn btn-primary" href="/auth" data-link>Login</a>`;

  return `
    <header class="site-header">
      <div class="container">
        ${brand()}
        <nav class="main-nav" id="mainNav">${links}</nav>
        <div class="header-actions">
          ${action}
        </div>
      </div>
    </header>`;
}

function footer() {
  return `
    <footer class="site-footer">
      <div class="container">
        <div class="footer-brand">
          <span class="footer-mark">HPF</span>
          <span>Human Practice Foundation · Digital Portal</span>
        </div>
        <div class="footer-meta">© ${new Date().getFullYear()} Human Practice Foundation</div>
      </div>
    </footer>`;
}

function shell(path, main) {
  return `${header(path)}<main class="fade-in">${main}</main>${footer()}`;
}

/* the floating badge that sits on the hero image — changes with each slide */
function heroBadge(slide) {
  return `
    <span class="hf-icon">${icon(slide.icon)}</span>
    <div>
      <div class="hf-label">${esc(slide.label)}</div>
      <div class="hf-value">${esc(slide.value)}</div>
    </div>`;
}

/* small helper for count-up numbers in static pages */
function countNum(count, suffix = "", compact = false) {
  return `<span class="count" data-count="${count}"${
    compact ? " data-compact" : ""
  } data-suffix="${esc(suffix)}">0${esc(suffix)}</span>`;
}

/* ------------------------------------------------------------ card helpers */
function cardsGrid(items) {
  return `<div class="card-grid">${items
    .map(
      (c) => `
      <a class="portal-card${c.variant === "primary" ? " primary" : ""}" href="${c.href || "#"}" ${c.href ? "data-link" : ""}>
        <div class="card-icon">${icon(c.icon)}</div>
        <h3>${esc(c.title)}</h3>
        <p>${esc(c.desc)}</p>
        <span class="card-link">
          ${esc(c.cta || "Open")} ${icon("arrowUpRight")}
        </span>
      </a>`
    )
    .join("")}</div>`;
}

function resourceGrid(items, cols = "cols-3") {
  return `<div class="card-grid ${cols}">${items
    .map(
      (c) => `
      <button class="portal-card" type="button" data-resource="${esc(c.title)}">
        <div class="card-icon">${icon(c.icon)}</div>
        <h3>${esc(c.title)}</h3>
        <p>${esc(c.desc)}</p>
        <span class="card-link plain">Open ${icon("arrowUpRight")}</span>
      </button>`
    )
    .join("")}</div>`;
}

/* ------------------------------------------------------------ home */
function pageHome() {
  const main = `
    <section class="hero">
      <div class="container hero-grid">
        <div class="hero-copy">
          <span class="eyebrow-dark"><span class="dot"></span>Education Portal</span>
          <p class="hero-quote-sm"><span class="hq-lead" data-hero-quote>${esc(HERO_QUOTES[0])}</span> <strong>That's human practice.</strong></p>
          <h1 class="hero-title">Human Practice Foundation <span class="accent">Digital Portal</span></h1>
          <p class="lede">Empowering teachers, learners, and schools through digital learning, assessments, and practical education resources.</p>
          <div class="hero-actions">
            <a class="btn btn-primary btn-lg" href="/resources" data-link>Access Learning Resources ${icon("arrowRight")}</a>
            <a class="btn btn-outline btn-lg" href="/field-officer" data-link>Field Officer Login</a>
          </div>
          <div class="hero-stats">
            <div class="hero-stat"><div class="label">Schools</div><div class="num">${countNum(30, "+")}</div></div>
            <div class="hero-stat"><div class="label">Teachers</div><div class="num">${countNum(500, "+")}</div></div>
            <div class="hero-stat"><div class="label">Learners</div><div class="num">${countNum(10000, "+", true)}</div></div>
          </div>
        </div>
        <div class="hero-media">
          <div class="hero-frame" data-hero>
            ${HERO_SLIDES.map(
              (s, i) => `<img class="hero-slide${i === 0 ? " is-active" : ""}"
                src="${BASE}/${s.src}" width="1024" height="1024" alt="${esc(s.alt)}"
                fetchpriority="${i === 0 ? "high" : "low"}" decoding="async" />`
            ).join("")}
            <div class="hero-dots">
              ${HERO_SLIDES.map(
                (s, i) => `<button class="hero-dot${i === 0 ? " is-active" : ""}"
                  data-hero-dot="${i}" aria-label="Show ${esc(s.value)}"></button>`
              ).join("")}
            </div>
          </div>
          <div class="hero-float" data-hero-float>${heroBadge(HERO_SLIDES[0])}</div>
        </div>
      </div>
    </section>

    <section class="section cem-section" id="model">
      <div class="container">
        <div class="section-head">
          <span class="eyebrow">OUR APPROACH</span>
          <h2>Child Empowerment Model</h2>
          <p>Three pillars — select one to see the programmes under it.</p>
        </div>
        <div class="cem">
          ${EMPOWERMENT_MODEL.map((p) => `
            <details class="cem-row">
              <summary class="cem-pillar">
                <span class="cem-pillar-ic">${icon(p.icon)}</span>
                <span class="cem-pillar-name">${esc(p.pillar)}</span>
                <span class="cem-count">${p.groups.reduce((n, g) => n + g.items.length, 0)}</span>
                <span class="cem-chev">${icon("arrowRight")}</span>
              </summary>
              <div class="cem-groups">
                ${p.groups.map((g) => `
                  <div class="cem-group">
                    <h3>${esc(g.title)} <span class="cem-ic">${icon(g.icon)}</span></h3>
                    <ul>${g.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
                  </div>`).join("")}
              </div>
            </details>`).join("")}
        </div>
      </div>
    </section>

    <section class="section" id="portal">
      <div class="container">
        <div class="section-head">
          <h2>Explore the portal</h2>
          <p>Jump straight into the module you need.</p>
        </div>
        ${cardsGrid(PORTAL_CARDS)}
      </div>
    </section>

    <section class="section" id="about">
      <div class="container">
        <div class="about-grid">
          <div class="about-copy">
            <span class="eyebrow">About HPF</span>
            <h2>Practical, sustainable education for every child</h2>
          </div>
          <p>Human Practice Foundation works to improve the quality of education by
            strengthening schools, empowering teachers, and supporting learners through
            practical, sustainable, and scalable education solutions.</p>
        </div>
      </div>
    </section>

    <section class="section" id="impact">
      <div class="container">
        <div class="section-head">
          <span class="eyebrow">Our impact so far</span>
          <h2>Measurable change across Kenya</h2>
          <p>Real numbers from schools, teachers, and learners we support.</p>
        </div>
        <div class="impact-grid">
          ${IMPACT.map(
            (s) => `<div class="impact-card">
              <span class="ic-icon">${icon(s.icon)}</span>
              <div class="num">${countNum(s.num)}<span class="suffix">${esc(s.suffix)}</span></div>
              <div class="label">${esc(s.label)}</div>
            </div>`
          ).join("")}
        </div>
      </div>
    </section>

    <section class="contact" id="contact">
      <div class="container">
        <div class="contact-grid">
          <div>
            <span class="eyebrow">Get in touch</span>
            <h2>Human Practice Foundation</h2>
            <p>Reach out about partnerships, school programmes, or teacher training.</p>
          </div>
          <div class="contact-list">
            <a class="contact-item" href="mailto:info@humanpracticefoundation.org">
              <span class="ci-icon">${icon("mail")}</span>
              info@humanpracticefoundation.org</a>
            <a class="contact-item" href="tel:+254700000000">
              <span class="ci-icon">${icon("phone")}</span>
              +254 700 000 000</a>
            <a class="contact-item" href="https://www.humanpractice.org/" target="_blank" rel="noopener noreferrer">
              <span class="ci-icon">${icon("link")}</span>
              www.humanpractice.org</a>
            <div class="contact-socials">
              <a href="https://www.facebook.com/humanpracticefoundation" target="_blank" rel="noopener noreferrer" aria-label="Facebook">${icon("facebook")}</a>
              <a href="https://www.linkedin.com/company/human-practice-foundation" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">${icon("linkedin")}</a>
              <a href="https://x.com/humanpracticef" target="_blank" rel="noopener noreferrer" aria-label="X">${icon("twitter")}</a>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  return shell("/", main);
}

function backLink() {
  return `<a class="back-link" href="/" data-link>← Back to overview</a>`;
}

function innerPage({ path, eyebrow, title, intro, body, after = "" }) {
  const main = `
    <section>
      <div class="container inner-page">
        <span class="eyebrow">${esc(eyebrow)}</span>
        <h1>${esc(title)}</h1>
        <p>${esc(intro)}</p>
        <div class="inner-grid">${body}</div>
        ${after ? "" : backLink()}
      </div>
    </section>
    ${after}`;
  return shell(path, main);
}

function pageCurriculum() {
  return innerPage({
    path: "/curriculum",
    eyebrow: "Curriculum",
    title: "Teacher Training Curriculum",
    intro:
      "Professional development modules, training manuals, facilitator guides, and certification resources designed to strengthen teaching practice in every classroom.",
    body: resourceGrid(CURRICULUM),
  });
}

function pageResources() {
  return innerPage({
    path: "/resources",
    eyebrow: "Learning Resources",
    title: "Digital Learning Resources",
    intro:
      "Handpicked materials teachers and school leaders use most — lesson plans, videos, worksheets, and classroom resources across subjects and grade levels.",
    body: resourceGrid(RESOURCES, "cols-4"),
  });
}

function pageAssessment() {
  const after = `
    <section class="impact-band">
      <div class="container">
        <div class="band-head">
          <h2>Our impact so far</h2>
          <p class="band-sub">Real numbers from classrooms across the counties we serve.</p>
        </div>
        <div class="band-grid">
          <div class="band-stat"><div class="num">${countNum(30, "+")}</div><div class="label">Schools Supported</div></div>
          <div class="band-stat"><div class="num">${countNum(10000, "+")}</div><div class="label">Learners Reached</div></div>
          <div class="band-stat"><div class="num">${countNum(500, "+")}</div><div class="label">Teachers Trained</div></div>
          <div class="band-stat"><div class="num">${countNum(4, "")}</div><div class="label">Counties Served</div></div>
        </div>
      </div>
    </section>
    <section>
      <div class="container band-back">${backLink()}</div>
    </section>`;
  return innerPage({
    path: "/assessment",
    eyebrow: "Assessment Tools",
    title: "Assessment & Reporting",
    intro:
      "Student assessments, baseline tools, classroom observation instruments, and reporting templates to track learning outcomes and school improvement.",
    body: resourceGrid(ASSESSMENT),
    after,
  });
}

function pageNotFound() {
  const main = `
    <div class="notfound">
      <div>
        <div class="code">404</div>
        <h1>Page not found</h1>
        <p>The page you're looking for doesn't exist or has moved.</p>
        <a class="btn btn-primary btn-lg" href="/" data-link>${icon("arrowLeft")} Back home</a>
      </div>
    </div>`;
  return shell("__none__", main);
}

/* ------------------------------------------------------------ auth page */
function pageAuth(mode = "login") {
  // Recovery takes over the whole card: someone who can't get in has no use for
  // the login form until they've finished, and the panel drives its own steps.
  if (isRecoveryOpen()) {
    const { h1, sub } = recoveryTitle();
    return authShell(`
      <main class="auth-main">
        <h1 data-recover-h1>${esc(h1)}</h1>
        <p data-recover-sub>${esc(sub)}</p>
        ${recoveryHtml()}
      </main>`);
  }

  const roleOptions =
    `<option value="" disabled selected>Select your role</option>` +
    SELF_SERVE_ROLES.map((r) => `<option value="${r.value}">${r.label}</option>`).join("");
  const regionOptions =
    `<option value="" disabled selected>Select your region</option>` +
    Object.keys(REGIONS).map((r) => `<option>${r}</option>`).join("");
  const projectOptions =
    `<option value="" disabled selected>Select your project</option>` +
    PROJECTS.map((p) => `<option>${p}</option>`).join("");

  const main = `
      <main class="auth-main">
        <h1>Welcome, educator</h1>
        <p>Sign in or create an account to save resources and request audience access.</p>

        <div class="tabs">
          <button class="tab ${mode === "login" ? "active" : ""}" data-tab="login">Login</button>
          <button class="tab ${mode === "signup" ? "active" : ""}" data-tab="signup">Sign up</button>
        </div>

        <form id="loginForm" ${mode === "login" ? "" : "hidden"}>
          <div class="field">
            <label for="li_id">Username or email</label>
            <input class="input" id="li_id" name="identifier" type="text" autocomplete="username" required>
          </div>
          <div class="field">
            <label for="li_pw">Password</label>
            <input class="input" id="li_pw" name="password" type="password" autocomplete="current-password" required>
          </div>
          <button class="btn btn-primary btn-block" type="submit">Login</button>
          <div class="auth-foot">
            <button class="link-btn" type="button" data-forgot>Forgot password?</button>
            <button class="link-btn" type="button" data-forgot-user>Forgot username?</button>
          </div>
        </form>

        <form id="signupForm" ${mode === "signup" ? "" : "hidden"}>
          <div class="field">
            <label for="su_name">Full name</label>
            <input class="input" id="su_name" name="fullName" type="text" required>
          </div>
          <div class="field">
            <label for="su_role">Role</label>
            <select class="select" id="su_role" name="role">${roleOptions}</select>
            <p class="hint">Learners sign up with a username; everyone else uses an email.
              HPF Staff (Admin) requires an @humanpractice.org email.</p>
          </div>
          <div class="field" data-email-field>
            <label for="su_email">Email</label>
            <input class="input" id="su_email" name="email" type="email">
          </div>
          <div class="field">
            <label for="su_user">Username <span style="font-weight:400;color:var(--muted-foreground)">(optional)</span></label>
            <input class="input" id="su_user" name="username" type="text">
            <p class="hint">Lets you sign in with a username instead of email.</p>
          </div>
          <div class="field">
            <label for="su_pw">Password</label>
            <input class="input" id="su_pw" name="password" type="password" minlength="6" required>
          </div>
          <div class="field">
            <label for="su_region">County / region</label>
            <select class="select" id="su_region" name="region" data-region>${regionOptions}</select>
          </div>
          <div class="field" data-school-field>
            <label for="su_school">School <span class="su-optional" hidden>(optional)</span></label>
            <select class="select" id="su_school" name="school" data-school disabled>
              <option value="" disabled selected>Select a region first</option>
            </select>
          </div>
          <div class="field">
            <label for="su_project">Project</label>
            <select class="select" id="su_project" name="project">${projectOptions}</select>
          </div>
          <button class="btn btn-primary btn-block" type="submit">Create account</button>
        </form>
      </main>`;

  return authShell(main);
}

function authShell(main) {
  return `
    <header class="auth-header">
      <div class="container">
        <a class="brand" href="/" data-link>
          <span class="brand-mark">HPF</span>
          <span class="brand-text-solo">Digital Portal</span>
        </a>
      </div>
    </header>
    <main class="fade-in">${main}</main>`;
}

/* ------------------------------------------------------------ my dashboard */
// render() calls view() and then wireView(path) in strict sequence for the
// same navigation (never concurrently, never out of order — see render()),
// so wireView's /dashboard branch can safely reuse whatever pageDashboard()
// just fetched instead of repeating the same Postgres round trip a moment
// later for the same page load.
let dashboardEventsCache = [];

/* Re-read this account's own role from Postgres. Without this, a promotion or
   demotion made by someone else stays invisible until the next sign-in: the
   role is cached in supaUser at boot and never re-checked, so a staff member
   promoted to admin would keep seeing the staff dashboard.

   Only ever touches a real Supabase session. A learner, a legacy account, and
   an admin impersonating someone all live in K_SESSION, which stays
   authoritative for them — re-reading a profile row would either find nothing
   or, worse, quietly end an impersonation. Returns whether the role actually
   changed, so the caller can say so rather than swapping the UI silently. */
async function syncRoleFromDb() {
  if (read(K_SESSION, null)) return null; // learner / legacy / impersonating
  const before = supaUser?.role;
  if (!before) return null;
  const { data } = await supabase.auth.getSession();
  if (!data?.session) return null;
  await refreshProfile(data.session);
  const after = supaUser?.role;
  return after && after !== before ? after : null;
}

async function pageDashboard() {
  if (!Auth.current()) return pageAuth("login");
  const newRole = await syncRoleFromDb();
  const user = Auth.current();
  if (!user) return pageAuth("login");
  if (newRole) {
    const label = ROLES.find((r) => r.value === newRole)?.label || newRole;
    toast("Your access changed", `You are now signed in as ${label}.`, "success");
  }
  dashboardEventsCache = await Repo.allEvents(user);
  return shell("/dashboard", myDashboardMain(user, dashboardEventsCache));
}

/* ------------------------------------------------------------ field officer */
function pageFieldOfficer() {
  const user = Auth.current();
  if (!user) return pageAuth("login");

  const allowed = user.role === "field_officer" || user.role === "admin";
  // Postgres already scopes this to the signed-in officer via RLS (admins see
  // everyone's), so no client-side filter by user is needed the way the old
  // localStorage version required.
  const outboxPending = foOutbox().filter((o) => !o.blocked);
  const outboxBlocked = foOutbox().filter((o) => o.blocked);
  const syncedCount = foReportsCache.length;
  const totalCount = syncedCount + outboxPending.length + outboxBlocked.length;

  const gateNotice = allowed
    ? ""
    : `<div class="notice">${icon("info")}
        <span>This portal is intended for <strong>Field Officers</strong> and <strong>HPF Staff</strong>.
        Your account role is <strong>${esc(ROLES.find((r) => r.value === user.role)?.label || user.role)}</strong>.
        You can explore the interface below, but submissions are marked for review.</span>
      </div>`;

  // Admin bypasses the assignment check entirely (RLS: is_admin() OR
  // assigned_to_school(school)), so a free-text field is fine and matches
  // that bypass. A field officer can only ever successfully file a NEW report
  // for a school in their own assignment list — offering anything wider would
  // just be a form that sometimes fails with a database error instead of a
  // clear reason.
  const schoolField = user.role === "admin"
    ? `<input class="input" id="fo_school" name="school" type="text" required placeholder="e.g. Nyeri Hill Primary School">`
    : !foSchoolsLoaded
    ? `<input class="input" disabled placeholder="Loading your assigned schools…">`
    : foSchoolsCache.length
    ? `<select class="select" id="fo_school" name="school" required>
         <option value="" disabled selected>Select a school</option>
         ${foSchoolsCache.map((s) => `<option>${esc(s)}</option>`).join("")}
       </select>`
    : `<input class="input" disabled placeholder="No schools assigned yet">`;
  const noAssignmentsNotice = (user.role !== "admin" && foSchoolsLoaded && !foSchoolsCache.length)
    ? `<div class="notice">${icon("info")}
        <span>You have no assigned schools yet, so there is nowhere to file a new report.
        Ask an HPF administrator to assign you to one or more schools.</span>
      </div>`
    : "";

  const dbNotice = !foReportsLoaded
    ? `<div class="empty-state">Loading your reports…</div>`
    : foReportsError
    ? `<div class="notice">${icon("info")}
        <span>Could not load past reports — ${esc(foReportsError)}</span>
        <button class="btn btn-outline btn-xs" data-fo-retry style="margin-left:.6rem">${icon("refresh")} Try again</button>
      </div>`
    : "";

  const visitOptions = VISIT_TYPES.map((v) => `<option>${v}</option>`).join("");
  const countyOptions =
    `<option value="" disabled ${user.county ? "" : "selected"}>Select county</option>` +
    COUNTIES.map(
      (c) => `<option ${user.county === c ? "selected" : ""}>${c}</option>`
    ).join("");

  // Three sources merged into one list: synced (Postgres, authoritative),
  // queued (offline, waiting for a connection), blocked (Postgres refused it
  // for a reason offline retry can't fix — surfaced rather than hidden).
  const allRows = [
    ...foReportsCache.map((s) => ({ ...s, _status: "synced" })),
    ...outboxPending.map((o) => ({ ...o.row, _status: "pending" })),
    ...outboxBlocked.map((o) => ({ ...o.row, _status: "blocked", _reason: o.blocked })),
  ].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  const subsList = allRows.length
    ? allRows
        .map(
          (s) => `
        <div class="submission">
          <span class="s-icon">${icon("clipboard")}</span>
          <div>
            <div class="s-title">${esc(s.school)}</div>
            <div class="s-meta">${esc(s.visit_type)} · ${esc(s.county)} · ${
            s.created_at ? new Date(s.created_at).toLocaleDateString() : "not yet uploaded"
          }${s._status === "blocked" ? ` · ${esc(s._reason)}` : ""}</div>
          </div>
          <span class="pill ${s._status}">${s._status}</span>
        </div>`
        )
        .join("")
    : `<div class="empty-state">No visits recorded yet.<br>Submit your first field report using the form.</div>`;

  const main = `
    <section class="dash">
      <div class="container">
        <div class="dash-head">
          <div>
            <span class="eyebrow">Field Officer Portal</span>
            <h1>Welcome, ${esc((user.fullName || "Officer").split(" ")[0])}</h1>
            <p>Collect monitoring, evaluation, and school support data from the field.</p>
          </div>
          <div style="display:flex;gap:.6rem">
            <a class="btn btn-outline" href="/dashboard" data-link>${icon("layers")} My Dashboard</a>
            <button class="btn btn-outline" data-logout>${icon("logout")} Sign out</button>
          </div>
        </div>

        ${gateNotice}
        ${dbNotice}
        ${noAssignmentsNotice}

        <div class="stat-row">
          <div class="stat-tile">
            <div class="st-label">${icon("clipboard")} Total visits</div>
            <div class="st-num">${countNum(totalCount)}</div>
          </div>
          <div class="stat-tile">
            <div class="st-label">${icon("cloud")} Synced</div>
            <div class="st-num">${countNum(syncedCount)}</div>
          </div>
          <div class="stat-tile">
            <div class="st-label">${icon("clock")} Pending</div>
            <div class="st-num">${countNum(outboxPending.length)}</div>
          </div>
          <div class="stat-tile">
            <div class="st-label">${icon("mapPin")} County</div>
            <div class="st-num" style="font-size:1.1rem">${esc(user.county || "—")}</div>
          </div>
        </div>

        <div class="dash-grid">
          <div class="panel">
            <h2>New field report</h2>
            <p class="panel-sub">Record a school visit, coaching session, or data-collection activity.</p>
            <form id="foForm">
              <div class="field">
                <label for="fo_school">School / institution name</label>
                ${schoolField}
              </div>
              <div class="form-row">
                <div class="field">
                  <label for="fo_visit">Visit type</label>
                  <select class="select" id="fo_visit" name="visitType">${visitOptions}</select>
                </div>
                <div class="field">
                  <label for="fo_county">County</label>
                  <select class="select" id="fo_county" name="county" required>${countyOptions}</select>
                </div>
              </div>
              <div class="form-row">
                <div class="field">
                  <label for="fo_teachers">Teachers present</label>
                  <input class="input" id="fo_teachers" name="teachers" type="number" min="0" value="0">
                </div>
                <div class="field">
                  <label for="fo_learners">Learners reached</label>
                  <input class="input" id="fo_learners" name="learners" type="number" min="0" value="0">
                </div>
              </div>
              <div class="field">
                <label for="fo_notes">Observations & notes</label>
                <textarea class="input" id="fo_notes" name="notes" placeholder="Key findings, support provided, follow-up actions..."></textarea>
              </div>
              <button class="btn btn-primary btn-block" type="submit">${icon("send")} Submit field report</button>
            </form>
          </div>

          <div class="panel">
            <h2>Recent submissions</h2>
            <p class="panel-sub">Saved to the HPF database · anything queued only exists on this device until it syncs.</p>
            <div id="subsList">${subsList}</div>
          </div>
        </div>
      </div>
    </section>`;
  return shell("/field-officer", main);
}

/* ------------------------------------------------------------ router */
/* ------------------------------------------------------------ community resources
   Greeting, the four areas HPF supports on, and an AI chat surface.

   The assistant runs on a Supabase Edge Function (community-resources-chat)
   that holds the model API key server-side — never in this file, which ships
   to every visitor's browser. See supabase/COMMUNITY-RESOURCES.md for the
   function code and deploy steps. If that function isn't deployed yet, the
   invoke call below fails and the chat says so instead of hanging silently. */
const SUPPORT_AREAS = [
  { id: "mara", icon: "mapPin", title: "Maasai community & culture",
    desc: "People, culture, traditions and the land itself.",
    prompt: "Tell me about the Maasai people and their culture." },
  { id: "education", icon: "graduation", title: "Education",
    desc: "Schools, learning, teacher training and staying in school.",
    prompt: "I have a question about education and schools." },
  { id: "health", icon: "shield", title: "Health care",
    desc: "Clinics, maternal health, nutrition and where to get help.",
    prompt: "I have a health care question." },
  { id: "maa", icon: "mail", title: "Translate to Maa",
    desc: "Translate from any language into the Maa language.",
    prompt: "Please translate this into Maa: " },
];

function pageCommunityResources() {
  // Every page returns shell(path, main); returning bare markup drops the
  // header and nav entirely, which is how this first shipped.
  const main = `
    <section class="section cs-section">
      <div class="container">
        <div class="cs-hero">
          <div class="section-head">
            <span class="eyebrow">Community resources</span>
            <h2 class="cs-greeting">Jambo, How may I support you today?</h2>
            <p>Choose an area below, or type your own question — the assistant covers Maasai community &amp; culture, education, healthcare, and Maa translation.</p>
          </div>
        </div>

        <div class="cs-areas">
          ${SUPPORT_AREAS.map((a) => `
            <button class="cs-area cs-area--${a.id}" data-cs-area="${a.id}" data-cs-prompt="${esc(a.prompt)}">
              <span class="cs-area-ic">${icon(a.icon)}</span>
              <span class="cs-area-t">${esc(a.title)}</span>
              <span class="cs-area-d">${esc(a.desc)}</span>
            </button>`).join("")}
        </div>

        <div class="cs-chat" data-cs-chat>
          <div class="cs-chat-head">
            <span class="cs-chat-avatar">${icon("sparkles")}</span>
            <div>
              <div class="cs-chat-name">HPF Assistant</div>
              <div class="cs-chat-status" data-cs-status><span class="cs-dot"></span>Ready to help</div>
            </div>
          </div>
          <div class="cs-log" data-cs-log aria-live="polite">
            <div class="cs-msg cs-bot">
              <span class="cs-avatar">${icon("sparkles")}</span>
              <div class="cs-bubble">Jambo, How may I support you today? Pick an area above or ask me anything.</div>
            </div>
          </div>
          <form class="cs-composer" data-cs-form>
            <input class="input" data-cs-input placeholder="Type your question…" autocomplete="off">
            <button class="btn btn-primary" type="submit">${icon("send")} Send</button>
          </form>
          <p class="cs-note">${icon("info")} This assistant can make mistakes. For urgent health or safety matters, contact HPF or a local clinic directly.</p>
        </div>
      </div>
    </section>`;
  return shell("/community-resources", main);
}

const ROUTES = {
  "/": pageHome,
  "/curriculum": pageCurriculum,
  "/resources": pageResources,
  "/assessment": pageAssessment,
  "/field-officer": pageFieldOfficer,
  "/community-resources": pageCommunityResources,
  "/dashboard": pageDashboard,
  "/auth": () => pageAuth("login"),
};

function titleFor(path) {
  const map = {
    "/": "Human Practice Foundation — Digital Portal",
    "/curriculum": "Teacher Training Curriculum — Human Practice Foundation",
    "/resources": "Digital Learning Resources — Human Practice Foundation",
    "/assessment": "Assessment Tools — Human Practice Foundation",
    "/field-officer": "Field Officer Portal — Human Practice Foundation",
    "/community-resources": "Community Resources — Human Practice Foundation",
    "/dashboard": "My Dashboard — Human Practice Foundation",
    "/auth": "Human Practice Foundation — Digital Portal",
  };
  return map[path] || "Page not found — Human Practice Foundation";
}

async function render() {
  let path = location.pathname;
  if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length);
  path = path.replace(/\/+$/, "") || "/";
  // login-gated routes redirect to /auth, like the original portal
  if ((path === "/field-officer" || path === "/dashboard") && !Auth.isAuthed()) {
    history.replaceState({}, "", BASE + "/auth");
    path = "/auth";
  }
  /* And the reverse: someone who already has a session has no use for the login
     page. This is also where a confirmation link lands — Supabase turns it into
     a session before the first paint — so without this a freshly confirmed user
     would arrive signed in and still be looking at a login form.
     Recovery keeps /auth: those flows run on a session of their own. */
  if (path === "/auth" && Auth.isAuthed() && !isRecoveryOpen()) {
    path = gotoAfterLogin(Auth.current());
    history.replaceState({}, "", BASE + path);
  }
  const view = ROUTES[path] || pageNotFound;
  document.title = titleFor(path);
  const root = $("#app");
  stopHeroCarousel(); // never leave a timer running for a view we're replacing
  // Views become async one at a time as they move onto Supabase; awaiting a
  // still-synchronous view is a no-op, so both kinds work during the migration.
  root.innerHTML = await view();
  window.scrollTo(0, 0);
  await wireView(path);
  runCounters(); // animate numbers immediately on every view
}

async function navigate(to) {
  if (BASE + to !== location.pathname) history.pushState({}, "", BASE + to);
  await render();
}

/* ------------------------------------------------------------ hero carousel
   Cross-fades the hero images every 3s, with clickable dots, pause-on-hover,
   and a floating badge that follows the active slide. */
let heroTimer = null;
const HERO_MS = 5000;

function stopHeroCarousel() {
  if (heroTimer) {
    clearInterval(heroTimer);
    heroTimer = null;
  }
}

function wireHeroCarousel() {
  const frame = $("[data-hero]");
  if (!frame) return;
  const slides = $$(".hero-slide", frame);
  const dots = $$("[data-hero-dot]", frame);
  const badge = $("[data-hero-float]");
  const quoteEl = $("[data-hero-quote]");
  if (slides.length < 2) return;

  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let i = 0;
  let qi = 0;

  function show(n) {
    i = (n + slides.length) % slides.length;
    slides.forEach((s, k) => s.classList.toggle("is-active", k === i));
    dots.forEach((d, k) => d.classList.toggle("is-active", k === i));
    if (badge) badge.innerHTML = heroBadge(HERO_SLIDES[i]);
  }
  // fade the tagline lead out, swap the text, fade it back in
  function nextQuote() {
    if (!quoteEl) return;
    qi = (qi + 1) % HERO_QUOTES.length;
    quoteEl.classList.add("is-swapping");
    setTimeout(() => {
      quoteEl.textContent = HERO_QUOTES[qi];
      quoteEl.classList.remove("is-swapping");
    }, 350);
  }
  function start() {
    stopHeroCarousel();
    if (!still)
      heroTimer = setInterval(() => {
        show(i + 1);
        nextQuote();
      }, HERO_MS);
  }

  dots.forEach((d) =>
    d.addEventListener("click", () => {
      show(+d.dataset.heroDot); // dots pick an image; the quote keeps its own cycle
      start(); // restart the clock after a manual pick
    })
  );
  frame.addEventListener("mouseenter", stopHeroCarousel);
  frame.addEventListener("mouseleave", start);
  start();
}

/* ------------------------------------------------------------ per-view wiring */
async function wireView(path) {
  const authed = Auth.current();
  if (path === "/") wireHeroCarousel();
  if (path === "/auth") wireAuth();
  if (path === "/field-officer") authed ? wireFieldOfficer() : wireAuth();
  if (path === "/community-resources") wireCommunityResources();
  if (path === "/dashboard") authed ? await wireMyDashboard(authed, dashboardEventsCache) : wireAuth();
}

/* ------------------------------------------------------------ auth wiring */
function wireAuth() {
  if (isRecoveryOpen()) return wireRecoveryPanel();

  const tabs = $$("[data-tab]");
  const loginForm = $("#loginForm");
  const signupForm = $("#signupForm");

  tabs.forEach((tab) =>
    tab.addEventListener("click", () => {
      const mode = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      if (loginForm) loginForm.hidden = mode !== "login";
      if (signupForm) signupForm.hidden = mode !== "signup";
    })
  );

  const roleSel = $("#su_role");
  const emailInput = $("#su_email");
  const emailField = signupForm?.querySelector("[data-email-field]");
  function syncRole() {
    if (!roleSel || !emailInput) return;
    const isLearner = roleSel.value === "learner";
    emailField.style.display = isLearner ? "none" : "";
    emailInput.required = !isLearner;

    // Admins and field officers work across schools, not at one, so the field
    // says so and clears itself rather than leaving a stale pick attached to
    // an account that should not have one.
    const optional = roleSel.value === "admin" || roleSel.value === "field_officer";
    const schoolSel = signupForm?.querySelector("[data-school]");
    const hint = signupForm?.querySelector(".su-optional");
    if (hint) hint.hidden = !optional;
    if (schoolSel && optional) schoolSel.value = "";
  }
  roleSel?.addEventListener("change", syncRole);
  syncRole();

  // region → filters the school dropdown to that region's schools
  const regionSel = $("[data-region]");
  const schoolSel = $("[data-school]");
  regionSel?.addEventListener("change", () => {
    const schools = REGIONS[regionSel.value] || [];
    schoolSel.disabled = !schools.length;
    schoolSel.innerHTML = schools.length
      ? `<option value="" disabled selected>Select your school</option>` +
        schools.map((s) => `<option>${esc(s)}</option>`).join("")
      : `<option value="" disabled selected>Select a region first</option>`;
  });

  // Carry whatever they already typed across, so the recovery panel doesn't ask
  // for an address they just entered. A username tells us nothing to email.
  $("[data-forgot]")?.addEventListener("click", async () => {
    const typed = ($("#li_id")?.value || "").trim();
    openRecovery("password", typed.includes("@") ? typed : "");
    await render();
  });

  $("[data-forgot-user]")?.addEventListener("click", async () => {
    openRecovery("username");
    await render();
  });

  loginForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(loginForm);
    const submit = loginForm.querySelector("[type=submit]");
    if (submit) { submit.disabled = true; submit.textContent = "Signing in…"; }
    try {
      const user = await Auth.login(fd.get("identifier"), fd.get("password"));
      if (user.legacy) {
        // Don't let this pass as a normal sign-in: nothing served from the
        // database will load, and the cause is not guessable from the UI.
        toast(
          "Signed in on your old account",
          "This account predates the move to the HPF database, so it only works in this browser and shared data will not load. Ask an administrator to recreate it.",
          "error"
        );
      } else {
        toast("Welcome back", `Signed in as ${user.fullName || user.username}.`, "success");
      }
      await navigate(gotoAfterLogin(user));
    } catch (err) {
      if (err.needsConfirm) {
        openEmailConfirm(err.email);
        toast("Confirm your email first", `${err.email} hasn't been confirmed yet. Finish it below.`, "error");
        return await navigate("/auth");
      }
      toast("Sign in failed", err.message, "error");
      if (submit) { submit.disabled = false; submit.textContent = "Login"; }
    }
  });

  signupForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(signupForm);
    const data = Object.fromEntries(fd.entries());
    data.role = data.role || "teacher";

    if (data.role === "learner") {
      if (!data.username) return toast("Username required", "Learners sign in with a username.", "error");
      delete data.email;
    } else {
      if (!data.email) return toast("Email required", "Please enter your email address.", "error");
      // Admin is never self-serve: patch-01-security.sql clamps the role
      // server-side, so allowing it here would only produce a silent downgrade.
      if (data.role === "admin") {
        return toast(
          "Admin accounts are issued by HPF",
          "Sign up as a Teacher, School Leader, or Field Officer. An HPF administrator can upgrade your account afterwards.",
          "error"
        );
      }
    }
    if ((data.password || "").length < 6)
      return toast("Weak password", "Password must be at least 6 characters.", "error");
    if (!data.region) return toast("Region required", "Select your region.", "error");
    // HPF staff and field officers work across schools rather than at one, so
    // forcing a choice would only produce a wrong answer. Everyone else is
    // based somewhere and the figures depend on it being right.
    const schoolOptional = data.role === "admin" || data.role === "field_officer";
    if (!schoolOptional && !data.school)
      return toast("School required", "Select your school from the region.", "error");
    if (!data.project) return toast("Project required", "Select the project you belong to.", "error");

    const submit = signupForm.querySelector("[type=submit]");
    if (submit) { submit.disabled = true; submit.textContent = "Creating account…"; }
    try {
      const user = await Auth.register(data);
      // Registered, but the address still has to be proved before Supabase will
      // issue a session. The panel takes the emailed code or link from here.
      if (user.needsConfirm) {
        openEmailConfirm(user.email, true);
        toast("Account created", `One step left — confirm ${user.email} to sign in.`, "success");
        return await navigate("/auth");
      }
      toast("Account created", `Welcome to the HPF portal, ${(user.fullName || "").split(" ")[0]}!`, "success");
      await navigate(gotoAfterLogin(user));
    } catch (err) {
      toast("Sign up failed", err.message, "error");
      if (submit) { submit.disabled = false; submit.textContent = "Create account"; }
    }
  });
}

function gotoAfterLogin(user) {
  return user.role === "field_officer" ? "/field-officer" : "/dashboard";
}

/* ------------------------------------------------------------ recovery wiring
   The panel repaints its own steps; app.js only has to say what "cancelled"
   and "finished" mean, since both change which page we're on. */
function wireRecoveryPanel() {
  wireRecovery({
    onDone: async () => {
      // Verifying a code or opening a reset link signs the person in, so land
      // them where a normal sign-in would — and log it like any other sign-in,
      // otherwise the admin inbox misses everyone who arrived this way.
      const { data } = await supabase.auth.getSession();
      const user = await refreshProfile(data.session);
      if (user) await Repo.record(user, "login");
      await navigate(user ? gotoAfterLogin(user) : "/auth");
    },
  });

  // Delegated: [data-recover-cancel] is re-rendered on every step.
  $("#recoverPanel")?.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-recover-cancel]")) return;
    // Backing out after a code or link was accepted would otherwise leave a live
    // session behind — signed in, but without having finished what they came for.
    if (recoveryOwnsSession()) {
      supaUser = null;
      await supabase.auth.signOut();
    }
    closeRecovery();
    await render();
  });
}

/* ------------------------------------------------------------ field officer wiring */
let foOnlineListenerAttached = false; // attach the retry-on-reconnect listener once, ever

function wireFieldOfficer() {
  const form = $("#foForm");
  const user = Auth.current();
  const onFieldOfficerPage = () => location.pathname.includes("/field-officer");

  if (!foReportsLoaded) {
    loadFoReports().then(() => { if (onFieldOfficerPage()) render(); });
  }
  if (!foSchoolsLoaded && user.role !== "admin") {
    loadFoSchools().then(() => { if (onFieldOfficerPage()) render(); });
  }
  // A visit saved while offline waits in the outbox; try it again on every
  // mount in case connectivity came back since. Re-render on any change, not
  // only a successful sync — a pending item that turns out blocked still
  // needs its pill and reason to update, or it would sit mislabeled "pending"
  // forever even though flushFoOutbox already found out otherwise.
  if (foOutbox().some((o) => !o.blocked)) {
    flushFoOutbox().then(({ changed }) => { if (changed && onFieldOfficerPage()) render(); });
  }
  if (!foOnlineListenerAttached) {
    foOnlineListenerAttached = true;
    window.addEventListener("online", async () => {
      const { changed } = await flushFoOutbox();
      if (changed && onFieldOfficerPage()) render();
    });
  }

  $("[data-fo-retry]")?.addEventListener("click", async () => {
    foReportsLoaded = false;
    await render();
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const county = fd.get("county");
    if (!county) return toast("County required", "Please select a county.", "error");

    const row = {
      user_id: user.id,
      school: fd.get("school"),
      visit_type: fd.get("visitType"),
      county,
      teachers: +fd.get("teachers") || 0,
      learners: +fd.get("learners") || 0,
      notes: fd.get("notes") || null,
      // Explicit, not the column's default: a row only ever reaches this
      // table via a live insert, so its mere presence in Postgres already
      // proves it synced. A queued-but-unsynced visit lives only in this
      // browser's outbox, never in this table — see K_FO_OUTBOX above.
      status: "synced",
    };

    const btn = form.querySelector("[type=submit]");
    if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }

    const { error } = await supabase.from("field_reports").insert(row);

    if (!error) {
      form.reset();
      toast("Report submitted", `${row.school} saved to the HPF database.`, "success");
      await loadFoReports();
      return render();
    }

    if (foReportIsConnectivityFailure(error)) {
      // No connection right now — this is not a failure to report as one.
      // The visit is real and recorded; it just hasn't reached the server yet.
      const outbox = foOutbox();
      outbox.push({ id: uid(), row, at: Date.now() });
      write(K_FO_OUTBOX, outbox);
      form.reset();
      toast("Saved offline", `${row.school} is queued — it will upload once you're back online.`, "success");
      return render();
    }

    // A real refusal (no JWT, RLS, etc.) — restore the button so the officer
    // can see the submit failed rather than watching it spin forever.
    if (btn) { btn.disabled = false; btn.textContent = "Submit field report"; }
    toast("Could not save report", authMessage(error), "error");
  });
}

/* ------------------------------------------------------------ community resources wiring */
function wireCommunityResources() {
  const form = $("[data-cs-form]");
  const input = $("[data-cs-input]");
  const log = $("[data-cs-log]");
  const status = $("[data-cs-status]");
  const areaBtns = $$("[data-cs-area]");
  if (!form || !input || !log) return;
  let activeArea = null;
  let statusResetTimer = null;

  function setStatus(mode, label) {
    if (!status) return;
    status.classList.toggle("is-busy", mode === "busy");
    status.classList.toggle("is-error", mode === "error");
    status.lastChild.textContent = label;
    clearTimeout(statusResetTimer);
    if (mode === "error") statusResetTimer = setTimeout(() => setStatus("ready", "Ready to help"), 5000);
  }

  function addMsg(who, text) {
    const row = document.createElement("div");
    row.className = `cs-msg ${who === "me" ? "cs-me" : "cs-bot"}`;
    row.innerHTML = `
      <span class="cs-avatar">${icon(who === "me" ? "users" : "sparkles")}</span>
      <div class="cs-bubble">${esc(text)}</div>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  function addTyping() {
    const row = document.createElement("div");
    row.className = "cs-msg cs-bot";
    row.innerHTML = `
      <span class="cs-avatar">${icon("sparkles")}</span>
      <div class="cs-bubble"><span class="cs-typing"><span></span><span></span><span></span></span></div>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  areaBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      areaBtns.forEach((b) => b.classList.toggle("active", b === btn));
      activeArea = btn.dataset.csArea;
      input.value = btn.dataset.csPrompt || "";
      input.focus();
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const sendBtn = form.querySelector("button[type=submit]");
    addMsg("me", text);
    input.value = "";
    input.disabled = true;
    sendBtn.disabled = true;
    setStatus("busy", "Thinking…");
    const typing = addTyping();
    try {
      const { data, error } = await supabase.functions.invoke("community-resources-chat", {
        body: { message: text, area: activeArea },
      });
      if (error) throw error;
      typing.querySelector(".cs-bubble").textContent =
        data?.reply || "Sorry, I don't have an answer for that right now.";
      setStatus("ready", "Ready to help");
    } catch {
      // The edge function may not be deployed yet, or the request failed —
      // either way the visitor gets a clear reason, not a stuck typing dot.
      typing.querySelector(".cs-bubble").textContent =
        "I couldn't reach the assistant just now. Please try again in a moment.";
      setStatus("error", "Having trouble connecting");
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      log.scrollTop = log.scrollHeight;
    }
  });
}

/* ------------------------------------------------------------ global events */
document.addEventListener("click", async (e) => {
  const link = e.target.closest("a[data-link]");
  if (link) {
    e.preventDefault();
    await navigate(link.getAttribute("href"));
    return;
  }
  const logout = e.target.closest("[data-logout]");
  if (logout) {
    e.preventDefault();
    await Auth.logout();
    toast("Signed out", "You have been logged out.");
    await navigate("/");
    return;
  }
  const resource = e.target.closest("[data-resource]");
  if (resource) {
    e.preventDefault();
    toast("Opening resource", `“${resource.dataset.resource}” opens in the resource library.`);
  }
});

window.addEventListener("popstate", () => { render(); });

/* ------------------------------------------------------------ boot */
(async () => {
  startGlobalCounters();

  /* Registered before the first getSession() so it cannot miss the event fired
     while Supabase is turning an emailed link into a session. Deliberately not
     async: calling back into supabase-js from inside this callback can deadlock
     its internal lock, so anything that does is deferred to a fresh task. */
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") supaUser = null;
    if (event !== "PASSWORD_RECOVERY") return;
    // The link may have landed on any page (Supabase falls back to the Site URL
    // when the redirect isn't allow-listed), so take over and go to /auth.
    setTimeout(() => {
      openPasswordReset(session?.user?.email || "");
      navigate("/auth");
    }, 0);
  });

  // Restore any stored Supabase session before the first paint, so a refresh
  // lands on the dashboard instead of flashing the login page.
  try {
    const { data } = await supabase.auth.getSession();
    await refreshProfile(data.session);
    // A username-recovery magic link opens a brand new page: pick that intent
    // back up instead of dropping the person on their dashboard.
    if (await resumeUsernameRecovery(data.session)) {
      history.replaceState({}, "", BASE + "/auth");
    } else if (supaUser?.needsPassword) {
      // An admin-invited staff account (patch-15): whichever page the magic
      // link actually landed on — Supabase falls back to the Site URL when
      // /auth isn't allow-listed yet — force the password step before
      // anything else, same as the username-recovery case above.
      openStaffInvite(supaUser.email);
      history.replaceState({}, "", BASE + "/auth");
    }
  } catch (err) {
    console.warn("Session restore failed:", err.message);
  }
  await render();
})();
