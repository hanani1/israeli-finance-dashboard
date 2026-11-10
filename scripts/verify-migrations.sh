#!/bin/bash
# Safety class: WRITES DB (creates and always drops its own throwaway fd_migverify_<pid>
# database; never touches an existing one).
#
# Fresh-database migration replay check (Trello card #47).
#
# Creates a throwaway database on the local Postgres, replays every migration
# in prisma/migrations from empty with `prisma migrate deploy`, then proves the
# result matches prisma/schema.prisma exactly (`prisma migrate diff
# --exit-code`) and that `prisma migrate status` is clean. The database is
# always dropped on exit (trap), pass or fail.
#
#   scripts/verify-migrations.sh
#   PGHOST=127.0.0.1 PGPORT=5432 scripts/verify-migrations.sh
#
# Exit codes: 0 = clean replay, no drift; non-zero = failure (deploy error,
# drift, or pending/failed migrations). Never touches an existing database:
# the scratch name is generated (fd_migverify_<pid>) and must not exist yet.
set -euo pipefail

cd "$(dirname "$0")/.."

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-$(id -un)}"
export PGHOST PGPORT PGUSER
DB="fd_migverify_$$"

case "$DB" in
  finance|postgres|template0|template1) echo "refusing to use database '$DB'" >&2; exit 2 ;;
esac

BASE_URL="postgresql://${PGUSER}@${PGHOST}:${PGPORT}/${DB}"
# Prisma CLI loads .env when present, but an already-set environment variable
# wins, so the scratch URL below is what every prisma command uses.
export DATABASE_URL="${BASE_URL}?schema=public"
PRISMA=(npx --no-install prisma)

cleanup() {
  local status=$?
  dropdb --if-exists "$DB" >/dev/null 2>&1 || echo "WARN: could not drop scratch database $DB" >&2
  if [ "$status" -eq 0 ]; then
    echo "verify-migrations: OK (scratch database $DB dropped)"
  else
    echo "verify-migrations: FAILED (exit $status; scratch database $DB dropped)" >&2
  fi
}

if psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1; then
  echo "scratch database $DB already exists; refusing to reuse it" >&2
  exit 2
fi
createdb "$DB"
trap cleanup EXIT

echo "== prisma migrate deploy (from empty, $DB)"
"${PRISMA[@]}" migrate deploy

echo "== prisma migrate status"
"${PRISMA[@]}" migrate status

echo "== prisma migrate diff (database -> prisma/schema.prisma, --exit-code)"
# --exit-code: 0 = no difference, 2 = drift, 1 = error.
"${PRISMA[@]}" migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code
