/* ============================================================
   HPF Digital Portal — SPA controller
   Router, auth + login repository, views, and interactions.
   ============================================================ */

import { icon } from "./icons.js";
import {
  PORTAL_CARDS, CURRICULUM, RESOURCES, ASSESSMENT, IMPACT,
  ROLES, ORG_TYPES, COUNTIES, VISIT_TYPES,
} from "./data.js";
import {
  $, $$, read, write, esc, initials, uid,
  startGlobalCounters, runCounters, toast,
} from "./util.js";
import { myDashboardMain, wireMyDashboard } from "./dashboards.js";

/* ------------------------------------------------------------ storage keys */
const K_USERS = "hpf_users";
const K_SESSION = "hpf_session";
const K_SUBS = "hpf_submissions";
const K_EVENTS = "hpf_login_events"; // dummy repository of all login requests
const ADMIN_EMAIL = "patrick@humanpractice.org";

/* ------------------------------------------------------------ login repository
   Every login / signup is stored here and "pushed" to the admin inbox. */
const Repo = {
  events: () => read(K_EVENTS, []),
  record(user, type) {
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
  },
};

/* ------------------------------------------------------------ auth store */
const Auth = {
  users: () => read(K_USERS, []),
  current: () => read(K_SESSION, null),
  isAuthed: () => !!read(K_SESSION, null),
  register(data) {
    const users = Auth.users();
    const key = (data.email || data.username || "").toLowerCase();
    if (users.some((u) => (u.email || u.username || "").toLowerCase() === key)) {
      throw new Error("An account with those details already exists.");
    }
    const user = { ...data, id: uid(), createdAt: Date.now() };
    users.push(user);
    write(K_USERS, users);
    const { password, ...safe } = user;
    write(K_SESSION, safe);
    Repo.record(safe, "signup");
    return safe;
  },
  login(identifier, password) {
    const id = identifier.trim().toLowerCase();
    const user = Auth.users().find(
      (u) =>
        (u.email || "").toLowerCase() === id ||
        (u.username || "").toLowerCase() === id
    );
    if (!user || user.password !== password) {
      throw new Error("Invalid credentials. Check your details and try again.");
    }
    const { password: _p, ...safe } = user;
    write(K_SESSION, safe);
    Repo.record(safe, "login");
    return safe;
  },
  logout() {
    localStorage.removeItem(K_SESSION);
  },
};

/* Seed a demo admin so the admin dashboard + inbox are reachable out of the box. */
function seedAdmin() {
  const users = Auth.users();
  if (!users.some((u) => (u.email || "").toLowerCase() === ADMIN_EMAIL)) {
    users.push({
      id: uid(),
      fullName: "Patrick — HPF Admin",
      role: "admin",
      email: ADMIN_EMAIL,
      username: "patrick",
      password: "admin1234",
      orgType: "NGO / Non-profit",
      county: "Nairobi",
      createdAt: Date.now(),
    });
    write(K_USERS, users);
  }
}

