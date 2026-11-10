/**
 * Analytics service layer — aggregations that power the dashboard charts.
 *
 * Convention: scraped expenses have negative chargedAmount, income positive.
 * All aggregates are returned as positive numbers with an explicit sign
 * convention documented per field.
 *
 * Money (card #53): Prisma returns DECIMAL sums as Prisma.Decimal; every sum
 * and comparison here stays Decimal, and the returned interfaces are the
 * JSON DTOs — converted with moneyToNumber when they are built.
 */
import { CategoryGroup, CategoryType, Prisma } from '@prisma/client';
import { classifyFlow, summarizeFlows } from './flowClassification';
import { prisma } from '@/lib/db';
import { resolveMonthWindow } from '@/lib/services/budgetPacing';
import { DEFAULT_CURRENCY } from '@/lib/services/currencyDisplay';
import {
  ZERO_MONEY,
  divideMoney,
  moneyToNumber,
  sumMoney,
  type Decimal,
} from '@/lib/services/money';
import { localCalendarDay, localCalendarMonth, localDateRange } from '@/lib/services/localDay';
import {
  AVG6_MONTH_COUNT,
  effectiveFlowMonthWhere,
  previousSixFlowMonths,
} from '@/lib/services/flowMonth';

export interface AnalyticsFilters {
  from?: string; // yyyy-MM-dd
  to?: string; // yyyy-MM-dd
  userId?: string;
  /** Restrict to a single category (used by the trend chart's category filter). */
  categoryId?: number;
}

export interface CategoryBreakdownSlice {
  categoryId: number | null;
  name: string;
  color: string;
  total: number; // positive ILS amount spent
}

export interface TrendPoint {
  period: string; // yyyy-MM-dd (day) or yyyy-MM (month)
  expenses: number; // positive
  income: number; // positive
}

export interface SummaryTotals {
  income: number;
  expenses: number;
  net: number;
}

/**
 * from/to are provider days (yyyy-MM-dd); the stored `date` is an instant
 * at Israel-local midnight, so the window is built on Israeli day boundaries
 * (a UTC window pushed every 1st-of-month row into the previous month).
 */
function dateRange(filters: AnalyticsFilters): { gte?: Date; lt?: Date } {
  return localDateRange(filters.from, filters.to);
}

function baseWhere(filters: AnalyticsFilters): Prisma.TransactionWhereInput {
  // Inter-account transfers and investment deposits/withdrawals are neither
  // income nor expense — always excluded. The INVESTMENT exclusion lives in
  // AND so callers that spread baseWhere and add their own OR don't clobber
  // it; uncategorized rows (categoryId null) are kept.
  //
  // Currency: every aggregate in this module is an ILS figure, so only rows
  // settled in ILS participate. Foreign-settled rows (chargedCurrency != ILS)
  // must never be added into an ILS total — they stay visible per-transaction
  // in the transactions views, formatted in their own currency.
  const where: Prisma.TransactionWhereInput = {
    date: dateRange(filters),
    isTransfer: false,
    // Covered card settlements / obsolete pending revisions duplicate card
    // spending that is already counted — excluded from every aggregation.
    isCardSettlement: false,
    chargedCurrency: DEFAULT_CURRENCY,
    AND: [
      {
        OR: [
          { categoryId: null },
          { category: { group: { not: CategoryGroup.INVESTMENT } } },
        ],
      },
    ],
  };
  if (filters.userId) {
    where.account = { userId: filters.userId };
  }
  if (filters.categoryId !== undefined) {
    where.categoryId = filters.categoryId;
  }
  return where;
}

/** Expense totals grouped by category, for the pie chart. */
export async function getExpenseBreakdown(
  filters: AnalyticsFilters,
): Promise<CategoryBreakdownSlice[]> {
  const grouped = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: {
      ...baseWhere(filters),
      chargedAmount: { lt: 0 },
      // isRefund rows are +|amount| income (ADR-0024), never spend.
      isRefund: false,
      OR: [{ category: { type: CategoryType.EXPENSE } }, { categoryId: null }],
    },
    _sum: { chargedAmount: true },
  });

  const categories = await prisma.category.findMany();
  const byId = new Map(categories.map((c) => [c.id, c]));

  return grouped
    .map((row) => {
      const category = row.categoryId !== null ? byId.get(row.categoryId) : undefined;
      return {
        categoryId: row.categoryId,
        name: category?.name ?? 'Uncategorized',
        color: category?.color ?? '#94a3b8',
        total: moneyToNumber(sumMoney([row._sum.chargedAmount]).abs()),
      };
    })
    .filter((slice) => slice.total > 0)
    .sort((a, b) => b.total - a.total);
}

