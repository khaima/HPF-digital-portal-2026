/* ============================================================
   HPF Digital Portal — account recovery & email confirmation
   Self-service "I forgot my password", "I forgot my username", and
   "confirm my new account", on top of Supabase Auth. Two ways in,
   both driven by email:

     • a reset link  — resetPasswordForEmail() mails a link; opening it
       returns here with a recovery session and the PASSWORD_RECOVERY
       event, and the app asks for a new password.
     • a one-time code — the same email also carries a 6-digit token
       (template permitting, see supabase/AUTH-RECOVERY.md), so anyone
       who can't open the link on this device can type the code instead.
       verifyOtp() turns it into the same session.

   Forgotten usernames use signInWithOtp() rather than a password reset:
   the person hasn't lost their password, so make them prove they own the
   address and then just show them the username. The username is never
   emailed — that would hand it to whoever controls the mailbox without
   any proof they can read it.

   New signups land here too. This project has "Confirm email" switched on
   (see supabase/AUTH-RECOVERY.md), so signUp() creates the account but
   returns no session — the person is registered and locked out at the same
   time. Rather than dead-ending them on an error, the same panel takes the
   confirmation link or code and finishes the job.

   The panel owns its own DOM under #recoverPanel and repaints itself
   between steps, so the router never has to know which step we're on.
   ============================================================ */

import { supabase, authMessage } from "./supabase.js";
import { $, esc, toast, BASE } from "./util.js";
import { icon } from "./icons.js";

const CODE_LEN = 6;

/* Where the emailed link sends people back to. This exact URL has to be listed
   under Authentication → URL Configuration → Redirect URLs in the Supabase
   dashboard; anything else is discarded and people land on the Site URL. */
const redirectUrl = () => `${location.origin}${BASE}/auth`;

/* Survives the round-trip through the mailbox: a magic link opens a fresh page
   load, so without this the app would just sign someone in and drop them on the
   dashboard when what they asked for was their username. */
const INTENT_KEY = "hpf_recover_intent";

const state = {
  open: false,
  step: "start", // start | linkSent | code | newPassword | username
  intent: "password", // password | username | confirm
  email: "",
  codeType: "recovery", // verifyOtp type for the code we last sent
  username: null,
  busy: false,
  // Set once a code or link has been accepted: from then on there is a live
  // Supabase session that only exists because of this flow, and backing out
  // has to dispose of it rather than leave someone half signed in.
  ownsSession: false,
};

/* Set by app.js: what to do once the person is recovered and signed in. */
let onFinish = () => {};

export const isRecoveryOpen = () => state.open;

/* Did this flow create the session we're sitting on? */
export const recoveryOwnsSession = () => state.ownsSession;

export function openRecovery(intent = "password", email = "") {
  Object.assign(state, {
    open: true, step: "start", intent, email, username: null, busy: false, ownsSession: false,
  });
}

export function closeRecovery() {
  state.open = false;
  state.ownsSession = false;
  try { sessionStorage.removeItem(INTENT_KEY); } catch { /* private mode */ }
}

/* A brand-new account that Supabase created but won't sign in until the address
   is confirmed, or a sign-in that bounced off "Email not confirmed".
   `fresh` = signUp has just sent the confirmation email, so don't send another. */
export function openEmailConfirm(email = "", fresh = false) {
  Object.assign(state, {
    open: true, step: fresh ? "linkSent" : "code", intent: "confirm", email,
    codeType: "signup", username: null, busy: false, ownsSession: false,
  });
}

/* Called from the PASSWORD_RECOVERY handler — Supabase has just exchanged the
   emailed link for a session, so skip straight to "choose a new password". */
export function openPasswordReset(email = "") {
  Object.assign(state, {
    open: true, step: "newPassword", intent: "password", email,
    username: null, busy: false, ownsSession: true,
  });
}

/* Called at boot: did this page load come from a username-recovery magic link? */
export async function resumeUsernameRecovery(session) {
  let flagged = false;
  try {
    flagged = sessionStorage.getItem(INTENT_KEY) === "username";
    if (flagged) sessionStorage.removeItem(INTENT_KEY);
  } catch { /* private mode */ }
  if (!flagged || !session?.user) return false;
  Object.assign(state, {
    open: true, step: "username", intent: "username",
    email: session.user.email || "", busy: false, ownsSession: true,
    username: await lookupUsername(session.user.id),
  });
  return true;
}

async function lookupUsername(userId) {
  const { data, error } = await supabase
    .from("profiles").select("username").eq("id", userId).maybeSingle();
  if (error) console.warn("username lookup failed:", error.message);
  return data?.username || "";
}

