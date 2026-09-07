-- ─────────────────────────────────────────────────────────────────────────────
-- Admin: edit/delete users, edit transactions.
--
-- Adds three SECURITY DEFINER RPCs, all admin-guarded via public.is_admin(),
-- following the exact pattern used throughout 002_full_app_schema.sql
-- (raise exception with errcode, grant execute to anon/authenticated so
-- PostgREST — which always calls as anon/authenticated regardless of the
-- app's own "admin" concept — can invoke them):
--
--   • admin_update_user_profile(target_uid, ...)
--       Directly edits a user's profile: full name, email, account number,
--       balance (direct override), transaction limit. Also mirrors the email
--       change into auth.users so login continues to work with the new
--       address.
--
--   • admin_delete_user(target_uid)
--       PERMANENT delete. Removes the row from auth.users; every app table
--       (profiles, transactions, transfer_requests, loan_applications,
--       deposit_requests, support_tickets) references auth.users(id) on
--       delete cascade, so this cleans up everything belonging to the user
--       in one statement. Irreversible — the admin.html UI is expected to
--       confirm with the admin before calling this.
--
--   • admin_update_transaction(target_id, ...)
--       Edits status, amount, created_at (date/timestamp) and description on
--       an existing transaction. When the amount changes, the owning user's
--       profiles.balance is adjusted by the delta (new_amount - old_amount)
--       so the ledger stays consistent — matches admin_credit_user's pattern
--       of touching balance directly.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── admin_update_user_profile ────────────────────────────────────────────
-- Pass NULL for any field to leave it unchanged (lets the UI submit only the
-- fields that were actually edited).
drop function if exists public.admin_update_user_profile(uuid, text, text, text, numeric, numeric);
create or replace function public.admin_update_user_profile(
  target_uid uuid,
  p_full_name text default null,
  p_email text default null,
  p_account_number text default null,
  p_balance numeric default null,
  p_transaction_limit numeric default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.profiles;
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;

  if p_email is not null and length(trim(p_email)) = 0 then
    raise exception 'Email cannot be blank' using errcode = '22023';
  end if;
  if p_full_name is not null and length(trim(p_full_name)) = 0 then
    raise exception 'Name cannot be blank' using errcode = '22023';
  end if;
  if p_balance is not null and p_balance < 0 then
    raise exception 'Balance cannot be negative' using errcode = '22023';
  end if;
  if p_transaction_limit is not null and p_transaction_limit < 0 then
    raise exception 'Transaction limit cannot be negative' using errcode = '22023';
  end if;

  if p_email is not null and exists (
    select 1 from public.profiles p where p.email = p_email and p.id <> target_uid
  ) then
    raise exception 'Another user already has that email' using errcode = '23505';
  end if;
  if p_account_number is not null and length(trim(p_account_number)) > 0 and exists (
    select 1 from public.profiles p where p.account_number = p_account_number and p.id <> target_uid
  ) then
    raise exception 'Another user already has that account number' using errcode = '23505';
  end if;

  update public.profiles p
     set full_name         = coalesce(p_full_name, p.full_name),
         email              = coalesce(p_email, p.email),
         account_number     = coalesce(p_account_number, p.account_number),
         balance            = coalesce(p_balance, p.balance),
         transaction_limit  = coalesce(p_transaction_limit, p.transaction_limit),
         updated_at         = now()
   where p.id = target_uid
  returning p.* into r;

  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;

  -- Keep auth.users.email in sync so the user can still log in with it.
  if p_email is not null then
    update auth.users set email = p_email where id = target_uid;
  end if;

  return r;
end;
$$;

-- ── admin_delete_user ─────────────────────────────────────────────────────
-- Permanent, irreversible. Cascades to profiles/transactions/transfer_requests
-- /loan_applications/deposit_requests/support_tickets via their FKs.
drop function if exists public.admin_delete_user(uuid);
create or replace function public.admin_delete_user(
  target_uid uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  if target_uid = auth.uid() then
    raise exception 'You cannot delete your own account' using errcode = '44000';
  end if;
  if exists (select 1 from public.profiles p where p.id = target_uid and p.role = 'admin') then
    raise exception 'Cannot delete another admin account' using errcode = '44000';
  end if;

  delete from auth.users where id = target_uid;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ── admin_update_transaction ──────────────────────────────────────────────
-- Pass NULL for any field to leave it unchanged. When p_amount is provided
-- and differs from the current amount, the owning user's balance is adjusted
-- by the delta so it stays consistent with the edited ledger.
drop function if exists public.admin_update_transaction(uuid, text, numeric, timestamptz, text);
create or replace function public.admin_update_transaction(
  target_id uuid,
  p_status text default null,
  p_amount numeric default null,
  p_created_at timestamptz default null,
  p_description text default null
)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.transactions;
  old_amount numeric;
  owner_id uuid;
  delta numeric;
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;

  select t.amount, t.user_id into old_amount, owner_id
  from public.transactions t
  where t.id = target_id;

  if not found then
    raise exception 'Transaction not found' using errcode = 'P0002';
  end if;

  update public.transactions t
     set status      = coalesce(p_status, t.status),
         amount      = coalesce(p_amount, t.amount),
         created_at  = coalesce(p_created_at, t.created_at),
         description = coalesce(p_description, t.description)
   where t.id = target_id
  returning t.* into r;

  if p_amount is not null then
    delta := p_amount - old_amount;
    if delta <> 0 then
      update public.profiles p
         set balance = p.balance + delta, updated_at = now()
       where p.id = owner_id;
    end if;
  end if;

  return r;
end;
$$;

grant execute on function public.admin_update_user_profile(uuid, text, text, text, numeric, numeric) to anon, authenticated;
grant execute on function public.admin_delete_user(uuid) to anon, authenticated;
grant execute on function public.admin_update_transaction(uuid, text, numeric, timestamptz, text) to anon, authenticated;

notify pgrst, 'reload schema';
