-- ─────────────────────────────────────────────────────────────────────────────
-- St Louis Shore Bank — full application schema (Postgres / Supabase).
--
-- This reconstructs the live Supabase project's application layer from the
-- client code so the site can run against any Supabase instance (local or
-- hosted). It defines every table the JS talks to, the RLS policies, the
-- auth.users -> profiles auto-provision trigger, and every admin RPC the
-- dashboard/admin pages call — including the FIXED admin_get_all_users and
-- admin_set_user_status from 001_fix_admin_user_management.sql.
--
-- Idempotent: safe to re-run. Designed for Supabase (uses auth.uid(),
-- security definer, notify pgrst). Run in the Supabase SQL editor or via
-- `supabase db execute` / psql.
-- ─────────────────────────────────────────────────────────────────────────────

-- Extension used for gen_random_uuid() fallbacks.
create extension if not exists pgcrypto;

-- ── profiles ──────────────────────────────────────────────────────────────
-- Auto-provisioned on signup by the trigger below. The numeric account_number
-- column is kept (the trigger still generates one for back-compat / uniqueness),
-- but the UI displays the wallet address instead — see dashboard.html.
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             text,
  full_name         text,
  phone             text,
  role              text not null default 'user',
  status            text not null default 'active',
  kyc_status        text not null default 'unverified',
  balance           numeric(14,2) not null default 0,
  held_funds        numeric(14,2) not null default 0,
  account_number    text,
  transaction_limit numeric(14,2) not null default 500000,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Helper to mint a per-user, 10-digit numeric-only account number.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  acct text;
  i int;
begin
  -- Build a 10-digit numeric-only account number.

  acct := '';
  for i in 1..10 loop
    acct := acct || floor(random() * 10)::int::text;  -- digits only
  end loop;
  insert into public.profiles (id, email, full_name, role, status, account_number)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'user',
    'active',
    acct
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── transactions ──────────────────────────────────────────────────────────
create table if not exists public.transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  type          text not null,
  amount        numeric(14,2) not null default 0,
  status        text not null default 'completed',
  description   text,
  reference     text,
  recipient     text,
  held          boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ── deposit_requests ──────────────────────────────────────────────────────
create table if not exists public.deposit_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  amount      numeric(14,2) not null default 0,
  method      text not null default 'bank',
  reference   text,
  status      text not null default 'pending',
  note        text,
  created_at  timestamptz not null default now()
);

-- ── transfer_requests ─────────────────────────────────────────────────────
create table if not exists public.transfer_requests (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  amount             numeric(14,2) not null default 0,
  recipient_name     text,
  recipient_account  text,
  bank_name          text,
  reason             text,
  status             text not null default 'pending',
  note               text,
  created_at         timestamptz not null default now()
);

-- ── loan_applications ─────────────────────────────────────────────────────
create table if not exists public.loan_applications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  amount          numeric(14,2) not null default 0,
  term_months     integer not null default 12,
  purpose         text,
  monthly_income  numeric(14,2),
  status          text not null default 'pending',
  note            text,
  created_at      timestamptz not null default now()
);

-- ── support_tickets ──────────────────────────────────────────────────────
-- Doubles as the "webmail" inbox: rows owned by the user with admin_reply set
-- read as mail "from" the bank. Readable across users by admins (no own-row
-- RLS restriction) so admin can list/reply to every ticket.
create table if not exists public.support_tickets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  category     text not null default 'general',
  subject      text,
  message      text,
  admin_reply  text,
  status       text not null default 'open',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── Row Level Security ────────────────────────────────────────────────────
alter table public.profiles          enable row level security;
alter table public.transactions      enable row level security;
alter table public.deposit_requests  enable row level security;
alter table public.transfer_requests enable row level security;
alter table public.loan_applications enable row level security;
alter table public.support_tickets   enable row level security;

-- profiles: a user can read/update only their own row. Admin reads go through
-- the admin_get_all_users SECURITY DEFINER RPC (bypasses RLS).
drop policy if exists "profiles select own"  on public.profiles;
drop policy if exists "profiles insert own"  on public.profiles;
drop policy if exists "profiles update own"  on public.profiles;
create policy "profiles select own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles insert own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- transactions: own row only (writes happen via admin RPCs / SECURITY DEFINER).
drop policy if exists "txn select own" on public.transactions;
create policy "txn select own" on public.transactions
  for select using (auth.uid() = user_id);
