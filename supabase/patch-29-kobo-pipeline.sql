-- ============================================================
-- patch-29 — a real Kobo-to-HPF ingestion pipeline.
--
-- REQUIRES patch-22/23 (permission matrix + matrix-backed RLS) and
-- patch-13 (kobo_submissions itself, created bare as "a raw sink for a
-- future KoboToolbox webhook/edge function — none exists yet").
--
-- That future is now: a real ingestion service (Edge Function,
-- functions/kobo-sync) fetches from the Kobo API, validates, transforms,
-- deduplicates, and writes here. This patch reshapes the bare sink into
-- what that pipeline actually needs to retain per submission — Kobo
-- submission id, form id, source, submitted_at, received_at, a processing
-- status, a validation status, and a reference to the immutable raw
-- payload — plus a sync-run log the monitoring page reads for "last
-- successful/failed synchronization".
--
-- Two tables are genuinely new (kobo_raw_payloads, kobo_sync_runs);
-- kobo_submissions is altered in place rather than replaced, since it
-- already exists live with zero rows and zero client wiring (verified
-- before writing this) — nothing to migrate, nothing to break.
--
-- Authorization is UNCHANGED from patch-13/23 on purpose: kobo_submissions
-- was already scoped to has_perm('me','view') with no write policy for
-- `authenticated` at all ("only a service-role integration... is meant to
-- write here"). The two new tables get the identical shape — same module,
-- same read-only-via-RLS design — rather than inventing a separate
-- permission module for what is the same data at a different stage of the
-- same pipeline. Every write, on all three tables, is the Edge Function
-- using the project's secret key, which bypasses RLS entirely — nobody,
-- including Admin, can create/edit/delete a pipeline record through the
-- API. See KOBO-INTEGRATION.md.
--
-- Safe to re-run.
-- ============================================================

do $do$
begin
  if not exists (select 1 from pg_type where typname = 'kobo_processing_status') then
    create type kobo_processing_status as enum
      ('RECEIVED', 'VALIDATED', 'PROCESSED', 'DUPLICATE', 'REQUIRES_REVIEW', 'REJECTED');
  end if;
  if not exists (select 1 from pg_type where typname = 'kobo_validation_status') then
    create type kobo_validation_status as enum ('pending', 'passed', 'failed');
  end if;
end
$do$;

-- ---------------------------------------------------------------- raw payloads
-- Append-only, immutable, never updated after insert. Kept as a separate
-- table from kobo_submissions on purpose: the "what Kobo actually sent"
-- evidence must never be touched by anything the validate/transform/dedup
-- stages do to the processing row, the same separation of concerns
-- `evidence` and `audit_logs` already use elsewhere in this schema.
--
-- unique(form_id, kobo_submission_id) is the pipeline's real idempotency
-- gate: re-polling a time window that overlaps what was already fetched
-- hits this constraint and is skipped rather than reprocessed — that is
-- re-observing already-recorded data, not a new fact to discard or a
-- "duplicate" in the business sense (see kobo_submissions.duplicate_of_id
-- below for that case, which is a different Kobo submission id entirely).
create table if not exists public.kobo_raw_payloads (
  id                  uuid primary key default gen_random_uuid(),
  form_id             text not null,
  kobo_submission_id  text not null,
  payload             jsonb not null,
  received_at         timestamptz not null default now(),
  unique (form_id, kobo_submission_id)
);

create index if not exists kobo_raw_payloads_received_at_idx on public.kobo_raw_payloads (received_at desc);

alter table public.kobo_raw_payloads enable row level security;
drop policy if exists "kobo raw read" on public.kobo_raw_payloads;
create policy "kobo raw read" on public.kobo_raw_payloads
  for select to authenticated using ((select has_perm('me', 'view')));
-- No insert/update/delete policy for `authenticated` — the Edge Function
-- writes with the secret key, which bypasses RLS entirely. Nobody can
-- alter or erase raw evidence through the API, including Admin.

-- ---------------------------------------------------------------- kobo_submissions
-- Reshaping the bare patch-13 sink (id, form_id, kobo_submission_id unique,
-- school, submitted_at, payload, processed boolean, received_at) into the
-- real pipeline's processing row. `processed boolean` is dropped, not kept
-- alongside the new status column: it has zero rows and zero readers
-- anywhere in this codebase (verified — grep for "kobo" in dashboards.js
-- returns nothing), so carrying a second, cruder status forward would
-- just be two sources of truth for the same fact. `payload` moves off this
-- table onto kobo_raw_payloads, referenced by raw_payload_id — the "raw
-- payload reference" the pipeline is required to retain, not a second
-- copy of the JSON living on the mutable row.
alter table public.kobo_submissions drop column if exists processed;
alter table public.kobo_submissions drop column if exists payload;

alter table public.kobo_submissions
  add column if not exists source              text not null default 'kobo',
  add column if not exists processing_status    kobo_processing_status not null default 'RECEIVED',
  add column if not exists validation_status     kobo_validation_status not null default 'pending',
  add column if not exists validation_errors     jsonb not null default '[]'::jsonb,
  add column if not exists raw_payload_id        uuid references public.kobo_raw_payloads(id) on delete restrict,
  add column if not exists transformed_data      jsonb,
  add column if not exists content_hash          text,
  add column if not exists duplicate_of_id        uuid references public.kobo_submissions(id) on delete set null,
  add column if not exists processed_at          timestamptz,
  add column if not exists error_detail          text,
  add column if not exists updated_at            timestamptz not null default now();

-- `add column` above has to allow null so it can run against any
-- pre-existing row without a backfill; there are none live (verified —
-- kobo_submissions has 0 rows), so the real invariant is enforced
-- immediately below instead of leaving the column permanently nullable.
alter table public.kobo_submissions alter column raw_payload_id set not null;

do $do$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'kobo_submissions_raw_payload_id_key'
  ) then
    alter table public.kobo_submissions add constraint kobo_submissions_raw_payload_id_key unique (raw_payload_id);
  end if;
end
$do$;

create index if not exists kobo_submissions_processing_status_idx on public.kobo_submissions (processing_status);
create index if not exists kobo_submissions_form_id_idx           on public.kobo_submissions (form_id);
create index if not exists kobo_submissions_received_at_idx       on public.kobo_submissions (received_at desc);
create index if not exists kobo_submissions_content_hash_idx      on public.kobo_submissions (form_id, content_hash) where content_hash is not null;

drop trigger if exists kobo_submissions_touch_updated_at on public.kobo_submissions;
create trigger kobo_submissions_touch_updated_at
  before update on public.kobo_submissions
  for each row execute function touch_updated_at();

-- kobo_submissions' own RLS is untouched: patch-23 already set it to
-- has_perm('me','view') for select, nothing for insert/update/delete.
-- Re-asserting it here anyway, idempotently, so this file is a complete
-- statement of the table's authorization rather than relying on a reader
-- to already know patch-23 set it correctly.
drop policy if exists "kobo read" on public.kobo_submissions;
drop policy if exists "kobo_submissions view" on public.kobo_submissions;
create policy "kobo_submissions view" on public.kobo_submissions
  for select to authenticated using ((select has_perm('me', 'view')));

-- ---------------------------------------------------------------- sync runs
-- One row per ingestion attempt (the Edge Function invoked once, for one
-- or all configured forms) — what the monitoring page's "last successful
-- synchronization" / "last failed synchronization" read from. Written at
-- the start of a run (status='running') and updated at the end, so a run
-- that crashes mid-way still shows as the last *attempt* even if it never
-- reaches 'success' or 'failed' cleanly — visible as stuck rather than
-- silently vanishing.
create table if not exists public.kobo_sync_runs (
  id               uuid primary key default gen_random_uuid(),
  form_id          text,  -- null = a run that covered every configured form
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null default 'running' check (status in ('running', 'success', 'failed')),
  fetched_count    int not null default 0,
  processed_count  int not null default 0,
  duplicate_count  int not null default 0,
  review_count     int not null default 0,
  rejected_count   int not null default 0,
  error_detail     text
);

create index if not exists kobo_sync_runs_started_at_idx on public.kobo_sync_runs (started_at desc);
create index if not exists kobo_sync_runs_status_idx     on public.kobo_sync_runs (status, started_at desc);

alter table public.kobo_sync_runs enable row level security;
drop policy if exists "kobo sync runs read" on public.kobo_sync_runs;
create policy "kobo sync runs read" on public.kobo_sync_runs
  for select to authenticated using ((select has_perm('me', 'view')));
-- No insert/update/delete policy for `authenticated` — same as the other
-- two tables: only the Edge Function, via the secret key, writes here.
