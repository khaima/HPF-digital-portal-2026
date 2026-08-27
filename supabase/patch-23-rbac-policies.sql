-- ============================================================
-- patch-23 — enforce the permission matrix in RLS.
--
-- REQUIRES patch-22.
--
-- Before this patch, authorization was `is_staff()` almost everywhere:
-- one boolean covering every role above teacher and every kind of
-- action. That has two problems this patch fixes.
--
-- 1. It cannot tell CREATE from EDIT from DELETE. A `for all` policy
--    applies one expression to all four commands, so "may read and may
--    delete" could not be different answers. Every table below is now
--    four separate policies — select / insert / update / delete —
--    checked against the matching matrix action.
--
-- 2. patch-22 split `staff` into programme_manager and me_officer, and
--    is_staff() still returns true for both. Left alone, an M&E officer
--    would have inherited full write access to every table in the
--    product. Write paths now ask has_perm(module, action) instead, so
--    M&E gets exactly the read/export access the matrix grants and no
--    more.
--
-- EVERY policy is `has_perm(module, action) AND <row scope>`:
--
--   has_perm  — may this ROLE do this KIND of thing at all?
--   row scope — to THIS row? (own class, own school, assigned school…)
--
-- Both halves are required. The matrix alone would let a field officer
-- edit any school's facilities. The row scope alone would let a learner
-- edit their own school's. Neither is sufficient and this patch never
-- treats one as standing in for the other.
--
-- A NULL scope argument below means "no policy for that command" —
-- i.e. denied to everyone through the API, whatever the matrix says.
-- Used for the append-only audit tables.
--
-- Safe to re-run: every table's policies are dropped and rebuilt.
-- ============================================================

-- The signed-in user's own school, by name. profiles.school is free text
-- (see SCHEMA.md on why school scoping matches by name, not by FK), and
-- this is the expression a dozen policies below would otherwise repeat.
create or replace function public.my_school()
returns text
language sql
stable
security definer
set search_path = public
as $$ select school from profiles where id = (select auth.uid()); $$;

revoke all on function public.my_school() from public;
grant execute on function public.my_school() to authenticated;

-- ---------------------------------------------------------------- generator
-- Builds the four per-command policies for one table so that all 40 are
-- shaped identically, rather than 160 hand-written policies drifting
-- apart from each other over time. Lives in pg_temp: it exists only for
-- the duration of this migration.
create or replace function pg_temp.rbac(
  p_table  text,
  p_module text,
  p_view   text default 'true',
  p_create text default 'true',
  p_edit   text default 'true',
  p_delete text default 'true'
) returns void
language plpgsql
as $$
declare r record;
begin
  for r in select policyname from pg_policies
            where schemaname = 'public' and tablename = p_table loop
    execute format('drop policy %I on public.%I', r.policyname, p_table);
  end loop;

  if p_view is not null then
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select has_perm(%L, %L)) and (%s))',
      p_table || ' view', p_table, p_module, 'view', p_view);
  end if;
  if p_create is not null then
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select has_perm(%L, %L)) and (%s))',
      p_table || ' create', p_table, p_module, 'create', p_create);
  end if;
  if p_edit is not null then
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select has_perm(%L, %L)) and (%s)) with check ((select has_perm(%L, %L)) and (%s))',
      p_table || ' edit', p_table, p_module, 'edit', p_edit, p_module, 'edit', p_edit);
  end if;
  if p_delete is not null then
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select has_perm(%L, %L)) and (%s))',
      p_table || ' delete', p_table, p_module, 'delete', p_delete);
  end if;
end $$;

-- ---------------------------------------------------------------- schools
select pg_temp.rbac('schools', 'schools');

select pg_temp.rbac('school_facilities', 'infrastructure',
  'true',
  'exists (select 1 from schools s where s.id = school_id and (s.name = (select my_school()) or (select assigned_to_school(s.name)) or (select is_programme_manager())))',
  'exists (select 1 from schools s where s.id = school_id and (s.name = (select my_school()) or (select assigned_to_school(s.name)) or (select is_programme_manager())))',
  '(select is_programme_manager())');

