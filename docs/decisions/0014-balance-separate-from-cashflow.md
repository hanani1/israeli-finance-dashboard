# ADR-0014: Current balance is separate from period cash flow

- **Date:** 2026-08-17
- **Status:** Accepted
- **Area:** Product / Data
- **Owners:** Finance Dashboard maintainers

## Context

The dashboard summarized a period as income / expenses / net. Users conflated the
period **income** figure with **how much money is actually in the bank**. These are
different concepts: income is a flow over a time window; the bank balance is a
point-in-time stock. Conflating them is misleading, and the product will soon aggregate
multiple banks, where "how much do I have in total" must be answerable directly.

## Decision

Model and present the two separately on the dashboard:

- **Cash flow (selected period):** income, expenses, and **net = income − expenses**,
  driven by the header date range. The "Net" label is spelled out as "Net (income −
  expenses)" (Hebrew: נטו (הכנסות פחות הוצאות)) so it is not read as a balance.
- **Current balance:** a distinct section showing the **sum of `Account.balance` across
  all connected accounts** (total holdings), with a per-account breakdown and an explicit
  note that it is the current bank amount, not income. Served by
  `accountService.listAccountBalances` via `GET /api/accounts`. Summing across banks is
  the same code path once more accounts are connected.

**Non-goals:** multi-currency conversion (balances are summed naively; ILS-only in
practice today), and historical balance tracking (the balance is the latest scrape value).

## Consequences

### Positive
- "How much do I have?" and "what was my cash flow?" are each answered unambiguously.
- Adding another bank automatically increases the total with no dashboard changes.

### Negative / risks
- Naive cross-currency summation would be wrong if a non-ILS account is added; revisit
  when that happens.
- The balance is only as fresh as the last sync.

## References

- `src/lib/services/accountService.ts`, `src/app/api/accounts/route.ts`, `src/app/page.tsx`
- `docs/REQUIREMENTS.md §3.10`, `docs/DESIGN.md §13`
