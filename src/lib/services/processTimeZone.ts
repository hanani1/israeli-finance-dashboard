/**
 * Process time zone for ingestion (card #46, ADR-0020).
 *
 * israeli-bank-scrapers parses provider dates with the PROCESS-LOCAL time
 * zone — `moment('20260901', 'YYYYMMDD')` (Discount, Beinleumi group),
 * `moment('01/09/2026', 'DD/MM/YYYY')` (Isracard/Amex), and
 * `moment('2026-09-01T00:00:00')` / `new Date('2026-09-01T00:00:00')`
 * (Max, Cal) — and returns `.toISOString()`. Under TZ=Asia/Jerusalem that
 * day is 2026-08-31T21:00:00Z; under TZ=UTC it is 2026-09-01T00:00:00Z. The
 * instant feeds the deterministic transaction id, so the same bank row got a
 * different id on the Mac host (Israel) and in Docker (UTC).
 *
 * Every stored scraped row is Israel-local midnight, so the process time zone
 * is pinned to Asia/Jerusalem in every runtime (host script, Dockerfile,
 * compose, and here as a last line of defence), not to UTC.
 */
import { ISRAEL_TIME_ZONE } from './localDay';

export const INGESTION_TIME_ZONE = ISRAEL_TIME_ZONE;

/** Daily scheduled ingestion: 04:00 Israel time, whatever the host clock zone. */
export const DAILY_INGESTION_CRON = '0 4 * * *';
export const DAILY_INGESTION_CRON_OPTIONS = { timezone: INGESTION_TIME_ZONE } as const;

/**
 * Force `process.env.TZ` to Asia/Jerusalem. Node re-reads the zone when
 * `process.env.TZ` is assigned, so this takes effect for every later
 * Date/moment parse in the process. Returns true when it had to change it.
 */
export function pinProcessTimeZone(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): boolean {
  if (env.TZ === INGESTION_TIME_ZONE) return false;
  warn(
    `[timezone] TZ=${env.TZ ?? '(unset)'}; pinning to ${INGESTION_TIME_ZONE} so scraped provider dates parse as Israel-local days.`,
  );
  env.TZ = INGESTION_TIME_ZONE;
  return true;
}
