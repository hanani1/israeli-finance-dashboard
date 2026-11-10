import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AVG6_MONTH_COUNT,
  calendarFlowMonth,
  effectiveFlowMonth,
  flowMonthEnd,
  flowMonthStart,
  previousSixFlowMonths,
} from './flowMonth';

test('calendarFlowMonth uses the Israeli calendar month of the provider day', () => {
  // Scraped rows are Israel-local midnight: 2026-01-31T22:00Z IS Feb 1 local.
  assert.equal(calendarFlowMonth(new Date('2026-01-31T22:00:00.000Z')), '2026-02');
  assert.equal(calendarFlowMonth(new Date('2026-08-31T21:00:00.000Z')), '2026-09');
  // Legacy CSV rows stored at 00:00Z stay on their day.
  assert.equal(calendarFlowMonth(new Date('2026-12-15T00:00:00.000Z')), '2026-12');
  assert.equal(calendarFlowMonth(new Date('2026-09-01T00:00:00.000Z')), '2026-09');
});

test('effectiveFlowMonth: Jan-31 rent check with stored flowMonth counts in February', () => {
  // The 5,500 rent check dated 2026-01-31 belongs to RiseUp flow month 2026-02.
  const janCheckDate = new Date('2026-01-31T22:00:00.000Z');
  assert.equal(effectiveFlowMonth('2026-02', janCheckDate), '2026-02');
});

test('effectiveFlowMonth falls back to the local calendar month when flowMonth is null/invalid', () => {
  const date = new Date('2026-01-15T22:00:00.000Z');
  assert.equal(effectiveFlowMonth(null, date), '2026-01');
  assert.equal(effectiveFlowMonth(undefined, date), '2026-01');
  assert.equal(effectiveFlowMonth('', date), '2026-01');
  assert.equal(effectiveFlowMonth('garbage', date), '2026-01');
});

test('previousSixFlowMonths returns exactly the six months before the selected month', () => {
  assert.deepEqual(previousSixFlowMonths('2026-08'), [
    '2026-02',
    '2026-03',
    '2026-04',
    '2026-05',
    '2026-06',
    '2026-07',
  ]);
});

test('previousSixFlowMonths crosses year boundaries and always has 6 entries (fixed divisor)', () => {
  const labels = previousSixFlowMonths('2026-02');
  assert.deepEqual(labels, ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
  assert.equal(labels.length, AVG6_MONTH_COUNT);
  assert.equal(AVG6_MONTH_COUNT, 6);
});

test('flowMonthStart / flowMonthEnd bound the calendar-fallback window', () => {
  // Israel midnight (IST, UTC+2 in winter) as a UTC instant.
  assert.equal(flowMonthStart('2026-02').toISOString(), '2026-01-31T22:00:00.000Z');
  assert.equal(flowMonthEnd('2026-02').toISOString(), '2026-02-28T22:00:00.000Z');
  assert.equal(flowMonthStart('2026-09').toISOString(), '2026-08-31T21:00:00.000Z');
  assert.equal(flowMonthEnd('2026-09').toISOString(), '2026-09-30T21:00:00.000Z');
  // Six-month window for 2026-08: [2026-02-01, 2026-08-01)
  const labels = previousSixFlowMonths('2026-08');
  const first = labels[0]!;
  const last = labels[labels.length - 1]!;
  assert.equal(flowMonthStart(first).toISOString(), '2026-01-31T22:00:00.000Z');
  assert.equal(flowMonthEnd(last).toISOString(), '2026-07-31T21:00:00.000Z');
});
