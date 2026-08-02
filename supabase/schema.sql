-- ============================================================
-- HPF Digital Portal — PostgreSQL schema for Supabase
-- Run this in the Supabase SQL editor:
--   Dashboard → SQL Editor → New query → paste → Run.
-- Mirrors the app's current data model (users, classes, learners,
-- assignments, assessments, submissions, login events, field reports)
-- with row-level security so the browser can talk to Postgres safely.
--
-- SAFE TO RE-RUN. Every statement is create-only-if-absent.
--
-- Deliberately create-only, NOT create-or-replace: the later patches
-- redefine things this file also defines, and a re-run must never undo them.
-- handle_new_user() below is the ORIGINAL, which trusts the client's role and
-- therefore grants admin to anyone who posts {"role":"admin"} at signup;
-- patch-01 closes that. `create or replace` here would silently reopen it on
-- the next re-run. Same for the "q read" / "res write" policies patch-01
-- tightens. So: if the object already exists, this file leaves it alone.
--
-- Run order: schema.sql → patch-01 → patch-02 → patch-03. See SETUP.md.
-- ============================================================

-- ---------- enums ----------
do $do$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum ('admin','teacher','learner','field_officer','school_leader');
  end if;
  if not exists (select 1 from pg_type where typname = 'work_type') then
    create type work_type as enum ('lesson','exercise','quiz');
  end if;
  if not exists (select 1 from pg_type where typname = 'session_state') then
    create type session_state as enum ('planned','active','ended');
  end if;
  if not exists (select 1 from pg_type where typname = 'audience_kind') then
    create type audience_kind as enum ('all','individual');
  end if;
end
$do$;

-- ---------- 1) profiles (one row per auth user) ----------
create table if not exists profiles (
  id         uuid primary key references auth.users on delete cascade,
  full_name  text not null default '',
  role       user_role not null default 'learner',
  username   text unique,
  email      text,
  school     text,
  org_type   text,
  county     text,
  created_at timestamptz not null default now()
);

-- Create a profile automatically on signup; role/name come from signup metadata.
-- Only created if absent — patch-01 and patch-03 replace this with a version
-- that clamps the role and carries `project`. Never overwrite theirs.
do $do$
begin
  if to_regprocedure('public.handle_new_user()') is null then
    execute $fn$
      create function handle_new_user() returns trigger
        language plpgsql security definer set search_path = public as $body$
      begin
        insert into profiles (id, full_name, email, username, role, school, county)
        values (
          new.id,
          coalesce(new.raw_user_meta_data->>'full_name',''),
          new.email,
          new.raw_user_meta_data->>'username',
          coalesce((new.raw_user_meta_data->>'role')::user_role, 'learner'),
          new.raw_user_meta_data->>'school',
          new.raw_user_meta_data->>'county'
        );
        return new;
      end $body$;
    $fn$;
  end if;
end
$do$;

-- The trigger only binds a name to the function, so recreating it cannot
-- change behaviour — whichever version of handle_new_user() is installed wins.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- 2) classes / grades ----------
create table if not exists classes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  school     text not null,
  owner_id   uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- a learner in a class (real account, or a roster-only name)
create table if not exists enrollments (
  id           uuid primary key default gen_random_uuid(),
  class_id     uuid not null references classes(id) on delete cascade,
  learner_id   uuid references profiles(id) on delete cascade,  -- null = name only
  name         text not null,
  is_account   boolean not null default false,
  active_label text default 'just now',
  created_at   timestamptz not null default now()
);

-- ---------- 3) assignments (lessons / exercises / quizzes) ----------
create table if not exists assignments (
  id         uuid primary key default gen_random_uuid(),
  class_id   uuid not null references classes(id) on delete cascade,
  type       work_type not null default 'lesson',
  title      text not null,
  detail     text,
  due        text,
  session    session_state not null default 'planned',
  created_at timestamptz not null default now()
);

create table if not exists assignment_results (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references assignments(id) on delete cascade,
  enrollment_id uuid not null references enrollments(id) on delete cascade,
  pct           int not null default 0,
  score         int,
  unique (assignment_id, enrollment_id)
);

