import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isracardRawDropReason } from './isracardCompleteness';

// Shapes observed in the 2026-10-09 bounded probe of CardsTransactionsList.

test('isracardRawDropReason: billing-total summary rows are dropped', () => {
  assert.equal(
    isracardRawDropReason({ dealSumType: '1', voucherNumberRatz: '000000000', fullSupplierNameHeb: 'סך חיוב בש"ח: 17255.61' }),
    'dealSumType=1',
  );
});

test('isracardRawDropReason: abroad-group placeholder rows without a voucher are dropped', () => {
  assert.equal(isracardRawDropReason({ voucherNumberRatzOutbound: '000000000' }), 'no-voucher-outbound');
  assert.equal(isracardRawDropReason({ voucherNumberRatz: '000000000' }), 'no-voucher');
});

test('isracardRawDropReason: ordinary purchases (a hotel stay) are kept', () => {
  assert.equal(
    isracardRawDropReason({ dealSumType: null, voucherNumberRatz: '271234567', fullSupplierNameHeb: 'מלון לדוגמה', dealSum: '1242.00' }),
    null,
  );
});
