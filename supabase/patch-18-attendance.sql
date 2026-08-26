-- ============================================================
-- HPF Digital Portal — patch 18: attendance records
-- Run once in the Supabase SQL editor, after patch-17. Safe to re-run.
--
-- Attendance exists today only as school_returns.attendance_rate — a
-- termly aggregate a head types in, with nothing granular behind it. This
-- is the normalized table a future pass could compute that rate FROM,
-- one row per learner per class per day, rather than a second place to
-- (re)type the same fact. Nothing reads this table yet and
-- school_returns.attendance_rate is untouched — building the aggregate-
-- from-real-data pass is a separate, later change, same as every other
-- "schema now, wiring later" table patch-13 already established.
--
-- RLS mirrors learners' own policy (patch-13): the class's owning teacher,
-- the learner's own school leader, or admin/staff.
-- ============================================================

create table if not exists attendance_records (
  id           uuid primary key default gen_random_uuid(),
  learner_id   uuid not null references learners(id) on delete cascade,
  class_id     uuid not null references classes(id) on delete cascade,
  session_date date not null,
  status       text not null check (status in ('present', 'absent', 'late', 'excused')),
  recorded_by  uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (learner_id, class_id, session_date)
);

create index if not exists attendance_records_learner_id_idx on attendance_records (learner_id, session_date);
create index if not exists attendance_records_class_id_idx   on attendance_records (class_id, session_date);

drop trigger if exists attendance_records_touch_updated_at on attendance_records;
create trigger attendance_records_touch_updated_at
  before update on attendance_records
  for each row execute function touch_updated_at();

alter table attendance_records enable row level security;

drop policy if exists "attendance rw" on attendance_records;
create policy "attendance rw" on attendance_records for all to authenticated
  using (
    (select is_admin())
    or (select teaches_learner(attendance_records.learner_id))
    or exists (select 1 from learners l join schools s on s.id = l.school_id
      where l.id = attendance_records.learner_id
        and s.name = (select p.school from profiles p where p.id = (select auth.uid())))
  )
  with check (
    (select is_admin())
    or (select teaches_learner(attendance_records.learner_id))
    or exists (select 1 from learners l join schools s on s.id = l.school_id
      where l.id = attendance_records.learner_id
        and s.name = (select p.school from profiles p where p.id = (select auth.uid())))
  );
