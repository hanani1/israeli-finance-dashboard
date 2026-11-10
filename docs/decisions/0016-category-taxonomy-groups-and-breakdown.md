# ADR-0016: RiseUp category taxonomy with groups + monthly breakdown

- **Date:** 2026-08-18
- **Status:** Accepted
- **Area:** Product / Data / UI
- **Owners:** Finance Dashboard maintainers

## Context

The seed categories were a flat list. The desired model (RiseUp-style) is a richer
Hebrew taxonomy split into three groups — **variable expenses**, **recurring/fixed
expenses**, and **income** — and a per-month breakdown view. Some names legitimately
repeat across groups (e.g. **ספורט** is variable *and* recurring; **דיור** is a recurring
expense *and* a rental-income line).

## Decision

- **Data model:** add a `CategoryGroup` enum (`VARIABLE_EXPENSE`, `RECURRING_EXPENSE`,
  `INCOME`) and a `group` field on `Category`; change uniqueness from `name` to a compound
  **`@@unique([name, group])`** so a name can exist once per group. `type` (INCOME/EXPENSE)
  is kept and derived from the group.
- **Seed + reconcile:** seed the full taxonomy (~35 categories) idempotently by
  `(name, group)`; the previously-existing categories were **retagged/renamed in place** so
  their transactions carried over (no orphans).
- **Classification:** all transactions are classified into the taxonomy — rules first
  (none defined today, so a no-op), then the Kiro LLM in batches past the 100/batch cap.
  Safe because no transaction was user-confirmed (`MANUAL`). Note: the LLM currently leans
  on catch-all categories (כללי / תשלומים); rules and the review flow refine over time.
- **Breakdown:** `getMonthlyBreakdown` (+ `GET /api/monthly-breakdown`) returns per-category
  totals grouped by group for a month; a new **`/breakdown` tab** shows a month selector, a
  pie of expenses by category at the top, and the grouped per-category lists.

## Consequences

### Positive
- Matches the RiseUp mental model; the breakdown view answers "where did the money go this month" by group.
- Names can repeat across groups without collisions.

### Negative / risks
- LLM classification into a large Hebrew taxonomy is coarse initially (catch-all bias); needs rules / manual review to sharpen.
- More categories to maintain; a few retagged mappings were best-effort.

## Alternatives considered

- **Keep flat categories + a boolean `isRecurring`:** rejected — income is a third dimension and names collide; an enum group is clearer.
- **Rules-only classification:** rejected for coverage (no rules exist yet); LLM handles the bulk.

## References

- `prisma/schema.prisma` (`CategoryGroup`, `@@unique([name, group])`), `prisma/migrations/3_add_category_group/`, `prisma/seed.ts`
- `src/lib/services/analyticsService.ts` (`getMonthlyBreakdown`), `src/app/api/monthly-breakdown/route.ts`, `src/app/breakdown/page.tsx`
- `docs/REQUIREMENTS.md §3.12`, `docs/DESIGN.md §18`
