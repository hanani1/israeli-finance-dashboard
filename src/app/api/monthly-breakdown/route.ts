import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { getMonthlyBreakdown } from '@/lib/services/analyticsService';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const params = request.nextUrl.searchParams;
  const breakdown = await getMonthlyBreakdown({
    month: params.get('month') ?? undefined,
    userId: params.get('userId') ?? undefined,
  });
  return NextResponse.json(breakdown);
});
