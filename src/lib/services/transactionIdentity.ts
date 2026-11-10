/**
 * Transaction identity across scrapes.
 *
 * A provider's identifier is stable for a transaction, but its `date` is not:
 * Isracard reports the purchase time while the charge is pending (e.g. 12:43
 * local) and plain midnight once it settles; other providers correct a
 * posting date by a day. Requiring the same calendar day therefore produced a
 * second row for the same purchase on the next scrape.
 *
 * Identity is: same account + identifier + amount + description, dated within
 * ±IDENTITY_DATE_WINDOW_DAYS. The window is deliberately small so recurring
 * charges that reuse their identifier every month (Leumi standing orders are
 * ≥22 days apart) stay distinct. Identifiers compare after normalization:
 * Isracard re-emits the same settled transaction as "030000005" on one scrape
 * and "30000005" on the next, which created a second row per purchase.
 */
import { toAgorot, type MoneyInput } from './money';
import { normalizeTxnIdentifier } from './pendingSettlement';

export const IDENTITY_DATE_WINDOW_DAYS = 3;

const DAY_MS = 86_400_000;

export interface IdentifiedTransactionShape {
  accountId: string;
  txnIdentifier: string | null;
  chargedAmount: MoneyInput;
  description: string;
  date: Date;
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Half-open UTC-day range [gte, lt) covering ±IDENTITY_DATE_WINDOW_DAYS around `date`. */
export function identityDateWindow(date: Date): { gte: Date; lt: Date } {
  const dayStart = utcDayStart(date);
  return {
    gte: new Date(dayStart.getTime() - IDENTITY_DATE_WINDOW_DAYS * DAY_MS),
    lt: new Date(dayStart.getTime() + (IDENTITY_DATE_WINDOW_DAYS + 1) * DAY_MS),
  };
}

export function isSameIdentifiedTransaction(
  a: IdentifiedTransactionShape,
  b: IdentifiedTransactionShape,
): boolean {
  const idA = normalizeTxnIdentifier(a.txnIdentifier);
  const idB = normalizeTxnIdentifier(b.txnIdentifier);
  if (idA == null || idB == null) return false;
  if (a.accountId !== b.accountId) return false;
  if (idA !== idB) return false;
  if (toAgorot(a.chargedAmount) !== toAgorot(b.chargedAmount)) return false;
  if (a.description !== b.description) return false;
  const gap = Math.abs(utcDayStart(a.date).getTime() - utcDayStart(b.date).getTime());
  return gap <= IDENTITY_DATE_WINDOW_DAYS * DAY_MS;
}