-- ---------- 4) assessments (auto-marked MCQ) ----------
create table if not exists assessments (
  id         uuid primary key default gen_random_uuid(),
  class_id   uuid not null references classes(id) on delete cascade,
  title      text not null,
  session    session_state not null default 'planned',
  published  boolean not null default false,
  audience   audience_kind not null default 'all',
  target_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists questions (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments(id) on delete cascade,
  position      int not null,
  text          text not null,
  options       jsonb not null,   -- array of option strings
  correct       int not null      -- index of the correct option
);

create table if not exists submissions (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments(id) on delete cascade,
  learner_id    uuid references profiles(id) on delete set null,
  name          text not null,
  answers       jsonb not null,   -- array of selected indexes
  correct       int not null,
  total         int not null,
  pct           int not null,
  created_at    timestamptz not null default now(),
  unique (assessment_id, learner_id)
);

-- ---------- 5) login-request inbox (admin) ----------
create table if not exists login_events (
  id           uuid primary key default gen_random_uuid(),
  type         text not null,     -- 'login' | 'signup'
  name         text,
  identifier   text,
  role         user_role,
  delivered_to text,
  created_at   timestamptz not null default now()
);

-- ---------- 6) field-officer reports ----------
create table if not exists field_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles(id) on delete cascade,
  school     text,
  visit_type text,
  county     text,
  teachers   int default 0,
  learners   int default 0,
  notes      text,
  status     text default 'pending',
  created_at timestamptz not null default now()
);

-- ============================================================
-- Row-level security
-- Baseline policies below are intentionally readable; patch-01
-- tightens the ones that leaked quiz answer keys.
-- ============================================================

-- Helper predicates, all security definer so they can read the tables the
-- policies protect without recursing through RLS. Created only if absent.
do $do$
begin
  if to_regprocedure('public.is_admin()') is null then
    execute $fn$
      create function is_admin() returns boolean
        language sql stable security definer set search_path = public as $body$
        select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
      $body$;
    $fn$;
  end if;

  if to_regprocedure('public.owns_class(uuid)') is null then
    execute $fn$
      create function owns_class(cid uuid) returns boolean
        language sql stable security definer set search_path = public as $body$
        select exists (select 1 from classes where id = cid and owner_id = auth.uid());
      $body$;
    $fn$;
  end if;

  if to_regprocedure('public.enrolled_in(uuid)') is null then
    execute $fn$
      create function enrolled_in(cid uuid) returns boolean
        language sql stable security definer set search_path = public as $body$
        select exists (select 1 from enrollments where class_id = cid and learner_id = auth.uid());
      $body$;
    $fn$;
  end if;
end
$do$;

alter table profiles           enable row level security;
alter table classes            enable row level security;
alter table enrollments        enable row level security;
alter table assignments        enable row level security;
alter table assignment_results enable row level security;
alter table assessments        enable row level security;
alter table questions          enable row level security;
alter table submissions        enable row level security;
alter table login_events       enable row level security;
alter table field_reports      enable row level security;

-- `create policy` has no IF NOT EXISTS, and dropping first would undo patch-01.
-- This helper creates a policy only when that table has no policy by that name.
-- It lives in pg_temp, so it disappears when the editor session ends.
create or replace function pg_temp.ensure_policy(tbl text, pol text, ddl text)
  returns void language plpgsql as $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = tbl and policyname = pol
  ) then
    execute ddl;
  end if;
end $$;

-- profiles: any signed-in user can read (teachers need to see learners,
-- admins everyone); you may edit your own, admins may edit anyone.
select pg_temp.ensure_policy('profiles','read profiles',
  $$create policy "read profiles" on profiles for select to authenticated using (true)$$);
select pg_temp.ensure_policy('profiles','update own',
  $$create policy "update own" on profiles for update to authenticated using (id = auth.uid() or is_admin())$$);
select pg_temp.ensure_policy('profiles','admin insert',
  $$create policy "admin insert" on profiles for insert to authenticated with check (is_admin())$$);

