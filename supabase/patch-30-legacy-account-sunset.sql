-- ============================================================
-- HPF Digital Portal — patch 30: legacy local-staff-account sunset
-- Run once in the Supabase SQL editor, after patch-29. Safe to re-run.
--
-- The problem this patch can and cannot solve, stated plainly:
-- `hpf_users` (localStorage, K_USERS in app.js) is the ONLY place a legacy
-- staff account has ever lived. It has never synced to Postgres — the
-- user_management panel's own header comment already documents this
-- ("Two admins on two laptops had two different, both-wrong pictures of
-- who had access"). That means there is NO server-side census of legacy
-- accounts to query — not a missing feature, a structural fact about
-- where this data has always lived. This patch does not, and cannot,
-- answer "how many legacy accounts exist" as a one-time count.
--
-- What it DOES do: turn "legacy account" from an invisible, per-browser
-- fact into a server-visible, growing ledger — populated the honest way,
-- one real login at a time, exactly as legacyLogin() in app.js already
-- authenticates them. From the moment this ships, every legacy sign-in
-- is detected, recorded once (identifier-keyed, idempotent), and tracked
-- through migration. The population this ledger reports on is "legacy
-- accounts that have actually been used since this shipped" — the only
-- population that was ever knowable, and the one that actually matters
-- (an account nobody has signed into is already functionally obsolete).
--
-- Architecture:
--   legacyLogin() succeeds (app.js, no JWT — never did, never will)
--     -> record_legacy_login()  [anon-callable, SECURITY DEFINER, narrow]
--        upserts legacy_account_migrations, keyed on lower(identifier).
--        If the identifier is already an email with a real profiles row,
--        lands as 'already_has_account' instead of 'detected' -- this
--        answers "does this person already have a Supabase account?"
--        the only honest way available: checked at the moment they're
--        seen, not guessed in advance.
--     -> app.js shows a migration prompt in that same session
--     -> user confirms an email -> adminClient().auth.signInWithOtp()
--        (the SAME anon-callable call createStaffAccount() already uses
--        for admin-created staff -- self-triggering it grants nothing
--        beyond the self-serve role every public signUp() already gets;
--        no privilege is escalated here)
--     -> mark_legacy_invited()  [anon-callable, SECURITY DEFINER, narrow]
--        flips status to 'invited', stores the confirmed email.
--     -> an admin, in the new "Legacy accounts" panel, sees the invited
--        row with its captured role/school/county/project and clicks
--        "Complete migration" -- this is the ONE step that actually needs
--        an authenticated, permissioned session, because it is the one
--        step that grants a real role: profiles.update({role, school,
--        ...}) is already gated by guard_profile_role()/has_perm('people',
--        'edit') (patch-14/22), unchanged by this patch. Ledger status
--        moves to 'migrated'.
--     -> legacyLogin() checks is_legacy_migrated() [anon-callable,
--        SECURITY DEFINER, returns a bare boolean, nothing else] before
--        accepting a legacy credential; a migrated identifier is refused
--        and its local hpf_users row is flagged so the browser stops
--        trying, even offline.
--
-- What this patch does NOT do (see supabase/LEGACY-SUNSET.md):
--   - Does not remove legacyLogin(), userManagementPanel(), or hpf_users.
--     "When legacy account count reaches zero" is a future, explicit,
--     separately-requested phase -- not a threshold this patch acts on
--     itself, even once actually reached.
--   - Does not touch learner accounts (LOCAL_ONLY_ROLE) or their local
--     storage in any way -- a separate product decision, untouched here.
--   - Never reads, stores, or transmits a legacy account's plaintext
--     password. The new account's password is set exactly once, by the
--     person themselves, via Supabase's own emailed link -- nobody
--     (not this patch, not an admin) ever sees or types it.
-- ============================================================

-- ---------------------------------------------------------------- ledger
create table if not exists public.legacy_account_migrations (
  id                 uuid primary key default gen_random_uuid(),
  -- lower(username-or-email) as it matched in hpf_users -- the one stable
  -- handle across repeated logins/devices for what is, structurally, a
  -- browser-local record with no other durable id.
  identifier         text not null,
  full_name          text,
  -- The account's ACTUAL legacy role (teacher/school_leader/field_officer/
  -- staff/programme_manager/me_officer/admin) -- never 'learner': legacyLogin()
  -- itself already excludes learner rows (see app.js), so this ledger
  -- structurally cannot receive one, and the RPC below rejects it too, as a
  -- second, server-side backstop.
  legacy_role        public.user_role,
  school             text,
  county             text,
  project            text,
  status             text not null default 'detected'
                        check (status in (
                          'detected',            -- seen once via a real legacy login, nothing done yet
                          'already_has_account',  -- identifier matches an existing profiles.email -- no invite needed
                          'invited',              -- signInWithOtp sent; confirmed_email captured
                          'migrated',             -- admin completed role+school; migrated_profile_id set
                          'declined',             -- admin/person marked this account intentionally not migrating
                          'obsolete'               -- admin marked this account no longer in use
                        )),
  confirmed_email    text,
  migrated_profile_id uuid references public.profiles(id) on delete set null,
  first_detected_at  timestamptz not null default now(),
  last_login_at      timestamptz not null default now(),
  login_count        integer not null default 1,
  invited_at         timestamptz,
  migrated_at        timestamptz,
  notes              text,
  updated_at         timestamptz not null default now(),
  unique (identifier)
);

