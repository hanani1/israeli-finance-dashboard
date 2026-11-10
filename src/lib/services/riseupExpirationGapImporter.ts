import crypto from 'node:crypto';

export type RiseUpRow = {
  transactionId: string;
  transactionDate: string;
  billingDate?: string;
  businessName: string;
  amount: number;
  isIncome: boolean;
  cashflowDate?: string;
  source: string;
  sourceType?: string;
  categoryLabel?: string;
};

export type RiseUpSnapshot = { transactions: RiseUpRow[] };
export type ProviderReport = Record<string, unknown>;
export type ComparisonReport = {
  unmatchedRiseup?: Array<{ riseup?: RiseUpRow }>;
};

export type ImportRow = {
  sourceId: string;
  provider: 'visaCal' | 'discount';
  accountId: string;
  date: Date;
  processedDate: Date | null;
  chargedAmount: number;
  description: string;
  txnIdentifier: string;
  rawCategory: string;
  flowMonth: string | null;
};

const EXCLUDED_CAL_IDS = new Set([
  'a79fe9f3-9ca8-11f1-85b9-a34eb1480843',
  'a79fe9fd-9ca8-11f1-85b9-a34eb1480843',
]);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${field}.`);
  return value;
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}: ${value}`);
  return date;
}

function month(value: string | undefined): string | null {
  return value?.match(/^\d{4}-\d{2}/)?.[0] ?? null;
}

function calExpected(report: ProviderReport): number {
  const exact = report.exactMatching;
  const monthly = exact && typeof exact === 'object' ? (exact as Record<string, unknown>).unresolvedMonthly : undefined;
  if (!monthly || typeof monthly !== 'object') throw new Error('Cal report lacks exactMatching.unresolvedMonthly.');
  return Object.values(monthly as Record<string, unknown>).reduce<number>((sum, value) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('Cal report has invalid unresolvedMonthly counts.');
    return sum + value;
  }, 0);
}

function discountExpected(report: ProviderReport): number {
  const input = report.input;
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>).unmatchedCount : undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('Discount report lacks valid input.unmatchedCount.');
  return value;
}

export function selectEligibleRows(
  snapshot: RiseUpSnapshot,
  calReport: ProviderReport,
  discountReport: ProviderReport,
  comparisonReport: ComparisonReport,
): RiseUpRow[] {
  const unmatched = comparisonReport.unmatchedRiseup;
  if (!Array.isArray(unmatched)) throw new Error('Comparison report lacks unmatchedRiseup rows.');
  const sourceById = new Map(snapshot.transactions.map((row) => [row.transactionId, row]));
  const cal: RiseUpRow[] = [];
  const discount: RiseUpRow[] = [];
  for (const entry of unmatched) {
    const sourceRow = entry.riseup;
    if (!sourceRow || !sourceRow.transactionId) throw new Error('Comparison report contains an invalid unmatched row.');
    const row = sourceById.get(sourceRow.transactionId);
    if (!row) throw new Error(`Comparison row ${sourceRow.transactionId} is missing from the source snapshot.`);
    if (row.source === 'cal' && row.sourceType === 'creditCard' && !EXCLUDED_CAL_IDS.has(row.transactionId)) cal.push(row);
    if (row.source === 'discount' && row.sourceType === 'checkingAccount') discount.push(row);
  }
  const expectedCal = calExpected(calReport);
  const expectedDiscount = discountExpected(discountReport);
  if (cal.length !== expectedCal) throw new Error(`Cal eligible selection is ${cal.length}; report confirms ${expectedCal}. Refusing to guess missing/extra rows.`);
  if (discount.length !== expectedDiscount) throw new Error(`Discount eligible selection is ${discount.length}; report confirms ${expectedDiscount}. Refusing to guess missing/extra rows.`);
  return [...cal, ...discount].sort((a, b) => a.transactionId.localeCompare(b.transactionId));
}

export function mapRows(rows: RiseUpRow[], accountIds: { visaCal: string; discount: string }): ImportRow[] {
  return rows.map((row) => {
    const provider = row.source === 'cal' ? 'visaCal' : row.source === 'discount' ? 'discount' : null;
    if (!provider) throw new Error(`Unsupported selected provider: ${row.source}`);
    const accountId = accountIds[provider];
    if (!accountId) throw new Error(`Missing account id for ${provider}.`);
    const date = parseDate(row.transactionDate, `${row.transactionId}.transactionDate`);
    return {
      sourceId: requiredString(row.transactionId, 'transactionId'),
      provider,
      accountId,
      date,
      processedDate: row.billingDate ? parseDate(row.billingDate, `${row.transactionId}.billingDate`) : null,
      chargedAmount: row.isIncome ? row.amount : -row.amount,
      description: requiredString(row.businessName, `${row.transactionId}.businessName`),
      txnIdentifier: row.transactionId,
      rawCategory: `riseup-expiration-gap:${provider}`,
      flowMonth: month(row.cashflowDate),
    };
  });
}

export function deterministicId(row: ImportRow): string {
  return crypto.createHash('sha256').update(`riseup-expiration-gap:${row.accountId}:${row.sourceId}`, 'utf8').digest('hex');
}

export function summarize(rows: ImportRow[], existingIds: Set<string>): { selected: number; alreadyPresent: number; toInsert: number; byProvider: Record<string, number> } {
  const byProvider: Record<string, number> = {};
  for (const row of rows) byProvider[row.provider] = (byProvider[row.provider] ?? 0) + 1;
  const alreadyPresent = rows.filter((row) => existingIds.has(`${row.accountId}|${row.txnIdentifier}`)).length;
  return { selected: rows.length, alreadyPresent, toInsert: rows.length - alreadyPresent, byProvider };
}

export { EXCLUDED_CAL_IDS };
