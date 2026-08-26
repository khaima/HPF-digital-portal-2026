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
--
-- WITH CHECK is required, not optional: a policy with a USING clause and no
-- explicit WITH CHECK has Postgres reuse USING as the check on the RESULTING
-- row too. That silently broke the one thing this patch was designed to
-- preserve -- a Staff member promoting a teacher to Staff -- because the row
-- that results FROM that promotion (role now 'staff') no longer satisfies a
-- Staff actor's own USING clause, and Postgres then rejects the write it had
-- just allowed. Caught by testing against the live database with a rolled-
-- back transaction before this shipped, not assumed. The WITH CHECK here
-- deliberately omits the old-role condition -- that check's job belongs to
-- USING (which row can be touched), not to WITH CHECK (what the actor is
-- allowed to write), and guard_profile_role() (patch-14) is still the
-- trigger that stops a Staff actor granting 'admin', independent of this.
-- ============================================================

drop policy if exists "update own" on profiles;
create policy "update own" on profiles for update to authenticated
  using (
    id = (select auth.uid())
    or (select is_admin())
    or ((select is_staff()) and role not in ('admin', 'staff'))
  )
  with check (
    id = (select auth.uid())
    or (select is_admin())
    or (select is_staff())
  );
