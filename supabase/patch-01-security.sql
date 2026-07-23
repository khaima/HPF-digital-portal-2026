-- ============================================================
-- HPF Digital Portal — security patch 01
-- Run once in the Supabase SQL editor, after schema.sql:
--   Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.
--
-- Closes three holes in the baseline schema:
--   1. signup metadata could grant itself 'admin'
--   2. a user could promote themselves by updating their own profile row
--   3. every authenticated user could read quiz answer keys
-- ============================================================

-- ---------- 1) role can never be self-assigned at signup ----------
-- handle_new_user() previously trusted raw_user_meta_data->>'role' verbatim, so
-- posting {"role":"admin"} to /auth/v1/signup produced an admin account and
-- is_admin() then unlocked every table. Clamp to the self-serve roles; 'admin'
-- is granted by SQL only (see the bottom of this file).
create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  requested text := new.raw_user_meta_data->>'role';
  safe_role user_role;
begin
  safe_role := case requested
                 when 'teacher'       then 'teacher'::user_role
                 when 'school_leader' then 'school_leader'::user_role
                 when 'field_officer' then 'field_officer'::user_role
                 else 'learner'::user_role   -- covers 'admin', junk, and null
               end;

  -- org_type added here: the signup form collects it but the original trigger
  -- dropped it on the floor.
  insert into profiles (id, full_name, email, username, role, school, county, org_type)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name',''),
    new.email,
    new.raw_user_meta_data->>'username',
    safe_role,
    new.raw_user_meta_data->>'school',
    new.raw_user_meta_data->>'county',
    new.raw_user_meta_data->>'org_type'
  );
  return new;
end $$;

-- ---------- 2) role cannot be changed by the row's owner ----------
-- The "update own" policy allows a user to update their own profiles row, and
-- RLS cannot restrict individual columns — so role was writable by its owner.
-- This trigger pins role to its previous value unless the change is legitimate.
--
-- Note on the claims check: auth.uid() reads request.jwt.claims, which is unset
-- in the SQL editor and for service_role callers. Gating on is_admin() alone
-- would therefore block the very SQL used to appoint the first admin. So the
-- guard only applies to real API requests made as an ordinary user.
create or replace function guard_profile_role() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  claims   json := nullif(current_setting('request.jwt.claims', true), '')::json;
  jwt_role text := claims->>'role';
begin
  if new.role is distinct from old.role
     and claims is not null            -- null = SQL editor / direct connection
     and jwt_role is distinct from 'service_role'
     and not is_admin() then
    new.role := old.role;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_role on profiles;
create trigger profiles_guard_role
  before update on profiles
  for each row execute function guard_profile_role();

-- ---------- 3) quiz answer keys are owner-only ----------
-- "q read" was `using (true)`, exposing questions.correct — the answer index —
-- to any signed-in user, who could read it before submitting.
drop policy if exists "q read"  on questions;
drop policy if exists "q write" on questions;

create policy "q read" on questions for select to authenticated
  using (exists (
    select 1 from assessments a
    where a.id = questions.assessment_id and (owns_class(a.class_id) or is_admin())
  ));

create policy "q write" on questions for all to authenticated
  using (exists (
    select 1 from assessments a
    where a.id = questions.assessment_id and (owns_class(a.class_id) or is_admin())
  ))
  with check (exists (
    select 1 from assessments a
    where a.id = questions.assessment_id and (owns_class(a.class_id) or is_admin())
  ));

-- ---------- 4) assignment results scoped to the owning class ----------
-- Was `using (true)` for both read and write, per the schema's own note that
-- baseline policies would be tightened during integration.
drop policy if exists "res read"  on assignment_results;
drop policy if exists "res write" on assignment_results;

create policy "res read" on assignment_results for select to authenticated
  using (exists (
    select 1 from assignments a
    where a.id = assignment_results.assignment_id and (owns_class(a.class_id) or is_admin())
  ));

create policy "res write" on assignment_results for all to authenticated
  using (exists (
    select 1 from assignments a
    where a.id = assignment_results.assignment_id and (owns_class(a.class_id) or is_admin())
  ))
  with check (exists (
    select 1 from assignments a
    where a.id = assignment_results.assignment_id and (owns_class(a.class_id) or is_admin())
  ));

-- ============================================================
-- Granting admin (the only supported route)
-- Create the user first via Authentication → Users → Add user,
-- then run, with your own address:
--
--   update profiles set role = 'admin' where email = 'you@humanpractice.org';
--
-- The guard trigger permits this because the SQL editor carries no JWT claims;
-- the same statement issued from the browser as a non-admin is silently
-- neutralised instead.
-- ============================================================
