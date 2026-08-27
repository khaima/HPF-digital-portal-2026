-- ============================================================
-- patch-27 — extend audit logging (patch-24) to the Master Data
-- Management tables it predates: teachers, learners, and
-- field_officers.
--
-- Not extended to `profiles` itself: it already has a targeted
-- audit path for the one field that matters most there (role, via
-- guard_profile_role, patch-22). A second, generic full-row trigger
-- would duplicate every role-change log entry in a second shape and
-- start recording every profile edit indiscriminately, including
-- fields with no MDM relevance. teachers/learners/field_officers are
-- where the actual MDM record data lives, and where "who changed
-- this teacher's TSC number" is a real, useful question to be able
-- to answer.
--
-- Safe to re-run.
-- ============================================================

do $$
declare
  t text;
  tables text[] := array['teachers', 'learners', 'field_officers'];
begin
  foreach t in array tables loop
    execute format('drop trigger if exists audit_%1$s on public.%1$s', t);
    execute format(
      'create trigger audit_%1$s after insert or update or delete on public.%1$s
         for each row execute function public.audit_row_change()', t);
  end loop;
end $$;
