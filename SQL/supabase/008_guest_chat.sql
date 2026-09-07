-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: guest (pre-login) live-chat tickets.
--
-- Problem: the chat widget's guest form inserted into public.support_tickets
-- with a placeholder user_id '00000000-0000-...' straight from the browser.
-- That insert fails twice:
--   1. RLS: the insert policy requires auth.uid() = user_id, and a guest has
--      no session (auth.uid() is NULL), so the policy always rejects it.
--   2. FK:  user_id references auth.users(id), so the placeholder UUID is not
--      a valid target even when RLS is bypassed.
-- The widget showed "Message sent!" regardless, silently dropping the message.
--
-- Fix: allow user_id to be NULL and add a SECURITY DEFINER create_guest_ticket
-- RPC that inserts the ticket server-side (bypasses RLS) after basic input
-- validation. Guarded to a no-op when public.support_tickets is absent.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'support_tickets'
  ) then
    return;
  end if;

  alter table public.support_tickets alter column user_id drop not null;

  drop function if exists public.create_guest_ticket(text, text, text);
  create or replace function public.create_guest_ticket(
    p_name text,
    p_email text,
    p_message text
  )
  returns uuid
  language plpgsql
  security definer
  set search_path = public
  as $f$
  declare
    new_id uuid;
  begin
    p_name    = left(trim(p_name),    120);
    p_email   = left(trim(p_email),   200);
    p_message = left(trim(p_message), 4000);
    if p_name = '' or p_email = '' or p_message = '' then
      raise exception 'name, email and message are required' using errcode = '22023';
    end if;
    if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'invalid email address' using errcode = '22023';
    end if;
    insert into public.support_tickets (user_id, category, subject, message, status)
    values (null, 'general',
            'Guest enquiry from ' || p_name,
            p_message || E'\n\n—\nFrom: ' || p_name || ' <' || p_email || '>',
            'open')
    returning id into new_id;
    return new_id;
  end;
  $f$;

  grant execute on function public.create_guest_ticket(text, text, text) to anon, authenticated;

  notify pgrst, 'reload schema';
end;
$$;
