-- ============================================================
-- HPF Digital Portal — patch 17: updated_at on every mutable entity
-- Run once in the Supabase SQL editor, after patch-16. Safe to re-run.
--
-- schools, school_returns, and school_facilities already carry updated_at
-- plus touch_updated_at() (patch-02) to keep it honest. Every other mutable
-- table predates that pattern and only ever got created_at. Purely additive:
-- a new column with a default, plus a trigger — nothing existing changes
-- shape, and no existing query breaks.
--
-- Scoped to tables that are actually EDITED after creation. Append-only
-- event logs (login_events, audit_logs, kolibri_activity, library_activity,
-- learning_activity, notifications) are deliberately left out — nothing
-- ever updates those rows, so a second timestamp would just sit there
-- always equal to created_at and mean nothing.
--
-- interventions never had created_at either (only opened_at/closed_at,
-- which mean something different — when the case was opened/closed, not
-- when the row last changed) — added here too, since "every major entity
-- must have created_at and updated_at" doesn't carve out an exception for
-- the one table that happened to skip both.
-- ============================================================

alter table public.interventions add column if not exists created_at timestamptz not null default now();

alter table public.profiles          add column if not exists updated_at timestamptz not null default now();
alter table public.teachers          add column if not exists updated_at timestamptz not null default now();
alter table public.field_officers    add column if not exists updated_at timestamptz not null default now();
alter table public.teacher_training  add column if not exists updated_at timestamptz not null default now();
alter table public.school_programmes add column if not exists updated_at timestamptz not null default now();
alter table public.learners          add column if not exists updated_at timestamptz not null default now();
alter table public.devices           add column if not exists updated_at timestamptz not null default now();
alter table public.field_visits      add column if not exists updated_at timestamptz not null default now();
alter table public.assessments       add column if not exists updated_at timestamptz not null default now();
alter table public.assignments       add column if not exists updated_at timestamptz not null default now();
alter table public.interventions     add column if not exists updated_at timestamptz not null default now();
alter table public.action_items      add column if not exists updated_at timestamptz not null default now();

drop trigger if exists profiles_touch_updated_at          on public.profiles;
drop trigger if exists teachers_touch_updated_at          on public.teachers;
drop trigger if exists field_officers_touch_updated_at    on public.field_officers;
drop trigger if exists teacher_training_touch_updated_at  on public.teacher_training;
drop trigger if exists school_programmes_touch_updated_at on public.school_programmes;
drop trigger if exists learners_touch_updated_at          on public.learners;
drop trigger if exists devices_touch_updated_at           on public.devices;
drop trigger if exists field_visits_touch_updated_at      on public.field_visits;
drop trigger if exists assessments_touch_updated_at       on public.assessments;
drop trigger if exists assignments_touch_updated_at       on public.assignments;
drop trigger if exists interventions_touch_updated_at     on public.interventions;
drop trigger if exists action_items_touch_updated_at      on public.action_items;

create trigger profiles_touch_updated_at          before update on public.profiles          for each row execute function touch_updated_at();
create trigger teachers_touch_updated_at          before update on public.teachers          for each row execute function touch_updated_at();
create trigger field_officers_touch_updated_at    before update on public.field_officers    for each row execute function touch_updated_at();
create trigger teacher_training_touch_updated_at  before update on public.teacher_training  for each row execute function touch_updated_at();
create trigger school_programmes_touch_updated_at before update on public.school_programmes for each row execute function touch_updated_at();
create trigger learners_touch_updated_at          before update on public.learners          for each row execute function touch_updated_at();
create trigger devices_touch_updated_at           before update on public.devices           for each row execute function touch_updated_at();
create trigger field_visits_touch_updated_at      before update on public.field_visits      for each row execute function touch_updated_at();
create trigger assessments_touch_updated_at       before update on public.assessments       for each row execute function touch_updated_at();
create trigger assignments_touch_updated_at       before update on public.assignments       for each row execute function touch_updated_at();
create trigger interventions_touch_updated_at     before update on public.interventions     for each row execute function touch_updated_at();
create trigger action_items_touch_updated_at      before update on public.action_items      for each row execute function touch_updated_at();
