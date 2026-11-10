# Design & Architecture — Personal Finance Dashboard

> How the system works and why it's built this way. Requirements live in `REQUIREMENTS.md`;
> durable rationale and alternatives live in [`decisions/README.md`](decisions/README.md).

## 1. System Overview

```
┌──────────────┐   fetch    ┌─────────────────────┐
│  Browser UI  │ ─────────▶ │  Next.js API routes │
│ (App Router) │            │  src/app/api/*      │
└──────────────┘            └────────┬────────────┘
                                     │ service layer calls
                            ┌────────▼────────────┐
                            │  src/lib/services/* │──▶ Prisma ──▶ PostgreSQL
                            └────────▲────────────┘
                                     │
┌──────────────┐  04:00 cron ┌───────┴─────────────┐   Puppeteer   ┌──────────────┐
│  worker.ts   │ ──────────▶ │ jobs/ingestion.ts   │ ────────────▶ │ Bank websites │
└──────────────┘             │ (decrypt→scrape→    │               └──────────────┘
                             │  upsert→rules)      │
                             └─────────────────────┘
```

Three entry points share one codebase and one service layer:
web server (UI + API), cron worker, and the manual `POST /api/sync` trigger.

## 2. Layering Rules

- `src/app/**` — routes/pages only; no direct Prisma access.
- `src/lib/services/*` — all DB access (transactionService, analyticsService, budgetService, credentialService, userService, ruleEngine). Pure, DB-free helpers (e.g. `budgetPacing.ts`) live here too and are unit-tested directly.
- `src/lib/security/crypto.ts` — the only module that touches `ENCRYPTION_KEY`.
- `src/lib/jobs/*` — scraping + ingestion; the only place credentials are decrypted.
- `src/components/**` — presentational; data arrives via props/fetch.

## 3. Deterministic, Idempotent Ingestion

**Problem**: scrapers re-return overlapping windows of transactions on every run; pending
card transactions later settle with the same identity.

**Decision**: derive the primary key instead of generating it:
`id = SHA256(accountId + "_" + date.toISOString() + "_" + chargedAmount + "_" + description)`.
Account ids are likewise derived: `SHA256(userId + "_" + provider + "_" + accountNumber)[:32]`.

- Upserts keyed on the derived id make re-ingestion a no-op for unchanged rows.
- The upsert's `update` branch deliberately excludes `categoryId` / `categorizationSource`
  so user and rule decisions survive every re-scrape.
- Trade-off: if a bank retroactively edits a description or amount, the row appears as a
  new transaction (accepted; rare in practice).
- Runs are serialized across all entry points (worker, `sync:once`, Sync Now, credential
  save) by a database lease (`IngestionLease`, heartbeat + 10-minute TTL); a second run
  returns `skipped: 'ingestion already running'` and `/api/sync` answers 409. The identity
  lookup is backed by a non-unique `(accountId, txnIdentifier)` index. See ADR-0021.
- Pending rows: the scraper's `status` is stored as `providerStatus`. A pending row with a
  matching settled row is hidden by `pendingSettlement.ts`; a pending row the provider
  stopped returning is retired (hidden via `isCardSettlement`, stamped `pendingRetiredAt`,
  never deleted, restored if it reappears) once older than a 14-day horizon. A missing
  `chargedCurrency` (Cal pending rows) keeps the purchase currency when the charged and
  original amounts are equal, instead of defaulting to ILS. See ADR-0025.

## 4. Credential Security Model

- AES-256-GCM (authenticated encryption): `{ciphertext, iv, tag}` Base64 columns on
  `BankCredential`; fresh random 96-bit IV per encryption; 32-byte hex key in `ENCRYPTION_KEY`.
- Login fields (per-provider shapes) are serialized to one JSON blob then encrypted —
  schema stays provider-agnostic.
- Read path returns metadata only; decryption exists solely inside `ingestCredential()`.
- Threat model: DB/backup theft ⇒ useless without the key. Full host compromise ⇒
  key + ciphertext leak together — mitigated by the **view-only bank user policy** (§7).

## 5. Categorization Pipeline

Categorization is layered and monotonic: each stage only claims rows where
`categoryId IS NULL`.

1. Rules run first as parameterized, set-based SQL updates in priority order and mark
   matches `RULE`.
