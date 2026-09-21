# Moving off Supabase — St Louis Shore Bank

Why this exists: the site's Supabase project (`xemnwvaymvnitldpiusx`) has been
**deleted** — it no longer shows up in the Supabase account at all, which is
why `stlouisbank.online` started failing with
`getaddrinfo ENOTFOUND xemnwvaymvnitldpiusx.supabase.co`. Recreating a fresh
Supabase project would only buy time until the next surprise bill, so this
rebuild replaces Supabase entirely with a small self-hosted backend, the same
approach already used for bellinzoneacredit.com.

**There is no data to migrate.** Since the source Supabase project is gone,
there's nothing left to copy — this is a clean rebuild. If you happen to
still have an export of the old data lying around, say so and a migration
script can be written, but as things stand there's nothing to pull from.

## What changed

Unlike bellinzoneacredit (a React SPA + separate API service), this app is a
static multi-page HTML/JS site with **one Node server doing double duty**:
`server/src/index.js` serves both the static pages *and* the `/api/*`
backend from a single Railway service — no second service needed here.

- **Auth** — Supabase Auth → a `users` table (email + bcrypt password hash)
  and JWT bearer tokens, issued by `POST /api/auth/signup` / `/signin`.
  `public/vendor/supabase.js` is no longer the real Supabase SDK — it's a
  drop-in replacement that implements the same `createClient()` /
  `.from().select/insert/update/upsert()` / `.rpc()` / `.auth.*` shape, so
  every existing page's inline JS kept working with (in most files) zero
  changes. `register.html` and `contact.html` needed small edits — see
  below.
- **Database access / row-level security** → `server/src/gateway.js`. Every
  table has a column whitelist and an ownership rule (you can only read/write
  your own rows) playing the same role the original Supabase RLS policies
  did, just enforced in plain JS against the JWT's user id instead of
  Postgres RLS. One hole in the original app is closed here: the real RLS
  policy technically let a signed-in user overwrite *any* column on their own
  profile row (including `role`/`balance`/`status`) since the client only
  ever sent `full_name`/`phone`; this rebuild allows just those two columns
  from the client, same as before in practice, safer in principle.
- **Admin functions** → `server/src/rpc.js` — all ~30 SQL RPCs from the 15
  migrations under `SQL/supabase/` (credit/hold/release funds, KYC review,
  card issuing, wire transfers, ticket management, deposit/transfer/loan
  approval, and so on), reimplemented as plain async functions with the same
  names and parameters, each independently checking admin status.
- **Live chat**: the original widget subscribed to Supabase Realtime for
  instant delivery, with a 5-second poll as a fallback. Realtime doesn't
  exist here, so the widget now relies solely on that same polling loop —
  chat still works, messages just arrive up to 5 seconds later instead of
  instantly. The only user-visible loss is the "!" unread badge not lighting
  up the moment a reply arrives while the panel is closed.
- **Password reset**: `forgot-password.html`/`reset-password.html` work
  unchanged, but the reset link is only **logged server-side** for now — no
  email provider is wired up (see "Known gap" below).

### The two small page edits

