/**
 * Safety class: READ-ONLY (database); writes the JSON + Markdown report files.
 *
 * Compare a RiseUp API snapshot (from `npm run riseup:fetch`) with the
 * dashboard, month by month:
 *
 *   npm run riseup:compare -- --input=data/riseup/transactions.json [--months=N] \
 *     [--output=<file>.json] [--markdown=<file>.md]
 *
 * Rows are paired with the shared RiseUp matcher (src/lib/services/riseupMatcher.ts,
 * the same tiers the CSV importers use) plus its opt-in amount + same-day
 * fallback tier, which is reported as low confidence.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { prisma } from '../src/lib/db';
import { money, moneyToNumber, type Decimal } from '../src/lib/services/money';
import { calendarDay, comparisonRange, effectiveMonth } from '../src/lib/services/riseupComparison';
import { matchRiseUpRows, type MatchTier } from '../src/lib/services/riseupMatcher';

type RiseUpTransaction = {
  transactionId: string;
  transactionDate: string;
  billingDate?: string;
  businessName: string;
  amount: number;
  isIncome: boolean;
  cashflowDate?: string;
  categoryLabel?: string;
  categoryType?: string;
};
type Snapshot = { from: string; to: string; transactions: RiseUpTransaction[] };
type DashboardTransaction = {
  id: string; date: Date; processedDate: Date | null; chargedAmount: Decimal; description: string; memo: string | null;
  categoryId: number | null; categorizationSource: string; isCardSettlement: boolean;
  flowMonth: string | null; category: { name: string; type: string } | null;
};
type Match = { riseup: RiseUpTransaction; dashboard: DashboardTransaction | null; confidence: 'high' | 'medium' | 'low' | 'unmatched'; reason: string };
type MonthlyRow = {
  riseupRows: number; dashboardRows: number; matched: number; unmatchedRiseup: number; unmatchedDashboard: number;
  riseupIncome: number; dashboardIncome: number; riseupExpenses: number; dashboardExpenses: number;
};

function signedRiseUp(transaction: RiseUpTransaction): number { return transaction.isIncome ? transaction.amount : -transaction.amount; }
function confidenceFor(tier: MatchTier): Match['confidence'] {
  if (tier.startsWith('exact-')) return 'high';
  return tier === 'amount+payment-date' ? 'low' : 'medium';
}
function monthStart(value: string): Date {
  const [year = 0, month = 0] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}
function monthAfter(value: string): Date {
  const [year = 0, month = 0] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month, 1));
}
function inRange(value: string, from: string, to: string): boolean { return value >= from && value <= to; }

async function main(): Promise<void> {
  const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice(8);
  if (!input) throw new Error('Usage: npx tsx scripts/riseup-compare.ts --input=data/riseup/transactions.json [--months=N] [--output=...]');
  const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ?? `${input}.comparison.json`;
  const markdown = process.argv.find((arg) => arg.startsWith('--markdown='))?.slice(11) ?? `${input}.comparison.md`;
  const monthsValue = process.argv.find((arg) => arg.startsWith('--months='))?.slice(9);
  const months = monthsValue === undefined ? undefined : Number(monthsValue);
  const snapshot = JSON.parse(await readFile(input, 'utf8')) as Snapshot;
  const range = comparisonRange(snapshot.from, snapshot.to, months);
  const riseupTransactions = snapshot.transactions.filter((transaction) => inRange(effectiveMonth(transaction.cashflowDate, transaction.transactionDate), range.from, range.to));
  const dashboard = await prisma.transaction.findMany({
    where: {
      isCardSettlement: false,
      OR: [
        { flowMonth: { gte: range.from, lte: range.to } },
        { flowMonth: null, date: { gte: monthStart(range.from), lt: monthAfter(range.to) } },
      ],
    },
    select: { id: true, date: true, processedDate: true, chargedAmount: true, description: true, memo: true, categoryId: true, categorizationSource: true, isCardSettlement: true, flowMonth: true, category: { select: { name: true, type: true } } },
  }) as DashboardTransaction[];

  const result = matchRiseUpRows(
    riseupTransactions.map((riseup) => ({
      key: riseup.transactionId,
      amount: signedRiseUp(riseup),
      paymentDate: calendarDay(riseup.transactionDate),
      chargeDate: riseup.billingDate ? calendarDay(riseup.billingDate) : null,
      description: riseup.businessName,
      source: riseup,
    })),
    dashboard.map((transaction) => ({
      id: transaction.id,
      date: calendarDay(transaction.date),
      processedDate: transaction.processedDate ? calendarDay(transaction.processedDate) : null,
      amount: transaction.chargedAmount,
      description: transaction.description,
      source: transaction,
    })),
    { amountDateFallback: true },
  );
  const used = new Set(result.matches.map((match) => match.txn.id));
  const byRiseUp = new Map<RiseUpTransaction, Match>();
  for (const match of result.matches) {
    byRiseUp.set(match.row.source, { riseup: match.row.source, dashboard: match.txn.source, confidence: confidenceFor(match.tier), reason: `tier ${match.tier}` });
  }
  for (const miss of result.unmatched) {
    byRiseUp.set(miss.row.source, { riseup: miss.row.source, dashboard: null, confidence: 'unmatched', reason: miss.reason });
  }
  const matches = riseupTransactions.map((riseup) => byRiseUp.get(riseup)).filter((match): match is Match => match !== undefined);

  const unmatchedDashboard = dashboard.filter((transaction) => !used.has(transaction.id));
  const monthly: Record<string, MonthlyRow> = {};
  const add = (month: string) => monthly[month] ??= { riseupRows: 0, dashboardRows: 0, matched: 0, unmatchedRiseup: 0, unmatchedDashboard: 0, riseupIncome: 0, dashboardIncome: 0, riseupExpenses: 0, dashboardExpenses: 0 };
  for (const riseup of riseupTransactions) {
    const row = add(effectiveMonth(riseup.cashflowDate, riseup.transactionDate)); const amount = signedRiseUp(riseup);
    row.riseupRows += 1;
    if (amount >= 0) row.riseupIncome += amount; else row.riseupExpenses -= amount;
  }
  for (const transaction of dashboard) {
    const row = add(effectiveMonth(transaction.flowMonth, transaction.date));
    row.dashboardRows += 1;
    // Exact per-step sums; the report row is a display boundary (card #53).
    if (!transaction.chargedAmount.lt(0)) row.dashboardIncome = moneyToNumber(money(row.dashboardIncome).add(transaction.chargedAmount));
    else row.dashboardExpenses = moneyToNumber(money(row.dashboardExpenses).sub(transaction.chargedAmount));
  }
  for (const match of matches) {
    const row = add(effectiveMonth(match.riseup.cashflowDate, match.riseup.transactionDate));
    if (match.dashboard) row.matched += 1; else row.unmatchedRiseup += 1;
  }
  for (const transaction of unmatchedDashboard) add(effectiveMonth(transaction.flowMonth, transaction.date)).unmatchedDashboard += 1;

  const categoryDifferences = matches.filter((match) => (match.confidence === 'high' || match.confidence === 'medium') && match.dashboard?.category && match.riseup.categoryLabel && match.dashboard.category.name.trim() !== match.riseup.categoryLabel.trim()).map((match) => ({ transactionId: match.riseup.transactionId, riseupCategory: match.riseup.categoryLabel, dashboardCategory: match.dashboard?.category?.name, source: match.dashboard?.categorizationSource }));
  const report = {
    generatedAt: new Date().toISOString(), sourceRange: { from: snapshot.from, to: snapshot.to }, comparisonRange: range,
    counts: { riseup: riseupTransactions.length, dashboard: dashboard.length, matched: matches.filter((match) => match.dashboard).length, unmatchedRiseup: matches.filter((match) => !match.dashboard).length, unmatchedDashboard: unmatchedDashboard.length, lowConfidence: matches.filter((match) => match.confidence === 'low').length, categoryDifferences: categoryDifferences.length },
    monthly: Object.fromEntries(Object.entries(monthly).sort()),
    unmatchedRiseup: matches.filter((match) => !match.dashboard),
    unmatchedDashboard,
    categoryDifferences,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const lines = [`# RiseUp comparison`, `Generated: ${report.generatedAt}`, `Source range: ${snapshot.from} to ${snapshot.to}`, `Comparison range: ${range.from} to ${range.to}`, '', '## Counts', ...Object.entries(report.counts).map(([key, value]) => `- ${key}: ${value}`), '', '## Monthly coverage and income/expense comparison', '| Month | RiseUp rows | Dashboard rows | Matched | Unmatched RiseUp | Unmatched dashboard | RiseUp income | Dashboard income | Difference | RiseUp expenses | Dashboard expenses | Difference |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [month, row] of Object.entries(report.monthly)) lines.push(`| ${month} | ${row.riseupRows} | ${row.dashboardRows} | ${row.matched} | ${row.unmatchedRiseup} | ${row.unmatchedDashboard} | ${row.riseupIncome.toFixed(2)} | ${row.dashboardIncome.toFixed(2)} | ${(row.riseupIncome - row.dashboardIncome).toFixed(2)} | ${row.riseupExpenses.toFixed(2)} | ${row.dashboardExpenses.toFixed(2)} | ${(row.riseupExpenses - row.dashboardExpenses).toFixed(2)} |`);
  await writeFile(markdown, lines.join('\n') + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ sourceRange: report.sourceRange, comparisonRange: range, counts: report.counts, output, markdown }, null, 2));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());