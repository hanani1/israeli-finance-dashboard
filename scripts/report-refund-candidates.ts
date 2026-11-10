/**
 * Safety class: READ-ONLY.
 *
 * Card #60 — READ-ONLY report of possible same-sign provider refunds.
 *
 *   DATABASE_URL=... npx tsx scripts/report-refund-candidates.ts \
 *     [--from=2026-06-01] [--to=2026-10-31] [--account=<accountId>] [--json]
 *
 * Lists visible negative rows that look like a refund/partial reversal of an
 * earlier purchase on the same account (see src/lib/services/refundCandidates.ts
 * for the conservative evidence rules), with confidence `likely` or
 * `ambiguous`. Nothing is written to the database: a human reviews the list
 * and marks real refunds in the UI (transaction details → "Mark as refund")
 * or with scripts/mark-transaction-refund.ts. Default window: last 180 days.
 */
import { prisma } from '../src/lib/db';
import { localCalendarDay } from '../src/lib/services/localDay';
import { moneyToNumber, type MoneyInput } from '../src/lib/services/money';
import { findRefundCandidates } from '../src/lib/services/refundCandidateService';

const KNOWN = new Set(['from', 'to', 'account', 'json']);
for (const a of process.argv.slice(2)) {
  const name = a.replace(/^--/, '').split('=')[0] ?? '';
  if (!a.startsWith('--') || !KNOWN.has(name)) {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function fmt(v: MoneyInput): string {
  return moneyToNumber(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main(): Promise<void> {
  const from = arg('from') ?? localCalendarDay(new Date(Date.now() - 180 * 86_400_000));
  const to = arg('to');
  if (!DAY.test(from) || (to !== undefined && !DAY.test(to))) {
    throw new Error('--from/--to must be yyyy-MM-dd');
  }
  const { rows, candidates } = await findRefundCandidates({ from, to, accountId: arg('account') });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const describe = (id: string): string => {
    const r = byId.get(id);
    if (!r) return id;
    return `${localCalendarDay(r.date)} ${r.account.provider} •${r.account.accountNumber.slice(-4)} ${fmt(r.chargedAmount)} ${r.chargedCurrency} id=${r.txnIdentifier ?? '—'} "${r.description}" [${r.id}]`;
  };

  const likely = candidates.filter((c) => c.confidence === 'likely').length;
  const ambiguous = candidates.length - likely;
  const marked = rows.filter((r) => r.isRefund).length;

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ from, to: to ?? null, rowsScanned: rows.length, alreadyMarked: marked, likely, ambiguous, candidates }, null, 2));
    return;
  }

  console.log(`Same-sign refund candidates ${from} .. ${to ?? 'now'} — READ-ONLY, nothing was changed.`);
  console.log(`Rows scanned: ${rows.length}; already marked isRefund: ${marked}; candidates: ${candidates.length} (likely ${likely}, ambiguous ${ambiguous}).`);
  for (const c of candidates) {
    console.log('');
    console.log(`[${c.confidence}] evidence=${c.evidence.join('+')}`);
    console.log(`  refund?   ${describe(c.refundId)}`);
    for (const id of c.originalIds) console.log(`  original? ${describe(id)}`);
  }
  if (candidates.length > 0) {
    console.log('');
    console.log('Review each one. To mark a real refund: transaction details → "Mark as refund", or');
    console.log('  npx tsx scripts/mark-transaction-refund.ts --id=<id> --backup=<fresh pg_dump>   (dry run; add --apply --confirm-db=<db>)');
  }
}

void main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