- `register.html` — used to call a Supabase Edge Function as a workaround for
  an email-confirmation rate limit that doesn't apply to this backend; it now
  calls `sb.auth.signUp()` directly. Password minimum bumped from 6 to 8
  characters (matches the new backend's requirement).
- `contact.html` — used to call the Supabase REST API directly with a hard
  coded URL/key; now calls `/api/rpc/create_contact_message` on this same
  server.

Nothing else in the HTML/JS needed to change.

## 1. Push the code

Push this repo to `olybless89-cyber/st-louis-shore-bank` (`master`, same repo
Railway already deploys from). No new service to create — the existing
`st-louis-shore-bank` service in the `imaginative-flexibility` project will
just build this new code on its next deploy.

## 2. Point it at a database

You already have a `Postgres` service sitting in the same
`imaginative-flexibility` project (alongside `chihap-website` and
`https-veyloraglobal.com`) — use it instead of paying for a second Postgres
container.

On the **st-louis-shore-bank** service, remove the now-unused
`SUPABASE_ANON_KEY` / `SUPABASE_API_URL` variables and set:

```
DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:${{Postgres.PGPORT}}/stlouisbank
DATABASE_ADMIN_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=<a long random string — e.g. output of `openssl rand -base64 48`>
```

(If your Postgres service isn't literally named `Postgres`, swap it in
above.) `stlouisbank` doesn't need to exist yet — the app creates that
database itself on first boot, using `DATABASE_ADMIN_URL` (a one-time
connection to Postgres's own already-existing default database, just to run
`CREATE DATABASE`), then applies `server/schema.sql` inside it. Every later
deploy just finds the database already there and does nothing extra. This
keeps `chihap-website`'s and `https-veyloraglobal.com`'s data (if either uses
this same Postgres) completely separate — they'd just be sharing one
container instead of each paying for their own.

If you'd rather give this app a fully dedicated Postgres instead: **New →
Database → Add PostgreSQL** in the project, then set `DATABASE_URL` to
`${{Postgres.DATABASE_URL}}` as-is and skip `DATABASE_ADMIN_URL` entirely.
Either way works — the shared option above is just the one that avoids
paying for another container.

## 3. Deploy

Railway should pick this up automatically on push. `railway.json` in this
repo pins the builder to Nixpacks and the start command to
`node server/src/index.js` — if the dashboard's Settings → Build still shows
a different builder from before, switch it to match (or just redeploy; the
`railway.json` in the repo usually wins). Once it's up, confirm:

- `https://stlouisbank.online/health` → `{"ok":true}`
- `https://stlouisbank.online/login` loads and a test signup/signin works
- `https://stlouisbank.online/admin` — sign in with whatever admin account
  you create (see below)

Your custom domain (`stlouisbank.online`) and the Railway subdomain are
already attached to this service and don't need to be touched.

### Creating the first admin

There's no data to migrate, so there's no existing admin account either.
Register a normal account at `/register`, then promote it to admin directly
in the database — easiest from Railway's Postgres service (Data tab, or
`railway connect Postgres`):

```sql
UPDATE profiles SET role = 'admin' WHERE email = 'you@example.com';
```

## Known gap: password-reset emails

`forgot-password.html` → `reset-password.html` works end-to-end, but the
reset link isn't emailed anywhere yet — it's only written to the server logs
(`console.log` in `server/src/auth.js`'s `logResetLink`). That's enough to
test the flow today, but real users won't see it. Wiring up a provider
(Resend, Postmark, SES) is a quick follow-up whenever you want it — happy to
add it.

## Other loose ends

- `app/`, `composer.json`, `SQL/database.sql` — pre-existing unused Laravel
  scaffolding noted in `AGENTS.md`, left untouched, out of scope for this
  migration.
- The 15 files under `SQL/supabase/` are kept as historical reference for
  exactly what the original schema/RPCs did — they're not run anymore
  (`server/schema.sql` is the live schema now) but are useful if you ever
  want to double check a business rule against the original.

## Repeating this for your other apps

Same pattern as bellinzoneacredit.com: a plain-Postgres + Express backend,
bcrypt + JWT auth, a client-side shim so existing pages barely change, and
(optionally) sharing one Postgres container per Railway project instead of
paying for one per app. Worth knowing for next time: this app's shim
(`public/vendor/supabase.js`) uses a flat `{message, code}` error shape
instead of bellinzoneacredit's nested `{error:{message,code}}`, because a
couple of files here (`chat-widget.js`, `contact.html`) call the API with
raw `fetch()` instead of going through the Supabase-shaped client and
already expected that flat shape — worth checking which convention any other
app's hand-written fetch calls (if it has any) actually expect before
copying either pattern wholesale.
