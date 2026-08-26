-- ============================================================
-- patch-21 — close the "authoritative data living only in
-- localStorage" gaps found by the storage audit.
--
-- Three things were authoritative-but-browser-local, meaning the
-- data existed only in whichever browser created it and no other
-- device or user could ever see it:
--
--   1. hpf_login_events  — learner/legacy logins. Postgres already had
--      login_events, but its insert policy is `to authenticated`, and a
--      learner has no Supabase account (no email → no JWT), so their
--      logins had nowhere to go. The admin's "Logins this week" chart
--      was therefore counting only the logins that happened in the
--      admin's own browser.
--   2. hpf_library       — the Digital Library catalogue. digital_learning
--      already existed but was unwired, so the panel wrote to
--      localStorage only.
--   3. hpf_activities    — admin-added scorecard activities, which are
--      averaged into an org-wide pillar score. Two admins on two devices
--      saw two different "org-wide" numbers.
--
-- Safe to re-run.
-- ============================================================

-- ---------------------------------------------------------------- 1) login events
-- Where the row came from, so an admin can tell a real Supabase sign-in
-- from a local learner one rather than the two being silently merged.
alter table public.login_events add column if not exists source text not null default 'supabase';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'login_events_source_check') then
    alter table public.login_events
      add constraint login_events_source_check check (source in ('supabase', 'local'));
  end if;
end $$;

create index if not exists login_events_created_at_idx on public.login_events (created_at desc);

-- A learner has no JWT, so they cannot satisfy the `to authenticated`
-- insert policy and cannot be granted one — RLS is JWT-based and there is
-- no identity to scope. This SECURITY DEFINER function is the deliberate,
-- narrow exception: anon may append ONE audit row, and the function
-- decides every security-relevant field itself rather than trusting its
-- caller.
--
-- What an anonymous caller cannot do through it: choose a role (hardcoded
-- 'learner', so this can never fabricate an admin sign-in), set source
-- (hardcoded 'local'), write an unbounded string (every input truncated),
-- or read anything back (returns void; login_events SELECT stays
-- is_staff()-only). Worst case is audit-log noise from someone hitting the
-- endpoint directly, bounded by Supabase's own request rate limits — the
-- same exposure the unauthenticated login form already has.
--
-- The database linter reports this as
-- `anon_security_definer_function_executable` (WARN). That is expected and
-- is the point of the function, not an oversight: being callable without a
-- session is the only way a learner's sign-in can be recorded at all. Every
-- other helper in this schema (is_admin, is_staff, log_audit, owns_class, …)
-- carries the same warning for the same structural reason.
create or replace function public.record_local_login(
  p_type       text,
  p_name       text,
  p_identifier text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_type not in ('login', 'signup') then
    raise exception 'record_local_login: type must be login or signup';
  end if;

  insert into public.login_events (type, name, identifier, role, source)
  values (
    p_type,
    left(coalesce(p_name, ''), 120),
    left(coalesce(p_identifier, ''), 120),
    'learner'::user_role,
    'local'
  );
end $$;

revoke all on function public.record_local_login(text, text, text) from public;
grant execute on function public.record_local_login(text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------- 2) digital library
-- The panel supports small file uploads held as data: URLs. They go in
-- `url` (a data: URL is still a URL) with the original filename kept
-- alongside it, so the catalogue needs no second storage system.
alter table public.digital_learning add column if not exists file_name text;

-- digital_learning predates the updated_at convention (patch-17 skipped it
-- because nothing edited these rows). The library panel edits them now.
alter table public.digital_learning add column if not exists updated_at timestamptz not null default now();
drop trigger if exists digital_learning_touch_updated_at on public.digital_learning;
create trigger digital_learning_touch_updated_at
  before update on public.digital_learning
  for each row execute function public.touch_updated_at();

create index if not exists digital_learning_published_idx on public.digital_learning (published);

-- The four resources data.js used to seed into each browser's localStorage on
-- first view. They are real HPF reference data, so they belong in the patch
-- sequence alongside patch-02's schools and patch-13's subjects — not
-- re-created per browser. Guarded on title (the table has no natural key), so
-- re-running this never duplicates them and never overwrites an edit.
insert into public.digital_learning (title, kind, category, description, url, published)
select v.title, v.kind, v.category, v.description, v.url, true
from (values
  ('HPF Teacher Training Manual', 'document', 'Teacher Training',
   'Comprehensive facilitator guide for HPF''s core teacher training programme.',
   'https://humanpracticefoundation.org/'),
  ('Foundational Literacy Pack', 'reading', 'Literacy',
   'Early-grade reading and phonics materials aligned to CBC.',
   'https://globaldigitallibrary.org/'),
  ('Numeracy Games & Activities', 'video', 'Numeracy',
   'Hands-on activities that make number sense stick.',
   'https://www.khanacademy.org/'),
  ('Intro to Digital Skills', 'video', 'ICT Skills',
   'Getting started with laptops, typing, and the internet — for the IT Academy.',
   'https://www.khanacademy.org/computing')
) as v(title, kind, category, description, url)
where not exists (select 1 from public.digital_learning d where d.title = v.title);

-- ---------------------------------------------------------------- 3) scorecard activities
-- me_indicators.pillar keeps its own coarse M&E vocabulary (shared with
-- field_visit_findings). The admin Scorecard has a different, finer set of
-- four programme pillars, and mapping one onto the other would be lossy —
-- 'ict' and 'general' are not the same claim. So the scorecard's pillar is
-- its own nullable column: set on indicators that belong to a scorecard
-- pillar, null on every other indicator.
alter table public.me_indicators add column if not exists scorecard_pillar text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'me_indicators_scorecard_pillar_check') then
    alter table public.me_indicators
      add constraint me_indicators_scorecard_pillar_check
      check (scorecard_pillar is null or scorecard_pillar in ('education', 'infrastructure', 'mep', 'ict'));
  end if;
end $$;

create index if not exists me_indicators_scorecard_pillar_idx
  on public.me_indicators (scorecard_pillar) where scorecard_pillar is not null;
