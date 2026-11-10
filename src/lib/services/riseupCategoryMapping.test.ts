import assert from 'node:assert/strict';
import test from 'node:test';
import { findMatchingCategory, riseUpCategoryTarget } from './riseupCategoryMapping';

test('maps income labels to income categories', () => {
  assert.deepEqual(riseUpCategoryTarget('משכורת', true), {
    name: 'משכורת', type: 'INCOME', group: 'INCOME',
  });
});

test('maps known recurring expense labels to recurring categories', () => {
  assert.deepEqual(riseUpCategoryTarget('דיור', false), {
    name: 'דיור', type: 'EXPENSE', group: 'RECURRING_EXPENSE',
  });
});

test('maps unknown non-hidden labels without inventing a translation', () => {
  assert.deepEqual(riseUpCategoryTarget('כלכלה', false), {
    name: 'כלכלה', type: 'EXPENSE', group: 'VARIABLE_EXPENSE',
  });
});

test('leaves blank and hidden RiseUp labels unassigned', () => {
  assert.equal(riseUpCategoryTarget('', false), null);
  assert.equal(riseUpCategoryTarget('__saving-hidden-category__', false), null);
});

test('matches by name, type, and group', () => {
  const categories = [
    { id: 1, name: 'דיור', type: 'EXPENSE' as const, group: 'RECURRING_EXPENSE' as const },
    { id: 2, name: 'דיור', type: 'INCOME' as const, group: 'INCOME' as const },
  ];
  assert.equal(findMatchingCategory(categories, riseUpCategoryTarget('דיור', false)!)?.id, 1);
  assert.equal(findMatchingCategory(categories, riseUpCategoryTarget('דיור', true)!)?.id, 2);
});
