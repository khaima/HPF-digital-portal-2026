-- ============================================================
-- HPF Digital Portal — DEVELOPMENT SEED DATA
--
-- ============================================================
-- DO NOT RUN THIS AGAINST THE LIVE PROJECT (zptupvyrwoeabncxabgj).
-- This is synthetic data for local testing only — a local Supabase
-- instance, or a throwaway Supabase branch. Running it against production
-- would insert fake teachers, learners, and field data into the one real
-- database this app has.
-- ============================================================
--
-- This is NOT the same thing as the real seed data already in the repo:
-- patch-02's 17 real schools and patch-13's real subject list are
-- production reference data (the actual schools HPF works with, the actual
-- subjects taught) and belong in the patch sequence, applied to the real
-- project. Everything below is fake, for exercising the schema locally —
-- it does not belong in the patch sequence and is never applied here.
--
-- Prerequisite: schema.sql through patch-20 already applied to whatever
-- database you run this against.
--
-- Usage (against a LOCAL or BRANCH database only):
--   psql "$LOCAL_OR_BRANCH_DATABASE_URL" -f supabase/seed-dev.sql
-- ============================================================

do $$
begin
  if current_database() !~ '^(postgres|local|dev|branch)' then
    raise notice 'Seeding database "%": double-check this is not production before proceeding.', current_database();
  end if;
end $$;

-- ---------- fake teachers, field officers, a school leader ----------
-- Auth users are not created here — this seed only touches application
-- tables, not auth.users, so it never creates a real sign-in-able account.
-- Use a real signup (or an admin invite) locally if you need to actually
-- sign in as one of these; this seed is for exercising queries and RLS
-- shapes against realistic-looking rows, not for testing auth itself.

insert into schools (id, name, county, lat, lng) values
  ('d0000000-0000-0000-0000-000000000001', 'Seed Demo Primary School', 'Meru', 0.05, 37.65)
on conflict (id) do nothing;

insert into learners (id, full_name, gender, school_id, admission_number) values
  ('d0000000-0000-0000-0000-000000000010', 'Amina Wanjiru',   'female', 'd0000000-0000-0000-0000-000000000001', 'SEED-001'),
  ('d0000000-0000-0000-0000-000000000011', 'Brian Kiptoo',    'male',   'd0000000-0000-0000-0000-000000000001', 'SEED-002'),
  ('d0000000-0000-0000-0000-000000000012', 'Cynthia Achieng', 'female', 'd0000000-0000-0000-0000-000000000001', 'SEED-003')
on conflict (id) do nothing;

insert into classes (id, name, school) values
  ('d0000000-0000-0000-0000-000000000020', 'Seed Class 4A', 'Seed Demo Primary School')
on conflict (id) do nothing;

insert into enrollments (class_id, learner_id, name, is_account) values
  ('d0000000-0000-0000-0000-000000000020', 'd0000000-0000-0000-0000-000000000010', 'Amina Wanjiru',   false),
  ('d0000000-0000-0000-0000-000000000020', 'd0000000-0000-0000-0000-000000000011', 'Brian Kiptoo',    false),
  ('d0000000-0000-0000-0000-000000000020', 'd0000000-0000-0000-0000-000000000012', 'Cynthia Achieng', false)
on conflict do nothing;

-- ---------- attendance: two weeks for the seed class ----------
insert into attendance_records (learner_id, class_id, session_date, status)
select l.id, 'd0000000-0000-0000-0000-000000000020', d::date,
  (array['present','present','present','absent','late'])[1 + (random() * 4)::int]
from (values
  ('d0000000-0000-0000-0000-000000000010'::uuid),
  ('d0000000-0000-0000-0000-000000000011'::uuid),
  ('d0000000-0000-0000-0000-000000000012'::uuid)
) as l(id)
cross join generate_series('2026-08-03'::date, '2026-08-14'::date, '1 day') as d
where extract(isodow from d) < 6 -- weekdays only
on conflict do nothing;

-- ---------- M&E indicators, one measurement, one target ----------
insert into me_indicators (id, code, name, description, unit, pillar) values
  ('d0000000-0000-0000-0000-000000000030', 'seed_attendance_pct', 'Seed: attendance rate', 'Demo indicator for local testing', '%', 'learning')
on conflict (id) do nothing;

insert into me_indicator_values (indicator_id, school_id, period_year, period_term, value, source) values
  ('d0000000-0000-0000-0000-000000000030', 'd0000000-0000-0000-0000-000000000001', 2026, 'Term 2', 87.5, 'manual')
on conflict do nothing;

insert into me_targets (indicator_id, school_id, period_year, target_value) values
  ('d0000000-0000-0000-0000-000000000030', 'd0000000-0000-0000-0000-000000000001', 2026, 90)
on conflict do nothing;

-- ---------- one piece of evidence, attached to the indicator value above ----------
insert into evidence (title, description, ref_table, ref_id) values
  ('Seed: attendance register scan', 'Placeholder evidence for local testing.', 'me_indicator_values',
    (select id from me_indicator_values where indicator_id = 'd0000000-0000-0000-0000-000000000030' limit 1));

-- ---------- summary ----------
do $$
begin
  raise notice 'Seed complete: % learners, % attendance rows, % indicator values in the seed school.',
    (select count(*) from learners where school_id = 'd0000000-0000-0000-0000-000000000001'),
    (select count(*) from attendance_records where class_id = 'd0000000-0000-0000-0000-000000000020'),
    (select count(*) from me_indicator_values where school_id = 'd0000000-0000-0000-0000-000000000001');
end $$;
