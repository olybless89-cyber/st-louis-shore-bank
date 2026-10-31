-- St Louis Shore Bank — plain Postgres schema (no Supabase, no RLS).
-- Ownership/admin rules that used to live in RLS policies + SECURITY DEFINER
-- RPCs are enforced in server/src/gateway.js and server/src/rpc.js instead.
-- Idempotent: every statement is safe to re-run.

create extension if not exists pgcrypto;

-- ── users (replaces Supabase auth.users) ───────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- ── profiles ────────────────────────────────────────────────────────────
create table if not exists profiles (
  id                uuid primary key references users(id) on delete cascade,
  email             text,
  full_name         text,
  phone             text,
  role              text not null default 'user',
  status            text not null default 'active',
  kyc_status        text not null default 'unverified',
  balance           numeric(14,2) not null default 0,
  held_funds        numeric(14,2) not null default 0,
  account_number    text unique,
  transaction_limit numeric(14,2) not null default 500000,
  wire_codes        jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── transactions ────────────────────────────────────────────────────────
create table if not exists transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  type         text not null,
  amount       numeric(14,2) not null default 0,
  status       text not null default 'completed',
  description  text,
  reference    text,
  recipient    text,
  held         boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ── deposit_requests ────────────────────────────────────────────────────
create table if not exists deposit_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  amount      numeric(14,2) not null default 0,
  method      text not null default 'bank',
  reference   text,
  status      text not null default 'pending',
  note        text,
  created_at  timestamptz not null default now()
);

-- ── transfer_requests ───────────────────────────────────────────────────
create table if not exists transfer_requests (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  amount             numeric(14,2) not null default 0,
  recipient_name     text,
  recipient_account  text,
  bank_name          text,
  reason             text,
  status             text not null default 'pending',
  note               text,
  created_at         timestamptz not null default now()
);

-- ── loan_applications ───────────────────────────────────────────────────
create table if not exists loan_applications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  amount          numeric(14,2) not null default 0,
  term_months     integer not null default 12,
  purpose         text,
  monthly_income  numeric(14,2),
  status          text not null default 'pending',
  note            text,
  created_at      timestamptz not null default now()
);

-- ── support_tickets (also doubles as "webmail" + live chat + guest/contact) ─
create table if not exists support_tickets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete cascade, -- null = guest/contact
  category     text not null default 'general',
  subject      text,
  message      text,
  admin_reply  text,
  status       text not null default 'open',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── payment_methods (admin-configurable deposit destinations) ─────────────
create table if not exists payment_methods (
  id              text primary key check (id in ('bitcoin','bank_transfer','paypal')),
  active          boolean not null default true,
  wallet_address  text,
  network         text,
  bank_name       text,
  account_name    text,
  account_number  text,
  swift_bic       text,
  iban            text,
  bank_address    text,
  currency        text,
  paypal_email    text,
  instructions    text,
  updated_by      uuid references users(id),
  updated_at      timestamptz not null default now()
);

insert into payment_methods (id, active, wallet_address, network, bank_name, account_name, account_number, swift_bic, iban, bank_address, currency, paypal_email, instructions)
values
  ('bitcoin', true, 'bc1q83l2870qn970jgc3y0ac6jaa6wl9gg4vc847zj', 'Bitcoin (BTC) Mainnet',
   null, null, null, null, null, null, null, null,
   'Send only BTC to the wallet address above. After sending, click "Continue to Deposit" so admin can verify and credit your account. Confirmations may take up to 1 hour.'),
  ('bank_transfer', true, null, null,
   'St Louis Shore Bank', 'St Louis Shore Bank Operations', '482100017788',
   'BFBBUS33', 'GB29NWBK60161331926819', '1 Threadneedle Street, London, EC2R 8AH, United Kingdom', 'USD', null,
   'Please include your wallet address as the transfer reference. Funds credited within 1-3 business days after admin approval.'),
  ('paypal', true, null, null,
   null, null, null, null, null, null, null,
   'deposits@stlouisshorebank.com',
   'Send your payment via PayPal to the address above, then click "Continue to Deposit" to submit your request. Include your St Louis Shore Bank wallet address in the PayPal note. PayPal deposits are reviewed within 24 hours.')
on conflict (id) do nothing;

-- ── cards (virtual debit cards) ────────────────────────────────────────
create table if not exists cards (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references users(id) on delete cascade,
  card_number   text not null,
  expiry_month  int not null,
  expiry_year   int not null,
  cvv           text not null,
  pin           text not null,
  status        text not null default 'active' check (status in ('active','frozen','blocked')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── password_resets (our own replacement for Supabase Auth's recover flow) ─
create table if not exists password_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null,
  expires_at  timestamptz not null,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ── otp_codes (email one-time verification codes) ─────────────────────────
create table if not exists otp_codes (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  user_id     uuid references users(id) on delete cascade,
  purpose     text not null default 'verify',
  code_hash   text not null,
  expires_at  timestamptz not null,
  used        boolean not null default false,
  attempts    int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists otp_codes_email_idx on otp_codes (email, purpose, used);

-- ── tx_notifications (idempotency for transaction emails) ──────────────────
-- One row per (transaction, status) notification actually sent, so repeated
-- events / webhook retries never email the customer twice.
create table if not exists tx_notifications (
  id         uuid primary key default gen_random_uuid(),
  dedup_key  text not null unique,
  user_id    uuid references users(id) on delete cascade,
  channel    text not null default 'email',
  sent_at    timestamptz not null default now()
);
