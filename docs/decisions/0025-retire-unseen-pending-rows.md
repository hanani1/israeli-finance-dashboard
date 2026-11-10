# ADR-0025: Retire pending rows the provider stopped returning; never default a foreign pending charge to ILS

- **Date:** 2026-11-03
- **Status:** Accepted
- **Area:** Data correctness / Ingestion
- **Owners:** Finance Dashboard maintainers

## Context

Card #49. The pending → settled matcher (`pendingSettlement.ts`, 714bf1e) hides a pending
row once a settled row with the same amount and a close date arrives. Two cases stayed
wrong:

1. **Orphaned pending rows.** A cancelled authorization, or a purchase that settles under
   a different amount (restaurant tip, a foreign purchase converted to shekels), has no
   matching settled row. The pending row stayed visible forever as a phantom expense.
   Nothing recorded whether a row was pending at all: the scraper's `status` was dropped.
2. **Foreign pending charges labelled ILS.** `visa-cal.js` leaves `chargedCurrency`
   undefined on every pending row and reports `chargedAmount = -trnAmt` in the purchase
   currency; `normalizeCurrencyCode(undefined)` returned `ILS`, so a pending €50 was
   stored and summed as ₪50. `max.js` also returns `undefined` for unmapped currency ids.

Symbol normalization (₪/$/€/£, Hebrew names, lowercase) on both currency fields already
landed in 765b850 and is unchanged apart from two extra aliases (`ש״ח` with gershayim,
`US$`).

## Decision

1. **Persist `providerStatus`** (`pending` | `completed`, nullable for legacy rows) as a
   provider-owned field in the scrape upsert (migration
   `20261103120000_transaction_provider_status`).
2. **Retire, don't delete.** After every run, for each card account whose credential
   scraped **successfully** this run, and after the settlement matcher has run, a row is
   retired when: it is pending (`providerStatus = 'pending'`, or a legacy visaCal row
   without an identifier — Cal only sets identifiers on completed rows; no legacy guess for
   other providers), not already hidden, not a transfer, older than the provider's pending
   horizon (14 Israeli calendar days, `DEFAULT_PENDING_HORIZON_DAYS`, per-provider
   overridable), and **not returned by that scrape**. Retiring sets `isCardSettlement=true`
   (already excluded by every list, total, budget and breakdown) and stamps
   `pendingRetiredAt`.
3. **Self-healing.** If a later scrape returns a retired row again it is restored
   (`isCardSettlement=false`, `pendingRetiredAt=null`) before the matchers run, so they can
   re-evaluate it. Only rows with `pendingRetiredAt` are ever restored; rows hidden by the
   matcher, by settlement detection or by hand are never un-hidden by this rule.
4. **Currency when missing** (`scrapedCurrency.ts`): Isracard keeps its amount-based
   inference; an explicit provider value is normalized; a missing value keeps the
   (normalized) `originalCurrency` only when it is non-ILS and `|chargedAmount| ==
   |originalAmount|` (to the cent) and the charged amount is non-zero — otherwise the
   amount is already converted and is ILS. Rows in a foreign currency are excluded from
   ILS totals (never mixed), which is the intended behaviour for an unsettled foreign
   authorization.

## Why the horizon and "not returned" together

The scrapers drop rows dated before the requested start date, and Cal silently returns no
pending rows when its pending endpoint fails. So "not returned" alone is not proof that a
row is gone. The horizon bounds the damage: a row younger than 14 days is never retired,
and an older row is only hidden if the provider did not return it. A still-pending
authorization older than the horizon that falls outside the window is hidden until it
settles; the settled row then counts the purchase, so totals are not lost.

## Consequences

- No visible pending row older than the horizon survives the first post-deploy sync of its
  account (legacy Cal phantoms included). Audit with
  `psql -X -d <db> -f scripts/audit-pending-currency.sql` (read-only transaction).
- A manual category on a retired phantom is not carried anywhere (it has no twin by
  definition); rows matched to a settled twin are still handled by the matcher first,
  which carries manual categories.
- Existing foreign pending rows stored as ILS are corrected in place when re-scraped
  (`chargedCurrency` is provider-owned); old ones are retired. The audit lists suspects.
