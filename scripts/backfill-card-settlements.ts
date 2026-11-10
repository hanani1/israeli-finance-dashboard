/**
 * Safety class: WRITES DB (marks settlements/kinds; idempotent).
 *
 * Backfill for the account-kind + card-settlement migration.
 *
 *  1. Sets Account.kind from the provider (card issuers -> CARD, else BANK).
 *  2. Runs the same settlement/revision detection used by ingestion
 *     (cardSettlementService) over existing rows: marks bank debits covered by
 *     Max/Isracard card cycles and obsolete repeated pending Cal snapshots.
 *
 * Raw rows are preserved — detection only sets isCardSettlement /
 * settlesAccountId. Idempotent: re-running marks nothing new.
 * Usage: npx tsx scripts/backfill-card-settlements.ts
 */
import { prisma } from '../src/lib/db';
import { accountKindForProvider } from '../src/lib/services/accountKind';
import { detectAndMarkCardSettlements } from '../src/lib/services/cardSettlementService';

async function main() {
  // 1. Provider -> kind backfill.
  const accounts = await prisma.account.findMany({
    select: { id: true, provider: true, displayName: true, kind: true },
  });
  for (const account of accounts) {
    const kind = accountKindForProvider(account.provider);
    if (kind !== account.kind) {
      await prisma.account.update({ where: { id: account.id }, data: { kind } });
    }
    console.log(`Account ${account.displayName} (${account.provider}) -> ${kind}`);
  }

  // 2. Settlement / obsolete-snapshot detection.
  const summary = await detectAndMarkCardSettlements();
  console.log(
    `Newly marked: coveredSettlements=${summary.settlementsMarked} obsoletePendingSnapshots=${summary.obsoleteSnapshotsMarked}`,
  );

  // Report the resulting state for verification.
  const marked = await prisma.transaction.findMany({
    where: { isCardSettlement: true },
    include: { account: { select: { displayName: true } } },
    orderBy: { date: 'desc' },
  });
  console.log(`Total isCardSettlement rows in DB: ${marked.length}`);
  for (const row of marked) {
    console.log(
      `  ${row.date.toISOString().slice(0, 10)}  ${row.account.displayName}  ` +
        `${row.chargedAmount} ILS  "${row.description}"  ` +
        (row.settlesAccountId ? `settles=${row.settlesAccountId.slice(0, 8)}…` : 'obsolete-snapshot'),
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
