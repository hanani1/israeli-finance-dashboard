import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATEGORY_MERGES,
  canonicalCategoryName,
  planCategoryMerges,
  type MergeCategory,
} from './categoryMerge';
import { riseUpCategoryTarget } from './riseupCategoryMapping';

const cats: MergeCategory[] = [
  { id: 44, name: 'הוצאות משתנות', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' },
  { id: 45, name: 'טיולים ופנאי', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' },
  { id: 47, name: 'פנאי', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' },
  { id: 51, name: 'אחר', type: 'INCOME', group: 'INCOME' },
  { id: 52, name: 'אחר', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' },
];

test('the agreed merges: expense אחר → הוצאות משתנות, פנאי → טיולים ופנאי', () => {
  assert.deepEqual(
    CATEGORY_MERGES.map((m) => `${m.source.name}/${m.source.group} → ${m.target.name}`),
    ['אחר/VARIABLE_EXPENSE → הוצאות משתנות', 'פנאי/VARIABLE_EXPENSE → טיולים ופנאי'],
  );
});

test('planCategoryMerges resolves sources and targets by name+type+group, never by id', () => {
  const plan = planCategoryMerges(cats);
  assert.deepEqual(
    plan.steps.map((s) => ({ from: s.source.id, to: s.target.id })),
    [{ from: 52, to: 44 }, { from: 47, to: 45 }],
  );
  assert.deepEqual(plan.skipped, []);
});

test('planCategoryMerges leaves the INCOME אחר alone (same display name, different group)', () => {
  const plan = planCategoryMerges(cats);
  assert.equal(plan.steps.some((s) => s.source.id === 51), false);
});

test('planCategoryMerges skips a merge whose source does not exist and reports it', () => {
  const plan = planCategoryMerges(cats.filter((c) => c.id !== 52));
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.skipped, [{ merge: CATEGORY_MERGES[0], reason: 'source-missing' }]);
});

test('planCategoryMerges refuses when the target is missing or duplicated instead of creating one', () => {
  const noTarget = planCategoryMerges(cats.filter((c) => c.id !== 45));
  assert.deepEqual(noTarget.skipped, [{ merge: CATEGORY_MERGES[1], reason: 'target-missing' }]);
  const dupTarget = planCategoryMerges([...cats, { id: 99, name: 'טיולים ופנאי', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' }]);
  assert.deepEqual(dupTarget.skipped, [{ merge: CATEGORY_MERGES[1], reason: 'target-ambiguous' }]);
});

test('canonicalCategoryName redirects merged names so imports and rules cannot recreate them', () => {
  assert.equal(canonicalCategoryName('אחר', 'EXPENSE'), 'הוצאות משתנות');
  assert.equal(canonicalCategoryName('אחר', 'INCOME'), 'אחר');
  assert.equal(canonicalCategoryName('פנאי', 'EXPENSE'), 'טיולים ופנאי');
  assert.equal(canonicalCategoryName(' פנאי ', 'EXPENSE'), 'טיולים ופנאי');
  assert.equal(canonicalCategoryName('סופר', 'EXPENSE'), 'סופר');
});

test('RiseUp label mapping goes through the canonical name', () => {
  assert.deepEqual(riseUpCategoryTarget('אחר', false), { name: 'הוצאות משתנות', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' });
  assert.deepEqual(riseUpCategoryTarget('פנאי', false), { name: 'טיולים ופנאי', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' });
  assert.deepEqual(riseUpCategoryTarget('אחר', true), { name: 'אחר', type: 'INCOME', group: 'INCOME' });
});
