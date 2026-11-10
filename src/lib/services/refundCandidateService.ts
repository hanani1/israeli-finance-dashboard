/**
 * DB side of the same-sign refund detector (card #60, ADR-0024). READ-ONLY:
 * it loads rows and returns proposals; nothing here marks a transaction.
 * Matching lives in refundCandidates.ts.
 */
import { prisma } from '@/lib/db';
import { localDateRange } from './localDay';
import { detectSameSignRefundCandidates, type RefundCandidate } from './refundCandidates';

export interface RefundCandidateQuery {
  /** yyyy-MM-dd, inclusive (Israeli day). */
  from?: string;
  /** yyyy-MM-dd, inclusive (Israeli day). */
  to?: string;
  accountId?: string;
}

export async function loadRefundCandidateRows(query: RefundCandidateQuery) {
  return prisma.transaction.findMany({
    where: {
      date: localDateRange(query.from, query.to),
      ...(query.accountId ? { accountId: query.accountId } : {}),
    },
    select: {
      id: true,
      accountId: true,
      txnIdentifier: true,
      date: true,
      processedDate: true,
      chargedAmount: true,
      chargedCurrency: true,
      description: true,
      memo: true,
      createdAt: true,
      isRefund: true,
      isTransfer: true,
      isCardSettlement: true,
      account: { select: { provider: true, accountNumber: true } },
    },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  });
}

export async function findRefundCandidates(query: RefundCandidateQuery): Promise<{
  rows: Awaited<ReturnType<typeof loadRefundCandidateRows>>;
  candidates: RefundCandidate[];
}> {
  const rows = await loadRefundCandidateRows(query);
  return { rows, candidates: detectSameSignRefundCandidates(rows) };
}
