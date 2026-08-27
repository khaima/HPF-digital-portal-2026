-- ============================================================
-- patch-22 — the permission matrix, as data.
--
-- REQUIRES patch-22a to have run and committed first.
--
-- Until now authorization was expressed as role checks scattered
-- through 69 policies: `is_admin()` here, `is_staff()` there. That
-- works, but nobody can answer "what exactly can an M&E officer do?"
-- without reading all 69. This patch makes the answer a table.
--
--   app_modules  — the 16 areas of the product
--   permissions  — (role, module, action) triples; a row means allowed
--   has_perm()   — the one function every policy calls
--
-- Two layers, and both matter:
--
--   has_perm(module, action)  answers "may this ROLE do this KIND of
--                             thing at all?"
--   the policy's own row test answers "to THIS row?" — own class, own
--                             school, assigned school, and so on.
--
-- A policy needs both. The matrix alone would let a field officer edit
-- any school's facilities; the row test alone would let a learner edit
-- their own school's. Neither is sufficient by itself and this patch
-- does not treat them as interchangeable.
--
-- Safe to re-run: the matrix is deleted and re-seeded each time, so
-- editing the seed below and re-running is the way to change it.
-- ============================================================

-- ---------------------------------------------------------------- modules
create table if not exists public.app_modules (
  id          text primary key,
  label       text not null,
  description text,
  sort_order  int not null default 0
);

insert into public.app_modules (id, label, description, sort_order) values
  ('schools',        'Schools',                'School records — name, county, location, story', 10),
  ('infrastructure', 'Infrastructure',         'Facilities inventory and which programmes run at a school', 20),
  ('returns',        'Termly returns',         'Self-reported termly figures filed by heads of institution', 30),
  ('people',         'People & roles',         'Accounts, role assignments, teacher and field-officer records', 40),
  ('learners',       'Learners',               'Learner roster identities', 50),
  ('classes',        'Classes',                'Classes and enrolments', 60),
  ('coursework',     'Coursework',             'Assignments, assessments, questions, results and submissions', 70),
  ('attendance',     'Attendance',             'Per-learner, per-class daily attendance', 80),
  ('field_ops',      'Field operations',       'Field reports, visits, findings and officer-to-school assignments', 90),
  ('devices',        'Devices',                'Device inventory and maintenance tickets', 100),
  ('library',        'Digital library',        'Content catalogue and learning-activity records', 110),
  ('me',             'Monitoring & evaluation','Indicators, measurements and targets', 120),
  ('interventions',  'Interventions',          'Case management and action items', 130),
  ('evidence',       'Evidence',               'Supporting attachments linked to any record', 140),
  ('audit',          'Audit & access logs',    'Audit trail and sign-in history', 150),
  ('permissions',    'Permission matrix',      'This matrix itself — who may change who can do what', 160)
on conflict (id) do update
  set label = excluded.label, description = excluded.description, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------- matrix
create table if not exists public.permissions (
  role       user_role not null,
  module     text not null references public.app_modules(id) on delete cascade,
  action     text not null check (action in ('view','create','edit','delete','export','approve')),
  primary key (role, module, action)
);

create index if not exists permissions_role_idx on public.permissions (role);

-- ---------------------------------------------------------------- helpers
-- The caller's role, once, from their JWT. SECURITY DEFINER because
-- profiles is itself RLS-protected and a policy must not recurse into it.
create or replace function public.current_app_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = (select auth.uid());
$$;

-- The single question every policy asks. Returns false for anon (no
-- profiles row, so no role, so no permission) — deliberately, so that
-- adding has_perm() to a policy can never accidentally open a table to
-- unauthenticated callers.
--
-- `staff` is mapped to programme_manager here rather than being given
-- its own matrix rows: the value is deprecated by patch-22a and this
-- keeps any row still carrying it working exactly as it did before,
-- instead of silently losing all access the moment this patch lands.
create or replace function public.has_perm(p_module text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from permissions p
    where p.module = p_module
      and p.action = p_action
      and p.role = (
        select case when pr.role = 'staff' then 'programme_manager'::user_role else pr.role end
        from profiles pr where pr.id = (select auth.uid())
      )
  );
$$;

revoke all on function public.current_app_role() from public;
revoke all on function public.has_perm(text, text) from public;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.has_perm(text, text) to authenticated;

-- ---------------------------------------------------------------- migrate off `staff`
-- The lookup rows come FIRST. profiles.role is a foreign key into
-- `roles`, so a profile cannot hold either new role until its row
-- exists here — without this, the migration below fails on any database
-- that actually has staff rows to move.
insert into public.roles (id, label, description) values
  ('programme_manager', 'Programme Manager',
   'Runs the programme: full operational access to every school, every module. Cannot change the permission matrix or delete accounts.'),
  ('me_officer', 'M&E',
   'Monitoring & evaluation: reads and exports everything across the programme; writes only indicators, targets, measurements and evidence.')
