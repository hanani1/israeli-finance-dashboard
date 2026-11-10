import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectSupersededPendingRows,
  normalizeCurrencyCode,
  normalizeTxnIdentifier,
  rawTxnIdentifier,
  type PendingSettlementRow,
} from './pendingSettlement';

const ACCOUNT = 'acct-1';

function row(partial: Partial<PendingSettlementRow> & { id: string }): PendingSettlementRow {
  return {
    accountId: ACCOUNT,
    txnIdentifier: null,
    date: new Date('2026-09-24T00:00:00.000Z'),
    processedDate: null,
    chargedAmount: -42,
    originalAmount: null,
    description: 'PAYBOX',
    memo: null,
    createdAt: new Date('2026-09-24T01:00:00.000Z'),
    ...partial,
  };
}

test('normalizeTxnIdentifier strips leading zeros that Isracard adds on some scrapes', () => {
  assert.equal(normalizeTxnIdentifier('030000005'), '30000005');
  assert.equal(normalizeTxnIdentifier('30000005'), '30000005');
  assert.equal(normalizeTxnIdentifier('0010000000004'), '10000000004');
  assert.equal(normalizeTxnIdentifier('000'), '0');
  assert.equal(normalizeTxnIdentifier(null), null);
  assert.equal(normalizeTxnIdentifier(''), null);
});

test('normalizeCurrencyCode maps Cal currency symbols and Hebrew names to ISO codes', () => {
  assert.equal(normalizeCurrencyCode('₪'), 'ILS');
  assert.equal(normalizeCurrencyCode('ILS'), 'ILS');
  assert.equal(normalizeCurrencyCode('דולר'), 'USD');
  assert.equal(normalizeCurrencyCode('$'), 'USD');
  assert.equal(normalizeCurrencyCode('€'), 'EUR');
  assert.equal(normalizeCurrencyCode('EUR'), 'EUR');
  assert.equal(normalizeCurrencyCode(undefined), 'ILS');
  assert.equal(normalizeCurrencyCode('  usd '), 'USD');
});

test('Isracard: pending row (long padded id, full description, processed=date) is superseded by the settled row (short id, truncated description)', () => {
  const pending = row({
    id: 'p',
    txnIdentifier: '0010000000004',
    date: new Date('2026-09-02T17:00:00.000Z'),
    processedDate: new Date('2026-09-02T00:00:00.000Z'),
    chargedAmount: -600,
    description: 'מאפיית השכונה הגדולה רמת',
    createdAt: new Date('2026-09-04T01:14:00.000Z'),
  });
  const settled = row({
    id: 's',
    txnIdentifier: '30000005',
    date: new Date('2026-09-01T21:00:00.000Z'),
    processedDate: new Date('2026-09-08T21:00:00.000Z'),
    chargedAmount: -600,
    description: 'מאפיית השכונה הגדולה',
    createdAt: new Date('2026-09-10T17:13:00.000Z'),
  });
  assert.deepEqual(detectSupersededPendingRows([pending, settled]), [
    { pendingId: 'p', settledId: 's', rule: 'description-prefix' },
  ]);
});

test('zero-padded identifier twins: the older padded row is superseded by the unpadded re-scrape', () => {
  const padded = row({
    id: 'old',
    txnIdentifier: '030000005',
    date: new Date('2026-09-02T17:00:00.000Z'),
    processedDate: new Date('2026-09-08T21:00:00.000Z'),
    chargedAmount: -600,
    description: 'מאפיית השכונה הגדולה',
    createdAt: new Date('2026-09-10T17:13:00.000Z'),
  });
  const unpadded = row({
    id: 'new',
    txnIdentifier: '30000005',
    date: new Date('2026-09-01T21:00:00.000Z'),
    processedDate: new Date('2026-09-08T21:00:00.000Z'),
    chargedAmount: -600,
    description: 'מאפיית השכונה הגדולה',
    createdAt: new Date('2026-09-28T22:19:00.000Z'),
  });
  assert.deepEqual(detectSupersededPendingRows([padded, unpadded]), [
    { pendingId: 'old', settledId: 'new', rule: 'identifier-padding' },
  ]);
});