select pg_temp.rbac('school_programmes', 'infrastructure');

-- ---------------------------------------------------------------- returns
-- A head of institution files and edits their own school's returns; a
-- field officer assigned to that school may read them; programme staff
-- see everything. Deleting a filed return stays with programme staff.
-- NOTE on the asymmetry below: the VIEW argument uses is_staff() (admin +
-- programme_manager + me_officer — everyone the matrix grants returns.view
-- to), while CREATE/EDIT/DELETE use is_programme_manager() (excludes
-- me_officer — M&E has no returns.create/edit/delete in the matrix). Using
-- is_programme_manager() on the view side was the actual bug this file
-- shipped with: it silently denied M&E the read access row 12 of the RBAC
-- test suite (STORAGE... see AUTH-RBAC-TESTS.md) caught. Keep them distinct.
select pg_temp.rbac('school_returns', 'returns',
  '(select is_staff()) or school = (select my_school()) or (select assigned_to_school(school))',
  'school = (select my_school()) or (select is_programme_manager())',
  'school = (select my_school()) or (select is_programme_manager())',
  '(select is_programme_manager())');

select pg_temp.rbac('school_return_grades', 'returns',
  'exists (select 1 from school_returns r where r.id = return_id and ((select is_staff()) or r.school = (select my_school()) or (select assigned_to_school(r.school))))',
  'exists (select 1 from school_returns r where r.id = return_id and ((select is_programme_manager()) or r.school = (select my_school())))',
  'exists (select 1 from school_returns r where r.id = return_id and ((select is_programme_manager()) or r.school = (select my_school())))',
  'exists (select 1 from school_returns r where r.id = return_id and ((select is_programme_manager()) or r.school = (select my_school())))');

-- An immutable correction log: written when a return is corrected,
-- never edited or removed afterwards.
select pg_temp.rbac('school_return_revisions', 'returns',
  '(select is_staff()) or school = (select my_school()) or (select assigned_to_school(school))',
  'school = (select my_school()) or (select is_programme_manager())',
  null, null);

-- ---------------------------------------------------------------- people
-- profiles.select stays open to every signed-in role: names and roles
-- are what the whole product renders (who owns a class, who filed a
-- return), and narrowing it would break every one of those views.
-- Writing is where the matrix bites. Role changes have a second gate on
-- top of this — guard_profile_role(), from patch-22.
select pg_temp.rbac('profiles', 'people',
  'true',
  'true',
  'id = (select auth.uid()) or (select is_admin()) or ((select has_perm(''people'',''edit'')) and role not in (''admin'',''staff'',''programme_manager'',''me_officer''))',
  '(select is_admin())');

select pg_temp.rbac('teachers', 'people',
  'true',
  'id = (select auth.uid()) or (select is_programme_manager())',
  'id = (select auth.uid()) or (select is_programme_manager())',
  '(select is_programme_manager())');

select pg_temp.rbac('field_officers', 'people',
  'true',
  'id = (select auth.uid()) or (select is_programme_manager())',
  'id = (select auth.uid()) or (select is_programme_manager())',
  '(select is_programme_manager())');

select pg_temp.rbac('teacher_training', 'people',
  'teacher_id = (select auth.uid()) or (select is_staff())',
  'teacher_id = (select auth.uid()) or (select is_programme_manager())',
  'teacher_id = (select auth.uid()) or (select is_programme_manager())',
  '(select is_programme_manager())');

select pg_temp.rbac('roles', 'people', 'true',
  '(select is_admin())', '(select is_admin())', '(select is_admin())');

-- ---------------------------------------------------------------- learners
select pg_temp.rbac('learners', 'learners',
  '(select is_staff()) or (select teaches_learner(id)) or exists (select 1 from schools s where s.id = school_id and (s.name = (select my_school()) or (select assigned_to_school(s.name))))',
  '(select is_programme_manager()) or exists (select 1 from schools s where s.id = school_id and s.name = (select my_school()))',
  '(select is_programme_manager()) or (select teaches_learner(id)) or exists (select 1 from schools s where s.id = school_id and s.name = (select my_school()))',
  '(select is_programme_manager())');

