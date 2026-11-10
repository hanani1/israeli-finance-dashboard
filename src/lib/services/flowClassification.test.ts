import assert from 'node:assert/strict';
import test from 'node:test';
import { CategoryGroup } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { classifyFlow as classifyFlowDecimal, summarizeFlows } from './flowClassification';
import { moneyToNumber, sumMoney } from './money';

/** classifyFlow returns Decimals (card #53); compare as numbers here. */
function classifyFlow(...args: Parameters<typeof classifyFlowDecimal>) {
  const flow = classifyFlowDecimal(...args);
  return { income: moneyToNumber(flow.income), expense: moneyToNumber(flow.expense) };
}

// Policy (matches the monthly breakdown and RiseUp): only positive rows in an
// INCOME-group category are income. A positive row that is uncategorized or in
// an expense category is a refund/reversal and reduces expenses instead — it
// must never inflate income. Negative rows in an INCOME category (e.g. a
// salary clawback) reduce income rather than counting as an expense.

test('positive INCOME-category rows are income', () => {
  assert.deepEqual(classifyFlow(12000, CategoryGroup.INCOME, false), { income: 12000, expense: 0 });
});

test('a positive uncategorized row is a refund that reduces expenses, not income', () => {
  // The 28.95 Isracard "Victory Internet" credit from the September reconciliation.
  assert.deepEqual(classifyFlow(28.95, null, false), { income: 0, expense: -28.95 });
});

test('a positive row in an expense category is a refund of that spend', () => {
  assert.deepEqual(classifyFlow(150, CategoryGroup.VARIABLE_EXPENSE, false), { income: 0, expense: -150 });
});

test('negative rows are expenses whether or not categorized', () => {
  assert.deepEqual(classifyFlow(-80.5, null, false), { income: 0, expense: 80.5 });
  assert.deepEqual(classifyFlow(-80.5, CategoryGroup.RECURRING_EXPENSE, false), { income: 0, expense: 80.5 });
});

test('a negative INCOME-category row reduces income', () => {
  assert.deepEqual(classifyFlow(-500, CategoryGroup.INCOME, false), { income: -500, expense: 0 });
});

test('summarizeFlows nets the classified rows into income, expenses and net', () => {
  const summary = summarizeFlows([
    { chargedAmount: 40472.04, group: CategoryGroup.INCOME, isRefund: false },
    { chargedAmount: 28.95, group: null, isRefund: false },
    { chargedAmount: -100, group: null, isRefund: false },
    { chargedAmount: -86110.4, group: CategoryGroup.VARIABLE_EXPENSE, isRefund: false },
  ]);
  assert.deepEqual(summary, {
    income: 40472.04,
    expenses: 86181.45,
    net: -45709.41,
  });
});

// Card #60 — semantic refund flag. A provider can report a refund/reversal
// with the SAME sign as the purchase (raw -125 after a -250 purchase). The raw
// amount is preserved; Transaction.isRefund marks its semantic flow: it is
// +|amount| income, and never an expense, whatever its category.

test('an isRefund row with a negative raw amount is +|amount| income, not an expense', () => {
  assert.deepEqual(classifyFlow(-125, CategoryGroup.VARIABLE_EXPENSE, true), { income: 125, expense: 0 });
  assert.deepEqual(classifyFlow(-125, null, true), { income: 125, expense: 0 });
});

test('isRefund overrides the category group (an INCOME category does not double-flip it)', () => {
  assert.deepEqual(classifyFlow(-125, CategoryGroup.INCOME, true), { income: 125, expense: 0 });
});

test('Pasta Bar: -250 purchase + -125 isRefund reversal = two rows, 250 expense, 125 income, net -125', () => {
  const summary = summarizeFlows([
    { chargedAmount: -250, group: CategoryGroup.VARIABLE_EXPENSE, isRefund: false },
    { chargedAmount: -125, group: CategoryGroup.VARIABLE_EXPENSE, isRefund: true },
  ]);
  assert.deepEqual(summary, { income: 125, expenses: 250, net: -125 });
});

test('MAX: a positive provider refund (-850 then +850, no flag) still nets the expense to zero', () => {
  const summary = summarizeFlows([
    { chargedAmount: -850, group: CategoryGroup.VARIABLE_EXPENSE, isRefund: false },
    { chargedAmount: 850, group: null, isRefund: false },
  ]);
  assert.deepEqual(summary, { income: 0, expenses: 0, net: 0 });
});

test('classification is linear, so grouped (summed) isRefund rows classify like the rows one by one', () => {
  const rows = [-125, -40.5, -9.99];
  const oneByOne = sumMoney(rows.map((amount) => classifyFlowDecimal(amount, null, true).income));
  const grouped = classifyFlowDecimal(sumMoney(rows), null, true).income;
  assert.equal(oneByOne.toString(), grouped.toString());
  assert.equal(grouped.toString(), '175.49');
});

test('summarizeFlows is exact on Decimal input and on float-noisy legacy numbers (card #53)', () => {
  const D = (v: string) => new Prisma.Decimal(v);
  assert.deepEqual(
    summarizeFlows([
      { chargedAmount: D('0.10'), group: CategoryGroup.INCOME, isRefund: false },
      { chargedAmount: D('0.20'), group: CategoryGroup.INCOME, isRefund: false },
      { chargedAmount: D('-0.30'), group: null, isRefund: false },
    ]),
    { income: 0.3, expenses: 0.3, net: 0 },
  );
  // A float sum such as 0.1 + 0.2 (0.30000000000000004) is read to the agorot.
  assert.deepEqual(summarizeFlows([{ chargedAmount: 0.1 + 0.2, group: CategoryGroup.INCOME, isRefund: false }]), {
    income: 0.3,
    expenses: 0,
    net: 0.3,
  });
});
