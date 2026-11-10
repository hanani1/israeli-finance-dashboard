import assert from 'node:assert/strict';
import test from 'node:test';
import { transactionMemoText } from './transactionMemo';

test('returns a trimmed provider memo for display', () => {
  assert.equal(transactionMemoText('  העברה לדני לוי  '), 'העברה לדני לוי');
});

test('returns null when the provider memo is empty', () => {
  assert.equal(transactionMemoText('   '), null);
  assert.equal(transactionMemoText(null), null);
  assert.equal(transactionMemoText(undefined), null);
});
