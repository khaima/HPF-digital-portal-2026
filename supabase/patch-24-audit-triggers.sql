-- ============================================================
-- patch-24 — wire up audit logging for real.
--
-- log_audit() and audit_logs have existed since patch-13. Verified
-- directly before writing this: zero rows, ever — the function was
-- defined but no trigger anywhere in the schema ever called it. An
-- audit trail nothing writes to is not an audit trail.
--
-- This adds one generic trigger function and attaches it to every
-- table where "who did this, and when" is something an admin would
-- actually need to answer: the permission matrix itself, schools,
-- termly returns, interventions and their action items, evidence,
-- devices and their maintenance tickets, and who is assigned where.
--
-- Deliberately NOT attached to high-volume, low-stakes tables
-- (attendance_records, submissions, kolibri/library/learning_activity)
-- — auditing every attendance mark would swamp the log with noise no
-- one would ever read, for rows that are themselves already scoped and
-- attributable via created_by/recorded_by columns.
--
-- Also not attached to app_modules: a fixed, 16-row label lookup (this
-- migration's own seed data), not something anyone changes at runtime.
-- `permissions` — the table that actually grants power — gets its own
-- trigger below instead of the generic one, since its primary key is
-- (role, module, action), not a single uuid id column.
--
-- profiles keeps its own, more specific trigger (guard_profile_role,
-- patch-22) rather than this generic one: a role change needs to log
-- old/new role specifically and can be *refused*, which a generic
-- after-the-fact trigger can't express as cleanly.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform log_audit('delete', tg_table_name, old.id, to_jsonb(old), null);
    return old;
  elsif tg_op = 'UPDATE' then
    perform log_audit('update', tg_table_name, new.id, to_jsonb(old), to_jsonb(new));
    return new;
  else
    perform log_audit('create', tg_table_name, new.id, null, to_jsonb(new));
    return new;
  end if;
end $$;

revoke all on function public.audit_row_change() from public;

do $$
declare
  t text;
  tables text[] := array[
    'schools', 'school_returns',
    'interventions', 'action_items', 'evidence',
    'devices', 'device_maintenance',
    'school_officer_assignments'
  ];
begin
  foreach t in array tables loop
    execute format('drop trigger if exists audit_%1$s on public.%1$s', t);
    execute format(
      'create trigger audit_%1$s after insert or update or delete on public.%1$s
         for each row execute function public.audit_row_change()', t);
  end loop;
end $$;

-- `permissions` has a composite primary key (role, module, action), not an
-- `id` column, so log_audit()'s p_record_id (uuid) has nothing to take —
-- pass null and let old_data/new_data carry the whole row instead. Same
-- generic function, this table just can't supply that one argument.
create or replace function public.audit_permissions_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform log_audit('delete', 'permissions', null, to_jsonb(old), null);
    return old;
  elsif tg_op = 'UPDATE' then
    perform log_audit('update', 'permissions', null, to_jsonb(old), to_jsonb(new));
    return new;
  else
    perform log_audit('create', 'permissions', null, null, to_jsonb(new));
    return new;
  end if;
end $$;

revoke all on function public.audit_permissions_change() from public;

drop trigger if exists audit_permissions on public.permissions;
create trigger audit_permissions after insert or update or delete on public.permissions
  for each row execute function public.audit_permissions_change();
