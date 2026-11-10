import assert from 'node:assert/strict';
import test from 'node:test';
import { computePacing, resolveMonthWindow } from './budgetPacing';

test('reports on-pace when spend tracks the elapsed fraction', () => {
  const p = computePacing({ amount: 1000, spent: 500, daysElapsed: 15, daysInMonth: 30 });
  assert.equal(p.pace, 'on');
  assert.equal(p.expectedByNow, 500);
  assert.equal(p.remaining, 500);
  assert.equal(p.projected, 1000);
  assert.equal(p.overBudget, false);
});

test('reports over-pace when spending outruns the month', () => {
  const p = computePacing({ amount: 1000, spent: 800, daysElapsed: 15, daysInMonth: 30 });
  assert.equal(p.pace, 'over');
  assert.ok(p.paceRatio > 1.05);
  assert.equal(p.projected, 1600);
  assert.equal(p.overBudget, false); // projected over, but not yet past the limit
});

test('reports under-pace when spending lags', () => {
  const p = computePacing({ amount: 1000, spent: 200, daysElapsed: 15, daysInMonth: 30 });
  assert.equal(p.pace, 'under');
  assert.equal(p.remaining, 800);
});

test('flags overBudget once cumulative spend exceeds the whole budget', () => {
  const p = computePacing({ amount: 1000, spent: 1200, daysElapsed: 20, daysInMonth: 30 });
  assert.equal(p.overBudget, true);
  assert.equal(p.remaining, -200);
  assert.equal(p.pace, 'over');
});

test('a zero budget with any spend is over pace', () => {
  const p = computePacing({ amount: 0, spent: 50, daysElapsed: 10, daysInMonth: 30 });
  assert.equal(p.pace, 'over');
  assert.equal(p.overBudget, true);
});

test('a zero budget with no spend is on pace', () => {
  const p = computePacing({ amount: 0, spent: 0, daysElapsed: 10, daysInMonth: 30 });
  assert.equal(p.pace, 'on');
  assert.equal(p.overBudget, false);
});

test('clamps out-of-range day counts', () => {
  const p = computePacing({ amount: 300, spent: 300, daysElapsed: 99, daysInMonth: 30 });
  assert.equal(p.elapsedFraction, 1);
  assert.equal(p.expectedByNow, 300);
  assert.equal(p.pace, 'on');
});

test('resolveMonthWindow uses full elapsed days for a past month', () => {
  const w = resolveMonthWindow('2026-02', new Date('2026-08-17T00:00:00.000Z'));
  assert.equal(w.label, '2026-02');
  assert.equal(w.daysInMonth, 28);
  assert.equal(w.daysElapsed, 28);
  assert.equal(w.start.toISOString(), '2026-01-31T22:00:00.000Z'); // Israel midnight, Feb 1
  assert.equal(w.end.toISOString(), '2026-02-28T22:00:00.000Z');
});

test('resolveMonthWindow uses the current day for the ongoing month', () => {
  const w = resolveMonthWindow('2026-08', new Date('2026-08-17T12:00:00.000Z'));
  assert.equal(w.daysInMonth, 31);
  assert.equal(w.daysElapsed, 17);
});

test('resolveMonthWindow defaults to the reference month when unspecified', () => {
  const w = resolveMonthWindow(undefined, new Date('2026-08-17T00:00:00.000Z'));
  assert.equal(w.label, '2026-08');
});

test('resolveMonthWindow bounds the query window on Israeli month boundaries', () => {
  const window = resolveMonthWindow('2026-09', new Date('2026-10-03T12:00:00.000Z'));
  // A Discount row dated Sept 1 is stored as 2026-08-31T21:00Z and must be inside.
  assert.equal(window.start.toISOString(), '2026-08-31T21:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-09-30T21:00:00.000Z');
  assert.equal(window.label, '2026-09');
  assert.equal(window.daysInMonth, 30);
  assert.equal(window.daysElapsed, 30);
});
