import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IDENTITY_DATE_WINDOW_DAYS,
  identityDateWindow,
  isSameIdentifiedTransaction,
} from './transactionIdentity';

// Providers report the same transaction with different `date` values over
// time: Isracard emits the purchase time while pending (e.g. 12:43 local) and
// midnight once settled, and some providers correct the posting date by a day.
// The identifier + account + amount + description are stable, so identity must
// tolerate a small date drift instead of requiring the same calendar day.

const base = {
  accountId: 'acc-1',
  txnIdentifier: '500000001',
  chargedAmount: -163.3,
  description: 'ביטוח רכב חובה',
};

test('same identifier one day apart (pending time vs settled midnight) is one transaction', () => {
  assert.equal(
    isSameIdentifiedTransaction(
      { ...base, date: new Date('2026-09-28T12:43:00.000Z') },
      { ...base, date: new Date('2026-09-27T21:00:00.000Z') },
    ),
    true,
  );
});

test('same identifier within the window but different amount or description is distinct', () => {
  assert.equal(
    isSameIdentifiedTransaction(
      { ...base, date: new Date('2026-09-28T00:00:00.000Z') },
      { ...base, chargedAmount: -163.31, date: new Date('2026-09-28T00:00:00.000Z') },
    ),
    false,
  );
  assert.equal(
    isSameIdentifiedTransaction(
      { ...base, date: new Date('2026-09-28T00:00:00.000Z') },
      { ...base, description: 'ביטוח רכב מקיף', date: new Date('2026-09-28T00:00:00.000Z') },
    ),
    false,
  );
});

test('a recurring charge that reuses its identifier a month later is a distinct transaction', () => {
  // Leumi standing orders reuse the same identifier every month.
  assert.equal(
    isSameIdentifiedTransaction(
      { ...base, date: new Date('2026-08-09T00:00:00.000Z') },
      { ...base, date: new Date('2026-09-09T00:00:00.000Z') },
    ),
    false,
  );
});

test('rows without an identifier are never treated as the same identified transaction', () => {
  assert.equal(
    isSameIdentifiedTransaction(
      { ...base, txnIdentifier: null, date: new Date('2026-09-28T00:00:00.000Z') },
      { ...base, txnIdentifier: null, date: new Date('2026-09-28T00:00:00.000Z') },
    ),
    false,
  );
});

test('identity window spans ±N days around the scraped date', () => {
  const { gte, lt } = identityDateWindow(new Date('2026-09-27T21:00:00.000Z'));
  assert.equal(IDENTITY_DATE_WINDOW_DAYS, 3);
  assert.equal(gte.toISOString(), '2026-09-24T00:00:00.000Z');
  assert.equal(lt.toISOString(), '2026-10-01T00:00:00.000Z');
});

test('identity ignores leading zeros in the provider identifier (Isracard re-scrapes 030000005 as 30000005)', () => {
  const base = {
    accountId: 'a',
    chargedAmount: -600,
    description: 'מאפיית השכונה הגדולה',
    date: new Date('2026-09-01T21:00:00.000Z'),
  };
  assert.equal(
    isSameIdentifiedTransaction(
      { ...base, txnIdentifier: '030000005' },
      { ...base, txnIdentifier: '30000005', date: new Date('2026-09-02T17:00:00.000Z') },
    ),
    true,
  );
  assert.equal(
    isSameIdentifiedTransaction({ ...base, txnIdentifier: '130000005' }, { ...base, txnIdentifier: '30000005' }),
    false,
  );
});