/**
 * Income / expense totals for the summary cards.
 *
 * Uses the same classification as the monthly breakdown (flowClassification):
 * income is a positive INCOME-category amount; a positive uncategorized or
 * expense-category amount is a refund that reduces expenses. Previously every
 * positive row counted as income, which made the summary disagree with the
 * breakdown (and RiseUp) by exactly the refunds — e.g. a ₪28.95 store credit.
 * Same-sign refunds marked isRefund are +|amount| income (grouped separately
 * so their sums classify as income, see flowClassification).
 */
export async function getSummaryTotals(filters: AnalyticsFilters): Promise<SummaryTotals> {
  const where = baseWhere(filters);
  const [grouped, categories] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['categoryId', 'isRefund'],
      where,
      _sum: { chargedAmount: true },
    }),
    prisma.category.findMany({ select: { id: true, group: true } }),
  ]);
  const groupById = new Map(categories.map((c) => [c.id, c.group]));
  return summarizeFlows(
    grouped.map((row) => ({
      chargedAmount: row._sum.chargedAmount ?? ZERO_MONEY,
      group: row.categoryId === null ? null : (groupById.get(row.categoryId) ?? null),
      isRefund: row.isRefund,
    })),
  );
}

export interface BreakdownCategory {
  categoryId: number;
  name: string;
  color: string;
  total: number; // positive amount (expense spend, or income received)
  avg6: number; // avg monthly amount over the 6 months preceding the selected month
}

export interface BreakdownGroup {
  group: CategoryGroup;
  total: number;
  categories: BreakdownCategory[];
}

export interface MonthlyBreakdown {
  month: string; // yyyy-MM
  groups: BreakdownGroup[]; // ordered: variable expense, recurring expense, income
  uncategorized: { total: number; count: number };
  /** Same-sign refunds marked isRefund: +|amount| income (ADR-0024). */
  refunds: { total: number; count: number };
  totalIncome: number; // INCOME-group categories + refunds
  totalExpense: number; // variable + recurring + uncategorized spend
  net: number; // totalIncome - totalExpense
}

/**
 * Where-clause shared by the selected month and its trailing 6-month average:
 * the effective flow-month predicate (flowMonth.ts, shared with budgets and
 * the monthly transaction list) plus the cash-flow exclusions.
 */
export function monthlyBreakdownWhere(
  labels: readonly string[],
  options: { userId?: string },
): Prisma.TransactionWhereInput {
  return {
    AND: [effectiveFlowMonthWhere(labels)],
    isTransfer: false,
    isCardSettlement: false,
    // ILS totals only — never fold foreign-settled rows into ILS sums.
    chargedCurrency: DEFAULT_CURRENCY,
    ...(options.userId ? { account: { userId: options.userId } } : {}),
  };
}

/**
 * Per-category totals for one month, grouped by CategoryGroup (variable expense
 * / recurring expense / income). Powers the monthly breakdown tab + its pie.
 * `now` is injectable for tests.
 *
 * Month semantics: both the selected month and the trailing 6-month average
 * use the *effective flow month* (stored RiseUp flowMonth, calendar-month
 * fallback), so totals align with RiseUp — e.g. a rent check dated Jan 31
 * that RiseUp assigns to February counts in February.
 */
