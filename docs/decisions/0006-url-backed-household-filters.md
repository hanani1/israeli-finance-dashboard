# ADR-0006: Store global household filters in the URL

- **Date:** 2026-08-05
- **Status:** Accepted
- **Area:** UI / Architecture
- **Owners:** Finance Dashboard maintainers

## Context

Dashboard and transaction views share date-range and household-member filters. Filters should survive navigation and refresh without adding a client state framework.

## Decision

Represent `from`, `to`, and optional `userId` in URL search parameters. Use one shared hook to read and update them, and have each page pass the same values to its API route.

## Consequences

### Positive
- Filtered views are refresh-safe, bookmarkable, and shareable within the trusted deployment.
- The UI avoids a separate global state dependency.
- Dashboard and transaction requests remain inspectable and reproducible.

### Negative / risks
- Every view must preserve unrelated search parameters correctly.
- Dates in shared URLs may disclose usage context in browser history.
- Invalid parameters require defensive defaults.

## Alternatives considered

- **React context/global store:** rejected as unnecessary for a small set of serializable filters.
- **Component-local state:** rejected because it resets during navigation and can diverge across pages.

## References

- `src/lib/hooks/useGlobalFilters.ts`
- `docs/DESIGN.md` §6
