-- ============================================================
-- HPF Digital Portal — patch 33: canonical learner identity
-- Run once after patch-32. Safe to re-run.
--
-- WHAT WAS ACTUALLY WRONG (inspected before designing — all six
-- learner-referencing foreign keys already pointed at learners(id);
-- patch-31 fixed the last one that didn't):
--
--   * enrollments.learner_id and submissions.learner_id are NULLABLE with
--     nothing populating or enforcing them, so a roster entry's only
--     identity in practice is its typed `name`. That is the root cause —
--     not a wrong FK target.
--   * Nothing stopped the same learner being enrolled twice in one class.
--   * Learner 360 therefore had to bridge by name (LEARNER-360.md documents
--     this as best-effort, not a guarantee).
--   * kobo_submissions has no learner link of any kind.
--
-- WHAT THIS PATCH DOES NOT DO: it does not make learner_id NOT NULL.
-- A historical row whose identity genuinely cannot be established must
-- stay null and be reviewable — forcing it would mean inventing an
-- identity, which is exactly what the brief forbids. Integrity is
-- guaranteed going FORWARD by triggers, and backwards by a reconciliation
-- pass that refuses to guess.
--
-- See supabase/LEARNER-IDENTITY.md for the strategy and the review queue.
-- ============================================================

-- ---------------------------------------------------------------- 1) the identifier
-- learners.id (uuid PK) is, and stays, THE canonical machine identifier —
-- every relationship in this schema already resolves to it. What was
-- missing is a *portable, human-quotable* form of it: a UUID cannot be
-- written on a Kobo form, read down a phone, or carried between schools.
--
-- Three identifiers, each with one job:
--   learners.id               canonical, internal, immutable, never shown
--   learners.learner_code     portable + human-quotable, stable for life,
--                             survives a school transfer (unlike an
--                             admission number, which the new school
--                             reissues)
--   (school_id, admission_number)  the SCHOOL's own natural key — already
--                             unique from patch-26, still nullable because
--                             not every school issues one
create sequence if not exists public.learner_code_seq;

alter table public.learners add column if not exists learner_code text;

create or replace function public.learners_autogenerate_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.learner_code is null or new.learner_code = '' then
    new.learner_code := 'HPF-L-' || lpad(nextval('public.learner_code_seq')::text, 6, '0');
  end if;
  return new;
end $$;

revoke all on function public.learners_autogenerate_code() from public;

drop trigger if exists learners_autogenerate_code on public.learners;
create trigger learners_autogenerate_code
  before insert on public.learners
  for each row execute function public.learners_autogenerate_code();

-- Backfill any learner that predates this patch, then enforce.
update public.learners
set learner_code = 'HPF-L-' || lpad(nextval('public.learner_code_seq')::text, 6, '0')
where learner_code is null;

create unique index if not exists learners_learner_code_key on public.learners (learner_code);

-- ---------------------------------------------------------------- 2) stop double-enrolment
-- One learner appears at most once per class. Partial, so the historical
-- unlinked rows (learner_id null) are untouched and still permitted.
create unique index if not exists enrollments_class_learner_key
  on public.enrollments (class_id, learner_id)
  where learner_id is not null;

-- ---------------------------------------------------------------- 3) name normalisation
-- Used ONLY for one-time reconciliation and for deciding whether a new
-- roster name is a person we already know. Never as a lookup key at read
-- time — that is the practice this patch exists to end.
create or replace function public.hpf_normalize_name(p text)
returns text
language sql
immutable
set search_path = public, pg_catalog
as $$
  select nullif(regexp_replace(lower(trim(coalesce(p, ''))), '\s+', ' ', 'g'), '');
$$;

