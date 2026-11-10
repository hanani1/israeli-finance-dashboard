import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { listAccountBalances } from '@/lib/services/accountService';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const userId = request.nextUrl.searchParams.get('userId') ?? undefined;
  const result = await listAccountBalances({ userId });
  return NextResponse.json(result);
});
