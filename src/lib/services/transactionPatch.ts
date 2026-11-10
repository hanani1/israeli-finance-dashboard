/**
 * Validation for PATCH /api/transactions/[id] (pure, unit-tested).
 *
 * The body is JSON with any of:
 *  - `categoryId`: integer or null — manual categorization (existing contract);
 *  - `isRefund`: boolean — the user's semantic same-sign refund override
 *    (card #60, ADR-0024).
 */
import { money, type MoneyInput } from './money';

export class TransactionPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionPatchError';
  }
}

export interface TransactionPatch {
  categoryId?: number | null;
  isRefund?: boolean;
}

export function parseTransactionPatch(body: unknown): TransactionPatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TransactionPatchError('Body must be a JSON object');
  }
  const input = body as Record<string, unknown>;
  const patch: TransactionPatch = {};
  if ('categoryId' in input) {
    const value = input.categoryId;
    if (value !== null && !Number.isInteger(value)) {
      throw new TransactionPatchError('categoryId must be an integer or null');
    }
    patch.categoryId = value as number | null;
  }
  if ('isRefund' in input) {
    if (typeof input.isRefund !== 'boolean') {
      throw new TransactionPatchError('isRefund must be a boolean');
    }
    patch.isRefund = input.isRefund;
  }
  if (patch.categoryId === undefined && patch.isRefund === undefined) {
    throw new TransactionPatchError('Body must include "categoryId" and/or "isRefund"');
  }
  return patch;
}

export interface RefundToggleTarget {
  chargedAmount: MoneyInput;
  isTransfer: boolean;
  isCardSettlement: boolean;
}

/**
 * Marking is only allowed on a visible negative row: a positive refund is
 * already handled by sign (it reduces expenses), transfers are neither income
 * nor expense, and hidden settlement / pending snapshots are not counted at
 * all. Unmarking is always allowed (it restores the raw-sign default).
 */
export function assertRefundToggleAllowed(target: RefundToggleTarget, isRefund: boolean): void {
  if (!isRefund) return;
  if (!money(target.chargedAmount).lt(0)) {
    throw new TransactionPatchError(
      'Only a negative (same-sign) row can be marked as a refund; positive refunds already reduce expenses',
    );
  }
  if (target.isTransfer) {
    throw new TransactionPatchError('A transfer cannot be marked as a refund');
  }
  if (target.isCardSettlement) {
    throw new TransactionPatchError('A hidden settlement/pending snapshot cannot be marked as a refund');
  }
}
