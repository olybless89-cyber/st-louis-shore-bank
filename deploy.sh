#!/usr/bin/env bash
# St Louis Shore Bank — bootstrap a NEW GitHub repo from this bundle, wire up
# auto-deploy, and (optionally) create the Railway project.
#
# This is a brand-new, separate project. It does NOT touch any existing
# repo/site you already have — it creates a new folder, a new git repo, and
# (if you let it) a new GitHub repo and Railway project.
#
# HOW TO USE:
#   1. Download st-louis-shore-bank.zip into your Downloads folder (leave it
#      zipped — this script unzips it itself).
#   2. Open Terminal and paste this whole script, then press Enter.
#   3. Answer the prompts (GitHub repo name, whether to create it via `gh`,
#      your Supabase project values if you already created one).
#
# You'll still need to do ONE manual thing that no script can do for you:
# create a Supabase project (https://supabase.com/dashboard -> New project)
# and grab its URL / anon key / project ref / access token. See SETUP.md —
# the script will prompt for these and wire them up for you if you have them
# ready; if not, just press Enter to skip and follow SETUP.md later.

set -uo pipefail

ZIP_PATH="$HOME/Downloads/st-louis-shore-bank.zip"
TARGET_DIR="$HOME/st-louis-shore-bank"

echo "============================================================"
echo " St Louis Shore Bank — new project bootstrap"
echo "============================================================"
echo ""

if [ ! -f "$ZIP_PATH" ]; then
  echo "Couldn't find $ZIP_PATH"
  read -r -p "Enter the full path to st-louis-shore-bank.zip: " INPUT_ZIP
  if [ -n "$INPUT_ZIP" ]; then ZIP_PATH="$INPUT_ZIP"; fi
fi
if [ ! -f "$ZIP_PATH" ]; then
  echo "Still can't find that file. Aborting."
  exit 1
fi

read -r -p "Folder to create this project in [$TARGET_DIR]: " INPUT_DIR
if [ -n "$INPUT_DIR" ]; then TARGET_DIR="$INPUT_DIR"; fi

if [ -e "$TARGET_DIR" ]; then
  echo "❌ $TARGET_DIR already exists — pick a different folder (pass a new path above) so nothing gets overwritten."
  exit 1
fi

