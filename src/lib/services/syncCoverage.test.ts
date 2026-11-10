import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyScrapeFailure,
  incrementalScrapeStart,
  staleSyncWarning,
  uncoveredDays,
} from './syncCoverage';

// Isracard dates are Israel-local midnights: a 2026-10-01 purchase is
// 2026-09-30T21:00:00Z. The library keeps a row only if startDate <= row date.
const keeps = (startDate: Date, rowDate: string) => startDate.getTime() <= new Date(rowDate).getTime();

test('regression: the 2026-10-08 recovery run after a 9-day Isracard outage covers 2026-10-01', () => {
  const now = new Date('2026-10-08T01:00:05.000Z'); // 04:00 IDT scheduled run
  const lastSuccess = new Date('2026-09-28T01:04:00.000Z'); // last Isracard OK before the 403s
  const hotelStay = '2026-09-30T21:00:00.000Z'; // purchase 2026-10-01
  const farmStay = '2026-09-29T21:00:00.000Z'; // purchase 2026-09-30

  // The old fixed "now minus seven days" window dropped both.
  const oldStart = new Date(now);
  oldStart.setDate(oldStart.getDate() - 7);
  assert.equal(keeps(oldStart, hotelStay), false);
  assert.equal(uncoveredDays(oldStart, lastSuccess), 3);

  const start = incrementalScrapeStart(now, lastSuccess);
  assert.equal(start.toISOString(), '2026-09-20T21:00:00.000Z'); // local 2026-09-21, 7 days before 09-28
  assert.equal(keeps(start, hotelStay), true);
  assert.equal(keeps(start, farmStay), true);
  assert.equal(uncoveredDays(start, lastSuccess), 0);
});

test('incrementalScrapeStart: daily success keeps a 7-day local-midnight window that includes the oldest day', () => {
  const now = new Date('2026-10-09T01:00:00.000Z');
  const start = incrementalScrapeStart(now, new Date('2026-10-08T01:04:00.000Z'));
  assert.equal(start.toISOString(), '2026-09-30T21:00:00.000Z'); // local 2026-10-01 00:00
  assert.equal(keeps(start, '2026-09-30T21:00:00.000Z'), true);
});

test('incrementalScrapeStart: no recorded success or a future timestamp falls back to now', () => {
  const now = new Date('2026-01-15T10:00:00.000Z');
  assert.equal(incrementalScrapeStart(now, null).toISOString(), '2026-01-07T22:00:00.000Z'); // IST, UTC+2
  assert.equal(incrementalScrapeStart(now, new Date('2026-02-01T00:00:00.000Z')).toISOString(), '2026-01-07T22:00:00.000Z');
});

test('uncoveredDays: zero when the window reaches the last success or there is none', () => {
  assert.equal(uncoveredDays(new Date('2026-10-01T00:00:00.000Z'), null), 0);
  assert.equal(uncoveredDays(new Date('2026-10-01T00:00:00.000Z'), new Date('2026-10-02T00:00:00.000Z')), 0);
  assert.equal(uncoveredDays(new Date('2026-10-05T00:00:00.000Z'), new Date('2026-10-02T00:00:00.000Z')), 3);
});

test('classifyScrapeFailure: Cloudflare/provider blocks are distinct from timeouts and login failures', () => {
  assert.equal(
    classifyScrapeFailure('Scrape failed for provider isracard: GENERIC Failed to navigate to url https://digital.isracard.co.il/personalarea/Login, status code: 403'),
    'provider-blocked',
  );
  assert.equal(classifyScrapeFailure('GENERIC Failed to navigate to url https://digital.isracard.co.il, status code: 520'), 'provider-blocked');
  assert.equal(classifyScrapeFailure(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`), 'provider-blocked');
  assert.equal(classifyScrapeFailure('Scrape failed for provider isracard: GENERIC Navigation timeout of 120000 ms exceeded'), 'timeout');
  assert.equal(classifyScrapeFailure('Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!'), 'timeout');
  assert.equal(classifyScrapeFailure('Scrape failed for provider isracard: INVALID_PASSWORD'), 'login');
  assert.equal(classifyScrapeFailure('Waiting for selector `button` failed'), 'other');
});

test('staleSyncWarning: reports a provider stuck failing for more than two days', () => {
  const now = new Date('2026-10-07T01:00:00.000Z');
  assert.equal(staleSyncWarning('isracard', new Date('2026-10-06T01:00:00.000Z'), now), null);
  assert.equal(staleSyncWarning('isracard', null, now), null);
  const warning = staleSyncWarning('isracard', new Date('2026-09-28T01:04:00.000Z'), now);
  assert.match(warning ?? '', /isracard: no successful sync since 2026-09-28T01:04:00\.000Z \(8 days\)/);
});
