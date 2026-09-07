-- 004_backfill_digit_free_account_numbers.sql
-- Idempotent. Safe to run any number of times.
--
-- HISTORY: this migration used to normalize every digit-bearing
-- account_number into an obsolete letters-only value. The site has since
-- switched to 10-DIGIT NUMERIC-ONLY account numbers (register Edge
-- Function, commit "fix: generate 10-digit numeric-only account numbers
-- on signup"), so that backfill would now renumber — and break — every
-- live account. It has been neutralized.
--
-- What remains: fill in a numeric account_number ONLY for profiles that
-- have none (NULL or empty). Existing account numbers are never touched.

do $$
declare
  r record;
  acct text;
begin
  for r in select id from public.profiles
           where account_number is null or btrim(account_number) = '' loop
    loop
      acct := '';
      for i in 1..10 loop
        acct := acct || floor(random() * 10)::int::text;  -- digits only
      end loop;
      exit when not exists (select 1 from public.profiles where account_number = acct);
    end loop;
    update public.profiles set account_number = acct, updated_at = now() where id = r.id;
  end loop;
end;
$$;