-- ---------------------------------------------------------------- classes
select pg_temp.rbac('classes', 'classes',
  '(select owns_class(id)) or (select enrolled_in(id)) or (select is_staff())',
  'owner_id = (select auth.uid()) or (select is_programme_manager())',
  '(select owns_class(id)) or (select is_programme_manager())',
  '(select owns_class(id)) or (select is_programme_manager())');

select pg_temp.rbac('enrollments', 'classes',
  '(select owns_class(class_id)) or learner_id = (select auth.uid()) or (select is_staff())',
  '(select owns_class(class_id)) or (select is_programme_manager())',
  '(select owns_class(class_id)) or (select is_programme_manager())',
  '(select owns_class(class_id)) or (select is_programme_manager())');

-- ---------------------------------------------------------------- coursework
select pg_temp.rbac('subjects', 'coursework', 'true',
  '(select is_programme_manager())', '(select is_programme_manager())', '(select is_programme_manager())');

select pg_temp.rbac('assignments', 'coursework',
  '(select owns_class(class_id)) or (select enrolled_in(class_id)) or (select is_staff())',
  '(select owns_class(class_id)) or (select is_programme_manager())',
  '(select owns_class(class_id)) or (select is_programme_manager())',
  '(select owns_class(class_id)) or (select is_programme_manager())');

select pg_temp.rbac('assignment_results', 'coursework',
  'exists (select 1 from assignments a where a.id = assignment_id and ((select owns_class(a.class_id)) or (select is_staff())))',
  'exists (select 1 from assignments a where a.id = assignment_id and ((select owns_class(a.class_id)) or (select is_programme_manager())))',
  'exists (select 1 from assignments a where a.id = assignment_id and ((select owns_class(a.class_id)) or (select is_programme_manager())))',
  'exists (select 1 from assignments a where a.id = assignment_id and ((select owns_class(a.class_id)) or (select is_programme_manager())))');

select pg_temp.rbac('assessments', 'coursework',
  '(select owns_class(class_id)) or (select enrolled_in(class_id)) or (select is_staff())',
  '(select owns_class(class_id)) or (select is_programme_manager())',
  '(select owns_class(class_id)) or (select is_programme_manager())',
  '(select owns_class(class_id)) or (select is_programme_manager())');

