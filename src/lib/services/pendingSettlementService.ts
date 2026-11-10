/**
 * DB service for pending → settled supersession on card accounts. Raw rows are
 * never deleted: a superseded pending row is hidden with the same
 * `isCardSettlement` flag every list/aggregation path already excludes
 * ("duplicates card spending that is already counted"), so no view, budget or
 * total needs to learn a new flag. Matching lives in pendingSettlement.ts.
 *
 * Only marks; never clears a card row's flag. A row hidden by an earlier run
 * (or by hand) stays hidden even if a later scrape changes its twin, which is
 * the safe direction for a duplicate.
 */
import { AccountKind, CategorizationSource } from '@prisma/client';
import { prisma } from '@/lib/db';
import { detectSupersededPendingRows, type SupersededPending } from './pendingSettlement';

export interface PendingSupersessionSummary {
  /** Pending rows newly hidden by this run. */
  supersededMarked: number;
  /** Survivors that inherited the hidden row's manual category. */
  categoriesCarried: number;
  /** Every match found (including rows that were already hidden). */
  matches: SupersededPending[];
}

export async function detectAndMarkSupersededPending(): Promise<PendingSupersessionSummary> {
  const rows = await prisma.transaction.findMany({
    where: { account: { kind: AccountKind.CARD }, isTransfer: false },
    select: {
      id: true,
      accountId: true,
      txnIdentifier: true,
      date: true,
      processedDate: true,
      chargedAmount: true,
      originalAmount: true,
      description: true,
      memo: true,
      createdAt: true,
      isCardSettlement: true,
      categoryId: true,
      categorizationSource: true,
    },
  });

  // Rows already hidden cannot stand in for anything, and need no re-matching.
  const matches = detectSupersededPendingRows(rows.filter((row) => !row.isCardSettlement));
  const byId = new Map(rows.map((row) => [row.id, row]));

  let supersededMarked = 0;
  let categoriesCarried = 0;
  await prisma.$transaction(async (tx) => {
    for (const match of matches) {
      const pending = byId.get(match.pendingId);
      const settled = byId.get(match.settledId);
      if (!pending || !settled) continue;

      // Preserve the user's work: a manual category on the hidden row moves to
      // the survivor unless the survivor was itself categorized by hand.
      if (
        pending.categoryId !== null &&
        pending.categorizationSource === CategorizationSource.MANUAL &&
        settled.categorizationSource !== CategorizationSource.MANUAL
      ) {
        await tx.transaction.update({
          where: { id: settled.id },
          data: { categoryId: pending.categoryId, categorizationSource: CategorizationSource.MANUAL },
        });
        categoriesCarried += 1;
      }

      const result = await tx.transaction.updateMany({
        where: { id: pending.id, isCardSettlement: false },
        data: { isCardSettlement: true, settlesAccountId: null },
      });
      supersededMarked += result.count;
    }
  });

  return { supersededMarked, categoriesCarried, matches };
}
