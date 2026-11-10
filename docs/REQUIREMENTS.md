# Product Requirements — Personal Finance Dashboard ("RiseUp Clone")

> Source of truth for what this application must do. See `DESIGN.md` for how it does it and
> [`decisions/README.md`](decisions/README.md) for why durable choices were made.

## 1. Vision

A production-grade, **self-hosted** personal finance web application for a household,
replacing RiseUp. It automatically ingests transactions from Israeli banks and credit
cards, categorizes them with user-defined rules, and presents cash-flow analytics on a
responsive (mobile-first) dashboard. All financial data and credentials stay on the
owner's own machine.

## 2. Tech Stack (pinned)

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + React 19 + TypeScript (strict) |
| Styling | Tailwind CSS 3 + shadcn-style primitives |
| Charts | Recharts 3 |
| ORM / DB | Prisma 6 + PostgreSQL 16 |
| Scraping | israeli-bank-scrapers 6 (Puppeteer-based) |
| Scheduling | node-cron (daily 04:00) |
| Encryption | Node crypto — AES-256-GCM |
| i18n | next-intl 4 (cookie-based locale, no i18n routing) |
| Deployment | Docker + docker-compose (app, worker, postgres) |

## 3. Functional Requirements

### 3.1 Ingestion
- Scrape all configured bank/card providers daily at 04:00 plus on-demand ("Sync Now").
- 90-day default lookback per scrape; a one-off full-history backfill is available via `npm run sync:once -- --from=YYYY-MM-DD` (bank/scraper caps apply — e.g. Discount ~1 year, Leumi multi-year). Backfilled history persists (idempotent, no deletes), so routine syncs never re-fetch old transactions.
- **Deterministic transaction identity**: `SHA256(accountId + "_" + date.toISOString() + "_" + chargedAmount + "_" + description)` — re-running ingestion must never create duplicates (idempotent upserts).
- Re-ingestion must never overwrite user or rule category assignments.
- A failure on one credential must not abort ingestion of the others.

### 3.2 Categorization
- 13 seeded default categories (see `prisma/seed.ts`) with fixed colors and INCOME/EXPENSE types.
- Rule engine: case-insensitive substring match (SQL `ILIKE`) of rule pattern against transaction description; only applies where `categoryId IS NULL`; higher `priority` rules win; matched rows marked `categorizationSource = RULE`.
- Manual inline categorization from the transactions table marks `categorizationSource = MANUAL`; manual assignments always survive rule runs and re-ingestion.
- **Auto-rule modal**: after a manual categorization, offer "Auto-categorize all future transactions matching '<merchant>' as <Category>?" — confirming creates a rule (pattern editable) and immediately applies it.
- Optional Kiro LLM categorization runs only after rules and only for rows still unassigned. It is host/VM opt-in, uses a dedicated no-tools agent and configured model, batches inputs, redacts long numeric identifiers, and consumes Kiro credits.
- LLM output must include every opaque batch index exactly once and use only existing category IDs. Invalid, timed-out, unauthenticated, or unavailable-model responses leave rows unassigned without blocking bank ingestion.
- Provenance values are `UNASSIGNED`, `RULE`, `LLM`, and `MANUAL`; existing assignments are never overwritten, and manual selection remains authoritative.
- **Review & confirm:** a one-by-one review modal walks through not-yet-reviewed transactions (source != MANUAL), pre-selecting the heuristic category so the user can confirm (→ MANUAL), edit, or skip. A **once-per-day in-app reminder** prompts the user when items await review (see [ADR-0015](decisions/0015-categorization-review-and-reminder.md)).

### 3.3 Analytics (Dashboard)
- **Cash flow (selected period):** income, expenses, and net = income − expenses. "Net" is labeled explicitly so it is not mistaken for a bank balance.
- Pie chart: expense breakdown by category (uncategorized shown as its own slice; the slice/tooltip localize to the active language).
- Line chart: spending & income trend with Day/Month granularity toggle **and a filter by a single expense category**.
- Sign convention: expenses are negative `chargedAmount`, income positive.
- See §3.10 for the separate current-balance section.

### 3.4 Filtering
- Global header: household-member filter (All Household / specific member), plus a date-range picker (from/to) **shown only on the main dashboard** — other pages have their own time controls (Transactions loads by month; Budgets/Monthly use a month selector/navigation).
- Filters are URL-backed (shareable, survive navigation).