-- classes: teachers CRUD their own; admins all; learners read classes they're in.
select pg_temp.ensure_policy('classes','class read',
  $$create policy "class read" on classes for select to authenticated using (owns_class(id) or enrolled_in(id) or is_admin())$$);
select pg_temp.ensure_policy('classes','class write',
  $$create policy "class write" on classes for all to authenticated using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin())$$);

-- enrollments / assignments / assessments / questions:
-- the class owner (teacher) or an admin manages them; enrolled learners read.
select pg_temp.ensure_policy('enrollments','enr read',
  $$create policy "enr read" on enrollments for select to authenticated using (owns_class(class_id) or learner_id = auth.uid() or is_admin())$$);
select pg_temp.ensure_policy('enrollments','enr write',
  $$create policy "enr write" on enrollments for all to authenticated using (owns_class(class_id) or is_admin()) with check (owns_class(class_id) or is_admin())$$);

select pg_temp.ensure_policy('assignments','asg read',
  $$create policy "asg read" on assignments for select to authenticated using (owns_class(class_id) or enrolled_in(class_id) or is_admin())$$);
select pg_temp.ensure_policy('assignments','asg write',
  $$create policy "asg write" on assignments for all to authenticated using (owns_class(class_id) or is_admin()) with check (owns_class(class_id) or is_admin())$$);

-- NOTE: patch-01 replaces these two with class-scoped versions. Left permissive
-- here only so a fresh install works before the patch runs.
select pg_temp.ensure_policy('assignment_results','res read',
  $$create policy "res read" on assignment_results for select to authenticated using (true)$$);
select pg_temp.ensure_policy('assignment_results','res write',
  $$create policy "res write" on assignment_results for all to authenticated using (true) with check (true)$$);

select pg_temp.ensure_policy('assessments','ass read',
  $$create policy "ass read" on assessments for select to authenticated using (owns_class(class_id) or enrolled_in(class_id) or is_admin())$$);
select pg_temp.ensure_policy('assessments','ass write',
  $$create policy "ass write" on assessments for all to authenticated using (owns_class(class_id) or is_admin()) with check (owns_class(class_id) or is_admin())$$);

-- NOTE: "q read" exposes answer keys to every signed-in user. patch-01 fixes
-- this. Do not relax it back.
select pg_temp.ensure_policy('questions','q read',
  $$create policy "q read" on questions for select to authenticated using (true)$$);
select pg_temp.ensure_policy('questions','q write',
  $$create policy "q write" on questions for all to authenticated using (true) with check (true)$$);

-- submissions: a learner writes/reads their own; the teacher & admin read all.
select pg_temp.ensure_policy('submissions','sub read',
  $$create policy "sub read" on submissions for select to authenticated using (learner_id = auth.uid() or is_admin()
     or exists (select 1 from assessments a where a.id = assessment_id and owns_class(a.class_id)))$$);
select pg_temp.ensure_policy('submissions','sub insert',
  $$create policy "sub insert" on submissions for insert to authenticated with check (learner_id = auth.uid() or is_admin()
     or exists (select 1 from assessments a where a.id = assessment_id and owns_class(a.class_id)))$$);
select pg_temp.ensure_policy('submissions','sub update',
  $$create policy "sub update" on submissions for update to authenticated using (learner_id = auth.uid() or is_admin())$$);

-- login events: anyone signed in may log; only admins read the inbox.
select pg_temp.ensure_policy('login_events','evt insert',
  $$create policy "evt insert" on login_events for insert to authenticated with check (true)$$);
select pg_temp.ensure_policy('login_events','evt read',
  $$create policy "evt read" on login_events for select to authenticated using (is_admin())$$);

-- field reports: officers manage their own; admins read all.
select pg_temp.ensure_policy('field_reports','fr own',
  $$create policy "fr own" on field_reports for all to authenticated using (user_id = auth.uid() or is_admin()) with check (user_id = auth.uid() or is_admin())$$);

-- ============================================================
-- After running this, create your first admin:
--   1. Dashboard → Authentication → Users → Add user
--      (email + password, and check "Auto Confirm User").
--   2. SQL Editor:
--        update profiles set role = 'admin'
--        where email = 'you@example.org';
-- ============================================================
