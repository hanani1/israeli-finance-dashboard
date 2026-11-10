import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSharePercent, sliceSharePercent } from './chartShare';

test('share is the slice total over the sum of all slices, in percent', () => {
  const slices = [{ total: 600 }, { total: 300 }, { total: 100 }];
  assert.equal(sliceSharePercent(600, slices), 60);
  assert.equal(sliceSharePercent(300, slices), 30);
  assert.equal(sliceSharePercent(100, slices), 10);
});

test('share is 0 when the chart is empty or sums to zero', () => {
  assert.equal(sliceSharePercent(0, []), 0);
  assert.equal(sliceSharePercent(0, [{ total: 0 }]), 0);
});

test('formatSharePercent rounds to one decimal and drops a trailing .0', () => {
  assert.equal(formatSharePercent(33.3333), '33.3%');
  assert.equal(formatSharePercent(60), '60%');
  assert.equal(formatSharePercent(0.04), '0%');
  assert.equal(formatSharePercent(99.96), '100%');
});
