import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { deleteBudget } from '@/lib/services/budgetService';

export const dynamic = 'force-dynamic';

export const DELETE = withRouteErrors(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await params;
  const budgetId = Number(id);

  if (!Number.isInteger(budgetId)) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }

  await deleteBudget(budgetId);
  return NextResponse.json({ ok: true });
});
