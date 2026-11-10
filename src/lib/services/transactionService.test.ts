import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTransactionWhere, dedupeAndSortCategories } from './transactionService';

const cat = (id: number, name: string, type = 'EXPENSE') => ({ id, name, type });

test('sorts alphabetically by Hebrew locale', () => {
  const result = dedupeAndSortCategories([
    cat(1, 'תרומה'),
    cat(2, 'ביטוח'),
    cat(3, 'אוכל בחוץ'),
    cat(4, 'סופר'),
  ]);
  assert.deepEqual(
    result.map((c) => c.name),
    ['אוכל בחוץ', 'ביטוח', 'סופר', 'תרומה'],
  );
});

test('drops same-name same-type duplicates, keeping the lowest id', () => {
  const result = dedupeAndSortCategories([cat(42, 'ספורט'), cat(23, 'ספורט')]);
  assert.deepEqual(
    result.map((c) => c.id),
    [23],
  );
});

test('treats whitespace variants of a name as duplicates', () => {
  const result = dedupeAndSortCategories([cat(2, 'דיור'), cat(46, ' דיור ')]);
  assert.deepEqual(
    result.map((c) => c.id),
    [2],
  );
});

test('keeps same-name categories of different types distinct', () => {
  const result = dedupeAndSortCategories([
    cat(2, 'דיור', 'EXPENSE'),
    cat(46, 'דיור', 'INCOME'),
  ]);
  assert.equal(result.length, 2);
});

test('returns an empty list unchanged', () => {
  assert.deepEqual(dedupeAndSortCategories([]), []);
});

test('normal transaction queries exclude card settlements by default', () => {
  assert.deepEqual(buildTransactionWhere({}), { isCardSettlement: false });
  assert.deepEqual(buildTransactionWhere({ needsReview: true }), {
    isCardSettlement: false,
    categorizationSource: { not: 'MANUAL' },
  });
});

test('internal audit queries can explicitly include raw card settlements', () => {
  assert.deepEqual(buildTransactionWhere({ includeCardSettlements: true }), {});
});
