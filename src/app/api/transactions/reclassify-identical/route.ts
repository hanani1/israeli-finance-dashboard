import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { reclassifyIdenticalTransactions } from '@/lib/services/transactionService';

export const dynamic = 'force-dynamic';

interface PostBody {
  description: string;
  categoryId: number;
}

/**
 * Apply a category to ALL transactions sharing the exact same description
 * (marks them MANUAL). Powers the "make this classification permanent" action.
 */
export const POST = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const body = (await request.json()) as PostBody;

  if (typeof body.description !== 'string' || !body.description || !Number.isInteger(body.categoryId)) {
    return NextResponse.json(
      { error: 'description (string) and categoryId (integer) are required' },
      { status: 400 },
    );
  }

  const count = await reclassifyIdenticalTransactions(body.description, body.categoryId);
  return NextResponse.json({ count });
});
