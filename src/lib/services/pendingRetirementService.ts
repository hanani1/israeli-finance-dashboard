/**
 * DB side of pending retirement (card #49, ADR-0025); the rule lives in
 * pendingRetirement.ts. Only card accounts are considered, rows are never
 * deleted, and only rows this rule retired (pendingRetiredAt set) are ever
 * un-hidden — a row hidden by the settlement matcher or by hand is left alone.
 */
import { AccountKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { selectPendingToRetire, selectRetiredToRestore } from './pendingRetirement';

/** One account returned by a successful scrape, with the row ids it returned. */
export interface ScrapedAccountRows {
  accountId: string;
  provider: string;
  seenIds: ReadonlySet<string>;
}

const retirementSelect = {
  id: true,
  date: true,
  providerStatus: true,
  txnIdentifier: true,
  isCardSettlement: true,
  pendingRetiredAt: true,
} as const;

/**
 * Un-hide rows this rule retired that the provider returned again. Run right
 * after the account's rows are upserted, before the settlement matchers, so
 * they can re-evaluate the row.
 */
export async function restoreReappearedPending(scrape: ScrapedAccountRows): Promise<number> {
  if (scrape.seenIds.size === 0) return 0;
  // The retired set is small; filter by seen ids in memory rather than
  // binding a full-history scrape's ids as query parameters.
  const rows = await prisma.transaction.findMany({
    where: { accountId: scrape.accountId, pendingRetiredAt: { not: null } },
    select: retirementSelect,
  });
  const ids = selectRetiredToRestore(rows, scrape.seenIds);
  if (ids.length === 0) return 0;
  const result = await prisma.transaction.updateMany({
    where: { id: { in: ids }, pendingRetiredAt: { not: null } },
    data: { isCardSettlement: false, settlesAccountId: null, pendingRetiredAt: null },
  });
  return result.count;
}

/**
 * Retire pending rows the latest successful scrape of their account did not
 * return and that are older than the provider's pending horizon. Run after
 * detectAndMarkSupersededPending so matched rows are handled (and their manual
 * category carried) by the matcher first.
 */
export async function retireUnseenPending(
  scrapes: readonly ScrapedAccountRows[],
  now: Date = new Date(),
): Promise<number> {
  let retired = 0;
  for (const scrape of scrapes) {
    const rows = await prisma.transaction.findMany({
      where: {
        accountId: scrape.accountId,
        account: { kind: AccountKind.CARD },
        isCardSettlement: false,
        isTransfer: false,
        // Persisted pending status, or a legacy row without one (the pure rule
        // decides which legacy rows count as pending).
        OR: [{ providerStatus: 'pending' }, { providerStatus: null, txnIdentifier: null }],
      },
      select: retirementSelect,
    });
    const ids = selectPendingToRetire(rows, scrape.seenIds, scrape.provider, now);
    if (ids.length === 0) continue;
    const result = await prisma.transaction.updateMany({
      where: { id: { in: ids }, isCardSettlement: false },
      data: { isCardSettlement: true, settlesAccountId: null, pendingRetiredAt: now },
    });
    retired += result.count;
  }
  return retired;
}
