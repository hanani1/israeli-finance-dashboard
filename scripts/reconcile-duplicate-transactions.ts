/**
 * Safety class: WRITES DB (merges/deletes duplicates only with --apply --backup; report by default).
 *
 * Reconcile duplicate transaction rows created by provider date drift.
 *
 * Before the identity window fix (transactionIdentity.ts), a provider that
 * moved a transaction's date between scrapes (Isracard: purchase time while
 * pending → midnight once settled) produced a second row with the same
 * account + identifier + amount + description. This script finds those pairs
 * within the identity window and, in --apply mode, merges each pair into the
 * OLDEST row (the one users have already categorized):
 *
 *   survivor.date          := newest scrape's date (settled posting)
 *   survivor.processedDate := newest non-null processedDate
 *   survivor.category      := kept if set, else taken from the duplicate
 *   duplicate              := deleted (only after the survivor is updated)
 *
 * Recurring charges that reuse an identifier month after month (Leumi
 * standing orders, ≥22 days apart) are outside the window and never touched.
 *
 * Usage:
 *   npx tsx scripts/reconcile-duplicate-transactions.ts --report [--month=2026-09]
 *   npx tsx scripts/reconcile-duplicate-transactions.ts --apply --backup=db-dumps/x.sql
 *
 * --apply refuses to run without a fresh backup path that exists on disk.
 * Output never includes credentials; descriptions are truncated.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  IDENTITY_DATE_WINDOW_DAYS,
  isSameIdentifiedTransaction,
} from '../src/lib/services/transactionIdentity';
import { detectAndMarkCardSettlements } from '../src/lib/services/cardSettlementService';
import { ZERO_MONEY, moneyToNumber, type Decimal } from '../src/lib/services/money';

try {
  process.loadEnvFile('.env');
} catch {
  // rely on environment
}

const prisma = new PrismaClient();

interface Row {
  id: string;
  accountId: string;
  provider: string;
  txnIdentifier: string | null;
  date: Date;
  processedDate: Date | null;
  chargedAmount: Decimal;
  description: string;
  categoryId: number | null;
  categorizationSource: string | null;
  isTransfer: boolean;
  isCardSettlement: boolean;
  flowMonth: string | null;
  createdAt: Date;
}

interface Pair {
  survivor: Row;
  duplicate: Row;
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function loadIdentifiedRows(): Promise<Row[]> {
  const rows = await prisma.transaction.findMany({
    where: { txnIdentifier: { not: null } },
    select: {
      id: true,
      accountId: true,
      account: { select: { provider: true } },
      txnIdentifier: true,
      date: true,
      processedDate: true,
      chargedAmount: true,
      description: true,
      categoryId: true,
      categorizationSource: true,
      isTransfer: true,
      isCardSettlement: true,
      flowMonth: true,
      createdAt: true,
    },
    orderBy: [{ accountId: 'asc' }, { txnIdentifier: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => ({ ...r, provider: r.account.provider }));
}

/** Group by identity key, then pair rows whose dates fall within the window. */
function findPairs(rows: Row[]): Pair[] {
  const byKey = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.accountId}|${row.txnIdentifier}|${row.chargedAmount}|${row.description}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }
  const pairs: Pair[] = [];
  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue;
    // Oldest row first; each later row within the window of a survivor is a duplicate.
    const sorted = [...bucket].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const survivors: Row[] = [];
    for (const row of sorted) {
      const survivor = survivors.find((s) => isSameIdentifiedTransaction(s, row));
      if (survivor) pairs.push({ survivor, duplicate: row });
      else survivors.push(row);
    }
  }
  return pairs;
}

function fmt(row: Row): string {
  return `${row.id.slice(0, 8)} ${row.date.toISOString().slice(0, 16)} ${row.chargedAmount} cat=${row.categoryId ?? '-'}/${row.categorizationSource ?? '-'} created=${row.createdAt.toISOString().slice(0, 10)}`;
}

