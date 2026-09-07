-- ─────────────────────────────────────────────────────────────────────────────
-- Fix #3: admin deposit/transfer/loan review RPCs threw
--        `column reference "note" is ambiguous`
--        (a PL/pgSQL parameter named `note` clashed with the
--        `deposit_requests.note` / `transfer_requests.note` /
--        `loan_applications.note` column inside `set ..., note = note`),
--        so approving/rejecting any deposit/transfer/loan silently failed.
--
-- Fix #4:the signup trigger now mints a per-user, 10-digit numeric-only
--        account_number, matching the register Edge Function.-- ── admin_review_deposit ───────────────────────────────────────────────────
-- approve -> credit the user + mark deposit approved; reject -> mark rejected.
-- Signature matches the dashboard client call
--   sb.rpc('admin_review_deposit', { deposit_id, new_status, note }).
drop function if exists public.admin_review_deposit(uuid, text, text);
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
drop function if exists public.admin_review_transfer(uuid, text, text);
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
-- approve -> credit the user + mark loan approved; reject -> mark rejected.
drop function if exists public.admin_review_loan(uuid, text, text);
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

-- ── handle_new_user (signup trigger) ──────────────────────────────────────
-- Mint a per-user, 10-digit numeric-only account_number, matching the live
-- register Edge Function (see commit "fix: generate 10-digit numeric-only
-- account numbers on signup"). NOTE: this migration previously minted
-- letters-only `MV`+8 values; that was superseded by the numeric format and
-- must NOT be re-applied, or every account gets renumbered on the next run.
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

-- (Re)create the trigger bound to the updated function. Idempotent.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Re-grant execute on the redefined RPCs (no-op if already granted).
grant execute on function public.admin_review_deposit(uuid, text, text) to anon, authenticated;
grant execute on function public.admin_review_transfer(uuid, text, text) to anon, authenticated;
grant execute on function public.admin_review_loan(uuid, text, text) to anon, authenticated;
