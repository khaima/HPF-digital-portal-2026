-- ============================================================
-- HPF Digital Portal — patch 32: derive school_returns.attendance_rate
-- from attendance_records. Run once after patch-31. Safe to re-run.
--
-- The gap this closes (patch-18's own header predicted it): attendance
-- existed twice — as a termly percentage a head types into school_returns,
-- and as real per-learner-per-day marks in attendance_records, with
-- nothing connecting them. Two numbers, one fact, free to disagree.
--
-- NO new attendance table (patch-18's is the one and only store), and NO
-- historical row is removed or overwritten: a return filed before any
-- daily marking existed keeps its typed value verbatim and is simply
-- labelled 'manual'.
--
-- See supabase/ATTENDANCE.md for the full definition, the reasoning
-- behind each choice, and how to reproduce any figure by hand.
-- ============================================================

-- ---------------------------------------------------------------- 1) term ranges
-- The reporting period. Kenyan school calendar, three terms:
--   Term 1  Jan 1 – Apr 30      Term 2  May 1 – Aug 31
--   Term 3  Sep 1 – Dec 31
-- IMMUTABLE on purpose: the same (year, term) must always produce the same
-- window, or a rate computed today and the same rate recomputed next year
-- would silently differ. That is what makes the calculation reproducible.
create or replace function public.hpf_term_range(p_year int, p_term text)
returns table (start_date date, end_date date)
language sql
immutable
set search_path = public, pg_catalog
as $$
  select
    case p_term
      when 'Term 1' then make_date(p_year, 1, 1)
      when 'Term 2' then make_date(p_year, 5, 1)
      when 'Term 3' then make_date(p_year, 9, 1)
    end,
    case p_term
      when 'Term 1' then make_date(p_year, 4, 30)
      when 'Term 2' then make_date(p_year, 8, 31)
      when 'Term 3' then make_date(p_year, 12, 31)
    end;
$$;

-- ---------------------------------------------------------------- 2) the definition
-- THE single source of truth for "HPF attendance rate". Every consumer
-- (the trigger below, the dashboard, School 360, Learner 360) resolves to
-- this one definition so they can never disagree.
--
--   numerator   = marks with status 'present' or 'late'
--   denominator = marks with status 'present', 'late' or 'absent'
--   'excused'   = excluded from BOTH (an authorised absence is not a
--                 session the learner failed to attend, and not one the
--                 school failed to deliver — counting it either way
--                 misstates the indicator)
--   rate        = round(numerator * 100 / denominator), NULL when
--                 denominator = 0 (no marks ≠ 0% attendance)
--
-- 'late' counts as attending: the learner was in class. Rewarding
-- punctuality is a different indicator and is not what school_returns
-- asks for ("Average attendance rate (%)").
--
-- School scope: every class whose `classes.school` equals the return's
-- `school` — attendance is marked against a class, and the class carries
-- the school name that school_returns is keyed on.
-- Learner scope: every learner with at least one mark in that school's
-- classes inside the window. A learner never marked contributes nothing
-- rather than being assumed absent.
create or replace function public.hpf_attendance_stats(
  p_school text, p_year int, p_term text
)
returns table (
  present_count  int,
  expected_count int,
  excused_count  int,
  learner_count  int,
  class_count    int,
  rate           int
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (select * from public.hpf_term_range(p_year, p_term)),
  marks as (
    select ar.status, ar.learner_id, ar.class_id
    from attendance_records ar
    join classes c on c.id = ar.class_id
    cross join bounds b
    where c.school = p_school
      and b.start_date is not null
      and ar.session_date between b.start_date and b.end_date
  )
  select
    count(*) filter (where status in ('present', 'late'))::int,
    count(*) filter (where status in ('present', 'late', 'absent'))::int,
    count(*) filter (where status = 'excused')::int,
    count(distinct learner_id)::int,
    count(distinct class_id)::int,
    case when count(*) filter (where status in ('present', 'late', 'absent')) = 0
      then null
      else round(
        count(*) filter (where status in ('present', 'late')) * 100.0
        / count(*) filter (where status in ('present', 'late', 'absent'))
      )::int
    end
  from marks;
$$;

revoke all on function public.hpf_attendance_stats(text, int, text) from public;
grant execute on function public.hpf_attendance_stats(text, int, text) to authenticated;
revoke all on function public.hpf_term_range(int, text) from public;
grant execute on function public.hpf_term_range(int, text) to authenticated;

-- ---------------------------------------------------------------- 3) provenance columns
-- Three states, always distinguishable, never guessed:
--   'calculated' — derived from attendance_records by the trigger below
--   'manual'     — a typed value, with no daily marks behind it
--   NULL         — missing: nothing recorded and nothing typed
alter table public.school_returns add column if not exists attendance_source text;
alter table public.school_returns add column if not exists attendance_present int;
alter table public.school_returns add column if not exists attendance_expected int;
alter table public.school_returns add column if not exists attendance_excused int;
alter table public.school_returns add column if not exists attendance_learners int;
alter table public.school_returns add column if not exists attendance_computed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'school_returns_attendance_source_check') then
    alter table public.school_returns
      add constraint school_returns_attendance_source_check
      check (attendance_source is null or attendance_source in ('calculated', 'manual'));
  end if;
