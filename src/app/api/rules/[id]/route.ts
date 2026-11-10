import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { deleteRule } from '@/lib/services/ruleEngine';

export const dynamic = 'force-dynamic';

export const DELETE = withRouteErrors(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await params;
  const ruleId = Number.parseInt(id, 10);
  if (!Number.isInteger(ruleId)) {
    return NextResponse.json({ error: 'Invalid rule id' }, { status: 400 });
  }
  await deleteRule(ruleId);
  return NextResponse.json({ ok: true });
});
