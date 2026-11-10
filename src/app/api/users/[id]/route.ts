import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { deleteUser, renameUser } from '@/lib/services/userService';

export const dynamic = 'force-dynamic';

interface PatchBody {
  name: string;
}

export const PATCH = withRouteErrors(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await params;
  const body = (await request.json()) as PatchBody;

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  // Unknown id is a P2025 -> 404 (withRouteErrors).
  const user = await renameUser(id, body.name);
  return NextResponse.json(user);
});

export const DELETE = withRouteErrors(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await params;
  // Guarded delete: a member who still owns credentials/accounts is a
  // RequestError(409) with its explicit message.
  await deleteUser(id);
  return NextResponse.json({ ok: true });
});
