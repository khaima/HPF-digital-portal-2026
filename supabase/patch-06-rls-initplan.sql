-- ============================================================
-- HPF Digital Portal — patch 06: hoist auth.uid() out of RLS row loops
-- Run once in the Supabase SQL editor, after patch-05:
--   Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.
--
-- Seven policies called auth.uid() and is_admin() bare, so Postgres re-ran them
-- once per row examined — on a table of 10,000 rows, 10,000 calls. Wrapping
-- each in a scalar subquery lets the planner hoist it into an InitPlan and
-- evaluate it once per statement. Supabase rates this 5-10x on large tables.
--
-- The predicates are otherwise untouched: same columns, same operators, same OR
-- structure. Access rules do not change, only how often the constants are
-- computed. patch-02 already wrote the schools policies this way.
-- ============================================================

drop policy if exists "update own" on profiles;
create policy "update own" on profiles for update to authenticated
  using (id = (select auth.uid()) or (select is_admin()));

drop policy if exists "class write" on classes;
create policy "class write" on classes for all to authenticated
  using (owner_id = (select auth.uid()) or (select is_admin()))
  with check (owner_id = (select auth.uid()) or (select is_admin()));

drop policy if exists "enr read" on enrollments;
create policy "enr read" on enrollments for select to authenticated
  using (owns_class(class_id) or learner_id = (select auth.uid()) or (select is_admin()));

drop policy if exists "fr own" on field_reports;
create policy "fr own" on field_reports for all to authenticated
  using (user_id = (select auth.uid()) or (select is_admin()))
  with check (user_id = (select auth.uid()) or (select is_admin()));

drop policy if exists "sub read" on submissions;
create policy "sub read" on submissions for select to authenticated
  using (learner_id = (select auth.uid()) or (select is_admin())
         or exists (select 1 from assessments a
                    where a.id = submissions.assessment_id and owns_class(a.class_id)));

drop policy if exists "sub insert" on submissions;
create policy "sub insert" on submissions for insert to authenticated
  with check (learner_id = (select auth.uid()) or (select is_admin())
              or exists (select 1 from assessments a
                         where a.id = submissions.assessment_id and owns_class(a.class_id)));

drop policy if exists "sub update" on submissions;
create policy "sub update" on submissions for update to authenticated
  using (learner_id = (select auth.uid()) or (select is_admin()));

-- ---------- still open ----------
-- The linter also reports "multiple permissive policies" on assessments,
-- assignments, assignment_results, classes, enrollments, questions and schools:
-- each has a "<x> write" policy declared FOR ALL, which includes SELECT, so it
-- is evaluated on reads on top of the "<x> read" policy.
--
-- The fix is to narrow those to `for insert, update, delete`, leaving SELECT to
-- the read policy alone. It is left out of this patch deliberately: it only
-- holds if each write policy's SELECT audience is already a subset of the read
-- policy's, and that has to be checked table by table. Get it wrong and someone
-- silently loses read access.