async function report(pairs: Pair[], month: string | undefined): Promise<void> {
  const inScope = month
    ? pairs.filter((p) => [p.survivor, p.duplicate].some((r) => r.date.toISOString().startsWith(month)))
    : pairs;
  const byProvider = new Map<string, { count: number; sum: Decimal }>();
  for (const p of inScope) {
    const agg = byProvider.get(p.survivor.provider) ?? { count: 0, sum: ZERO_MONEY };
    agg.count += 1;
    agg.sum = agg.sum.add(p.duplicate.chargedAmount.abs());
    byProvider.set(p.survivor.provider, agg);
  }
  console.log(`Duplicate identity pairs (window ±${IDENTITY_DATE_WINDOW_DAYS} days)${month ? ` touching ${month}` : ''}: ${inScope.length}`);
  for (const [provider, agg] of byProvider) {
    console.log(`  ${provider}: ${agg.count} pairs, duplicated amount ${agg.sum.toFixed(2)}`);
  }
  const categoryConflicts = inScope.filter(
    (p) => p.survivor.categoryId != null && p.duplicate.categoryId != null && p.survivor.categoryId !== p.duplicate.categoryId,
  );
  console.log(`  pairs where both rows are categorized differently (survivor wins): ${categoryConflicts.length}`);
  const gaps = new Map<number, number>();
  for (const p of inScope) {
    const gap = Math.round(Math.abs(p.survivor.date.getTime() - p.duplicate.date.getTime()) / 86_400_000);
    gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  console.log(`  date gap distribution (days → pairs): ${JSON.stringify(Object.fromEntries([...gaps].sort()))}`);
  console.log('  sample:');
  for (const p of inScope.slice(0, 5)) {
    console.log(`    keep ${fmt(p.survivor)} | drop ${fmt(p.duplicate)} | ${p.duplicate.description.slice(0, 18)}`);
  }

  const outDir = path.resolve('debug-screenshots');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `duplicate-pairs-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      inScope.map((p) => ({
        provider: p.survivor.provider,
        identifier: p.survivor.txnIdentifier,
        amount: moneyToNumber(p.survivor.chargedAmount),
        description: p.survivor.description.slice(0, 40),
        keep: { id: p.survivor.id, date: p.survivor.date, categoryId: p.survivor.categoryId, source: p.survivor.categorizationSource },
        drop: { id: p.duplicate.id, date: p.duplicate.date, categoryId: p.duplicate.categoryId, source: p.duplicate.categorizationSource },
      })),
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`  full list -> ${outFile}`);
}

async function apply(pairs: Pair[]): Promise<void> {
  const backup = arg('backup');
  if (!backup || !existsSync(backup)) {
    throw new Error('--apply requires --backup=<path to a fresh pg_dump that exists>.');
  }
  const before = await prisma.transaction.count();
  let merged = 0;
  let categoriesInherited = 0;
  for (const { survivor, duplicate } of pairs) {
    await prisma.$transaction(async (tx) => {
      const newest = survivor.createdAt > duplicate.createdAt ? survivor : duplicate;
      const inheritCategory = survivor.categoryId == null && duplicate.categoryId != null;
      await tx.transaction.update({
        where: { id: survivor.id },
        data: {
          date: newest.date,
          processedDate: newest.processedDate ?? survivor.processedDate ?? duplicate.processedDate,
          flowMonth: survivor.flowMonth ?? duplicate.flowMonth,
          isTransfer: survivor.isTransfer || duplicate.isTransfer,
          ...(inheritCategory
            ? {
                categoryId: duplicate.categoryId,
                categorizationSource: (duplicate.categorizationSource ?? 'RULE') as never,
              }
            : {}),
        },
      });
      // Any bank row that pointed at the duplicate as its settled card account
      // is keyed by accountId, not transaction id, so nothing else references it.
      await tx.transaction.delete({ where: { id: duplicate.id } });
    });
    merged += 1;
    if (survivor.categoryId == null && duplicate.categoryId != null) categoriesInherited += 1;
  }
  const after = await prisma.transaction.count();
  console.log(`Merged ${merged} pairs (${categoriesInherited} survivors inherited a category). Rows: ${before} → ${after} (expected ${before - pairs.length}).`);

  const settlements = await detectAndMarkCardSettlements();
  console.log(`Card settlement detection re-run: newly marked=${settlements.settlementsMarked}, obsolete snapshots=${settlements.obsoleteSnapshotsMarked}`);
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--apply') ? 'apply' : 'report';
  const rows = await loadIdentifiedRows();
  const pairs = findPairs(rows);
  if (mode === 'report') {
    await report(pairs, arg('month'));
  } else {
    await report(pairs, undefined);
    await apply(pairs);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
