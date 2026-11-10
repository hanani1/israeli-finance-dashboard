import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import {
  getBudgetPacing,
  listBudgetableCategories,
  upsertBudget,
} from '@/lib/services/budgetService';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const params = request.nextUrl.searchParams;
  const month = params.get('month') ?? undefined;
  const userId = params.get('userId') ?? undefined;

  const [pacing, budgetableCategories] = await Promise.all([
    getBudgetPacing({ month, userId }),
    listBudgetableCategories(),
  ]);

  return NextResponse.json({ ...pacing, budgetableCategories });
});

interface PostBody {
  categoryId: number;
  amount: number;
}

export const POST = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const body = (await request.json()) as PostBody;
  // Validation failures are RequestError(400) with their explicit message;
  // an unknown categoryId is a P2003 -> 409 (withRouteErrors).
  const metadata = await upsertBudget(body);
  return NextResponse.json(metadata, { status: 201 });
});
