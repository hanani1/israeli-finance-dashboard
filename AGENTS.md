# AGENTS.md — set up and verify Finance Dashboard from a fresh clone

Instructions for a coding agent (or a human) to stand up a working copy end to end.
Follow the steps in order; each has a check that must pass before moving on.
Background and options are in [README.md](README.md); the "why" behind design
choices is in [docs/decisions/](docs/decisions/README.md).

## Ground rules

- **Never expose the app beyond this machine.** There is no login layer; the loopback
  bind *is* the access control ([ADR-0018](docs/decisions/0018-loopback-bind-is-the-access-wall.md)).
  Keep `APP_BIND_IP` unset (127.0.0.1). Never bind `0.0.0.0` or a LAN address.
  Remote access is only via a private tailnet (README → Security).
- **Never commit** `.env`, encryption keys, bank credentials, DB dumps (`*.sql` outside
  `prisma/migrations/`), scrape logs, screenshots or reports. `.gitignore` covers these;
  do not weaken it.
- **Real bank logins are the user's job.** Do not ask for, store, print or log bank
  passwords. Use the demo data to verify the app; the user adds credentials in the UI.
- Do not loop provider logins: banks lock accounts and WAFs block IPs. One bounded
  `npm run sync:once` attempt at a time.

## Path A — Docker (recommended, any OS)

Requires Docker with Compose v2.

```bash
cp .env.example .env
# Set both values in .env (generate, don't invent):
#   POSTGRES_PASSWORD=$(openssl rand -hex 24)
#   ENCRYPTION_KEY=$(openssl rand -hex 32)
# DATABASE_URL in .env is only used by host-run commands; compose overrides it.
docker compose up -d --build
docker compose exec app npm run db:seed-demo      # optional synthetic data
```

Checks:

```bash
docker compose ps                                 # db healthy, app running
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/          # 200
curl -s http://127.0.0.1:3002/api/accounts        # JSON; "Demo bank" if demo seeded
lsof -nP -iTCP:3002 -sTCP:LISTEN                  # must show 127.0.0.1 only (macOS/Linux)
```

Open http://127.0.0.1:3002. Migrations and the base seed run on every app start.

## Path B — host Node.js (development)

Requires Node.js 20+ and PostgreSQL 16 listening on 127.0.0.1 (or only the db
container: `docker compose up -d db`).

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD and the same password in DATABASE_URL.
# Encryption key: macOS -> `npm run key:keychain` (leave ENCRYPTION_KEY empty);
#                 other -> ENCRYPTION_KEY=$(openssl rand -hex 32) in .env
npm ci
npm run db:deploy        # apply migrations
npm run db:seed          # categories + two placeholder household users
npm run db:seed-demo     # optional synthetic data (refuses if real data exists)
npm run dev              # http://127.0.0.1:3000
```

## Verify the code

All four must pass before you call a change done:

```bash
npm test          # node:test suite, no DB or network needed
npm run typecheck
npm run lint      # zero warnings allowed
npm run build
```

## Connecting real banks (user step)

1. In the UI open **Settings → Bank connections** and add a provider
   (supported providers come from
   [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers)).
   Credentials are encrypted with AES-256-GCM before they reach the database.
2. Remove demo data first: `npm run db:seed-demo -- --reset`.
3. Run one sync: `npm run sync:once` on the host, or the Sync button in the UI.
   The first sync per credential imports full history; later runs use a 7-day window.
4. Schedule it: macOS → `scripts/launchd/finance-dashboard.worker.plist.example`;
   Linux → cron/systemd timer running `scripts/run-host-worker.sh` (needs `zsh`, or
   run `npm run sync:once` with the same environment); Docker →
   `docker compose --profile docker-worker up -d worker`.

## Optional features (off by default)

- **LLM categorization** (`LLM_CATEGORIZATION_ENABLED=true`): needs a host CLI —
  Hermes Agent or Kiro CLI — logged in as the worker's OS user. Sends redacted
  descriptions/amounts to that provider. See README → "Optional LLM categorization".
- **Chat Q&A** (`CHAT_ENABLED=true`): host-only; needs the read-only DB role from
  `scripts/setup-chat-readonly-role.sql`. See README → "Chat".

## Repo map

- `src/app` — Next.js App Router pages and `/api/*` route handlers
- `src/lib/services` — domain logic (ingestion, categorization, analytics); unit tests sit next to it as `*.test.ts`
- `src/lib/jobs` — sync worker and categorization jobs
- `prisma/` — schema, timestamped immutable migrations, `seed.ts`, `seed-demo.ts`
- `scripts/` — operational scripts; each header states its safety class (README → Script index)
- `docs/` — requirements, design, decision records

Locale defaults to Hebrew (RTL); English is available from the language switcher.
Ingestion time zone is Asia/Jerusalem by design (ADR-0020).