/* ------------------------------------------------------------ shared chrome */
const NAV = [
  { label: "Home", href: "/" },
  { label: "Curriculum", href: "/curriculum" },
  { label: "Learning Resources", href: "/resources" },
  { label: "Assessment Tools", href: "/assessment" },
  { label: "Field Officer App", href: "/field-officer" },
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

function header(path) {
  const user = Auth.current();
  const links = (user ? NAV_AUTHED : NAV).map(
    (n) =>
      `<a href="${n.href}" data-link class="${path === n.href ? "active" : ""}">${n.label}</a>`
  ).join("");

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
      <div class="portal-card">
        <div class="card-icon">${icon(c.icon)}</div>
        <h3>${esc(c.title)}</h3>
        <p>${esc(c.desc)}</p>
        <span class="card-link plain">Open ${icon("arrowUpRight")}</span>
      </div>`
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
          <p class="hero-quote-sm">When actions flow from the heart. <strong>That's human practice.</strong></p>
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
          <div class="hero-frame">
            <img src="/assets/hero-classroom.jpg" width="1024" height="1024"
              alt="Human Practice Foundation teacher with young learners in a Kenyan classroom" />
          </div>
          <div class="hero-float">
            <span class="hf-icon">${icon("graduation")}</span>
            <div>
              <div class="hf-label">Certified</div>
              <div class="hf-value">Teacher Programme</div>
            </div>
          </div>
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
  const roleOptions =
    `<option value="" disabled selected>Select your role</option>` +
    ROLES.map((r) => `<option value="${r.value}">${r.label}</option>`).join("");
  const orgOptions =
    `<option value="" disabled selected>Select organization type</option>` +
    ORG_TYPES.map((o) => `<option>${o}</option>`).join("");
  const countyOptions =
    `<option value="" disabled selected>Select your county</option>` +
    COUNTIES.map((c) => `<option>${c}</option>`).join("");

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
            <label for="su_org">School / organization</label>
            <select class="select" id="su_org" name="orgType">${orgOptions}</select>
          </div>
          <div class="field">
            <label for="su_county">County / region</label>
            <select class="select" id="su_county" name="county">${countyOptions}</select>
          </div>
          <button class="btn btn-primary btn-block" type="submit">Create account</button>
        </form>
      </main>`;

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
function pageDashboard() {
  const user = Auth.current();
  if (!user) return pageAuth("login");
  return shell("/dashboard", myDashboardMain(user, Repo.events()));
}

/* ------------------------------------------------------------ field officer */
function pageFieldOfficer() {
  const user = Auth.current();
  if (!user) return pageAuth("login");

  const allowed = user.role === "field_officer" || user.role === "admin";
  const subs = read(K_SUBS, []).filter((s) => s.userId === user.id);
  const synced = subs.filter((s) => s.status === "synced").length;
  const pending = subs.length - synced;

  const gateNotice = allowed
    ? ""
    : `<div class="notice">${icon("info")}
        <span>This portal is intended for <strong>Field Officers</strong> and <strong>HPF Staff</strong>.
        Your account role is <strong>${esc(ROLES.find((r) => r.value === user.role)?.label || user.role)}</strong>.
        You can explore the interface below, but submissions are marked for review.</span>
      </div>`;

  const visitOptions = VISIT_TYPES.map((v) => `<option>${v}</option>`).join("");
  const countyOptions =
    `<option value="" disabled ${user.county ? "" : "selected"}>Select county</option>` +
    COUNTIES.map(
      (c) => `<option ${user.county === c ? "selected" : ""}>${c}</option>`
    ).join("");

  const subsList = subs.length
    ? subs
        .slice()
        .reverse()
        .map(
          (s) => `
        <div class="submission">
          <span class="s-icon">${icon("clipboard")}</span>
          <div>
            <div class="s-title">${esc(s.school)}</div>
            <div class="s-meta">${esc(s.visitType)} · ${esc(s.county)} · ${new Date(
            s.createdAt
          ).toLocaleDateString()}</div>
          </div>
          <span class="pill ${s.status}">${s.status}</span>
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

        <div class="stat-row">
          <div class="stat-tile">
            <div class="st-label">${icon("clipboard")} Total visits</div>
            <div class="st-num">${countNum(subs.length)}</div>
          </div>
          <div class="stat-tile">
            <div class="st-label">${icon("cloud")} Synced</div>
            <div class="st-num">${countNum(synced)}</div>
          </div>
          <div class="stat-tile">
            <div class="st-label">${icon("clock")} Pending</div>
            <div class="st-num">${countNum(pending)}</div>
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
                <input class="input" id="fo_school" name="school" type="text" required placeholder="e.g. Nyeri Hill Primary School">
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
            <p class="panel-sub">Your latest field reports on this device.</p>
            <div id="subsList">${subsList}</div>
          </div>
        </div>
      </div>
    </section>`;
  return shell("/field-officer", main);
}

/* ------------------------------------------------------------ router */
const ROUTES = {
  "/": pageHome,
  "/curriculum": pageCurriculum,
  "/resources": pageResources,
  "/assessment": pageAssessment,
  "/field-officer": pageFieldOfficer,
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
    "/dashboard": "My Dashboard — Human Practice Foundation",
    "/auth": "Human Practice Foundation — Digital Portal",
  };
  return map[path] || "Page not found — Human Practice Foundation";
}

function render() {
  let path = location.pathname.replace(/\/+$/, "") || "/";
  // login-gated routes redirect to /auth, like the original portal
  if ((path === "/field-officer" || path === "/dashboard") && !Auth.isAuthed()) {
    history.replaceState({}, "", "/auth");
    path = "/auth";
  }
  const view = ROUTES[path] || pageNotFound;
  document.title = titleFor(path);
  const root = $("#app");
  root.innerHTML = view();
  window.scrollTo(0, 0);
  wireView(path);
  runCounters(); // animate numbers immediately on every view
}

function navigate(to) {
  if (to !== location.pathname) history.pushState({}, "", to);
  render();
}

/* ------------------------------------------------------------ per-view wiring */
function wireView(path) {
  const authed = Auth.current();
  if (path === "/auth") wireAuth();
  if (path === "/field-officer") authed ? wireFieldOfficer() : wireAuth();
  if (path === "/dashboard") authed ? wireMyDashboard(authed, Repo.events()) : wireAuth();
}

/* ------------------------------------------------------------ auth wiring */
function wireAuth() {
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
  }
  roleSel?.addEventListener("change", syncRole);
  syncRole();

  $("[data-forgot]")?.addEventListener("click", () =>
    toast("Password reset", "Contact your HPF administrator to reset your password.")
  );

  loginForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(loginForm);
    try {
      const user = Auth.login(fd.get("identifier"), fd.get("password"));
      toast("Welcome back", `Signed in as ${user.fullName || user.username}.`, "success");
      navigate(gotoAfterLogin(user));
    } catch (err) {
      toast("Sign in failed", err.message, "error");
    }
  });

  signupForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(signupForm);
    const data = Object.fromEntries(fd.entries());
    data.role = data.role || "teacher";

    if (data.role === "learner") {
      if (!data.username) return toast("Username required", "Learners sign in with a username.", "error");
      delete data.email;
    } else {
      if (!data.email) return toast("Email required", "Please enter your email address.", "error");
      if (data.role === "admin" && !/@humanpractice\.org$/i.test(data.email)) {
        return toast("Invalid staff email", "HPF Staff (Admin) requires an @humanpractice.org email.", "error");
      }
    }
    if ((data.password || "").length < 6)
      return toast("Weak password", "Password must be at least 6 characters.", "error");

    try {
      const user = Auth.register(data);
      toast("Account created", `Welcome to the HPF portal, ${user.fullName.split(" ")[0]}!`, "success");
      navigate(gotoAfterLogin(user));
    } catch (err) {
      toast("Sign up failed", err.message, "error");
    }
  });
}

