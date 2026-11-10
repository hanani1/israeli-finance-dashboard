import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import {
  fuzzyDescMatch,
  matchRiseUpRows,
  normalizeDescription,
  parseCsv,
  parseDmy,
  prefixDescMatch,
  wordSubsetMatch,
  type DashboardMatchRow,
  type RiseUpMatchRow,
} from './riseupMatcher';

function row(key: number, overrides: Partial<RiseUpMatchRow> = {}): RiseUpMatchRow {
  return { key, amount: -100, paymentDate: '2026-09-05', chargeDate: null, description: 'שופרסל דיל', ...overrides };
}
function txn(id: string, overrides: Partial<DashboardMatchRow> = {}): DashboardMatchRow {
  return { id, date: '2026-09-05', processedDate: null, amount: -100, description: 'שופרסל דיל', ...overrides };
}

test('normalizeDescription drops quotes, punctuation and case', () => {
  assert.equal(normalizeDescription('הו"ק  לועד-בית'), 'הוק לועד בית');
  assert.equal(normalizeDescription(' PAYPAL *Spotify '), 'paypal spotify');
});

test('parseDmy converts DD/MM/YYYY and rejects anything else', () => {
  assert.equal(parseDmy('5/9/2026'), '2026-09-05');
  assert.equal(parseDmy(' 05/09/2026 '), '2026-09-05');
  assert.equal(parseDmy('2026-09-05'), null);
  assert.equal(parseDmy(''), null);
});

test('parseCsv handles BOMs, quotes, embedded commas/newlines and CRLF', () => {
  const text = '\ufeff\ufeffa,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n1,2';
  assert.deepEqual(parseCsv(text), [['a', 'b'], ['x, y', 'say "hi"\nthere'], ['1', '2']]);
});

test('description predicates cover the RiseUp formatting differences', () => {
  assert.ok(fuzzyDescMatch(normalizeDescription('הוק לועד ביתלסניף'), normalizeDescription('הו"ק לועד בית לסניף')));
  assert.ok(!fuzzyDescMatch('ab', 'abc'));
  assert.ok(prefixDescMatch(normalizeDescription('העברה דיגיטל'), normalizeDescription('העברה דיגי700')));
  assert.ok(!prefixDescMatch('abcd', 'abcdef'));
  assert.ok(wordSubsetMatch('מענק לאומי', 'מענק בנק לאומי'));
  assert.ok(!wordSubsetMatch('א ב', 'א ב ג'));
});

test('matches on exact description + payment date first', () => {
  const result = matchRiseUpRows([row(1)], [txn('b', { description: 'שופרסל' }), txn('a')]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.txn.id, 'a');
  assert.equal(result.matches[0]?.tier, 'exact-desc+payment-date');
  assert.equal(result.unmatched.length, 0);
});

test('matches the RiseUp charge date against processedDate', () => {
  const result = matchRiseUpRows(
    [row(1, { paymentDate: '2026-08-01', chargeDate: '2026-09-10' })],
    [txn('a', { date: '2026-08-03', processedDate: '2026-09-10' })],
  );
  assert.equal(result.matches[0]?.tier, 'exact-desc+charge-date');
});

test('falls through to fuzzy, ±1 day, prefix and word-subset tiers', () => {
  const cases: Array<[Partial<RiseUpMatchRow>, Partial<DashboardMatchRow>, string]> = [
    [{ description: 'הוק לועד ביתלסניף' }, { description: 'הו"ק לועד בית לסניף' }, 'fuzzy-desc+payment-date'],
    [{ description: 'שופרסל' }, { description: 'שופרסל דיל', date: '2026-09-06' }, 'fuzzy-desc+date±1'],
    [{ description: 'העברה דיגי700' }, { description: 'העברה דיגיטל' }, 'prefix-desc+payment-date'],
    [{ description: 'מענק לאומי' }, { description: 'מענק בנק לאומי' }, 'word-subset+payment-date'],
  ];
  for (const [r, t, tier] of cases) {
    const result = matchRiseUpRows([row(1, r)], [txn('a', t)]);
    assert.equal(result.matches[0]?.tier, tier, JSON.stringify(r));
  }
});

test('compares amounts exactly to the agora, Prisma Decimal included', () => {
  const result = matchRiseUpRows(
    [row(1, { amount: -12.3 }), row(2, { amount: -12.31 })],
    [txn('a', { amount: new Prisma.Decimal('-12.30') })],
  );
  assert.deepEqual(result.matches.map((m) => [m.row.key, m.txn.id]), [[1, 'a']]);
  assert.equal(result.unmatched[0]?.reason, 'no DB transaction with this amount');
});

test('pairs identical rows one-to-one and never reuses a transaction', () => {
  const result = matchRiseUpRows([row(1), row(2), row(3)], [txn('b'), txn('a')]);
  assert.deepEqual(result.matches.map((m) => [m.row.key, m.txn.id]), [[1, 'a'], [2, 'b']]);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0]?.row.key, 3);
});

test('accepts interchangeable surplus candidates but refuses distinct ones', () => {
  const interchangeable = matchRiseUpRows([row(1)], [txn('b'), txn('a')]);
  assert.equal(interchangeable.matches[0]?.txn.id, 'a');

  const distinct = matchRiseUpRows(
    [row(1, { description: 'שופרסל' })],
    [txn('a', { description: 'שופרסל דיל' }), txn('b', { description: 'שופרסל אונליין' })],
  );
  assert.equal(distinct.matches.length, 0);
  assert.match(distinct.unmatched[0]?.reason ?? '', /^ambiguous: 2 distinct DB candidates in tier "fuzzy-desc\+payment-date"$/);
});

test('explains unmatched rows', () => {
  const result = matchRiseUpRows(
    [
      row(1, { paymentDate: null }),
      row(2, { paymentDate: '2020-01-01' }),
      row(3, { description: 'משהו אחר לגמרי' }),
    ],
    [txn('a', { date: '2026-09-01' }), txn('b', { date: '2026-09-30', amount: -1 })],
  );
  assert.deepEqual(result.unmatched.map((u) => u.reason), [
    'unparseable date',
    'outside DB transaction date range (2026-09-01..2026-09-30)',
    'no DB transaction with matching amount+date+description',
  ]);
});

test('the amount+date fallback tier is opt-in and only for unique candidates', () => {
  const rows = [row(1, { description: 'PAYBOX' })];
  assert.equal(matchRiseUpRows(rows, [txn('a', { description: 'העברה' })]).matches.length, 0);

  const withFallback = matchRiseUpRows(rows, [txn('a', { description: 'העברה' })], { amountDateFallback: true });
  assert.equal(withFallback.matches[0]?.tier, 'amount+payment-date');

  const ambiguous = matchRiseUpRows(
    rows,
    [txn('a', { description: 'העברה' }), txn('b', { description: 'משיכה' })],
    { amountDateFallback: true },
  );
  assert.equal(ambiguous.matches.length, 0);
});

test('result does not depend on the order of DB rows', () => {
  const rows = [row(1), row(2, { description: 'שופרסל' })];
  const txns = [txn('c'), txn('a'), txn('b', { description: 'שופרסל ים' })];
  const forward = matchRiseUpRows(rows, txns).matches.map((m) => [m.row.key, m.txn.id]);
  const reverse = matchRiseUpRows(rows, [...txns].reverse()).matches.map((m) => [m.row.key, m.txn.id]);
  assert.deepEqual(forward, reverse);
});
