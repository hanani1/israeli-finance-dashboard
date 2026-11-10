/**
 * Safety class: WRITES DB (one row, only with --apply --confirm-db and a fresh backup).
 *
 * Card #60 — mark (or un-mark) ONE transaction as a same-sign refund
 * (Transaction.isRefund, ADR-0024). Used for the historical Pasta Bar
 * correction: keep both raw rows, mark only the -₪125 reversal so it counts
 * as +₪125 income while the -₪250 purchase stays an expense.
 *
 *   # 1. dated backup first (required — the script refuses without it)
 *   pg_dump -Fc "$DATABASE_URL" -f db-dumps/<db>-$(date +%Y%m%d-%H%M%S)-pre-card60.dump
 *   # 2. dry run (default): prints the row and before/projected totals
 *   npx tsx scripts/mark-transaction-refund.ts --id=<id> --backup=db-dumps/<file>.dump
 *   # 3. apply
 *   npx tsx scripts/mark-transaction-refund.ts --id=<id> --backup=<file> --apply --confirm-db=<db>
 *   # revert (same guards): sets isRefund back to false
 *   npx tsx scripts/mark-transaction-refund.ts --id=<id> --backup=<file> --revert [--apply --confirm-db=<db>]
 *
 * Only `isRefund` is written; the raw amount/sign, identifier, dates,
 * category, note and source data are untouched, so --revert restores the
 * previous state exactly. Idempotent: re-running in the same direction is a
 * no-op. Output reports, for the row's month: raw rows, visible rows,
 * income / expenses / net (summary cards and monthly breakdown), rows marked
 * isRefund ("reconciled") and open detector candidates (likely / ambiguous).
 * Do not git add the dump (db-dumps/ is gitignored).
 */
import { lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { CategoryGroup } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { getMonthlyBreakdown, getSummaryTotals } from '../src/lib/services/analyticsService';
import { classifyFlow } from '../src/lib/services/flowClassification';
import { localCalendarMonth, localDateRange } from '../src/lib/services/localDay';
import { ZERO_MONEY, money } from '../src/lib/services/money';
import { findRefundCandidates } from '../src/lib/services/refundCandidateService';
import {
  RefundCorrectionError,
  assertConfirmedDatabase,
  assertUsableBackup,
  databaseNameFromUrl,
  parseRefundCorrectionArgs,
  type BackupFileInfo,
} from '../src/lib/services/refundCorrection';
import { assertRefundToggleAllowed } from '../src/lib/services/transactionPatch';

function readBackupInfo(path: string): BackupFileInfo | null {
  try {
    const stat = lstatSync(path);
    let head = '';
    if (stat.isFile() && stat.size > 0) {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(64);
        const n = readSync(fd, buf, 0, buf.length, 0);
        head = buf.subarray(0, n).toString('latin1');
      } finally {
        closeSync(fd);
      }
    }
    return { isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs, head };
  } catch {
    return null;
  }
}

