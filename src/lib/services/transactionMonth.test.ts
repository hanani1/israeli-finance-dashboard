import test from 'node:test';
import assert from 'node:assert/strict';
import { monthDateRange } from './transactionMonth';

test('builds an inclusive calendar range for a selected month', () => {
  assert.deepEqual(monthDateRange('2026-02'), {
    from: '2026-02-01',
    to: '2026-02-28',
  });
});

test('handles leap years', () => {
  assert.deepEqual(monthDateRange('2028-02'), {
    from: '2028-02-01',
    to: '2028-02-29',
  });
});

test('rejects malformed month values', () => {
  assert.throws(() => monthDateRange('2026-2'), /Invalid month/);
});
