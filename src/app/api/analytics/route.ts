import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import {
  getExpenseBreakdown,
  getSpendingTrend,
  getSummaryTotals,
} from '@/lib/services/analyticsService';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const params = request.nextUrl.searchParams;
  const filters = {
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    userId: params.get('userId') ?? undefined,
  };
  const granularity = params.get('granularity') === 'month' ? 'month' : 'day';
  const trendCategoryId = params.get('trendCategoryId');

  // The category filter applies only to the trend chart; summary + breakdown
  // stay across all categories.
  const trendFilters = {
    ...filters,
    categoryId: trendCategoryId ? Number(trendCategoryId) : undefined,
  };

  const [totals, breakdown, trend] = await Promise.all([
    getSummaryTotals(filters),
    getExpenseBreakdown(filters),
    getSpendingTrend(trendFilters, granularity),
  ]);

  return NextResponse.json({ totals, breakdown, trend });
});
