# ADR-0004: Deterministic, idempotent ingestion

- **Date:** 2026-08-05
- **Status:** Accepted
- **Area:** Data / Architecture
- **Owners:** Finance Dashboard maintainers

## Context

Bank scrapers return overlapping date windows, and the same transaction appears on repeated runs. Random database IDs would require a separate deduplication mechanism and make retries unsafe.

## Decision

Derive account IDs from user, provider, and account number. Derive transaction IDs from account ID, ISO date, charged amount, and description using SHA-256. Upsert by that identity and deliberately exclude category fields from the update branch.

## Consequences

### Positive
- Re-running ingestion is safe and does not create ordinary duplicates.
- Manual, rule, and LLM classifications survive re-ingestion.
- Partial provider failures can be retried independently.

### Negative / risks
- A bank correction to date, amount, or description creates a new logical transaction.
- Identity behavior is a compatibility contract; changing it requires migration and reconciliation.

## Alternatives considered

- **Random IDs plus database uniqueness constraints:** rejected because provider transaction identifiers are inconsistent and not always present.
- **Fuzzy deduplication:** rejected as harder to reason about and capable of merging distinct purchases.

## References

- `src/lib/jobs/ingestion.ts`
- `docs/DESIGN.md` §3
