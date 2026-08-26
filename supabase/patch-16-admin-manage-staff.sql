-- ============================================================
-- HPF Digital Portal — patch 16: only Admin manages existing Staff/Admin rows
-- Run once in the Supabase SQL editor, after patch-14. Safe to re-run.
--
-- patch-14 made is_staff() the gate for almost every general action,
-- including updating someone else's profile row at all -- so today a Staff
-- viewer can already rename, or demote back to Learner, an existing Staff or
-- Admin account. Patrick asked for Admin to have real extra powers over
-- Staff, scoped to exactly this: Staff can still create new Staff (invite)
-- and view the list, but touching an ALREADY-staff-or-admin row -- editing
-- or removing it -- is Admin-only from here on.
--
-- "update own" (patch-06) is the one policy that governs this: it decides
-- whether an UPDATE on someone else's row is allowed at all, before
-- guard_profile_role() (patch-14) ever gets to inspect what's changing. The
-- USING clause runs against the row's row BEFORE the update, so checking
-- `role` here checks who they already are, not what they're being changed
-- to -- which is exactly the distinction needed: promoting a teacher up to
-- Staff still works (their old role isn't staff/admin), touching an
-- existing Staff/Admin row now doesn't, unless the viewer is Admin.
-- ============================================================

drop policy if exists "update own" on profiles;
create policy "update own" on profiles for update to authenticated
  using (
    id = (select auth.uid())
    or (select is_admin())
    or ((select is_staff()) and role not in ('admin', 'staff'))
  );
