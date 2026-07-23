-- ============================================================
-- HPF Digital Portal — PostgreSQL schema for Supabase
-- Run this once in the Supabase SQL editor:
--   Dashboard → SQL Editor → New query → paste → Run.
-- Mirrors the app's current data model (users, classes, learners,
-- assignments, assessments, submissions, login events, field reports)
-- with row-level security so the browser can talk to Postgres safely.
-- ============================================================

-- ---------- enums ----------
create type user_role      as enum ('admin','teacher','learner','field_officer','school_leader');
create type work_type      as enum ('lesson','exercise','quiz');
create type session_state  as enum ('planned','active','ended');
create type audience_kind  as enum ('all','individual');

-- ---------- 1) profiles (one row per auth user) ----------
create table profiles (
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

-- create a profile automatically on signup; role/name come from signup metadata
create function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
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
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- 2) classes / grades ----------
create table classes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  school     text not null,
  owner_id   uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- a learner in a class (real account, or a roster-only name)
create table enrollments (
  id           uuid primary key default gen_random_uuid(),
  class_id     uuid not null references classes(id) on delete cascade,
  learner_id   uuid references profiles(id) on delete cascade,  -- null = name only
  name         text not null,
  is_account   boolean not null default false,
  active_label text default 'just now',
  created_at   timestamptz not null default now()
);

-- ---------- 3) assignments (lessons / exercises / quizzes) ----------
create table assignments (
  id         uuid primary key default gen_random_uuid(),
  class_id   uuid not null references classes(id) on delete cascade,
  type       work_type not null default 'lesson',
  title      text not null,
  detail     text,
  due        text,
  session    session_state not null default 'planned',
  created_at timestamptz not null default now()
);

create table assignment_results (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references assignments(id) on delete cascade,
  enrollment_id uuid not null references enrollments(id) on delete cascade,
  pct           int not null default 0,
  score         int,
  unique (assignment_id, enrollment_id)
);

-- ---------- 4) assessments (auto-marked MCQ) ----------
create table assessments (
  id         uuid primary key default gen_random_uuid(),
  class_id   uuid not null references classes(id) on delete cascade,
  title      text not null,
  session    session_state not null default 'planned',
  published  boolean not null default false,
  audience   audience_kind not null default 'all',
  target_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table questions (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments(id) on delete cascade,
  position      int not null,
  text          text not null,
  options       jsonb not null,   -- array of option strings
  correct       int not null      -- index of the correct option
);

create table submissions (
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
create table login_events (
  id           uuid primary key default gen_random_uuid(),
  type         text not null,     -- 'login' | 'signup'
  name         text,
  identifier   text,
  role         user_role,
  delivered_to text,
  created_at   timestamptz not null default now()
);

-- ---------- 6) field-officer reports ----------
create table field_reports (
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
-- Baseline policies below are intentionally readable; they are
-- tightened during app integration once we can test live.
-- ============================================================

-- is the caller an admin?  (security definer avoids RLS recursion)
create function is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- does the caller own (teach) this class?
create function owns_class(cid uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from classes where id = cid and owner_id = auth.uid());
$$;

-- is the caller enrolled in this class?
create function enrolled_in(cid uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from enrollments where class_id = cid and learner_id = auth.uid());
$$;

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

-- profiles: any signed-in user can read (teachers need to see learners,
-- admins everyone); you may edit your own, admins may edit anyone.
create policy "read profiles"   on profiles for select to authenticated using (true);
create policy "update own"      on profiles for update to authenticated using (id = auth.uid() or is_admin());
create policy "admin insert"    on profiles for insert to authenticated with check (is_admin());

-- classes: teachers CRUD their own; admins all; learners read classes they're in.
create policy "class read"   on classes for select to authenticated using (owns_class(id) or enrolled_in(id) or is_admin());
create policy "class write"  on classes for all    to authenticated using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());

-- enrollments / assignments / assessments / questions:
-- the class owner (teacher) or an admin manages them; enrolled learners read.
create policy "enr read"  on enrollments for select to authenticated using (owns_class(class_id) or learner_id = auth.uid() or is_admin());
create policy "enr write" on enrollments for all    to authenticated using (owns_class(class_id) or is_admin()) with check (owns_class(class_id) or is_admin());

create policy "asg read"  on assignments for select to authenticated using (owns_class(class_id) or enrolled_in(class_id) or is_admin());
create policy "asg write" on assignments for all    to authenticated using (owns_class(class_id) or is_admin()) with check (owns_class(class_id) or is_admin());

create policy "res read"  on assignment_results for select to authenticated using (true);
create policy "res write" on assignment_results for all    to authenticated using (true) with check (true);

create policy "ass read"  on assessments for select to authenticated using (owns_class(class_id) or enrolled_in(class_id) or is_admin());
create policy "ass write" on assessments for all    to authenticated using (owns_class(class_id) or is_admin()) with check (owns_class(class_id) or is_admin());

create policy "q read"    on questions for select to authenticated using (true);
create policy "q write"   on questions for all    to authenticated using (true) with check (true);

-- submissions: a learner writes/reads their own; the teacher & admin read all.
create policy "sub read"   on submissions for select to authenticated using (learner_id = auth.uid() or is_admin()
              or exists (select 1 from assessments a where a.id = assessment_id and owns_class(a.class_id)));
create policy "sub insert" on submissions for insert to authenticated with check (learner_id = auth.uid() or is_admin()
              or exists (select 1 from assessments a where a.id = assessment_id and owns_class(a.class_id)));
create policy "sub update" on submissions for update to authenticated using (learner_id = auth.uid() or is_admin());

-- login events: anyone signed in may log; only admins read the inbox.
create policy "evt insert" on login_events for insert to authenticated with check (true);
create policy "evt read"   on login_events for select to authenticated using (is_admin());

-- field reports: officers manage their own; admins read all.
create policy "fr own"   on field_reports for all    to authenticated using (user_id = auth.uid() or is_admin()) with check (user_id = auth.uid() or is_admin());

-- ============================================================
-- After running this, create your first admin:
--   1. Dashboard → Authentication → Users → Add user
--      (email + password, and check "Auto Confirm User").
--   2. SQL Editor:
--        update profiles set role = 'admin'
--        where email = 'you@example.org';
-- ============================================================
