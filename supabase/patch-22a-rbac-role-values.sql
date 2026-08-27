-- ============================================================
-- patch-22a — the two new role values, on their own.
--
-- MUST RUN AND COMMIT BEFORE patch-22. Postgres will not let a new
-- enum value be *used* in the same transaction that adds it, so the
-- values land here and everything that references them lands next —
-- the same split patch-14a/patch-14 already used for 'staff'.
--
-- The blanket `staff` tier splits in two:
--   programme_manager — runs the programme; full operational access
--   me_officer        — monitoring & evaluation; reads and exports
--                       everything, writes only M&E data and evidence
--
-- `staff` itself stays in the enum. Postgres cannot drop an enum value,
-- and pretending otherwise would mean rebuilding the type and every
-- column, policy and index that depends on it. patch-22 migrates every
-- existing staff row to programme_manager and keeps is_staff() treating
-- the old value as equivalent, so nothing breaks if a row is created
-- with it by older code.
--
-- Safe to re-run.
-- ============================================================

alter type user_role add value if not exists 'programme_manager';
alter type user_role add value if not exists 'me_officer';
