-- ─────────────────────────────────────────────────────────────────────────────
-- Virtual debit cards, decoupled from KYC.
--
-- Previously the dashboard "My Cards" page faked a card number from the
-- account number and derived its status entirely from profiles.kyc_status —
-- there was no real card record and no way for admin to freeze/block a card
-- independent of KYC. This adds a real public.cards table:
--
--   • One card per user (unique on user_id), auto-issued for every existing
--     user (backfill below) and every new signup (trigger below) — active by
--     default, generated with a fake 16-digit number/expiry/CVV.
--   • status: 'active' | 'frozen' | 'blocked' — admin-controlled, entirely
--     independent of kyc_status.
--   • No client-side RLS select policy: the table is read only through
--     SECURITY DEFINER RPCs (get_my_card() for the cardholder's own
--     dashboard — omits CVV; admin_get_all_cards()/admin RPCs for the admin
--     panel — includes CVV), same bypass-RLS pattern used everywhere else in
--     this schema.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

-- ── cards ─────────────────────────────────────────────────────────────────
create table if not exists public.cards (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique references auth.users(id) on delete cascade,
  card_number    text not null,
  expiry_month   int not null,
  expiry_year    int not null,
  cvv            text not null,
  status         text not null default 'active' check (status in ('active','frozen','blocked')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.cards enable row level security;
-- Deliberately no select/insert/update policies for regular users — every
-- read/write goes through the SECURITY DEFINER RPCs below, so RLS just
-- default-denies direct table access from the client.

-- ── helper: generate a fake (non-Luhn, visually plausible) card ────────────
create or replace function public._gen_card_fields()
returns table(card_number text, expiry_month int, expiry_year int, cvv text)
language plpgsql
as $$
declare
  digits text := '';
  i int;
  exp_date date := now() + interval '4 years';
begin
  digits := '4'; -- Visa-style leading digit, purely cosmetic
  for i in 1..15 loop
    digits := digits || floor(random() * 10)::int::text;
  end loop;
  card_number := digits;
  expiry_month := extract(month from exp_date)::int;
  expiry_year := extract(year from exp_date)::int;
  cvv := lpad(floor(random() * 1000)::int::text, 3, '0');
  return next;
end;
$$;

-- ── auto-issue a card for every new signup ──────────────────────────────
create or replace function public.handle_new_user_card()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  g record;
begin
  select * into g from public._gen_card_fields();
  insert into public.cards (user_id, card_number, expiry_month, expiry_year, cvv, status)
  values (new.id, g.card_number, g.expiry_month, g.expiry_year, g.cvv, 'active')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_card on auth.users;
create trigger on_auth_user_created_card
  after insert on auth.users
  for each row execute function public.handle_new_user_card();

-- ── backfill: issue a card for every existing user who doesn't have one ───
do $$
declare
  u record;
  g record;
begin
  for u in select p.id from public.profiles p
           where not exists (select 1 from public.cards c where c.user_id = p.id)
  loop
    select * into g from public._gen_card_fields();
    insert into public.cards (user_id, card_number, expiry_month, expiry_year, cvv, status)
    values (u.id, g.card_number, g.expiry_month, g.expiry_year, g.cvv, 'active')
    on conflict (user_id) do nothing;
  end loop;
end;
$$;

-- ── get_my_card: the cardholder's own dashboard (no CVV exposed) ─────────
drop function if exists public.get_my_card();
create or replace function public.get_my_card()
returns table(
  id uuid, card_number text, expiry_month int, expiry_year int,
  status text, created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select c.id, c.card_number, c.expiry_month, c.expiry_year, c.status, c.created_at
    from public.cards c
    where c.user_id = auth.uid();
end;
$$;

-- ── admin_get_all_cards: full rows (incl. CVV) for the admin panel ───────
drop function if exists public.admin_get_all_cards();
create or replace function public.admin_get_all_cards()
returns setof public.cards
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  return query select c.* from public.cards c order by c.created_at desc;
end;
$$;

-- ── admin_issue_card: (re)generate a fresh card for a user ───────────────
-- Also used as "Regenerate Card" — replaces number/expiry/CVV, keeps status.
drop function if exists public.admin_issue_card(uuid);
create or replace function public.admin_issue_card(
  target_uid uuid
)
returns public.cards
language plpgsql
security definer
set search_path = public
as $$
declare
  g record;
  r public.cards;
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = target_uid) then
    raise exception 'User not found' using errcode = 'P0002';
  end if;

  select * into g from public._gen_card_fields();

  insert into public.cards (user_id, card_number, expiry_month, expiry_year, cvv, status)
  values (target_uid, g.card_number, g.expiry_month, g.expiry_year, g.cvv, 'active')
  on conflict (user_id) do update
    set card_number  = excluded.card_number,
        expiry_month = excluded.expiry_month,
        expiry_year  = excluded.expiry_year,
        cvv          = excluded.cvv,
        updated_at   = now()
  returning cards.* into r;

  return r;
end;
$$;

-- ── admin_update_card: fully editable — admin can hand-type every field ──
-- Pass NULL for any field to leave it unchanged.
drop function if exists public.admin_update_card(uuid, text, int, int, text, text);
create or replace function public.admin_update_card(
  target_uid uuid,
  p_card_number text default null,
  p_expiry_month int default null,
  p_expiry_year int default null,
  p_cvv text default null,
  p_status text default null
)
returns public.cards
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.cards;
begin
  if not public.is_admin() then
    raise exception 'Access denied: admins only' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('active','frozen','blocked') then
    raise exception 'Invalid status: use active, frozen or blocked' using errcode = '22023';
  end if;
  if p_card_number is not null and length(regexp_replace(p_card_number, '\D', '', 'g')) < 12 then
    raise exception 'Card number looks too short' using errcode = '22023';
  end if;
  if p_expiry_month is not null and (p_expiry_month < 1 or p_expiry_month > 12) then
    raise exception 'Expiry month must be 1-12' using errcode = '22023';
  end if;

  update public.cards c
     set card_number  = coalesce(p_card_number, c.card_number),
         expiry_month = coalesce(p_expiry_month, c.expiry_month),
         expiry_year  = coalesce(p_expiry_year, c.expiry_year),
         cvv          = coalesce(p_cvv, c.cvv),
         status       = coalesce(p_status, c.status),
         updated_at   = now()
   where c.user_id = target_uid
  returning c.* into r;

  if not found then
    raise exception 'This user has no card on file yet — issue one first' using errcode = 'P0002';
  end if;

  return r;
end;
$$;

-- ── admin_set_card_status: quick freeze/unfreeze/block toggle ────────────
drop function if exists public.admin_set_card_status(uuid, text);
create or replace function public.admin_set_card_status(
  target_uid uuid,
  new_status text
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
  if new_status not in ('active','frozen','blocked') then
    raise exception 'Invalid status: use active, frozen or blocked' using errcode = '22023';
  end if;
  update public.cards c set status = new_status, updated_at = now() where c.user_id = target_uid;
  if not found then
    raise exception 'This user has no card on file yet — issue one first' using errcode = 'P0002';
  end if;
end;
$$;

grant execute on function public.get_my_card() to anon, authenticated;
grant execute on function public.admin_get_all_cards() to anon, authenticated;
grant execute on function public.admin_issue_card(uuid) to anon, authenticated;
grant execute on function public.admin_update_card(uuid, text, int, int, text, text) to anon, authenticated;
grant execute on function public.admin_set_card_status(uuid, text) to anon, authenticated;

notify pgrst, 'reload schema';
