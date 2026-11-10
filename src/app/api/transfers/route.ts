import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { listTransferPairs } from '@/lib/services/transferService';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const params = request.nextUrl.searchParams;
  const result = await listTransferPairs({
    userId: params.get('userId') ?? undefined,
  });
  return NextResponse.json(result);
});
