# St Louis Shore Bank

A static HTML/JS digital banking application backed by **Supabase**
(Postgres + Auth + PostgREST). No PHP, no Laravel, no build step — every
page talks to Supabase directly from the browser.

**New to this repo? Start with [SETUP.md](./SETUP.md)** — it walks through
the one manual step (creating your Supabase project) and how to make pushes
to `main` auto-deploy the site and auto-run the database migrations.

## What's included

- **Public site** — home, about, business, personal, cards, loans, apps,
  contact, FAQ, privacy policy, terms of service.
- **Auth** — register/login/logout via Supabase Auth, session persistence,
  forgot/reset password, role-based routing (user vs admin).
- **Customer dashboard** — balance, account number, KYC, deposits,
  transfers, loan applications, virtual card (view status/expiry), webmail,
  notifications, live chat widget.
- **Admin dashboard** — user management (edit/delete), transaction
  management (edit with automatic balance sync), deposit/transfer/loan
  approvals, KYC review, card management (issue/freeze/block/edit/
  regenerate, including PIN), COT/RELEASE/TAX wire codes, support tickets,
  live chat, stats.

## Tech stack

- **Frontend** — static HTML5, inline CSS/JS, no build step.
- **Backend** — Supabase (Postgres + Auth + PostgREST + Edge Functions).
- **Database** — PostgreSQL schema in `SQL/supabase/*.sql`: tables, RLS
  policies, a signup trigger, and `SECURITY DEFINER` admin RPCs. Every
  migration is idempotent (`create table if not exists`,
  `create or replace function`, `insert ... on conflict do nothing`), so
  re-running them against a database that already has some of them applied
  is always safe.
- **Server** — `serve.js` (Node, zero dependencies). Serves `public/` with
  clean-URL routing and rewrites the Supabase URL/anon key embedded in the
  HTML to whatever project you point it at via environment variables — see
  SETUP.md.
- **CI/CD** — `.github/workflows/deploy.yml` runs every SQL migration
  against your Supabase project on every push to `main`, using the Supabase
  Management API (access token + project ref only, no DB password needed).
  Railway (or any Nixpacks-compatible host) auto-builds and redeploys the
  app itself on every push to the connected GitHub repo.

## Running locally

Requires Node 18+.

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/st-louis-shore-bank.git
cd st-louis-shore-bank
PORT=12000 SUPABASE_API_URL=https://YOUR-PROJECT-REF.supabase.co SUPABASE_ANON_KEY=YOUR_ANON_KEY node serve.js
```

Open http://localhost:12000. Without the two environment variables the
server still starts, but auth/data calls fail (by design — see SETUP.md).

## Deploying

See [SETUP.md](./SETUP.md) for the full one-time setup, and the repo root's
`deploy.sh` (delivered alongside this bundle) for the one-command bootstrap
that creates the GitHub repo, pushes this code, and wires up Railway.
