-- ============================================================
-- HPF Digital Portal — patch 15: staff invite tracking
-- Run once in the Supabase SQL editor, after patch-14. Safe to re-run.
--
-- Supports switching "Add staff member" from an admin-typed temporary
-- password to an emailed invite link: the invitee's row is flagged here the
-- moment the invite is created, and the app forces a "choose your password"
-- step on their first sign-in until they clear it themselves. This is what
-- actually proves they control the mailbox, rather than trusting whoever
-- typed the address into the admin panel.
--
-- No RLS changes: the existing "update own profile" and staff/admin
-- "update any profile" policies already cover an ordinary column add, since
-- guard_profile_role() only ever inspects role transitions, not this one.
-- ============================================================

alter table public.profiles add column if not exists needs_password boolean not null default false;
