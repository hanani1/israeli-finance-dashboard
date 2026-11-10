import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { Prisma } from '@prisma/client';
import { isValidCategoryColor, updateCategoryColor } from '@/lib/services/categoryService';

export const dynamic = 'force-dynamic';

interface PatchBody {
  color?: unknown;
}

/** Update editable category attributes. Currently supports { color }. */
export const PATCH = withRouteErrors(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await params;
  const categoryId = Number(id);
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return NextResponse.json({ error: 'id must be a positive integer' }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isValidCategoryColor(body.color)) {
    return NextResponse.json(
      { error: 'color must be a hex CSS color like #22C55E' },
      { status: 400 },
    );
  }

  try {
    const category = await updateCategoryColor(categoryId, body.color);
    return NextResponse.json(category);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return NextResponse.json({ error: 'Category not found' }, { status: 404 });
    }
    throw error;
  }
});
