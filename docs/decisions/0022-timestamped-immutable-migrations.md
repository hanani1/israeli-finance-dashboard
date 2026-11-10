# ADR-0022: Timestamped, immutable Prisma migrations

- **Date:** 2026-11-02
- **Status:** Accepted
- **Area:** Data / Operations
- **Owners:** Finance Dashboard maintainers

## Context

Prisma applies `prisma/migrations/*` in lexical folder order. Early migrations
were hand-named `1_` to `4_`, so they sorted after the timestamped
`2026…` folders. `20260829233500_investments` extends the `"CategoryGroup"`
enum, which `3_add_category_group` creates. On a fresh database (new host,
restore into an empty DB, CI) `prisma migrate deploy` failed with
`type "CategoryGroup" does not exist`. The two live databases did not hit this
because they applied `1_` to `4_` before the timestamped folders existed
(Trello card #47).

Card #47 also flagged `20260902210000_payments_variable_expense`, which runs
`UPDATE "Category" … WHERE "id" = 39`.

## Decision

1. Rename `1_`…`4_` to `20260810000001_add_llm_categorization_source`,
   `20260810000002_add_budgets`, `20260810000003_add_category_group`,
   `20260810000004_track_initial_bank_sync`. The SQL stays byte-identical, so
   the checksums don't change. `0_init` keeps its name because it already
   sorts first.
2. Existing databases rename the four matching `_prisma_migrations.migration_name`
   rows once with `scripts/rename-legacy-migrations.sh`. The script is a dry run
   by default and needs a fresh pg_dump for `--apply`. It is idempotent, checks
   each checksum against the file, and never changes checksums or timestamps.
3. Leave `20260902210000_payments_variable_expense` **byte-identical**.
   - On a fresh database the `UPDATE` matches zero rows: migrations run before
     `prisma db seed`, so `Category` is empty. Replay works without a change.
     The seed then upserts the payments category by its stable id 39 as
     `VARIABLE_EXPENSE`/`EXPENSE`, so the end state is already correct.
   - A restored dump brings its own already-correct row and its own
     `_prisma_migrations`.
   - Editing the file changes its checksum. With Prisma 6.19,
     `prisma migrate status` does not report the change (verified), but
     `prisma migrate dev` reports "was modified after it was applied" and asks
     to **reset the database**, which would lose all data. Avoiding that would
     need a second manual checksum rewrite on both live DBs, and the edit would
     not change behaviour anywhere.
   - A name-based predicate would also be less precise. Category names are
     unique only per `(name, group)`, and transactions, rules and budgets rely
     on the stable id.
4. From now on, migrations use Prisma-generated `YYYYMMDDHHMMSS_` names only,
   and an applied migration is never edited. Corrections go in a new migration.
   `scripts/verify-migrations.sh` (fresh replay + `migrate status` +
   `migrate diff --exit-code`) is the check.

## Consequences

### Positive
- A fresh database replays every migration with no drift from the schema,
  which unblocks card #15 (productionize, CI).
- Live databases keep their exact schema and data. Only four bookkeeping rows
  are renamed.

### Negative / risks
- If anything runs `prisma migrate deploy` with the new folders before the
  rename (the compose `app` container does this on every start), Prisma tries to
  re-apply `20260810000001_…`. That fails on its first statement with no schema
  change, records a failed row, and stops the app from starting. Recovery:
  `npx prisma migrate resolve --rolled-back 20260810000001_add_llm_categorization_source`,
  then run the rename script. The script detects this state and prints the
  command.
- The hard-coded id 39 stays in history. It is harmless, but it reads as a
  smell.

## Alternatives considered

- **`prisma migrate resolve --applied <new>` for each renamed migration**
  (card's option): this leaves the old rows behind. Then `migrate status` and
  `migrate dev` report "migrations from the database are not found locally",
  so the old rows would have to be deleted by hand anyway. Renaming the rows is
  one transaction and keeps the original timestamps.
- **Edit the id-39 migration and rewrite its stored checksum**: more live-DB
  writes for no behavioural gain (see Decision 3).
- **Squash into a new baseline**: needs `resolve` plus manual table edits on
  both live DBs and throws away history. Out of proportion for this fix.

## Follow-up

- On both Macs: back up, then run `scripts/rename-legacy-migrations.sh`, before
  deploying this change (see card #47).
- Card #15: call `scripts/verify-migrations.sh` from CI.

## References

- Trello card #47 (12.6), card #15.
- `scripts/verify-migrations.sh`, `scripts/rename-legacy-migrations.sh`.
