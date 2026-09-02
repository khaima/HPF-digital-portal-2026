-- ============================================================
-- HPF Digital Portal — patch 34: activate the notifications system
-- Run once after patch-33. Safe to re-run.
--
-- NO new table. `notifications` has existed since patch-13 with real RLS
-- (rewritten by patch-23 onto the permission matrix) and has never had a
-- producer — patch-13's own comment says so: "Insert is admin-only for
-- now — no automated producer exists yet to write these on the app's
-- behalf." This patch writes that producer.
--
-- Three columns are added to the EXISTING table because the brief requires
-- facts it cannot currently store: `priority`, a structured related record
-- (`ref_table`/`ref_id` — the same polymorphic shape learning_activity and
-- evidence already use), and `dedupe_key`, which is what actually enforces
-- "do not generate noisy notifications".
--
-- THE PRODUCER IS SERVER-SIDE ONLY. Notifications are raised by triggers on
-- the tables where the events genuinely happen, plus one scheduled sweep
-- for the time-based ones. hpf_notify() is deliberately NOT granted to
-- `authenticated`: no client can fabricate a notification for another user.
-- The single client-callable entry point (offline-sync failure) can only
-- ever notify the caller themselves.
--
-- See supabase/NOTIFICATIONS.md for the event catalogue and the RLS audit.
-- ============================================================

