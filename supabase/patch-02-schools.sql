-- ============================================================
-- HPF Digital Portal — patch 02: schools table
-- Run once in the Supabase SQL editor, after patch-01-security.sql:
--   Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.
--
-- The satellite map used to read school names and GPS from the
-- SCHOOL_COORDS constant in data.js, so correcting a coordinate meant
-- editing and redeploying the site. This gives schools a real home:
-- admins manage the list, everyone signed in can read it.
--
-- `story` lives here too. It was keyed by school *name* in localStorage,
-- which meant renaming a school orphaned its story; a foreign key on the
-- row id makes that class of bug impossible.
-- ============================================================

create table if not exists schools (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  county     text,
  lat        double precision,
  lng        double precision,
  story      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Names are the human identifier the app dedupes on, and the client already
-- rejects duplicates case-insensitively — enforce the same rule in Postgres so
-- a second admin racing the first cannot slip one through.
create unique index if not exists schools_name_lower_idx on schools (lower(name));

-- ---------- keep updated_at honest ----------
create or replace function touch_updated_at() returns trigger
  language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists schools_touch_updated_at on schools;
create trigger schools_touch_updated_at
  before update on schools
  for each row execute function touch_updated_at();

-- ---------- row-level security ----------
-- Read is open to any signed-in user: teachers, field officers and school
-- leaders all need the school list for filters and dropdowns. Writes are
-- admin-only, matching the "Manage schools" control in the admin dashboard.
alter table schools enable row level security;

drop policy if exists "schools read"  on schools;
drop policy if exists "schools write" on schools;

create policy "schools read" on schools for select to authenticated
  using (true);

create policy "schools write" on schools for all to authenticated
  using (is_admin()) with check (is_admin());

-- ---------- seed from the old SCHOOL_COORDS constant ----------
-- Mirrors data.js at the time of writing. `on conflict do nothing` keeps this
-- re-runnable and will not clobber coordinates an admin has since corrected.
insert into schools (name, county, lat, lng) values
  ('Meru Primary School',       'Meru',     0.0463, 37.6559),
  ('Kithoka Primary School',    'Meru',     0.1018, 37.6472),
  ('Nkubu Primary School',      'Meru',    -0.0619, 37.6650),
  ('Isiolo Central Primary',    'Isiolo',   0.3546, 37.5822),
  ('Garbatulla Primary School', 'Isiolo',   0.5300, 38.5200),
  ('Kinna Primary School',      'Isiolo',   0.5833, 38.3167),
  ('Nanyuki Primary School',    'Laikipia', 0.0100, 37.0731),
  ('Rumuruti Primary School',   'Laikipia', 0.2725, 36.5372),
  ('Doldol Primary School',     'Laikipia', 0.3833, 37.1500),
  ('Aitong School',             'Narok',   -1.1667, 35.2500),
  ('Naboisho School',           'Narok',   -1.3167, 35.3167),
  ('Ololomei School',           'Narok',   -1.2500, 35.2000),
  ('Olkimitare School',         'Narok',   -1.4000, 35.1500)
on conflict do nothing;
