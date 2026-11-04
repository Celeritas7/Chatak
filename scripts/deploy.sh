#!/usr/bin/env bash
# Deploy the Chatak edge functions. Run from the repo root:
#   ./scripts/deploy.sh <project-ref>
#
# The functions live in supabase/functions — the directory name the Supabase CLI
# expects — so there is nothing to stage or copy.

set -e
PROJECT_REF="${1:?usage: ./scripts/deploy.sh <project-ref>}"
cd "$(dirname "$0")/.."

supabase link --project-ref "$PROJECT_REF"
# All four check their caller in code (since the Akatsuki hub's 2026-10-28 audit),
# so the gateway's JWT check is off: the new secret key is not a JWT.
#   collect-prices, evaluate-alerts: server only (the secret key)
#   send-push: the server or a signed-in user;  add-product: a signed-in user
supabase functions deploy collect-prices  --no-verify-jwt
supabase functions deploy evaluate-alerts --no-verify-jwt
supabase functions deploy add-product     --no-verify-jwt
supabase functions deploy send-push       --no-verify-jwt

echo "Deployed. supabase/schema.sql is NOT deployed by this script — run it in the SQL editor."
