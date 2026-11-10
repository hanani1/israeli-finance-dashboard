/**
 * Optional database-backed parity test for the chat's typed tools: seeds a
 * SCRATCH database (name must start with fd_) including a same-sign refund
 * row, runs the tools through the read-only role, and compares with
 * flowClassification.classifyFlow. Skipped unless both URLs are set:
 *   CHAT_TEST_ADMIN_URL=postgresql://<owner>@127.0.0.1:5432/fd_xx
 *   CHAT_TEST_RO_URL=postgresql://<scratch_ro_role>:<pw>@127.0.0.1:5432/fd_xx
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CategoryGroup, PrismaClient } from '@prisma/client';
import { classifyFlow } from './flowClassification';
import { moneyToNumber } from './money';
import { planToolRequest } from './chatTools';

const adminUrl = process.env.CHAT_TEST_ADMIN_URL;
const roUrl = process.env.CHAT_TEST_RO_URL;
const scratch = (url: string | undefined) => !!url && /\/fd_[A-Za-z0-9_]+(\?|$)/.test(url);
const skip = !(scratch(adminUrl) && scratch(roUrl)) && 'set CHAT_TEST_ADMIN_URL / CHAT_TEST_RO_URL to fd_* scratch DBs';

const ROWS = [
  // id, chargedAmount, categoryId (1 expense, 2 income, 4 investment), isRefund, isTransfer
  ['r1', -250, 1, false, false], // purchase
  ['r2', -125, 1, true, false], // same-sign provider refund → +125 income
  ['r3', 40, 1, false, false], // positive refund → reduces spend
  ['r4', 10000, 2, false, false], // salary
  ['r5', -3000, 4, false, false], // investment: excluded
  ['r6', -500, null, false, true], // transfer: excluded
] as const;
const GROUPS: Record<number, CategoryGroup> = { 1: 'VARIABLE_EXPENSE', 2: 'INCOME', 4: 'INVESTMENT' };

test('typed tools match classifyFlow on a scratch DB, including an isRefund row', { skip }, async () => {
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  process.env.CHAT_DB_URL = roUrl;
  const { executeReadonlyQuery } = await import('./chatReadonlyDb');
  try {
    await admin.$executeRawUnsafe(`DELETE FROM "Transaction" WHERE id LIKE 'r_'`);
    await admin.$executeRawUnsafe(
      `INSERT INTO "User"(id,name,email) VALUES ('u-test','Test','t@example.test') ON CONFLICT DO NOTHING`,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "Account"(id,"userId",provider,"accountNumber","displayName","updatedAt") VALUES ('acc-test','u-test','x','0','Test',now()) ON CONFLICT DO NOTHING`,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "Category"(id,name,type,"group") VALUES (1,'Food','EXPENSE','VARIABLE_EXPENSE'),(2,'Salary','INCOME','INCOME'),(4,'Invest','INVESTMENT','INVESTMENT') ON CONFLICT DO NOTHING`,
    );
    for (const [id, amount, categoryId, isRefund, isTransfer] of ROWS) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "Transaction"(id,"accountId",date,"chargedAmount",description,"categoryId","isRefund","isTransfer") VALUES ($1,'acc-test','2026-10-10 21:00:00',$2,$1,$3,$4,$5)`,
        id, amount, categoryId, isRefund, isTransfer,
      );
    }

    let income = 0;
    let expenses = 0;
    for (const [, amount, categoryId, isRefund, isTransfer] of ROWS) {
      if (isTransfer || categoryId === 4) continue;
      const flow = classifyFlow(amount, categoryId === null ? null : (GROUPS[categoryId] ?? null), isRefund);
      income += moneyToNumber(flow.income);
      expenses += moneyToNumber(flow.expense);
    }
    assert.deepEqual([income, expenses], [10125, 210], 'sanity: refund counted as income');

    const run = async (name: string, args: Record<string, unknown>) => {
      const plan = planToolRequest({ name, args }, 'u-test');
      assert.ok(plan.ok);
      return plan.ok ? executeReadonlyQuery(plan.query) : [];
    };
    const monthly = await run('monthly_totals', { fromMonth: '2026-10', toMonth: '2026-10' });
    assert.equal(monthly.length, 1);
    assert.equal(Number(monthly[0]?.income), income);
    assert.equal(Number(monthly[0]?.expenses), expenses);

    const spending = await run('spending_by_category', { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(
      spending.map((row) => [row.category, Number(row.spent)]),
      [['Food', 210]],
      'refund row is not spend; positive refund nets out',
    );
    const merchants = await run('top_merchants', { from: '2026-10-01', to: '2026-10-31', direction: 'income' });
    assert.deepEqual(merchants.map((row) => row.merchant).sort(), ['r2', 'r4']);
  } finally {
    await admin.$executeRawUnsafe(`DELETE FROM "Transaction" WHERE id LIKE 'r_'`).catch(() => undefined);
    await admin.$disconnect();
  }
});