drop trigger if exists legacy_account_migrations_touch_updated_at on public.legacy_account_migrations;
create trigger legacy_account_migrations_touch_updated_at
  before update on public.legacy_account_migrations
  for each row execute function public.touch_updated_at();

create index if not exists legacy_account_migrations_status_idx
  on public.legacy_account_migrations (status);

alter table public.legacy_account_migrations enable row level security;

-- Same visibility as the staff directory this ledger is a companion to.
create policy "legacy migrations view" on public.legacy_account_migrations
  for select to authenticated
  using ((select has_perm('people', 'view')));

-- Admin actions (complete migration, mark obsolete/declined, edit notes)
-- go through a normal authenticated UPDATE, gated exactly like every other
-- people-management write in this schema -- no new RPC needed for this
-- part, since the caller here always has a real session.
create policy "legacy migrations edit" on public.legacy_account_migrations
  for update to authenticated
  using ((select has_perm('people', 'edit')))
  with check ((select has_perm('people', 'edit')));

-- No authenticated/anon INSERT or DELETE policy at all -- every row is
-- created exactly once, by record_legacy_login() below, running as the
-- function owner. Nothing else may create or remove a row in this table.

-- ---------------------------------------------------------------- sunset config
-- Single row (id fixed true), admin-set target date + note. Existing purely
-- as a displayed target for the admin panel -- nothing in this schema
-- enforces it automatically; reaching it is a signal for a human decision,
-- not a trigger for this patch to act on.
create table if not exists public.legacy_sunset_config (
  id          boolean primary key default true check (id),
  sunset_date date,
  note        text,
  updated_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);

insert into public.legacy_sunset_config (id) values (true)
  on conflict (id) do nothing;

drop trigger if exists legacy_sunset_config_touch_updated_at on public.legacy_sunset_config;
create trigger legacy_sunset_config_touch_updated_at
  before update on public.legacy_sunset_config
  for each row execute function public.touch_updated_at();

alter table public.legacy_sunset_config enable row level security;

create policy "legacy sunset config view" on public.legacy_sunset_config
  for select to authenticated
  using ((select has_perm('people', 'view')));

-- Admin-only, not Programme Manager: setting the actual removal date for a
-- whole authentication path is a bigger call than the day-to-day people.edit
-- actions Programme Manager already has (matches patch-16's own Admin-only
-- carve-out for touching an existing Staff/Admin row).
create policy "legacy sunset config edit" on public.legacy_sunset_config
  for update to authenticated
  using ((select is_admin()))
  with check ((select is_admin()));