/* ------------------------------------------------------------ markup */

/* Heading for the card, which app.js renders outside the panel. Keyed off the
   step once identity is settled, because by then the intent the person started
   with no longer describes what they're looking at. */
export function recoveryTitle() {
  if (state.intent === "confirm")
    return { h1: "Confirm your email", sub: "One step left. Your account exists — it just needs the address proved before you can sign in." };
  if (state.step === "newPassword")
    return { h1: "Choose a new password", sub: "Your identity is confirmed — this is the last step." };
  if (state.step === "username")
    return { h1: "Your account", sub: "This is the username stored against your email address." };
  return state.intent === "username"
    ? { h1: "Find your username", sub: "Confirm your email address and the portal will show you the username on your account." }
    : { h1: "Reset your password", sub: "We'll email you a link and a one-time code. Either one lets you set a new password." };
}

export function recoveryHtml() {
  return `<section class="recover" id="recoverPanel">${stepHtml()}</section>`;
}

function stepHtml() {
  switch (state.step) {
    case "linkSent": return linkSentStep();
    case "code": return codeStep();
    case "newPassword": return newPasswordStep();
    case "username": return usernameStep();
    default: return startStep();
  }
}

const backToLogin = `<button class="link-btn" type="button" data-recover-cancel>← Back to login</button>`;

function startStep() {
  const forUsername = state.intent === "username";
  return `
    <div class="tabs">
      <button class="tab ${forUsername ? "" : "active"}" type="button" data-intent="password">Forgot password</button>
      <button class="tab ${forUsername ? "active" : ""}" type="button" data-intent="username">Forgot username</button>
    </div>

    <form id="recoverStartForm" novalidate>
      <div class="field">
        <label for="rc_email">Email address</label>
        <input class="input" id="rc_email" name="email" type="email" autocomplete="email"
               value="${esc(state.email)}" placeholder="you@school.ac.ke" required>
        <p class="hint">The address you signed up with. Nothing is sent anywhere else.</p>
      </div>
      ${forUsername
        ? `<button class="btn btn-primary btn-block" type="submit" data-send="code">
             ${icon("mail")} Email me a sign-in code
           </button>`
        : `<button class="btn btn-primary btn-block" type="submit" data-send="link">
             ${icon("mail")} Email me a reset link
           </button>
           <button class="btn btn-outline btn-block recover-alt" type="button" data-send="code">
             ${icon("key")} Send a ${CODE_LEN}-digit code instead
           </button>`}
    </form>

    <div class="notice recover-note">${icon("info")}
      <span><strong>Learner accounts</strong> have no email address, so they can't be
      recovered here — ask your teacher or school leader to reset your password.</span>
    </div>

    ${backToLogin}`;
}

function linkSentStep() {
  const confirming = state.intent === "confirm";
  return `
    <div class="notice recover-note">${icon("mail")}
      ${confirming
        ? `<span>Your account is created. A confirmation link is on its way to
           <strong>${esc(state.email)}</strong> — open it on this device and you'll be
           signed straight in. The link works once.</span>`
        : `<span>A password reset link is on its way to <strong>${esc(state.email)}</strong>.
           Open it on this device and you'll come straight back here to choose a new password.
           The link is good for one hour and can only be used once.</span>`}
    </div>
    <p class="hint recover-hint">Can't open the link — reading mail on a different phone,
      or it won't load? The same email also contains a ${CODE_LEN}-digit code.</p>
    <button class="btn btn-outline btn-block" type="button" data-goto-code>
      ${icon("key")} I have a code from that email
    </button>
    <div class="recover-actions">
      <button class="link-btn" type="button" data-resend>Send it again</button>
      ${backToLogin}
    </div>`;
}

