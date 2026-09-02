-- patch-36-field-report-me-link.sql
-- Lets a field visit record a real M&E measurement inline: "New field
-- report" gains an optional indicator + value, chosen from the actual
-- M&E data model instead of a disconnected text field. See
-- FIELD-REPORT-FORMS.md for the full design and the cascading-form UI it
-- feeds (app.js).
--
-- Safe to re-run.

-- ---------------------------------------------------------------- columns
-- Nullable and independent of everything field_reports already does: a
-- report with no indicator picked (visit types with nothing set up yet in
-- M&E, or an officer who just doesn't have a reading) behaves exactly as
-- before. Riding inside field_reports, not a second table, means the
-- already-tested offline outbox, client_id idempotency and audit trigger
-- (patch-35) cover this write for free.
alter table field_reports
  add column if not exists me_indicator_id uuid references me_indicators(id) on delete set null,
  add column if not exists me_value numeric;

comment on column field_reports.me_indicator_id is
  'Optional: the M&E indicator (me_indicators) this visit recorded a measurement for. Set together with me_value.';
comment on column field_reports.me_value is
  'Optional: the value recorded for me_indicator_id during this visit.';

-- ---------------------------------------------------------------- derivation trigger
-- field_officer holds has_perm('me','view') and has_perm('me','export') but
-- NOT has_perm('me','create') — by design, an officer may read indicators to
-- pick one on the form but may not write me_indicator_values directly. This
-- function does that one write on their behalf, SECURITY DEFINER, strictly
-- scoped to the row field_reports' own RLS just accepted as that officer's
-- genuine, assigned-school visit — the same pattern patch-32's attendance
-- derivation and patch-34's notification producers already use.
create or replace function derive_me_indicator_value()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school_id uuid;
  v_year int;
  v_term text;
begin
  if new.me_indicator_id is null or new.me_value is null then
    return new;
  end if;

  -- field_reports.school is a free-text name (school_officer_assignments has
  -- no FK to schools), so the link is by name. No match (a typo, or an
  -- admin's free-text entry that isn't a real school row) means there is
  -- nothing safe to attach the measurement to — the field report itself is
  -- already saved either way; only the M&E linkage is skipped.
  select id into v_school_id from schools where name = new.school limit 1;
  if v_school_id is null then
    return new;
  end if;

  -- Same term boundaries as hpf_term_range() (patch-32), inverted: which
  -- term a given date falls in rather than a term's date range.
  v_year := extract(year from coalesce(new.created_at, now()))::int;
  v_term := case
    when extract(month from coalesce(new.created_at, now())) between 1 and 4 then 'Term 1'
    when extract(month from coalesce(new.created_at, now())) between 5 and 8 then 'Term 2'
    else 'Term 3'
  end;

  -- One value per indicator per school per period, matching the table's own
  -- unique constraint and the "latest reading for the period wins"
  -- convention the M&E module's own recordActivityScore() already uses
  -- (dashboards.js) — a second visit in the same term updates the reading
  -- rather than adding a silent duplicate.
  insert into me_indicator_values (indicator_id, school_id, period_year, period_term, value, source, recorded_by)
  values (new.me_indicator_id, v_school_id, v_year, v_term, new.me_value, 'manual', new.user_id)
  on conflict (indicator_id, school_id, period_year, period_term)
  do update set value = excluded.value, recorded_by = excluded.recorded_by, updated_at = now();

  return new;
end;
$$;

-- A trigger function is invoked by the trigger machinery, never called
-- directly over the API — revoke the direct-call grants PostgREST's default
-- exposure would otherwise leave in place (the same defect patch-34 found
-- and closed for hpf_notify).
revoke all on function derive_me_indicator_value() from public, anon, authenticated;

drop trigger if exists trg_derive_me_indicator_value on field_reports;
create trigger trg_derive_me_indicator_value
  after insert on field_reports
  for each row execute function derive_me_indicator_value();
