# ADR-0020: Pin the ingestion process time zone to Asia/Jerusalem in every runtime

- **Date:** 2026-11-02
- **Status:** Accepted
- **Area:** Data correctness / ingestion
- **Owners:** Finance Dashboard maintainers
- **Card:** Trello #46 (12.5)

## Context

The host worker (`scripts/run-host-worker.sh`, launchd) exported `TZ=Asia/Jerusalem`;
the Docker image set no TZ (UTC) unless `.env` happened to; `node-cron` used the
process zone for "04:00". The deterministic transaction id hashes
`date.toISOString()` (ADR-0004).

`toISOString()` is zone-independent for a given instant, so the question is whether the
scrapers produce the same instant under different zones. They do not.
israeli-bank-scrapers 6.12.1 parses provider *days* in the process-local zone:

| Provider | Code | Input |
|---|---|---|
| Discount, Beinleumi group | `moment(OperationDate, 'YYYYMMDD')` | `20260901` |
| Isracard / Amex | `moment(dateStr, 'DD/MM/YYYY')` | `01/09/2026` |
| Max | `moment(purchaseDate)` | `2026-09-01T00:00:00` (no offset) |
| Cal | `moment(trnPurchaseDate)`, `new Date(debCrdDate)` | no offset |

Under `TZ=Asia/Jerusalem` 2026-09-01 becomes `2026-08-31T21:00:00Z`; under `TZ=UTC`
it becomes `2026-09-01T00:00:00Z`. Same bank row, different id. Every scraped row
already in the database was ingested on the host, so it is stored at Israel-local midnight.

The card's first proposal was to pin `TZ=UTC`. That would make the runtimes agree, but
every newly scraped row would then be stored at 00:00Z while existing rows sit at
Israel midnight. Ids would change scheme and dates would be stored two ways. The web
server's few local-time helpers (`src/lib/utils.ts`, `transactions/page.tsx`) also assume
Israel local time.

Month bucketing is already settled: `localDay.ts` / `calendarFlowMonth` (765b850)
attribute rows to Israeli calendar days/months whatever the process zone, and
`flowMonth.test.ts` covers Feb 1 00:00 Israel = February. The stored `flowMonth`
column comes only from the RiseUp export, never from a computed calendar month, so no
stored row changes bucket.

## Decision

- **The ingestion zone is `Asia/Jerusalem`, everywhere.** Set it in the runtime image
  (`Dockerfile`: `ENV TZ=Asia/Jerusalem` plus the `tzdata` package so Chromium and
  system tools agree), in `docker-compose.yml` for `app` and `worker` (overrides
  `.env`), and keep the export in `scripts/run-host-worker.sh`.
- **In-process backstop:** `pinProcessTimeZone()` (`src/lib/services/processTimeZone.ts`)
  runs when `src/lib/jobs/ingestion.ts` loads and again in `worker.ts` after `.env`. It
  forces `process.env.TZ` to Asia/Jerusalem and warns if it had to change it. This
  covers every entry point that scrapes: worker, `sync:once`, `/api/sync`, credential save.
- **Cron:** `cron.schedule('0 4 * * *', …, { timezone: 'Asia/Jerusalem' })`, so 04:00
  means Israel time whatever the host clock zone.
- **Read-side code** keeps using `localDay.ts` helpers and never depends on the process zone.

## Consequences

- The same scraped row gets the same id and flow month on the Mac host and in Docker.
  `timeZoneIndependence.test.ts` spawns probes under UTC, Asia/Jerusalem,
  America/New_York and an unset TZ. It also keeps a control showing the unpinned library
  parse really does differ, so a future library change that removes the dependency will
  show up.
- Any rows a UTC Docker worker may have ingested earlier (00:00Z dates) still land on the
  right Israeli day through `localDay.ts`. On re-scrape the ±3-day identity window
  (`transactionIdentity.ts`) matches them, keeps their id, and moves `date` to Israel
  midnight. No new duplicates.
- Pinning to UTC was rejected (see Context). If the scrapers ever start emitting
  offset-qualified instants, the pin becomes harmless rather than wrong.
- Setting `process.env.TZ` changes the zone for the whole Node process. In the Next server
  that is the intended zone anyway (the image sets it). In `next dev` on a non-Israel
  machine, the first sync would switch the dev server's zone, and a warning is logged.
