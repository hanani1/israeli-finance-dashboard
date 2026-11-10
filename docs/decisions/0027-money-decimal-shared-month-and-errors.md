# ADR-0027: Money as DECIMAL, one flow-month predicate, one API error policy

- **Date:** 2026-11-03
- **Status:** Accepted
- **Area:** Data / Architecture / Security
- **Owners:** Finance Dashboard maintainers

## Context

Trello card #53 (12.12) bundles three cleanups.

1. **Money was `Float`.** `Transaction.chargedAmount`, `originalAmount`,
   `Account.balance` and `Budget.amount` were `double precision`. Postgres
   `SUM` and the JS reducers added binary floats, so API totals carried noise
   (`43210.89999999999`). Amount matching (transfers, card settlements,
   pending → settled, refunds, non-cash reconciliation) only worked because
   each module had its own `Math.round(x * 100)` agorot key, and every new
   call site had to remember to round. Rounding a float average was also not
   deterministic: on the same data, a change in SQL summation order moved
   `avg6` from `7696.83` to `7696.84`.
2. **The month predicate was duplicated.** The monthly breakdown used the
   effective flow month (stored RiseUp `flowMonth`, falling back to the
   Israeli calendar month). The monthly transaction list re-implemented it.
   Budget pacing did not use it: it bucketed spend by calendar date. A Jan-31
   purchase that RiseUp assigns to February therefore counted against
   January's budget but showed in February's breakdown.
3. **API errors were ad hoc.** Some routes returned `error.message` for any
   failure, which could be a Prisma message with file paths. Others let
   Prisma errors escape as unhandled 500s. A malformed JSON body was a 500
   in most routes.

## Decision

### 1. Money columns are `DECIMAL`, and `Prisma.Decimal` is the server type

- Migration `20261103140000_money_decimal`:
  - `chargedAmount`, `balance` and `Budget.amount` become `DECIMAL(14,2)`
    (agorot; up to ±999,999,999,999.99).
  - `originalAmount` becomes **`DECIMAL(14,3)`**. It is the merchant-side
    amount in the *original* currency, and ISO 4217 gives JOD, KWD, BHD, OMR
    and TND three minor-unit digits. Rounding a purchase in Amman or Petra to
    two decimals would be real data loss. The column is never summed. It is
    used for display and for the pending-settlement match, which compares at
    agorot precision.
  - Each column is converted `USING round(x::numeric, scale)`. The
    `float8 → numeric` cast keeps 15 significant digits, so binary noise
    (`0.30000000000000004`) disappears and the value is pinned to the scale.
    Before converting, the migration raises a `NOTICE` with the number of
    values that genuinely had more digits than the scale. Prisma does not
    print notices, so run the preflight query below by hand.
  - There are no exchange-rate columns. `chargedAmount` is always in the
    settlement currency (ILS, USD, EUR, GBP), all of which have two decimals.
- `src/lib/services/money.ts` is the only money API:
  - `money()`, `sumMoney()` and `divideMoney()` (half-up to the agorot) do
    exact Decimal arithmetic.
  - `toAgorot()` and `absAgorot()` give exact integer keys for every matcher.
    The per-module `Math.round(x * 100)` helpers are gone.
  - `moneyToNumber()`, `agorotToNumber()` and `originalAmountToNumberOrNull()`
    are the **only** Decimal → number conversions. They are used when a
    response DTO, a report line or the LLM prompt is built, which is the
    UI/JSON boundary. `ratioToNumber()` handles dimensionless ratios such as
    the pace ratio.
- Pure modules accept `MoneyInput` (`Decimal | number | string`), so tests
  and scraper input can still pass plain numbers. Services pass the Prisma
  Decimals straight through.
- `Decimal#toJSON()` returns a **string**, so a raw Prisma row must never
  reach `NextResponse.json`. Transaction rows go through
  `serializeTransaction()`, and every other response is an explicit DTO.
  Client code and API contracts are unchanged: money is still a JSON number.
- Writes are pinned to the column scale at the boundary: `money()` and
  `originalAmount()` are applied to scraper rows, balances, budgets and
  RiseUp imports. The ingestion identity lookup compares at that scale too.
  The deterministic transaction-id fingerprint still uses the **raw scraper
  number**. Changing its text would re-key every existing row and duplicate
  it on the next scrape.

### 2. `effectiveFlowMonthWhere` lives in `flowMonth.ts` and is shared

The monthly breakdown (selected month and its 6-month average), the
`flowMonth` transaction list and budget pacing all use the same predicate.
Callers put it inside `AND`, so their own `OR` clauses cannot replace it. The
budget behaviour therefore changes: "spent" now follows the effective flow
month. `flowMonthWhere.test.ts` checks the predicate against
`effectiveFlowMonth()` for rows around month edges, and checks that the
budget, breakdown and list predicates agree.

### 3. API errors go through one handler

