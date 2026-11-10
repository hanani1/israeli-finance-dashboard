import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { TransactionPatchError, parseTransactionPatch } from '@/lib/services/transactionPatch';
import {
  TransactionNotFoundError,
  serializeTransaction,
  setTransactionCategory,
  setTransactionRefund,
} from '@/lib/services/transactionService';

export const dynamic = 'force-dynamic';

/**
 * JSON body with `categoryId` (integer | null, manual categorization) and/or
 * `isRefund` (boolean, semantic same-sign refund — card #60, ADR-0024).
 */
export const PATCH = withRouteErrors(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const patch = parseTransactionPatch(body);
    // Validate/apply the refund flag first so a rejected toggle leaves the
    // category untouched too.
    let transaction =
      patch.isRefund !== undefined ? await setTransactionRefund(id, patch.isRefund) : null;
    if (patch.categoryId !== undefined) {
      transaction = await setTransactionCategory(id, patch.categoryId);
    }
    return NextResponse.json(transaction ? serializeTransaction(transaction) : null);
  } catch (error) {
    if (error instanceof TransactionPatchError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TransactionNotFoundError) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }
    throw error;
  }
});
