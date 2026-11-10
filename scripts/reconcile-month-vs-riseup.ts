/**
 * Safety class: READ-ONLY (database); writes a Markdown report file.
 *
 * Read-only reconciliation of one month's dashboard totals against RiseUp.
 *
 *   npx tsx scripts/reconcile-month-vs-riseup.ts --month=2026-09 \
 *     --riseup-income=40562 --riseup-expenses=63344 \
 *     [--output=docs/reconciliation-2026-09-riseup.md]
 *
 * Starts from the totals the dashboard computed BEFORE the fixes shipped with
 * this script (UTC month window, strict 'ILS' currency, no pending→settled
 * supersession) and applies one correction layer at a time, printing each
 * layer's effect and the rows it adds or removes, so every shekel of the
 * RiseUp delta is attributed to a cause. Nothing is written to the database.
 */
import { writeFile } from 'node:fs/promises';
import { CategoryGroup } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { isPendingSnapshotDescription } from '../src/lib/services/cardSettlementDetection';
import { classifyFlow } from '../src/lib/services/flowClassification';
import { flowMonthEnd, flowMonthStart } from '../src/lib/services/flowMonth';
import { localCalendarDay } from '../src/lib/services/localDay';
import {
  ZERO_MONEY,
  moneyToNumber,
  sumMoney,
  toAgorot,
  type Decimal,
  type MoneyInput,
} from '../src/lib/services/money';
import {
  detectSupersededPendingRows,
  normalizeCurrencyCode,
} from '../src/lib/services/pendingSettlement';
import { detectSameSignRefundCandidates } from '../src/lib/services/refundCandidates';

type Row = {
  id: string;
  accountId: string;
  account: string;
  kind: string;
  txnIdentifier: string | null;
  date: Date;
  processedDate: Date | null;
  chargedAmount: Decimal;
  chargedCurrency: string;
  originalAmount: Decimal | null;
  originalCurrency: string | null;
  description: string;
  memo: string | null;
  createdAt: Date;
  isTransfer: boolean;
  isCardSettlement: boolean;
  /** Same-sign refund marked by the user/reconciliation (ADR-0024). */
  isRefund: boolean;
  categoryName: string | null;
  group: CategoryGroup | null;
};