function gotoAfterLogin(user) {
  return user.role === "field_officer" ? "/field-officer" : "/dashboard";
}

/* ------------------------------------------------------------ field officer wiring */
function wireFieldOfficer() {
  const form = $("#foForm");
  const user = Auth.current();
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const allowed = user.role === "field_officer" || user.role === "admin";
    const sub = {
      id: uid(),
      userId: user.id,
      school: fd.get("school"),
      visitType: fd.get("visitType"),
      county: fd.get("county"),
      teachers: +fd.get("teachers") || 0,
      learners: +fd.get("learners") || 0,
      notes: fd.get("notes"),
      status: allowed ? "synced" : "pending",
      createdAt: Date.now(),
    };
    if (!sub.county) return toast("County required", "Please select a county.", "error");
    const all = read(K_SUBS, []);
    all.push(sub);
    write(K_SUBS, all);
    toast("Report submitted", `${sub.school} recorded successfully.`, "success");
    render();
  });
}

/* ------------------------------------------------------------ global events */
document.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-link]");
  if (link) {
    e.preventDefault();
    navigate(new URL(link.href).pathname);
    return;
  }
  const logout = e.target.closest("[data-logout]");
  if (logout) {
    e.preventDefault();
    Auth.logout();
    toast("Signed out", "You have been logged out.");
    navigate("/");
  }
});

window.addEventListener("popstate", render);

/* ------------------------------------------------------------ boot */
seedAdmin();
startGlobalCounters();
render();
