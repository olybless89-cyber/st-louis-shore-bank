-- St Louis Shore Bank — fix wire-code `require` flags (2026-09-07)
--
-- Root cause of "Configure codes don't complete the flow":
--   `submit_wire_transfer` unconditionally demanded ALL THREE codes whenever
--   `enabled=true`, but the admin UI lets an admin turn on only some of the
--   per-code `require` toggles ({cost,tax,release}). A user was therefore
--   prompted (via dashboard `wireEnabled()`) for only the required codes, then
--   the RPC rejected the submission because the unrequired codes were missing.

-- This migration makes the RPC enforce exactly the codes whose per-requirement
-- flag is `true`. If the config pre-dates the `require` block (or the block is
--   absent), it falls back to requiring all three (legacy behavior, to avoid
--   silently weakening an existing all-codes config).
--
-- It alsostrictly validates `admin_update_kyc` to the four allowed KYC states so
--   typos can't corrupt `profiles.kyc_status`.
--
-- Idempotent: safe to re-run. Security DEFINER + admin-guarded, no RLS involvement.

drop function if exists public.submit_wire_transfer(numeric, text, text, text);
create or replace function public.submit_wire_transfer(
    p_amount numeric,
    p_cost_code text,
    p_tax_code text,
    p_release_code text
  )
  returns table (amount numeric, type text, reference text, request_id uuid)
  language plpgsql
  security definer
  set search_path = public
  as $fz$
  declare
    uid uuid := auth.uid();
    wc jsonb;
    req_cost boolean;
    req_tax boolean;
    req_release boolean;
    wire_ref text;
    req_id uuid;
  begin
    if uid is null then
      raise exception 'Not authenticated' using errcode = '42501';
    end if;
    select wire_codes into wc from public.profiles where id = uid;
    if wc is null or coalesce(wc->>'enabled', 'false') = 'false' then
      raise exception 'International wire codes are not enabled for this user' using errcode = '44000';
    end if;
    if p_amount is null or p_amount <= 0 then
      raise exception 'Amount must be positive' using errcode = '22023';
    end if;
    -- Per-requirement flags: only codes the admin required are validated. When the
    -- `require` block is absent (legacy config), default to requiring all three.

    if wc ? 'require' then
      req_cost := coalesce((wc -> 'require' ->> 'cost')::boolean, false);
      req_tax := coalesce((wc -> 'require' ->> 'tax')::boolean, false);
      req_release := coalesce((wc -> 'require' ->> 'release')::boolean, false);
    else
      req_cost := true;
      req_tax := true;
      req_release := true;
    end if;
if (req_cost AND  (p_cost_code is null or btrim(p_cost_code) = ''))
       or (req_tax AND  (p_tax_code is null or btrim(p_tax_code) = ''))
       or (req_release AND  (p_release_code is null or btrim(p_release_code) = '')) then
      raise exception 'All required wire codes must be provided' using errcode = '22023';
    end if;
    if req_cost and wc->>'cost' is distinct from trim(p_cost_code) then
      raise exception 'Invalid cost-of-transfer code' using errcode = 'P0004';
    end if;
    if req_tax and wc->>'tax' is distinct from trim(p_tax_code) then
      raise exception 'Invalid tax code' using errcode = 'P0004';
    end if;
    if req_release and wc->>'release' is distinct from trim(p_release_code) then
      raise exception 'Invalid release code' using errcode = 'P0004';
    end if;
    update public.profiles p
       set balance = p.balance - p_amount,
           held_funds = p.held_funds + p_amount,
           updated_at = now()
     where p.id = uid and p.balance >= p_amount;
    if not found then
      raise exception 'Insufficient balance' using errcode = 'P0002';
    end if;
    wire_ref := 'WIRE-' || substr(md5(random()::text), 1, 8);
    insert into public.transfer_requests (user_id, amount, recipient_name, recipient_account, bank_name, reason, note, status)
    values (uid, p_amount, 'International Wire', 'Wire Desk', 'St Louis Shore Bank',
           'International wire (verified codes)', 'Cost: ' || p_cost_code || '; Tax: ' || p_tax_code || '; Release: ' || p_release_code, 'pending')
    returning id into req_id;
    insert into public.transactions (user_id, type, amount, status, description, reference, held)
    values (uid, 'hold', p_amount, 'pending', 'International wire fee hold', wire_ref, true);
    return query select p_amount::numeric, 'transfer', wire_ref::text, req_id::uuid;
  end;
  $fz$;
grant execute on function public.submit_wire_transfer(numeric, text, text, text) to authenticated;

drop function if exists public.admin_update_kyc(uuid, text);
create or replace function public.admin_update_kyc(
  target_id uuid,
  new_kyc_status public.profiles.kyc_status%type
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
  if new_kyc_status is null
     or new_kyc_status not in ('unverified', 'pending', 'verified', 'rejected') then
    raise exception 'Invalid KYC status' using errcode = '22023';
  end if;
  update public.profiles p
     set kyc_status = new_kyc_status, updated_at = now()
   where p.id = target_id;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
end;
$$;
grant execute on function public.admin_update_kyc(uuid, text) to authenticated;