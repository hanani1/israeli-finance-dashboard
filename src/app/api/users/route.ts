import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { listUsers } from '@/lib/services/transactionService';
import { createUser } from '@/lib/services/userService';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (): Promise<NextResponse> => {
  const users = await listUsers();
  return NextResponse.json(users);
});

interface PostBody {
  name: string;
  email?: string;
}

export const POST = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const body = (await request.json()) as PostBody;

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  // A duplicate email is a P2002 -> 409 (withRouteErrors).
  const user = await createUser(body.name, body.email);
  return NextResponse.json(user, { status: 201 });
});
