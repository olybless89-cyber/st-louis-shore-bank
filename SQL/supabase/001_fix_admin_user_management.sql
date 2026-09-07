-- ─────────────────────────────────────────────────────────────────────────────
-- Fix: created users do not show on the admin dashboard and cannot be managed.
--
-- Root cause (verified against the live project uatnxwvkpuvxvgngxxez):
--   1. public.admin_get_all_users() threw
--        `column reference "role" is ambiguous`
--      because the PL/pgSQL function body did `SELECT ... role ...` while a
--      function parameter / variable was also named `role`. Postgres could not
--      decide between the parameter and the `profiles.role` column, so the RPC
--      errored for every caller.
--   2. The admin dashboard's fallback path reads `profiles` directly from the
--      client. Row-Level Security on `profiles` is `auth.uid() = id` (own row
--      only) with NO admin bypass, so a direct client read can never return
--      other users — it returns just the admin's own row (or nothing).
--   3. admin.html `toggleUserStatus()` wrote to `profiles` directly from the
--      client. RLS blocks cross-user writes too, so activating/deactivating
--      another user silently did nothing. No status-toggle RPC existed.
--
-- Fix:
--   * Redefine admin_get_all_users() as SECURITY DEFINER (bypasses RLS, runs as
--     the function owner) with every column reference table-qualified (`p.col`)
--     so there is no possible ambiguity. Returns the full profile row set the
--     dashboard needs.
--   * Add admin_set_user_status(target_id uuid, new_status text) as a
--     SECURITY DEFINER RPC so admins can activate / deactivate any user, with a
--     role guard so only admins can call it and admins cannot deactivate
--     themselves (matching the UI intent).
--
-- Apply: run this in the Supabase SQL editor (Dashboard ▸ SQL Editor ▸ New query)
-- or via `supabase db execute` / psql against the project database. It is
-- idempotent (CREATE OR REPLACE) and safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- The live project may carry an older admin_get_all_users / admin_set_user_status
-- with a different return type; CREATE OR REPLACE cannot change a return type
-- (error 42P13), so drop first. Dropping is dependency-free here: nothing
-- references these functions in policies or views.
do $guard$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'profiles'
  ) then
    -- No profiles table yet (fresh database): 002 creates it plus these RPCs.
    return;
  end if;

drop function if exists public.admin_get_all_users();
drop function if exists public.admin_set_user_status(uuid, text);

-- 1) Working, unambiguous admin user list.
--    SECURITY DEFINER + explicit table aliases remove both the RLS barrier and
--    the PL/pgSQL name-clash that broke the previous version. Returns the full
--    profile row (setof public.profiles) so the client gets every column it
--    needs without having to match a fixed RETURNS TABLE signature (which would
--    break if role/status are enum types rather than text).
create or replace function public.admin_get_all_users()
returns setof public.profiles
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only authenticated admins may enumerate users.
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ) then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;

  return query
    select p.*
    from public.profiles p
    order by p.created_at desc;
end;
$$;

-- 2) Admin activate / deactivate RPC (replaces the RLS-blocked client update).
--    new_status is typed as the profiles.status column (%TYPE) so it works
--    whether status is text or an enum.
create or replace function public.admin_set_user_status(
  target_id uuid,
  new_status public.profiles.status%type
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ) then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;

  if new_status::text not in ('active', 'inactive') then
    raise exception 'Invalid status: use active or inactive' using errcode = '22023';
  end if;

  -- Prevent an admin from locking themselves out.
  if target_id = auth.uid() then
    raise exception 'You cannot change your own status' using errcode = '44000';
  end if;

  update public.profiles p
     set status      = new_status,
         updated_at  = now()
   where p.id = target_id;

  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Grant execute so the anon/authenticated roles can invoke these through
-- PostgREST. SECURITY DEFINER already bypasses RLS; the function bodies enforce
-- the admin guard themselves.
grant execute on function public.admin_get_all_users() to anon, authenticated;
grant execute on function public.admin_set_user_status(uuid, public.profiles.status%type) to anon, authenticated;

-- Refresh the PostgREST schema cache so the (re)defined functions are picked up
-- immediately (Supabase listens for this notification).
notify pgrst, 'reload schema';
end;
$guard$;

