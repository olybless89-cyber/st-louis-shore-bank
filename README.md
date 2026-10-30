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
