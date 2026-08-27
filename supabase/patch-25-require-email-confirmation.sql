-- ============================================================
-- patch-25 — stop auto-confirming signups.
--
-- Reverses patch-11. That patch auto-confirmed every new account because
-- SMTP delivery wasn't reliable and unconfirmed accounts were getting
-- permanently stranded. Leaving it in place means anyone can register
-- under an email address they do not own — the account is treated as
-- verified the instant it's created, with nothing to prove the address
-- was really theirs.
--
-- Dropping the trigger alone is necessary but NOT sufficient. Whether an
-- unconfirmed account can actually sign in is governed by a project-level
-- Auth setting this file cannot see or change:
--
--   Authentication -> Providers -> Email -> "Confirm email"
--
-- If that toggle is ON (patch-11's own header says it was, at the time),
-- new signups will need to click a confirmation link before they can sign
-- in — which means SMTP delivery has to actually work, or this reproduces
-- the exact lockout patch-11 was written to fix. Test a real signup right
-- after applying this (supabase/TESTING.md has the manual script) before
-- trusting it in front of real users.
--
-- Rollback, if signups start getting stranded again: re-apply
-- patch-11-open-signup.sql. It is still safe to re-run — it only re-creates
-- the trigger and releases any accounts stuck unconfirmed at that moment.
--
-- Does not touch any existing account: only new inserts into auth.users are
-- affected, and this migration was verified to introduce zero new
-- unconfirmed rows on its own (dropping a BEFORE INSERT trigger changes
-- nothing about rows already committed).
-- ============================================================

drop trigger if exists on_auth_user_auto_confirm on auth.users;

-- Left in place, unused, rather than dropped: patch-11 can still recreate
-- it if this needs to be rolled back, and a dangling unused function is a
-- smaller risk than a rollback migration that has to redefine it from
-- scratch under time pressure.
comment on function public.auto_confirm_new_user() is
  'Deprecated by patch-25 — no trigger calls this any more. Kept only so patch-11 can re-attach it as a rollback without redefining it.';