function monthDays(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

interface Snapshot {
  month: string;
  rawRows: number;
  visibleRows: number;
  summary: { income: number; expenses: number; net: number };
  breakdown: { month: string; totalIncome: number; totalExpense: number; net: number; refunds: number };
  refundsMarked: number;
  candidatesLikely: number;
  candidatesAmbiguous: number;
}

async function snapshot(month: string, flowMonth: string): Promise<Snapshot> {
  const { from, to } = monthDays(month);
  const date = localDateRange(from, to);
  const [rawRows, visibleRows, refundsMarked, summary, breakdown, detected] = await Promise.all([
    prisma.transaction.count({ where: { date } }),
    prisma.transaction.count({ where: { date, isCardSettlement: false, isTransfer: false } }),
    prisma.transaction.count({ where: { date, isRefund: true, isCardSettlement: false } }),
    getSummaryTotals({ from, to }),
    getMonthlyBreakdown({ month: flowMonth }),
    // A refund can trail its purchase; scan back so month-start refunds see their original.
    findRefundCandidates({ from: localCalendarMonth(new Date(Date.parse(`${from}T12:00:00Z`) - 90 * 86_400_000)) + '-01', to }),
  ]);
  const inMonth = new Set(
    detected.rows.filter((r) => localCalendarMonth(r.date) === month).map((r) => r.id),
  );
  const candidates = detected.candidates.filter((c) => inMonth.has(c.refundId));
  return {
    month,
    rawRows,
    visibleRows,
    summary,
    breakdown: {
      month: breakdown.month,
      totalIncome: breakdown.totalIncome,
      totalExpense: breakdown.totalExpense,
      net: breakdown.net,
      refunds: breakdown.refunds.total,
    },
    refundsMarked,
    candidatesLikely: candidates.filter((c) => c.confidence === 'likely').length,
    candidatesAmbiguous: candidates.filter((c) => c.confidence === 'ambiguous').length,
  };
}

function printSnapshot(label: string, s: Snapshot): void {
  console.log(`${label} (${s.month}; breakdown flow month ${s.breakdown.month})`);
  console.log(`  raw rows ${s.rawRows} | visible rows ${s.visibleRows}`);
  console.log(`  summary:   income ${s.summary.income} | expenses ${s.summary.expenses} | net ${s.summary.net}`);
  console.log(`  breakdown: income ${s.breakdown.totalIncome} (refunds ${s.breakdown.refunds}) | expenses ${s.breakdown.totalExpense} | net ${s.breakdown.net}`);
  console.log(`  reconciled (isRefund) ${s.refundsMarked} | open candidates: likely ${s.candidatesLikely}, ambiguous ${s.candidatesAmbiguous}`);
}

async function main(): Promise<void> {
  const args = parseRefundCorrectionArgs(process.argv.slice(2));
  assertUsableBackup(readBackupInfo(args.backup), Date.now());
  assertConfirmedDatabase(args, process.env.DATABASE_URL);
  const target = !args.revert;

  console.log(`Database: ${databaseNameFromUrl(process.env.DATABASE_URL) ?? '(unknown)'} | backup: ${args.backup}`);
  console.log(`Mode: ${args.apply ? 'APPLY' : 'dry run'} | set isRefund=${target}`);

  const row = await prisma.transaction.findUnique({
    where: { id: args.id },
    include: { account: { select: { provider: true, accountNumber: true } }, category: { select: { name: true, group: true } } },
  });
  if (!row) throw new RefundCorrectionError(`Transaction ${args.id} not found`);
  console.log(
    `Row: ${row.id} | ${row.account.provider} •${row.account.accountNumber.slice(-4)} | ${row.date.toISOString()} | raw ${row.chargedAmount} ${row.chargedCurrency} | id=${row.txnIdentifier ?? '—'} | "${row.description}" | category ${row.category?.name ?? '—'} | isRefund ${row.isRefund} | hidden ${row.isCardSettlement} | transfer ${row.isTransfer}`,
  );
  assertRefundToggleAllowed(row, target);

  const month = localCalendarMonth(row.date);
  const flowMonth = row.flowMonth ?? month;
  const before = await snapshot(month, flowMonth);
  printSnapshot('BEFORE', before);

  if (row.isRefund === target) {
    console.log(`No change: isRefund is already ${target} (idempotent).`);
    return;
  }

  if (!args.apply) {
    const group = row.category?.group ?? null;
    const counted = row.chargedCurrency === 'ILS' && group !== CategoryGroup.INVESTMENT;
    const was = classifyFlow(row.chargedAmount, group, row.isRefund);
    const will = classifyFlow(row.chargedAmount, group, target);
    const dIncome = counted ? will.income.sub(was.income) : ZERO_MONEY;
    const dExpense = counted ? will.expense.sub(was.expense) : ZERO_MONEY;
    const income = money(before.summary.income).add(dIncome);
    const expenses = money(before.summary.expenses).add(dExpense);
    console.log(`PROJECTED summary after: income ${income} | expenses ${expenses} | net ${income.sub(expenses)} | reconciled ${before.refundsMarked + (target ? 1 : -1)}`);
    console.log('Dry run — nothing written. Re-run with --apply --confirm-db=<db> to write.');
    return;
  }

  const result = await prisma.transaction.updateMany({
    where: { id: row.id, isRefund: row.isRefund, chargedAmount: { lt: 0 } },
    data: { isRefund: target },
  });
  if (result.count !== 1) throw new RefundCorrectionError('Row changed concurrently; nothing written');
  console.log(`Wrote isRefund=${target} on ${row.id}. Revert with ${target ? '--revert' : '(omit --revert)'} and the same guards.`);
  const after = await snapshot(month, flowMonth);
  printSnapshot('AFTER', after);
}

void main()
  .catch((e) => {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