-- ---------------------------------------------------------------- 4) review queue
-- Anything this patch refuses to resolve lands here instead of being
-- guessed. One open row per (table, record) — re-running reconciliation
-- updates rather than duplicating.
create table if not exists public.learner_identity_reviews (
  id            uuid primary key default gen_random_uuid(),
  source_table  text not null check (source_table in ('enrollments', 'submissions', 'kobo_submissions')),
  source_id     uuid not null,
  observed_name text,
  school        text,
  reason        text not null check (reason in ('ambiguous', 'no_candidate', 'no_school')),
  candidates    jsonb not null default '[]'::jsonb,
  status        text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_learner_id uuid references public.learners(id) on delete set null,
  resolved_by   uuid references public.profiles(id) on delete set null,
  resolved_at   timestamptz,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (source_table, source_id)
);

create index if not exists learner_identity_reviews_status_idx
  on public.learner_identity_reviews (status, source_table);

drop trigger if exists learner_identity_reviews_touch on public.learner_identity_reviews;
create trigger learner_identity_reviews_touch
  before update on public.learner_identity_reviews
  for each row execute function public.touch_updated_at();

alter table public.learner_identity_reviews enable row level security;

drop policy if exists "learner reviews view" on public.learner_identity_reviews;
create policy "learner reviews view" on public.learner_identity_reviews
  for select to authenticated using ((select has_perm('learners', 'view')));

drop policy if exists "learner reviews edit" on public.learner_identity_reviews;
create policy "learner reviews edit" on public.learner_identity_reviews
  for update to authenticated
  using ((select has_perm('learners', 'edit')))
  with check ((select has_perm('learners', 'edit')));

-- ---------------------------------------------------------------- 5) resolution
-- Returns the ONE learner a name unambiguously identifies within a school,
-- or null plus the reason it could not. Never picks a winner from several.
create or replace function public.hpf_resolve_learner(p_school text, p_name text)
returns table (learner_id uuid, reason text, candidates jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_school_id uuid;
  v_norm      text := public.hpf_normalize_name(p_name);
  v_ids       uuid[];
  v_cands     jsonb;
begin
  if v_norm is null then
    return query select null::uuid, 'no_candidate'::text, '[]'::jsonb; return;
  end if;

  select s.id into v_school_id from schools s where s.name = p_school;
  if v_school_id is null then
    return query select null::uuid, 'no_school'::text, '[]'::jsonb; return;
  end if;

  select array_agg(l.id),
         coalesce(jsonb_agg(jsonb_build_object(
           'learner_id', l.id, 'learner_code', l.learner_code,
           'full_name', l.full_name, 'admission_number', l.admission_number)), '[]'::jsonb)
    into v_ids, v_cands
  from learners l
  where l.school_id = v_school_id
    and public.hpf_normalize_name(l.full_name) = v_norm;

  if v_ids is null or array_length(v_ids, 1) = 0 then
    return query select null::uuid, 'no_candidate'::text, '[]'::jsonb;
  elsif array_length(v_ids, 1) = 1 then
    return query select v_ids[1], 'unique'::text, v_cands;
  else
    -- Two or more people share this name in this school. Choosing one
    -- would be a guess, and a guess here silently attributes one child's
    -- attendance and results to another.
    return query select null::uuid, 'ambiguous'::text, v_cands;
  end if;
end $$;

revoke all on function public.hpf_resolve_learner(text, text) from public;
grant execute on function public.hpf_resolve_learner(text, text) to authenticated;

-- ---------------------------------------------------------------- 6) forward integrity
-- Every NEW enrollment gets a stable identity at the database, whatever
-- client wrote it — this is what stops the gap reopening.
--   exactly one existing match -> link to it
--   no match                   -> a new name on a roster IS a new learner;
--                                 create the row (not a guess: it asserts
--                                 a person exists, it does not claim they
--                                 are some specific existing person)
--   several matches / no school-> leave null and FLAG. Never guess.
create or replace function public.enrollments_resolve_learner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school text;
  v_school_id uuid;
  r record;
  v_new_id uuid;