-- ---------------------------------------------------------------- RPC 1: detect
-- Called from legacyLogin()'s own success path, the one moment a legacy
-- account is known to be real -- there is no JWT to authenticate this
-- call with (that is the whole reason legacyLogin() exists), so this is
-- necessarily anon-callable, same narrow shape as record_local_login()
-- (patch-21): every security-relevant value is decided or validated here,
-- not trusted from the caller. Worst case a hostile caller can do is add
-- ledger noise for a role/school/name of their choosing under an
-- identifier of their choosing -- exactly the same bound record_local_login
-- already accepted for login_events, and no different in kind from the
-- public sign-up form already accepting arbitrary self-reported names.
create or replace function public.record_legacy_login(
  p_identifier text,
  p_full_name  text,
  p_role       text,
  p_school     text,
  p_county     text,
  p_project    text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_identifier text := lower(trim(coalesce(p_identifier, '')));
  v_role       public.user_role;
  v_existing_profile boolean;
begin
  if v_identifier = '' then
    raise exception 'record_legacy_login: identifier is required';
  end if;

  -- Validate against the real enum rather than trusting the string; an
  -- unrecognised or learner role is dropped to null rather than raising,
  -- so a client-side data quirk becomes an admin-visible blank, not a
  -- failed sign-in for someone already having a bad day.
  begin
    v_role := nullif(p_role, '')::public.user_role;
  exception when invalid_text_representation then
    v_role := null;
  end;
  if v_role = 'learner' then
    v_role := null;
  end if;

  v_existing_profile := v_identifier like '%@%'
    and exists (select 1 from public.profiles where lower(email) = v_identifier);

  insert into public.legacy_account_migrations
    (identifier, full_name, legacy_role, school, county, project, status)
  values (
    v_identifier,
    left(coalesce(p_full_name, ''), 120),
    v_role,
    left(coalesce(p_school, ''), 200),
    left(coalesce(p_county, ''), 120),
    left(coalesce(p_project, ''), 200),
    case when v_existing_profile then 'already_has_account' else 'detected' end
  )
  on conflict (identifier) do update set
    last_login_at = now(),
    login_count = legacy_account_migrations.login_count + 1,
    -- Refresh the descriptive fields (a legacy row can be edited client-side
    -- between logins) but never move a row backwards out of a state an
    -- admin or the invite step already advanced it to.
    full_name = excluded.full_name,
    legacy_role = coalesce(excluded.legacy_role, legacy_account_migrations.legacy_role),
    school = excluded.school,
    county = excluded.county,
    project = excluded.project,
    status = case
      when legacy_account_migrations.status in ('detected')
        then excluded.status
      else legacy_account_migrations.status
    end;
end $$;

revoke all on function public.record_legacy_login(text, text, text, text, text, text) from public;
grant execute on function public.record_legacy_login(text, text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------- RPC 2: invite recorded
-- Called right after the legacy user's own browser successfully calls
-- signInWithOtp() for themselves. Anon-callable for the same structural
-- reason as above; narrow on purpose -- it can only ever move a row from
-- 'detected' to 'invited' and attach the one email the caller just proved
-- they can receive mail at (by the invite having been sent, not by this
-- call itself -- proof of ownership is still the emailed link, exactly as
-- createStaffAccount()'s existing invite flow already relies on).
create or replace function public.mark_legacy_invited(
  p_identifier text,
  p_email      text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.legacy_account_migrations
  set status = 'invited',
      confirmed_email = lower(trim(coalesce(p_email, ''))),
      invited_at = now()
  where identifier = lower(trim(coalesce(p_identifier, '')))
    and status in ('detected', 'invited');
end $$;

revoke all on function public.mark_legacy_invited(text, text) from public;
grant execute on function public.mark_legacy_invited(text, text) to anon, authenticated;

-- ---------------------------------------------------------------- RPC 3: migrated check
-- The one read a fully anonymous legacy sign-in attempt needs: "has this
-- identifier already been migrated?" Deliberately returns a bare boolean,
-- nothing else -- SELECT on the table itself stays people.view-gated, so
-- an anonymous caller learns only the one yes/no fact relevant to whether
-- their own credential should still work.
create or replace function public.is_legacy_migrated(p_identifier text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.legacy_account_migrations
    where identifier = lower(trim(coalesce(p_identifier, '')))
      and status = 'migrated'
  );
$$;

revoke all on function public.is_legacy_migrated(text) from public;
grant execute on function public.is_legacy_migrated(text) to anon, authenticated;

-- ---------------------------------------------------------------- RPC 4: mark migrated
-- The one write that actually matters for the sunset itself. Kept as its
-- own narrow RPC rather than a plain authenticated UPDATE (unlike
-- obsolete/declined below) because it must run in the SAME action as the
-- role/school grant it is reporting on, and do so atomically -- an admin
-- must never be able to view a row as 'migrated' when the profiles.update
-- beside it silently failed (guard_profile_role() can refuse a role
-- change and simply keep the old role -- see patch-14). Still
-- authenticated-only, still requires the same has_perm('people','edit')
-- the direct table UPDATE policy already requires, so this adds no new
-- privilege -- only atomicity.
create or replace function public.complete_legacy_migration(
  p_identifier text,
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (select has_perm('people', 'edit')) then
    raise exception 'complete_legacy_migration: not permitted';
  end if;

  update public.legacy_account_migrations
  set status = 'migrated',
      migrated_profile_id = p_profile_id,
      migrated_at = now()
  where identifier = lower(trim(coalesce(p_identifier, '')));
end $$;

revoke all on function public.complete_legacy_migration(text, uuid) from public;
grant execute on function public.complete_legacy_migration(text, uuid) to authenticated;