export async function getMonthlyBreakdown(
  options: { month?: string; userId?: string },
  now: Date = new Date(),
): Promise<MonthlyBreakdown> {
  const window = resolveMonthWindow(options.month, now);

  const grouped = await prisma.transaction.groupBy({
    by: ['categoryId', 'isRefund'],
    where: monthlyBreakdownWhere([window.label], options),
    _sum: { chargedAmount: true },
    _count: true,
  });

  const categories = await prisma.category.findMany();
  const byId = new Map(categories.map((c) => [c.id, c]));

  // Trailing 6-month average per category: exactly the six flow months
  // [selected-6 .. selected-1], divided by 6 (zero months count as zero).
  const priorLabels = previousSixFlowMonths(window.label);
  const priorGrouped = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: {
      ...monthlyBreakdownWhere(priorLabels, options),
      // Per-category spend/income averages exclude flagged refunds (income).
      isRefund: false,
    },
    _sum: { chargedAmount: true },
  });
  const avg6ById = new Map<number, number>();
  for (const row of priorGrouped) {
    if (row.categoryId === null) continue;
    const category = byId.get(row.categoryId);
    if (!category) continue;
    const amount = categoryAmount(category.group, row._sum.chargedAmount);
    // Exact sum / 6, rounded half-up to the agorot.
    avg6ById.set(row.categoryId, moneyToNumber(divideMoney(amount, AVG6_MONTH_COUNT)));
  }

  interface CategoryTotal {
    category: (typeof categories)[number];
    total: Decimal;
  }
  const buckets = new Map<CategoryGroup, CategoryTotal[]>();
  for (const g of Object.values(CategoryGroup)) buckets.set(g, []);
  let uncatTotal = ZERO_MONEY;
  let uncatCount = 0;
  let refundTotal = ZERO_MONEY;
  let refundCount = 0;

  for (const row of grouped) {
    const sum = row._sum.chargedAmount ?? ZERO_MONEY;
    if (row.isRefund) {
      // Same-sign refund: raw negative, semantic +|amount| income in its own
      // line — the purchase stays a full expense in its category (ADR-0024).
      refundTotal = refundTotal.add(classifyFlow(sum, null, true).income);
      refundCount += row._count;
      continue;
    }
    if (row.categoryId === null) {
      // Uncategorized spend; a positive uncategorized row is a refund and
      // reduces it (same policy as the summary cards, see flowClassification).
      uncatTotal = uncatTotal.sub(sum);
      uncatCount += row._count;
      continue;
    }
    const category = byId.get(row.categoryId);
    if (!category) continue;
    const total = categoryAmount(category.group, sum);
    if (!total.gt(0)) continue;
    buckets.get(category.group)?.push({ category, total });
  }

  // INVESTMENT is intentionally absent: deposits/withdrawals to investment
  // houses are neither income nor expense and are excluded from the monthly
  // breakdown (they surface on the /investments page instead).
  const order: CategoryGroup[] = [
    CategoryGroup.VARIABLE_EXPENSE,
    CategoryGroup.RECURRING_EXPENSE,
    CategoryGroup.INCOME,
  ];
  const groupTotals = new Map<CategoryGroup, Decimal>();
  const groups: BreakdownGroup[] = order.map((group) => {
    const cats = (buckets.get(group) ?? []).sort((a, b) => b.total.comparedTo(a.total));
    const total = sumMoney(cats.map((c) => c.total));
    groupTotals.set(group, total);
    return {
      group,
      total: moneyToNumber(total),
      categories: cats.map(({ category, total: categoryTotal }) => ({
        categoryId: category.id,
        name: category.name,
        color: category.color,
        total: moneyToNumber(categoryTotal),
        avg6: avg6ById.get(category.id) ?? 0,
      })),
    };
  });

  const groupTotal = (group: CategoryGroup): Decimal => groupTotals.get(group) ?? ZERO_MONEY;
  const totalIncome = groupTotal(CategoryGroup.INCOME).add(refundTotal);
  // Net expenses include variable + recurring categories AND uncategorized spend.
  const totalExpense = sumMoney([
    groupTotal(CategoryGroup.VARIABLE_EXPENSE),
    groupTotal(CategoryGroup.RECURRING_EXPENSE),
    uncatTotal,
  ]);

  return {
    month: window.label,
    groups,
    uncategorized: { total: moneyToNumber(uncatTotal), count: uncatCount },
    refunds: { total: moneyToNumber(refundTotal), count: refundCount },
    totalIncome: moneyToNumber(totalIncome),
    totalExpense: moneyToNumber(totalExpense),
    net: moneyToNumber(totalIncome.sub(totalExpense)),
  };
}

/**
 * A category's positive breakdown amount from its signed sum: income received
 * for INCOME-group categories, spend for expense groups; zero when the sum
 * points the other way (net refunds / clawbacks).
 */
function categoryAmount(group: CategoryGroup, sum: Decimal | null): Decimal {
  const value = sum ?? ZERO_MONEY;
  if (group === CategoryGroup.INCOME) return value.gt(0) ? value : ZERO_MONEY;
  return value.lt(0) ? value.neg() : ZERO_MONEY;
}

/** Spending/income trend bucketed by day or month, for the line chart. */
export async function getSpendingTrend(
  filters: AnalyticsFilters,
  granularity: 'day' | 'month',
): Promise<TrendPoint[]> {
  const transactions = await prisma.transaction.findMany({
    where: baseWhere(filters),
    select: {
      date: true,
      chargedAmount: true,
      isRefund: true,
      category: { select: { group: true } },
    },
    orderBy: { date: 'asc' },
  });

  const buckets = new Map<string, { period: string; expenses: Decimal; income: Decimal }>();
  for (const txn of transactions) {
    const period =
      granularity === 'day' ? localCalendarDay(txn.date) : localCalendarMonth(txn.date);
    const bucket = buckets.get(period) ?? { period, expenses: ZERO_MONEY, income: ZERO_MONEY };
    const flow = classifyFlow(txn.chargedAmount, txn.category?.group ?? null, txn.isRefund);
    bucket.expenses = bucket.expenses.add(flow.expense);
    bucket.income = bucket.income.add(flow.income);
    buckets.set(period, bucket);
  }

  return Array.from(buckets.values()).map((point) => ({
    period: point.period,
    expenses: moneyToNumber(point.expenses),
    income: moneyToNumber(point.income),
  }));
}
