# Setup — St Louis Shore Bank

This repo auto-deploys on every push to `main`:

1. **GitHub Actions** runs every file in `SQL/supabase/*.sql` against your
   Supabase project (idempotent — safe to re-run against a database that
   already has some or all of it; existing data is left alone).
2. **Railway** (connected to this GitHub repo) rebuilds and redeploys the
   site itself.

There is exactly **one manual step**: creating a Supabase project and
telling this repo about it. Everything below is that one step, done once.

## 1. Create a Supabase project

1. Go to https://supabase.com/dashboard → **New project**.
2. Once it's created, open **Project Settings → API** and copy:
   - **Project URL** — looks like `https://abcdEFGH12345.supabase.co`
   - **anon / public key** (labelled "anon" or "publishable")
   - **Project ref** — the `abcdEFGH12345` part of the URL
3. Open **Project Settings → Access Tokens** (this is account-level, not
   project-level) → **Generate new token** → copy it. This is your
   `SUPABASE_ACCESS_TOKEN`; it's what lets GitHub Actions run migrations
   without ever needing your database password.

You now have 4 values: **Project URL**, **anon key**, **project ref**,
**access token**.

## 2. Add GitHub secrets (so pushes auto-run the migrations)

In your GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**. Add:

| Secret name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | the access token from step 1 |
| `SUPABASE_PROJECT_REF` | the project ref from step 1 |
| `SUPABASE_ANON_KEY` | the anon key from step 1 (used to verify the deploy worked) |

That's it for GitHub. From now on, every push to `main` runs
`.github/workflows/deploy.yml`, which applies every `SQL/supabase/*.sql`
file in order and then does a live probe to confirm the migrations landed.

## 3. Add Railway environment variables (so the live site talks to your database)

In Railway: your project → **Variables**. Add:

| Variable name | Value |
|---|---|
| `SUPABASE_API_URL` | the Project URL from step 1 |
| `SUPABASE_ANON_KEY` | the anon key from step 1 |

`serve.js` reads these at request time and rewrites the placeholder
Supabase URL/key baked into the committed HTML to point at your real
project. Railway already auto-builds and redeploys on every push (that's
what `railway.json` / `nixpacks.toml` / `Procfile` are for) — you're just
telling the running server which database to talk to.

## 4. Push

```bash
git push origin main
```

GitHub Actions runs the migrations, Railway redeploys the app. Watch
progress under your repo's **Actions** tab and Railway's **Deployments**
tab.

## If you already have a Supabase project with some of this schema in it

Nothing extra to do — every file under `SQL/supabase/` is written to be
safe to re-run (`create table if not exists`, `create or replace function`,
`insert ... on conflict do nothing`, etc.). Point the secrets/variables in
steps 2–3 at that existing project and push; the workflow will apply
whatever's missing and leave the rest untouched.

## Creating the first admin user

Sign up a normal account through `/register`, then in the Supabase SQL
Editor run:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

Admin login is at `/admin-login`.

## Troubleshooting

- **Actions tab shows the migration step skipped with a warning** — one of
  the 3 GitHub secrets isn't set. Re-check step 2.
- **Site loads but login/register fail** — the Railway environment
  variables from step 3 aren't set, or Railway hasn't redeployed since you
  added them (redeploy manually from Railway's dashboard if needed).
- **"create_guest_ticket is NOT available" in the Actions log** — the
  migrations didn't reach the project named by `SUPABASE_PROJECT_REF`.
  Double check the ref (no `https://`, no `.supabase.co`, just the id).