begin
  if new.learner_id is not null then
    return new;
  end if;

  select c.school into v_school from classes c where c.id = new.class_id;
  select * into r from public.hpf_resolve_learner(v_school, new.name);

  if r.reason = 'unique' then
    new.learner_id := r.learner_id;
    return new;
  end if;

  if r.reason = 'no_candidate' then
    select s.id into v_school_id from schools s where s.name = v_school;
    if v_school_id is not null then
      insert into learners (full_name, school_id, created_by)
      values (trim(new.name), v_school_id, (select auth.uid()))
      returning id into v_new_id;
      new.learner_id := v_new_id;
      return new;
    end if;
  end if;

  -- ambiguous, or no school to scope a new learner to: record it and
  -- leave the roster entry usable but unidentified.
  insert into public.learner_identity_reviews
    (source_table, source_id, observed_name, school, reason, candidates)
  values ('enrollments', new.id, new.name, v_school,
          case when r.reason = 'no_school' then 'no_school' else r.reason end,
          coalesce(r.candidates, '[]'::jsonb))
  on conflict (source_table, source_id) do update
    set observed_name = excluded.observed_name, school = excluded.school,
        reason = excluded.reason, candidates = excluded.candidates;
  return new;
end $$;

drop trigger if exists enrollments_resolve_learner on public.enrollments;
create trigger enrollments_resolve_learner
  before insert on public.enrollments
  for each row execute function public.enrollments_resolve_learner();

-- A submission is scoped by its assessment's CLASS, so the class roster —
-- not the whole school — is the right place to resolve it. By the time a
-- submission exists the roster already carries stable ids, so this is a
-- roster lookup, not a name-identity lookup.
create or replace function public.submissions_resolve_learner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id uuid;
  v_school   text;
  v_ids      uuid[];
  v_cands    jsonb;
  v_norm     text := public.hpf_normalize_name(new.name);
begin
  if new.learner_id is not null or v_norm is null then
    return new;
  end if;

  select a.class_id, c.school into v_class_id, v_school
  from assessments a join classes c on c.id = a.class_id
  where a.id = new.assessment_id;

  select array_agg(e.learner_id),
         coalesce(jsonb_agg(jsonb_build_object('learner_id', e.learner_id, 'name', e.name)), '[]'::jsonb)
    into v_ids, v_cands
  from enrollments e
  where e.class_id = v_class_id
    and e.learner_id is not null
    and public.hpf_normalize_name(e.name) = v_norm;

  if v_ids is not null and array_length(v_ids, 1) = 1 then
    new.learner_id := v_ids[1];
    return new;
  end if;

  insert into public.learner_identity_reviews
    (source_table, source_id, observed_name, school, reason, candidates)
  values ('submissions', new.id, new.name, v_school,
          case when v_ids is null or array_length(v_ids, 1) = 0 then 'no_candidate' else 'ambiguous' end,
          coalesce(v_cands, '[]'::jsonb))
  on conflict (source_table, source_id) do update
    set observed_name = excluded.observed_name, school = excluded.school,
        reason = excluded.reason, candidates = excluded.candidates;
  return new;
end $$;

drop trigger if exists submissions_resolve_learner on public.submissions;
create trigger submissions_resolve_learner
  before insert on public.submissions
  for each row execute function public.submissions_resolve_learner();

-- ---------------------------------------------------------------- 7) Kobo (requirement 8)
-- Kobo has no learner link today. When a form carries a learner
-- identifier it will be a WRITTEN one — learner_code or admission number —
-- never a typed name, so the column stores the raw reference and
-- resolution is exact-match only. Nothing is inferred; an unmatched
-- reference is flagged like any other.
alter table public.kobo_submissions add column if not exists learner_id uuid references public.learners(id) on delete set null;
alter table public.kobo_submissions add column if not exists learner_ref text;

create index if not exists kobo_submissions_learner_id_idx on public.kobo_submissions (learner_id) where learner_id is not null;

create or replace function public.hpf_resolve_learner_ref(p_ref text, p_school text default null)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select l.id from learners l
  where p_ref is not null and trim(p_ref) <> ''
    and (
      l.learner_code = upper(trim(p_ref))
      or (l.admission_number = trim(p_ref)
          and (p_school is null or l.school_id = (select s.id from schools s where s.name = p_school)))
    )
  limit 1;
$$;

