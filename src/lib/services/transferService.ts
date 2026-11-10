/**
 * Transfer service layer — DB access for inter-account transfer detection and
 * the transfers page listing.
 *
 * Detection pairs unmarked transactions with `pairTransfers` (see
 * transferDetection.ts for the heuristics) and marks both sides
 * isTransfer=true with mutual transferPairId references. Marked rows are
 * excluded from every income/expense aggregation (analytics, monthly
 * breakdown, budgets) and surface only on the transfers page.
 */
import { prisma } from '@/lib/db';
import { moneyToNumber } from './money';
import { pairTransfers } from './transferDetection';

/**
 * Detect transfers among not-yet-marked transactions and mark both sides.
 * Idempotent: already-paired rows (transferPairId set) are never re-paired.
 * Returns the number of NEW pairs marked.
 */
export async function detectAndMarkTransfers(): Promise<number> {
  const unmarked = await prisma.transaction.findMany({
    where: { isTransfer: false, transferPairId: null },
    select: {
      id: true,
      accountId: true,
      date: true,
      chargedAmount: true,
      description: true,
    },
  });

  const pairs = pairTransfers(unmarked);
  let marked = 0;

  for (const pair of pairs) {
    // Guarded update: only claim rows still unmarked, so a concurrent run
    // cannot double-pair. Both sides must be claimed or neither is kept.
    await prisma.$transaction(async (tx) => {
      const outflow = await tx.transaction.updateMany({
        where: { id: pair.outflowId, isTransfer: false, transferPairId: null },
        data: { isTransfer: true, transferPairId: pair.inflowId },
      });
      if (outflow.count !== 1) return;
      const inflow = await tx.transaction.updateMany({
        where: { id: pair.inflowId, isTransfer: false, transferPairId: null },
        data: { isTransfer: true, transferPairId: pair.outflowId },
      });
      if (inflow.count !== 1) {
        throw new Error('transfer counterpart already claimed'); // rolls back the outflow mark
      }
      marked += 1;
    });
  }

  return marked;
}

export interface TransferPairView {
  /** Outflow transaction id (stable key for the pair). */
  id: string;
  date: string; // ISO date of the outflow side
  amount: number; // positive ILS amount moved
  fromAccount: string;
  toAccount: string;
  fromDescription: string;
  toDescription: string;
}

export interface TransfersResult {
  pairs: TransferPairView[];
}

/** All detected transfer pairs, newest first, one row per pair. */
export async function listTransferPairs(options: {
  userId?: string;
} = {}): Promise<TransfersResult> {
  const rows = await prisma.transaction.findMany({
    where: {
      isTransfer: true,
      transferPairId: { not: null },
      ...(options.userId ? { account: { userId: options.userId } } : {}),
    },
    include: { account: { select: { displayName: true } } },
    orderBy: { date: 'desc' },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  const pairs: TransferPairView[] = [];
  for (const row of rows) {
    if (!row.chargedAmount.lt(0)) continue; // build each pair from its outflow side
    const counterpart = row.transferPairId ? byId.get(row.transferPairId) : undefined;
    if (!counterpart) continue; // counterpart filtered out (shouldn't happen: same household)
    pairs.push({
      id: row.id,
      date: row.date.toISOString(),
      amount: moneyToNumber(row.chargedAmount.abs()),
      fromAccount: row.account.displayName,
      toAccount: counterpart.account.displayName,
      fromDescription: row.description,
      toDescription: counterpart.description,
    });
  }
  return { pairs };
}
