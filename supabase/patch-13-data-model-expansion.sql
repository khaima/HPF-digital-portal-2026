-- ============================================================
-- HPF Digital Portal — patch 13: data model expansion
-- Run once in the Supabase SQL editor, after patch-12. Safe to re-run.
--
-- Builds out the rest of the target central schema: roles, richer school/
-- teacher/field-officer/learner records, a real curriculum-subject and
-- learning-content model, field-visit findings, device tracking, an
-- intervention/action-item workflow, notifications and an audit trail.
--
-- This is schema, not features: none of these tables get client wiring in
-- this patch, the same way assignments/assessments/questions sat fully
-- built and RLS-complete for a long time before any UI read or wrote them.
-- Two deliberate exceptions, not oversights:
--   - `submissions` already IS what a table called "assessment_results"
--     would hold (per-learner assessment result) — not duplicated here.
--   - `field_visits`/`field_visit_findings` are the future-shaped, normalized
--     version of what `field_reports` already does live today. Both exist
--     after this patch; `field_reports` stays authoritative until a future
--     pass migrates the field-officer portal onto the new tables — building
--     that migration was out of scope for a schema-only pass.
--
-- RLS throughout reuses the existing helper-function vocabulary
-- (is_admin(), owns_class(), enrolled_in(), assigned_to_school()) rather
-- than inventing a new authorization style, and wraps auth.uid()/is_admin()
-- in `(select ...)` per patch-06's InitPlan-hoisting pattern.
--
-- Indexes here are plain FK indexes only (no INCLUDE columns) — patch-05's
-- covering indexes were chosen from real read patterns; nothing has read
-- these tables yet to know what to cover.
-- ============================================================

-- ------------------------------------------------------------ roles
-- A reference/lookup table for role metadata (label, description) — not a
-- replacement for profiles.role, which stays the existing user_role enum
-- untouched (every is_admin()-style function and trigger that compares
-- role = 'admin' keeps working exactly as before). roles.id uses that same
-- enum type purely so profiles can carry a real FK to it.
create table if not exists roles (
  id          user_role primary key,
  label       text not null,
  description text
);

insert into roles (id, label, description) values
  ('admin',         'HPF Staff (Admin)', 'Full platform access — every school, every account.'),
  ('teacher',       'Teacher',           'Runs classes at one school: rosters, assignments, assessments.'),
  ('school_leader', 'School Leader',     'Files termly returns and oversees one school.'),
  ('field_officer', 'Field Officer',     'Visits and reports on assigned schools.'),
  ('learner',       'Learner',           'Local-only account (no Supabase auth) — takes assignments/assessments on a shared classroom device.')
on conflict (id) do nothing;

alter table roles enable row level security;
drop policy if exists "roles read" on roles;
create policy "roles read" on roles for select to authenticated using (true);
-- No write policy for authenticated: the 5 rows are fixed by this migration,
-- not admin-editable data.

alter table profiles
  add constraint profiles_role_fkey foreign key (role) references roles(id);

-- ------------------------------------------------------------ school data
create table if not exists school_programmes (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  programme   text not null,
  status      text not null default 'active' check (status in ('planned','active','completed','paused')),
  started_at  date,
  ended_at    date,
  notes       text,
  created_at  timestamptz not null default now(),
  unique (school_id, programme)
);
create index if not exists school_programmes_school_id_idx on school_programmes (school_id);

alter table school_programmes enable row level security;
drop policy if exists "programmes read" on school_programmes;
drop policy if exists "programmes write" on school_programmes;
create policy "programmes read" on school_programmes for select to authenticated using (true);
create policy "programmes write" on school_programmes for all to authenticated
  using ((select is_admin()))
  with check ((select is_admin()));

