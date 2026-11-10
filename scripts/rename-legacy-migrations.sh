#!/bin/bash
# Safety class: WRITES DB (_prisma_migrations rows, only with --apply and a fresh backup;
# dry run by default).
#
# One-off live-database follow-up for Trello card #47 (migration ordering).
#
# The migrations 1_..4_ were renamed to timestamped names so a fresh database
# replays them before 20260829233500_investments (which extends the
# "CategoryGroup" enum created by the old 3_add_category_group). The SQL is
# byte-identical, so the stored checksums stay valid; only the
# `_prisma_migrations.migration_name` of databases that applied the old names
# has to follow the rename. Without this, `prisma migrate deploy` would try to
# re-apply the four migrations under their new names and fail.
#
# Run it BEFORE anything runs `prisma migrate deploy` with the renamed folder
# (docker-compose's app command does so on every start). If that already
# happened, the script detects the recorded failed attempt and prints the
# `prisma migrate resolve --rolled-back` command to run first.
#
#   DATABASE_URL=postgresql://.../finance scripts/rename-legacy-migrations.sh
#       dry run (default): shows each row's state and the planned change
#   DATABASE_URL=... scripts/rename-legacy-migrations.sh --apply --backup=db-dumps/finance-<stamp>-pre-card47.sql
#       renames the rows in one transaction
#
# --apply refuses to run without --backup pointing at a pg_dump of this
# database taken within the last 24 hours, e.g.
#   pg_dump --file db-dumps/finance-$(date +%Y%m%d%H%M)-pre-card47.sql "${DATABASE_URL%%\?*}"
#
# Idempotent: rows already under the new name are left alone; re-running after
# a successful apply is a no-op. It refuses (exit 1, nothing changed) when a
# pair is in an unexpected state: both names present, neither present, the old
# row is failed/rolled back, or its checksum does not match the file on disk.
# Checksums and timestamps are never modified.
set -euo pipefail

cd "$(dirname "$0")/.."

RENAMES=(
  "1_add_llm_categorization_source:20260810000001_add_llm_categorization_source"
  "2_add_budgets:20260810000002_add_budgets"
  "3_add_category_group:20260810000003_add_category_group"
  "4_track_initial_bank_sync:20260810000004_track_initial_bank_sync"
)

APPLY=0
BACKUP=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --backup=*) BACKUP="${a#--backup=}" ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must be set explicitly (this script never guesses the target database)." >&2
  exit 2
fi
DB_URL="${DATABASE_URL%%\?*}" # psql rejects Prisma's ?schema=... suffix
DB_NAME="${DB_URL##*/}"

psql_q() { psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=1 "$@"; }

echo "Target database: $DB_NAME ($([ "$APPLY" -eq 1 ] && echo APPLY || echo dry run))"

if [ "$(psql_q -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")" != "t" ]; then
  echo "No public._prisma_migrations table in $DB_NAME; nothing to do." >&2
  exit 1
fi

# Rows marked rolled back (`prisma migrate resolve --rolled-back`) are ignored,
# exactly as Prisma ignores them.
row_state() { # <migration_name> -> absent | duplicate | "<checksum>|<t if finished, else f>"
  local r
  r="$(psql_q -v name="$1" <<'SQL'
SELECT checksum || '|' || CASE WHEN finished_at IS NOT NULL THEN 't' ELSE 'f' END
FROM _prisma_migrations WHERE migration_name = :'name' AND rolled_back_at IS NULL;
SQL
)"
  if [ -z "$r" ]; then echo absent; elif [ "$(printf '%s\n' "$r" | wc -l)" -gt 1 ]; then echo duplicate; else echo "$r"; fi
}

PLANNED=()
PROBLEMS=0
for pair in "${RENAMES[@]}"; do
  old="${pair%%:*}"; new="${pair##*:}"
  file="prisma/migrations/$new/migration.sql"
  if [ ! -f "$file" ]; then echo "  !! $file missing in this checkout" >&2; PROBLEMS=1; continue; fi
  want="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  os="$(row_state "$old")"; ns="$(row_state "$new")"
  if [ "$os" = duplicate ] || [ "$ns" = duplicate ]; then
    echo "  !! $old / $new: more than one active row; resolve manually" >&2; PROBLEMS=1
  elif [ "$ns" != absent ] && [ "${ns##*|}" != t ]; then
    # `prisma migrate deploy` ran with the new folder before this script and
    # recorded a failed re-apply of SQL that is already applied. Each of these
    # four fails on its first statement, so the schema was not changed.
    echo "  !! $new has a FAILED row (migrate deploy ran before the rename). Run" >&2
    echo "       npx prisma migrate resolve --rolled-back $new" >&2
    echo "     then re-run this script." >&2
    PROBLEMS=1
  elif [ "$os" = absent ] && [ "$ns" != absent ]; then
    echo "  ok      $new (already renamed)"
  elif [ "$os" = absent ]; then
    echo "  !! $old / $new: neither row exists; not a database that applied the old name" >&2; PROBLEMS=1
  elif [ "$ns" != absent ]; then
    echo "  !! both $old and $new rows exist; resolve manually" >&2; PROBLEMS=1
  elif [ "${os##*|}" != t ]; then
    echo "  !! $old is recorded as failed (not finished); resolve manually" >&2; PROBLEMS=1
  elif [ "${os%%|*}" != "$want" ]; then
    echo "  !! $old checksum ${os%%|*} != sha256($file) $want; SQL differs from what was applied" >&2; PROBLEMS=1
  else
    echo "  rename  $old -> $new (checksum $want matches)"
    PLANNED+=("$old:$new")
  fi
done

if [ "$PROBLEMS" -ne 0 ]; then
  echo "Refusing to change anything: fix the issues above first." >&2
  exit 1
fi
if [ "${#PLANNED[@]}" -eq 0 ]; then
  echo "Nothing to rename; $DB_NAME already matches prisma/migrations."
  exit 0
fi
if [ "$APPLY" -ne 1 ]; then
  echo "Dry run: ${#PLANNED[@]} row(s) would be renamed. Re-run with --apply --backup=<fresh pg_dump path>."
  exit 0
fi

if [ -z "$BACKUP" ] || [ ! -s "$BACKUP" ]; then
  echo "--apply requires --backup=<path to a fresh, non-empty pg_dump of $DB_NAME>." >&2
  exit 2
fi
if ! head -c 5 "$BACKUP" | grep -q PGDMP && ! head -n 5 "$BACKUP" | grep -q 'PostgreSQL database dump'; then
  echo "$BACKUP does not look like a pg_dump file." >&2
  exit 2
fi
if [ -z "$(find "$BACKUP" -mmin -1440 2>/dev/null)" ]; then
  echo "$BACKUP is older than 24 hours; take a fresh pg_dump first." >&2
  exit 2
fi
if ! grep -q -a '_prisma_migrations' "$BACKUP"; then
  echo "$BACKUP does not contain _prisma_migrations; is it a dump of $DB_NAME?" >&2
  exit 2
fi

SQL="BEGIN;"
for pair in "${PLANNED[@]}"; do
  old="${pair%%:*}"; new="${pair##*:}"
  # Guarded so a concurrent/partial run can never produce two rows for one migration.
  SQL+="
UPDATE _prisma_migrations SET migration_name = '$new'
 WHERE migration_name = '$old' AND rolled_back_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM _prisma_migrations
                    WHERE migration_name = '$new' AND rolled_back_at IS NULL);"
done
SQL+="
COMMIT;"
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -c "$SQL"
echo "Renamed ${#PLANNED[@]} row(s) in $DB_NAME (backup: $BACKUP). Now run: npx prisma migrate status"
