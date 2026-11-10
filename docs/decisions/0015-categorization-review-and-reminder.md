# ADR-0015: In-app daily categorization reminder and one-by-one review

- **Date:** 2026-08-17
- **Status:** Accepted
- **Area:** Product / UX
- **Owners:** Finance Dashboard maintainers

## Context

Rules and the LLM assign a *heuristic* category, but the user wants to personally confirm
categorizations and be nudged to do so regularly (RiseUp-style). A "confirmed by me" state
already exists: `categorizationSource = MANUAL`. Everything else (`UNASSIGNED`, `RULE`,
`LLM`) is "not yet reviewed by the user".

## Decision

- **Needs-review = `categorizationSource != MANUAL`.** Added a `needsReview` filter to the
  transactions API/service.
- **Visual markers (transactions table):** a green dot next to any not-yet-reviewed row,
  and a confirm **tick** that promotes the current heuristic category to `MANUAL` in one
  click (shown only when a category is already suggested).
- **One-by-one review modal:** steps through the not-yet-reviewed transactions,
  **pre-selecting the heuristic category** so the user usually just clicks Confirm (or
  edits, or skips). Confirming sets `MANUAL`.
- **Daily reminder:** an app-wide client component shows a once-per-day prompt (tracked in
  `localStorage`) when there are items to review, linking to `/transactions?review=1`,
  which opens the review modal. This is the pragmatic reminder for a self-hosted app with
  no push channel; an OS notification via the existing launchd job could be layered on
  later.

**Non-goals:** server-side reminder state / cross-device sync (localStorage is per-browser),
and bulk "confirm all" (deliberately per-item so the user actually reviews).

## Consequences

### Positive
- Confirming a correct heuristic is one click; the green dot makes unreviewed items obvious.
- Reuses existing provenance (`MANUAL`) — no schema change.

### Negative / risks
- The daily reminder is per-browser (localStorage), so it can re-prompt on a new device.
- The reminder counts within the loaded window / all needs-review rows, not a curated set.

## References

- `src/lib/services/transactionService.ts` (`needsReview`), `src/app/api/transactions/route.ts`
- `src/components/transactions/TransactionsTable.tsx` (green dot + tick)
- `src/components/transactions/CategorizeReviewModal.tsx`
- `src/components/transactions/DailyCategorizeReminder.tsx`, `src/app/layout.tsx`
- `docs/REQUIREMENTS.md §3.2`, `docs/DESIGN.md §15`
