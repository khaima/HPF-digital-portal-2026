-- ============================================================
-- HPF Digital Portal — patch 05: index the foreign keys
-- Run once in the Supabase SQL editor, after patch-04:
--   Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.
--
-- Supabase's linter reported nine unindexed foreign keys. Postgres indexes the
-- parent side of a FK automatically but never the child side, so every join and
-- every parent delete was scanning the whole child table.
--
-- Where the app reads more than the key alongside the lookup, the index carries
-- those columns with INCLUDE. That lets the planner answer from an index-only
-- scan instead of returning to the heap once per row — the covering-index
-- pattern, worth roughly 2-5x on read-heavy paths.
--
-- These will show up as "unused index" in the linter until the tables carry
-- real traffic. That is expected on a database with no rows yet, not a reason
-- to drop them.
-- ============================================================

-- class -> assignments / assessments / enrollments: the coach view lists these
-- by class constantly, and always wants the title/type alongside.
create index if not exists assignments_class_id_idx
  on assignments (class_id) include (title, type, session);
create index if not exists assessments_class_id_idx
  on assessments (class_id) include (title, session, published);
create index if not exists enrollments_class_id_idx
  on enrollments (class_id) include (name, learner_id, is_account);

-- learner -> enrollments / submissions: "my classes" and "my results".
create index if not exists enrollments_learner_id_idx on enrollments (learner_id);
create index if not exists submissions_learner_id_idx
  on submissions (learner_id) include (assessment_id, pct);

-- assessment -> questions: always fetched as a whole ordered paper, so the
-- sort column joins the key rather than sitting in INCLUDE.
create index if not exists questions_assessment_id_idx
  on questions (assessment_id, position) include (text, correct);

-- assignment -> results: progress per assignment.
create index if not exists assignment_results_enrollment_id_idx
  on assignment_results (enrollment_id) include (assignment_id, pct, score);

-- teacher -> classes, officer -> reports. Both also back an RLS predicate
-- (owns_class, "fr own"), so these cut policy evaluation cost too.
create index if not exists classes_owner_id_idx
  on classes (owner_id) include (name, school);
create index if not exists field_reports_user_id_idx
  on field_reports (user_id) include (school, status, created_at);