- Every route is exported as `withRouteErrors(handler)` from
  `src/lib/api/routeError.ts`. That module maps errors as follows:
  - `RequestError` → its 4xx status and message.
  - `SyntaxError` → 400 `Invalid JSON body`.
  - Prisma `P2025` → 404 `Not found`.
  - Prisma `P2002` or `P2003` → 409 `Conflict: …`.
  - Anything else → 500 `Internal server error`. The full error is logged on
    the server and never appears in the response body.
- Services signal client errors with `RequestError` from
  `src/lib/services/requestError.ts`, which has no dependencies. Examples: a
  blank member name, a negative budget, missing login fields, a member who
  still owns accounts (409). These replace the blanket `catch → 400
  error.message` blocks.
- Routes keep their explicit 4xx validation responses and messages, for
  example `id must be an integer`, `Transaction not found` and
  `Category not found`.
- `routeError.test.ts` fails if any `src/app/api/**/route.ts` exports an
  unwrapped handler. That includes `chat/route.ts`: it keeps its explicit
  403 (disabled / not local), 429 (rate limit) and curated CLI-failure
  (e.g. 503) responses; only an unexpected throw reaches the shared handler.
- **Chat raw queries (ADR-0026).** The chat's read-only client runs
  `$queryRaw`, so numeric money columns, and `SUM`/`ROUND`/`AVG` over
  them, come back as `Prisma.Decimal`. `chatTools.redactResultValue`
  converts them to plain JSON numbers before the DATA lines are built. This
  is the model's input boundary, so it is the same rule as API DTOs.
  `chatTools.test.ts` covers this. The typed tools' SQL (`CASE … ELSE 0`,
  `ROUND(SUM(…)::numeric, 2)`) works unchanged on `DECIMAL`. The
  column-level grants of the read-only role survive `ALTER COLUMN … TYPE`.

## Consequences

### Positive
- Totals are exact and deterministic. A synthetic 837-row snapshot with
  injected float noise gave identical sums before and after the migration on
  every captured endpoint. The only differences were half-agorot ties in
  derived divisions, listed next.
- Matching is integer-exact everywhere, through one helper.
- A Prisma failure no longer leaks file paths or SQL details. A bad JSON
  body is a 400, a missing record is a 404 and a conflict is a 409.

### Negative / risks
- **Half-agorot ties now round half-up.** Two derived values move by one
  agorot, but only when the exact value ends in ½ agorot:
  - `avg6 = Σ / 6` when Σ in agorot ≡ 3 (mod 6).
  - The pacing projection `spent × days / elapsed`.
  The float code rounded such ties up or down depending on representation
  noise and summation order. Sums themselves never change.
- **Budget "spent" changes for rows whose stored `flowMonth` differs from
  their calendar month.** This is intended: budgets now match the breakdown.
- Decimal arithmetic is slower than float arithmetic. This is irrelevant at
  household scale (thousands of rows).
- A future route that returns a raw Prisma row with money in it would send
  strings. Review for `serializeTransaction` or a DTO. The
  route-wrapper test does not catch this.

## Alternatives considered

- **Keep `Float` and round at every call site.** This was the status quo,
  and the card exists to end it.
- **Integer agorot columns (`BIGINT`).** Exact, but every raw SQL query (the
  chat's read-only data tools and `query` SQL, scripts, RiseUp reconciliation) would have to
  divide by 100. It would also need a second representation for the
  three-decimal original currencies.
- **`DECIMAL(14,2)` for `originalAmount` too.** Rejected because of the
  three-minor-unit currencies above.
- **Abort the migration when a value has more digits than its scale.**
  Rejected. Sub-agorot digits on an ILS/USD/EUR settlement amount are
  meaningless, and a migration that blocks the deploy is worse than a
  counted, logged rounding.

## Follow-up

- **Before deploying, on the primary machine (read-only):**

  ```sql
  SELECT
    count(*) FILTER (WHERE "chargedAmount"::numeric <> round("chargedAmount"::numeric, 2)) AS charged_gt2,
    count(*) FILTER (WHERE "originalAmount" IS NOT NULL
                       AND "originalAmount"::numeric <> round("originalAmount"::numeric, 3)) AS original_gt3,
    count(*) FILTER (WHERE "originalAmount" IS NOT NULL
                       AND "originalAmount"::numeric <> round("originalAmount"::numeric, 2)) AS original_gt2
  FROM "Transaction";
  SELECT count(*) FILTER (WHERE balance::numeric <> round(balance::numeric, 2)) FROM "Account";
  SELECT count(*) FILTER (WHERE amount::numeric <> round(amount::numeric, 2)) FROM "Budget";
  ```

  Take a `pg_dump` first, then run `npm run db:deploy`.

## References

- Trello card #53 (12.12). Prerequisite #46.
- `prisma/migrations/20261103140000_money_decimal/migration.sql`
- `src/lib/services/money.ts`, `src/lib/services/flowMonth.ts`,
  `src/lib/api/routeError.ts`, `src/lib/services/requestError.ts`
- ADR-0022 (immutable timestamped migrations), ADR-0024 (refund flag)
