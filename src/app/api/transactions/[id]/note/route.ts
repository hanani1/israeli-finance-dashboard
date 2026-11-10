import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { NoteValidationError } from '@/lib/services/transactionNote';
import { setTransactionNote, TransactionNotFoundError } from '@/lib/services/transactionService';

export const dynamic = 'force-dynamic';

interface PutBody {
  note?: string | null;
}

/** Set (non-empty string) or clear (null / empty) the note on a transaction. */
export const PUT = withRouteErrors(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await params;
  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (body === null || typeof body !== 'object' || !('note' in body)) {
    return NextResponse.json({ error: 'Body must include "note" (string or null)' }, { status: 400 });
  }
  try {
    const result = await setTransactionNote(id, body.note ?? null);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof NoteValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TransactionNotFoundError) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }
    throw error;
  }
});

export const DELETE = withRouteErrors(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await params;
  try {
    return NextResponse.json(await setTransactionNote(id, null));
  } catch (error) {
    if (error instanceof TransactionNotFoundError) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }
    throw error;
  }
});
