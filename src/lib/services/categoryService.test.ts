import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidCategoryColor, normalizeCategoryColor } from './categoryService';

test('accepts 6-digit and 3-digit hex colors, any case, surrounding spaces', () => {
  assert.ok(isValidCategoryColor('#22c55e'));
  assert.ok(isValidCategoryColor('#22C55E'));
  assert.ok(isValidCategoryColor('#abc'));
  assert.ok(isValidCategoryColor(' #ABC '));
});

test('rejects invalid colors and non-strings', () => {
  assert.ok(!isValidCategoryColor('22c55e')); // missing #
  assert.ok(!isValidCategoryColor('#22c55')); // 5 digits
  assert.ok(!isValidCategoryColor('#22c55ez')); // non-hex char
  assert.ok(!isValidCategoryColor('#22c55e00')); // 8 digits (alpha) not allowed
  assert.ok(!isValidCategoryColor('red')); // named colors not allowed
  assert.ok(!isValidCategoryColor('#abc; background:url(x)')); // injection-ish
  assert.ok(!isValidCategoryColor(42));
  assert.ok(!isValidCategoryColor(null));
  assert.ok(!isValidCategoryColor(undefined));
});

test('normalizes to lowercase 6-digit form', () => {
  assert.equal(normalizeCategoryColor('#22C55E'), '#22c55e');
  assert.equal(normalizeCategoryColor('#ABC'), '#aabbcc');
  assert.equal(normalizeCategoryColor(' #f00 '), '#ff0000');
});
