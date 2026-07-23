/* ============================================================
   Supabase client. Loaded straight from a CDN as an ES module so
   the site stays a static build with no toolchain — same style as
   the rest of the app's imports.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
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
  if (m.includes("email not confirmed")) return "This account still needs email confirmation. Ask an HPF admin to enable auto-confirm.";
  if (m.includes("already registered") || m.includes("already been registered")) return "An account with those details already exists.";
  if (m.includes("password should be")) return "Password must be at least 6 characters.";
  if (m.includes("failed to fetch")) return "Cannot reach the server. Check your internet connection.";
  return error?.message || "Something went wrong. Please try again.";
}