-- ---------------------------------------------------------------- 1) columns
alter table public.notifications add column if not exists priority text not null default 'normal';
alter table public.notifications add column if not exists ref_table text;
alter table public.notifications add column if not exists ref_id uuid;
alter table public.notifications add column if not exists dedupe_key text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_priority_check') then
    alter table public.notifications
      add constraint notifications_priority_check
      check (priority in ('low', 'normal', 'high', 'urgent'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notifications_type_check') then
    alter table public.notifications
      add constraint notifications_type_check
      check (type in (
        'field_assignment',      -- new field assignment
        'action_assigned',       -- new action
        'action_overdue',        -- overdue action
        'high_priority_issue',   -- high-priority issue
        'kpi_at_risk',           -- KPI at risk
        'kobo_sync_failed',      -- failed Kobo synchronization
        'offline_sync_failed',   -- failed offline synchronization
        'data_quality',          -- data-quality problem
        'training_assigned',     -- training assignment
        'admin_event'            -- important administrative event
      ));
  end if;
end $$;

-- The anti-noise guarantee. One notification per (recipient, event) —
-- a daily overdue sweep re-running cannot stack up duplicates.
create unique index if not exists notifications_dedupe_key
  on public.notifications (dedupe_key) where dedupe_key is not null;

create index if not exists notifications_recipient_unread_idx
  on public.notifications (recipient_id, created_at desc) where read_at is null;

-- ---------------------------------------------------------------- 2) the producer
-- Internal. SECURITY DEFINER so a trigger firing under any user's session
-- can write to a recipient other than themselves — and NOT granted to
-- `authenticated`, so that capability is unreachable from a client.
-- Silently no-ops on a duplicate dedupe_key, and refuses to notify anyone
-- who is not a real, active profile.
create or replace function public.hpf_notify(
  p_recipient  uuid,
  p_type       text,
  p_title      text,
  p_body       text default null,
  p_link       text default null,
  p_priority   text default 'normal',
  p_ref_table  text default null,
  p_ref_id     uuid default null,
  p_dedupe_key text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id uuid;
begin
  if p_recipient is null then return null; end if;
  -- Never notify a deactivated account, and never a row that isn't a real
  -- profile (the FK would reject it anyway, louder than is useful here).
  if not exists (select 1 from profiles p where p.id = p_recipient and coalesce(p.active, true)) then
    return null;
  end if;

  insert into public.notifications
    (recipient_id, type, title, body, link, priority, ref_table, ref_id, dedupe_key)
  values
    (p_recipient, p_type, left(p_title, 200), left(p_body, 1000), p_link,
     coalesce(p_priority, 'normal'), p_ref_table, p_ref_id, p_dedupe_key)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;

  return v_id;
end $fn$;

-- Supabase's default privileges GRANT EXECUTE on every new function to
-- anon + authenticated, so revoking from PUBLIC alone is a no-op against
-- those explicit grants — caught by RLS test R6, where hpf_notify() turned
-- out to be callable by anyone holding the publishable key. The roles must
-- be revoked by name. Internal producer: server-side callers only.
revoke all on function public.hpf_notify(uuid, text, text, text, text, text, text, uuid, text) from public, anon, authenticated;

-- Fan-out helper: notify every holder of an oversight role. Used only for
-- events that genuinely have no single owner (a failed sync, a KPI at
-- risk). Kept narrow on purpose — broadcasting is how notification
-- systems become noise.
create or replace function public.hpf_notify_roles(
  p_roles      text[],
  p_type       text,
  p_title      text,
  p_body       text default null,
  p_link       text default null,
  p_priority   text default 'normal',
  p_ref_table  text default null,
  p_ref_id     uuid default null,
  p_dedupe_key text default null
) returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n int := 0; r record;
begin
  for r in select p.id from profiles p
           where p.role::text = any(p_roles) and coalesce(p.active, true)
  loop
    if public.hpf_notify(r.id, p_type, p_title, p_body, p_link, p_priority,
         p_ref_table, p_ref_id,
         -- per-recipient dedupe key, so one event = one row each
         case when p_dedupe_key is null then null else p_dedupe_key || ':' || r.id::text end) is not null
    then n := n + 1; end if;
  end loop;
  return n;
end $fn$;

revoke all on function public.hpf_notify_roles(text[], text, text, text, text, text, text, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- 3) event: new field assignment
create or replace function public.notify_field_assignment()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  -- No notification when an officer assigns a school to themselves.
  if new.officer_id is distinct from (select auth.uid()) then
    perform public.hpf_notify(
      new.officer_id, 'field_assignment',
      'New school assigned: ' || new.school,
      'You have been assigned to ' || new.school || '. Field reports you file for this school will now be accepted.',
      '/field-officer', 'normal', 'school_officer_assignments', new.id,
      'field_assignment:' || new.id::text);
  end if;
  return new;
end $fn$;
drop trigger if exists notify_field_assignment on public.school_officer_assignments;
create trigger notify_field_assignment after insert on public.school_officer_assignments
  for each row execute function public.notify_field_assignment();

-- ---------------------------------------------------------------- 4) event: new action
create or replace function public.notify_action_assigned()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare v_school text;
begin
  if new.assignee_id is null or new.assignee_id is not distinct from (select auth.uid()) then
    return new;
  end if;
  -- Only on a genuine assignment: creation, or a re-assignment to someone new.
  if tg_op = 'UPDATE' and new.assignee_id is not distinct from old.assignee_id then
    return new;
  end if;
  select s.name into v_school from interventions i join schools s on s.id = i.school_id where i.id = new.intervention_id;
  perform public.hpf_notify(
    new.assignee_id, 'action_assigned',
    'Action assigned: ' || new.title,
    coalesce('For ' || v_school || '. ', '') ||
      coalesce('Due ' || to_char(new.due_date, 'DD Mon YYYY') || '.', 'No due date set.'),
    '/dashboard', 'normal', 'action_items', new.id,
    'action_assigned:' || new.id::text || ':' || new.assignee_id::text);
  return new;
end $fn$;
drop trigger if exists notify_action_assigned on public.action_items;
create trigger notify_action_assigned after insert or update of assignee_id on public.action_items
  for each row execute function public.notify_action_assigned();

-- ---------------------------------------------------------------- 5) event: high-priority issue
-- An intervention IS the escalation path in this schema, so opening one is
-- the high-priority signal. Notified to the school's own leader (ownership)
-- and to programme oversight — not broadcast.
create or replace function public.notify_intervention_opened()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare v_school text; r record;
begin
  select s.name into v_school from schools s where s.id = new.school_id;
  for r in select p.id from profiles p
           where coalesce(p.active, true)
             and (p.role::text in ('admin', 'programme_manager')
                  or (p.role::text = 'school_leader' and p.school = v_school))
             and p.id is distinct from (select auth.uid())
  loop
    perform public.hpf_notify(
      r.id, 'high_priority_issue',
      'Issue opened: ' || new.title,
      coalesce('At ' || v_school || '. ', '') || coalesce(left(new.description, 300), ''),
      '/dashboard', 'high', 'interventions', new.id,
      'intervention_opened:' || new.id::text || ':' || r.id::text);
  end loop;
  return new;