type Totals = { rows: number; income: number; expenses: number; net: number; riseupIncome: number; riseupExpenses: number };

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** Report output is a display boundary (card #53). */
function fmt(v: MoneyInput): string {
  return moneyToNumber(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function sum(rows: readonly Row[], f: (r: Row) => Decimal): Decimal {
  return sumMoney(rows.map(f));
}

/** Dashboard convention (flowClassification) and RiseUp convention (sign only). */
function totals(rows: readonly Row[]): Totals {
  let income = ZERO_MONEY;
  let expenses = ZERO_MONEY;
  for (const r of rows) {
    const flow = classifyFlow(r.chargedAmount, r.group, r.isRefund);
    income = income.add(flow.income);
    expenses = expenses.add(flow.expense);
  }
  return {
    rows: rows.length,
    income: moneyToNumber(income),
    expenses: moneyToNumber(expenses),
    net: moneyToNumber(income.sub(expenses)),
    riseupIncome: moneyToNumber(sum(rows, (r) => (r.chargedAmount.gt(0) ? r.chargedAmount : ZERO_MONEY))),
    riseupExpenses: moneyToNumber(sum(rows, (r) => (r.chargedAmount.lt(0) ? r.chargedAmount.neg() : ZERO_MONEY))),
  };
}

function rowLine(r: Row, extra = ''): string {
  const id = r.txnIdentifier ?? '—';
  const pd = r.processedDate ? localCalendarDay(r.processedDate) : '—';
  const desc = r.description.replace(/\|/g, '/').trim() || '(empty)';
  return `| ${localCalendarDay(r.date)} | ${pd} | ${r.account} | ${fmt(r.chargedAmount)} | ${r.chargedCurrency} | ${r.originalAmount ?? ''} | ${id} | ${desc} | ${r.categoryName ?? '—'} | ${r.createdAt.toISOString().slice(0, 10)} | ${r.id.slice(0, 8)}${extra} |`;
}
const ROW_HEADER = [
  '| Date | Processed | Account | Charged | Cur | Original | Provider id | Description | Category | Created | Row |',
  '|---|---|---|---:|---|---:|---|---|---|---|---|',
];

function layerTable(title: string, before: Totals, after: Totals): string[] {
  return [
    `### ${title}`,
    '',
    '| | Rows | Income (dashboard) | Expenses (dashboard) | Net | Income (sign) | Expenses (sign) |',
    '|---|---:|---:|---:|---:|---:|---:|',
    `| Before | ${before.rows} | ${fmt(before.income)} | ${fmt(before.expenses)} | ${fmt(before.net)} | ${fmt(before.riseupIncome)} | ${fmt(before.riseupExpenses)} |`,
    `| After | ${after.rows} | ${fmt(after.income)} | ${fmt(after.expenses)} | ${fmt(after.net)} | ${fmt(after.riseupIncome)} | ${fmt(after.riseupExpenses)} |`,
    `| Effect | ${after.rows - before.rows} | ${fmt(after.income - before.income)} | ${fmt(after.expenses - before.expenses)} | ${fmt(after.net - before.net)} | ${fmt(after.riseupIncome - before.riseupIncome)} | ${fmt(after.riseupExpenses - before.riseupExpenses)} |`,
    '',
  ];
}

async function main(): Promise<void> {
  const month = arg('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Usage: --month=yyyy-MM --riseup-income=N --riseup-expenses=N [--output=path.md]');
  const riseupIncome = Number(arg('riseup-income'));
  const riseupExpenses = Number(arg('riseup-expenses'));
  if (!Number.isFinite(riseupIncome) || !Number.isFinite(riseupExpenses)) throw new Error('--riseup-income and --riseup-expenses are required numbers');
  const output = arg('output') ?? `docs/reconciliation-${month}-riseup.md`;

  const [y = 0, m = 1] = month.split('-').map(Number);
  const utcStart = new Date(Date.UTC(y, m - 1, 1));
  const utcEnd = new Date(Date.UTC(y, m, 1));
  const localStart = flowMonthStart(month);
  const localEnd = flowMonthEnd(month);
  const pad = 5 * 86_400_000;

  const raw = await prisma.transaction.findMany({
    where: { date: { gte: new Date(Math.min(utcStart.getTime(), localStart.getTime()) - pad), lt: new Date(Math.max(utcEnd.getTime(), localEnd.getTime()) + pad) } },
    include: { account: { select: { provider: true, accountNumber: true, kind: true } }, category: { select: { name: true, group: true } } },
    orderBy: [{ date: 'asc' }, { chargedAmount: 'asc' }],
  });
  const all: Row[] = raw.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    account: `${t.account.provider} •${t.account.accountNumber.slice(-4)}`,
    kind: t.account.kind,
    txnIdentifier: t.txnIdentifier,
    date: t.date,
    processedDate: t.processedDate,
    chargedAmount: t.chargedAmount,
    chargedCurrency: t.chargedCurrency,
    originalAmount: t.originalAmount,
    originalCurrency: t.originalCurrency,
    description: t.description,
    memo: t.memo,
    createdAt: t.createdAt,
    isTransfer: t.isTransfer,
    isCardSettlement: t.isCardSettlement,
    isRefund: t.isRefund,
    categoryName: t.category?.name ?? null,
    group: t.category?.group ?? null,
  }));

  const visible = (r: Row): boolean => !r.isTransfer && !r.isCardSettlement && r.group !== CategoryGroup.INVESTMENT;
  const inUtc = (r: Row): boolean => r.date >= utcStart && r.date < utcEnd;
  const inLocal = (r: Row): boolean => r.date >= localStart && r.date < localEnd;
  const strictIls = (r: Row): boolean => r.chargedCurrency === 'ILS';
  const anyIls = (r: Row): boolean => normalizeCurrencyCode(r.chargedCurrency) === 'ILS';

  // L0: the dashboard before this change.
  const l0 = all.filter((r) => visible(r) && inUtc(r) && strictIls(r));
  // L1: Israeli day boundaries.
  const l1 = all.filter((r) => visible(r) && inLocal(r) && strictIls(r));
  const movedIn = l1.filter((r) => !inUtc(r));
  const movedOut = l0.filter((r) => !inLocal(r));
  // L2: ₪-coded rows are ILS.
  const l2 = all.filter((r) => visible(r) && inLocal(r) && anyIls(r));
  const addedCurrency = l2.filter((r) => !strictIls(r));
  // L3: pending → settled supersession (evaluated over the padded window so twins just outside the month count).
  const candidates = all.filter((r) => visible(r) && anyIls(r));
  const matches = detectSupersededPendingRows(candidates);
  const supersededIds = new Map(matches.map((mt) => [mt.pendingId, mt] as const));
  const byId = new Map(all.map((r) => [r.id, r]));
  const l3 = l2.filter((r) => !supersededIds.has(r.id));
  const removedPending = l2.filter((r) => supersededIds.has(r.id));
  // L4: visible pending card-charge forecast snapshots.
  const l4 = l3.filter((r) => !isPendingSnapshotDescription(r.description));
  const removedForecast = l3.filter((r) => isPendingSnapshotDescription(r.description));

  const t0 = totals(l0), t1 = totals(l1), t2 = totals(l2), t3 = totals(l3), t4 = totals(l4);

  // Ambiguities for human review.
  // Pending snapshots the matcher left visible: Cal rows without an identifier,
  // or Isracard rows with the long pending-style identifier processed on the
  // purchase day. Each is either a purchase still awaiting settlement or an
  // ambiguous case (e.g. a fuel pre-authorization settled for a lower amount).
  const stillPending = l4.filter(
    (r) =>
      r.kind === 'CARD' &&
      !r.chargedAmount.isZero() &&
      (r.txnIdentifier === null ||
        (r.txnIdentifier.length >= 12 && r.processedDate !== null && localCalendarDay(r.processedDate) === localCalendarDay(r.date))),
  );
  const sameAmountSameDay: Array<[Row, Row]> = [];
  for (let i = 0; i < l4.length; i++) {
    for (let j = i + 1; j < l4.length; j++) {
      const a = l4[i]!, b = l4[j]!;
      if (a.accountId === b.accountId && toAgorot(a.chargedAmount) === toAgorot(b.chargedAmount) && a.chargedAmount.lt(0) && localCalendarDay(a.date) === localCalendarDay(b.date)) sameAmountSameDay.push([a, b]);
    }
  }
  const excluded = {
    transfers: all.filter((r) => inLocal(r) && r.isTransfer),
    settlements: all.filter((r) => inLocal(r) && r.isCardSettlement),
    foreign: all.filter((r) => inLocal(r) && visible(r) && !anyIls(r)),
    investments: all.filter((r) => inLocal(r) && r.group === CategoryGroup.INVESTMENT),
  };

  const byCategory = new Map<string, { group: string; n: number; sum: Decimal }>();
  for (const r of l4) {
    const key = r.categoryName ?? '(uncategorized)';
    const e = byCategory.get(key) ?? { group: r.group ?? '—', n: 0, sum: ZERO_MONEY };
    e.n += 1; e.sum = e.sum.add(r.chargedAmount);
    byCategory.set(key, e);
  }

  const ruleCounts = new Map<string, { n: number; sum: Decimal }>();
  for (const r of removedPending) {
    const rule = supersededIds.get(r.id)!.rule;
    const e = ruleCounts.get(rule) ?? { n: 0, sum: ZERO_MONEY };
    e.n += 1; e.sum = e.sum.add(r.chargedAmount);
    ruleCounts.set(rule, e);
  }

  const L: string[] = [];
  L.push(`# Reconciliation ${month}: dashboard vs RiseUp`, '', `Generated ${new Date().toISOString()} from database \`${(process.env.DATABASE_URL ?? '').replace(/\/\/.*@/, '//***@')}\`. Read-only.`, '');
  L.push('## Headline', '', '| | Income | Expenses | Net |', '|---|---:|---:|---:|');
  L.push(`| RiseUp (screenshot) | ${fmt(riseupIncome)} | ${fmt(riseupExpenses)} | ${fmt(riseupIncome - riseupExpenses)} |`);
  L.push(`| Dashboard before fixes (L0) | ${fmt(t0.income)} | ${fmt(t0.expenses)} | ${fmt(t0.net)} |`);
  L.push(`| Delta L0 − RiseUp | ${fmt(t0.income - riseupIncome)} | ${fmt(t0.expenses - riseupExpenses)} | ${fmt(t0.net - (riseupIncome - riseupExpenses))} |`);
  L.push(`| Dashboard after all layers, dashboard convention (L4) | ${fmt(t4.income)} | ${fmt(t4.expenses)} | ${fmt(t4.net)} |`);
  L.push(`| Dashboard after all layers, RiseUp sign convention (L4) | ${fmt(t4.riseupIncome)} | ${fmt(t4.riseupExpenses)} | ${fmt(t4.riseupIncome - t4.riseupExpenses)} |`);
  L.push(`| Residual (L4 sign convention − RiseUp) | ${fmt(t4.riseupIncome - riseupIncome)} | ${fmt(t4.riseupExpenses - riseupExpenses)} | ${fmt(t4.riseupIncome - t4.riseupExpenses - (riseupIncome - riseupExpenses))} |`, '');
  L.push('Conventions: the dashboard counts a positive non-income row (refund/reversal) as a reduction of expenses; RiseUp counts every positive row as income. A negative row marked isRefund (same-sign provider refund, ADR-0024) is +|amount| income in the dashboard convention and stays an expense by raw sign in the RiseUp convention. Both are shown so the residual is convention-free.', '');

  L.push('## Layers', '');
  L.push(...layerTable('L1 — Israeli day boundaries instead of UTC (rows dated the 1st at local midnight are stored as 21:00Z/22:00Z the day before)', t0, t1));
  L.push(`Rows pulled INTO ${month} (local ${month}, UTC previous month): ${movedIn.length}, sum ${fmt(sum(movedIn, (r) => r.chargedAmount))}`, '', ...ROW_HEADER, ...movedIn.map((r) => rowLine(r)), '');
  L.push(`Rows pushed OUT of ${month} (UTC ${month}, local next month): ${movedOut.length}, sum ${fmt(sum(movedOut, (r) => r.chargedAmount))}`, '', ...ROW_HEADER, ...movedOut.map((r) => rowLine(r)), '');
  L.push(...layerTable("L2 — rows whose chargedCurrency is the symbol '₪' (Cal settled rows) are ILS and must be aggregated", t1, t2));
  L.push(`Rows added: ${addedCurrency.length}, sum ${fmt(sum(addedCurrency, (r) => r.chargedAmount))} (by account: ${[...new Set(addedCurrency.map((r) => r.account))].join(', ')})`, '');
  L.push(...layerTable('L3 — pending rows superseded by their settled row, and zero-padded identifier twins (pendingSettlement.ts)', t2, t3));
  L.push('| Rule | Rows | Sum |', '|---|---:|---:|', ...[...ruleCounts].map(([k, v]) => `| ${k} | ${v.n} | ${fmt(v.sum)} |`), '');
  L.push(...ROW_HEADER, ...removedPending.map((r) => { const mt = supersededIds.get(r.id)!; const s = byId.get(mt.settledId)!; return rowLine(r, ` ← kept ${s.id.slice(0, 8)} (${s.txnIdentifier ?? '—'}, ${fmt(s.chargedAmount)} ${s.chargedCurrency}, ${mt.rule})`); }), '');
  L.push(...layerTable('L4 — visible pending card-charge forecast snapshot ("חיוב לכרטיס", Discount pending Cal debit; the card purchases are already counted)', t3, t4));
  L.push(...ROW_HEADER, ...removedForecast.map((r) => rowLine(r)), '');

  L.push('## Excluded by design (not in any total)', '', '| Bucket | Rows | Sum |', '|---|---:|---:|');
  for (const [k, rows] of Object.entries(excluded)) L.push(`| ${k} | ${rows.length} | ${fmt(sum(rows, (r) => r.chargedAmount))} |`);
  L.push('', '### Foreign-currency rows in the month (shown per-transaction only)', '', ...ROW_HEADER, ...excluded.foreign.map((r) => rowLine(r)), '');
  L.push('### Transfers', '', ...ROW_HEADER, ...excluded.transfers.map((r) => rowLine(r)), '');

  L.push('## Ambiguous / for review', '');
  L.push(`### Card rows still in pending state with no settled twin (${stillPending.length})`, '', ...ROW_HEADER, ...stillPending.map((r) => rowLine(r)), '');
  L.push(`### Same account, same amount, same day — kept as separate purchases (${sameAmountSameDay.length} pairs)`, '', ...ROW_HEADER, ...sameAmountSameDay.flatMap(([a, b]) => [rowLine(a), rowLine(b)]), '');

  // Same-sign refunds (card #60, ADR-0024): rows already marked count as
  // +|amount| income in L0–L4; unmarked review candidates are listed only.
  const markedRefunds = l4.filter((r) => r.isRefund);
  const l4Ids = new Set(l4.map((r) => r.id));
  const refundCandidates = detectSameSignRefundCandidates(all.filter((r) => visible(r) && anyIls(r)))
    .filter((c) => l4Ids.has(c.refundId));
  L.push(`### Same-sign refunds marked isRefund — counted as +|amount| income (${markedRefunds.length}, raw sum ${fmt(sum(markedRefunds, (r) => r.chargedAmount))})`, '', ...ROW_HEADER, ...markedRefunds.map((r) => rowLine(r)), '');
  L.push(`### Same-sign refund candidates NOT marked (review only; ${refundCandidates.filter((c) => c.confidence === 'ambiguous').length} ambiguous)`, '', ...ROW_HEADER, ...refundCandidates.map((c) => rowLine(byId.get(c.refundId)!, ` ← ${c.confidence} (${c.evidence.join('+')}) original(s) ${c.originalIds.map((id) => id.slice(0, 8)).join(', ')}`)), '');

  L.push('## Final month by category (L4)', '', '| Category | Group | Rows | Sum |', '|---|---|---:|---:|', ...[...byCategory].sort((a, b) => a[1].sum.comparedTo(b[1].sum)).map(([k, v]) => `| ${k} | ${v.group} | ${v.n} | ${fmt(v.sum)} |`), '');

  L.push('## All rows counted in the final total (L4)', '', ...ROW_HEADER, ...l4.map((r) => rowLine(r)), '');

  await writeFile(output, L.join('\n') + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ month, output, riseup: { income: riseupIncome, expenses: riseupExpenses }, L0: t0, L1: t1, L2: t2, L3: t3, L4: t4, supersededMatches: matches.length, refundsMarked: markedRefunds.length, refundCandidates: refundCandidates.length, matchesByRule: Object.fromEntries(ruleCounts) }, null, 2));
}

void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