on conflict (id) do update
  set label = excluded.label, description = excluded.description;

update public.roles set
  label = 'HPF Staff (deprecated)',
  description = 'Superseded by Programme Manager and M&E (patch-22). Kept because Postgres cannot drop an enum value; existing rows were migrated to programme_manager.'
where id = 'staff';

update public.profiles set role = 'programme_manager' where role = 'staff';

-- is_staff() keeps its meaning — "has org-wide operational standing" —
-- and now covers the two roles the old tier split into. Every existing
-- policy that calls it keeps working unchanged; patch-23 is what
-- narrows individual tables down to the matrix.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = (select auth.uid())
      and role in ('admin', 'staff', 'programme_manager', 'me_officer')
  );
$$;

-- New, and the one is_staff() can no longer express: "may operate the
-- programme", which M&E may not. Policies that used to mean is_staff()
-- in the *write* sense want this instead.
create or replace function public.is_programme_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = (select auth.uid())
      and role in ('admin', 'staff', 'programme_manager')
  );
$$;

revoke all on function public.is_programme_manager() from public;
grant execute on function public.is_programme_manager() to authenticated;

-- ---------------------------------------------------------------- seed the matrix
-- Rebuilt wholesale on every run, so this block is the single
-- authoritative statement of who can do what. Edit here, re-run, done.
delete from public.permissions;

-- ADMIN — everything, everywhere, including the matrix itself.
insert into public.permissions (role, module, action)
select 'admin'::user_role, m.id, a.action
from public.app_modules m
cross join (values ('view'),('create'),('edit'),('delete'),('export'),('approve')) as a(action);

-- PROGRAMME_MANAGER — runs the programme. Everything operational.
-- Carve-outs: cannot change the permission matrix (admin only), cannot
-- delete people, and cannot write the audit trail (nobody can — it is
-- append-only by design, written only by log_audit()).
insert into public.permissions (role, module, action)
select 'programme_manager'::user_role, m.id, a.action
from public.app_modules m
cross join (values ('view'),('create'),('edit'),('delete'),('export'),('approve')) as a(action)
where not (m.id = 'permissions' and a.action <> 'view')
  and not (m.id = 'audit'  and a.action not in ('view','export'))
  and not (m.id = 'people' and a.action = 'delete');

-- M&E — reads and exports everything; writes only M&E data and evidence.
-- This is the separation the role exists for: monitoring observes the
-- programme, it does not operate it.
insert into public.permissions (role, module, action)
select 'me_officer'::user_role, m.id, a.action
from public.app_modules m
cross join (values ('view'),('export')) as a(action);

insert into public.permissions (role, module, action)
select 'me_officer'::user_role, m.id, a.action
from (values ('me'),('evidence')) as m(id)
cross join (values ('create'),('edit'),('delete')) as a(action);

-- FIELD_OFFICER — operates in the field, at their assigned schools only.
-- (Which schools is a row-level question the policies answer with
-- assigned_to_school(); this is only the "what kind of thing" half.)
insert into public.permissions (role, module, action) values
  ('field_officer','field_ops','view'),   ('field_officer','field_ops','create'),
  ('field_officer','field_ops','edit'),   ('field_officer','field_ops','delete'),
  ('field_officer','field_ops','export'),
  ('field_officer','schools','view'),     ('field_officer','schools','export'),
  ('field_officer','infrastructure','view'),('field_officer','infrastructure','create'),
  ('field_officer','infrastructure','edit'),('field_officer','infrastructure','export'),
  ('field_officer','returns','view'),     ('field_officer','returns','export'),
  ('field_officer','devices','view'),     ('field_officer','devices','create'),
  ('field_officer','devices','edit'),     ('field_officer','devices','export'),
  ('field_officer','interventions','view'),('field_officer','interventions','create'),
  ('field_officer','interventions','edit'),('field_officer','interventions','export'),
  ('field_officer','evidence','view'),    ('field_officer','evidence','create'),
  ('field_officer','evidence','export'),
  ('field_officer','learners','view'),    ('field_officer','learners','export'),
  ('field_officer','attendance','view'),  ('field_officer','attendance','export'),
  ('field_officer','me','view'),          ('field_officer','me','export'),
  ('field_officer','library','view'),     ('field_officer','library','export'),
  ('field_officer','classes','view'),
  ('field_officer','coursework','view'),
  ('field_officer','people','view'),
  ('field_officer','permissions','view');