mkdir -p "$TARGET_DIR"
echo "Unzipping into $TARGET_DIR ..."
unzip -q "$ZIP_PATH" -d "$TARGET_DIR"
# If the zip has a single wrapping top-level folder, flatten it.
ENTRIES=("$TARGET_DIR"/*)
if [ "${#ENTRIES[@]}" -eq 1 ] && [ -d "${ENTRIES[0]}" ]; then
  TMP_FLATTEN=$(mktemp -d)
  mv "${ENTRIES[0]}"/* "${ENTRIES[0]}"/.[!.]* "$TMP_FLATTEN" 2>/dev/null
  rmdir "${ENTRIES[0]}" 2>/dev/null
  mv "$TMP_FLATTEN"/* "$TMP_FLATTEN"/.[!.]* "$TARGET_DIR" 2>/dev/null
  rmdir "$TMP_FLATTEN" 2>/dev/null
fi

cd "$TARGET_DIR"

if [ ! -f serve.js ]; then
  echo "❌ serve.js not found in $TARGET_DIR after unzip — something's wrong with the zip contents. Aborting."
  exit 1
fi

echo ""
echo "── Git ──────────────────────────────────────────────────────"
git init -q
if ! git config user.email >/dev/null 2>&1; then
  git config user.email "deploy@st-louis-shore-bank.local"
  git config user.name "St Louis Shore Bank Deploy"
  echo "(no git identity was configured — set one locally for this repo only;"
  echo " run 'git config --global user.email/user.name' later to use your own)"
fi
git add -A
if git commit -q -m "Initial commit: St Louis Shore Bank"; then
  echo "✅ Local git repo created at $TARGET_DIR"
else
  echo "❌ 'git commit' failed — see the error above. Fix it, then from $TARGET_DIR run:"
  echo "     git add -A && git commit -m 'Initial commit: St Louis Shore Bank'"
  echo "   and re-run this script, or continue manually from here."
  exit 1
fi

echo ""
echo "── GitHub ───────────────────────────────────────────────────"
DEFAULT_REPO_NAME="st-louis-shore-bank"
read -r -p "GitHub repository name to create [$DEFAULT_REPO_NAME]: " REPO_NAME
REPO_NAME="${REPO_NAME:-$DEFAULT_REPO_NAME}"

HAVE_GH=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  HAVE_GH=1
fi

GH_USER=""
if [ "$HAVE_GH" = "1" ]; then
  GH_USER=$(gh api user --jq .login 2>/dev/null)
  read -r -p "Make the new GitHub repo private? [Y/n]: " PRIVACY
  VISIBILITY_FLAG="--private"
  if [[ "$PRIVACY" =~ ^[Nn] ]]; then VISIBILITY_FLAG="--public"; fi
  echo "Creating GitHub repo $GH_USER/$REPO_NAME and pushing..."
  if gh repo create "$REPO_NAME" $VISIBILITY_FLAG --source=. --remote=origin --push; then
    echo "✅ Pushed to https://github.com/$GH_USER/$REPO_NAME"
  else
    echo "⚠️  'gh repo create' failed — you'll need to create the repo and push manually (see below)."
    HAVE_GH=0
  fi
else
  echo "GitHub CLI ('gh') isn't installed/authenticated, so this script can't create"
  echo "the repo for you. Do it manually:"
  echo ""
  echo "  1. Create a new EMPTY repo at https://github.com/new (no README/license)"
  echo "  2. Then run:"
  echo "       git remote add origin https://github.com/YOUR_USERNAME/$REPO_NAME.git"
  echo "       git branch -M main"
  echo "       git push -u origin main"
  echo ""
  read -r -p "Press Enter once you've pushed to GitHub (or Ctrl+C to stop here)..." _
fi

echo ""
echo "── Supabase (auto-migrate secrets) ─────────────────────────"
echo "If you've already created your Supabase project (see SETUP.md), enter its"
echo "values now and this script will set them as GitHub Actions secrets."
echo "If not, just press Enter to skip each — you can set these anytime in"
echo "GitHub: Settings -> Secrets and variables -> Actions."
echo ""
read -r -p "Supabase Project URL (e.g. https://abcd1234.supabase.co) [skip]: " SB_URL
read -r -p "Supabase anon/public key [skip]: " SB_ANON
read -r -p "Supabase project ref (the abcd1234 part) [skip]: " SB_REF
read -r -p "Supabase access token (dashboard -> Access Tokens) [skip]: " SB_TOKEN

if [ "$HAVE_GH" = "1" ]; then
  if [ -n "$SB_TOKEN" ]; then gh secret set SUPABASE_ACCESS_TOKEN --body "$SB_TOKEN" && echo "✅ Set SUPABASE_ACCESS_TOKEN"; fi
  if [ -n "$SB_REF" ]; then gh secret set SUPABASE_PROJECT_REF --body "$SB_REF" && echo "✅ Set SUPABASE_PROJECT_REF"; fi
  if [ -n "$SB_ANON" ]; then gh secret set SUPABASE_ANON_KEY --body "$SB_ANON" && echo "✅ Set SUPABASE_ANON_KEY"; fi
  if [ -z "$SB_TOKEN$SB_REF$SB_ANON" ]; then
    echo "Skipped — no values entered. Set them later in GitHub: Settings -> Secrets and variables -> Actions."
  fi
else
  echo "No 'gh' CLI available — set these manually in GitHub: Settings -> Secrets"
  echo "and variables -> Actions -> New repository secret:"
  echo "  SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SUPABASE_ANON_KEY"
fi

echo ""
echo "── Railway (hosting) ───────────────────────────────────────"
HAVE_RAILWAY=0
if command -v railway >/dev/null 2>&1 && railway whoami >/dev/null 2>&1; then
  HAVE_RAILWAY=1
fi

if [ "$HAVE_RAILWAY" = "1" ]; then
  echo "Railway CLI detected and logged in. Initializing a new Railway project..."
  if railway init -n "$REPO_NAME"; then
    if [ -n "$SB_URL" ]; then railway variables --set "SUPABASE_API_URL=$SB_URL"; fi
    if [ -n "$SB_ANON" ]; then railway variables --set "SUPABASE_ANON_KEY=$SB_ANON"; fi
    echo "Deploying..."
    railway up || echo "⚠️  'railway up' failed — you can retry with 'railway up' from $TARGET_DIR, or connect the GitHub repo from the Railway dashboard instead (recommended, since that also gives you auto-deploy-on-push)."
    echo ""
    echo "IMPORTANT: for auto-deploy-on-push, still connect this Railway project to"
    echo "your new GitHub repo from the Railway dashboard (Settings -> Source ->"
    echo "connect $REPO_NAME) — 'railway up' alone only deploys this one snapshot."
  else
    HAVE_RAILWAY=0
  fi
fi

if [ "$HAVE_RAILWAY" = "0" ]; then
  echo "Set up Railway manually (a couple of clicks, no CLI needed):"
  echo ""
  echo "  1. Go to https://railway.app -> New Project -> Deploy from GitHub repo"
  echo "  2. Pick the '$REPO_NAME' repo you just pushed"
  echo "  3. Railway auto-detects railway.json/nixpacks.toml — no config needed"
  echo "  4. Once it's created: Settings -> Variables -> add:"
  if [ -n "$SB_URL" ]; then
    echo "       SUPABASE_API_URL = $SB_URL"
  else
    echo "       SUPABASE_API_URL = <your Supabase project URL>"
  fi
  if [ -n "$SB_ANON" ]; then
    echo "       SUPABASE_ANON_KEY = $SB_ANON"
  else
    echo "       SUPABASE_ANON_KEY = <your Supabase anon key>"
  fi
  echo "  5. Railway redeploys automatically — from now on, every 'git push'"
  echo "     rebuilds and redeploys the site on its own."
fi

echo ""
echo "============================================================"
echo " Done."
echo "============================================================"
echo " Project folder : $TARGET_DIR"
if [ -n "$GH_USER" ]; then
  echo " GitHub repo    : https://github.com/$GH_USER/$REPO_NAME"
fi
echo ""
echo " If you skipped the Supabase secret/variable steps above, finish them"
echo " using $TARGET_DIR/SETUP.md — that's the only manual step left."
echo ""
echo " After the Supabase secrets are set, every 'git push' to main will:"
echo "   - auto-run the database migrations (GitHub Actions)"
echo "   - auto-rebuild and redeploy the site (Railway)"
echo " and it's safe to push again even if the database already has some or"
echo " all of the schema applied — every migration is idempotent."
