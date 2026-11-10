import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TransactionPatchError,
  assertRefundToggleAllowed,
  parseTransactionPatch,
} from './transactionPatch';

test('parseTransactionPatch keeps the existing categoryId contract', () => {
  assert.deepEqual(parseTransactionPatch({ categoryId: 7 }), { categoryId: 7 });
  assert.deepEqual(parseTransactionPatch({ categoryId: null }), { categoryId: null });
  assert.throws(() => parseTransactionPatch({ categoryId: 'x' }), TransactionPatchError);
  assert.throws(() => parseTransactionPatch({ categoryId: 1.5 }), TransactionPatchError);
});

test('parseTransactionPatch accepts a boolean isRefund toggle (card #60)', () => {
  assert.deepEqual(parseTransactionPatch({ isRefund: true }), { isRefund: true });
  assert.deepEqual(parseTransactionPatch({ isRefund: false }), { isRefund: false });
  assert.deepEqual(parseTransactionPatch({ categoryId: 3, isRefund: true }), { categoryId: 3, isRefund: true });
  assert.throws(() => parseTransactionPatch({ isRefund: 'true' }), TransactionPatchError);
  assert.throws(() => parseTransactionPatch({ isRefund: 1 }), TransactionPatchError);
});

test('parseTransactionPatch rejects empty and non-object bodies', () => {
  assert.throws(() => parseTransactionPatch({}), TransactionPatchError);
  assert.throws(() => parseTransactionPatch(null), TransactionPatchError);
  assert.throws(() => parseTransactionPatch([]), TransactionPatchError);
  assert.throws(() => parseTransactionPatch('isRefund'), TransactionPatchError);
});

const visibleNegative = { chargedAmount: -125, isTransfer: false, isCardSettlement: false };

test('a visible negative row (Pasta Bar reversal) can be marked as a refund', () => {
  assert.doesNotThrow(() => assertRefundToggleAllowed(visibleNegative, true));
});

test('positive rows, transfers and hidden snapshots cannot be marked; unmarking is always allowed', () => {
  assert.throws(() => assertRefundToggleAllowed({ ...visibleNegative, chargedAmount: 850 }, true), TransactionPatchError);
  assert.throws(() => assertRefundToggleAllowed({ ...visibleNegative, chargedAmount: 0 }, true), TransactionPatchError);
  assert.throws(() => assertRefundToggleAllowed({ ...visibleNegative, isTransfer: true }, true), TransactionPatchError);
  assert.throws(() => assertRefundToggleAllowed({ ...visibleNegative, isCardSettlement: true }, true), TransactionPatchError);
  assert.doesNotThrow(() => assertRefundToggleAllowed({ ...visibleNegative, chargedAmount: 850 }, false));
});