end $fn$;
drop trigger if exists notify_intervention_opened on public.interventions;
create trigger notify_intervention_opened after insert on public.interventions
  for each row execute function public.notify_intervention_opened();

-- ---------------------------------------------------------------- 6) event: failed Kobo sync
create or replace function public.notify_kobo_sync_failed()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  -- Only on the transition into 'failed', never on every row touch.
  if new.status = 'failed' and (tg_op = 'INSERT' or old.status is distinct from 'failed') then
    perform public.hpf_notify_roles(
      array['admin', 'programme_manager'], 'kobo_sync_failed',
      'Kobo synchronisation failed' || coalesce(' — ' || new.form_id, ''),
      left(coalesce(new.error_detail, 'No error detail recorded.'), 500),
      '/dashboard', 'high', 'kobo_sync_runs', new.id,
      'kobo_sync_failed:' || new.id::text);
  end if;
  return new;
end $fn$;
drop trigger if exists notify_kobo_sync_failed on public.kobo_sync_runs;
create trigger notify_kobo_sync_failed after insert or update of status on public.kobo_sync_runs
  for each row execute function public.notify_kobo_sync_failed();

-- ---------------------------------------------------------------- 7) event: data-quality problem
-- A Kobo submission that could not be processed cleanly.
create or replace function public.notify_kobo_data_quality()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.processing_status in ('REJECTED', 'REQUIRES_REVIEW')
     and (tg_op = 'INSERT' or old.processing_status is distinct from new.processing_status) then
    perform public.hpf_notify_roles(
      array['admin', 'programme_manager', 'me_officer'], 'data_quality',
      'Submission needs review: ' || new.form_id,
      'Kobo submission ' || new.kobo_submission_id || ' was marked ' || new.processing_status || '.',
      '/dashboard', 'normal', 'kobo_submissions', new.id,
      'kobo_dq:' || new.id::text);
  end if;
  return new;
end $fn$;
drop trigger if exists notify_kobo_data_quality on public.kobo_submissions;
create trigger notify_kobo_data_quality after insert or update of processing_status on public.kobo_submissions
  for each row execute function public.notify_kobo_data_quality();

-- A learner record whose identity could not be resolved (patch-33).
create or replace function public.notify_identity_review()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.status = 'open' and tg_op = 'INSERT' then
    perform public.hpf_notify_roles(
      array['admin', 'programme_manager'], 'data_quality',
      'Learner identity needs review',
      coalesce(new.observed_name, 'A record') || coalesce(' at ' || new.school, '') ||
        ' could not be matched to a learner (' || new.reason || ').',
      '/dashboard', 'normal', 'learner_identity_reviews', new.id,
      'identity_review:' || new.id::text);
  end if;
  return new;
end $fn$;
drop trigger if exists notify_identity_review on public.learner_identity_reviews;
create trigger notify_identity_review after insert on public.learner_identity_reviews
  for each row execute function public.notify_identity_review();

-- ---------------------------------------------------------------- 8) event: training assignment
create or replace function public.notify_training_assigned()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.teacher_id is distinct from (select auth.uid()) then
    perform public.hpf_notify(
      new.teacher_id, 'training_assigned',
      'Training recorded: ' || new.title,
      coalesce('Provider: ' || new.provider || '. ', '') ||
        case when new.completed_at is null then 'Not yet completed.'
             else 'Completed ' || to_char(new.completed_at, 'DD Mon YYYY') || '.' end,
      '/curriculum', 'normal', 'teacher_training', new.id,
      'training:' || new.id::text);
  end if;
  return new;
