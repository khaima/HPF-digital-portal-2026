-- ============================================================
-- HPF Digital Portal — patch 19: M&E indicators, indicator values, targets
-- Run once in the Supabase SQL editor, after patch-18. Safe to re-run.
--
-- No indicator/target table existed at all before this: KPI_TARGETS in
-- data.js is a hardcoded constant, not a record. This is schema only, same
-- as every table in patch-13 — data.js is untouched, no dashboard reads
-- from these tables yet, per "do not redesign the dashboard yet."
--
-- Split in three, not one wide table, because they answer different
-- questions: me_indicators defines WHAT is measured (a fixed, admin-
-- managed vocabulary, same shape as subjects/roles); me_indicator_values
-- holds an actual measurement for a period, tagged with WHERE it came from
-- (source) rather than pretending every number is equally authoritative;
-- me_targets holds what the value SHOULD be, kept separate so a target
-- can exist and be edited without ever being confused for an achieved
-- value, or vice versa.
-- ============================================================

create table if not exists me_indicators (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  description text,
  unit        text,
  pillar      text check (pillar in ('infrastructure', 'learning', 'economic_empowerment', 'general')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists me_indicators_touch_updated_at on me_indicators;
create trigger me_indicators_touch_updated_at
  before update on me_indicators
  for each row execute function touch_updated_at();

alter table me_indicators enable row level security;
drop policy if exists "indicators read"  on me_indicators;
drop policy if exists "indicators write" on me_indicators;
create policy "indicators read" on me_indicators for select to authenticated using (true);
create policy "indicators write" on me_indicators for all to authenticated
  using ((select is_staff())) with check ((select is_staff()));

-- ------------------------------------------------------------ values
create table if not exists me_indicator_values (
  id           uuid primary key default gen_random_uuid(),
  indicator_id uuid not null references me_indicators(id) on delete cascade,
  school_id    uuid references schools(id) on delete cascade, -- null = org-wide
  period_year  int not null,
  period_term  text,
  value        numeric not null,
  source       text not null default 'manual' check (source in ('computed', 'manual', 'kobo_submission')),
  recorded_by  uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (indicator_id, school_id, period_year, period_term)
);

create index if not exists me_indicator_values_indicator_id_idx on me_indicator_values (indicator_id);
create index if not exists me_indicator_values_school_id_idx    on me_indicator_values (school_id);

drop trigger if exists me_indicator_values_touch_updated_at on me_indicator_values;
create trigger me_indicator_values_touch_updated_at
  before update on me_indicator_values
  for each row execute function touch_updated_at();

alter table me_indicator_values enable row level security;
drop policy if exists "indicator values read"  on me_indicator_values;
drop policy if exists "indicator values write" on me_indicator_values;

-- Read is open to any signed-in user, same as school_returns — the
-- scorecard this could feed aggregates across schools.
create policy "indicator values read" on me_indicator_values for select to authenticated using (true);

-- Write: admin/staff always; for a school-scoped row, that school's own
-- leader too (school_returns' own write pattern) or an officer assigned
-- to it (mirrors field_reports/field_visits).
create policy "indicator values write" on me_indicator_values for all to authenticated
  using (
    (select is_staff())
    or (school_id is not null and exists (select 1 from schools s where s.id = me_indicator_values.school_id
      and (s.name = (select p.school from profiles p where p.id = (select auth.uid()))
           or assigned_to_school(s.name))))
  )
  with check (
    (select is_staff())
    or (school_id is not null and exists (select 1 from schools s where s.id = me_indicator_values.school_id
      and (s.name = (select p.school from profiles p where p.id = (select auth.uid()))
           or assigned_to_school(s.name))))
  );

-- ------------------------------------------------------------ targets
create table if not exists me_targets (
  id           uuid primary key default gen_random_uuid(),
  indicator_id uuid not null references me_indicators(id) on delete cascade,
  school_id    uuid references schools(id) on delete cascade, -- null = org-wide
  period_year  int not null,
  target_value numeric not null,
  set_by       uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (indicator_id, school_id, period_year)
);

create index if not exists me_targets_indicator_id_idx on me_targets (indicator_id);
create index if not exists me_targets_school_id_idx    on me_targets (school_id);

drop trigger if exists me_targets_touch_updated_at on me_targets;
create trigger me_targets_touch_updated_at
  before update on me_targets
  for each row execute function touch_updated_at();

alter table me_targets enable row level security;
drop policy if exists "targets read"  on me_targets;
drop policy if exists "targets write" on me_targets;
create policy "targets read" on me_targets for select to authenticated using (true);
-- Targets are set by HPF, not the school itself, unlike the value it's
-- measured against — staff/admin only, no school-leader carve-out.
create policy "targets write" on me_targets for all to authenticated
  using ((select is_staff())) with check ((select is_staff()));