-- Answer keys live here, so reading stays with the class owner and
-- programme staff — never the enrolled learner (patch-01's fix, kept).
select pg_temp.rbac('questions', 'coursework',
  'exists (select 1 from assessments a where a.id = assessment_id and ((select owns_class(a.class_id)) or (select is_staff())))',
  'exists (select 1 from assessments a where a.id = assessment_id and ((select owns_class(a.class_id)) or (select is_programme_manager())))',
  'exists (select 1 from assessments a where a.id = assessment_id and ((select owns_class(a.class_id)) or (select is_programme_manager())))',
  'exists (select 1 from assessments a where a.id = assessment_id and ((select owns_class(a.class_id)) or (select is_programme_manager())))');

select pg_temp.rbac('submissions', 'coursework',
  'learner_id = (select auth.uid()) or (select is_staff()) or exists (select 1 from assessments a where a.id = assessment_id and (select owns_class(a.class_id)))',
  'learner_id = (select auth.uid()) or (select is_programme_manager()) or exists (select 1 from assessments a where a.id = assessment_id and (select owns_class(a.class_id)))',
  'learner_id = (select auth.uid()) or (select is_programme_manager()) or exists (select 1 from assessments a where a.id = assessment_id and (select owns_class(a.class_id)))',
  '(select is_programme_manager()) or exists (select 1 from assessments a where a.id = assessment_id and (select owns_class(a.class_id)))');

-- ---------------------------------------------------------------- attendance
select pg_temp.rbac('attendance_records', 'attendance',
  '(select is_staff()) or (select teaches_learner(learner_id)) or exists (select 1 from learners l join schools s on s.id = l.school_id where l.id = learner_id and (s.name = (select my_school()) or (select assigned_to_school(s.name))))',
  '(select is_programme_manager()) or (select teaches_learner(learner_id)) or exists (select 1 from learners l join schools s on s.id = l.school_id where l.id = learner_id and s.name = (select my_school()))',
  '(select is_programme_manager()) or (select teaches_learner(learner_id)) or exists (select 1 from learners l join schools s on s.id = l.school_id where l.id = learner_id and s.name = (select my_school()))',
  '(select is_programme_manager()) or (select teaches_learner(learner_id))');

-- ---------------------------------------------------------------- field operations
select pg_temp.rbac('field_reports', 'field_ops',
  '(select is_staff()) or user_id = (select auth.uid()) or (select assigned_to_school(school))',
  '(select is_programme_manager()) or (select assigned_to_school(school))',
  '(select is_programme_manager()) or user_id = (select auth.uid())',
  '(select is_programme_manager()) or user_id = (select auth.uid())');

select pg_temp.rbac('field_visits', 'field_ops',
  '(select is_staff()) or officer_id = (select auth.uid()) or (select visit_school_match(school_id))',
  '(select is_programme_manager()) or officer_id = (select auth.uid())',
  '(select is_programme_manager()) or officer_id = (select auth.uid())',
  '(select is_programme_manager()) or officer_id = (select auth.uid())');

select pg_temp.rbac('field_visit_findings', 'field_ops',
  'exists (select 1 from field_visits v where v.id = visit_id and ((select is_staff()) or v.officer_id = (select auth.uid()) or (select visit_school_match(v.school_id))))',
  'exists (select 1 from field_visits v where v.id = visit_id and ((select is_programme_manager()) or v.officer_id = (select auth.uid())))',
  'exists (select 1 from field_visits v where v.id = visit_id and ((select is_programme_manager()) or v.officer_id = (select auth.uid())))',
  'exists (select 1 from field_visits v where v.id = visit_id and ((select is_programme_manager()) or v.officer_id = (select auth.uid())))');

select pg_temp.rbac('school_officer_assignments', 'field_ops',
  '(select is_staff()) or officer_id = (select auth.uid())',
  '(select is_programme_manager())', '(select is_programme_manager())', '(select is_programme_manager())');

-- ---------------------------------------------------------------- devices
select pg_temp.rbac('devices', 'devices',
  'true',
  '(select is_programme_manager()) or (select visit_school_match(school_id))',
  '(select is_programme_manager()) or (select visit_school_match(school_id))',
  '(select is_programme_manager())');

select pg_temp.rbac('device_maintenance', 'devices',
  'true',
  'exists (select 1 from devices d where d.id = device_id and ((select is_programme_manager()) or (select visit_school_match(d.school_id)) or d.school_id is null))',
  'exists (select 1 from devices d where d.id = device_id and ((select is_programme_manager()) or (select visit_school_match(d.school_id))))',
  '(select is_programme_manager())');

-- ---------------------------------------------------------------- digital library
-- Not generated: the read side is the one policy in the schema that
-- must stay open to `anon`. Learners hold no session at all, and the
-- published catalogue is what they browse.
drop policy if exists "content read" on public.digital_learning;
drop policy if exists "content write" on public.digital_learning;
drop policy if exists "digital_learning view" on public.digital_learning;
drop policy if exists "digital_learning create" on public.digital_learning;
drop policy if exists "digital_learning edit" on public.digital_learning;
drop policy if exists "digital_learning delete" on public.digital_learning;

create policy "digital_learning view" on public.digital_learning
  for select to anon, authenticated
  using (published or (select has_perm('library','view')));
create policy "digital_learning create" on public.digital_learning
  for insert to authenticated with check ((select has_perm('library','create')));
create policy "digital_learning edit" on public.digital_learning
  for update to authenticated
  using ((select has_perm('library','edit'))) with check ((select has_perm('library','edit')));
create policy "digital_learning delete" on public.digital_learning
  for delete to authenticated using ((select has_perm('library','delete')));

select pg_temp.rbac('kolibri_activity', 'library',
  '(select activity_visible(learner_id))', '(select activity_visible(learner_id))',
  '(select activity_visible(learner_id))', '(select is_programme_manager())');
select pg_temp.rbac('library_activity', 'library',
  '(select activity_visible(learner_id))', '(select activity_visible(learner_id))',
  '(select activity_visible(learner_id))', '(select is_programme_manager())');
select pg_temp.rbac('learning_activity', 'library',
  '(select activity_visible(learner_id))', '(select activity_visible(learner_id))',
  '(select activity_visible(learner_id))', '(select is_programme_manager())');

-- ---------------------------------------------------------------- M&E
-- The one module M&E writes. A school leader or field officer may
-- record a measurement for their own/assigned school, but org-wide
-- figures (school_id null) stay with M&E and programme staff.
select pg_temp.rbac('me_indicators', 'me');
select pg_temp.rbac('me_targets', 'me');

select pg_temp.rbac('me_indicator_values', 'me',
  'true',
  '(select is_staff()) or (school_id is not null and exists (select 1 from schools s where s.id = school_id and (s.name = (select my_school()) or (select assigned_to_school(s.name)))))',
  '(select is_staff()) or (school_id is not null and exists (select 1 from schools s where s.id = school_id and (s.name = (select my_school()) or (select assigned_to_school(s.name)))))',
  '(select is_staff())');

select pg_temp.rbac('kobo_submissions', 'me', 'true', null, null, null);

-- ---------------------------------------------------------------- interventions
select pg_temp.rbac('interventions', 'interventions',
  '(select is_staff()) or (select visit_school_match(school_id))',
  '(select is_programme_manager()) or (select visit_school_match(school_id))',
  '(select is_programme_manager()) or (select visit_school_match(school_id))',
  '(select is_programme_manager())');

select pg_temp.rbac('action_items', 'interventions',
  '(select is_staff()) or assignee_id = (select auth.uid()) or exists (select 1 from interventions i where i.id = intervention_id and (select visit_school_match(i.school_id)))',
  '(select is_programme_manager()) or exists (select 1 from interventions i where i.id = intervention_id and (select visit_school_match(i.school_id)))',
  '(select is_programme_manager()) or assignee_id = (select auth.uid()) or exists (select 1 from interventions i where i.id = intervention_id and (select visit_school_match(i.school_id)))',
  '(select is_programme_manager())');

-- ---------------------------------------------------------------- evidence
select pg_temp.rbac('evidence', 'evidence',
  'true', 'true',
  'uploaded_by = (select auth.uid()) or (select is_staff())',
  'uploaded_by = (select auth.uid()) or (select is_staff())');

-- ---------------------------------------------------------------- notifications
-- Deliberately NOT is_staff() here, unlike the returns/training fix above:
-- a notification is a message to one person, and M&E's 'people' view+export
-- grant is about org/role data, not license to browse everyone's personal
-- inbox. This is the row-scope legitimately narrowing past the module grant
-- — see the file header on why both halves exist — not the same bug.
select pg_temp.rbac('notifications', 'people',
  'recipient_id = (select auth.uid()) or (select is_programme_manager())',
  '(select is_programme_manager())',
  'recipient_id = (select auth.uid()) or (select is_programme_manager())',
  '(select is_programme_manager())');

-- ---------------------------------------------------------------- audit
-- Append-only, and enforced as such: no insert, update or delete policy
-- exists on audit_logs at all, so the REST API cannot write or alter the
-- trail under any role. Rows arrive solely through log_audit() and the
-- triggers in patch-24, which are SECURITY DEFINER and bypass RLS.
select pg_temp.rbac('audit_logs', 'audit', 'true', null, null, null);

-- login_events: any signed-in user may append their own sign-in, and
-- learners append theirs through record_local_login() (patch-21).
-- Reading the trail is an audit permission; nothing may alter it.
select pg_temp.rbac('login_events', 'audit', 'true', 'true', null, null);