end $$;

-- Historical rows: a value already typed, with no daily marks behind it,
-- is exactly what 'manual' means. Nothing is removed or altered — only
-- labelled. Guarded so re-running never relabels a row the trigger has
-- since recalculated.
update public.school_returns
set attendance_source = 'manual'
where attendance_rate is not null and attendance_source is null;

-- ---------------------------------------------------------------- 4) derivation trigger
-- Where "prevent contradictory manual values" is actually enforced: when
-- real marks exist for a school's term, the calculated rate wins and the
-- typed number is discarded, so the two can never disagree on the same
-- row. When no marks exist, the typed value stands untouched — that is
-- the only case a manual figure is authoritative, and it is labelled as
-- such rather than being passed off as derived.
--
-- Deliberately NOT an override flag: a head cannot overrule a figure the
-- database can prove. Partial coverage (some classes marking daily,
-- others not) is surfaced by attendance_learners / attendance_expected
-- rather than being papered over with a typed guess — see ATTENDANCE.md.
create or replace function public.school_returns_derive_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
begin
  select * into s from public.hpf_attendance_stats(new.school, new.year, new.term);

  if s.expected_count > 0 then
    new.attendance_rate      := s.rate;
    new.attendance_source    := 'calculated';
    new.attendance_present   := s.present_count;
    new.attendance_expected  := s.expected_count;
    new.attendance_excused   := s.excused_count;
    new.attendance_learners  := s.learner_count;
    new.attendance_computed_at := now();
  else
    -- No marks for this school+term.
    --
    -- The subtle case, caught by test E4: marks that USED to exist have
    -- been deleted (a class removed, a mis-keyed day cleared). The row
    -- still carries the number this trigger last calculated. Relabelling
    -- that as 'manual' would invent a manual entry nobody ever typed, and
    -- leave a stale figure looking authoritative. So a previously-
    -- calculated value that the writer did not themselves change reverts
    -- to missing. A value the writer genuinely typed (different from what
    -- was stored) is a real manual entry and is kept as one.
    if tg_op = 'UPDATE'
       and old.attendance_source = 'calculated'
       and new.attendance_rate is not distinct from old.attendance_rate then
      new.attendance_rate := null;
    end if;
    new.attendance_source    := case when new.attendance_rate is null then null else 'manual' end;
    new.attendance_present   := null;
    new.attendance_expected  := null;
    new.attendance_excused   := null;
    new.attendance_learners  := null;
    new.attendance_computed_at := null;
  end if;

  return new;
end $$;

drop trigger if exists school_returns_derive_attendance on public.school_returns;
create trigger school_returns_derive_attendance
  before insert or update on public.school_returns
  for each row execute function public.school_returns_derive_attendance();

-- ---------------------------------------------------------------- 5) keep it fresh
-- Marks are usually entered AFTER the return is filed, so the stored
-- figure would go stale the moment a teacher marks another day. This
-- re-derives any affected return whenever marks change. The UPDATE fires
-- the trigger above, which recomputes from scratch — the stored value is
-- always a cache of the function, never an independent number.
create or replace function public.attendance_refresh_school_return()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id uuid := coalesce(new.class_id, old.class_id);
  v_date     date := coalesce(new.session_date, old.session_date);
  v_school   text;
begin
  select c.school into v_school from classes c where c.id = v_class_id;
  if v_school is null then return coalesce(new, old); end if;

  update public.school_returns sr
  set updated_at = sr.updated_at   -- no-op write; the BEFORE trigger recomputes
  where sr.school = v_school
    and v_date between (select start_date from public.hpf_term_range(sr.year, sr.term))
                   and (select end_date   from public.hpf_term_range(sr.year, sr.term));

  return coalesce(new, old);
end $$;

drop trigger if exists attendance_records_refresh_return on public.attendance_records;
create trigger attendance_records_refresh_return
  after insert or update or delete on public.attendance_records
  for each row execute function public.attendance_refresh_school_return();