end $fn$;
drop trigger if exists notify_training_assigned on public.teacher_training;
create trigger notify_training_assigned after insert on public.teacher_training
  for each row execute function public.notify_training_assigned();

-- ---------------------------------------------------------------- 9) event: administrative
-- A role change is the one profile edit that changes what a person can do,
-- so the person it happens to is told. Mirrors guard_profile_role()'s own
-- audit entry, from the recipient's side.
create or replace function public.notify_role_change()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.role is distinct from old.role then
    perform public.hpf_notify(
      new.id, 'admin_event',
      'Your access level changed',
      'Your role is now ' || new.role::text || ' (previously ' || old.role::text || ').',
      '/dashboard', 'high', 'profiles', new.id,
      'role_change:' || new.id::text || ':' || new.role::text || ':' || to_char(now(), 'YYYYMMDDHH24MISS'));
  end if;
  return new;
end $fn$;
drop trigger if exists notify_role_change on public.profiles;
create trigger notify_role_change after update of role on public.profiles
  for each row execute function public.notify_role_change();

-- ---------------------------------------------------------------- 10) offline sync failure
-- The ONLY client-callable producer. It can notify exactly one person —
-- the caller — so it is not a spam vector even though `authenticated` may
-- execute it. Mirrors how record_local_login() (patch-21) is scoped.
create or replace function public.hpf_notify_offline_sync_failed(p_detail text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if (select auth.uid()) is null then return null; end if;
  return public.hpf_notify(
    (select auth.uid()), 'offline_sync_failed',
    'A saved report could not be synced',
    coalesce(left(p_detail, 500), 'One or more offline field reports are still waiting to reach the server.'),
    '/field-officer', 'high', null, null,
    -- one per person per day: a device retrying every few minutes must not
    -- produce a notification every time it fails.
    'offline_sync:' || (select auth.uid())::text || ':' || to_char(now(), 'YYYY-MM-DD'));
end $fn$;

revoke all on function public.hpf_notify_offline_sync_failed(text) from public, anon;
grant execute on function public.hpf_notify_offline_sync_failed(text) to authenticated;

-- ---------------------------------------------------------------- 11) time-based sweep
-- Overdue actions and at-risk KPIs are states, not events, so no trigger
-- can raise them — they need a periodic pass. Idempotent via dedupe_key
-- (an overdue action produces one notification per day, not one per run).
-- Restricted to programme oversight so an ordinary user cannot use it to
-- push notifications to other people.
create or replace function public.hpf_notification_sweep()
returns table (overdue_actions int, kpis_at_risk int)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_overdue int := 0; v_kpi int := 0; r record; today text := to_char(now(), 'YYYY-MM-DD');
begin
  if not ((select is_programme_manager()) or (select is_admin())) then
    raise exception 'hpf_notification_sweep: not permitted';
  end if;

  -- overdue actions -> the assignee who owns them
  for r in
    select ai.id, ai.title, ai.assignee_id, ai.due_date
    from action_items ai
    where ai.status <> 'done' and ai.due_date is not null
      and ai.due_date < current_date and ai.assignee_id is not null
  loop
    if public.hpf_notify(
         r.assignee_id, 'action_overdue',
         'Overdue action: ' || r.title,
         'This action was due ' || to_char(r.due_date, 'DD Mon YYYY') || ' and is not yet marked done.',
         '/dashboard', 'high', 'action_items', r.id,
         'action_overdue:' || r.id::text || ':' || today) is not null
    then v_overdue := v_overdue + 1; end if;
  end loop;

  -- KPIs at risk: latest recorded value below 80% of its target
  for r in
    select mi.name, mi.id as indicator_id, mv.value, mt.target_value, mt.period_year
    from me_targets mt
    join me_indicators mi on mi.id = mt.indicator_id
    join lateral (
      select v.value from me_indicator_values v
      where v.indicator_id = mt.indicator_id
        and v.school_id is not distinct from mt.school_id
        and v.period_year = mt.period_year
      order by v.created_at desc limit 1
    ) mv on true
    where mt.target_value > 0 and mv.value < mt.target_value * 0.8
  loop
    v_kpi := v_kpi + public.hpf_notify_roles(
      array['admin', 'programme_manager', 'me_officer'], 'kpi_at_risk',
      'KPI at risk: ' || r.name,
      'Latest value ' || r.value || ' is below 80% of the ' || r.period_year || ' target of ' || r.target_value || '.',
      '/dashboard', 'high', 'me_indicators', r.indicator_id,
      'kpi_at_risk:' || r.indicator_id::text || ':' || r.period_year::text || ':' || today);
  end loop;

  return query select v_overdue, v_kpi;
