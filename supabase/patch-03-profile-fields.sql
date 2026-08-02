-- ============================================================
-- HPF Digital Portal — patch 03: profile fields that signup collects
-- Run once in the Supabase SQL editor, after patch-02-schools.sql:
--   Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.
--
-- The signup form asks for "County / region" and "Project", and validates
-- both as required — then throws them away. `region` was never forwarded in
-- the signup metadata, and `project` had nowhere to land. Every account
-- created so far therefore has a null county and no project, which is why
-- those two columns read "—" for every Supabase user in the admin table.
--
-- The form's region select lists Meru / Isiolo / Laikipia / Narok, which are
-- counties, so it maps onto the existing profiles.county column rather than
-- earning a redundant `region` one. Only `project` is genuinely new.
-- ============================================================

alter table public.profiles add column if not exists project text;

-- ---------- carry project through signup ----------
-- Same shape as patch-01, which is still the authority on role clamping:
-- 'admin' is never self-assignable, whatever the client posts.
--
-- search_path tightened from `public` to `''` while we are in here. This runs
-- SECURITY DEFINER — as the owner, bypassing RLS — so anything it resolves
-- through a search path is a privilege-escalation route: create a `profiles`
-- earlier in the path and the insert lands there instead. Every reference is
-- schema-qualified now, including the enum, which will NOT resolve without it.
create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  requested text := new.raw_user_meta_data->>'role';
  safe_role public.user_role;
begin
  safe_role := case requested
                 when 'teacher'       then 'teacher'::public.user_role
                 when 'school_leader' then 'school_leader'::public.user_role
                 when 'field_officer' then 'field_officer'::public.user_role
                 else 'learner'::public.user_role   -- covers 'admin', junk, and null
               end;

  insert into public.profiles (id, full_name, email, username, role, school, county, org_type, project)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name',''),
    new.email,
    new.raw_user_meta_data->>'username',
    safe_role,
    new.raw_user_meta_data->>'school',
    new.raw_user_meta_data->>'county',
    new.raw_user_meta_data->>'org_type',
    new.raw_user_meta_data->>'project'
  );
  return new;
end;
$$;

-- ---------- backfill accounts created before this patch ----------
-- The values were posted to auth.users at signup even when the trigger
-- ignored them, so anything the old form did forward is still recoverable.
-- Only fills blanks; an admin who has since corrected a profile keeps theirs.
update public.profiles p
   set county  = coalesce(nullif(p.county, ''),  u.raw_user_meta_data->>'county'),
       project = coalesce(nullif(p.project, ''), u.raw_user_meta_data->>'project')
  from auth.users u
 where u.id = p.id
   and (p.county is null or p.county = '' or p.project is null or p.project = '');