-- allow a user to insert their own transactions (used by client history writes)
drop policy if exists "txn insert own" on public.transactions;
create policy "txn insert own" on public.transactions
  for insert with check (auth.uid() = user_id);

-- deposit_requests: user can read own + insert; admin reviews via RPC.
drop policy if exists "dep select own" on public.deposit_requests;
drop policy if exists "dep insert own" on public.deposit_requests;
create policy "dep select own" on public.deposit_requests
  for select using (auth.uid() = user_id);
create policy "dep insert own" on public.deposit_requests
  for insert with check (auth.uid() = user_id);

-- transfer_requests: read own + insert; admin reviews via RPC.
drop policy if exists "tr select own" on public.transfer_requests;
drop policy if exists "tr insert own" on public.transfer_requests;
create policy "tr select own" on public.transfer_requests
  for select using (auth.uid() = user_id);
create policy "tr insert own" on public.transfer_requests
  for insert with check (auth.uid() = user_id);

-- loan_applications: read own + insert; admin reviews via RPC.
drop policy if exists "loan select own" on public.loan_applications;
drop policy if exists "loan insert own" on public.loan_applications;
create policy "loan select own" on public.loan_applications
  for select using (auth.uid() = user_id);
create policy "loan insert own" on public.loan_applications
  for insert with check (auth.uid() = user_id);

-- support_tickets: readable across users (admin lists all), but a user can
-- only insert/read their own tickets directly. Admin replies via RPC.
drop policy if exists "ticket select own" on public.support_tickets;
drop policy if exists "ticket insert own" on public.support_tickets;
create policy "ticket select own" on public.support_tickets
  for select using (auth.uid() = user_id);
create policy "ticket insert own" on public.support_tickets
  for insert with check (auth.uid() = user_id);

-- ── admin helper: is the caller an admin? ────────────────────────────────
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

-- ── admin_get_all_users (FIXED — see 001_fix_admin_user_management.sql) ──
-- SECURITY DEFINER bypasses RLS; every column is table-qualified (p.col) so
-- there is no PL/pgSQL variable/column ambiguity. Returns the full profile row.
drop function if exists public.admin_get_all_users();
create or replace function public.admin_get_all_users()
returns setof public.profiles
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  return query
    select p.*
    from public.profiles p
    order by p.created_at desc;
end;
$$;

-- Drop-then-create for every admin RPC: the live project may carry older
-- versions with different return types, and CREATE OR REPLACE cannot change a
-- return type (42P13). handle_new_user/is_admin keep plain CREATE OR REPLACE
-- (a trigger / other functions may depend on them and their types are stable).
drop function if exists public.admin_set_user_status(uuid, text);
drop function if exists public.admin_update_kyc(uuid, text);
drop function if exists public.admin_credit_user(uuid, numeric, text);
drop function if exists public.admin_hold_funds(uuid, numeric, text);
drop function if exists public.admin_release_hold(uuid);
drop function if exists public.admin_review_deposit(uuid, text, text);
drop function if exists public.admin_review_transfer(uuid, text, text);
drop function if exists public.admin_review_loan(uuid, text, text);
drop function if exists public.admin_reply_ticket(uuid, text, text);
drop function if exists public.admin_get_stats();

-- ── admin_set_user_status (NEW — replaces RLS-blocked client update) ─────
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
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  if new_status::text not in ('active', 'inactive') then
    raise exception 'Invalid status: use active or inactive' using errcode = '22023';
  end if;
  if target_id = auth.uid() then
    raise exception 'You cannot change your own status' using errcode = '44000';
  end if;
  update public.profiles p
     set status = new_status, updated_at = now()
   where p.id = target_id;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ── admin_update_kyc ──────────────────────────────────────────────────────
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
  update public.profiles p
     set kyc_status = new_kyc_status, updated_at = now()
   where p.id = target_id;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ── admin_credit_user ─────────────────────────────────────────────────────
