-- ─────────────────────────────────────────────────────────────────────────────
-- Admin per-user + live-chat RPCs.
--
-- Problem: the admin "Manage user" drawer and the Live Chat panel still
-- read/write user-owned rows directly from the client:
--   * openReleaseModal / openTxnHistory select from `transactions` filtered by
--     another user's id — blocked by the `auth.uid() = user_id` RLS policy, so
--     the admin sees no holds / no history for any non-self user.
--   * loadLiveChats / pollLcSession select from `support_tickets`; sendLcReply
--     and updateLcStatus UPDATE `support_tickets` — both blocked by RLS for any
--     ticket owned by another user (the live chat silently fails to load/reply).
--
-- Fix: SECURITY DEFINER, admin-guarded RPCs for these cross-user reads/writes.
-- Idempotent; safe no-op when `public.profiles` is absent.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'profiles'
  ) then
    return;
  end if;

  -- ── All transactions for a specific user (admin view) ──
  -- Optional type/status filters narrow the result (used by the release-hold
  -- modal: type='hold', status='active'). Returns all when filters are null.
  drop function if exists public.admin_get_user_transactions(uuid, text, text);
  create or replace function public.admin_get_user_transactions(
    target_uid uuid, filter_type text default null, filter_status text default null
  )
  returns setof public.transactions
  language plpgsql security definer set search_path = public
  as $f$
  begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    return query
      select t.* from public.transactions t
      where t.user_id = target_uid
        and (filter_type   is null or t.type   = filter_type)
        and (filter_status is null or t.status = filter_status)
      order by t.created_at desc;
  end;
  $f$;

  -- ── Live chat: append an admin line to a ticket's message thread ──
  -- Appends "\n---\n[admin] <msg> [<rfc3339>]" to the existing message and
  -- bumps updated_at; optionally records admin_reply and a new status.
  -- Param is p_admin_reply (not admin_reply) to avoid a PL/pgSQL var/column
  -- name clash with support_tickets.admin_reply ("column reference is
  -- ambiguous"), the same class of bug as the old admin_get_all_users issue.
  drop function if exists public.admin_append_ticket_message(uuid, text, text, text);
  create or replace function public.admin_append_ticket_message(
    ticket_id uuid, msg text, p_admin_reply text default null, new_status text default null
  )
  returns public.support_tickets
  language plpgsql security definer set search_path = public
  as $f$ declare r public.support_tickets; cur text; begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    select coalesce(t.message, '') into cur from public.support_tickets t where t.id = ticket_id;
    if not found then raise exception 'Ticket not found' using errcode = 'P0002'; end if;
    update public.support_tickets t
       set message    = cur || E'\n---\n[admin] ' || msg || ' [' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || ']',
           admin_reply = coalesce(p_admin_reply, msg),
           status      = coalesce(new_status, t.status),
           updated_at  = now()
     where t.id = ticket_id
     returning * into r;
    return r;
  end;
  $f$;

  -- ── Live chat: change a ticket's status ──
  drop function if exists public.admin_set_ticket_status(uuid, text);
  create or replace function public.admin_set_ticket_status(
    ticket_id uuid, new_status text
  )
  returns void
  language plpgsql security definer set search_path = public
  as $f$ begin
    if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') then
      raise exception 'Access denied: admins only' using errcode = '42501';
    end if;
    update public.support_tickets t set status = new_status, updated_at = now() where t.id = ticket_id;
  end;
  $f$;

  grant execute on function public.admin_get_user_transactions(uuid, text, text) to anon, authenticated;
  grant execute on function public.admin_append_ticket_message(uuid, text, text, text) to anon, authenticated;
  grant execute on function public.admin_set_ticket_status(uuid, text) to anon, authenticated;

  notify pgrst, 'reload schema';
end;
$$;