### 3.5 Transactions View
- Searchable (debounced) table: date, description, account, amount, inline category select, categorization source badge.
- **Defaults to the last 3 months**, **grouped by month** with a month header and the month's net; **infinite scroll loads earlier months** (3 at a time) until there are no older transactions.
- **Not-yet-reviewed rows** (source != MANUAL) show a **green dot** and a **confirm tick** that promotes the current heuristic category to MANUAL in one click.
- A **"review uncategorized"** action opens the one-by-one review modal (see §3.2).

### 3.6 Settings
- Household members: add / rename / delete (delete refused while the member owns bank connections or accounts).
- Bank connections: add credentials per member/provider (16 supported providers), list (metadata only), delete, Sync Now with a result summary.
- Rules: list / add / delete.

### 3.7 Multi-user model
- Household members are data-scoping entities (accounts belong to members), **not** login identities. The app itself has no authentication (see Security).

### 3.8 Budgets & pacing
- A monthly spending budget can be set **per expense category** (one budget per category; positive ILS amount).
- The Budgets view shows, for a selected month and the active household filter: total budget, spent-so-far, expected-by-now, and a linear end-of-month projection, plus per-category rows.
- **Pacing**: spend is compared against the elapsed fraction of the month and classified `under` / `on` / `over` (±5% tolerance); "on pace" means cumulative spend tracks the elapsed share of the budget.
- Budgets are editable and deletable inline; deleting a category cascades to its budget.
- Non-goals: budget rollover, per-month historical budget values, and non-linear/seasonal pacing (see [ADR-0012](decisions/0012-monthly-budgets-with-pacing.md)).

### 3.10 Current balance
- A dashboard section **separate from cash flow** shows the **current bank balance** = sum of `Account.balance` across all connected accounts, with a per-account breakdown and an explicit note that it is the amount in the bank now, not income.
- Designed to aggregate multiple banks into a single total-holdings figure (see [ADR-0014](decisions/0014-balance-separate-from-cashflow.md)). Multi-currency conversion is out of scope for now.

### 3.11 Monthly view (מבט חודשי)
- A single month-by-month tab (`/monthly`) — the former separate `/breakdown` tab was merged in (see [ADR-0017](decisions/0017-unified-monthly-view.md)). For a selected month it shows: a **Net** summary (income, expenses, net = income − all expenses incl. variable), a **pie of expenses by category**, and the **grouped per-category breakdown** (variable / recurring / income).
- Each category shows its total, its **trailing 6-month average** (the six months before the selected month), and the ±% delta.
- **Drill-down:** expanding a category lists its transactions; changing a transaction's category updates it (→ MANUAL), and a **"make permanent?"** prompt then updates all identically-described past transactions and creates a categorization rule.

### 3.12 Monthly breakdown tab
- Categories follow a grouped Hebrew taxonomy: `Category.group` ∈ {`VARIABLE_EXPENSE`, `RECURRING_EXPENSE`, `INCOME`}; names are unique per group (a name may appear in more than one group). See [ADR-0016](decisions/0016-category-taxonomy-groups-and-breakdown.md).
- All transactions are classified into the taxonomy (rules → Kiro LLM in batches). Credit-card aggregate charges (מקס/כאל/ישראכרט) arrive as single lump sums under תשלומים and cannot be itemized without connecting the card providers as their own credentials.
- The per-category breakdown is served by `GET /api/monthly-breakdown` and shown in the Monthly view (§3.11).

### 3.13 Free-text data Q&A (chat)
- `/chat` answers free-text questions about the household's data in Hebrew or English (RTL), with follow-ups that keep context within a session (server-side, 15-minute TTL, capped history).
- Answers come from a host-side **Hermes Agent** one-shot run (default; `CHAT_CLI=hermes|kiro`, `CHAT_CLI_PATH`, `HERMES_CHAT_MODEL`). The model has **no host tools**. The server runs every data lookup read-only, either typed tools or a single validated SELECT, through the `finance_chat_ro` role (`CHAT_DB_URL`), and lists the lookups under each answer.
- Opt-in and off by default (`CHAT_ENABLED=true`). Loopback-only, CSRF-guarded and rate limited. The current household-member filter is enforced by the server.
- Clear errors for: CLI missing or not logged in, timeout, output cap, too many lookups, database misconfiguration, and rate limiting. Empty data is reported plainly. See [ADR-0026](decisions/0026-tool-less-chat-with-server-side-readonly-tools.md).

