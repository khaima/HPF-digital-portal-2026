-- ============================================================
-- HPF Digital Portal — patch 10: head of institution details
-- Run once in the Supabase SQL editor, after patch-09. Safe to re-run.
--
-- Who filed the return, kept on the return itself rather than only on the
-- profile: headship changes, and a 2024 return should still name the head who
-- signed it, not whoever holds the post today.
-- ============================================================

alter table school_returns add column if not exists head_title text;
alter table school_returns add column if not exists head_name  text;
alter table school_returns add column if not exists head_phone text;
alter table school_returns add column if not exists head_email text;

-- The same details on the profile so the form pre-fills next term instead of
-- asking the same person the same question three times a year.
alter table profiles add column if not exists head_title text;
alter table profiles add column if not exists phone      text;
