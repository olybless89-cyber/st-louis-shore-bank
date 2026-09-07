-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 011: Admin-managed deposit payment methods.

-- Problem: the customer deposit page hard-codes the Bitcoin wallet address,
-- bank-transfer details, and PayPal details in dashboard.html
-- (WALLET_ADDRESS constant + DEP_METHOD_INFO map), so changing any
-- deposit destination requires a code deployment. There is no database
-- table for this configuration.


-- Fix: a `payment_methods` table (one row per method: bitcoin,
-- bank_transfer, paypal) storing the admin-configurable fields, seeded
-- with the previously-hard-coded values so the current behaviour is preserved.
-- Admin reads/writes go through SECURITY DEFINER, admin-guarded RPCs
-- (same pattern as admin_get_wire_codes / admin_set_wire_codes. Customers
-- read ONLY the active methods via a separate SECURITY DEFINER
-- `get_active_payment_methods` RPC that exposes just the fields needed to
-- render the deposit page -- no admin-only data (updated_at only)and no
-- writes. RLS is enabled on the table and ALL direct client reads/writes are
-- disabled for non-postgres roles so the only access paths are the two RPCs.


-- Does NOT touch deposit_requests / transactions — no existing customer data
-- is affected. Idempotent; safe no-op when the `profiles` table is absent.



do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'profiles'
  ) then
    return;
  end if;

  create table if not exists public.payment_methods (
    id            text primary key check (id in ('bitcoin','bank_transfer','paypal')),
    active       boolean not null default true,
    wallet_address   text,
    network          text,
    bank_name        text,
    account_name      text,
    account_number    text,
    swift_bic        text,
    iban             text,
    bank_address      text,
    currency         text,
    paypal_email      text,
    instructions       text,
    updated_by        uuid references auth.users(id),
    updated_at        timestamptz not null default now()
  );

  insert into public.payment_methods (id, active, wallet_address, network, bank_name, account_name, account_number, swift_bic, iban, bank_address, currency, paypal_email, instructions)
  values
    ('bitcoin', true, 'bc1q83l2870qn970jgc3y0ac6jaa6wl9gg4vc847zj', 'Bitcoin (BTC) Mainnet',
     null, null, null, null, null, null, null, null,
     'Send only BTC to the wallet address above. After sending, click "Continue to Deposit" so admin can verify and credit your account. Confirmations may take up to 1 hour.'),
    ('bank_transfer', true, null, null,
     'St Louis Shore Bank', 'St Louis Shore Bank Operations', '482100017788',
     'BFBBUS33', 'GB29NWBK60161331926819', '1 Threadneedle Street, London, EC2R 8AH, United Kingdom', 'USD', null,
     'Please include your wallet address as the transfer reference. Funds credited within 1–3 business days after admin approval.'),
    ('paypal', true, null, null,
     null, null, null, null, null, null, null,
     'deposits@stlouisshorebank.com',
     'Send your payment via PayPal to the address above, then click "Continue to Deposit" to submit your request. Include your St Louis Shore Bank wallet address in the PayPal note. PayPal deposits are reviewed within 24 hours.')
  on conflict (id) do nothing;

  alter table public.payment_methods enable row level security;

  drop function if exists public.admin_get_payment_methods();
  create or replace function public.admin_get_payment_methods()
  returns setof public.payment_methods
  language plpgsql
  security definer
  set search_path = public
  as $f$
  begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid()and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    return query
      select m.* from public.payment_methods m
      order by case m.id when 'bitcoin' then 1 when 'bank_transfer' then 2 else 3 end;
  end;
  $f$;

  drop function if exists public.admin_update_payment_method(text, jsonb);
  create or replace function public.admin_update_payment_method(
    p_method text,
    p_patch jsonb
  )
  returns public.payment_methods
  language plpgsql
  security definer
  set search_path = public
  as $f$
  declare
    r public.payment_methods;
    v_active        boolean;
    v_wallet        text;
    v_network        text;
    v_bank_name      text;
    v_account_name    text;
    v_account_number  text;
    v_swift          text;
    v_iban           text;
    v_bank_address    text;
    v_currency        text;
    v_paypal_email    text;
    v_instructions     text;
  begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid()and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    if p_method not in ('bitcoin','bank_transfer','paypal') then
      raise exception 'Invalid payment method' using errcode = '22023';
    end if;
    if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
      raise exception 'Invalid payload' using errcode = '22023';
    end if;

    select m.* into r from public.payment_methods m where m.id = p_method;

    if not found then
      raise exception 'Payment method not found' using errcode = 'P0002';
    end if;

    v_active        := coalesce(case when p_patch ? 'active' then (p_patch->>'active')::boolean else r.active end, r.active);
    v_wallet        := coalesce(nullif(trim(coalesce(p_patch->>'wallet_address', '')), ''), r.wallet_address);
    v_network        := coalesce(nullif(trim(coalesce(p_patch->>'network', '')), ''), r.network);
    v_bank_name      := coalesce(nullif(trim(coalesce(p_patch->>'bank_name', '')), ''), r.bank_name);
    v_account_name    := coalesce(nullif(trim(coalesce(p_patch->>'account_name', '')), ''), r.account_name);
    v_account_number  := coalesce(nullif(trim(coalesce(p_patch->>'account_number', '')), ''), r.account_number);
    v_swift          := coalesce(nullif(trim(coalesce(p_patch->>'swift_bic', '')), ''), r.swift_bic);
    v_iban           := coalesce(nullif(trim(coalesce(p_patch->>'iban', '')), ''), r.iban);
    v_bank_address    := coalesce(nullif(trim(coalesce(p_patch->>'bank_address', '')), ''), r.bank_address);
    v_currency        := coalesce(nullif(trim(coalesce(p_patch->>'currency', '')), ''), r.currency);
    v_paypal_email    := coalesce(nullif(trim(coalesce(p_patch->>'paypal_email', '')), ''), r.paypal_email);
    v_instructions     := coalesce(nullif(trim(coalesce(p_patch->>'instructions', '')), ''), r.instructions);

    if p_method = 'bitcoin'and coalesce(v_wallet,'') = '' then
      raise exception 'Bitcoin wallet address is required' using errcode = '22023';
    end if;
    if p_method = 'bank_transfer' then
      if coalesce(trim(v_bank_name),'') = '' or coalesce(trim(v_account_name),'') = '' or coalesce(trim(v_account_number),'') = '' then
        raise exception 'Bank name, account name and account number are required for Bank Transfer' using errcode = '22023';
      end if;
    end if;
    if p_method = 'paypal'and coalesce(v_paypal_email,'') = '' then
      raise exception 'PayPal email is required' using errcode = '22023';
    end if;
    if p_method = 'paypal'and v_paypal_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Invalid PayPal email address' using errcode = '22023';
    end if;

    update public.payment_methods m
      set active          = v_active,
          wallet_address  = case when p_method = 'bitcoin' then v_wallet else m.wallet_address end,
          network         = case when p_method = 'bitcoin' then v_network else m.network end,
          bank_name       = case when p_method = 'bank_transfer' then v_bank_name else m.bank_name end,
          account_name     = case when p_method = 'bank_transfer' then v_account_name else m.account_name end,
          account_number   = case when p_method = 'bank_transfer' then v_account_number else m.account_number end,
          swift_bic       = case when p_method = 'bank_transfer' then v_swift else m.swift_bic end,
          iban            = case when p_method = 'bank_transfer' then v_iban else m.iban end,
          bank_address     = case when p_method = 'bank_transfer' then v_bank_address else m.bank_address end,
          currency        = case when p_method = 'bank_transfer' then v_currency else m.currency end,
          paypal_email     = case when p_method = 'paypal' then v_paypal_email else m.paypal_email end,
          instructions     = v_instructions,
          updated_by      = auth.uid(),
          updated_at      = now()
      where m.id = p_method
      returning * into r;
    return r;
  end;
  $f$;

  drop function if exists public.admin_toggle_payment_method(text, boolean);
  create or replace function public.admin_toggle_payment_method(
    p_method text,
    p_active boolean
  )
  returns public.payment_methods
  language plpgsql
  security definer
  set search_path = public
  as $f$
  declare r public.payment_methods; begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid()and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    if p_method not in ('bitcoin','bank_transfer','paypal') then
      raise exception 'Invalid payment method' using errcode = '22023';
    end if;
    update public.payment_methods m
      set active = coalesce(p_active, not m.active), updated_by = auth.uid(), updated_at = now()
      where m.id = p_method
      returning * into r;
    if not found then
      raise exception 'Payment method not found' using errcode = 'P0002'; end if;
    return r;
  end;
  $f$;

  drop function if exists public.get_active_payment_methods();
  create or replace function public.get_active_payment_methods()
  returns table (
    id text,
    wallet_address text,
    network text,
    bank_name text,
    account_name text,
    account_number text,
    swift_bic text,
    iban text,
    bank_address text,
    currency text,
    paypal_email text,
    instructions text,
    updated_at timestamptz
  )
  language plpgsql
  security definer
  set search_path = public
  as $f$
  begin
    return query
      select m.id,
             m.wallet_address,
             m.network,
             m.bank_name,
             m.account_name,
             m.account_number,
             m.swift_bic,
             m.iban,
             m.bank_address,
             m.currency,
             m.paypal_email,
             m.instructions,
             m.updated_at
        from public.payment_methods m
        where m.active = true
        order by case m.id when 'bitcoin' then 1 when 'bank_transfer' then 2 else 3 end;
  end;
  $f$;

  grant execute on function public.admin_get_payment_methods()               to anon, authenticated;
  grant execute on function public.admin_update_payment_method(text, jsonb) to anon, authenticated;
  grant execute on function public.admin_toggle_payment_method(text, boolean) to anon, authenticated;
  grant execute on function public.get_active_payment_methods()               to anon, authenticated;

  notify pgrst,'reload schema';
end;
$$;