test('Cal: no-id pending rows (precise amount) match settled rows on originalAmount; two genuine ₪42 PAYBOX transfers keep both settled rows', () => {
  const rows = [
    // Two settled PAYBOX transfers (distinct identifiers), charged rounded to ₪ with precise originalAmount.
    row({ id: 's1', txnIdentifier: '40000000001', processedDate: new Date('2026-10-01T00:00:00.000Z'), date: new Date('2026-09-28T09:04:00.000Z'), chargedAmount: -42, originalAmount: -42 }),
    row({ id: 's2', txnIdentifier: '40000000002', processedDate: new Date('2026-10-01T00:00:00.000Z'), date: new Date('2026-09-28T09:31:00.000Z'), chargedAmount: -42, originalAmount: -42 }),
    // Their two pending snapshots, no identifier, processedDate = date.
    row({ id: 'p1', date: new Date('2026-09-28T09:04:00.000Z'), processedDate: new Date('2026-09-28T09:04:00.000Z') }),
    row({ id: 'p2', date: new Date('2026-09-28T09:31:00.000Z'), processedDate: new Date('2026-09-28T09:31:00.000Z') }),
    // A rounded settled WOLT row vs its precise pending snapshot.
    row({ id: 's3', txnIdentifier: '40000000003', processedDate: new Date('2026-10-01T00:00:00.000Z'), date: new Date('2026-09-28T12:00:00.000Z'), chargedAmount: -151, originalAmount: -150.54, description: 'WOLT' }),
    row({ id: 'p3', date: new Date('2026-09-28T12:00:00.000Z'), processedDate: new Date('2026-09-28T12:00:00.000Z'), chargedAmount: -150.54, description: 'WOLT' }),
  ];
  const matches = detectSupersededPendingRows(rows);
  assert.equal(matches.length, 3);
  assert.deepEqual(new Set(matches.map((m) => m.pendingId)), new Set(['p1', 'p2', 'p3']));
  assert.deepEqual(new Set(matches.map((m) => m.settledId)), new Set(['s1', 's2', 's3']));
  assert.equal(matches.find((m) => m.pendingId === 'p3')?.rule, 'description-prefix');
});

test('Cal: a no-id pending row whose settled twin carries a different merchant text (ATM withdrawal) matches on amount only, flagged as such', () => {
  const pending = row({ id: 'p', date: new Date('2026-09-24T07:00:00.000Z'), processedDate: new Date('2026-09-24T07:00:00.000Z'), chargedAmount: -1000, description: 'משיכת מזומן' });
  const settled = row({ id: 's', txnIdentifier: '10000000001', date: new Date('2026-09-24T07:00:00.000Z'), processedDate: new Date('2026-09-30T21:00:00.000Z'), chargedAmount: -1000, originalAmount: -1000, description: 'חנות לדוגמה' });
  assert.deepEqual(detectSupersededPendingRows([pending, settled]), [
    { pendingId: 'p', settledId: 's', rule: 'amount-only' },
  ]);
});

test('never pairs across accounts, across amounts, beyond the day window, or two settled rows with each other', () => {
  const settledA = row({ id: 'a', txnIdentifier: '1', processedDate: new Date('2026-10-01T00:00:00.000Z'), chargedAmount: -42 });
  const settledB = row({ id: 'b', txnIdentifier: '2', processedDate: new Date('2026-10-01T00:00:00.000Z'), chargedAmount: -42 });
  const otherAccount = row({ id: 'c', accountId: 'acct-2', processedDate: new Date('2026-09-24T00:00:00.000Z'), chargedAmount: -42 });
  const otherAmount = row({ id: 'd', processedDate: new Date('2026-09-24T00:00:00.000Z'), chargedAmount: -43 });
  const farAway = row({ id: 'e', date: new Date('2026-09-10T00:00:00.000Z'), processedDate: new Date('2026-09-10T00:00:00.000Z'), chargedAmount: -42 });
  assert.deepEqual(detectSupersededPendingRows([settledA, settledB, otherAccount, otherAmount, farAway]), []);
});

test('a pending row with an identifier that matches no settled row stays visible (ambiguous Isracard ₪250 vs ₪125)', () => {
  const pending = row({ id: 'p', txnIdentifier: '0010000000002', processedDate: new Date('2026-09-05T17:20:00.000Z'), date: new Date('2026-09-05T17:20:00.000Z'), chargedAmount: -250, description: 'נעלי דוגמה ת"א' });
  const settled = row({ id: 's', txnIdentifier: '20000003', processedDate: new Date('2026-09-08T21:00:00.000Z'), date: new Date('2026-09-04T21:00:00.000Z'), chargedAmount: -125, description: 'נעלי דוגמה ת"א' });
  assert.deepEqual(detectSupersededPendingRows([pending, settled]), []);
});

