import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInvestmentBreakdown,
  investmentHouseFor,
  OTHER_HOUSE,
  type InvestmentTxn,
} from './investmentAnalysis';

function txn(
  date: string,
  chargedAmount: number,
  description: string,
  memo: string | null = null,
): InvestmentTxn {
  return { date: new Date(date), chargedAmount, description, memo };
}

test('investmentHouseFor resolves houses from the memo (real transfer shapes)', () => {
  // Typical shape: description is a generic transfer, the house lives in the memo.
  assert.equal(
    investmentHouseFor('העברה דיגיטל', 'העברה אל: אלטשולר שחם 10-800-000000001 השקעה'),
    'אלטשולר שחם',
  );
  assert.equal(
    investmentHouseFor('העברה דיגיטל', 'העברה אל: מיטב דש 10-800-000000002 מספר חשבון 000003'),
    'מיטב דש',
  );
  assert.equal(
    investmentHouseFor('מהבינלאומי ס-י', 'העברה מאת: מיטב טרייד בע"מ 00-000-000000000 העברה'),
    'מיטב טרייד',
  );
});

test('investmentHouseFor resolves houses from the description', () => {
  assert.equal(investmentHouseFor('הע. למיטב טרייד בע בסניף 00-000', null), 'מיטב טרייד');
  assert.equal(investmentHouseFor('קנית ני"ע', null), 'תיק ני"ע (בנק)');
  assert.equal(investmentHouseFor('מכירת ני"ע', null), 'תיק ני"ע (בנק)');
});

test('investmentHouseFor falls back to "other" for unknown descriptions', () => {
  assert.equal(investmentHouseFor('הפקדה כלשהי', null), OTHER_HOUSE);
  assert.equal(investmentHouseFor('הפקדה', 'ללא יעד מוכר'), OTHER_HOUSE);
});

test('buildInvestmentBreakdown: deposits minus withdrawals across all time', () => {
  const breakdown = buildInvestmentBreakdown([
    txn('2023-12-17T00:00:00Z', -20000, 'העברה דיגיטל', 'העברה אל: אלטשולר שחם השקעה'),
    txn('2024-02-13T00:00:00Z', -25000, 'העברה דיגיטל', 'העברה אל: מיטב דש חשבון'),
    txn('2024-02-19T00:00:00Z', 25000, 'מהבינלאומי ס-י', 'העברה מאת: מיטב טרייד בע"מ'),
  ]);
  assert.equal(breakdown.totalDeposits, 45000);
  assert.equal(breakdown.totalWithdrawals, 25000);
  assert.equal(breakdown.totalInvested, 20000);
  assert.equal(breakdown.count, 3);
});

test('buildInvestmentBreakdown groups per house with counts', () => {
  const breakdown = buildInvestmentBreakdown([
    txn('2023-11-07T00:00:00Z', -10000.5, 'קנית ני"ע'),
    txn('2024-02-28T00:00:00Z', 4000.25, 'מכירת ני"ע'),
    txn('2023-12-17T00:00:00Z', -20000, 'העברה דיגיטל', 'העברה אל: אלטשולר שחם השקעה'),
  ]);
  const securities = breakdown.houses.find((h) => h.house === 'תיק ני"ע (בנק)');
  assert.deepEqual(securities, {
    house: 'תיק ני"ע (בנק)',
    deposits: 10000.5,
    withdrawals: 4000.25,
    net: 6000.25,
    count: 2,
  });
  const altshuler = breakdown.houses.find((h) => h.house === 'אלטשולר שחם');
  assert.equal(altshuler?.net, 20000);
  // Sorted by net descending: Altshuler (20000) before the securities account.
  assert.deepEqual(
    breakdown.houses.map((h) => h.house),
    ['אלטשולר שחם', 'תיק ני"ע (בנק)'],
  );
});

test('buildInvestmentBreakdown buckets by month in ascending order', () => {
  const breakdown = buildInvestmentBreakdown([
    txn('2024-02-13T00:00:00Z', -25000, 'העברה דיגיטל', 'מיטב דש'),
    txn('2023-12-17T00:00:00Z', -20000, 'העברה דיגיטל', 'אלטשולר שחם'),
    txn('2024-02-19T00:00:00Z', 25000, 'מהבינלאומי ס-י', 'מיטב טרייד'),
  ]);
  assert.deepEqual(breakdown.monthly, [
    { month: '2023-12', deposits: 20000, withdrawals: 0, net: 20000 },
    { month: '2024-02', deposits: 25000, withdrawals: 25000, net: 0 },
  ]);
});

test('buildInvestmentBreakdown handles empty input and negative net', () => {
  assert.deepEqual(buildInvestmentBreakdown([]), {
    totalDeposits: 0,
    totalWithdrawals: 0,
    totalInvested: 0,
    count: 0,
    houses: [],
    monthly: [],
  });
  // Withdrew more than deposited — net invested goes negative, not clamped.
  const negative = buildInvestmentBreakdown([txn('2024-09-03T00:00:00Z', 5000, 'מכירת ני"ע')]);
  assert.equal(negative.totalInvested, -5000);
});
