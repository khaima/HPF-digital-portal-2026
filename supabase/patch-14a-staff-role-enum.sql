-- ============================================================
-- HPF Digital Portal — patch 14a: add the 'staff' role value
-- Run once in the Supabase SQL editor, after patch-13. Safe to re-run.
--
-- Split on its own, before patch-14: Postgres refuses to use a freshly-added
-- enum value inside the same transaction that added it, so this has to land
-- and commit by itself before anything references 'staff'.
-- ============================================================

alter type user_role add value if not exists 'staff';
