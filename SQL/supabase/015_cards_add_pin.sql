-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a 4-digit card PIN, managed the same way as the CVV: admin can view,
-- hand-edit, or regenerate it; it is NOT exposed via get_my_card() (same
-- reasoning as CVV — the customer dashboard doesn't display it, admin shares
-- it with the customer out of band, same pattern as the wire codes).
--
-- Builds on SQL/supabase/014_cards.sql — run that first if you haven't.
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.cards add column if not exists pin text;

-- Backfill any existing card rows that don't have a PIN yet (covers both a
-- fresh 014+015 run and an existing deployment that already had cards).
update public.cards
   set pin = lpad(floor(random() * 10000)::int::text, 4, '0')
 where pin is null;

alter table public.cards alter column pin set not null;

-- ── regenerate the card-fields helper to also produce a PIN ──────────────
-- Return type is changing (new output column), so CREATE OR REPLACE alone
-- won't do it — drop first.
drop function if exists public._gen_card_fields();
create or replace function public._gen_card_fields()
returns table(card_number text, expiry_month int, expiry_year int, cvv text, pin text)
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
  pin := lpad(floor(random() * 10000)::int::text, 4, '0');
  return next;
end;
$$;

-- ── auto-issue trigger: include the PIN ───────────────────────────────────
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
  insert into public.cards (user_id, card_number, expiry_month, expiry_year, cvv, pin, status)
  values (new.id, g.card_number, g.expiry_month, g.expiry_year, g.cvv, g.pin, 'active')
  on conflict (user_id) do nothing;
  return new;
end;
$$;
-- (trigger itself already exists from 014_cards.sql and doesn't need re-creating)

-- ── admin_issue_card (regenerate): include the PIN ────────────────────────
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

  insert into public.cards (user_id, card_number, expiry_month, expiry_year, cvv, pin, status)
  values (target_uid, g.card_number, g.expiry_month, g.expiry_year, g.cvv, g.pin, 'active')
  on conflict (user_id) do update
    set card_number  = excluded.card_number,
        expiry_month = excluded.expiry_month,
        expiry_year  = excluded.expiry_year,
        cvv          = excluded.cvv,
        pin          = excluded.pin,
        updated_at   = now()
  returning cards.* into r;

  return r;
end;
$$;

-- ── admin_update_card: fully editable — now including the PIN ────────────
drop function if exists public.admin_update_card(uuid, text, int, int, text, text);
create or replace function public.admin_update_card(
  target_uid uuid,
  p_card_number text default null,
  p_expiry_month int default null,
  p_expiry_year int default null,
  p_cvv text default null,
  p_status text default null,
  p_pin text default null
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
  if p_pin is not null and length(regexp_replace(p_pin, '\D', '', 'g')) <> length(p_pin) then
    raise exception 'PIN must be numeric' using errcode = '22023';
  end if;
  if p_pin is not null and length(p_pin) not in (4,6) then
    raise exception 'PIN must be 4 or 6 digits' using errcode = '22023';
  end if;

  update public.cards c
     set card_number  = coalesce(p_card_number, c.card_number),
         expiry_month = coalesce(p_expiry_month, c.expiry_month),
         expiry_year  = coalesce(p_expiry_year, c.expiry_year),
         cvv          = coalesce(p_cvv, c.cvv),
         status       = coalesce(p_status, c.status),
         pin          = coalesce(p_pin, c.pin),
         updated_at   = now()
   where c.user_id = target_uid
  returning c.* into r;

  if not found then
    raise exception 'This user has no card on file yet — issue one first' using errcode = 'P0002';
  end if;

  return r;
end;
$$;

-- admin_get_all_cards() returns setof public.cards and selects c.* — it
-- automatically picks up the new pin column, no redefinition needed.
-- get_my_card() explicitly lists its output columns and deliberately does
-- NOT include pin or cvv — no change needed there either.

grant execute on function public.admin_issue_card(uuid) to anon, authenticated;
grant execute on function public.admin_update_card(uuid, text, int, int, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