-- SCHOOL_LEADER — runs one school. Files its returns, keeps its roster.
insert into public.permissions (role, module, action) values
  ('school_leader','returns','view'),     ('school_leader','returns','create'),
  ('school_leader','returns','edit'),     ('school_leader','returns','export'),
  ('school_leader','schools','view'),     ('school_leader','schools','export'),
  ('school_leader','infrastructure','view'),('school_leader','infrastructure','edit'),
  ('school_leader','infrastructure','export'),
  ('school_leader','learners','view'),    ('school_leader','learners','create'),
  ('school_leader','learners','edit'),    ('school_leader','learners','export'),
  ('school_leader','classes','view'),     ('school_leader','classes','export'),
  ('school_leader','coursework','view'),  ('school_leader','coursework','export'),
  ('school_leader','attendance','view'),  ('school_leader','attendance','export'),
  ('school_leader','devices','view'),     ('school_leader','devices','create'),
  ('school_leader','evidence','view'),    ('school_leader','evidence','create'),
  ('school_leader','field_ops','view'),
  ('school_leader','interventions','view'),
  ('school_leader','me','view'),          ('school_leader','me','export'),
  ('school_leader','library','view'),     ('school_leader','library','export'),
  ('school_leader','people','view'),
  ('school_leader','permissions','view');

-- TEACHER — owns their classes and everything hanging off them.
-- No returns: those carry school-wide staffing and enrolment figures
-- that are the head of institution's to file, not a teacher's to read.
insert into public.permissions (role, module, action) values
  ('teacher','classes','view'),      ('teacher','classes','create'),
  ('teacher','classes','edit'),      ('teacher','classes','delete'),
  ('teacher','classes','export'),
  ('teacher','coursework','view'),   ('teacher','coursework','create'),
  ('teacher','coursework','edit'),   ('teacher','coursework','delete'),
  ('teacher','coursework','export'),
  ('teacher','attendance','view'),   ('teacher','attendance','create'),
  ('teacher','attendance','edit'),   ('teacher','attendance','export'),
  ('teacher','learners','view'),     ('teacher','learners','create'),
  ('teacher','learners','edit'),     ('teacher','learners','export'),
  ('teacher','evidence','view'),     ('teacher','evidence','create'),
  ('teacher','devices','view'),      ('teacher','devices','create'),
  ('teacher','library','view'),      ('teacher','library','export'),
  ('teacher','schools','view'),
  ('teacher','me','view'),
  ('teacher','people','view'),
  ('teacher','permissions','view');

-- LEARNER — sees their own work and the library.
-- Learners hold no Supabase session (no email, so no JWT), so these
-- rows govern the UI rather than RLS, which never sees a learner at
-- all. They are stated anyway so the matrix describes the whole
-- product rather than only the part RLS can reach.
insert into public.permissions (role, module, action) values
  ('learner','coursework','view'),   ('learner','coursework','create'),
  ('learner','classes','view'),
  ('learner','attendance','view'),
  ('learner','library','view'),
  ('learner','permissions','view');

-- ---------------------------------------------------------------- RLS on the matrix
alter table public.app_modules enable row level security;
alter table public.permissions enable row level security;

-- Everyone signed in may read the matrix — the frontend uses it to shape
-- what it offers, and a permission list is not itself a secret. Only
-- someone with 'permissions.edit' may change it, which by the seed above
-- means admin alone.
drop policy if exists "modules read" on public.app_modules;
create policy "modules read" on public.app_modules
  for select to authenticated using (true);

drop policy if exists "modules write" on public.app_modules;
create policy "modules write" on public.app_modules
  for all to authenticated
  using ((select has_perm('permissions','edit')))
  with check ((select has_perm('permissions','edit')));

drop policy if exists "permissions read" on public.permissions;
create policy "permissions read" on public.permissions
  for select to authenticated using (true);

drop policy if exists "permissions write" on public.permissions;
create policy "permissions write" on public.permissions
  for all to authenticated
  using ((select has_perm('permissions','edit')))
  with check ((select has_perm('permissions','edit')));

-- ---------------------------------------------------------------- role-assignment guard
-- Replaces patch-14's version. Same shape, three changes:
--   * granting admin still requires being admin
--   * granting any other role now requires people.edit rather than the
--     broad is_staff(), so M&E cannot reassign roles
--   * every role change is written to audit_logs, including refusals —
--     an attempt that gets silently reverted is exactly the thing worth
--     having a record of
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims   json := nullif(current_setting('request.jwt.claims', true), '')::json;
  jwt_role text := claims->>'role';
  allowed  boolean;
begin
  if new.role is distinct from old.role
     and claims is not null            -- null = SQL editor / direct connection
     and jwt_role is distinct from 'service_role' then

    allowed := case
      when new.role = 'admin' then is_admin()
      when old.role in ('admin','staff','programme_manager','me_officer') then is_admin()
      else has_perm('people','edit')
    end;

    if not allowed then
      new.role := old.role;
      insert into audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
      values ((select auth.uid()), 'role_change_refused', 'profiles', new.id,
              jsonb_build_object('role', old.role), jsonb_build_object('role', new.role));
    else
      insert into audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
      values ((select auth.uid()), 'role_change', 'profiles', new.id,
              jsonb_build_object('role', old.role), jsonb_build_object('role', new.role));
    end if;
  end if;
  return new;
end $$;