2. If `KIRO_CATEGORIZATION_ENABLED=true`, the host worker processes one bounded batch
   (maximum 100) and invokes the no-tools `finance-categorizer` agent through Kiro CLI
   headless mode. Numeric identifiers are redacted; opaque indexes, descriptions,
   amounts, category metadata, and per-run nonce markers are written to a mode-`0600`,
   gitignored runtime resource that is removed afterward. Strict JSON, index,
   completeness, nonce-marker, and category-ID validation occurs before one atomic
   database update marks rows `LLM`.
3. Manual selection marks a row `MANUAL` and remains the final user-controlled decision.

The Kiro subprocess has a timeout and no automatic retry. Authentication, model,
validation, or CLI failures are recorded in the ingestion summary while rows remain
unassigned. The unauthenticated web sync route never invokes Kiro; only the host cron
worker and explicit one-shot command can spend credits. This avoids probabilistic output
blocking bank ingestion or overriding known behavior. See ADR-0005 and ADR-0009.

## 6. Frontend Decisions

- **URL-backed global filters** (`useGlobalFilters`): date range + member filter live in
  search params — shareable links, no state library needed. The dashboard header also offers
  relative presets (`range=3m|6m|12m`, current month + N-1 previous whole months, ending
  Israel-local today; recomputed on load) — see ADR-0023.
- Pages are client components fetching JSON APIs (the API layer is needed anyway for the
  worker-adjacent actions), wrapped in layout-level `<Suspense>` for `useSearchParams`.
- Manual categorization flow: PATCH transaction → optimistic row update → auto-rule modal →
  on confirm POST /api/rules (creates + applies) → table refetch.
- IDs: `User`/`BankCredential`/`Account`/`Transaction` ids are **strings** (UUID/SHA-derived);
  `Category`/`CategorizationRule` ids are ints. (A `Number(uuid)` bug from an early
  iteration is fixed — keep types honest.)

## 7. Bank Access Strategy (view-only users)

Scraping requires real bank credentials; policy is to minimize their power:

| Provider | Read-only option | How |
|---|---|---|
| Discount | Yes — info-only user code | No self-service: call Telebank 03-9439191 or branch; banker issues an additional user code with "הרשאת מידע בלבד". Verify it works on telebank.co.il (website, not just app). Fields: `id`, `password`, `num`. |
| Leumi | Yes — view-only secondary user (procedure unverified; ask *5522) | Fields: `username`, `password`. |
| Max | N/A — card site is informational | Includes **Shufersal cards** (Max-operated; no separate scraper provider). Fields: `username`, `password`. |
| Isracard | N/A — card site is informational | Includes **FlyCard** (Isracard-issued; no separate provider). Fields: `id`, `card6Digits`, `password`. |

## 8. Deployment

- Single Docker image (node:20-bookworm-slim + apt Chromium, `PUPPETEER_SKIP_DOWNLOAD=1`,
  `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`, non-root user) runs three roles:
  - `app`: `prisma migrate deploy && prisma db seed && node server.js`
  - `worker`: `npm run worker` (cron 04:00, `--once` for one-shot)
  - migrations ship in the image (`prisma/migrations/0_init`).
- compose: `db` (postgres:16-alpine + healthcheck + pgdata volume), `app` (:3000), `worker`.
- **No auth layer by design** — deploy on trusted LAN/VPN or behind an authenticating
  reverse proxy only.
- **Kiro on a VM** — supported when `npm run worker` runs directly on the VM under the
  same OS user that installed/logged into Kiro CLI and the checkout includes
  `.kiro/agents/finance-categorizer.json`. The stock worker container cannot categorize
  through Kiro because the image and container user do not have the CLI/auth state.
  Container support requires an explicit secure provisioning design; never mount the
  whole host home directory merely to obtain Kiro credentials.

## 9. Budgets & Pacing

Monthly, per-category budgets with pace computed at read time (see ADR-0012).

- **Model**: `Budget` — one row per category (`categoryId @unique`), positive monthly
  `amount`, cascade-deleted with its category. The overall total is derived by summing
  category budgets rather than stored as its own row.
- **Pure core** (`src/lib/services/budgetPacing.ts`): `computePacing` is Date-/DB-free —
  `expectedByNow = amount × elapsedFraction`, a linear `projected` run-rate, and a
  `under`/`on`/`over` verdict within ±5%. `resolveMonthWindow(month, now)` maps `yyyy-MM`
  to a UTC `[start, end)` window and elapsed-day counts (full month in the past, current
  day for the ongoing month, injectable `now` for tests). Unit-tested in `budgetPacing.test.ts`.
