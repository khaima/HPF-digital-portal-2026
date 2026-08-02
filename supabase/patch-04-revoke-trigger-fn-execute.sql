-- ============================================================
-- HPF Digital Portal — patch 04: lock down trigger functions
-- Run once in the Supabase SQL editor, after patch-03:
--   Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.
--
-- Supabase's database linter flagged every SECURITY DEFINER function in the
-- public schema as callable over the REST API at /rest/v1/rpc/<name>, by anon
-- as well as authenticated. Living in `public` is enough to expose them.
--
-- Two of them are trigger functions. Postgres fires triggers as the table
-- owner, so no caller ever needs EXECUTE — the grant was pure surface area.
--
-- The other three (is_admin, owns_class, enrolled_in) are deliberately left
-- alone. They are called from inside RLS policy expressions, which Postgres
-- evaluates with the querying role's own privileges; revoking EXECUTE there
-- would break every policy that depends on them. Closing those properly means
-- moving them to a non-exposed schema and repointing the policies, which is a
-- larger change than this patch.
-- ============================================================

revoke all on function public.handle_new_user()    from public, anon, authenticated;
revoke all on function public.guard_profile_role() from public, anon, authenticated;

-- Verify: the trigger still populates profiles, and a signup asking for
-- 'admin' is still clamped. Run inside a transaction and roll back.
--
--   begin;
--   insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
--                           email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
--                           created_at, updated_at)
--   values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
--           'authenticated', 'authenticated', 'probe@example.org',
--           crypt('x', gen_salt('bf')), now(), '{}'::jsonb,
--           jsonb_build_object('full_name','Probe','role','admin','project','Education'),
--           now(), now());
--   select full_name, role, project from public.profiles where email='probe@example.org';
--   rollback;
--
-- Expect: the row exists, project is carried, and role reads 'learner'.
