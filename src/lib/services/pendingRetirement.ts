/**
 * Retire pending rows the provider stopped returning (pure, unit-tested;
 * card #49, ADR-0025).
 *
 * pendingSettlement.ts hides a pending row once its settled twin arrives, but
 * only when the two match (same amount, close date). A pending row whose
 * purchase was cancelled, or whose settled row carries a different amount (a
 * restaurant tip, a foreign purchase converted to shekels), has no twin and
 * used to stay visible forever as a phantom expense.
 *
 * Rule, applied per scraped account after a SUCCESSFUL scrape and after the
 * settlement matcher has run: a row is retired when
 *   - the provider marked it pending (persisted `providerStatus`, or a legacy
 *     Cal row without an identifier — visa-cal.js only sets identifiers on
 *     completed rows),
 *   - it is not already hidden,
 *   - it is older than the provider's pending horizon (Israeli calendar days), and
 *   - the scrape that just completed did not return it.
 *
 * Retiring hides the row with the existing `isCardSettlement` flag (excluded
 * by every list, total, budget and breakdown) and stamps `pendingRetiredAt`
 * so the decision is auditable and reversible; rows are never deleted. If a
 * later scrape returns a retired row again, it is restored, which makes a
 * provider glitch self-healing.
 */
import { localCalendarDay } from './localDay';

export const PENDING_STATUS = 'pending';

/**
 * Days a card authorization may legitimately stay pending. Cal/Max/Isracard
 * normally settle within a few business days; two weeks leaves room for
 * holidays and late merchant capture before a missing row is treated as gone.
 */
export const DEFAULT_PENDING_HORIZON_DAYS = 14;

const PENDING_HORIZON_DAYS: Readonly<Record<string, number>> = {};

export function pendingHorizonDays(provider: string): number {
  return PENDING_HORIZON_DAYS[provider] ?? DEFAULT_PENDING_HORIZON_DAYS;
}

export interface PendingRetirementRow {
  id: string;
  date: Date;
  providerStatus: string | null;
  txnIdentifier: string | null;
  isCardSettlement: boolean;
  pendingRetiredAt: Date | null;
}

/** The provider reported this row as pending (not yet a settled charge). */
export function isProviderPending(
  row: Pick<PendingRetirementRow, 'providerStatus' | 'txnIdentifier'>,
  provider: string,
): boolean {
  if (row.providerStatus !== null) return row.providerStatus === PENDING_STATUS;
  // Rows ingested before the status was persisted: only Cal has a reliable
  // structural signal (no identifier ⇔ pending). Never guess for others.
  return provider === 'visaCal' && row.txnIdentifier === null;
}

function dayNumber(date: Date): number {
  return Date.parse(`${localCalendarDay(date)}T00:00:00Z`) / 86_400_000;
}

/** Ids of the account's pending rows to retire after a successful scrape. */
export function selectPendingToRetire(
  rows: readonly PendingRetirementRow[],
  seenIds: ReadonlySet<string>,
  provider: string,
  now: Date,
): string[] {
  const horizon = pendingHorizonDays(provider);
  const today = dayNumber(now);
  return rows
    .filter(
      (row) =>
        !row.isCardSettlement &&
        isProviderPending(row, provider) &&
        !seenIds.has(row.id) &&
        today - dayNumber(row.date) > horizon,
    )
    .map((row) => row.id);
}

/** Ids of rows this rule retired that the provider has returned again. */
export function selectRetiredToRestore(
  rows: readonly PendingRetirementRow[],
  seenIds: ReadonlySet<string>,
): string[] {
  return rows.filter((row) => row.pendingRetiredAt !== null && seenIds.has(row.id)).map((row) => row.id);
}
