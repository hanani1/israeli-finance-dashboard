/**
 * DB service for card-settlement detection. All raw rows remain in PostgreSQL;
 * duplicate bank rows are represented only by isCardSettlement metadata.
 */
import { AccountKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  isPendingSnapshotDescription,
  matchCoveredSettlements,
  pendingSnapshotsToHide,
  settlementProviderFor,
} from './cardSettlementDetection';

export interface CardSettlementSummary {
  settlementsMarked: number;
  obsoleteSnapshotsMarked: number;
}

/**
 * Recompute covered Max/Isracard/Cal cycles and pending-Cal forecast snapshots.
 * Recomputing all candidates (rather than only unmarked rows) keeps the result
 * correct after a new card account or a newer pending snapshot is ingested.
 */
export async function detectAndMarkCardSettlements(): Promise<CardSettlementSummary> {
  const [bankTxns, cardTxns] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        isTransfer: false,
        chargedAmount: { lt: 0 },
        account: { kind: AccountKind.BANK },
      },
      select: {
        id: true,
        accountId: true,
        date: true,
        chargedAmount: true,
        description: true,
        createdAt: true,
        isCardSettlement: true,
      },
    }),
    prisma.transaction.findMany({
      where: {
        account: { kind: AccountKind.CARD },
        processedDate: { not: null },
      },
      select: {
        accountId: true,
        processedDate: true,
        chargedAmount: true,
        account: { select: { provider: true } },
      },
    }),
  ]);

  const settlementCandidates = bankTxns.filter(
    (txn) => settlementProviderFor(txn.description) !== null,
  );
  const matches = matchCoveredSettlements(
    settlementCandidates,
    cardTxns.map((txn) => ({
      accountId: txn.accountId,
      provider: txn.account.provider,
      processedDate: txn.processedDate,
      chargedAmount: txn.chargedAmount,
    })),
  );
  const desiredSettlements = new Map(
    matches.map((match) => [match.settlementId, match.cardAccountId]),
  );

  let settlementsMarked = 0;
  await prisma.$transaction(async (tx) => {
    const noLongerCovered = settlementCandidates
      .filter((candidate) => !desiredSettlements.has(candidate.id))
      .map((candidate) => candidate.id);
    if (noLongerCovered.length > 0) {
      await tx.transaction.updateMany({
        where: { id: { in: noLongerCovered }, isCardSettlement: true },
        data: { isCardSettlement: false, settlesAccountId: null },
      });
    }

    for (const match of matches) {
      const newlyMarked = await tx.transaction.updateMany({
        where: { id: match.settlementId, isCardSettlement: false },
        data: { isCardSettlement: true, settlesAccountId: match.cardAccountId },
      });
      settlementsMarked += newlyMarked.count;
      if (newlyMarked.count === 0) {
        await tx.transaction.updateMany({
          where: { id: match.settlementId },
          data: { settlesAccountId: match.cardAccountId },
        });
      }
    }
  });

  const snapshotCandidates = bankTxns.filter((txn) =>
    isPendingSnapshotDescription(txn.description),
  );
  const hasDetailedCalRows = cardTxns.some((txn) => txn.account.provider === 'visaCal');
  const obsoleteIds = new Set(pendingSnapshotsToHide(snapshotCandidates, { hasDetailedCalRows }));
  const currentIds = snapshotCandidates
    .filter((candidate) => !obsoleteIds.has(candidate.id))
    .map((candidate) => candidate.id);

  let obsoleteSnapshotsMarked = 0;
  await prisma.$transaction(async (tx) => {
    // Without detailed Cal rows a newly ingested snapshot becomes the visible
    // survivor; with them the set is empty and every snapshot stays hidden.
    if (currentIds.length > 0) {
      await tx.transaction.updateMany({
        where: { id: { in: currentIds } },
        data: { isCardSettlement: false, settlesAccountId: null },
      });
    }
    if (obsoleteIds.size > 0) {
      const result = await tx.transaction.updateMany({
        where: { id: { in: [...obsoleteIds] }, isCardSettlement: false },
        data: { isCardSettlement: true, settlesAccountId: null },
      });
      obsoleteSnapshotsMarked = result.count;
    }
  });

  return { settlementsMarked, obsoleteSnapshotsMarked };
}
