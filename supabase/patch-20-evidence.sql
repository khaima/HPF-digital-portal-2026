-- ============================================================
-- HPF Digital Portal — patch 20: evidence
-- Run once in the Supabase SQL editor, after patch-19. Safe to re-run.
--
-- Generic supporting attachment (a photo from a field visit, a document
-- backing an intervention's outcome, a source file behind an indicator
-- value) — linked by ref_table/ref_id, the exact polymorphic-reference
-- pattern learning_activity already established in patch-13, not a new
-- convention invented for this table.
--
-- RLS is deliberately NOT ref-table-aware: resolving "can this viewer see
-- the thing this evidence is attached to" generically across an arbitrary
-- ref_table would need dynamic SQL inside the policy, which is real
-- complexity this schema-only pass (no client wiring yet, same as every
-- other patch-13-style table) doesn't have a concrete use case to justify.
-- Scoped instead to the plain, defensible rule every uploaded-content table
-- in this schema already uses: admin/staff see and manage everything, an
-- ordinary uploader manages their own upload, and read is open to any
-- signed-in user (nothing here is more sensitive than what schools/returns
-- already expose the same way). Revisit this once a real consumer exists
-- and the actual sensitivity of what gets attached is known.
-- ============================================================

create table if not exists evidence (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  file_url    text,
  ref_table   text,
  ref_id      uuid,
  uploaded_by uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists evidence_ref_idx ON evidence (ref_table, ref_id);
create index if not exists evidence_uploaded_by_idx ON evidence (uploaded_by);

drop trigger if exists evidence_touch_updated_at on evidence;
create trigger evidence_touch_updated_at
  before update on evidence
  for each row execute function touch_updated_at();

alter table evidence enable row level security;
drop policy if exists "evidence read"  on evidence;
drop policy if exists "evidence write" on evidence;
create policy "evidence read" on evidence for select to authenticated using (true);
create policy "evidence write" on evidence for all to authenticated
  using ((select is_staff()) or uploaded_by = (select auth.uid()))
  with check ((select is_staff()) or uploaded_by = (select auth.uid()));
