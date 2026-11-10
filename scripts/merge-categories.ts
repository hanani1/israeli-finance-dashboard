/**
 * Safety class: WRITES DB (only with --apply or --revert, after a pg_dump backup; audit by default).
 *
 * Card #57 — merge categories (אחר → הוצאות משתנות, פנאי → טיולים ופנאי),
 * including historical data.
 *
 *   npx tsx scripts/merge-categories.ts                  # audit only (default), writes a report
 *   npx tsx scripts/merge-categories.ts --apply          # pg_dump backup, then apply
 *   npx tsx scripts/merge-categories.ts --apply --skip-backup
 *   npx tsx scripts/merge-categories.ts --revert=debug-screenshots/category-merge-<ts>.json
 *
 * The merges themselves live in src/lib/services/categoryMerge.ts and are
 * resolved by name + type + group (ids differ between databases). Per merge:
 *   - transactions: categoryId → target; categorizationSource is untouched
 *     (manual stays manual);
 *   - rules: re-pointed to the target; a rule whose pattern already exists
 *     for the target is deleted as a duplicate (reported);
 *   - budgets: moved when the target has none; if both have one the conflict
 *     is reported and NOTHING for that merge is changed (never overwrite);
 *   - the source category is deleted only once nothing references it.
 * Apply writes a JSON file listing every moved transaction / rule / budget
 * with its previous category so --revert can restore the exact prior state
 * (it recreates the source category with its original id, color, type, group).
 * The pg_dump is the belt-and-braces fallback.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { CategoryGroup, CategoryType } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { getMonthlyBreakdown } from '../src/lib/services/analyticsService';
import { money, moneyToNumber } from '../src/lib/services/money';
import { planCategoryMerges, type MergeStep } from '../src/lib/services/categoryMerge';

const APPLY = process.argv.includes('--apply');
const SKIP_BACKUP = process.argv.includes('--skip-backup');
const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const REVERT = arg('revert');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const REPORT = arg('report') ?? `debug-screenshots/category-merge-${APPLY ? 'apply' : 'audit'}-${STAMP}.md`;
const UNDO = `debug-screenshots/category-merge-${STAMP}.json`;

interface UndoFile {
  createdAt: string;
  categories: Array<{ id: number; name: string; type: CategoryType; group: CategoryGroup; color: string }>;
  transactions: Array<{ id: string; categoryId: number }>;
  rules: Array<{ id: number; categoryId: number }>;
  deletedRules: Array<{ id: number; pattern: string; categoryId: number; priority: number; matchMemo: boolean; createdAt: string }>;
  budgets: Array<{ id: number; categoryId: number }>;
}

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function backup(): string {
  const url = process.env.DATABASE_URL ?? '';
  const dbName = url.replace(/\?.*$/, '').split('/').pop() ?? 'finance';
  mkdirSync('db-dumps', { recursive: true });
  const path = `db-dumps/${dbName}-${STAMP}-pre-card57.sql`;
  const result = spawnSync('pg_dump', ['--file', path, url.replace(/\?schema=.*$/, '')], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`pg_dump failed (exit ${result.status}); refusing to apply without a backup.`);
  return path;
}

async function categoryStats(categoryId: number) {
  const [txn, manual, rules, budgets] = await Promise.all([
    prisma.transaction.aggregate({ where: { categoryId }, _count: true, _sum: { chargedAmount: true } }),
    prisma.transaction.count({ where: { categoryId, categorizationSource: 'MANUAL' } }),
    prisma.categorizationRule.findMany({ where: { categoryId }, orderBy: { id: 'asc' } }),
    prisma.budget.findMany({ where: { categoryId } }),
  ]);
  return { count: txn._count, sum: moneyToNumber(txn._sum.chargedAmount ?? 0), manual, rules, budgets };
}

async function recentMonths(n = 3): Promise<string[]> {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

async function monthlyTotals(months: string[]): Promise<Record<string, { income: number; expense: number; net: number }>> {
  const out: Record<string, { income: number; expense: number; net: number }> = {};
  for (const m of months) {
    const b = await getMonthlyBreakdown({ month: m });
    out[m] = { income: b.totalIncome, expense: b.totalExpense, net: b.net };
  }
  return out;
}

async function revert(path: string): Promise<void> {
  const undo = JSON.parse(await readFile(path, 'utf8')) as UndoFile;
  await prisma.$transaction(async (tx) => {
    for (const c of undo.categories) {
      await tx.category.upsert({ where: { id: c.id }, update: {}, create: c });
    }
    for (const r of undo.deletedRules) {
      await tx.categorizationRule.create({ data: { id: r.id, pattern: r.pattern, categoryId: r.categoryId, priority: r.priority, matchMemo: r.matchMemo, createdAt: new Date(r.createdAt) } });
    }
    for (const r of undo.rules) await tx.categorizationRule.update({ where: { id: r.id }, data: { categoryId: r.categoryId } });
    for (const b of undo.budgets) await tx.budget.update({ where: { id: b.id }, data: { categoryId: b.categoryId } });
    // Chunked to stay under parameter limits.
    const byCat = new Map<number, string[]>();
    for (const t of undo.transactions) byCat.set(t.categoryId, [...(byCat.get(t.categoryId) ?? []), t.id]);
    for (const [categoryId, ids] of byCat) {
      for (let i = 0; i < ids.length; i += 500) {
        await tx.transaction.updateMany({ where: { id: { in: ids.slice(i, i + 500) } }, data: { categoryId } });
      }
    }
  });
  console.log(JSON.stringify({ mode: 'revert', from: path, categoriesRestored: undo.categories.length, transactionsRestored: undo.transactions.length, rulesRestored: undo.rules.length + undo.deletedRules.length, budgetsRestored: undo.budgets.length }, null, 2));
}

async function main(): Promise<void> {
  if (REVERT) return revert(REVERT);

  const categories = await prisma.category.findMany({ select: { id: true, name: true, type: true, group: true, color: true } });
  const plan = planCategoryMerges(categories);
  const months = await recentMonths();

  const L: string[] = [];
  L.push(`# Card #57 — category merge (${APPLY ? 'APPLY' : 'AUDIT, no changes'})`, '', `Generated ${new Date().toISOString()} against \`${(process.env.DATABASE_URL ?? '').replace(/\/\/.*@/, '//***@')}\`.`, '');
  if (plan.skipped.length) {
    L.push('## Skipped merges', '', ...plan.skipped.map((s) => `- ${s.merge.source.name} (${s.merge.source.group}) → ${s.merge.target.name}: **${s.reason}**`), '');
  }

  type StepReport = { step: MergeStep; before: { source: Awaited<ReturnType<typeof categoryStats>>; target: Awaited<ReturnType<typeof categoryStats>> }; budgetConflict: boolean; duplicateRules: string[] };
  const reports: StepReport[] = [];
  for (const step of plan.steps) {
    const [source, target] = await Promise.all([categoryStats(step.source.id), categoryStats(step.target.id)]);
    const targetPatterns = new Set(target.rules.map((r) => r.pattern));
    reports.push({
      step,
      before: { source, target },
      budgetConflict: source.budgets.length > 0 && target.budgets.length > 0,
      duplicateRules: source.rules.filter((r) => targetPatterns.has(r.pattern)).map((r) => r.pattern),
    });
  }

  L.push('## Before', '', '| Merge | Category | Id | Transactions | Manual | Sum | Rules | Budgets |', '|---|---|---:|---:|---:|---:|---:|---:|');
  for (const r of reports) {
    const m = `${r.step.source.name} → ${r.step.target.name}`;
    L.push(`| ${m} | source: ${r.step.source.name} | ${r.step.source.id} | ${r.before.source.count} | ${r.before.source.manual} | ${fmt(r.before.source.sum)} | ${r.before.source.rules.length} | ${r.before.source.budgets.length} |`);
    L.push(`| ${m} | target: ${r.step.target.name} | ${r.step.target.id} | ${r.before.target.count} | ${r.before.target.manual} | ${fmt(r.before.target.sum)} | ${r.before.target.rules.length} | ${r.before.target.budgets.length} |`);
  }
  L.push('');
  for (const r of reports) {
    if (r.budgetConflict) L.push(`- **Budget conflict** ${r.step.source.name} → ${r.step.target.name}: both categories have a budget (source ${r.before.source.budgets.map((b) => b.amount).join(', ')}; target ${r.before.target.budgets.map((b) => b.amount).join(', ')}). This merge is NOT applied until resolved.`);
    if (r.duplicateRules.length) L.push(`- Rules on ${r.step.source.name} whose pattern already exists on the target (will be deleted as duplicates): ${r.duplicateRules.map((p) => `"${p}"`).join(', ')}`);
    for (const rule of r.before.source.rules.filter((x) => !r.duplicateRules.includes(x.pattern))) L.push(`- Rule #${rule.id} "${rule.pattern}" → re-pointed to ${r.step.target.name}`);
  }
  const otherIncome = categories.filter((c) => c.name.trim() === 'אחר' && c.type === 'INCOME');
  if (otherIncome.length) L.push(`- Note: INCOME category "אחר" (id ${otherIncome.map((c) => c.id).join(', ')}) is intentionally untouched — the card asks for the expense "Other" only.`);
  L.push('');

  const totalsBefore = await monthlyTotals(months);
  L.push('## Monthly totals (getMonthlyBreakdown) before', '', '| Month | Income | Expense | Net |', '|---|---:|---:|---:|', ...months.map((m) => `| ${m} | ${fmt(totalsBefore[m]!.income)} | ${fmt(totalsBefore[m]!.expense)} | ${fmt(totalsBefore[m]!.net)} |`), '');

  if (!APPLY) {
    L.push('_Audit only — run with `--apply` to execute (a pg_dump backup is taken first)._');
    mkdirSync('debug-screenshots', { recursive: true });
    await writeFile(REPORT, L.join('\n') + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ mode: 'audit', report: REPORT, steps: reports.map((r) => ({ from: `${r.step.source.name}#${r.step.source.id}`, to: `${r.step.target.name}#${r.step.target.id}`, transactions: r.before.source.count, manual: r.before.source.manual, sum: r.before.source.sum, rules: r.before.source.rules.length, budgets: r.before.source.budgets.length, budgetConflict: r.budgetConflict })), skipped: plan.skipped }, null, 2));
    return;
  }

  const backupPath = SKIP_BACKUP ? '(skipped)' : backup();
  const undo: UndoFile = { createdAt: new Date().toISOString(), categories: [], transactions: [], rules: [], deletedRules: [], budgets: [] };
  const applied: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const r of reports) {
      if (r.budgetConflict) continue;
      const { source, target } = r.step;
      const txns = await tx.transaction.findMany({ where: { categoryId: source.id }, select: { id: true } });
      undo.transactions.push(...txns.map((t) => ({ id: t.id, categoryId: source.id })));
      await tx.transaction.updateMany({ where: { categoryId: source.id }, data: { categoryId: target.id } });

      for (const rule of r.before.source.rules) {
        if (r.duplicateRules.includes(rule.pattern)) {
          undo.deletedRules.push({ id: rule.id, pattern: rule.pattern, categoryId: rule.categoryId, priority: rule.priority, matchMemo: rule.matchMemo, createdAt: rule.createdAt.toISOString() });
          await tx.categorizationRule.delete({ where: { id: rule.id } });
        } else {
          undo.rules.push({ id: rule.id, categoryId: source.id });
          await tx.categorizationRule.update({ where: { id: rule.id }, data: { categoryId: target.id } });
        }
      }
      for (const b of r.before.source.budgets) {
        undo.budgets.push({ id: b.id, categoryId: source.id });
        await tx.budget.update({ where: { id: b.id }, data: { categoryId: target.id } });
      }
      const full = categories.find((c) => c.id === source.id)!;
      undo.categories.push({ id: full.id, name: full.name, type: full.type, group: full.group, color: full.color });
      await tx.category.delete({ where: { id: source.id } });
      applied.push(`${source.name}#${source.id} → ${target.name}#${target.id}: ${txns.length} transactions`);
    }
  });

  mkdirSync('debug-screenshots', { recursive: true });
  await writeFile(UNDO, JSON.stringify(undo, null, 2) + '\n', { mode: 0o600 });

  L.push(`Backup: \`${backupPath}\`  ·  Undo file: \`${UNDO}\` (\`--revert=${UNDO}\`)`, '');
  L.push('## After', '', '| Target | Id | Transactions | Manual | Sum | Rules | Budgets |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const r of reports) {
    if (r.budgetConflict) continue;
    const after = await categoryStats(r.step.target.id);
    const expectedCount = r.before.source.count + r.before.target.count;
    const expectedSum = moneyToNumber(money(r.before.source.sum).add(r.before.target.sum));
    const ok = after.count === expectedCount && Math.abs(after.sum - expectedSum) < 0.005 && after.manual === r.before.source.manual + r.before.target.manual;
    L.push(`| ${r.step.target.name} | ${r.step.target.id} | ${after.count} (expected ${expectedCount}) | ${after.manual} | ${fmt(after.sum)} (expected ${fmt(expectedSum)}) | ${after.rules.length} | ${after.budgets.length} | ${ok ? '✓' : '**MISMATCH**'}`);
  }
  const remaining = await prisma.category.findMany({ where: { OR: plan.steps.map((s) => ({ name: s.source.name, type: s.source.type, group: s.source.group })) } });
  L.push('', `Retired categories still present: ${remaining.length === 0 ? 'none ✓' : remaining.map((c) => `${c.name}#${c.id}`).join(', ')}`, '');
  const totalsAfter = await monthlyTotals(months);
  L.push('## Monthly totals after (must equal before — merges stay within VARIABLE_EXPENSE)', '', '| Month | Income | Expense | Net | Δ expense |', '|---|---:|---:|---:|---:|', ...months.map((m) => `| ${m} | ${fmt(totalsAfter[m]!.income)} | ${fmt(totalsAfter[m]!.expense)} | ${fmt(totalsAfter[m]!.net)} | ${fmt(totalsAfter[m]!.expense - totalsBefore[m]!.expense)} |`), '');
  await writeFile(REPORT, L.join('\n') + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ mode: 'apply', backup: backupPath, undo: UNDO, report: REPORT, applied, skippedForBudgetConflict: reports.filter((r) => r.budgetConflict).map((r) => r.step.source.name), totalsBefore, totalsAfter }, null, 2));
}

void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
