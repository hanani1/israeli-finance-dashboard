import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { deleteCredential } from '@/lib/services/credentialService';

export const dynamic = 'force-dynamic';

export const DELETE = withRouteErrors(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await params;
  await deleteCredential(id);
  return NextResponse.json({ ok: true });
});
