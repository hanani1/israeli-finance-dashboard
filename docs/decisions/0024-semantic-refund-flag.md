# ADR-0024: Same-sign provider refunds are marked with a semantic `isRefund` flag

- **Date:** 2026-11-02
- **Status:** Accepted
- **Area:** Data / Business
- **Owners:** Finance Dashboard maintainers

## Context

The flow policy (`flowClassification.ts`) decides income vs. expense by **sign and
category group**: a negative row is an expense, a positive non-income row is a refund
that reduces expenses (the MAX `-₪850` purchase + `+₪850` refund nets to zero).

Some providers report a refund or partial reversal with the **same sign as the
purchase**. Pasta Bar (card #60): a `-₪250` purchase followed by a `-₪125` reversal. By
sign alone both are expenses (₪375), but economically the household spent ₪125. The raw
provider row is correct provider data and must not be deleted, netted, or re-signed:
raw amount/sign, identifier, dates, category, note and source data are preserved.

Nothing in the raw data distinguishes such a reversal from a second, smaller purchase
at the same merchant reliably, so an automatic rule would hide legitimate spending.

## Decision

1. **`Transaction.isRefund Boolean @default(false)`** (migration
   `20261102130000_transaction_is_refund`). It is a semantic override only; the raw
   `chargedAmount` stays negative. A DB `CHECK (NOT "isRefund" OR "chargedAmount" < 0)`
   keeps it negative-only: positive refunds are already handled by sign.
2. **Policy:** an `isRefund` row is **+|amount| income and never an expense**, whatever
   its category: `classifyFlow(amount, group, true) = { income: -amount, expense: 0 }`.
   Pasta Bar shows two rows: ₪250 expense, ₪125 income, net ₪125 expense. Because the
   flag is negative-only the rule is linear, so `groupBy` sums of flagged rows classify
   exactly like individual rows (aggregates group by `[categoryId, isRefund]`).
   The card asked for income semantics ("+₪125 income") rather than an expense
   reduction; the purchase therefore stays a full expense in its category.
3. **Every aggregate honours it:** summary cards and trend (via `classifyFlow`), the
   monthly breakdown (a separate `refunds { total, count }` line included in
   `totalIncome`; per-category totals and 6-month averages exclude flagged rows), the
   expense pie and budgets (flagged rows are not spend), the transactions list month net
   and amount display (`currencyDisplay.semanticAmount`: green `+|amount|` with a
   "refund" label), the RiseUp reconciliation script, and the chat SQL primer.
4. **Ownership:** `isRefund` is user/reconciliation-owned — listed in
   `USER_OWNED_TRANSACTION_FIELDS`, never in the scrape upsert payload, so re-ingestion
   cannot erase it.
5. **Setting it:** the user toggles "Mark as refund" in the transaction details dialog
   (`PATCH /api/transactions/[id]` with JSON `{ "isRefund": boolean }`; only visible
   negative rows, not transfers or hidden settlement snapshots). One-off/historical
   corrections use `scripts/mark-transaction-refund.ts` (requires a fresh pg_dump via
   `--backup`, dry run by default, `--apply --confirm-db=<db>` to write, `--revert`).
6. **Detection is review-first.** `refundCandidates.ts` /
   `scripts/report-refund-candidates.ts` only *report* same-sign candidates; they never
   mark. Same account + currency + agreeing merchant text + `|refund| ≤ |original|` +
   plausible dates is necessary but **not sufficient** (that describes a second
   purchase). A candidate also needs evidence: a shared provider identifier within 14
   days with a partial amount, or an explicit refund keyword (זיכוי / ביטול / refund /
   reversal). One qualifying original → `likely`; several, equal amounts, or chains →
   `ambiguous`.

**Non-goals:** automatic marking; positive-sign refunds (unchanged); pairing a refund
to its original in the schema (the report shows the proposed original only).

## Consequences

### Positive
- Raw provider data stays intact and auditable; the correction is one reversible bit.
- One policy function drives every total, so the views keep reconciling.
- Legitimate repeated purchases are never hidden by a heuristic.

### Negative / risks
- Same-sign refunds are counted only after a human marks them; until then expenses are
  overstated by the refund amount (the report lists candidates to review).
- Income now includes marked refunds, so "income" is not only salary-like income; the
  breakdown shows refunds as their own line to keep that visible.
- RiseUp's sign convention still counts a marked row as an expense; reconciliation
  shows both conventions.

## Alternatives considered

- **Re-sign the raw row (-125 → +125):** loses provider truth and is overwritten or
  duplicated by the next scrape.
- **Net the refund into the purchase / hide one row:** violates "two separate rows" and
  hides the economic events.
- **Treat it as an expense reduction (like positive refunds):** rejected because the
  card specifies `+₪125` income semantics; the net is identical either way.
- **Automatic detection and marking:** rejected; same-merchant smaller purchases are
  common and indistinguishable without strong evidence.

## Follow-up

- Run the historical Pasta Bar correction on the primary machine (dated pg_dump, dry run,
  apply, verify) — see card #60.
- Revisit the detector evidence rules once real same-sign refunds have been reviewed.

## References

- Trello card #60; `src/lib/services/flowClassification.ts`, `refundCandidates.ts`,
  `refundCorrection.ts`, `transactionPatch.ts`, `scrapedTransactionWrite.ts`.
- ADR-0004 (deterministic idempotent ingestion), ADR-0016 (category groups/breakdown).
