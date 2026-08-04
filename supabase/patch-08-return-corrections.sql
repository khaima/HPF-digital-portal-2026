-- ============================================================
-- HPF Digital Portal — patch 08: correcting a filed return
-- Run once in the Supabase SQL editor, after patch-07.
-- Safe to re-run.
--
-- A filed return already feeds the HPF scorecard, so letting a head overwrite
-- enrolment or dropout figures silently is the problem, not the fix. Anyone
-- reading a rate needs to see that it was amended, by whom, and why.
--
-- The trail is written by a trigger rather than by the app, so a change made
-- through the REST API or the SQL editor is recorded exactly the same way.
-- Clients get no insert/update/delete policy on the revisions table at all —
-- the trigger is SECURITY DEFINER and owns it.
--
-- correction_reason sits on school_returns only as the carrier for the current
-- edit. The trigger moves it into the revision and blanks it, so the live row
-- never claims a reason belonging to a past change.
-- ============================================================

alter table school_returns add column if not exists correction_reason text;

create table if not exists school_return_revisions (
  id           uuid primary key default gen_random_uuid(),
  return_id    uuid not null references school_returns(id) on delete cascade,
  school       text not null,
  year         int  not null,
  term         text not null,
  previous     jsonb not null,   -- the row as it stood before
  changed      jsonb not null,   -- only the fields that moved: {col:{from,to}}
  reason       text,
  corrected_by uuid references profiles(id) on delete set null,
  corrected_at timestamptz not null default now()
);

create index if not exists return_revisions_return_idx
  on school_return_revisions (return_id, corrected_at desc);
create index if not exists return_revisions_school_idx
  on school_return_revisions (school, year, term);

create or replace function log_return_correction() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  before_j jsonb := to_jsonb(old) - 'updated_at' - 'correction_reason';
  after_j  jsonb := to_jsonb(new) - 'updated_at' - 'correction_reason';
  diff     jsonb := '{}'::jsonb;
  k        text;
begin
  for k in select jsonb_object_keys(after_j) loop
    if before_j -> k is distinct from after_j -> k then
      diff := diff || jsonb_build_object(
        k, jsonb_build_object('from', before_j -> k, 'to', after_j -> k));
    end if;
  end loop;

  if diff = '{}'::jsonb then
    return new;   -- a save that changed nothing is not a correction
  end if;

  insert into public.school_return_revisions
    (return_id, school, year, term, previous, changed, reason, corrected_by)
  values (old.id, old.school, old.year, old.term, before_j, diff,
          nullif(new.correction_reason, ''), auth.uid());

  new.correction_reason := null;
  return new;
end;
$$;

revoke all on function public.log_return_correction() from public, anon, authenticated;

drop trigger if exists school_returns_log_correction on school_returns;
create trigger school_returns_log_correction
  before update on school_returns
  for each row execute function log_return_correction();

alter table school_return_revisions enable row level security;

drop policy if exists "revisions read"   on school_return_revisions;
drop policy if exists "revisions insert" on school_return_revisions;

-- The point of an audit trail is that it can be read. No write policy exists
-- for clients by design.
create policy "revisions read" on school_return_revisions for select to authenticated
  using (true);
