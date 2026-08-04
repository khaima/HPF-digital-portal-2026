-- ============================================================
-- HPF Digital Portal — patch 09: enrolment by grade and gender
-- Run once in the Supabase SQL editor, after patch-08. Safe to re-run.
--
-- Enrolment was one boys/girls pair per return. It is now one row per grade,
-- so the roll can be read per grade, per gender, per school and per county —
-- county and school already sit on the parent return, so a grade row reaches
-- both without storing either twice.
--
-- school_returns.boys/girls remain, but stop being independently editable: a
-- trigger recomputes them from the grade rows. A stored total a trigger owns
-- cannot drift from its parts, which was the objection to storing one at all.
-- ============================================================

create table if not exists school_return_grades (
  id        uuid primary key default gen_random_uuid(),
  return_id uuid not null references school_returns(id) on delete cascade,
  grade     text not null,
  boys      int  not null default 0,
  girls     int  not null default 0,
  position  int  not null default 0   -- alphabetical would put Grade 10 between 1 and 2
);

create unique index if not exists return_grades_unique_idx
  on school_return_grades (return_id, grade);
create index if not exists return_grades_return_idx
  on school_return_grades (return_id, position) include (grade, boys, girls);

alter table school_return_grades enable row level security;

drop policy if exists "grades read"  on school_return_grades;
drop policy if exists "grades write" on school_return_grades;

create policy "grades read" on school_return_grades for select to authenticated
  using (true);

-- A grade row inherits its parent's ownership, expressed against the parent so
-- the two can never drift apart.
create policy "grades write" on school_return_grades for all to authenticated
  using (exists (
    select 1 from school_returns r where r.id = return_id and (
      (select is_admin())
      or r.school = (select p.school from profiles p where p.id = (select auth.uid()))
    )))
  with check (exists (
    select 1 from school_returns r where r.id = return_id and (
      (select is_admin())
      or r.school = (select p.school from profiles p where p.id = (select auth.uid()))
    )));

create or replace function sync_return_enrolment() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  rid uuid := coalesce(new.return_id, old.return_id);
begin
  update public.school_returns s
     set boys  = coalesce((select sum(g.boys)  from public.school_return_grades g where g.return_id = rid), 0),
         girls = coalesce((select sum(g.girls) from public.school_return_grades g where g.return_id = rid), 0)
   where s.id = rid;
  return null;
end;
$$;

revoke all on function public.sync_return_enrolment() from public, anon, authenticated;

drop trigger if exists return_grades_sync on school_return_grades;
create trigger return_grades_sync
  after insert or update or delete on school_return_grades
  for each row execute function sync_return_enrolment();