- **Service/API**: `budgetService.getBudgetPacing` groups negative `chargedAmount` for the
  window (honoring the household `userId` filter, same convention as analyticsService) and
  returns per-category + total pacing. Exposed via `GET/POST /api/budgets` and
  `DELETE /api/budgets/[id]`.
- **UI**: `/budgets` page (month picker + editable per-category amounts) with a
  `BudgetPacingChart` (Recharts bars colored by pace). Client-fetch pattern like the dashboard.

## 10. Internationalization (Hebrew / RTL)

`next-intl` **without i18n routing** — the locale lives in a cookie, not the URL (see ADR-0013),
which suits a single-user self-hosted app that needs no per-locale URLs or SEO.

- **Resolution**: `src/i18n/config.ts` (locales, default, RTL set, `LOCALE` cookie) +
  `src/i18n/request.ts` (`getRequestConfig` reads the cookie server-side and loads
  `messages/{locale}.json`); wired via `createNextIntlPlugin` in `next.config.mjs`.
- **Direction**: the async root layout sets `<html lang dir>` and wraps the tree in
  `NextIntlClientProvider`. Shared chrome uses logical utilities (`border-e`, `ms-auto`) so
  `dir="rtl"` mirrors correctly.
- **Switching**: `LocaleSwitcher` → `POST /api/locale` (persists cookie) → client refresh.
- **Coverage**: the entire UI is translated (en + he) — navigation, header, dashboard,
  budgets, transactions, and settings. **Hebrew is the default locale.**
- **Categories**: seeded in Hebrew (`prisma/seed.ts`); names are data, so they display
  identically in both languages. Insurance (ביטוח ופיננסים) uses teal `#0d9488` so it is
  visually distinct from the gray General Expenses (הוצאות כלליות) in the breakdown chart.

## 11. Current Balance vs. Cash Flow

The dashboard separates two concepts (ADR-0014): **cash flow** (income / expenses / net
over the header date range) and **current balance** (a point-in-time stock). Balance is
served by `accountService.listAccountBalances` (`GET /api/accounts`) as the sum of
`Account.balance` across accounts plus a per-account breakdown; the same code aggregates
multiple banks into one total. Balances are summed naively (ILS-only today; no FX).

## 12. Monthly View (RiseUp-style)

`/monthly` presents month navigation + a "variable expenses" hero + per-category cards
(spent, budget, a pacing bar colored by pace, remaining/over amount). It reuses the
Budgets pacing data (`GET /api/budgets` → `getBudgetPacing`), so pacing logic lives in one
place (`budgetPacing.ts`). The household filter applies; the month is page-local state.

## 13. Categorization Review & Daily Reminder

Not-yet-reviewed = `categorizationSource != MANUAL` (a `needsReview` filter on the
transactions API). The transactions table shows a green dot + a one-click confirm tick;
`CategorizeReviewModal` steps through the items pre-selecting the heuristic category; and
`DailyCategorizeReminder` (mounted in the layout) shows a once-per-day `localStorage`-gated
prompt linking to `/transactions?review=1`. See ADR-0015.

## 14. Trend Category Filter & Header Scoping

- The spending-trend chart can filter to a single expense category. The category filter is
  applied only to the trend query (`trendCategoryId` → `getSpendingTrend`), leaving the
  summary and breakdown across all categories.
- The header's from/until date range renders only on `/` (the dashboard); other pages own
  their time controls (Transactions by month, Budgets/Monthly via month selection).

## 15. Transactions Windowing

Transactions default to the last 3 months and are grouped by month (header + monthly net).
An `IntersectionObserver` sentinel widens the window by 3 months as the user scrolls; when
widening yields no new rows, it stops (nothing older). The window is page-local; only the
household filter is shared.

## 16. Future Work / Backlog

Highlights:
- Broader logical-property RTL polish across deep components.
- Port merchant-memory / automatic transfer detection from Spent (deferred; touches the categorization pipeline).
- Connect Discount, Leumi, Max (Shufersal), Isracard (FlyCard) with view-only users.
- CSV/Excel import endpoint for historical data (RiseUp export or bank file downloads),
  feeding the same deterministic-id pipeline.
- Optional: extend first-sync lookback beyond 90 days (bank-dependent, up to ~1 year).
- Optional: authentication layer if ever exposed beyond localhost/LAN.

## 18. Category Taxonomy Groups & Monthly Breakdown

