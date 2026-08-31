/* ============================================================
   Supabase client. Loaded straight from a CDN as an ES module so
   the site stays a static build with no toolchain — same style as
   the rest of the app's imports.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

/* detectSessionInUrl must stay on: the password-reset and sign-in-code emails
   send people back here with their tokens in the URL, and this is what turns
   those into a session (and fires the PASSWORD_RECOVERY event app.js listens
   for). It also strips the tokens from the address bar afterwards. */
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* A throwaway client that never touches stored session state.
   signUp() signs the new user in on whichever client makes the call, which
   would knock an admin out of their own session while adding a teacher.
   Creating the account on an isolated client keeps the caller signed in. */
export function adminClient() {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/* Supabase error messages are terse and sometimes leak internals; map the
   common ones onto something a teacher can act on. */
export function authMessage(error) {
  const m = (error?.message || "").toLowerCase();
  if (m.includes("invalid login credentials")) return "Invalid credentials. Check your details and try again.";
  // The app offers the confirmation email itself now (see recovery.js), so this
  // only needs to say what happened, not what an admin should go and change.
  if (m.includes("email not confirmed")) return "This email address hasn't been confirmed yet.";
  if (m.includes("already registered") || m.includes("already been registered")) return "An account with those details already exists.";
  if (m.includes("password should be")) return "Password must be at least 6 characters.";
  if (m.includes("failed to fetch")) return "Cannot reach the server. Check your internet connection.";
  /* ---- account recovery ---- */
  // Supabase says "Token has expired or is invalid" for both a wrong code and
  // an expired one; the code is the only part the person can act on.
  if (m.includes("token has expired") || m.includes("otp_expired") || m.includes("invalid token"))
    return "That code is wrong or has expired. Request a new one and try again.";
  if (m.includes("email rate limit") || m.includes("over_email_send_rate_limit"))
    return "Too many emails have been sent from the portal in the last hour. Please try again later.";
  // "For security purposes, you can only request this after 51 seconds."
  if (m.includes("for security purposes")) return error.message;
  // Shared by every recovery/invite/confirm path (a code, a link, or an
  // admin invite), so this can't name which one expired — just that it did.
  if (m.includes("auth session missing") || m.includes("session_not_found"))
    return "That's no longer valid. Request a new one and use it straight away.";
  if (m.includes("new password should be different") || m.includes("same as the old password"))
    return "That is the password you already have. Choose a different one.";
  return error?.message || "Something went wrong. Please try again.";
}
