import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localCalendarDay, localCalendarMonth, localDateRange, localDayStart } from './localDay';

// Scrapers emit provider dates as Israel-local midnight instants: a Discount
// row "dated" 2026-09-01 is stored as 2026-08-31T21:00:00Z (IDT, UTC+3) and a
// January row as ...T22:00:00Z (IST, UTC+2). Older CSV imports stored plain
// 00:00Z. Day/month attribution must follow the Israeli calendar for both.

test('localDayStart: Israel midnight of a yyyy-MM-dd as a UTC instant (DST aware)', () => {
  assert.equal(localDayStart('2026-09-01').toISOString(), '2026-08-31T21:00:00.000Z');
  assert.equal(localDayStart('2026-01-01').toISOString(), '2025-12-31T22:00:00.000Z');
});

test('localCalendarDay: scraped local-midnight rows and legacy 00:00Z rows map to the same provider day', () => {
  assert.equal(localCalendarDay(new Date('2026-08-31T21:00:00.000Z')), '2026-09-01');
  assert.equal(localCalendarDay(new Date('2026-09-01T00:00:00.000Z')), '2026-09-01');
  assert.equal(localCalendarDay(new Date('2026-09-30T21:00:00.000Z')), '2026-10-01');
  assert.equal(localCalendarDay(new Date('2025-12-31T22:00:00.000Z')), '2026-01-01');
});

test('localCalendarMonth: the Sept-1 mortgage debit belongs to September, not August', () => {
  assert.equal(localCalendarMonth(new Date('2026-08-31T21:00:00.000Z')), '2026-09');
  assert.equal(localCalendarMonth(new Date('2026-09-30T21:00:00.000Z')), '2026-10');
});

test('localDateRange: inclusive yyyy-MM-dd bounds become a half-open UTC window on Israeli days', () => {
  const range = localDateRange('2026-09-01', '2026-09-30');
  assert.equal(range.gte?.toISOString(), '2026-08-31T21:00:00.000Z');
  assert.equal(range.lt?.toISOString(), '2026-09-30T21:00:00.000Z');
  assert.deepEqual(localDateRange(undefined, undefined), {});
  assert.equal(localDateRange('2026-09-01', undefined).lt, undefined);
});
