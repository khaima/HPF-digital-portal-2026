-- ============================================================
-- HPF Digital Portal — patch 07: termly school returns
-- Run once in the Supabase SQL editor, after patch-06.
-- Safe to re-run.
--
-- What a head of institution files each term: enrolment, staffing, retention,
-- and the facilities facts HPF's pillars are scored on. One row per school per
-- term per year, so history accumulates and "all terms" is an aggregate over
-- rows rather than a different kind of record.
--
-- Enrolment is stored split by gender and never as a total — equity reporting
-- is the reason for collecting it, and a stored total is one more thing that
-- can disagree with its parts.
-- ============================================================

create table if not exists school_returns (
  id                       uuid primary key default gen_random_uuid(),
  school                   text not null,
  county                   text,
  year                     int  not null,
  term                     text not null,

  boys                     int not null default 0,
  girls                    int not null default 0,
  learners_with_disability int not null default 0,

  -- the TSC / non-TSC split is what shows HPF where the funding gap sits
  tsc_teachers             int not null default 0,
  non_tsc_teachers         int not null default 0,
  support_staff            int not null default 0,
  teachers_trained_term    int not null default 0,

  dropouts                 int not null default 0,
  dropout_reason           text,
  dropout_reason_other     text,
  transfers_in             int not null default 0,
  transfers_out            int not null default 0,

  attendance_rate          int,
  mean_score               numeric(5,2),

  classrooms               int,
  desks                    int,
  toilets                  int,
  water_source             text,
  electricity              text,

  computers                int,
  internet_status          text,

  feeding_programme        boolean not null default false,
  income_projects          text,

  notes                    text,
  submitted_by             uuid references profiles(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- One return per school per term; refiling updates rather than duplicating.
create unique index if not exists school_returns_unique_idx
  on school_returns (lower(school), year, term);

-- The scorecard reads by school and by term and always wants the headline
-- numbers alongside, so they ride in the index and those reads stay index-only.
create index if not exists school_returns_school_idx
  on school_returns (school, year, term) include (boys, girls, tsc_teachers, non_tsc_teachers, dropouts);
create index if not exists school_returns_county_idx    on school_returns (county, year, term);
create index if not exists school_returns_submitted_by_idx on school_returns (submitted_by);

drop trigger if exists school_returns_touch_updated_at on school_returns;
create trigger school_returns_touch_updated_at
  before update on school_returns
  for each row execute function touch_updated_at();

alter table school_returns enable row level security;

drop policy if exists "returns read"  on school_returns;
drop policy if exists "returns write" on school_returns;

-- Read is open to any signed-in user: the scorecard aggregates across schools,
-- and a teacher seeing their own school's numbers is not a leak.
create policy "returns read" on school_returns for select to authenticated
  using (true);

-- A head may only write returns for the school on their own profile; admins
-- may write any. Wrapped in select so each lookup runs once per statement.
create policy "returns write" on school_returns for all to authenticated
  using (
    (select is_admin())
    or school = (select p.school from profiles p where p.id = (select auth.uid()))
  )
  with check (
    (select is_admin())
    or school = (select p.school from profiles p where p.id = (select auth.uid()))
  );
