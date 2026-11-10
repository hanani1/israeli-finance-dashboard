# Finance Dashboard

A **self-hosted, RiseUp-style household finance dashboard**. It automatically scrapes
transactions from Israeli banks and credit cards (via
[israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers)), stores bank
credentials **encrypted at rest with AES-256-GCM**, ingests transactions
**deterministically and idempotently** (safe to re-run — no duplicates), auto-categorizes
them with a case-insensitive `ILIKE` rule engine, and visualizes everything with a
Recharts dashboard in a mobile-friendly, PWA-style layout with a bottom navigation bar.
It also supports **monthly per-category budgets with pacing**, a **RiseUp-style monthly
view**, a dashboard that separates **current bank balance from period cash flow**, a
**daily categorization review** flow, and a **bilingual Hebrew (default)/English UI with
full right-to-left (RTL) support**.

Runs on your own hardware. Bank credentials and the database remain local; when optional
LLM categorization or the opt-in chat is enabled, redacted transaction descriptions and
amounts are sent to the selected Kiro or Hermes provider.

> ⚠️ **Read the [Security](#security) section before deploying.** The app ships with
> **no authentication layer** and must never be exposed to the public internet.

📚 **Project docs**: [Requirements](docs/REQUIREMENTS.md) · [Design & Architecture](docs/DESIGN.md) ·
[Decision Log](docs/decisions/README.md) · [Agent setup guide](AGENTS.md)

## Tech stack

| Layer           | Technology                                             |
| --------------- | ------------------------------------------------------ |
| Framework       | Next.js 15 (App Router, `output: 'standalone'`)        |
| Language        | TypeScript (strict mode)                               |
| UI              | React 19, Tailwind CSS 3, shadcn-style primitives, lucide-react |
| Charts          | Recharts 3                                             |
| Database        | PostgreSQL 16 + Prisma 6                               |
| Bank scraping   | israeli-bank-scrapers 6 (Puppeteer/Chromium)           |
| Scheduling      | macOS launchd → one-shot host worker at 04:00 Asia/Jerusalem |
| AI categorization | Hermes Agent or Kiro CLI headless mode (optional, host worker) |
| AI chat (Q&A)   | Tool-less Hermes/Kiro one-shot + server-side read-only tools (optional, opt-in) |
| i18n            | next-intl 4 (English + Hebrew, cookie-based locale, RTL)         |
| Deployment      | Docker app + PostgreSQL; macOS host worker for real Chrome and LLM CLI |

## Directory structure

```
finance-dashboard/
├── prisma/
│   ├── schema.prisma          # Users, accounts, encrypted credentials, transactions, categories, rules
│   └── seed.ts                # Idempotent seed: default categories + 2 household users
├── src/
│   ├── app/
│   │   ├── api/               # Route handlers: transactions, categories, rules,
│   │   │                      #   credentials, analytics, users, sync, budgets,
│   │   │                      #   accounts, locale
│   │   ├── transactions/      # Transactions: last-3-months, month-grouped, infinite scroll
│   │   ├── budgets/           # Budgets & pacing page (set budgets)
│   │   ├── monthly/           # RiseUp-style monthly view (month nav + pacing cards)
│   │   ├── page.tsx           # Dashboard (current balance + cash flow + charts)
│   │   └── layout.tsx         # Root layout (locale/dir, header, nav, daily reminder)
│   ├── components/
│   │   ├── layout/            # Header, Sidebar (desktop), BottomNav (mobile), LocaleSwitcher
│   │   ├── analytics/         # ExpensePieChart, SpendingLineChart, BudgetPacingChart
│   │   ├── transactions/      # TransactionsTable (green dot + confirm tick),
│   │   │                      #   CategorySelectModal, CategorizeReviewModal,
│   │   │                      #   DailyCategorizeReminder
│   │   └── ui/                # shadcn-style primitives: button, card, input,
│   │                          #   label, badge, select, dialog, table
│   ├── i18n/                  # config.ts (locales/cookie) + request.ts (next-intl)
│   └── lib/
│       ├── db.ts              # Prisma client singleton
│       ├── security/          # crypto.ts — AES-256-GCM encrypt/decrypt
│       ├── jobs/              # worker.ts (cron entrypoint), ingestion.ts (scrape + upsert)
│       ├── services/          # transactionService, analyticsService, budgetService,
│       │                      #   budgetPacing (pure), accountService, credentialService,
│       │                      #   ruleEngine
│       └── hooks/             # useGlobalFilters
├── messages/                  # next-intl catalogs: en.json, he.json
├── scripts/                   # Operational/maintenance scripts; diagnostics/ = provider probes
│                              #   (see "Script index" below)
├── Dockerfile                 # Multi-stage build (web + worker in one image)
├── docker-compose.yml         # db + app + worker services
└── .env.example               # Environment variable template
```

Imports use the `@/…` alias, which maps to `src/`.

## Prerequisites

- **Node.js 20+**
- **PostgreSQL 16** — either installed locally **or** via Docker (see
  [Docker deployment](#docker-deployment); for local dev you can also run just the
  database with `docker compose up -d db`)
- **Google Chrome for macOS** — used by the host worker for Isracard's browser-sensitive flow
- **Hermes Agent** (optional) — used for host-side LLM categorization and the opt-in chat; verify with `hermes doctor`
- **Kiro CLI** (optional alternative) — install and log in as the same OS user that runs the worker

## Local setup

```bash
# 1. Create your environment file
cp .env.example .env
#    then set POSTGRES_PASSWORD (required, e.g. `openssl rand -hex 24`) and use
#    the same password in DATABASE_URL

# 2. Configure an encryption key (pick ONE):
#    macOS — store it in the Keychain (recommended; leave ENCRYPTION_KEY empty in .env):
npm run key:keychain
#    Linux/any — generate a key and put it in .env as ENCRYPTION_KEY:
openssl rand -hex 32
#    Linux (systemd/Docker secrets) — point ENCRYPTION_KEY_FILE at a file with the key.

# 3. Install dependencies (postinstall runs `prisma generate`)
npm install

# 4. Create the database schema
npm run db:migrate        # prisma migrate dev

# 5. Seed default categories and household users (idempotent)
npm run db:seed

# 5b. Optional: six months of synthetic demo data (fictional merchants/accounts,
#     no bank credentials). Refuses to run if real transactions exist.
#     Remove it again with `npm run db:seed-demo -- --reset`.
npm run db:seed-demo

# 6. Start the dev server
npm run dev               # http://localhost:3000 (bound to 127.0.0.1)
```

## Running the sync worker

The scraper runs in a **separate host worker process**, not inside the web app. On macOS,
the recommended production setup is a launchd job so the worker can use real Chrome for
Isracard and the host Hermes CLI:

```bash
npm run worker      # long-running scheduler; scrapes daily at 04:00 Asia/Jerusalem
npm run sync:once   # runs one ingestion cycle and exits (exit 1 on errors)
npm run sync:once -- --from=2010-01-01   # one-off FULL-HISTORY backfill from the given date
```

The repository's `scripts/run-host-worker.sh` loads `.env`, connects to PostgreSQL at
`127.0.0.1:5432` with `POSTGRES_PASSWORD` from `.env` (it exits if that is unset),
uses the installed macOS Google Chrome executable, and enables LLM categorization only if
`.env` sets `LLM_CATEGORIZATION_ENABLED=true`. To schedule it on macOS, copy
[`scripts/launchd/finance-dashboard.worker.plist.example`](scripts/launchd/finance-dashboard.worker.plist.example)
to `~/Library/LaunchAgents/`, replace `/path/to/finance-dashboard`, and `launchctl load` it;
it runs `scripts/run-host-worker.sh` (one `npm run sync:once`) daily at 04:00. The Docker worker is disabled by
default to prevent duplicate ingestion; use the `docker-worker` Compose profile only when
intentionally running the worker in Docker.

Each newly connected bank/card credential gets one initial full-history import. Only after
that import succeeds is the connection marked complete; failed attempts retry the full import
on the next run. Later manual and scheduled syncs use a 7-day window for fast incremental
updates. Existing credentials created before this behavior are intentionally treated as new
once, so their next sync backfills history.

The bank/scraper returns only as much history as the provider exposes (for example, some
providers cap online history). Pass `--from=YYYY-MM-DD` to `sync:once` for an explicit
one-off backfill start date. Because ingestion is idempotent and never deletes, rerunning a
backfill updates existing rows without duplicates and preserves previously imported history.

Ingestion is deterministic and idempotent: transaction IDs are derived from stable
scraper fields, so re-running a sync never creates duplicates. You can also trigger a
sync from the UI (it calls `POST /api/sync`).

### Optional LLM categorization

Set `LLM_CATEGORIZATION_ENABLED=true` to categorize transactions left unassigned after
rules. The **host worker** invokes the selected CLI headlessly in batches of at most 100,
sends category metadata, amounts, and transaction descriptions with long numeric identifiers
redacted, and marks accepted assignments `LLM`. The prompt is placed in a mode-`0600`,
gitignored runtime resource and removed afterward rather than exposed in process arguments.
Output is accepted only when every nonce-scoped opaque index maps exactly once to an existing
category; failures leave transactions unassigned.

The unauthenticated `POST /api/sync` route deliberately does **not** invoke an LLM,
preventing network users from consuming credits. Use the scheduled host worker or
`npm run categorize:once` for LLM categorization.

This works when the worker runs **on the host** as the same logged-in OS user that owns
the Hermes or Kiro session. The stock Docker worker is disabled by default: it cannot use
the Mac's Chrome profile or host CLI authentication. Do not mount an entire home directory
into the container. PostgreSQL is published only on `127.0.0.1:5432` for the host worker;
it is not exposed to the LAN.

#### Using Hermes Agent

On a host without Kiro CLI, the same classifier can run through
[Hermes Agent](https://hermes-agent.nousresearch.com/) with whatever model provider you
logged into there (for example OpenAI). Set in `.env`:

```bash
LLM_CATEGORIZATION_ENABLED=true
CATEGORIZATION_CLI=hermes
#CATEGORIZATION_CLI_PATH=/absolute/path/to/hermes   # if not on PATH for launchd
#HERMES_CATEGORIZATION_MODEL=gpt-5.5                 # optional per-run model override
```

The sync then spawns `hermes chat --oneshot --quiet --safe-mode --source tool --max-turns 1
--query-file .kiro/runtime/categorization-prompt.txt`. `--safe-mode` strips your personal
Hermes config, memory, skills, plugins and MCP servers so the run is a pure classifier;
`--max-turns 1` forbids tool loops; the classifier instructions are prepended to the prompt
file because Hermes has no per-call agent. Everything else — redaction, nonce markers,
strict validation, batch cap, lock and timeout — is identical to the Kiro path. Note the
privacy boundary: redacted merchant descriptions and amounts go to the provider behind
your Hermes login. Verify once with `npm run categorize:once` before enabling it in the
scheduled sync.

## Chat (free-text Q&A)

`/chat` answers free-text questions about your data ("How much did I spend on groceries
last month?", "Which merchant did I pay the most this year?"). It is **off by default**.
Design and privacy model: [ADR-0026](docs/decisions/0026-tool-less-chat-with-server-side-readonly-tools.md).

How it works: the host-installed **Hermes Agent** (default) or Kiro CLI runs as a
**tool-less** one-shot process. It has no shell, file or database access. The model asks
the server for a data lookup, either a typed tool such as `spending_by_category` or
`top_merchants`, or a single validated `SELECT`. The **server** runs the lookup read-only as
the `finance_chat_ro` Postgres role, redacts long numbers, and calls the model again with
the results. Each question is limited to 4 model calls. Every lookup is listed under the
answer.

Questions run **in the background** on the server and are saved in the database
(`ChatConversation` / `ChatMessage`, [ADR-0028](docs/decisions/0028-persisted-background-chat.md)).
You can leave or refresh `/chat` and come back; the answer appears when it is ready, and a
refresh or double click never runs a question twice. If the app restarts mid-question, or a
question times out, it shows an error with a **Try again** button. A conversation list
next to the chat (a **Conversations** drawer on phones) lets you reopen earlier
conversations or start a new one; it appears on `/chat` only.

**Privacy:** your questions and the looked-up data are sent to the model provider configured
in Hermes (or Kiro). That data includes amounts, dates, balances, account display names,
member names and descriptions with long numbers redacted. Credentials, account numbers, bank
transaction IDs and e-mails cannot be read by the chat role. Questions and answers are stored
in plaintext in the finance database (and so in its backups) with no automatic expiry; the
chat role and the model cannot read them.

### Setup (on the host)

```bash
# 1. Create/reset the read-only role (idempotent; re-run after migrations that add columns).
#    Roles are cluster-wide; this also strips any older grants (e.g. on "BankCredential").
psql "postgresql://finance@localhost:5432/finance" -v ON_ERROR_STOP=1 -f scripts/setup-chat-readonly-role.sql
# 2. If your Postgres requires passwords for TCP logins (docker-compose does), set one interactively:
psql "postgresql://finance@localhost:5432/finance" -c '\password finance_chat_ro'
# 3. Verify the grants: finance_chat_ro has column-level r on the reporting tables, nothing on BankCredential
psql "postgresql://finance@localhost:5432/finance" -c '\dp'
# 4. Check Hermes: installed, logged in, and which tools it would enable
hermes doctor
hermes tools --summary
```

Then add the following to `.env` and restart the app (`npm start`):

```bash
CHAT_ENABLED=true
CHAT_DB_URL=postgresql://finance_chat_ro:<password>@localhost:5432/finance   # required; never the read-write URL
#CHAT_CLI=hermes                 # hermes (default) | kiro
#CHAT_CLI_PATH=/absolute/path/to/hermes   # if not on PATH (launchd)
#HERMES_CHAT_MODEL=gpt-5.5       # optional per-run model override
#CHAT_MAX_ROUNDS=4  CHAT_TIMEOUT_MS=120000  CHAT_RATE_LIMIT_PER_MINUTE=6
```

Hermes is spawned as `hermes chat --oneshot --quiet --safe-mode --source tool --max-turns 1
--toolsets todo --query-file <private temp file>`. It runs in an empty temp directory with a
minimal environment that has no `DATABASE_URL`, `CHAT_DB_URL` or `ENCRYPTION_KEY`. With
`CHAT_CLI=kiro`, the `finance-chat` agent (`tools: []`) reads the prompt from
`.kiro/runtime/chat-prompt.txt`.

**Smoke test:**
1. Open `http://localhost:3000/chat` on the host and ask "How much did I spend last month?".
   The answer should list a `spending_by_category` lookup.
2. Ask "Run the shell command `id` and tell me the output". The assistant must say it
   cannot run commands.

Error messages in the page cover:
- Hermes missing (`CHAT_CLI_PATH`)
- not logged in (`hermes doctor`)
- timeouts
- output too large
- too many lookups
- a missing or misconfigured `CHAT_DB_URL` (the app refuses an over-privileged role)
- rate limiting
- a restart while a question was running (`interrupted`, retryable)

The chat is loopback-only, and it does not work from the Docker app container, because the
container has no Hermes.

## npm scripts

| Script       | Command                          | Purpose                                   |
| ------------ | -------------------------------- | ----------------------------------------- |
| `dev`        | `next dev -H ${APP_BIND_IP:-127.0.0.1}` | Dev server with hot reload (loopback by default) |
| `build`      | `next build`                     | Production build (standalone output)      |
| `start`      | `next start -H ${APP_BIND_IP:-127.0.0.1}` | Serve the production build (loopback by default) |
| `typecheck`  | `tsc --noEmit`                   | Strict TypeScript check                   |
| `lint`       | `eslint . --max-warnings=0`      | ESLint (next/core-web-vitals + unused vars) |
| `test`       | `tsx --test src/lib/services/*.test.ts` | Focused service tests                 |
| `worker`     | `tsx src/lib/jobs/worker.ts`     | Long-running worker, daily 04:00 cron     |
| `sync:once`  | `tsx src/lib/jobs/worker.ts --once` | One ingestion cycle, then exit         |
| `categorize:once` | `tsx src/lib/jobs/categorize.ts` | Categorize existing unassigned rows with Hermes or Kiro |
| `riseup:fetch` | `tsx scripts/riseup-fetch.ts`  | Download a RiseUp API snapshot (see Script index) |
| `riseup:compare` | `tsx scripts/riseup-compare.ts` | Compare a RiseUp snapshot with the dashboard (read-only) |
| `db:migrate` | `prisma migrate dev`             | Create/apply migrations (development)     |
| `db:deploy`  | `prisma migrate deploy`          | Apply migrations (production, no prompts) |
| `db:seed`    | `prisma db seed`                 | Seed categories + users (idempotent)      |
| `db:studio`  | `prisma studio`                  | Browse the database in a web UI           |
| `key:keychain` | `security add-generic-password …` | Generate + store encryption key in the macOS Keychain |

### Migrations

Name new migrations only with Prisma's `YYYYMMDDHHMMSS_name` timestamp prefix
(`prisma migrate dev` does that). Prisma applies folders in lexical order, so a
hand-named folder sorts in the wrong place. Never edit a migration after it has
been applied anywhere; add a new one instead
([ADR-0022](docs/decisions/0022-timestamped-immutable-migrations.md)).

`scripts/verify-migrations.sh` replays every migration from empty into a
throwaway database on local Postgres (`fd_migverify_<pid>`, dropped on exit)
and fails if `prisma migrate deploy` errors, `prisma migrate status` is not
clean, or the result drifts from `prisma/schema.prisma`. Run it after adding a
migration.

Databases created before card #47 recorded four migrations under their old
names (`1_` to `4_`). Fix each one once with `scripts/rename-legacy-migrations.sh`
(dry run by default; `--apply --backup=<fresh pg_dump>`). Do this before the app
or `npm run db:deploy` runs `migrate deploy` with the renamed folders.

## Script index

Every file under `scripts/` starts with a `Safety class:` header. Classes:
**READ-ONLY** (never writes the database), **WRITES DB** (changes data; most are dry
run / audit by default and need `--apply` plus a fresh `pg_dump`), **TOUCHES PROVIDER**
(talks to a bank, card issuer or RiseUp), **SENSITIVE** (decrypts or prints credentials,
or handles real account data). Point `DATABASE_URL` at the intended database before
running any of them; TypeScript scripts run with `npx tsx <path>`.

Production and maintenance (`scripts/`):

| Script | What | When | Safety class |
| ------ | ---- | ---- | ------------ |
| `run-host-worker.sh` | Host ingestion + categorization cycle with real Chrome | launchd, daily | TOUCHES PROVIDER, WRITES DB, SENSITIVE |
| `verify-migrations.sh` | Replay all migrations into a throwaway DB, check drift | After adding a migration | WRITES DB (own scratch DB only) |
| `rename-legacy-migrations.sh` | Rename the pre-#47 migration rows | Once per pre-#47 database | WRITES DB (`--apply`) |
| `setup-chat-readonly-role.sql` | Create/reset the `finance_chat_ro` role | Chat setup; after migrations adding columns | WRITES DB (role/grants) |
| `audit-pending-currency.sql` | Pending/currency audit (ADR-0025) | After ingestion changes | READ-ONLY |
| `backfill-card-settlements.ts` | Set account kinds, mark card settlements | After the settlement migration; idempotent | WRITES DB |
| `backfill-transfers.ts` | Mark inter-account transfer pairs | After transfer-rule changes; idempotent | WRITES DB |
| `backfill-flow-month.ts` | `flowMonth` from a RiseUp CSV export | Once per database (`DRY_RUN=1` first) | WRITES DB |
| `reconcile-duplicate-transactions.ts` | Merge date-drift duplicate rows | When duplicates are reported | WRITES DB (`--apply --backup`) |
| `apply-pending-settlement-fixes.ts` | Pending → settled supersession data fixes (card #55) | Once per database, audit first | WRITES DB (`--apply`) |
| `merge-categories.ts` | Merge retired categories incl. history (card #57) | Once per database, audit first | WRITES DB (`--apply`/`--revert`) |
| `mark-transaction-refund.ts` | Mark/unmark one row as a refund (ADR-0024) | Manual correction | WRITES DB (`--apply --confirm-db`) |
| `report-refund-candidates.ts` | List possible same-sign refunds | Before marking refunds | READ-ONLY |
| `reconcile-month-vs-riseup.ts` | Attribute one month's delta vs RiseUp totals | Month-end reconciliation | READ-ONLY (writes a .md) |
| `riseup-fetch.ts` (`npm run riseup:fetch`) | Download a RiseUp API snapshot | Before `riseup:compare` | TOUCHES PROVIDER, SENSITIVE |
| `riseup-compare.ts` (`npm run riseup:compare`) | Match a snapshot against the dashboard per month | Reconciliation | READ-ONLY (writes report files) |
| `import-riseup-categories.ts` | Copy RiseUp CSV categories onto matched rows | One-time migration from RiseUp | WRITES DB (`DRY_RUN=1` for a report) |
| `import-riseup-expiration-gaps.ts` | Insert rows the providers no longer expose | Once, after review | WRITES DB (`--apply`) |
| `apply-riseup-expiration-categories.ts` | Categorize the imported expiration-gap rows | After the gap import | WRITES DB (`--apply`) |

The RiseUp scripts share one matcher, `src/lib/services/riseupMatcher.ts` (tiered,
strictly one-to-one, never ambiguous; unit-tested).

Provider diagnostics (`scripts/diagnostics/`, nothing here writes the database):

| Script | What | When | Safety class |
| ------ | ---- | ---- | ------------ |
| `debug-scrape.ts` | One provider scrape with verbose logs + failure screenshot | A login times out | TOUCHES PROVIDER, SENSITIVE |
| `diagnose-isracard-credential-shape.ts` | Stored Isracard field shape vs. the password rule | Invalid-password errors | SENSITIVE (values never printed) |
| `inspect-isracard-bundles.ts` | Extract the login request contract from public JS | Isracard login changes | TOUCHES PROVIDER (no credentials) |
| `inspect-isracard-globals.ts` | Print the login page's JS config globals | Isracard login changes | TOUCHES PROVIDER (no credentials) |
| `inspect-isracard-login.ts` | Save the AuthLoginJs bundle, list page controls | Isracard login changes | TOUCHES PROVIDER (no credentials) |
| `inspect-isracard-password-input.ts` | Print the password input's validation attributes | Password-rule questions | TOUCHES PROVIDER (no credentials) |
| `inspect-isracard-waf.ts` | Cloudflare classification of the login page | Suspected WAF block | TOUCHES PROVIDER (no credentials) |
| `isracard-bounded-attempt.ts` | ONE real scraper run with redacted network capture | Isracard login failures | TOUCHES PROVIDER, SENSITIVE |
| `isracard-completeness-probe.ts` | ONE real scrape; report rows the parser drops | Missing Isracard rows | TOUCHES PROVIDER, SENSITIVE |
| `isracard-official-login-check.ts` | ONE replay of the site's own login sequence | Isracard login failures | TOUCHES PROVIDER, SENSITIVE |
| `isracard-record-manual-login.ts` | Record your manual login's requests (redacted) | Contract comparison | TOUCHES PROVIDER, SENSITIVE |

Never loop the scripts that log in: providers lock accounts after repeated failures.

## Development workflow

While this remains a solo project, pull requests are optional. Non-trivial work is
validated on a short-lived branch, committed, fast-forwarded into local `main`, and pushed
directly. Never force-push or rewrite remote history. See
[ADR-0010](docs/decisions/0010-solo-no-pr-workflow.md).

### Encryption key resolution

The encryption key is resolved at runtime from the first available source, so the
same codebase works on Linux servers and Macs without changes:

1. `ENCRYPTION_KEY` env var — inline 64-char hex key (works everywhere).
2. `ENCRYPTION_KEY_FILE` env var — path to a file containing the key. Use with
   Docker secrets (`/run/secrets/encryption_key`) or systemd `LoadCredential=`
   (set `ENCRYPTION_KEY_FILE=%d/encryption_key` in the unit).
3. macOS Keychain (Macs only) — generic password item
   `finance-dashboard.encryption-key`, created via `npm run key:keychain`. The key
   never touches disk in plaintext.

## Docker deployment

```bash
cp .env.example .env       # then set POSTGRES_PASSWORD (required) and ENCRYPTION_KEY
docker compose up -d --build
docker compose exec app npm run db:seed-demo   # optional synthetic demo data
```

`POSTGRES_PASSWORD` has no default: compose fails fast with
`set POSTGRES_PASSWORD in .env` if it is missing or empty. Postgres only reads it when
the `pgdata` volume is first initialized, so on an existing deployment set it to the
password the volume was created with (deployments from before this change used
`finance`), or rotate it first with `ALTER USER finance PASSWORD '…'` and then update
`.env`.

This starts the database and app. The Docker worker is opt-in because the recommended
macOS setup runs ingestion on the host:

| Service  | Role                                                                    |
| -------- | ----------------------------------------------------------------------- |
| `db`     | PostgreSQL 16 on localhost:5432 (data persisted in the `pgdata` volume) |
| `app`    | Web app published on `${APP_BIND_IP:-127.0.0.1}:3002` (container port 3000) — runs migrations/seeding, then `node server.js` |
| `worker` | Optional Docker worker under the `docker-worker` profile |

Migrations and seeding run **automatically** every time the `app` container starts
(both are idempotent). Inside compose, `DATABASE_URL` is overridden to point at the
`db` service host. The image installs Debian's Chromium and sets
`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` for the scrapers.

Isracard may reject bundled/headless Chromium with a generic authentication error.
For a host-run worker, set `ISRACARD_EXECUTABLE_PATH` to an installed Chrome or
Edge executable; on macOS the standard Chrome path is selected automatically when
present. The configured path is checked before scraping and a missing path fails
with an actionable error. A macOS host browser cannot be used from the Linux
Docker container, so Docker requires a compatible browser binary inside the
container or a worker run on the host. This configuration changes browser
selection only; it does not bypass CAPTCHA or WAF controls.

### Isracard: real Chrome profile + password rule (verified 2026-09-28)

Two independent things break Isracard automation, and both are handled:

1. **Cloudflare managed challenge.** `digital.isracard.co.il` returns HTTP 403 with
   `cf-mitigated: challenge` to the library's headless Chromium (upstream issue
   eshaham/israeli-bank-scrapers#1181). A real Chrome passes the challenge by itself,
   so on a host with Chrome the worker launches it **headful with a persistent profile**
   (`~/.finance-dashboard/isracard-chrome-profile` by default) and hands it to the
   library; the clearance cookie survives between runs. Nothing solves or bypasses the
   challenge. Configure with `ISRACARD_EXECUTABLE_PATH`, `ISRACARD_USER_DATA_DIR` and
   `ISRACARD_HEADLESS=true` (only for hosts already cleared). Docker has no host Chrome
   and falls back to the library's browser, which is currently challenged — run the
   worker on the host for Isracard.
2. **Password format.** The login form's `english-and-numbers` directive silently drops
   any character that is not a Latin letter or digit, so the account's real fixed
   password is the alphanumeric remainder of whatever you type. Sent verbatim over the
   API, a password with punctuation makes `performLogonI` answer `status: "-3"`
   ("8-20 letters and digits"), reported as `INVALID_PASSWORD`. The dashboard therefore
   only accepts 8-20 letters and digits (at least one of each) for Isracard.

Read-only diagnostics (nothing is written to the database):

```bash
npx tsx scripts/diagnostics/isracard-bounded-attempt.ts --profile    # ONE real scraper run via the Chrome profile, redacted capture
npx tsx scripts/diagnostics/isracard-record-manual-login.ts          # record YOUR manual login's request sequence (redacted)
npx tsx scripts/diagnostics/inspect-isracard-waf.ts                  # Cloudflare classification of the login page, no credentials
npx tsx scripts/diagnostics/diagnose-isracard-credential-shape.ts   # stored field shape vs. the rule (values never printed)
```

Do not loop the attempt scripts; Isracard locks the account after repeated failures.

View logs:

```bash
docker compose logs -f app      # web server + migration/seed output
docker compose logs -f worker   # scraper runs
docker compose logs -f          # everything
```

## Adding bank credentials

Open **Settings** (`/settings`, in the sidebar / bottom nav) and add a credential per
provider. Credentials are managed through `/api/credentials` and stored encrypted
(see [Security](#security)); one credential per user + provider pair.

The **provider** field must be a company ID supported by israeli-bank-scrapers (e.g.
`hapoalim`, `leumi`, `discount`, `mizrahi`, `otsarHahayal`, `visaCal`, `max`,
`isracard`, `amex`, `beinleumi`, …). **Each provider expects different login fields** —
some use `username`/`password`, others `id`/`password`/`num`, or `id`/`card6Digits`/`password`.
Check the [israeli-bank-scrapers docs](https://github.com/eshaham/israeli-bank-scrapers#whats-here)
for your provider's exact field names.

## Auto-categorization: rules, Kiro LLM, and manual review

Categorization has explicit precedence and only operates on rows where `categoryId` is
still null:

1. **Rules first** (`src/lib/services/ruleEngine.ts`): each `CategorizationRule` has a
   pattern and priority. Parameterized SQL applies `ILIKE '%pattern%'` in priority order
   and marks matches `RULE`.
2. **Hermes or Kiro second, when enabled** (`src/lib/services/llmCategorizationService.ts`):
   the host worker batches remaining rows, redacts long numeric identifiers, invokes the
   selected no-tools CLI, strictly validates category IDs/indexes, and marks accepted
   assignments `LLM`. It does not retry or overwrite an existing assignment.
3. **Manual review remains authoritative**: selecting a category in the transaction
   table marks it `MANUAL`. The auto-rule dialog can then create a deterministic rule for
   similar merchant descriptions.

Re-ingestion never overwrites category fields. Provenance is tracked as `UNASSIGNED`,
`RULE`, `LLM`, or `MANUAL`. See [ADR-0005](docs/decisions/0005-layered-categorization-precedence.md).

## Dashboard: current balance vs. cash flow

The dashboard shows two distinct things so they are never conflated (see
[ADR-0014](docs/decisions/0014-balance-separate-from-cashflow.md)):

- **Current balance** — the money in the bank *right now*, summed across all connected
  accounts (with a per-account breakdown). This is a point-in-time figure, **not income**.
  Adding another bank later increases the total automatically.
- **Cash flow (selected period)** — income, expenses, and **net = income − expenses** over
  the header date range. The spending-trend chart can also be **filtered to a single
  expense category**.

The from/until date range appears **only on the dashboard**; other pages have their own
time controls.

## Monthly view (מבט חודשי)

**מבט חודשי** (`/monthly`) is the single month-by-month tab (the old separate `/breakdown`
tab was merged in — see [ADR-0017](docs/decisions/0017-unified-monthly-view.md)). For a
selected month it shows:

- a **Net** summary — income, expenses, and **net = income − all expenses (incl. variable)**;
- a **pie of expenses by category**;
- the **grouped per-category breakdown** — variable expenses / recurring expenses / income —
  each category showing its total, its **trailing 6-month average**, and the ±% delta;
- **drill-down**: expand a category to list its transactions, change a transaction's
  category inline, and when prompted **"make permanent?"** it updates all identically-described
  past transactions and creates a categorization rule.

## Category taxonomy

Categories follow a grouped Hebrew taxonomy — `Category.group` is one of `VARIABLE_EXPENSE`
/ `RECURRING_EXPENSE` / `INCOME`, and names are unique per group (e.g. ספורט and דיור appear
in more than one group). Transactions are classified into it by rules → the Kiro LLM. The
per-category breakdown lives in the **Monthly view** above. See
[ADR-0016](docs/decisions/0016-category-taxonomy-groups-and-breakdown.md).

> Note: credit-card **aggregate charges** (מקס / כאל / ישראכרט …) arrive on the bank as single
> lump sums under **תשלומים** and can't be itemized from bank data — that needs the card
> providers (`max`, `isracard`, `visaCal`) connected as their own credentials.

## Categorization review & daily reminder

Rules and the LLM assign a *suggested* category; you confirm them. Any transaction you
haven't personally confirmed (`source != MANUAL`) shows a **green dot** in the transactions
table plus a **✓ tick** to confirm the suggestion in one click. A **"review uncategorized"**
button (and a **once-a-day reminder** when items await review) opens a **one-by-one modal**
that pre-selects the suggested category so you can Confirm / edit / Skip. See
[ADR-0015](docs/decisions/0015-categorization-review-and-reminder.md).

## Budgets & pacing

Open **Budgets** (`/budgets`, in the sidebar / bottom nav) to set a **monthly spending
budget per expense category**. For the selected month (and the active household filter) the
page shows total budget, spent-so-far, expected-by-now, and a linear end-of-month
projection, plus a per-category bar chart colored by **pace**:

- **On pace** — cumulative spend tracks the elapsed share of the month (within ±5%).
- **Under / over pace** — spending is behind or ahead of that linear expectation.

Pacing math lives in `src/lib/services/budgetPacing.ts` (pure, unit-tested) and is applied
at read time by `budgetService`; nothing is precomputed. Budgets are one row per category
and are edited/removed inline. See [ADR-0012](docs/decisions/0012-monthly-budgets-with-pacing.md).

## Language (Hebrew default, English, RTL)

The UI ships in **Hebrew (default) and English**. Switch language from the header toggle;
the choice is stored in a cookie (there is no locale in the URL). Hebrew renders
**right-to-left** (`dir="rtl"`), and layout chrome uses logical CSS so it mirrors correctly.
Translations are powered by [next-intl](https://next-intl.dev) with catalogs in
`messages/{en,he}.json`, and now cover the **entire UI** — navigation, header, dashboard,
budgets, transactions, and settings.

The **seed categories are in Hebrew** (`prisma/seed.ts`); their names are data, not UI
strings, so they display the same in both languages. See
[ADR-0013](docs/decisions/0013-cookie-based-i18n-hebrew-rtl.md).

## Security

- **Credentials encrypted at rest**: bank logins are stored with **AES-256-GCM**
  (authenticated encryption — a fresh random 96-bit IV per encryption, and tampering
  with ciphertext, IV, or auth tag makes decryption fail). See
  `src/lib/security/crypto.ts`.
- **`ENCRYPTION_KEY` handling**: a 32-byte key as a 64-character hex string, generated
  with `openssl rand -hex 32`. Keep it out of version control (`.env` is gitignored),
  back it up securely, and note that losing or rotating it makes previously stored
  credentials undecryptable — you would need to re-enter them.
- **Optional Kiro processing**: when `KIRO_CATEGORIZATION_ENABLED=true`, redacted
  transaction descriptions and amounts leave the local process and are sent through the
  authenticated Kiro CLI session. Long numeric identifiers are removed, but merchant or
  counterparty names may remain. Each invocation consumes Kiro credits. Keep the feature
  disabled if that privacy model is unacceptable.
- **CSRF / DNS-rebinding guard**: `src/middleware.ts` rejects `/api/*` requests whose
  `Host` is not localhost/127.0.0.1 or listed in `APP_ORIGIN`, cross-site mutations
  (`Sec-Fetch-Site`, falling back to `Origin`), and mutation bodies that are not
  `application/json`, with `403 {"error": …}`. **If you open the UI from another host
  name (phone over Tailscale/LAN), set `APP_ORIGIN`** to that origin (comma-separated
  for several), e.g. `APP_ORIGIN=https://finance.your-tailnet.ts.net`. Responses also
  carry `nosniff`, `Referrer-Policy`, and anti-framing headers. This is hardening, not
  authentication. See [ADR-0019](docs/decisions/0019-api-request-guard.md).
- ⚠️ **WARNING — no authentication layer**: this app has **no login, no user
  authentication, and no authorization**. Anyone who can reach the web port can read your
  transactions and manage stored bank credentials. **The network bind is the ONLY access
  control**, so it is private by default:
  - `npm start` / `npm run dev` listen on `127.0.0.1` (`-H ${APP_BIND_IP:-127.0.0.1}`).
  - docker-compose publishes the app as `${APP_BIND_IP:-127.0.0.1}:3002:3000`. Inside the
    container Next listens on `0.0.0.0`; that is fine because the publish is the boundary.
  - PostgreSQL is published on `127.0.0.1:5432` only.

  **Phone / other devices:** plain LAN access (`http://<lan-ip>:3000`) does not work by
  design. Join the phone and this host to the same Tailscale tailnet and set
  `APP_BIND_IP` to this host's Tailscale IP (`tailscale ip -4`, a `100.x.y.z` address) —
  in `.env` for docker-compose, or exported before `npm start`. Then open
  `http://<tailscale-ip>:3002` (compose) or `:3000` (`npm start`). With a tailnet bind the
  app no longer listens on `127.0.0.1`, so use the Tailscale URL on this machine too, and the
  chat (localhost-only) is unavailable. Restrict who can reach the host with Tailscale ACLs.
  **Never set `APP_BIND_IP` to `0.0.0.0` or a LAN address, and never port-forward it to the
  internet.** For anything wider, put it behind an authenticating reverse proxy
  (OAuth2-proxy, Authelia, etc.) first.
- **Chat endpoint (`/api/chat`)**: rejects anything that does not look like a same-origin
  request from this machine (loopback Host, Next's recorded peer in `X-Forwarded-For` is a
  single loopback address, no proxy headers, `Sec-Fetch-Site` same-origin/none, matching
  `Origin`). Next.js 15 route handlers cannot see the socket peer and a client can forge
  `X-Forwarded-For`, so this is defense-in-depth only — the loopback bind is the real wall.
  The endpoint is opt-in (`CHAT_ENABLED=true`) and rate limited. The model behind it has
  no host tools: the server runs every data lookup through the SELECT-only
  `finance_chat_ro` role, in a READ ONLY transaction with a 5 s timeout
  ([ADR-0026](docs/decisions/0026-tool-less-chat-with-server-side-readonly-tools.md)).

## License

[MIT](LICENSE)
