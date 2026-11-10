/**
 * Child-process probe for timeZoneIndependence.test.ts. Run with an arbitrary
 * TZ; prints JSON describing how fixture provider rows are parsed before and
 * after loading the ingestion module (which pins the process time zone).
 *
 * The parse calls mirror israeli-bank-scrapers 6.12.1 exactly, using the
 * library's own moment instance:
 *   discount.js:26            moment(OperationDate, 'YYYYMMDD')
 *   base-isracard-amex.js:160 moment(dateStr, 'DD/MM/YYYY')
 *   max.js:190                moment(purchaseDate)
 *   visa-cal.js:182/190       moment(trnPurchaseDate), new Date(debCrdDate)
 */
import { createRequire } from 'node:module';

type MomentLike = { toISOString(): string };
type MomentFn = (input: string, format?: string) => MomentLike;

const scrapersRequire = createRequire(require.resolve('israeli-bank-scrapers'));
const moment = scrapersRequire('moment') as MomentFn;

const ACCOUNT_ID = 'fixture-account';

const FIXTURES = [
  { provider: 'discount', parse: () => moment('20260201', 'YYYYMMDD').toISOString(), amount: -4321.5, description: 'משכנתא' },
  { provider: 'isracard', parse: () => moment('01/09/2026', 'DD/MM/YYYY').toISOString(), amount: -120, description: 'סופר' },
  { provider: 'max', parse: () => moment('2026-03-01T00:00:00').toISOString(), amount: -59.9, description: 'MAX FIXTURE' },
  { provider: 'visaCal', parse: () => moment('2026-10-01T00:00:00').toISOString(), amount: -200, description: 'CAL FIXTURE' },
  { provider: 'visaCal-processed', parse: () => new Date('2026-12-01T00:00:00').toISOString(), amount: -1, description: 'CAL DEB' },
];

async function main(): Promise<void> {
  const unpinned = FIXTURES.map((f) => f.parse());

  const { computeTransactionId } = await import('../../jobs/ingestion');
  const { calendarFlowMonth } = await import('../flowMonth');

  const pinned = FIXTURES.map((f) => {
    const date = f.parse();
    return {
      provider: f.provider,
      date,
      id: computeTransactionId(ACCOUNT_ID, new Date(date), f.amount, f.description),
      flowMonth: calendarFlowMonth(new Date(date)),
    };
  });

  process.stdout.write(`${JSON.stringify({ tzAfterImport: process.env.TZ, unpinned, pinned })}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
