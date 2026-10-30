# St Louis Shore Bank

Static multi-page site + Express API in **one Node service**, backed by plain Postgres.
No Supabase. Not tied to any host — runs anywhere Docker or Node 18+ runs.

## Deploy (Railway — any account)

1. **New Project → Deploy from GitHub repo** → this repo. It builds from the `Dockerfile`.
2. In the same project: **New → Database → PostgreSQL**.
3. On the app service → **Variables**:
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   JWT_SECRET=<output of: openssl rand -base64 48>
   ```
4. **Settings → Networking → Generate Domain** (port 8080).

That's it. On boot the app creates every table itself (`server/schema.sql`, idempotent).
No manual SQL / psql step is needed.

Check: `https://<your-domain>/health` → `{"ok":true,"db":"ready"}`

- `db: "not_configured"` → `DATABASE_URL` isn't set
- `db: "connecting"` → URL set but Postgres unreachable (wrong URL / DB down) — see deploy logs

The site always boots and passes the healthcheck, even with no database, so a deploy never fails because of DB setup.

## Deploy anywhere else

```bash
docker build -t stlsb .
docker run -p 8080:8080 -e DATABASE_URL=postgresql://... -e JWT_SECRET=... stlsb
```
Or without Docker: `npm ci && DATABASE_URL=... JWT_SECRET=... npm start`

## Variables

| Name | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Any Postgres. Add `?sslmode=require` for hosts that need SSL (Neon, etc.) |
| `JWT_SECRET` | recommended | Falls back to a value derived from `DATABASE_URL` |
| `DATABASE_ADMIN_URL` | no | Only when sharing one Postgres server: app creates its own DB from `DATABASE_URL`'s name |
| `APP_URL` | no | Base for password-reset links (logged server-side; no email provider yet) |
| `AUTO_MIGRATE` | no | `false` to skip auto schema on boot |
| `PORT` | no | Set by host; default 8080 |

## Admin account

Register normally at `/register`, then promote it:
```sql
UPDATE profiles SET role='admin' WHERE email='you@example.com';
```
Sign in at `/admin`.

## Email notifications (OTP + password reset)

The app emails a branded 6-digit OTP on signup and on request, and emails the
password-reset link. It uses plain SMTP, so any provider works.

Set these variables on the service to send real email (until they're set,
emails are printed to the deploy logs so you can still test):

```
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587                         # 465 for SSL, 587 for STARTTLS
SMTP_USER=no-reply@yourdomain.com
SMTP_PASS=<smtp password / app password / API key>
MAIL_FROM=St Louis Shore Bank <no-reply@yourdomain.com>
MAIL_BRAND=St Louis Shore Bank
SUPPORT_EMAIL=support@yourdomain.com
SUPPORT_PHONE=+1 453 598 4512         # optional, shown in the footer
```

Endpoints:
- `POST /api/auth/send-otp` `{ email, purpose }` — purpose: `verify` | `login` | `reset`
- `POST /api/auth/verify-otp` `{ email, code, purpose }` — returns a session token for `login`
- OTP is sent automatically on `POST /api/auth/signup`

Codes are 6 digits, hashed in the `otp_codes` table, expire in 10 minutes, and
lock after 5 wrong attempts.