### 3.9 Internationalization (Hebrew default + English, RTL)
- The UI supports Hebrew (default locale) and English; the reader can switch language from the header, and the choice persists in a cookie (no locale in the URL).
- Hebrew renders right-to-left (`dir="rtl"`); layout chrome uses logical CSS so it mirrors correctly.
- Translation covers the **entire UI**: navigation, header, dashboard, budgets, transactions, and settings (see [ADR-0013](decisions/0013-cookie-based-i18n-hebrew-rtl.md)).
- Category names are seeded in Hebrew (data, not UI strings) and render identically in both languages.

## 4. Security Requirements

- Bank credentials are encrypted with **AES-256-GCM** before persistence: payload = `{ciphertext, iv, tag}` (Base64), fresh random 96-bit IV per encryption, key from `ENCRYPTION_KEY` env (64-char hex = 32 bytes), authenticated decryption (tamper ⇒ throw).
- Plaintext credentials are never returned by any API; credential list endpoints expose metadata only. Decryption happens only in the ingestion worker, in memory.
- `.gitignore` must block `.env`, DB dumps, and Puppeteer caches.
- **Operational policy** (documented in README): app has NO auth layer — LAN/VPN or authenticating reverse proxy only. Bank credentials should be **view-only bank users** wherever the bank supports it (defense in depth; see DESIGN.md §7).
- The chat is disabled by default. When enabled, the page discloses that questions and looked-up data go to the model provider configured in Hermes/Kiro. The chat must never have shell, file or write access. Its DB role must not read `BankCredential`, account numbers, bank transaction identifiers or e-mails. Every query runs in a READ ONLY transaction with a 5 s statement timeout and a row cap, and long numeric identifiers are redacted before data reaches the model.
- Kiro categorization is disabled by default. When enabled, disclose that redacted descriptions and amounts are sent through the authenticated Kiro CLI session, may retain merchant/counterparty names, and consume credits. Never send bank credentials, account IDs, database IDs, or full long numeric identifiers.

## 5. Non-Functional Requirements

- Strict TypeScript everywhere; DB access isolated to service layers (`src/lib/services/*`); encryption isolated to `src/lib/security/crypto.ts`; scraping isolated to `src/lib/jobs/`.
- UI components presentational; accessible (labels, aria attributes); responsive: bottom tab bar `<768px`, sidebar on desktop.
- Reproducible builds: pinned dependency versions + committed `package-lock.json` + committed Prisma migrations.
- Single Docker image serves web, worker, and migrations; `docker compose up` is a complete deployment.

## 6. Seed Data

Categories are seeded in Hebrew as a grouped taxonomy (~35 categories) across `VARIABLE_EXPENSE`, `RECURRING_EXPENSE`, and `INCOME` groups (see ADR-0016) — variable e.g. סופר, אוכל בחוץ, רכב, פארמה; recurring e.g. דיור, משכנתא, חשמל, ביטוח; income e.g. משכורת, קצבאות, זיכויים. (The original flat list, retained for history:)
Categories are seeded in Hebrew (name / color / type): סופרמרקט #16a34a, דיור (שכירות/משכנתא) #2563eb, חשבונות ותשתיות #0284c7, מסעדות ובתי קפה #f97316, קניות #ec4899, תחבורה ודלק #eab308, מנויים ותוכנה #8b5cf6, ילדים #06b6d4, בריאות #ef4444, ביטוח ופיננסים #0d9488 — all EXPENSE; משכורת והכנסות #10b981, השקעות והעברות #6366f1 — INCOME; הוצאות כלליות #6b7280 — EXPENSE. (ביטוח ופיננסים uses teal #0d9488 to stay visually distinct from the gray הוצאות כלליות in the breakdown chart.) Plus two placeholder household members (rename via Settings UI).

## 7. Out of Scope (current version)

- Application-level authentication/authorization.
- Savings goals and notifications (RiseUp features not cloned). *(Budgets are now in scope — see §3.8.)*
- Open Banking API integration (requires ISA licensing).
- Historical import from RiseUp/bank file exports (planned — see DESIGN.md §9).
