import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { listTransactions, serializeTransaction } from '@/lib/services/transactionService';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const params = request.nextUrl.searchParams;
  const transactions = await listTransactions({
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    flowMonth: params.get('flowMonth') ?? undefined,
    userId: params.get('userId') ?? undefined,
    search: params.get('search') ?? undefined,
    uncategorizedOnly: params.get('uncategorizedOnly') === 'true',
    needsReview: params.get('needsReview') === 'true',
  });
  return NextResponse.json(transactions.map(serializeTransaction));
});