-- Current-state facilities inventory — one row per school, distinct from
-- school_returns' termly historical snapshot of similar fields (returns
-- answer "what did term 2 2026 look like"; this answers "what's true now").
create table if not exists school_facilities (
  school_id        uuid primary key references schools(id) on delete cascade,
  classrooms       int,
  toilets          int,
  water_source     text,
  electricity      text,
  library          boolean not null default false,
  playground       boolean not null default false,
  solar            boolean not null default false,
  fence            boolean not null default false,
  dormitories      int,
  dining_hall      boolean not null default false,
  teachers_houses  int,
  computers        int,
  internet_status  text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references profiles(id) on delete set null
);

drop trigger if exists school_facilities_touch_updated_at on school_facilities;
create trigger school_facilities_touch_updated_at
  before update on school_facilities
  for each row execute function touch_updated_at();

alter table school_facilities enable row level security;
drop policy if exists "facilities read" on school_facilities;
drop policy if exists "facilities write" on school_facilities;
create policy "facilities read" on school_facilities for select to authenticated using (true);
create policy "facilities write" on school_facilities for all to authenticated
  using (
    (select is_admin())
    or exists (select 1 from schools s where s.id = school_facilities.school_id
      and s.name = (select p.school from profiles p where p.id = (select auth.uid())))
  )
  with check (
    (select is_admin())
    or exists (select 1 from schools s where s.id = school_facilities.school_id
      and s.name = (select p.school from profiles p where p.id = (select auth.uid())))
  );

-- ------------------------------------------------------------ people extensions
-- 1:1 extensions of profiles — same shape, same RLS (admin or self) for both.
create table if not exists teachers (
  id                uuid primary key references profiles(id) on delete cascade,
  tsc_number        text,
  subject_specialty text,
  employment_type   text check (employment_type in ('tsc','non_tsc','volunteer')),
  date_joined       date,
  created_at        timestamptz not null default now()
);
alter table teachers enable row level security;
drop policy if exists "teachers rw" on teachers;
create policy "teachers rw" on teachers for all to authenticated
  using ((select is_admin()) or id = (select auth.uid()))
  with check ((select is_admin()) or id = (select auth.uid()));

create table if not exists field_officers (
  id               uuid primary key references profiles(id) on delete cascade,
  employee_number  text,
  region           text,
  vehicle_reg      text,
  date_joined      date,
  created_at       timestamptz not null default now()
);
alter table field_officers enable row level security;
drop policy if exists "field_officers rw" on field_officers;
create policy "field_officers rw" on field_officers for all to authenticated
  using ((select is_admin()) or id = (select auth.uid()))
  with check ((select is_admin()) or id = (select auth.uid()));

create table if not exists teacher_training (
  id               uuid primary key default gen_random_uuid(),
  teacher_id       uuid not null references profiles(id) on delete cascade,
  title            text not null,
  provider         text,
  completed_at     date,
  hours            numeric,
  certificate_url  text,
  created_at       timestamptz not null default now()
);
create index if not exists teacher_training_teacher_id_idx on teacher_training (teacher_id);
alter table teacher_training enable row level security;
drop policy if exists "training rw" on teacher_training;
create policy "training rw" on teacher_training for all to authenticated
  using ((select is_admin()) or teacher_id = (select auth.uid()))
  with check ((select is_admin()) or teacher_id = (select auth.uid()));

