-- ============================================================
-- HPF Digital Portal — patch 14: split Admin into Staff + Admin
-- Run once in the Supabase SQL editor, after patch-14a. Safe to re-run.
--
-- Staff gets everything Admin has today. Admin keeps exactly one extra
-- power: granting the Admin role itself. Implemented by renaming the
-- existing is_admin() to is_staff() and broadening its body — every one of
-- the 50 live policies that already call is_admin() picks up the broadened
-- access automatically, with zero edits to any of them, because a Postgres
-- policy binds to a function by OID, not by re-parsing its name on every
-- call. Verified empirically (rolled-back transaction, on a throwaway test
-- schema and again against the live 50 policies) before this was written.
-- is_admin() is then recreated under its old name with the original, strict
-- meaning — reused only for the one action that must stay exclusive.
--
-- Cosmetic note, not a bug: `select qual from pg_policies` now shows
-- `(select is_staff() as is_admin)` in every policy that was renamed —
-- Postgres keeps the original inferred column alias (`is_admin`, from when
-- the wrapping subquery was first compiled) even though the function it
-- calls is correctly `is_staff()`. The alias is display-only; nothing reads
-- it, and it doesn't affect what the policy allows.
-- ============================================================

alter function is_admin() rename to is_staff;

create or replace function is_staff() returns boolean
  language sql stable security definer set search_path = 'public' as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('admin', 'staff'));
$$;

create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = 'public' as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;
grant execute on function is_admin() to public, postgres, anon, authenticated, service_role;

-- Only the *destination* role of a change is special-cased: moving someone
-- to 'admin' needs the strict check; moving them to anything else (staff
-- included) needs only the broadened one. This is what makes "staff can do
-- what admin does, except grant admin" a real, un-bypassable rule rather
-- than a UI convention.
create or replace function guard_profile_role() returns trigger
  language plpgsql security definer set search_path = 'public' as $$
declare
  claims   json := nullif(current_setting('request.jwt.claims', true), '')::json;
  jwt_role text := claims->>'role';
begin
  if new.role is distinct from old.role
     and claims is not null            -- null = SQL editor / direct connection
     and jwt_role is distinct from 'service_role' then
    if new.role = 'admin' then
      if not is_admin() then
        new.role := old.role;
      end if;
    else
      if not is_staff() then
        new.role := old.role;
      end if;
    end if;
  end if;
  return new;
end $$;

insert into roles (id, label, description) values
  ('staff', 'HPF Staff', 'Full platform access — every school, every account. Cannot promote another account to Admin.')
on conflict (id) do nothing;

update roles set label = 'HPF Admin', description =
  'Full platform access — every school, every account. The only role that can promote a Staff account to Admin.'
where id = 'admin';