test('one settled row absorbs both its zero-padded twin and its pending snapshot (Isracard ₪600 donation seen three times)', () => {
  const pending = row({ id: 'p', txnIdentifier: '0010000000004', date: new Date('2026-09-02T17:00:00.000Z'), processedDate: new Date('2026-09-02T00:00:00.000Z'), chargedAmount: -600, description: 'מאפיית השכונה הגדולה רמת', createdAt: new Date('2026-09-04T01:14:00.000Z') });
  const padded = row({ id: 'old', txnIdentifier: '030000005', date: new Date('2026-09-02T17:00:00.000Z'), processedDate: new Date('2026-09-08T21:00:00.000Z'), chargedAmount: -600, description: 'מאפיית השכונה הגדולה', createdAt: new Date('2026-09-10T17:13:00.000Z') });
  const settled = row({ id: 'new', txnIdentifier: '30000005', date: new Date('2026-09-01T21:00:00.000Z'), processedDate: new Date('2026-09-08T21:00:00.000Z'), chargedAmount: -600, description: 'מאפיית השכונה הגדולה', createdAt: new Date('2026-09-28T22:19:00.000Z') });
  const matches = detectSupersededPendingRows([pending, padded, settled]);
  assert.deepEqual(
    matches.sort((a, b) => a.pendingId.localeCompare(b.pendingId)),
    [
      { pendingId: 'old', settledId: 'new', rule: 'identifier-padding' },
      { pendingId: 'p', settledId: 'new', rule: 'description-prefix' },
    ],
  );
});

test('Cal: a settled ATM withdrawal is processed on the purchase day itself; its no-id pending snapshot still matches', () => {
  const pending = row({ id: 'p', date: new Date('2026-09-24T07:00:00.000Z'), processedDate: new Date('2026-09-24T07:00:00.000Z'), chargedAmount: -1000, description: 'משיכת מזומן' });
  const settled = row({ id: 's', txnIdentifier: '10000000001', date: new Date('2026-09-24T07:00:00.000Z'), processedDate: new Date('2026-09-23T21:00:00.000Z'), chargedAmount: -1000, originalAmount: -1000, description: 'חנות לדוגמה' });
  assert.deepEqual(detectSupersededPendingRows([pending, settled]), [{ pendingId: 'p', settledId: 's', rule: 'amount-only' }]);
});

test('two no-id pending snapshots never collapse onto one settled row', () => {
  const settled = row({ id: 's', txnIdentifier: '1', processedDate: new Date('2026-10-01T00:00:00.000Z'), chargedAmount: -42 });
  const p1 = row({ id: 'p1', processedDate: new Date('2026-09-24T00:00:00.000Z'), chargedAmount: -42 });
  const p2 = row({ id: 'p2', processedDate: new Date('2026-09-24T00:00:00.000Z'), chargedAmount: -42, createdAt: new Date('2026-09-24T02:00:00.000Z') });
  assert.equal(detectSupersededPendingRows([settled, p1, p2]).length, 1);
});

test('installment purchase: zero-amount pending snapshot is superseded by the first installment', () => {
  const pending = row({
    id: 'installment-pending',
    date: new Date('2026-09-23T00:00:00.000Z'),
    processedDate: new Date('2026-09-23T00:00:00.000Z'),
    chargedAmount: 0,
    originalAmount: -7485,
    description: 'סוכנויות נסיעות בע"מ',
  });
  const firstInstallment = row({
    id: 'installment-1',
    date: new Date('2026-09-23T00:00:00.000Z'),
    processedDate: new Date('2026-10-10T00:00:00.000Z'),
    chargedAmount: -3630.71,
    originalAmount: -7485,
    txnIdentifier: '00000000000000000000001_1',
    description: 'סוכנות נסיעות בע"מ',
    memo: 'תשלום 1 מתוך 2',
  });
  const secondInstallment = row({
    id: 'installment-2',
    date: new Date('2026-10-23T00:00:00.000Z'),
    processedDate: new Date('2026-11-09T00:00:00.000Z'),
    chargedAmount: -3629.74,
    originalAmount: -7485,
    txnIdentifier: '00000000000000000000001_2',
    description: 'סוכנות נסיעות בע"מ',
    memo: 'תשלום 2 מתוך 2',
  });
  assert.deepEqual(detectSupersededPendingRows([pending, firstInstallment, secondInstallment]), [
    { pendingId: 'installment-pending', settledId: 'installment-1', rule: 'installment-original-amount' },
  ]);
});

// Card #50: Isracard can hand back a numeric identifier parsed from an empty
// field (NaN). String(NaN) === "NaN" would give every such row the same
// identifier and let them collide on the identity lookup.
test('normalizeTxnIdentifier: NaN, Infinity and stringified NaN/undefined/null are treated as absent', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'NaN', 'undefined', 'null', ' ', undefined, null]) {
    assert.equal(normalizeTxnIdentifier(bad as never), null, `${String(bad)} must normalize to null`);
  }
  assert.equal(normalizeTxnIdentifier(30000005), '30000005');
  assert.equal(normalizeTxnIdentifier('030000005'), '30000005');
  assert.equal(normalizeTxnIdentifier(0), '0');
});

test('rawTxnIdentifier: keeps the provider form but drops NaN/undefined', () => {
  assert.equal(rawTxnIdentifier('030000005'), '030000005');
  assert.equal(rawTxnIdentifier(42), '42');
  for (const bad of [NaN, 'NaN', 'undefined', undefined, null, '']) {
    assert.equal(rawTxnIdentifier(bad as never), null, `${String(bad)} must be null`);
  }
});
