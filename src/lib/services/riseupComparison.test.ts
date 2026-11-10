import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarDay, comparisonRange, effectiveMonth } from './riseupComparison';

test('comparisonRange defaults to the complete snapshot range', () => {
  assert.deepEqual(comparisonRange('2024-05', '2026-09'), { from: '2024-05', to: '2026-09' });
});

test('comparisonRange selects the requested number of trailing months', () => {
  assert.deepEqual(comparisonRange('2024-05', '2026-09', 6), { from: '2026-04', to: '2026-09' });
  assert.deepEqual(comparisonRange('2024-05', '2026-09', 99), { from: '2024-05', to: '2026-09' });
});

test('comparisonRange rejects a non-positive month count', () => {
  assert.throws(() => comparisonRange('2024-05', '2026-09', 0), /positive integer/);
});

test('calendarDay treats scraper timestamps as Israeli local dates', () => {
  assert.equal(calendarDay(new Date('2024-05-04T21:00:00.000Z')), '2024-05-05');
  assert.equal(calendarDay('2024-05-05T00:00:00.000Z'), '2024-05-05');
});

test('effectiveMonth prefers the assigned cashflow month', () => {
  assert.equal(effectiveMonth('2024-05', '2024-04-30T00:00:00.000Z'), '2024-05');
  assert.equal(effectiveMonth(null, new Date('2024-05-31T21:00:00.000Z')), '2024-06');
});