end $fn$;

revoke all on function public.hpf_notification_sweep() from public, anon;
grant execute on function public.hpf_notification_sweep() to authenticated;

-- ---------------------------------------------------------------- 12) mark as read
-- The recipient's own action. RLS already permits a recipient to UPDATE
-- their own row, so this needs no elevated rights — it is SECURITY INVOKER
-- and simply cannot touch anyone else's notifications.
create or replace function public.hpf_mark_notifications_read(p_ids uuid[] default null)
returns int
language sql
security invoker
set search_path = public
as $fn$
  with upd as (
    update public.notifications
    set read_at = now()
    where recipient_id = (select auth.uid())
      and read_at is null
      and (p_ids is null or id = any(p_ids))
    returning 1
  ) select count(*)::int from upd;
$fn$;

revoke all on function public.hpf_mark_notifications_read(uuid[]) from anon;
grant execute on function public.hpf_mark_notifications_read(uuid[]) to authenticated;

-- ---------------------------------------------------------------- 13) RLS correction
-- The existing UPDATE policy required has_perm('people','edit'), held only
-- by admin and programme_manager — so a teacher, field officer or school
-- leader could not mark their OWN notification read, making the feature
-- unusable for the roles it serves most (caught by RLS test R8). Marking
-- your own notification read is not a people-management action, so that
-- gate does not belong on the self case. Ownership is unchanged and still
-- the boundary; programme-manager oversight is retained exactly as before.
drop policy if exists "notifications edit" on public.notifications;
create policy "notifications edit" on public.notifications for update to authenticated
  using (
    recipient_id = (select auth.uid())
    or ((select has_perm('people', 'edit')) and (select is_programme_manager()))
  )
  with check (
    recipient_id = (select auth.uid())
    or ((select has_perm('people', 'edit')) and (select is_programme_manager()))
  );

-- RLS decides which ROWS; this decides which COLUMN. A recipient may flip
-- read_at on their own notification and nothing else — they cannot rewrite
-- the title, body, priority or link of a notification the system sent them.
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- ---------------------------------------------------------------- 14) trigger fn hygiene
-- Trigger functions cannot meaningfully be invoked outside trigger context
-- (PostgREST will not expose a function returning `trigger`, and TG_OP is
-- unset), but patch-04 and patch-28 already established that this schema
-- revokes them anyway rather than relying on that. Same treatment here.
revoke all on function public.notify_field_assignment() from public, anon, authenticated;
revoke all on function public.notify_action_assigned() from public, anon, authenticated;
revoke all on function public.notify_intervention_opened() from public, anon, authenticated;
revoke all on function public.notify_kobo_sync_failed() from public, anon, authenticated;
revoke all on function public.notify_kobo_data_quality() from public, anon, authenticated;
revoke all on function public.notify_identity_review() from public, anon, authenticated;
revoke all on function public.notify_training_assigned() from public, anon, authenticated;
revoke all on function public.notify_role_change() from public, anon, authenticated;
