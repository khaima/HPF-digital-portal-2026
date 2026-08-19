-- ============================================================
-- HPF Digital Portal — patch 12: field officer assignments
-- Run once in the Supabase SQL editor, after patch-11. Safe to re-run.
--
-- Gives "Field Officer: assigned schools" a real mechanism instead of an
-- officer only ever seeing reports they personally filed. An admin assigns
-- officers to schools here; RLS on field_reports and school_returns then
-- checks the same table, so an assignment made in the admin dashboard is
-- what actually lets an officer file and see reports for that school, on
-- every device — not merely what the dashboard panel displays.
--
-- Also tightens school_returns / school_return_grades / school_return_revisions
-- read access from "any signed-in user reads everything" (using (true)) to
-- "admin, the school's own leader, or an officer assigned to that school" —
-- verified against both client call sites (the school-leader own-return view
-- and the admin scorecard) before applying, so this is not a functional
-- regression for either.
-- ============================================================

create table if not exists school_officer_assignments (
  id          uuid primary key default gen_random_uuid(),
  officer_id  uuid not null references profiles(id) on delete cascade,
  school      text not null,
  assigned_by uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (officer_id, school)
);

create index if not exists school_officer_assignments_officer_idx
  on school_officer_assignments (officer_id) include (school);
create index if not exists school_officer_assignments_school_idx
  on school_officer_assignments (school);

alter table school_officer_assignments enable row level security;

drop policy if exists "assignments read"  on school_officer_assignments;
drop policy if exists "assignments write" on school_officer_assignments;

-- An officer sees their own assignments (so the field-officer form can list
-- "your schools"); only an admin manages who is assigned where.
create policy "assignments read" on school_officer_assignments for select to authenticated
  using ((select is_admin()) or officer_id = (select auth.uid()));

create policy "assignments write" on school_officer_assignments for all to authenticated
  using ((select is_admin()))
  with check ((select is_admin()));

-- Checks whether the signed-in officer is assigned to target_school. Mirrors
-- owns_class()/enrolled_in(): SECURITY DEFINER so it can read the assignment
-- table regardless of the caller's own RLS grants, STABLE so Postgres can
-- fold repeated calls within one statement.
create or replace function assigned_to_school(target_school text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.school_officer_assignments
    where officer_id = auth.uid() and school = target_school
  );
$$;

revoke all on function assigned_to_school(text) from public;
grant execute on function assigned_to_school(text) to authenticated;

-- ------------------------------------------------------------ field_reports
-- Was one "fr own" policy (own report only, admin bypass) for every
-- operation. Split into four so read/update can additionally recognise
-- "assigned to this school" (supervisory access) without loosening insert
-- (you can't have "your own" report for a school you've never been assigned
-- to file for) or delete (stays own-report-only, deliberately conservative).
drop policy if exists "fr own" on field_reports;

create policy "fr read" on field_reports for select to authenticated
  using (
    (select is_admin())
    or user_id = (select auth.uid())
    or assigned_to_school(school)
  );

create policy "fr insert" on field_reports for insert to authenticated
  with check (
    (select is_admin())
    or assigned_to_school(school)
  );

create policy "fr update" on field_reports for update to authenticated
  using (
    (select is_admin())
    or user_id = (select auth.uid())
    or assigned_to_school(school)
  )
  with check (
    (select is_admin())
    or user_id = (select auth.uid())
    or assigned_to_school(school)
  );

create policy "fr delete" on field_reports for delete to authenticated
  using (
    (select is_admin())
    or user_id = (select auth.uid())
  );

-- ------------------------------------------------------------ school_returns
-- Was "any signed-in user reads everything". Now: admin, the school's own
-- leader, or an officer assigned to that school.
drop policy if exists "returns read" on school_returns;

create policy "returns read" on school_returns for select to authenticated
  using (
    (select is_admin())
    or school = (select p.school from profiles p where p.id = (select auth.uid()))
    or assigned_to_school(school)
  );

drop policy if exists "grades read" on school_return_grades;

create policy "grades read" on school_return_grades for select to authenticated
  using (
    exists (
      select 1 from school_returns r
      where r.id = school_return_grades.return_id
        and (
          (select is_admin())
          or r.school = (select p.school from profiles p where p.id = (select auth.uid()))
          or assigned_to_school(r.school)
        )
    )
  );

-- Revisions are an audit trail of a school's own returns, so they follow the
-- same scope as the return itself rather than adding officer visibility —
-- an officer sees the current figures, not the school's edit history.
drop policy if exists "revisions read" on school_return_revisions;

create policy "revisions read" on school_return_revisions for select to authenticated
  using (
    (select is_admin())
    or school = (select p.school from profiles p where p.id = (select auth.uid()))
  );
