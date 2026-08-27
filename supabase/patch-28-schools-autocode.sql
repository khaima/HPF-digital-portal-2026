-- ============================================================
-- patch-28 — auto-generate a school code when one isn't supplied.
--
-- A real regression, found and confirmed live: patch-26 made
-- `schools.code` NOT NULL + UNIQUE. Master Data Management's own
-- "New school" form was updated to collect one — but the *older*
-- "Add school" form on the admin Schools map (schoolMapPanel,
-- predates Master Data Management) inserts {name, county, lat, lng}
-- with no code field at all. Every insert through that form has been
-- failing outright since patch-26 shipped.
--
-- Rather than patch that one call site (and trust every other insert
-- path, present or future, to remember), the database now generates a
-- code itself whenever one isn't provided — the same scheme
-- patch-26's one-time backfill used (county prefix + a per-county
-- sequence number), so codes stay consistent whichever path created
-- the row. A caller that DOES supply a code (Master Data Management's
-- own form) is left alone.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.schools_autogenerate_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix text;
  next_n int;
begin
  if new.code is not null and new.code <> '' then
    return new;
  end if;

  prefix := upper(left(coalesce(new.county, 'GEN'), 3));
  select coalesce(max((regexp_match(code, '-(\d+)$'))[1]::int), 0) + 1
    into next_n
    from public.schools
    where code like prefix || '-%';

  new.code := prefix || '-' || lpad(next_n::text, 3, '0');
  return new;
end $$;

revoke all on function public.schools_autogenerate_code() from public;

drop trigger if exists schools_autogenerate_code on public.schools;
create trigger schools_autogenerate_code
  before insert on public.schools
  for each row execute function public.schools_autogenerate_code();