Categories carry a `CategoryGroup` (`VARIABLE_EXPENSE` / `RECURRING_EXPENSE` / `INCOME`) in
addition to `type`; uniqueness is `@@unique([name, group])` because names repeat across
groups (ADR-0016). The seed defines the ~35-category Hebrew taxonomy and is idempotent by
`(name, group)`; migrating an existing DB retags/renames the old categories in place so
transactions keep their `categoryId`. Classification fills the taxonomy via rules → Kiro
LLM. `analyticsService.getMonthlyBreakdown` (`GET /api/monthly-breakdown`) aggregates a
month's transactions into per-group, per-category totals; the `/breakdown` tab renders a
pie of expenses plus the grouped lists.

## 19. Same-Sign Refunds (`isRefund`)

Some providers report a refund or partial reversal with the same sign as the purchase
(Pasta Bar: -₪250 purchase, -₪125 reversal). `Transaction.isRefund` (user-owned, never
touched by ingestion, negative rows only) makes such a row +|amount| income in every
aggregate via `flowClassification.classifyFlow`, while the raw amount stays negative in
the DB/API. The monthly breakdown reports them as a separate `refunds` line included in
`totalIncome`; budgets and the expense pie ignore them; the UI shows them green and
positive. Users toggle the flag in the transaction details dialog (`PATCH
/api/transactions/[id]` `{ isRefund }`). `scripts/report-refund-candidates.ts` lists
review-only candidates (never marks); `scripts/mark-transaction-refund.ts` applies a
backed-up, reversible one-row correction. See ADR-0024.

## 20. Free-text Chat (tool-less model, server-side read-only tools)

See [ADR-0026](decisions/0026-tool-less-chat-with-server-side-readonly-tools.md).

`POST /api/chat` has several gates: `CHAT_ENABLED`, `isLoopbackRequest`, the
middleware CSRF guard and a global rate limit. It calls `chatService().submit`, which
persists a pending `ChatMessage` (idempotency key, ADR-0028), returns at once, and runs
`chatLoop.runChatLoop` on the process-wide serialized queue in the background. The page
polls `GET /api/chat/conversations/[id]`; status changes follow the pure state machine in
`chatConversation.ts` (compare-and-set on status + runner id; pending rows of a dead
process are recovered as `failed/interrupted`). The replayed history is the conversation's
completed turns from the database, capped. `/chat` also shows a chat-only conversation
list (`components/chat/ConversationSidebar.tsx`, `GET /api/chat/conversations`; a drawer
below `md`). The loop makes up to 4 rounds. Each round:

1. `chatProtocol.buildChatPrompt` builds the prompt: instructions, tool catalog, schema,
   category names, the capped history, the question, the DATA from earlier rounds, and
   fresh nonce markers.
2. `chatCli.runChatModel` spawns a **tool-less** Hermes or Kiro one-shot. The prompt goes
   through a 0600 file in an empty temp dir, and the child gets an allowlisted environment.
3. `chatProtocol.parseModelReply` accepts exactly one JSON envelope:
   `answer` | `tools` (≤3 calls).
4. `chatTools.planToolRequest` turns each call into fixed, parameterized SQL (typed tools)
   or runs `chatSqlValidator.validateChatSql` (raw `query`: AST allowlist, single SELECT,
   re-serialized).
5. `chatSqlValidator.buildScopedQuery` wraps it in table-shadowing CTEs. They expose
   allowlisted columns only, apply the household filter `$1`, drop card-settlement rows,
   and add a `LIMIT`.
6. `chatReadonlyDb.executeReadonlyQuery` runs it on a separate Prisma client (`CHAT_DB_URL`,
   role `finance_chat_ro`) inside `SET TRANSACTION READ ONLY` with
   `statement_timeout = 5s`. It first verifies that the role is not privileged.
7. `chatTools.shapeToolRows` redacts the rows (`redactTransactionDescription`) and caps them
   at 200.

The role and its column-level grants come from the idempotent
`scripts/setup-chat-readonly-role.sql`, not from a migration: roles are cluster-wide and
need a password set out of band. The pure modules (`chatSqlValidator`, `chatTools`,
`chatProtocol`, `chatLoop`, `chatSession`, `chatCli`, `chatConversation`) are unit tested,
and the loop and the background service are tested with a fake `hermes` executable. The
chat tables are never granted to the chat role nor allowlisted in the validator.

## 17. Development History Notes

- Built 2026-08-05/06; verified via `next build`, `tsc --noEmit`, crypto round-trip +
  tamper tests, and live end-to-end API tests (rule engine, analytics, credential
  encryption, member CRUD) against a local PostgreSQL 16 (Homebrew).
