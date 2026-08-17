-- ============================================================
-- HPF Digital Portal — patch 11: open signup
-- Run once in the Supabase SQL editor, after patch-10. Safe to re-run.
--
-- Signup was creating the account and then refusing the session: the project
-- has "Confirm email" on and nobody was receiving the mail, so every account
-- was stranded unconfirmed and could neither sign up nor sign in. Three real
-- accounts were stuck that way.
--
-- This auto-confirms new users so people can register and sign in straight
-- away. It is a deliberate loosening: an address is never proven to belong to
-- whoever typed it, so anyone can register under any email. To undo, drop the
-- trigger and switch "Confirm email" back on under
-- Authentication -> Providers -> Email.
--
-- What it does NOT loosen: patch-01 still clamps the requested role, so a
-- signup asking for 'admin' still lands as a learner. Open registration is not
-- open privileges.
-- ============================================================

create or replace function auto_confirm_new_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.auto_confirm_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_auto_confirm on auth.users;
create trigger on_auth_user_auto_confirm
  before insert on auth.users
  for each row execute function auto_confirm_new_user();

-- One-off: release accounts already stranded behind the confirmation wall.
update auth.users set email_confirmed_at = now() where email_confirmed_at is null;
