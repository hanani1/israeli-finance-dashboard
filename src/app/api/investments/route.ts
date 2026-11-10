import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { getInvestmentsOverview } from '@/lib/services/investmentService';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const params = request.nextUrl.searchParams;
  const result = await getInvestmentsOverview({
    userId: params.get('userId') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
  });
  return NextResponse.json(result);
});
