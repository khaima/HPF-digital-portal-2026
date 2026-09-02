-- ============================================================
-- HPF Digital Portal — patch 31: real learner experience, prerequisite fix
-- Run once in the Supabase SQL editor, after patch-30. Safe to re-run.
--
-- See supabase/LEARNER-EXPERIENCE-SPEC.md for the full design. This is
-- the one schema change that spec named as load-bearing: every other
-- learner-scoped table (enrollments, attendance_records, kolibri_activity,
-- library_activity, learning_activity) references learners(id) — the
-- real MDM identity a learner has, whether or not they ever hold a
-- credential. submissions was the one outlier, still referencing
-- profiles(id) — a row a learner structurally never has (no email, no
-- Supabase Auth account, ever). That FK was unsatisfiable for a real
-- learner from the day patch-13 shipped it.
--
-- Zero rows exist in `submissions` today (verified live), so this is a
-- pure, non-destructive constraint swap — nothing to migrate, nothing to
-- backfill.
-- ============================================================

alter table public.submissions drop constraint if exists submissions_learner_id_fkey;
alter table public.submissions
  add constraint submissions_learner_id_fkey
  foreign key (learner_id) references public.learners(id) on delete set null;

-- Note, deliberately not changed here: the "submissions create/view/edit"
-- RLS policies still carry a `learner_id = auth.uid()` clause left over
-- from when this FK pointed at profiles(id). It's dead, not dangerous —
-- learners.id and profiles.id are independently-generated UUIDs from
-- different tables, so this clause can now never match a real row. The
-- clause that actually authorizes a learner-attributed write is the
-- existing `owns_class(a.class_id)` branch (the teacher's own session),
-- which this patch doesn't need to touch — see the Option D model in
-- LEARNER-EXPERIENCE-SPEC.md §4. Flagged here rather than silently
-- rewritten, matching this schema's own convention of calling out a
-- known-harmless leftover instead of touching policies with no
-- behavioral need to.
