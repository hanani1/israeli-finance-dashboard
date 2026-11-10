/**
 * Investment service layer — DB access for the investments dashboard card and
 * the /investments breakdown page.
 *
 * Transactions in an INVESTMENT-group category (deposits to / withdrawals
 * from investment houses like אלטשולר שחם or מיטב דש) are neither income nor
 * expense — they are excluded from all income/expense aggregations (same
 * treatment as isTransfer rows) and surface only here.
 */
import { CategoryGroup } from '@prisma/client';
import { prisma } from '@/lib/db';
import { localDateRange } from '@/lib/services/localDay';
import {
  buildInvestmentBreakdown,
  type InvestmentBreakdown,
  type MonthlyInvestmentActivity,
} from './investmentAnalysis';

export interface InvestmentsOverview extends InvestmentBreakdown {
  /** Activity in the current calendar month (zeros when none). */
  thisMonth: MonthlyInvestmentActivity;
}

export interface InvestmentFilters {
  userId?: string;
  from?: string; // yyyy-MM-dd (inclusive)
  to?: string; // yyyy-MM-dd (inclusive)
}

function dateRange(filters: InvestmentFilters): { gte?: Date; lt?: Date } | undefined {
  if (!filters.from && !filters.to) return undefined;
  return {
    ...localDateRange(filters.from, filters.to),
  };
}

/**
 * Investments overview honoring the global filters: cumulative totals,
 * per-house and per-month breakdowns within the from/to range (all-time when
 * no range is given), plus the current month's activity.
 * `now` is injectable for tests.
 */
export async function getInvestmentsOverview(
  options: InvestmentFilters = {},
  now: Date = new Date(),
): Promise<InvestmentsOverview> {
  const txns = await prisma.transaction.findMany({
    where: {
      isTransfer: false,
      isCardSettlement: false,
      category: { group: CategoryGroup.INVESTMENT },
      ...(dateRange(options) ? { date: dateRange(options) } : {}),
      ...(options.userId ? { account: { userId: options.userId } } : {}),
    },
    select: { date: true, chargedAmount: true, description: true, memo: true },
    orderBy: { date: 'asc' },
  });

  const breakdown = buildInvestmentBreakdown(txns);
  const currentMonth = now.toISOString().slice(0, 7);
  const thisMonth = breakdown.monthly.find((m) => m.month === currentMonth) ?? {
    month: currentMonth,
    deposits: 0,
    withdrawals: 0,
    net: 0,
  };

  return { ...breakdown, thisMonth };
}
