/**
 * Safety class: WRITES DB (only with --apply, after a pg_dump backup; audit mode is read-only).
 *
 * Card #55 — pending → settled duplicates and related data fixes.
 *
 *   npx tsx scripts/apply-pending-settlement-fixes.ts                 # audit only (default)
 *   npx tsx scripts/apply-pending-settlement-fixes.ts --apply         # pg_dump backup, then apply
 *   npx tsx scripts/apply-pending-settlement-fixes.ts --apply --skip-backup
 *   options: --months=2026-08,2026-09   --audit=PAYBOX,תרומה   --report=path.md
 *
 * Audit mode writes a Markdown report (default debug-screenshots/, gitignored)
 * with: every proposed supersession and its survivor, every row in the audited
 * categories/merchants with its current and proposed visibility, the currency
 * backfill scope, and the totals for the requested months as they are now and
 * as they would be. Nothing is written to the database.
 *
 * Apply mode (explicit opt-in) first dumps the database with pg_dump to
 * db-dumps/<db>-<timestamp>-pre-card55.sql (do NOT git add it), then in order:
 *   1. backfills chargedCurrency / originalCurrency to ISO codes (₪ → ILS …);
 *   2. re-runs card-settlement detection (hides Cal forecast snapshots while
 *      detailed Cal rows exist);
 *   3. hides superseded pending rows via detectAndMarkSupersededPending.
 * Raw rows are never deleted; manual categories move to the surviving row.
 * It then prints the same totals after the change so before/after is verifiable.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { AccountKind } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { getSummaryTotals } from '../src/lib/services/analyticsService';
import { detectAndMarkCardSettlements } from '../src/lib/services/cardSettlementService';
import { isPendingSnapshotDescription } from '../src/lib/services/cardSettlementDetection';
import { localCalendarDay, localDateRange } from '../src/lib/services/localDay';
import { ZERO_MONEY, moneyToNumber, type Decimal, type MoneyInput } from '../src/lib/services/money';
import { detectSupersededPendingRows, normalizeCurrencyCode, type SupersededPending } from '../src/lib/services/pendingSettlement';
import { detectAndMarkSupersededPending } from '../src/lib/services/pendingSettlementService';

const APPLY = process.argv.includes('--apply');
const SKIP_BACKUP = process.argv.includes('--skip-backup');
const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const MONTHS = (arg('months') ?? '2026-08,2026-09').split(',').map((m) => m.trim()).filter(Boolean);
const AUDIT_TERMS = (arg('audit') ?? 'PAYBOX,תרומה,BIT').split(',').map((t) => t.trim()).filter(Boolean);
const REPORT = arg('report') ?? `debug-screenshots/card55-pending-settlement-${APPLY ? 'apply' : 'audit'}-${new Date().toISOString().slice(0, 10)}.md`;

type Row = Awaited<ReturnType<typeof loadRows>>[number];

async function loadRows() {
  return prisma.transaction.findMany({
    where: { isTransfer: false },
    select: {
      id: true, accountId: true, txnIdentifier: true, date: true, processedDate: true, chargedAmount: true,
      originalAmount: true, chargedCurrency: true, originalCurrency: true, description: true, memo: true, createdAt: true,
      isCardSettlement: true, categoryId: true, categorizationSource: true,
      account: { select: { provider: true, accountNumber: true, kind: true } },
      category: { select: { name: true } },
    },
    orderBy: [{ date: 'asc' }],
  });
}

function fmt(v: MoneyInput): string {
  // Report output is a display boundary (card #53).
  return moneyToNumber(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function monthRange(month: string): { from: string; to: string } {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
function line(r: Row, note = ''): string {
  const acct = `${r.account.provider} •${r.account.accountNumber.slice(-4)}`;
  const pd = r.processedDate ? localCalendarDay(r.processedDate) : '—';
  return `| ${localCalendarDay(r.date)} | ${pd} | ${acct} | ${fmt(r.chargedAmount)} | ${r.chargedCurrency} | ${r.originalAmount ?? ''} | ${r.txnIdentifier ?? '—'} | ${r.description.replace(/\|/g, '/')} | ${r.category?.name ?? '—'}/${r.categorizationSource} | ${r.isCardSettlement ? 'hidden' : 'visible'} | ${r.id.slice(0, 8)} ${note} |`;
}
const HEADER = ['| Date | Processed | Account | Charged | Cur | Original | Provider id | Description | Category/source | Now | Row |', '|---|---|---|---:|---|---:|---|---|---|---|---|'];

async function totalsFor(months: string[]): Promise<Record<string, { income: number; expenses: number; net: number }>> {
  const out: Record<string, { income: number; expenses: number; net: number }> = {};
  for (const month of months) out[month] = await getSummaryTotals(monthRange(month));
  return out;
}

async function categoryTotals(month: string): Promise<Map<string, number>> {
  const { from, to } = monthRange(month);
  const rows = await prisma.transaction.findMany({
    where: { isTransfer: false, isCardSettlement: false, chargedCurrency: 'ILS', date: localDateRange(from, to) },
    select: { chargedAmount: true, category: { select: { name: true } } },
  });
  const sums = new Map<string, Decimal>();
  for (const r of rows) {
    const k = r.category?.name ?? '(uncategorized)';
    sums.set(k, (sums.get(k) ?? ZERO_MONEY).add(r.chargedAmount));
  }
  return new Map([...sums].map(([k, v]) => [k, moneyToNumber(v)]));
}

function backup(): string {
  const url = process.env.DATABASE_URL ?? '';
  const dbName = url.replace(/\?.*$/, '').split('/').pop() ?? 'finance';
  mkdirSync('db-dumps', { recursive: true });
  const path = `db-dumps/${dbName}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}-pre-card55.sql`;
  const result = spawnSync('pg_dump', ['--file', path, url.replace(/\?schema=.*$/, '')], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`pg_dump failed (exit ${result.status}); refusing to apply without a backup.`);
  return path;
}

async function main(): Promise<void> {
  const rows = await loadRows();
  const cardRows = rows.filter((r) => r.account.kind === AccountKind.CARD && !r.isCardSettlement);
  const matches: SupersededPending[] = detectSupersededPendingRows(cardRows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const supersededIds = new Map(matches.map((m) => [m.pendingId, m] as const));

  const currencyScope = rows.filter((r) => normalizeCurrencyCode(r.chargedCurrency) !== r.chargedCurrency || (r.originalCurrency !== null && normalizeCurrencyCode(r.originalCurrency) !== r.originalCurrency));
  const currencyByValue = new Map<string, number>();
  for (const r of currencyScope) {
    const k = `${r.chargedCurrency} → ${normalizeCurrencyCode(r.chargedCurrency)}`;
    currencyByValue.set(k, (currencyByValue.get(k) ?? 0) + 1);
  }
  const hasDetailedCalRows = rows.some((r) => r.account.kind === AccountKind.CARD && r.account.provider === 'visaCal');
  const forecastVisible = rows.filter((r) => r.account.kind === AccountKind.BANK && isPendingSnapshotDescription(r.description) && !r.isCardSettlement);

  const before = await totalsFor(MONTHS);
  const beforeCats = new Map<string, Map<string, number>>();
  for (const m of MONTHS) beforeCats.set(m, await categoryTotals(m));

  const L: string[] = [];
  L.push(`# Card #55 — pending → settled duplicates (${APPLY ? 'APPLY' : 'AUDIT, no changes'})`, '', `Generated ${new Date().toISOString()} against \`${(process.env.DATABASE_URL ?? '').replace(/\/\/.*@/, '//***@')}\`.`, '');
  L.push('## Proposed changes', '');
  L.push(`1. Currency backfill: ${currencyScope.length} rows — ${[...currencyByValue].map(([k, n]) => `${k}: ${n}`).join('; ') || 'none'}.`);
  L.push(`2. Cal forecast snapshots ("חיוב לכרטיס"): ${forecastVisible.length} visible row(s) → ${hasDetailedCalRows ? 'hidden (detailed Cal rows exist, purchases already counted)' : 'unchanged (no detailed Cal rows)'}: ${forecastVisible.map((r) => `${localCalendarDay(r.date)} ${fmt(r.chargedAmount)}`).join(', ') || '—'}.`);
  const byRule = new Map<string, { n: number; sum: Decimal }>();
  for (const m of matches) {
    const r = byId.get(m.pendingId)!;
    const e = byRule.get(m.rule) ?? { n: 0, sum: ZERO_MONEY };
    e.n += 1; e.sum = e.sum.add(r.chargedAmount);
    byRule.set(m.rule, e);
  }
  L.push(`3. Superseded pending rows to hide: ${matches.length} — ${[...byRule].map(([k, v]) => `${k}: ${v.n} rows, ${fmt(v.sum)}`).join('; ') || 'none'}.`, '');

  L.push('## Audit: rows matching the audit terms, with proposed visibility', '');
  for (const term of AUDIT_TERMS) {
    const hits = rows.filter((r) => r.description.includes(term) || r.category?.name === term);
    L.push(`### ${term} (${hits.length} rows)`, '', ...HEADER);
    for (const r of hits) {
      const m = supersededIds.get(r.id);
      const note = m ? `→ HIDE (${m.rule}, kept ${m.settledId.slice(0, 8)})` : r.isCardSettlement ? '' : '→ keep';
      L.push(line(r, note));
    }
    L.push('');
  }

  L.push('## All proposed supersessions', '', ...HEADER);
  for (const m of matches) {
    const p = byId.get(m.pendingId)!, s = byId.get(m.settledId)!;
    L.push(line(p, `→ HIDE (${m.rule}); survivor ${s.id.slice(0, 8)} ${s.txnIdentifier ?? '—'} ${fmt(s.chargedAmount)} ${s.chargedCurrency} "${s.description}"`));
  }
  L.push('');

  const totalsTable = (title: string, t: Record<string, { income: number; expenses: number; net: number }>): string[] => [
    `### ${title}`, '', '| Month | Income | Expenses | Net |', '|---|---:|---:|---:|',
    ...Object.entries(t).map(([m, v]) => `| ${m} | ${fmt(v.income)} | ${fmt(v.expenses)} | ${fmt(v.net)} |`), '',
  ];
  L.push('## Totals (getSummaryTotals, dashboard convention)', '', ...totalsTable('Before', before));

  if (!APPLY) {
    L.push('_Audit only — run with `--apply` to execute (a pg_dump backup is taken first)._', '');
    await writeFile(REPORT, L.join('\n') + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ mode: 'audit', report: REPORT, currencyRows: currencyScope.length, forecastRowsToHide: hasDetailedCalRows ? forecastVisible.length : 0, supersessions: matches.length, byRule: Object.fromEntries(byRule), before }, null, 2));
    return;
  }

  const backupPath = SKIP_BACKUP ? '(skipped)' : backup();
  L.push(`Backup: \`${backupPath}\``, '');

  // 1. currency backfill (per distinct value → bounded number of statements)
  let currencyUpdated = 0;
  for (const value of new Set(rows.map((r) => r.chargedCurrency))) {
    const iso = normalizeCurrencyCode(value);
    if (iso === value) continue;
    const res = await prisma.transaction.updateMany({ where: { chargedCurrency: value }, data: { chargedCurrency: iso } });
    currencyUpdated += res.count;
  }
  for (const value of new Set(rows.map((r) => r.originalCurrency).filter((v): v is string => v !== null))) {
    const iso = normalizeCurrencyCode(value);
    if (iso === value) continue;
    await prisma.transaction.updateMany({ where: { originalCurrency: value }, data: { originalCurrency: iso } });
  }
  // 2. settlement / forecast snapshots
  const settlements = await detectAndMarkCardSettlements();
  // 3. pending supersession
  const pending = await detectAndMarkSupersededPending();

  const after = await totalsFor(MONTHS);
  L.push(...totalsTable('After', after));
  L.push('### Category deltas (after − before, visible ILS rows)', '');
  for (const m of MONTHS) {
    const b = beforeCats.get(m)!, a = await categoryTotals(m);
    const keys = new Set([...b.keys(), ...a.keys()]);
    L.push(`#### ${m}`, '', '| Category | Before | After | Δ |', '|---|---:|---:|---:|');
    for (const k of [...keys].sort()) {
      const bv = b.get(k) ?? 0, av = a.get(k) ?? 0;
      if (Math.abs(av - bv) > 0.004) L.push(`| ${k} | ${fmt(bv)} | ${fmt(av)} | ${fmt(av - bv)} |`);
    }
    L.push('');
  }
  await writeFile(REPORT, L.join('\n') + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ mode: 'apply', backup: backupPath, report: REPORT, currencyUpdated, settlements, supersededMarked: pending.supersededMarked, categoriesCarried: pending.categoriesCarried, before, after }, null, 2));
}

void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