function codeStep() {
  const confirming = state.intent === "confirm";
  return `
    <div class="notice recover-note">${icon("mail")}
      ${confirming
        ? `<span>Enter the ${CODE_LEN}-digit code from the confirmation email sent to
           <strong>${esc(state.email)}</strong>, or use <strong>Send a new code</strong>
           below if it's gone stale.</span>`
        : `<span>We emailed a ${CODE_LEN}-digit code to <strong>${esc(state.email)}</strong>.
           It expires in one hour.</span>`}
    </div>
    <form id="recoverCodeForm" novalidate>
      <div class="field">
        <label for="rc_code">Verification code</label>
        <input class="input code-input" id="rc_code" name="token" type="text"
               inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*"
               maxlength="${CODE_LEN}" placeholder="000000" required>
      </div>
      <button class="btn btn-primary btn-block" type="submit">Verify code</button>
    </form>
    <p class="hint recover-hint">Nothing after a few minutes? Check the spam folder.${confirming
      ? " If the portal's email sending isn't set up yet, an HPF administrator can confirm the address for you from the Supabase dashboard."
      : " If the address has no account on the portal, no email is sent at all — ask an HPF administrator to set one up."}</p>
    <div class="recover-actions">
      <button class="link-btn" type="button" data-resend>Send a new code</button>
      ${confirming ? "" : `<button class="link-btn" type="button" data-recover-restart>Use a different email</button>`}
      ${backToLogin}
    </div>`;
}

function newPasswordStep() {
  return `
    <div class="notice recover-note">${icon("userCheck")}
      <span>Identity confirmed${state.email ? ` for <strong>${esc(state.email)}</strong>` : ""}.
      Choose a new password to finish — it replaces the old one everywhere.</span>
    </div>
    <form id="recoverPwForm" novalidate>
      <div class="field">
        <label for="rc_pw">New password</label>
        <input class="input" id="rc_pw" name="password" type="password"
               autocomplete="new-password" minlength="6" required placeholder="min. 6 characters">
      </div>
      <div class="field">
        <label for="rc_pw2">Confirm new password</label>
        <input class="input" id="rc_pw2" name="confirm" type="password"
               autocomplete="new-password" minlength="6" required>
      </div>
      <button class="btn btn-primary btn-block" type="submit">Save new password</button>
    </form>
    ${backToLogin}`;
}

function usernameStep() {
  const has = !!state.username;
  return `
    <div class="notice recover-note">${icon("userCheck")}
      <span>Identity confirmed for <strong>${esc(state.email)}</strong>. You're signed in on this device.</span>
    </div>
    <div class="recover-reveal">
      <div class="rv-label">Your username</div>
      <div class="rv-value ${has ? "" : "rv-empty"}">${has ? esc(state.username) : "none set"}</div>
    </div>
    <p class="hint recover-hint">${has
      ? "Sign in with either this username or your email address."
      : "This account was created without a username — sign in with your email address instead. An HPF administrator can add a username for you."}</p>
    <button class="btn btn-primary btn-block" type="button" data-recover-continue>
      Continue to my dashboard ${icon("arrowRight")}
    </button>
    <div class="recover-actions">
      <button class="link-btn" type="button" data-goto-password>Set a new password while I'm here</button>
      ${backToLogin}
    </div>`;
}

/* ------------------------------------------------------------ wiring */

export function wireRecovery({ onDone } = {}) {
  if (onDone) onFinish = onDone;
  wireStep();
}

/* Repaint the current step in place and rebind its handlers. */
function paint() {
  const host = $("#recoverPanel");
  if (!host) return;
  host.innerHTML = stepHtml();
  wireStep();
  syncHeading();
}

/* The heading lives outside the panel (app.js renders it), so keep it honest
   when the intent tabs switch. */
function syncHeading() {
  const { h1, sub } = recoveryTitle();
  const head = $("[data-recover-h1]");
  const lede = $("[data-recover-sub]");
  if (head) head.textContent = h1;
  if (lede) lede.textContent = sub;
}

/* One place to run every network step: keeps the button honest, stops double
   submits, and turns a throw into a toast. */
async function guard(btn, label, fn) {
  if (state.busy) return;
  state.busy = true;
  const original = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try {
    await fn();
  } catch (err) {
    toast("Couldn't do that", err.message, "error");
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  } finally {
    state.busy = false;
  }
}

function wireStep() {
  const host = $("#recoverPanel");
  if (!host) return;

  host.querySelectorAll("[data-intent]").forEach((tab) =>
    tab.addEventListener("click", () => {
      state.intent = tab.dataset.intent;
      state.email = $("#rc_email")?.value.trim() || state.email;
      paint();
    })
  );

  const startForm = $("#recoverStartForm");
  startForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const btn = e.submitter || startForm.querySelector("[type=submit]");
    send(btn?.dataset.send || (state.intent === "username" ? "code" : "link"), btn);
  });
  host.querySelector("[data-send=code]:not([type=submit])")
    ?.addEventListener("click", (e) => send("code", e.currentTarget));

  host.querySelector("[data-goto-code]")?.addEventListener("click", () => {
    state.step = "code";
    paint();
  });

  // Offered from the username reveal: they're already verified, so this is the
  // same last step as a password reset — including the heading.
  host.querySelector("[data-goto-password]")?.addEventListener("click", () => {
    state.intent = "password";
    state.step = "newPassword";
    paint();
  });

  host.querySelector("[data-resend]")?.addEventListener("click", (e) =>
    send(state.step === "code" ? "code" : "link", e.currentTarget)
  );

  host.querySelector("[data-recover-restart]")?.addEventListener("click", () => {
    state.step = "start";
    paint();
  });

  const codeForm = $("#recoverCodeForm");
  codeForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const token = ($("#rc_code")?.value || "").replace(/\s+/g, "");
    if (token.length < CODE_LEN) {
      return toast("Code incomplete", `Enter all ${CODE_LEN} digits from the email.`, "error");
    }
    verify(token, codeForm.querySelector("[type=submit]"));
  });

  const pwForm = $("#recoverPwForm");
  pwForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const pw = $("#rc_pw")?.value || "";
    const confirm = $("#rc_pw2")?.value || "";
    if (pw.length < 6) return toast("Weak password", "Password must be at least 6 characters.", "error");
    if (pw !== confirm) return toast("Passwords don't match", "Type the same password in both boxes.", "error");
    savePassword(pw, pwForm.querySelector("[type=submit]"));
  });

  host.querySelector("[data-recover-continue]")?.addEventListener("click", () => finish());
}

/* ------------------------------------------------------------ the four calls */

/* Supabase names the account it can't find, which would let anyone probe the
   portal for who has an account. Treat it as an ordinary send. */
const NO_SUCH_ACCOUNT = /signups not allowed|otp_disabled|user not found|user_not_found/;

/* Nothing to confirm — the address is already verified. */
const ALREADY_DONE = /already confirmed|already been confirmed|email_address_not_available/;

function send(kind, btn) {
  const email = ($("#rc_email")?.value ?? state.email).trim().toLowerCase();
  if (!email.includes("@") || !email.includes(".")) {
    return toast("Email needed", "Enter the email address on your account.", "error");
  }
  state.email = email;

  return guard(btn, "Sending…", async () => {
    if (state.intent === "confirm") {
      // resend(), not signUp(): the account already exists, and signing up again
      // with the same address is an error rather than a new email.
      const { error } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: redirectUrl() },
      });
      if (error && !ALREADY_DONE.test(error.message.toLowerCase())) {
        throw new Error(authMessage(error));
      }
      if (error) {
        // Already confirmed — nothing to resend, so close the panel (finish, not
        // onFinish: leaving it open would contradict what the toast just said)
        // and let the router put them back on the login form.
        toast("Already confirmed", "This address is confirmed. Sign in with your password.", "success");
        return finish();
      }
      state.codeType = "signup";
      state.step = "code";
    } else if (state.intent === "username") {
      // A sign-in code, not a reset: they still know their password.
      try { sessionStorage.setItem(INTENT_KEY, "username"); } catch { /* private mode */ }
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: redirectUrl() },
      });
      if (error && !NO_SUCH_ACCOUNT.test(error.message.toLowerCase())) {
        throw new Error(authMessage(error));
      }
      state.codeType = "email";
      state.step = "code";
    } else {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: redirectUrl(),
      });
      if (error && !NO_SUCH_ACCOUNT.test(error.message.toLowerCase())) {
        throw new Error(authMessage(error));
      }
      state.codeType = "recovery";
      state.step = kind === "code" ? "code" : "linkSent";
    }
    toast("Email sent", `Check ${email} — it usually arrives within a minute.`, "success");
    paint();
  });
}

function verify(token, btn) {
  return guard(btn, "Verifying…", async () => {
    const { data, error } = await supabase.auth.verifyOtp({
      email: state.email, token, type: state.codeType,
    });
    if (error) throw new Error(authMessage(error));
    if (!data?.session) throw new Error("That code was accepted but no session came back. Please try the link in the email.");

    state.ownsSession = true;
    if (state.intent === "confirm") {
      // Confirmed and signed in — there is nothing else to ask for.
      toast("Email confirmed", "You're signed in. Welcome to the HPF portal.", "success");
      return finish();
    }
    if (state.intent === "username") {
      state.username = await lookupUsername(data.session.user.id);
      state.step = "username";
      try { sessionStorage.removeItem(INTENT_KEY); } catch { /* private mode */ }
    } else {
      state.step = "newPassword";
    }
    paint();
  });
}

function savePassword(password, btn) {
  return guard(btn, "Saving…", async () => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(authMessage(error));
    toast("Password updated", "Use your new password next time you sign in.", "success");
    await finish();
  });
}

async function finish() {
  closeRecovery();
  await onFinish();
}
