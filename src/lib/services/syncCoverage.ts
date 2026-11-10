/**
 * Incremental sync coverage (pure, unit-tested).
 *
 * The scrapers drop every row dated before the requested start date, so a
 * window measured from "now" silently loses purchases whenever a provider
 * fails for longer than the lookback: Isracard was blocked (HTTP 403) from
 * 2026-09-29 to 2026-10-07, and the first successful run on 2026-10-08 asked
 * only for 2026-10-01 onwards, so every 2026-09-30/10-01 purchase was
 * filtered out while the run reported errors=0.
 * The window is therefore anchored on the credential's last successful sync,
 * with an overlap for rows the provider posts days after the purchase.
 */
import { localCalendarDay, localDayStart } from './localDay';

export const INCREMENTAL_OVERLAP_DAYS = 7;
/** A credential without a successful sync for longer than this is reported. */
export const STALE_SYNC_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

function shiftDay(label: string, days: number): string {
  const [year, month, day] = label.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Start of the incremental scrape window: Israel-local midnight `overlapDays`
 * before the earlier of now and the last successful sync. Provider dates are
 * local-midnight instants, so the start is aligned to a local day boundary to
 * keep the oldest overlapping day inside the window.
 */
export function incrementalScrapeStart(
  now: Date,
  lastSuccessfulSyncAt: Date | null,
  overlapDays: number = INCREMENTAL_OVERLAP_DAYS,
): Date {
  const anchor = lastSuccessfulSyncAt && lastSuccessfulSyncAt < now ? lastSuccessfulSyncAt : now;
  return localDayStart(shiftDay(localCalendarDay(anchor), -overlapDays));
}

/**
 * Days of provider history a scrape starting at `startDate` cannot see:
 * the gap between the last successful sync and the window start. Zero means
 * every row dated since the last success is requested again.
 */
export function uncoveredDays(startDate: Date, lastSuccessfulSyncAt: Date | null): number {
  if (!lastSuccessfulSyncAt || startDate <= lastSuccessfulSyncAt) return 0;
  return Math.ceil((startDate.getTime() - lastSuccessfulSyncAt.getTime()) / DAY_MS);
}

export type ScrapeFailureKind = 'provider-blocked' | 'timeout' | 'login' | 'other';

/**
 * Separate provider/Cloudflare access failures (403/520, challenge HTML where
 * JSON was expected) from timeouts and credential problems, so a blocked
 * provider is not mistaken for a bad password or an empty month.
 */
export function classifyScrapeFailure(message: string): ScrapeFailureKind {
  if (/status code:\s*(403|429|52\d)\b|Attention Required|cloudflare|Unexpected token '?<'?|is not valid JSON/i.test(message)) {
    return 'provider-blocked';
  }
  if (/timed? ?out|timeout/i.test(message)) return 'timeout';
  if (/INVALID_PASSWORD|CHANGE_PASSWORD|ACCOUNT_BLOCKED|unknown error during login/i.test(message)) return 'login';
  return 'other';
}

/** Warning for a credential whose last success is older than `staleDays`, else null. */
export function staleSyncWarning(
  provider: string,
  lastSuccessfulSyncAt: Date | null,
  now: Date,
  staleDays: number = STALE_SYNC_DAYS,
): string | null {
  if (!lastSuccessfulSyncAt) return null;
  const ageDays = (now.getTime() - lastSuccessfulSyncAt.getTime()) / DAY_MS;
  if (ageDays <= staleDays) return null;
  return `[coverage] ${provider}: no successful sync since ${lastSuccessfulSyncAt.toISOString()} (${Math.floor(ageDays)} days); its transactions are incomplete until it recovers.`;
}