-- Credits balance and logs a transaction. Triggered from admin "Credit Funds".
create or replace function public.admin_credit_user(
  target_id uuid,
  amount numeric,
  reason text default 'Admin credit'
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
  if amount <= 0 then
    raise exception 'Amount must be positive' using errcode = '22023';
  end if;
  update public.profiles p
     set balance = p.balance + amount, updated_at = now()
   where p.id = target_id;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  insert into public.transactions (user_id, type, amount, status, description, reference)
  values (target_id, 'credit', amount, 'completed', coalesce(reason, 'Admin credit'), 'ADM-' || substr(md5(random()::text), 1, 8));
end;
$$;

-- ── admin_hold_funds ──────────────────────────────────────────────────────
-- Moves funds from balance into held_funds and logs a held transaction.
create or replace function public.admin_hold_funds(
  target_id uuid,
  amount numeric,
  reason text default 'Admin hold'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  txid uuid;
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  if amount <= 0 then
    raise exception 'Amount must be positive' using errcode = '22023';
  end if;
  update public.profiles p
     set balance = p.balance - amount,
         held_funds = p.held_funds + amount,
         updated_at = now()
   where p.id = target_id and p.balance >= amount;
  if not found then
    raise exception 'User not found or insufficient balance' using errcode = 'P0002';
  end if;
  insert into public.transactions (user_id, type, amount, status, description, reference, held)
  values (target_id, 'hold', amount, 'pending', coalesce(reason, 'Admin hold'), 'HLD-' || substr(md5(random()::text), 1, 8), true)
  returning id into txid;
  return txid;
end;
$$;

-- ── admin_release_hold ────────────────────────────────────────────────────
-- Releases a previously held amount: moves it back into balance (or per policy)
-- and marks the hold transaction resolved. Returns the held transaction to
-- balance by default.
create or replace function public.admin_release_hold(
  hold_transaction_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  select t.user_id, t.amount into rec
  from public.transactions t
  where t.id = hold_transaction_id and t.held = true and t.type = 'hold';
  if not found then
    raise exception 'Held transaction not found' using errcode = 'P0002';
  end if;
  update public.profiles p
     set held_funds = greatest(p.held_funds - rec.amount, 0),
         balance = p.balance + rec.amount,
         updated_at = now()
   where p.id = rec.user_id;
  update public.transactions t
     set held = false, status = 'completed'
   where t.id = hold_transaction_id;
end;
$$;

-- ── admin_review_deposit ──────────────────────────────────────────────────
-- approve -> credit the user + mark deposit approved; reject -> mark rejected.
create or replace function public.admin_review_deposit(
  deposit_id uuid,
  new_status text,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_note text := note;
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  if new_status not in ('approved', 'rejected') then
    raise exception 'Invalid status: use approved or rejected' using errcode = '22023';
  end if;
  select d.user_id, d.amount, d.status into rec
  from public.deposit_requests d where d.id = deposit_id;
  if not found then
    raise exception 'Deposit not found' using errcode = 'P0002';
  end if;
  if rec.status = 'approved' then
    raise exception 'Deposit already reviewed' using errcode = '44000';
  end if;
  update public.deposit_requests
     set status = new_status, note = v_note
   where id = deposit_id;
  if new_status = 'approved' then
    update public.profiles p
       set balance = p.balance + rec.amount, updated_at = now()
     where p.id = rec.user_id;
    insert into public.transactions (user_id, type, amount, status, description, reference)
    values (rec.user_id, 'deposit', rec.amount, 'completed', 'Deposit approved', 'DEP-' || deposit_id::text);
  end if;
end;
$$;

-- ── admin_review_transfer ─────────────────────────────────────────────────
-- approve -> debit the user + mark transfer completed; reject -> mark rejected.
create or replace function public.admin_review_transfer(
  transfer_id uuid,
  new_status text,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_note text := note;
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  if new_status not in ('approved', 'rejected') then
    raise exception 'Invalid status: use approved or rejected' using errcode = '22023';
  end if;
  select t.user_id, t.amount, t.status into rec
  from public.transfer_requests t where t.id = transfer_id;
  if not found then
    raise exception 'Transfer not found' using errcode = 'P0002';
  end if;
  if rec.status = 'approved' then
    raise exception 'Transfer already reviewed' using errcode = '44000';
  end if;
  update public.transfer_requests
     set status = new_status, note = v_note
   where id = transfer_id;
  if new_status = 'approved' then
    update public.profiles p
       set balance = p.balance - rec.amount, updated_at = now()
     where p.id = rec.user_id;
    insert into public.transactions (user_id, type, amount, status, description, reference, recipient)
    values (rec.user_id, 'transfer', rec.amount, 'completed', 'Transfer approved', 'TRF-' || transfer_id::text, null);
  end if;
end;
$$;

-- ── admin_review_loan ─────────────────────────────────────────────────────
create or replace function public.admin_review_loan(
  loan_id uuid,
  new_status text,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_note text := note;
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  if new_status not in ('approved', 'rejected') then
    raise exception 'Invalid status: use approved or rejected' using errcode = '22023';
  end if;
  select l.user_id, l.amount, l.status into rec
  from public.loan_applications l where l.id = loan_id;
  if not found then
    raise exception 'Loan not found' using errcode = 'P0002';
  end if;
  if rec.status = 'approved' then
    raise exception 'Loan already reviewed' using errcode = '44000';
  end if;
  update public.loan_applications
     set status = new_status, note = v_note
   where id = loan_id;
  if new_status = 'approved' then
    update public.profiles p
       set balance = p.balance + rec.amount, updated_at = now()
     where p.id = rec.user_id;
    insert into public.transactions (user_id, type, amount, status, description, reference)
    values (rec.user_id, 'loan', rec.amount, 'completed', 'Loan approved', 'LOAN-' || loan_id::text);
  end if;
end;
$$;

-- ── admin_reply_ticket ────────────────────────────────────────────────────
-- Sets admin_reply on a support ticket and (optionally) closes it. The user
-- sees this as an inbox message in the Webmail section.
create or replace function public.admin_reply_ticket(
  ticket_id uuid,
  reply text,
  new_status text default 'closed'
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
  update public.support_tickets
     set admin_reply = reply,
         status = new_status,
         updated_at = now()
   where id = ticket_id;
  if not found then
    raise exception 'Ticket not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ── admin_get_stats ───────────────────────────────────────────────────────
create or replace function public.admin_get_stats()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  result json;
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  select json_build_object(
    'total_users',        (select count(*) from public.profiles),
    'active_users',       (select count(*) from public.profiles where status = 'active'),
    'total_balance',      coalesce((select sum(balance) from public.profiles), 0),
    'total_held',         coalesce((select sum(held_funds) from public.profiles), 0),
    'pending_transfers',  (select count(*) from public.transfer_requests where status = 'pending'),
    'pending_loans',      (select count(*) from public.loan_applications where status = 'pending'),
    'pending_deposits',   (select count(*) from public.deposit_requests where status = 'pending'),
    'open_tickets',       (select count(*) from public.support_tickets where status in ('open','pending')),
    'total_transactions', (select count(*) from public.transactions)
  ) into result;
  return result;
end;
$$;

-- ── grants ────────────────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated;
grant select, insert, update on public.profiles          to anon, authenticated;
grant select, insert            on public.transactions      to anon, authenticated;
grant select, insert            on public.deposit_requests  to anon, authenticated;
grant select, insert            on public.transfer_requests to anon, authenticated;
grant select, insert            on public.loan_applications to anon, authenticated;
grant select, insert            on public.support_tickets   to anon, authenticated;
grant execute on function public.admin_get_all_users()                         to anon, authenticated;
grant execute on function public.admin_set_user_status(uuid, public.profiles.status%type) to anon, authenticated;
grant execute on function public.admin_update_kyc(uuid, public.profiles.kyc_status%type) to anon, authenticated;
grant execute on function public.admin_credit_user(uuid, numeric, text)        to anon, authenticated;
grant execute on function public.admin_hold_funds(uuid, numeric, text)         to anon, authenticated;
grant execute on function public.admin_release_hold(uuid)                       to anon, authenticated;
grant execute on function public.admin_review_deposit(uuid, text, text)        to anon, authenticated;
grant execute on function public.admin_review_transfer(uuid, text, text)       to anon, authenticated;
grant execute on function public.admin_review_loan(uuid, text, text)            to anon, authenticated;
grant execute on function public.admin_reply_ticket(uuid, text, text)          to anon, authenticated;
grant execute on function public.admin_get_stats()                             to anon, authenticated;
grant execute on function public.is_admin()                                    to anon, authenticated;

-- Refresh PostgREST schema cache so the (re)defined functions are visible.
notify pgrst, 'reload schema';
