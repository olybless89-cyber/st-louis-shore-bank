-- ─────────────────────────────────────────────────────────────────────────────
-- Admin "read-all" RPCs for the approval tables.
--
-- Problem: deposit_requests, transfer_requests, loan_applications,
-- support_tickets and transactions all have RLS SELECT policies of
-- `auth.uid() = user_id` (own-row only). The admin dashboard reads these
-- tables directly from the client, so an admin can only ever see their OWN
-- rows — every approval table appears empty even when rows exist (the
-- SECURITY DEFINER stats RPCs count them, but the client list read is
-- RLS-blocked). Same bug class as the old admin_get_all_users issue.
--
-- Fix: SECURITY DEFINER functions that return every row, admin-guarded, so
-- the admin dashboard can list + review other users' requests. Idempotent.
--
-- NOTE: targets the `public.profiles` (uuid id) schema. Clean no-op on
-- projects that use a different user table (guarded on `public.profiles`
-- existing), so it is safe to run in a migration set alongside a
-- users-based migration.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'profiles'
  ) then
    return;
  end if;

  -- ── Deposits ──
  drop function if exists public.admin_get_all_deposits();
  drop function if exists public.admin_get_all_transfers();
  drop function if exists public.admin_get_all_loans();
  drop function if exists public.admin_get_all_tickets();
  drop function if exists public.admin_get_all_transactions();
  drop function if exists public.admin_get_deposit(uuid);
  drop function if exists public.admin_get_transfer(uuid);
  drop function if exists public.admin_get_loan(uuid);
  drop function if exists public.admin_get_ticket(uuid);
  drop function if exists public.admin_send_message(uuid, text, text, text);
  create or replace function public.admin_get_all_deposits()
  returns setof public.deposit_requests
  language plpgsql security definer set search_path = public
  as $f$
  begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    return query select d.* from public.deposit_requests d order by d.created_at desc;
  end;
  $f$;

  -- ── Transfers ──
  create or replace function public.admin_get_all_transfers()
  returns setof public.transfer_requests
  language plpgsql security definer set search_path = public
  as $f$
  begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    return query select t.* from public.transfer_requests t order by t.created_at desc;
  end;
  $f$;

  -- ── Loans ──
  create or replace function public.admin_get_all_loans()
  returns setof public.loan_applications
  language plpgsql security definer set search_path = public
  as $f$
  begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    return query select l.* from public.loan_applications l order by l.created_at desc;
  end;
  $f$;

  -- ── Support tickets ──
  create or replace function public.admin_get_all_tickets()
  returns setof public.support_tickets
  language plpgsql security definer set search_path = public
  as $f$
  begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    return query select t.* from public.support_tickets t order by t.created_at desc;
  end;
  $f$;

  -- ── Transactions ──
  create or replace function public.admin_get_all_transactions()
  returns setof public.transactions
  language plpgsql security definer set search_path = public
  as $f$
  begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    return query select t.* from public.transactions t order by t.created_at desc limit 500;
  end;
  $f$;

  -- ── Single-row fetches for the review modals (RLS blocks cross-user reads) ──
  create or replace function public.admin_get_deposit(d_id uuid)
  returns public.deposit_requests language plpgsql security definer set search_path = public
  as $f$ declare r public.deposit_requests; begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501'; end if;
    select d.* into r from public.deposit_requests d where d.id = d_id; return r;
  end; $f$;

  create or replace function public.admin_get_transfer(t_id uuid)
  returns public.transfer_requests language plpgsql security definer set search_path = public
  as $f$ declare r public.transfer_requests; begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501'; end if;
    select t.* into r from public.transfer_requests t where t.id = t_id; return r;
  end; $f$;

  create or replace function public.admin_get_loan(l_id uuid)
  returns public.loan_applications language plpgsql security definer set search_path = public
  as $f$ declare r public.loan_applications; begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501'; end if;
    select l.* into r from public.loan_applications l where l.id = l_id; return r;
  end; $f$;

  create or replace function public.admin_get_ticket(t_id uuid)
  returns public.support_tickets language plpgsql security definer set search_path = public
  as $f$ declare r public.support_tickets; begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501'; end if;
    select t.* into r from public.support_tickets t where t.id = t_id; return r;
  end; $f$;

  -- ── Admin → user message (insert a ticket owned by the target user) ──
  -- Cross-user insert is blocked by the `ticket insert own` RLS policy, so
  -- route it through a SECURITY DEFINER function.
  create or replace function public.admin_send_message(
    target_user uuid, p_subject text, p_body text, p_category text default 'account'
  )
  returns void language plpgsql security definer set search_path = public
  as $f$ begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501'; end if;
    insert into public.support_tickets (user_id, subject, message, category, admin_reply, status)
    values (target_user, p_subject, 'Admin message', p_category, p_body, 'closed');
  end; $f$;

  grant execute on function public.admin_get_all_deposits() to anon, authenticated;
  grant execute on function public.admin_get_all_transfers() to anon, authenticated;
  grant execute on function public.admin_get_all_loans() to anon, authenticated;
  grant execute on function public.admin_get_all_tickets() to anon, authenticated;
  grant execute on function public.admin_get_all_transactions() to anon, authenticated;
  grant execute on function public.admin_get_deposit(uuid) to anon, authenticated;
  grant execute on function public.admin_get_transfer(uuid) to anon, authenticated;
  grant execute on function public.admin_get_loan(uuid) to anon, authenticated;
  grant execute on function public.admin_get_ticket(uuid) to anon, authenticated;
  grant execute on function public.admin_send_message(uuid, text, text, text) to anon, authenticated;

  notify pgrst, 'reload schema';
end;
$$;
