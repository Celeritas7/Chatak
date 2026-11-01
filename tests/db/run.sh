#!/usr/bin/env bash
# Database test harness: a throwaway Postgres with Supabase stubs.
#   tests/db/run.sh                 # schema twice, then every tests/db/test_*.sql
#   tests/db/run.sh test_compare    # schema twice, then only matching tests
# Needs Postgres 15+ binaries (PGBIN=/usr/lib/postgresql/16/bin by default).
# Run as root in a container, it starts the server as the postgres user.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DIR="$(mktemp -d /var/tmp/chatak-db-XXXX)"; PORT="${PGPORT:-54329}"
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$DIR"
cleanup() { as_pg "$PGBIN/pg_ctl -D $DIR/data stop -m fast" >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
as_pg "$PGBIN/initdb -D $DIR/data -A trust" >/dev/null
as_pg "$PGBIN/pg_ctl -D $DIR/data -o '-k $DIR -p $PORT -c listen_addresses=' -l $DIR/log start" >/dev/null
PSQL="psql -h $DIR -p $PORT -U postgres -X -q -v ON_ERROR_STOP=1"
$PSQL -c "create database t" postgres
$PSQL -d t -f "$HERE/stubs.sql"
for run in 1 2; do  # twice: the schema must be safe to re-run
  $PSQL -d t -1 -f "$ROOT/supabase/schema.sql" 2>&1 | grep -v NOTICE || true
  [ "${PIPESTATUS[0]}" = 0 ] || { echo "schema run $run FAILED"; exit 1; }
  echo "schema run $run ok"
done
status=0
for f in "$HERE"/test_*.sql; do
  case "$(basename "$f")" in *"${1:-}"*) ;; *) continue ;; esac
  if $PSQL -d t -f "$f"; then echo "PASS $(basename "$f")"; else echo "FAIL $(basename "$f")"; status=1; fi
done
exit $status
