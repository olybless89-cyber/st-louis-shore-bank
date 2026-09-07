-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 009: contact-form messages -> support inbox.
--
-- Problem: the /contact page form POSTs to `homesendcontact`, a dead endpoint
-- from the old PHP app (no routes/ or PHP runtime exist), so every "Send
-- Message" submission is silently lost — nothing ever reaches the admin.
--
-- Fix: a SECURITY DEFINER create_contact_message RPC (same pattern as
-- migration 008's create_guest_ticket) that inserts the message server-side
-- as a support_tickets row with category='contact' and a NULL user_id, so it
-- lands in the admin Email inbox / Support Tickets for a reply. Guests have
-- no session, so a direct client insert would be rejected by RLS.
-- Guarded to a no-op when public.support_tickets is absent. Idempotent.
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

  drop function if exists public.create_contact_message(text, text, text, text);
  create or replace function public.create_contact_message(
    p_name text,
    p_email text,
    p_phone text,
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
    p_phone   = left(trim(coalesce(p_phone, '')), 60);
    p_message = left(trim(p_message), 4000);
    if p_name = '' or p_email = '' or p_message = '' then
      raise exception 'name, email and message are required' using errcode = '22023';
    end if;
    if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'invalid email address' using errcode = '22023';
    end if;
    insert into public.support_tickets (user_id, category, subject, message, status)
    values (null, 'contact',
            'Contact form: ' || p_name,
            p_message || E'\n\n—\nFrom: ' || p_name || ' <' || p_email || '>'
            || case when p_phone <> '' then E'\nPhone: ' || p_phone else '' end,
            'open')
    returning id into new_id;
    return new_id;
  end;
  $f$;

  grant execute on function public.create_contact_message(text, text, text, text) to anon, authenticated;

  notify pgrst, 'reload schema';
end;
$$;
