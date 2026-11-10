# ADR-0021: Serialize ingestion runs with a database lease

- **Date:** 2026-11-02
- **Status:** Accepted
- **Area:** Data / Operations
- **Owners:** Finance Dashboard maintainers

## Context

`runIngestion` is entered from several places: the host launchd job / `npm run sync:once`,
the `npm run worker` cron, Settings "Sync Now" (`POST /api/sync`) and credential save
(`POST /api/credentials`). Overlapping runs start several Chromiums, repeat live bank
logins (lockout risk), race the `findFirst -> upsert` identity lookup (which has no unique
key, so both runs can insert the same purchase), and flip-flop the two-phase settlement
marking. Trello card #48.

The card proposed `pg_try_advisory_lock`. A session-level advisory lock is owned by one
database connection and must be released on that same connection; Prisma's pool gives no
connection affinity outside a transaction, and a scrape run (minutes) is far too long to
keep one transaction open. Transaction-level advisory locks have the same problem.

## Decision

- One run-wide lock, `finance.ingestion`, implemented as a **lease row** in
  `IngestionLease(name PK, holder, acquiredAt, expiresAt timestamptz)`.
- Acquire is a single atomic `INSERT ... ON CONFLICT (name) DO UPDATE ... WHERE
  expiresAt <= now() RETURNING holder`; the conflict row lock serializes concurrent
  acquirers, so exactly one wins. Holder id = `hostname:pid:uuid` (unique per run).
- While running, a heartbeat renews `expiresAt = now() + TTL` every 60 s (TTL 10 min);
  `finally` deletes the row (only if still ours). All time comparisons use the database
  clock, so host/container clock skew does not matter.
- A crashed or `kill -9`ed run stops heartbeating and its lease expires after at most
  10 minutes; nothing stays held forever. If the heartbeat finds the lease lost (e.g. the
  laptop slept past the TTL) it logs a warning; the run continues.
- A run that cannot acquire returns an empty summary with
  `skipped: 'ingestion already running'`: `sync:once` logs it and exits 0, `/api/sync`
  responds **409**, credential save rolls the unverified credential back and responds 409
  (a connection is visible only once verified), and Settings shows an "already running"
  message (en + he).
- The identity lookup gets a **non-unique** index on `Transaction(accountId,
  txnIdentifier)`. A unique index is not possible: the identity is fuzzy (a ±3-day date
  window, raw and normalized identifier forms), and existing rows may already share an
  identifier. Serialization by the lock is what prevents duplicate inserts.
- Non-goal: per-provider locks; a whole-run lock is enough for one household.

## Consequences

### Positive
- No concurrent scrapes, logins or identity races, from any entry point.
- Works over any pooled connection, needs no new dependency, self-heals after crashes.

### Negative / risks
- After a crash, syncs are skipped for up to 10 minutes. Manual override:
  `DELETE FROM "IngestionLease" WHERE name = 'finance.ingestion';`
- A run suspended longer than the TTL (sleep) can overlap a newer run; this is logged.

## Alternatives considered

- **`pg_try_advisory_lock` over Prisma:** no connection affinity outside a transaction;
  releasing on a different pooled connection is a no-op, so the lock could leak until the
  pool connection closed.
- **Dedicated `pg` client for the advisory lock:** correct and crash-safe (the lock dies
  with the connection), but adds a dependency and a second connection config; and a
  half-open TCP connection can keep the lock for a long time. The lease needs neither.
- **Unique index on the identity fields:** too strict with the ±3-day window (card #48).

## References

- `src/lib/services/ingestionLock.ts`, `src/lib/jobs/ingestionLease.ts`,
  `src/lib/jobs/ingestion.ts`
- `prisma/migrations/20261102120000_ingestion_lease_and_identity_index`
- Trello card #48 (12.7)
