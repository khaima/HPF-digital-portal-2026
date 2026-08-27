-- ============================================================
-- patch-26 — Master Data Management: the fields and constraints
-- the six MDM modules (Schools, Teachers, Learners, School
-- Leaders, Devices, Infrastructure) actually need.
--
-- Every table already had a permanent UUID primary key
-- (gen_random_uuid()) — that part of the brief was already true
-- everywhere and needed no change.
--
-- What this patch adds, and why:
--
--   schools            — code, sub_county, location, programme_status,
--                         contact info, active/inactive.
--   profiles           — school_id (a REAL foreign key, additive)
--                         and active, for Teachers/School Leaders/
--                         Field Officers.
--   learners           — grade and active.
--   devices            — a real uniqueness constraint on serial_number.
--
-- `school_facilities` (the Infrastructure module) needs no schema
-- change: it is already one row per school (PRIMARY KEY (school_id)),
-- which is exactly the "no duplicates, ever" guarantee a dedicated
-- infrastructure table would otherwise have to enforce by hand.
--
-- Why school_id on profiles, alongside the existing free-text
-- `school` column rather than replacing it: `profiles.school` is
-- matched by NAME in roughly a dozen existing RLS policies (see
-- SCHEMA.md's own note on this) — a school leader's, teacher's, or
-- field officer's scoping to "their school" runs through that text
-- match today. Rewriting every one of those policies to a FK join
-- is a real change with real regression risk for a system already
-- in production use, and the brief for this pass is master data
-- management, not an RLS rewrite. `school_id` is purely additive: a
-- second, reliable way to relate a person to a school for the MDM
-- module and any future feature, while every existing policy keeps
-- working exactly as it does today, unchanged.
--
-- Safe to re-run.
-- ============================================================

-- ---------------------------------------------------------------- schools
alter table public.schools add column if not exists code text;
alter table public.schools add column if not exists sub_county text;
alter table public.schools add column if not exists location text;
alter table public.schools add column if not exists programme_status text not null default 'active';
alter table public.schools add column if not exists contact_name text;
alter table public.schools add column if not exists contact_phone text;
alter table public.schools add column if not exists contact_email text;
alter table public.schools add column if not exists active boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'schools_programme_status_check') then
    alter table public.schools add constraint schools_programme_status_check
      check (programme_status in ('prospective', 'active', 'paused', 'graduated', 'closed'));
  end if;
end $$;

-- Backfill a real code for every school that doesn't have one, before the
-- column is made required — a three-letter county prefix plus a per-county
-- sequence number (HPF has never had more than a few schools per county, so
-- three digits is headroom, not a guess). Re-running this is a no-op:
-- `where code is null` means an already-coded school is never touched.
with numbered as (
  select id, upper(left(coalesce(county, 'GEN'), 3)) as prefix,
    row_number() over (partition by county order by created_at, name) as n
  from public.schools
  where code is null
)
update public.schools s
set code = numbered.prefix || '-' || lpad(numbered.n::text, 3, '0')
from numbered
where s.id = numbered.id;

alter table public.schools alter column code set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'schools_code_key') then
    alter table public.schools add constraint schools_code_key unique (code);
  end if;
end $$;

create index if not exists schools_active_idx on public.schools (active);
create index if not exists schools_sub_county_idx on public.schools (sub_county);
create index if not exists schools_programme_status_idx on public.schools (programme_status);

-- ---------------------------------------------------------------- profiles
alter table public.profiles add column if not exists school_id uuid references public.schools(id) on delete set null;
alter table public.profiles add column if not exists active boolean not null default true;

-- Best-effort one-time backfill by matching the existing free-text school
-- name — exact match only, deliberately: a fuzzy match here could silently
-- link someone to the wrong school with no way to tell later. Anyone left
-- unmatched (a typo'd or since-renamed school name) keeps school_id null;
-- the MDM screen surfaces that as "no school linked" rather than guessing.
update public.profiles p
set school_id = s.id
from public.schools s
where p.school_id is null and p.school is not null and s.name = p.school;

create index if not exists profiles_school_id_idx on public.profiles (school_id);
create index if not exists profiles_active_idx on public.profiles (active);

-- `active` here is an MDM roster flag only — archived vs current — not an
-- access-control signal. It does not gate sign-in, RLS, or role checks
-- anywhere; a person keeps using the portal exactly as before regardless
-- of this value. It exists so a school leaver's, teacher's, or officer's
-- record can be retired from the roster without deleting their account or
-- history, per "do not permanently delete... unless explicitly authorized."

-- ---------------------------------------------------------------- learners
alter table public.learners add column if not exists grade text;
alter table public.learners add column if not exists active boolean not null default true;

create index if not exists learners_grade_idx on public.learners (grade);
create index if not exists learners_active_idx on public.learners (active);

-- One admission number per school, not globally — two different schools
-- both legitimately using "001" is normal; the same school issuing it
-- twice is the actual error this catches.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'learners_school_admission_key') then
    alter table public.learners add constraint learners_school_admission_key
      unique (school_id, admission_number);
  end if;
end $$;

-- ---------------------------------------------------------------- teachers
-- TSC number is a real national identifier for a Kenyan teacher — a
-- genuine natural key, not a fuzzy-match guess, unlike a person's name.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'teachers_tsc_number_key') then
    alter table public.teachers add constraint teachers_tsc_number_key unique (tsc_number);
  end if;
end $$;

-- ---------------------------------------------------------------- devices
-- A serial number is manufacturer-assigned and genuinely unique when
-- present; asset_tag (HPF's own inventory label) gets the same treatment
-- for the same reason. Both nullable — not every device in the field has
-- had either recorded — so the constraint only fires when there is
-- something to actually compare.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'devices_serial_number_key') then
    alter table public.devices add constraint devices_serial_number_key unique (serial_number);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_asset_tag_key') then
    alter table public.devices add constraint devices_asset_tag_key unique (asset_tag);
  end if;
end $$;
