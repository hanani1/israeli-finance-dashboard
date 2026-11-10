import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deterministicId,
  EXCLUDED_CAL_IDS,
  mapRows,
  selectEligibleRows,
  summarize,
} from './riseupExpirationGapImporter';

const excluded = [...EXCLUDED_CAL_IDS][0]!;
const snapshot = {
  transactions: [
    { transactionId: 'cal-keep', transactionDate: '2024-05-03T00:00:00.000Z', billingDate: '2024-06-02T00:00:00.000Z', businessName: 'Cafe', amount: 12.5, isIncome: false, cashflowDate: '2024-05-01T00:00:00.000Z', source: 'cal', sourceType: 'creditCard' },
    { transactionId: 'cal-keep-2', transactionDate: '2024-05-04T00:00:00.000Z', businessName: 'Refund', amount: 7, isIncome: true, cashflowDate: '2024-05-01T00:00:00.000Z', source: 'cal', sourceType: 'creditCard' },
    { transactionId: excluded, transactionDate: '2024-05-05T00:00:00.000Z', businessName: 'Duplicate', amount: 10, isIncome: false, cashflowDate: '2024-05-01T00:00:00.000Z', source: 'cal', sourceType: 'creditCard' },
    { transactionId: 'cal-too-new', transactionDate: '2025-03-01T00:00:00.000Z', businessName: 'New', amount: 1, isIncome: false, cashflowDate: '2025-03-01T00:00:00.000Z', source: 'cal', sourceType: 'creditCard' },
    { transactionId: 'discount-keep', transactionDate: '2025-08-26T00:00:00.000Z', businessName: 'Market', amount: 33, isIncome: false, cashflowDate: '2025-08-01T00:00:00.000Z', source: 'discount', sourceType: 'checkingAccount' },
    { transactionId: 'discount-too-new', transactionDate: '2025-08-27T00:00:00.000Z', businessName: 'Current', amount: 2, isIncome: false, cashflowDate: '2025-08-01T00:00:00.000Z', source: 'discount', sourceType: 'checkingAccount' },
  ],
};
const calReport = {
  exactMatching: { unresolvedMonthly: { '2024-05': 2 }, providerHistoryEvidence: { affectedTransactionDateRange: { to: '2025-02-26' } } },
};
const discountReport = { input: { unmatchedCount: 1 } };
const comparisonReport = {
  unmatchedRiseup: [
    { riseup: snapshot.transactions[0] },
    { riseup: snapshot.transactions[1] },
    { riseup: snapshot.transactions[2] },
    { riseup: snapshot.transactions[4] },
  ],
};

test('selects only confirmed provider gaps and exclusions', () => {
  const rows = selectEligibleRows(snapshot, calReport, discountReport, comparisonReport);
  assert.deepEqual(rows.map((row) => row.transactionId).sort(), ['cal-keep', 'cal-keep-2', 'discount-keep']);
});

test('maps signs, dates, flow month, and safe unassigned provenance', () => {
  const selected = selectEligibleRows(snapshot, calReport, discountReport, comparisonReport);
  const rows = mapRows(selected, { visaCal: 'cal-account', discount: 'discount-account' });
  const expense = rows.find((row) => row.sourceId === 'cal-keep')!;
  const income = rows.find((row) => row.sourceId === 'cal-keep-2')!;
  assert.equal(expense.chargedAmount, -12.5);
  assert.equal(income.chargedAmount, 7);
  assert.equal(expense.processedDate?.toISOString(), '2024-06-02T00:00:00.000Z');
  assert.equal(expense.flowMonth, '2024-05');
  assert.equal(expense.rawCategory, 'riseup-expiration-gap:visaCal');
  assert.equal(expense.txnIdentifier, 'cal-keep');
});

test('uses stable ids and counts existing rows without changing category state', () => {
  const rows = mapRows(selectEligibleRows(snapshot, calReport, discountReport, comparisonReport), { visaCal: 'cal-account', discount: 'discount-account' });
  assert.equal(deterministicId(rows[0]!), deterministicId(rows[0]!));
  const summary = summarize(rows, new Set(['cal-account|cal-keep']));
  assert.deepEqual(summary, { selected: 3, alreadyPresent: 1, toInsert: 2, byProvider: { visaCal: 2, discount: 1 } });
});

test('fails closed when report and snapshot counts disagree', () => {
  assert.throws(() => selectEligibleRows(snapshot, { ...calReport, exactMatching: { ...calReport.exactMatching, unresolvedMonthly: { '2024-05': 3 } } }, discountReport, comparisonReport), /Cal eligible selection is 2; report confirms 3/);
});
