import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { findSimilarTransactions } from '@/lib/services/similarTransactionsService';

export const dynamic = 'force-dynamic';

/**
 * GET /api/transactions/:id/similar?limit=&offset=
 *
 * The endpoint accepts only the source transaction id — the transaction is
 * loaded server-side and matching is computed from its stored description, so
 * no client-supplied merchant strings ever reach the matcher or the DB query.
 * Pagination is clamped server-side to bounded values.
 */
export const GET = withRouteErrors(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await params;
  if (!id || id.length > 200) {
    return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
  }

  const searchParams = request.nextUrl.searchParams;
  const result = await findSimilarTransactions(id, {
    limit: searchParams.get('limit'),
    offset: searchParams.get('offset'),
  });

  if (!result) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  }
  return NextResponse.json(result);
});