-- ------------------------------------------------------------ learners
-- Pure roster data — no Supabase account, no JWT, same as every learner
-- record before this migration. enrollments already exists; this is what
-- enrollments.learner_id finally has something real to reference (the
-- column already existed, just always null in practice — see enrollments'
-- own comment history in schema.sql).
create table if not exists learners (
  id                uuid primary key default gen_random_uuid(),
  full_name         text not null,
  gender            text check (gender in ('male','female')),
  date_of_birth     date,
  school_id         uuid references schools(id) on delete set null,
  admission_number  text,
  guardian_name     text,
  guardian_phone    text,
  created_by        uuid references profiles(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index if not exists learners_school_id_idx on learners (school_id);

-- enrollments.learner_id already existed and already had a foreign key —
-- to profiles(id), left over from before this table existed. That target
-- was structurally dead from day one: a learner can never have a profiles
-- row (no Supabase account, ever — see this file's header). Repointing it
-- at the table that can actually hold a learner's identity now.
alter table enrollments drop constraint if exists enrollments_learner_id_fkey;
alter table enrollments
  add constraint enrollments_learner_id_fkey foreign key (learner_id) references learners(id) on delete set null;

-- "Does the caller own a class this learner is enrolled in" — same shape
-- and purpose as owns_class()/enrolled_in(), just walking through
-- enrollments to reach a learner instead of a class.
create or replace function teaches_learner(lid uuid) returns boolean
  language sql stable security definer set search_path = 'public' as $$
  select exists (
    select 1 from enrollments e join classes c on c.id = e.class_id
    where e.learner_id = lid and c.owner_id = auth.uid()
  );
$$;
revoke all on function teaches_learner(uuid) from public;
grant execute on function teaches_learner(uuid) to authenticated;

alter table learners enable row level security;
drop policy if exists "learners rw" on learners;
create policy "learners rw" on learners for all to authenticated
  using (
    (select is_admin())
    or (select teaches_learner(learners.id))
    or exists (select 1 from schools s where s.id = learners.school_id
      and s.name = (select p.school from profiles p where p.id = (select auth.uid())))
  )
  with check (
    (select is_admin())
    or exists (select 1 from schools s where s.id = learners.school_id
      and s.name = (select p.school from profiles p where p.id = (select auth.uid())))
  );

-- ------------------------------------------------------------ curriculum
create table if not exists subjects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);
insert into subjects (name) values
  ('Literacy'), ('Numeracy'), ('Science'), ('Social Studies'),
  ('Life Skills'), ('Creative Arts'), ('ICT'), ('Physical Education')
on conflict (name) do nothing;

alter table subjects enable row level security;
drop policy if exists "subjects read" on subjects;
drop policy if exists "subjects write" on subjects;
create policy "subjects read" on subjects for select to authenticated using (true);
create policy "subjects write" on subjects for all to authenticated
  using ((select is_admin())) with check ((select is_admin()));

alter table assignments add column if not exists subject_id uuid references subjects(id) on delete set null;
alter table assessments add column if not exists subject_id uuid references subjects(id) on delete set null;
create index if not exists assignments_subject_id_idx on assignments (subject_id);
create index if not exists assessments_subject_id_idx on assessments (subject_id);

-- ------------------------------------------------------------ learning content
-- Four tables, four distinct jobs — not four names for the same thing:
--   digital_learning  = the catalogue (what content exists)
--   kolibri_activity  = usage ingested from an external Kolibri deployment
--   library_activity  = usage against HPF's own curated catalogue specifically
--   learning_activity = the general, not-content-specific engagement timeline
create table if not exists digital_learning (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  kind         text not null check (kind in ('video','exercise','reading','audio','interactive','document','link')),
  source       text,
  subject_id   uuid references subjects(id) on delete set null,
  url          text,
  duration     text,
  description  text,
  category     text,
  published    boolean not null default true,
  created_by   uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists digital_learning_subject_id_idx on digital_learning (subject_id);

alter table digital_learning enable row level security;
drop policy if exists "content read" on digital_learning;
drop policy if exists "content write" on digital_learning;
-- Public read, on purpose: a learner browsing content has no JWT (same
-- structural fact as everywhere else in this schema), so a future UI can
-- only ever query this table for them as `anon`. There's nothing
-- learner-identifying in a content catalogue row, so opening read to anon
-- is the deliberate choice here, unlike assignments/assessments/questions.
create policy "content read" on digital_learning for select to anon, authenticated using (published or (select is_admin()));
create policy "content write" on digital_learning for all to authenticated
  using ((select is_admin())) with check ((select is_admin()));

create table if not exists kolibri_activity (
  id                  uuid primary key default gen_random_uuid(),
  content_id          uuid references digital_learning(id) on delete cascade,
  learner_id          uuid references learners(id) on delete cascade,
  progress_pct        int,
  time_spent_seconds  int,
  kolibri_session_id  text,
  synced_at           timestamptz not null default now()
);
create index if not exists kolibri_activity_content_id_idx on kolibri_activity (content_id);
create index if not exists kolibri_activity_learner_id_idx on kolibri_activity (learner_id);

create table if not exists library_activity (
  id           uuid primary key default gen_random_uuid(),
  content_id   uuid references digital_learning(id) on delete cascade,
  learner_id   uuid references learners(id) on delete cascade,
  action       text not null check (action in ('opened','downloaded','bookmarked')),
  occurred_at  timestamptz not null default now()
);
create index if not exists library_activity_content_id_idx on library_activity (content_id);
create index if not exists library_activity_learner_id_idx on library_activity (learner_id);

create table if not exists learning_activity (
  id           uuid primary key default gen_random_uuid(),
  learner_id   uuid references learners(id) on delete cascade,
  activity_type text not null,
  ref_table    text,
  ref_id       uuid,
  occurred_at  timestamptz not null default now()
);
create index if not exists learning_activity_learner_id_idx on learning_activity (learner_id);

-- All three activity logs: written on a learner's behalf by whichever
-- teacher's session is active on the shared device (same syncResults()
-- pattern this session already established for assignment_results/
-- submissions), or by a school_leader/admin. No learner-direct write —
-- same JWT ceiling as everywhere else. Read: admin, the learner's own
-- school leader, or a teacher who teaches that learner.
create or replace function activity_visible(lid uuid) returns boolean
  language sql stable security definer set search_path = 'public' as $$
  select
    (select is_admin())
    or teaches_learner(lid)
    or exists (
      select 1 from learners l join schools s on s.id = l.school_id
      where l.id = lid and s.name = (select p.school from profiles p where p.id = auth.uid())
    );
$$;
revoke all on function activity_visible(uuid) from public;
grant execute on function activity_visible(uuid) to authenticated;

alter table kolibri_activity enable row level security;
alter table library_activity enable row level security;
alter table learning_activity enable row level security;

drop policy if exists "kolibri rw" on kolibri_activity;
create policy "kolibri rw" on kolibri_activity for all to authenticated
  using ((select activity_visible(kolibri_activity.learner_id)))
  with check ((select activity_visible(kolibri_activity.learner_id)));

drop policy if exists "library_activity rw" on library_activity;
create policy "library_activity rw" on library_activity for all to authenticated
  using ((select activity_visible(library_activity.learner_id)))
  with check ((select activity_visible(library_activity.learner_id)));

drop policy if exists "learning_activity rw" on learning_activity;
create policy "learning_activity rw" on learning_activity for all to authenticated
  using ((select activity_visible(learning_activity.learner_id)))
  with check ((select activity_visible(learning_activity.learner_id)));

-- ------------------------------------------------------------ field operations
-- The future-shaped version of field_reports — see this file's header for
-- why both tables exist. Same RLS shape as field_reports' own "fr *"
-- policies (patch-12): assigned_to_school() joined through schools.name,
-- since these new tables key school by id rather than text.
create table if not exists field_visits (
  id          uuid primary key default gen_random_uuid(),
  officer_id  uuid not null references profiles(id) on delete cascade,
  school_id   uuid references schools(id) on delete set null,
  county      text,
  visit_type  text,
  visited_at  timestamptz not null default now(),
  status      text not null default 'draft' check (status in ('draft','submitted')),
  created_at  timestamptz not null default now()
);
create index if not exists field_visits_officer_id_idx on field_visits (officer_id);
create index if not exists field_visits_school_id_idx on field_visits (school_id);

create table if not exists field_visit_findings (
  id          uuid primary key default gen_random_uuid(),
  visit_id    uuid not null references field_visits(id) on delete cascade,
  pillar      text check (pillar in ('infrastructure','learning','economic_empowerment','general')),
  finding     text not null,
  severity    text check (severity in ('info','watch','concern','urgent')),
  created_at  timestamptz not null default now()
);
create index if not exists field_visit_findings_visit_id_idx on field_visit_findings (visit_id);

create or replace function visit_school_match(sid uuid) returns boolean
  language sql stable security definer set search_path = 'public' as $$
  select exists (select 1 from schools s where s.id = sid and assigned_to_school(s.name));
$$;
revoke all on function visit_school_match(uuid) from public;
grant execute on function visit_school_match(uuid) to authenticated;

alter table field_visits enable row level security;
drop policy if exists "visits rw" on field_visits;
create policy "visits rw" on field_visits for all to authenticated
  using ((select is_admin()) or officer_id = (select auth.uid()) or (select visit_school_match(school_id)))
  with check ((select is_admin()) or officer_id = (select auth.uid()));

alter table field_visit_findings enable row level security;
drop policy if exists "findings rw" on field_visit_findings;
create policy "findings rw" on field_visit_findings for all to authenticated
  using (exists (select 1 from field_visits v where v.id = field_visit_findings.visit_id
    and ((select is_admin()) or v.officer_id = (select auth.uid()) or (select visit_school_match(v.school_id)))))
  with check (exists (select 1 from field_visits v where v.id = field_visit_findings.visit_id
    and ((select is_admin()) or v.officer_id = (select auth.uid()))));

-- ------------------------------------------------------------ assets
create table if not exists devices (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid references schools(id) on delete set null,
  device_type     text check (device_type in ('laptop','tablet','desktop','projector','router','server','other')),
  serial_number   text,
  asset_tag       text,
  status          text not null default 'active' check (status in ('active','faulty','retired')),
  acquired_at     date,
  created_at      timestamptz not null default now()
);
create index if not exists devices_school_id_idx on devices (school_id);

create table if not exists device_maintenance (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid not null references devices(id) on delete cascade,
  reported_by   uuid references profiles(id) on delete set null,
  issue         text not null,
  resolution    text,
  status        text not null default 'open' check (status in ('open','in_progress','resolved')),
  reported_at   timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists device_maintenance_device_id_idx on device_maintenance (device_id);

alter table devices enable row level security;
drop policy if exists "devices rw" on devices;
create policy "devices rw" on devices for all to authenticated
  using ((select is_admin()) or (select visit_school_match(school_id)))
  with check ((select is_admin()) or (select visit_school_match(school_id)));

alter table device_maintenance enable row level security;
drop policy if exists "maintenance rw" on device_maintenance;
create policy "maintenance rw" on device_maintenance for all to authenticated
  using (exists (select 1 from devices d where d.id = device_maintenance.device_id
    and ((select is_admin()) or (select visit_school_match(d.school_id)))))
  with check (exists (select 1 from devices d where d.id = device_maintenance.device_id
    and ((select is_admin()) or (select visit_school_match(d.school_id)))));

-- ------------------------------------------------------------ external ingestion
-- Raw sink for a future KoboToolbox webhook/edge function — none exists
-- yet (this session's earlier Kobo investigation found no existing form
-- maps cleanly onto a current use case). No client insert path on purpose:
-- this is meant to be written server-side once that integration exists.
create table if not exists kobo_submissions (
  id                   uuid primary key default gen_random_uuid(),
  form_id              text not null,
  kobo_submission_id   text not null unique,
  school               text,
  submitted_at         timestamptz,
  payload              jsonb not null,
  processed            boolean not null default false,
  received_at          timestamptz not null default now()
);

alter table kobo_submissions enable row level security;
drop policy if exists "kobo read" on kobo_submissions;
create policy "kobo read" on kobo_submissions for select to authenticated using ((select is_admin()));
-- Deliberately no insert/update/delete policy for `authenticated` — only a
-- service-role integration (which bypasses RLS entirely) is meant to write
-- here.

-- ------------------------------------------------------------ case management
-- Genuinely new product concept — no existing UI or workflow to anchor
-- this against, so this schema is a best-effort design, not a reflection
-- of an established process.
create table if not exists interventions (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid references schools(id) on delete set null,
  title         text not null,
  description   text,
  status        text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  opened_by     uuid references profiles(id) on delete set null,
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz
);
create index if not exists interventions_school_id_idx on interventions (school_id);

create table if not exists action_items (
  id                uuid primary key default gen_random_uuid(),
  intervention_id   uuid not null references interventions(id) on delete cascade,
  title             text not null,
  assignee_id       uuid references profiles(id) on delete set null,
  status            text not null default 'pending' check (status in ('pending','in_progress','done')),
  due_date          date,
  completed_at      timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists action_items_intervention_id_idx on action_items (intervention_id);
create index if not exists action_items_assignee_id_idx on action_items (assignee_id);

alter table interventions enable row level security;
drop policy if exists "interventions rw" on interventions;
create policy "interventions rw" on interventions for all to authenticated
  using ((select is_admin()) or (select visit_school_match(school_id)))
  with check ((select is_admin()) or (select visit_school_match(school_id)));

alter table action_items enable row level security;
drop policy if exists "action_items rw" on action_items;
create policy "action_items rw" on action_items for all to authenticated
  using (
    (select is_admin())
    or assignee_id = (select auth.uid())
    or exists (select 1 from interventions i where i.id = action_items.intervention_id and (select visit_school_match(i.school_id)))
  )
  with check (
    (select is_admin())
    or assignee_id = (select auth.uid())
    or exists (select 1 from interventions i where i.id = action_items.intervention_id and (select visit_school_match(i.school_id)))
  );

-- ------------------------------------------------------------ platform
create table if not exists notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references profiles(id) on delete cascade,
  type          text not null,
  title         text not null,
  body          text,
  link          text,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists notifications_recipient_id_idx on notifications (recipient_id) include (read_at);

alter table notifications enable row level security;
drop policy if exists "notifications read" on notifications;
drop policy if exists "notifications update" on notifications;
drop policy if exists "notifications insert" on notifications;
-- Recipient reads and marks their own as read; no delete policy (nothing
-- deletes a notification today). Insert is admin-only for now — no
-- automated producer exists yet to write these on the app's behalf.
create policy "notifications read" on notifications for select to authenticated
  using (recipient_id = (select auth.uid()) or (select is_admin()));
create policy "notifications update" on notifications for update to authenticated
  using (recipient_id = (select auth.uid()) or (select is_admin()))
  with check (recipient_id = (select auth.uid()) or (select is_admin()));
create policy "notifications insert" on notifications for insert to authenticated
  with check ((select is_admin()));

-- Generic audit trail. Not wired to a trigger on every table (that's a much
-- larger, riskier change than "build the schema") — instead a callable,
-- SECURITY DEFINER helper a future pass can call from sensitive write paths
-- (role changes, admin creation) the same way createAdminAccount()/
-- promoteToAdmin() already exist as clear "sensitive action" points.
create table if not exists audit_logs (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references profiles(id) on delete set null,
  action       text not null,
  table_name   text,
  record_id    uuid,
  old_data     jsonb,
  new_data     jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists audit_logs_actor_id_idx on audit_logs (actor_id);
create index if not exists audit_logs_created_at_idx on audit_logs (created_at);

alter table audit_logs enable row level security;
drop policy if exists "audit read" on audit_logs;
create policy "audit read" on audit_logs for select to authenticated using ((select is_admin()));
-- No insert/update/delete policy for `authenticated` at all — writes only
-- happen through log_audit() below, which runs as this migration's owner
-- and so isn't subject to these policies.

create or replace function log_audit(
  p_action text, p_table_name text, p_record_id uuid,
  p_old_data jsonb default null, p_new_data jsonb default null
) returns void
  language plpgsql security definer set search_path = 'public' as $$
begin
  insert into audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), p_action, p_table_name, p_record_id, p_old_data, p_new_data);
end;
$$;
revoke all on function log_audit(text, text, uuid, jsonb, jsonb) from public;
grant execute on function log_audit(text, text, uuid, jsonb, jsonb) to authenticated;
