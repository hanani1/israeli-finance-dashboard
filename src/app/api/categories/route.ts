import { NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { listCategories } from '@/lib/services/transactionService';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (): Promise<NextResponse> => {
  const categories = await listCategories();
  return NextResponse.json(categories);
});
