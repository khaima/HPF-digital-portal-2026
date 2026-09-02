-- ============================================================
-- HPF Digital Portal — patch 35: server support for offline-first sync
-- Run once after patch-34. Safe to re-run.
--
-- Two things the offline PWA needs that the server could not previously
-- provide. Both are additive; nothing existing changes shape.
--
-- 1. IDEMPOTENCY. A visit recorded offline is retried until it lands. If a
--    retry happens after the insert actually succeeded (response lost on a
--    flaky link — the normal failure mode in the field, not an edge case),
--    a second row would be created for one real visit. `client_id` is
--    generated on the device the moment the officer saves, travels with
--    the row, and is UNIQUE — so the retry collides instead of
--    duplicating, and the client can tell "already synced" apart from
--    "failed". This is what makes duplicate prevention a server
--    guarantee rather than a client hope.
--
-- 2. AUDIT. field_reports was never given patch-24's audit trigger, so a
--    synced visit left no audit_logs entry. Added here using the same
--    shared audit_row_change() every other audited table uses.
-- ============================================================

alter table public.field_reports add column if not exists client_id uuid;

create unique index if not exists field_reports_client_id_key
  on public.field_reports (client_id) where client_id is not null;

-- Lets a device ask "did my queued visit actually land?" without needing
-- to read the whole table. SELECT is already RLS-scoped (own rows, or
-- assigned school, or staff) so this exposes nothing new.
create index if not exists field_reports_user_created_idx
  on public.field_reports (user_id, created_at desc);

drop trigger if exists field_reports_audit on public.field_reports;
create trigger field_reports_audit
  after insert or update or delete on public.field_reports
  for each row execute function public.audit_row_change();
