#!/bin/sh
# Deploys FeedbackKit's Worker from the committed HEAD (docs/worker.md#deploy), in the one safe order:
#   1. render deploy/wrangler.jsonc from the template (account, public URL, D1 id looked up by name);
#   2. the Worker's tests;
#   3. apply D1's migrations, then stop unless D1 lists none still to apply;
#   4. deploy, named for the commit.
# Code that needs a column the database lacks fails every request that touches it, so step 4 never runs before
# step 3 has passed (2026-11-15: migration 0004 failed D1's foreign-key check and the Worker went out first).
#
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… deploy/deploy.sh
#
# Secrets (CALLER_TOKEN, RUNNER_TOKEN, ISSUES_TOKEN, ADMIN_TOKEN, APP_KEYS, APNS_*, ACP_SECRET) are set once with
# `wrangler secret put`; this never touches them.
set -eu
cd "$(dirname "$0")/.."
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
PUBLIC_URL=${PUBLIC_URL:-https://featurekit.jai-f89.workers.dev}
DATABASE=feedbackkit
config=deploy/wrangler.jsonc

if [ -n "$(git status --porcelain -- worker deploy/wrangler.template.jsonc)" ]; then
  echo "deploy: worker/ or the template has uncommitted changes; deploy only what is committed" >&2
  exit 1
fi
commit=$(git rev-parse --short HEAD)

cd worker
npm ci --silent
database_id=$(npx wrangler d1 list --json | node -e '
  let text = ""; process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
    const found = JSON.parse(text).find((one) => one.name === process.argv[1]);
    if (!found) { console.error(`deploy: no D1 database named ${process.argv[1]}`); process.exit(1); }
    console.log(found.uuid);
  });' "$DATABASE")
sed -e "s/__CLOUDFLARE_ACCOUNT_ID__/$CLOUDFLARE_ACCOUNT_ID/" -e "s#__PUBLIC_URL__#$PUBLIC_URL#" \
  -e "s/__D1_DATABASE_ID__/$database_id/" ../deploy/wrangler.template.jsonc > "../$config"

echo "deploy: tests"
npm test >/dev/null 2>&1 || { echo "deploy: the Worker's tests fail; run npm test in worker/" >&2; exit 1; }
npm run typecheck >/dev/null

echo "deploy: D1 migrations"
npx wrangler d1 migrations apply "$DATABASE" --remote --config "../$config"
pending=$(npx wrangler d1 migrations list "$DATABASE" --remote --config "../$config" 2>&1)
case "$pending" in
  *"No migrations to apply"*) ;;
  *) printf '%s\n' "$pending" >&2; echo "deploy: D1 still has migrations to apply; the Worker is not deployed" >&2; exit 1 ;;
esac

echo "deploy: the Worker at $commit"
npx wrangler deploy --config "../$config" --message "$commit"
