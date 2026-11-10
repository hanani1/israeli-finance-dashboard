# ADR-0017: Unified monthly view (merge), net, 6-month average, drill-down reclassify

- **Date:** 2026-08-18
- **Status:** Accepted
- **Area:** Product / UI
- **Owners:** Finance Dashboard maintainers

## Context

The `/monthly` (pacing) and `/breakdown` (pie + grouped categories) tabs overlapped
conceptually. Users wanted one monthly tab that also shows net, per-category trends, and
lets them fix classifications in place.

## Decision

- **Merge** into a single tab named **מבט חודשי** at `/monthly`; remove `/breakdown` and
  its nav entry. The unified view keeps פילוח's features (month selector, expenses pie,
  grouped per-category breakdown) — superseding the earlier separate breakdown tab from
  ADR-0016 and the pacing-only monthly view.
- **Net:** `getMonthlyBreakdown` returns `totalIncome`, `totalExpense`, and
  `net = income − all expenses (incl. variable)`, shown as a summary at the top.
- **Trailing 6-month average:** each category shows `avg6` (its average over the six months
  preceding the selected month) and a colored ±% delta vs the current month.
- **Drill-down + make-permanent:** expanding a category lists its transactions for the
  month; changing a transaction's category `PATCH`es it (→ MANUAL) and then prompts
  *"make this a permanent classification?"*. On yes, all transactions with the **exact same
  description** are updated (`POST /api/transactions/reclassify-identical`) **and** a
  `CategorizationRule` is created so future matches auto-classify.

## Consequences

### Positive
- One place for "what happened this month," with trend context and in-place correction.
- Make-permanent turns a single fix into a durable rule + backfill.

### Negative / risks
- "Identical" is an exact-description match — near-duplicate descriptions won't be caught by the bulk update (they still get a rule via ILIKE-contains).
- The drill-down filters the month's transactions client-side (the transactions GET route has no `categoryId` param yet).

## References

- `src/app/monthly/page.tsx`, `src/lib/services/analyticsService.ts` (`getMonthlyBreakdown`: net, avg6)
- `src/app/api/transactions/reclassify-identical/route.ts`, `src/lib/services/transactionService.ts`
- `src/components/transactions/MakePermanentDialog.tsx`
- Supersedes the separate breakdown tab in ADR-0016; builds on ADR-0015 (MANUAL provenance).
