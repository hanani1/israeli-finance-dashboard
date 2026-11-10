/**
 * Safety class: WRITES DB (marks transfer pairs; idempotent).
 *
 * Backfill inter-account transfer detection over existing transactions.
 *
 * Runs the same detection used by ingestion (transferService) over all
 * not-yet-marked rows, then prints the marked pairs. Idempotent: re-running
 * marks nothing new. Usage: npx tsx scripts/backfill-transfers.ts
 */
import { prisma } from '../src/lib/db';
import { detectAndMarkTransfers, listTransferPairs } from '../src/lib/services/transferService';

async function main() {
  const marked = await detectAndMarkTransfers();
  console.log(`Transfer pairs newly marked: ${marked}`);

  const { pairs } = await listTransferPairs();
  console.log(`Total transfer pairs in DB: ${pairs.length}`);
  for (const pair of pairs) {
    console.log(
      `  ${pair.date.slice(0, 10)}  ${pair.fromAccount} -> ${pair.toAccount}  ` +
        `${pair.amount} ILS  (${pair.fromDescription} / ${pair.toDescription})`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