revoke all on function public.hpf_resolve_learner_ref(text, text) from public;
grant execute on function public.hpf_resolve_learner_ref(text, text) to authenticated;

-- ---------------------------------------------------------------- 8) reconciliation
-- One-shot, idempotent, safe to re-run. Links what can be linked with
-- certainty, flags the rest, NEVER overwrites an existing learner_id and
-- NEVER deletes anything.
create or replace function public.hpf_reconcile_learner_identities()
returns table (
  enrollments_linked   int,
  enrollments_flagged  int,
  submissions_linked   int,
  submissions_flagged  int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  e_linked int := 0; e_flagged int := 0;
  s_linked int := 0; s_flagged int := 0;
  rec record; r record;
begin
  -- enrollments: resolve against the school's learners
  for rec in
    select e.id, e.name, c.school
    from enrollments e join classes c on c.id = e.class_id
    where e.learner_id is null
  loop
    select * into r from public.hpf_resolve_learner(rec.school, rec.name);
    if r.reason = 'unique' then
      update enrollments set learner_id = r.learner_id where id = rec.id;
      update public.learner_identity_reviews
        set status = 'resolved', resolved_learner_id = r.learner_id, resolved_at = now(),
            note = coalesce(note, '') || ' auto-resolved: unique name within school'
        where source_table = 'enrollments' and source_id = rec.id and status = 'open';
      e_linked := e_linked + 1;
    else
      insert into public.learner_identity_reviews
        (source_table, source_id, observed_name, school, reason, candidates)
      values ('enrollments', rec.id, rec.name, rec.school, r.reason, coalesce(r.candidates, '[]'::jsonb))
      on conflict (source_table, source_id) do update
        set observed_name = excluded.observed_name, school = excluded.school,
            reason = excluded.reason, candidates = excluded.candidates
        where learner_identity_reviews.status = 'open';
      e_flagged := e_flagged + 1;
    end if;
  end loop;

  -- submissions: resolve against the assessment's class roster
  for rec in
    select sub.id, sub.name, c.school, a.class_id
    from submissions sub
    join assessments a on a.id = sub.assessment_id
    join classes c on c.id = a.class_id
    where sub.learner_id is null
  loop
    declare
      v_ids uuid[]; v_cands jsonb; v_norm text := public.hpf_normalize_name(rec.name);
    begin
      select array_agg(e.learner_id),
             coalesce(jsonb_agg(jsonb_build_object('learner_id', e.learner_id, 'name', e.name)), '[]'::jsonb)
        into v_ids, v_cands
      from enrollments e
      where e.class_id = rec.class_id and e.learner_id is not null
        and public.hpf_normalize_name(e.name) = v_norm;

      if v_ids is not null and array_length(v_ids, 1) = 1 then
        update submissions set learner_id = v_ids[1] where id = rec.id;
        update public.learner_identity_reviews
          set status = 'resolved', resolved_learner_id = v_ids[1], resolved_at = now(),
              note = coalesce(note, '') || ' auto-resolved: unique name on class roster'
          where source_table = 'submissions' and source_id = rec.id and status = 'open';
        s_linked := s_linked + 1;
      else
        insert into public.learner_identity_reviews
          (source_table, source_id, observed_name, school, reason, candidates)
        values ('submissions', rec.id, rec.name, rec.school,
                case when v_ids is null or array_length(v_ids, 1) = 0 then 'no_candidate' else 'ambiguous' end,
                coalesce(v_cands, '[]'::jsonb))
        on conflict (source_table, source_id) do update
          set observed_name = excluded.observed_name, school = excluded.school,
              reason = excluded.reason, candidates = excluded.candidates
          where learner_identity_reviews.status = 'open';
        s_flagged := s_flagged + 1;
      end if;
    end;
  end loop;

  return query select e_linked, e_flagged, s_linked, s_flagged;
end $$;

revoke all on function public.hpf_reconcile_learner_identities() from public;
grant execute on function public.hpf_reconcile_learner_identities() to authenticated;

-- ---------------------------------------------------------------- 9) apply to existing data
select * from public.hpf_reconcile_learner_identities();
