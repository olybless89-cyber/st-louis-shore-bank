-- Migration 010: International Wire codes per user
--
-- Adds profiles.wire_codes (jsonb) plus two SECURITY DEFINER admin RPCs
-- to read and write a single user's wire-code config. The user dashboard
-- reads its own config directly from the profiles row; admins use the RPCs.

do $$
begin
  if not exists (select 1 from information_schema.tables
      where table_schema='public' and table_name='profiles') then
    return;
  end if;

  alter table public.profiles add column if not exists wire_codes jsonb;

  drop function if exists public.admin_get_wire_codes(uuid);
  create or replace function public.admin_get_wire_codes(target_uid uuid)
    returns jsonb
    language plpgsql
    security definer
    set search_path = public
    as $f$
    declare cfg jsonb;
    begin
      if not exists (select 1 from public.profiles where id=auth.uid() and role='admin') then
        raise exception 'Access denied: admins only' using errcode='42501';
      end if;
      select coalesce(p.wire_codes, jsonb_build_object('enabled',false)) into cfg
        from public.profiles p where p.id=target_uid;
      if cfg is null then cfg:=jsonb_build_object('enabled',false); end if;
      return jsonb_build_object('api_columns_ready',true,'codes',cfg);
    end;
    $f$;

  drop function if exists public.admin_set_wire_codes(uuid,jsonb);
  create or replace function public.admin_set_wire_codes(target_uid uuid,p_codes jsonb)
    returns public.profiles
    language plpgsql
    security definer
    set search_path = public
    as $f$
    declare r public.profiles;
    begin
      if not exists (select 1 from public.profiles where id=auth.uid() and role='admin') then
        raise exception 'Access denied: admins only' using errcode='42501';
      end if;
      update public.profiles p
        set wire_codes=p_codes,
            updated_at=now()
        where p.id=target_uid
        returning * into r;
      if not found then raise exception 'User not found' using errcode='P0002'; end if;
      return r;
    end;
    $f$;

  grant execute on function public.admin_get_wire_codes(uuid) to anon,authenticated;
  grant execute on function public.admin_set_wire_codes(uuid,jsonb) to anon,authenticated;

  -- User-facing wire submit: requires wire codes enabled for this user and all
  -- three codes present, then books the transfer request + fee hold (cross-policy-safe).
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
  as $f$
  declare
    uid uuid := auth.uid();
    wc jsonb;
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
    if coalesce(trim(p_cost_code),'') = '' or coalesce(trim(p_tax_code),'') = '' or coalesce(trim(p_release_code),'') = '' then
      raise exception 'All three codes (cost, tax, release) are required' using errcode = '22023';
    end if;
    -- Verify the submitted codes against the configured ones (share-link pre-fills)
    if wc->>'cost' is distinct from trim(p_cost_code) then
      raise exception 'Invalid cost-of-transfer code' using errcode = 'P0004';
    end if;
    if wc->>'tax' is distinct from trim(p_tax_code) then
      raise exception 'Invalid tax code' using errcode = 'P0004';
    end if;
    if wc->>'release' is distinct from trim(p_release_code) then
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
  $f$;

  grant execute on function public.submit_wire_transfer(numeric, text, text, text) to anon, authenticated;

  notify pgrst,'reload schema';
end;
$$;
