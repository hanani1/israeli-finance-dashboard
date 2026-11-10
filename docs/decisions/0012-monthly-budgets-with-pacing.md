# ADR-0012: Monthly per-category budgets with linear pacing

- **Date:** 2026-08-17
- **Status:** Accepted
- **Area:** Product / Data
- **Owners:** Finance Dashboard maintainers

## Context

Budgeting was previously out of scope (see the superseded item in `REQUIREMENTS.md §7`).
The Spent evaluation ([ADR-0011](0011-borrow-from-spent-not-fork.md)) surfaced "budget with
pacing" as the cleanest net-new capability — it lets a household see not just how much of a
budget is spent, but whether spend is ahead of or behind the pace the month implies.

## Decision

Add **monthly, per-category budgets** with pace computed at read time.

- **Data:** a `Budget` model — one row per category (`categoryId @unique`), a positive
  monthly `amount` in ILS, cascade-deleted with its category. No overall/uncategorized
  budget row; the aggregate total is derived by summing category budgets.
- **Pacing math is pure and DB/Date-free** (`src/lib/services/budgetPacing.ts`,
  `computePacing`): `expectedByNow = amount × elapsedFraction`, a linear end-of-month
  `projected` run-rate, and a `pace` of `under` / `on` / `over` within a ±5% tolerance
  band. `resolveMonthWindow` maps a `yyyy-MM` month to a UTC window and elapsed-day counts
  (full days for past months, current day for the ongoing month). This keeps the logic
  unit-testable without a database (`budgetPacing.test.ts`).
- **Service/API:** `budgetService.ts` (`upsertBudget`, `deleteBudget`, `getBudgetPacing`,
  `listBudgetableCategories`); `GET/POST /api/budgets` and `DELETE /api/budgets/[id]`.
- **UI:** a `/budgets` page (month picker honoring the global household filter), a
  `BudgetPacingChart` (Recharts bars, colored by pace), and an editable per-category list.

**Non-goals:** budget rollover, per-month historical budget values (the amount is a single
current recurring figure), and non-linear/seasonal pacing curves.

## Consequences

### Positive
- Net-new capability isolated to new files plus a nav entry and a Prisma migration.
- Pure pacing core is fully unit-tested and reused for both per-category and total rows.

### Negative / risks
- Linear pacing ignores seasonality and lumpy bills (e.g. an annual charge reads as "over
  pace" early in the month). Accepted for v1; projection is advisory.
- Budgets are current-value only, so changing an amount is not historically versioned.

## Alternatives considered

- **Single overall budget row (nullable category):** rejected — Postgres treats NULLs as
  distinct, complicating the unique constraint; per-category + derived total is cleaner.
- **Time-series budget table (amount per month):** deferred — unnecessary for the current
  single recurring-figure model.

## References

- `src/lib/services/budgetPacing.ts`, `budgetPacing.test.ts`, `src/lib/services/budgetService.ts`
- `src/app/api/budgets/route.ts`, `src/app/api/budgets/[id]/route.ts`, `src/app/budgets/page.tsx`
- `src/components/analytics/BudgetPacingChart.tsx`, `prisma/migrations/2_add_budgets/`
- `docs/REQUIREMENTS.md §3.8`, `docs/DESIGN.md §9`
