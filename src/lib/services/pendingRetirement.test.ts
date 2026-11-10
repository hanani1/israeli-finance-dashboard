/**
 * Card #49: pending rows the provider stopped returning are retired (hidden,
 * never deleted) once they are older than the provider's pending horizon, and
 * restored if the provider returns them again.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PENDING_HORIZON_DAYS,
  isProviderPending,
  pendingHorizonDays,
  selectPendingToRetire,
  selectRetiredToRestore,
  type PendingRetirementRow,
} from './pendingRetirement';

// 2026-11-03 12:00 Israel time.
const NOW = new Date('2026-11-03T10:00:00.000Z');

/** Israel-local midnight of a yyyy-MM-dd day (IST, UTC+2, in Oct/Nov 2026 after DST). */
function day(label: string): Date {
  return new Date(`${label}T00:00:00+02:00`);
}

function row(partial: Partial<PendingRetirementRow> & { id: string }): PendingRetirementRow {
  return {
    date: day('2026-10-01'),
    providerStatus: 'pending',
    txnIdentifier: null,
    isCardSettlement: false,
    pendingRetiredAt: null,
    ...partial,
  };
}

test('isProviderPending trusts the persisted scraper status', () => {
  assert.equal(isProviderPending(row({ id: 'a', providerStatus: 'pending', txnIdentifier: '1' }), 'max'), true);
  assert.equal(isProviderPending(row({ id: 'b', providerStatus: 'completed' }), 'visaCal'), false);
});

test('isProviderPending: legacy rows without a status are pending only for Cal rows without an identifier', () => {
  // visa-cal.js sets identifier only on completed rows, so a no-id Cal row was pending.
  assert.equal(isProviderPending(row({ id: 'a', providerStatus: null, txnIdentifier: null }), 'visaCal'), true);
  assert.equal(isProviderPending(row({ id: 'b', providerStatus: null, txnIdentifier: '123' }), 'visaCal'), false);
  // No reliable legacy signal for other providers: never guess.
  assert.equal(isProviderPending(row({ id: 'c', providerStatus: null, txnIdentifier: null }), 'max'), false);
  assert.equal(isProviderPending(row({ id: 'd', providerStatus: null, txnIdentifier: null }), 'isracard'), false);
});

test('pendingHorizonDays has a conservative default for every provider', () => {
  assert.equal(pendingHorizonDays('visaCal'), DEFAULT_PENDING_HORIZON_DAYS);
  assert.equal(pendingHorizonDays('somethingNew'), DEFAULT_PENDING_HORIZON_DAYS);
  assert.ok(DEFAULT_PENDING_HORIZON_DAYS >= 14);
});

test('a pending row older than the horizon that the latest scrape did not return is retired', () => {
  const rows = [row({ id: 'phantom', date: day('2026-09-15') })];
  assert.deepEqual(selectPendingToRetire(rows, new Set(), 'visaCal', NOW), ['phantom']);
});

test('a pending row the provider still returns is never retired, however old', () => {
  const rows = [row({ id: 'still-pending', date: day('2026-08-01') })];
  assert.deepEqual(selectPendingToRetire(rows, new Set(['still-pending']), 'visaCal', NOW), []);
});

test('a pending row younger than the horizon is kept even when absent (provider glitch / not yet settled)', () => {
  const horizon = pendingHorizonDays('visaCal');
  const recent = new Date(day('2026-11-03').getTime() - horizon * 86_400_000);
  const rows = [
    row({ id: 'edge', date: recent }), // exactly `horizon` days old: kept
    row({ id: 'yesterday', date: day('2026-11-02') }),
  ];
  assert.deepEqual(selectPendingToRetire(rows, new Set(), 'visaCal', NOW), []);
});

test('completed rows, already-hidden rows and non-pending legacy rows are never retired', () => {
  const rows = [
    row({ id: 'completed', providerStatus: 'completed', txnIdentifier: '9', date: day('2026-09-01') }),
    row({ id: 'hidden', isCardSettlement: true, date: day('2026-09-01') }),
    row({ id: 'legacy-max', providerStatus: null, date: day('2026-09-01') }),
  ];
  assert.deepEqual(selectPendingToRetire(rows, new Set(), 'max', NOW), []);
});

test('pending → settled transition with a changed amount (tip / FX): the orphaned pending row is retired', () => {
  // The settled row (₪195 for a €50 purchase) is returned; the €50 pending snapshot is not.
  const rows = [
    row({ id: 'pending-eur', date: day('2026-10-05') }),
    row({ id: 'settled', providerStatus: 'completed', txnIdentifier: '77', date: day('2026-10-05') }),
  ];
  assert.deepEqual(selectPendingToRetire(rows, new Set(['settled']), 'visaCal', NOW), ['pending-eur']);
});

test('a retired row the provider returns again is restored; manually hidden rows are not touched', () => {
  const rows = [
    row({ id: 'retired-back', isCardSettlement: true, pendingRetiredAt: day('2026-10-20') }),
    row({ id: 'retired-gone', isCardSettlement: true, pendingRetiredAt: day('2026-10-20') }),
    row({ id: 'hidden-by-matcher', isCardSettlement: true, pendingRetiredAt: null }),
  ];
  assert.deepEqual(
    selectRetiredToRestore(rows, new Set(['retired-back', 'hidden-by-matcher'])),
    ['retired-back'],
  );
});
