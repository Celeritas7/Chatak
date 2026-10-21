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
supabase functions deploy collect-prices  --no-verify-jwt
supabase functions deploy evaluate-alerts --no-verify-jwt
supabase functions deploy add-product                      # keeps JWT: it writes as a user
supabase functions deploy send-push                        # keeps JWT: the app and evaluate-alerts call it

echo "Deployed. supabase/schema.sql is NOT deployed by this script — run it in the SQL editor."
