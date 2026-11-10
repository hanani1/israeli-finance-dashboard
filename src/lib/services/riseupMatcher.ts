/**
 * The one RiseUp ↔ dashboard transaction matcher (card #52).
 *
 * Extracted verbatim from scripts/import-riseup-categories.ts, whose tiers were
 * proven on the real export, and shared by every RiseUp script:
 * import-riseup-categories.ts, backfill-flow-month.ts and riseup-compare.ts.
 *
 * Matching is strictly one-to-one and never ambiguous. Amounts must be equal
 * to the agora; then each tier, strongest first, pairs the still-unmatched
 * RiseUp rows with still-unconsumed dashboard rows:
 *
 *   1 exact description  + payment date == transaction date
 *   2 exact description  + charge date  == processed date (or transaction date)
 *   3 fuzzy description  + payment date
 *   4 fuzzy description  + charge date
 *   5 fuzzy description  + payment date ±1 day
 *   6 prefix description + payment date
 *   7 prefix description + charge date
 *   8 word-subset        + payment date
 *   9 (opt-in) amount + payment date only — for reports, never for writes
 *
 * Identical RiseUp rows are grouped and paired off with as many candidates as
 * exist. When a tier finds MORE candidates than identical rows, the rows are
 * matched only if the candidates are interchangeable (same date, amount and
 * description); otherwise they are marked ambiguous and left unmatched.
 * Pure: no I/O, inputs are not mutated, output is independent of input order
 * of the dashboard rows (they are processed in id order).
 */
import { money, type MoneyInput } from './money';

/** A RiseUp row. Dates are Israeli-local `YYYY-MM-DD` labels. */
export interface RiseUpMatchRow {
  /** Caller's stable row key (CSV line number, RiseUp transactionId, …). */
  key: string | number;
  /** Signed amount in the dashboard's sign convention (expenses negative). */
  amount: MoneyInput;
  paymentDate: string | null;
  chargeDate: string | null;
  description: string;
}

/** A dashboard transaction. Dates are Israeli-local `YYYY-MM-DD` labels. */
export interface DashboardMatchRow {
  id: string;
  date: string;
  processedDate: string | null;
  amount: MoneyInput;
  description: string;
}

export const MATCH_TIERS = [
  'exact-desc+payment-date',
  'exact-desc+charge-date',
  'fuzzy-desc+payment-date',
  'fuzzy-desc+charge-date',
  'fuzzy-desc+date±1',
  'prefix-desc+payment-date',
  'prefix-desc+charge-date',
  'word-subset+payment-date',
  'amount+payment-date',
] as const;
export type MatchTier = (typeof MATCH_TIERS)[number];

export interface RiseUpMatch<R, T> {
  row: R;
  txn: T;
  tier: MatchTier;
}
export interface RiseUpUnmatched<R> {
  row: R;
  reason: string;
}
export interface RiseUpMatchResult<R, T> {
  /** In RiseUp row order. */
  matches: Array<RiseUpMatch<R, T>>;
  /** In RiseUp row order. */
  unmatched: Array<RiseUpUnmatched<R>>;
}
export interface RiseUpMatchOptions {
  /**
   * Add tier 9 (same amount + same payment date, description ignored). Only
   * a unique candidate is accepted. Meant for read-only comparison reports.
   */
  amountDateFallback?: boolean;
}

// ---------- parsing helpers shared by the RiseUp CSV scripts ----------

/** RFC 4180 CSV parser; strips leading BOMs and skips blank lines. */
export function parseCsv(input: string): string[][] {
  let text = input;
  while (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export function stripBom(value: string): string {
  return value.replace(/^\ufeff+/, '');
}

/** `DD/MM/YYYY` → `YYYY-MM-DD`; anything else → null. */
export function parseDmy(value: string): string | null {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// ---------- description predicates (inputs already normalized) ----------

export function normalizeDescription(value: string): string {
  return value
    .toLowerCase()
    .replace(/["'`”“׳״]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function fuzzyDescMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  if (a.includes(b) || b.includes(a)) return true;
  // RiseUp often drops/merges spaces ("הוק לועד ביתלסניף" vs "הו\"ק לועד בית לסניף").
  const as = a.replace(/ /g, '');
  const bs = b.replace(/ /g, '');
  return as.includes(bs) || bs.includes(as);
}

/**
 * Weakest description signal: the scraper truncates descriptions and RiseUp
 * appends reference numbers ("העברה דיגיטל" vs "העברה דיגי700"). Requires a
 * common prefix of >=5 chars covering >=60% of the shorter space-stripped string.
 */
export function prefixDescMatch(a: string, b: string): boolean {
  const as = a.replace(/ /g, '');
  const bs = b.replace(/ /g, '');
  if (as.length < 5 || bs.length < 5) return false;
  let i = 0;
  while (i < as.length && i < bs.length && as[i] === bs[i]) i++;
  return i >= 5 && i >= 0.6 * Math.min(as.length, bs.length);
}

/** "מענק לאומי" vs "מענק בנק לאומי": every word of one side appears in the other. */
export function wordSubsetMatch(a: string, b: string): boolean {
  const aw = a.split(' ').filter((w) => w.length > 0);
  const bw = b.split(' ').filter((w) => w.length > 0);
  if (aw.length === 0 || bw.length === 0) return false;
  const [small, big] = aw.length <= bw.length ? [aw, bw] : [bw, aw];
  if (small.join('').length < 4) return false;
  const bigSet = new Set(big);
  return small.every((w) => bigSet.has(w));
}

// ---------- matcher ----------

function amountKey(value: MoneyInput): string {
  return money(value).toFixed(2);
}
function dayDiff(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
}

interface Side<R> { source: R; amount: string; desc: string }
type RowSide<R> = Side<R> & { paymentDate: string | null; chargeDate: string | null };
type TxnSide<T> = Side<T> & { id: string; date: string; processedDate: string | null };
type Pred = (r: RowSide<unknown>, t: TxnSide<unknown>) => boolean;

const chargeDateMatches = (r: RowSide<unknown>, t: TxnSide<unknown>): boolean =>
  r.chargeDate !== null && (r.chargeDate === t.processedDate || r.chargeDate === t.date);
const paymentDateMatches = (r: RowSide<unknown>, t: TxnSide<unknown>): boolean =>
  r.paymentDate !== null && r.paymentDate === t.date;

const TIER_PREDICATES: Record<MatchTier, Pred> = {
  'exact-desc+payment-date': (r, t) => paymentDateMatches(r, t) && r.desc === t.desc,
  'exact-desc+charge-date': (r, t) => chargeDateMatches(r, t) && r.desc === t.desc,
  'fuzzy-desc+payment-date': (r, t) => paymentDateMatches(r, t) && fuzzyDescMatch(r.desc, t.desc),
  'fuzzy-desc+charge-date': (r, t) => chargeDateMatches(r, t) && fuzzyDescMatch(r.desc, t.desc),
  'fuzzy-desc+date±1': (r, t) =>
    r.paymentDate !== null && dayDiff(r.paymentDate, t.date) <= 1 && fuzzyDescMatch(r.desc, t.desc),
  'prefix-desc+payment-date': (r, t) => paymentDateMatches(r, t) && prefixDescMatch(r.desc, t.desc),
  'prefix-desc+charge-date': (r, t) => chargeDateMatches(r, t) && prefixDescMatch(r.desc, t.desc),
  'word-subset+payment-date': (r, t) => paymentDateMatches(r, t) && wordSubsetMatch(r.desc, t.desc),
  'amount+payment-date': paymentDateMatches,
};

export function matchRiseUpRows<R extends RiseUpMatchRow, T extends DashboardMatchRow>(
  rows: readonly R[],
  txns: readonly T[],
  options: RiseUpMatchOptions = {},
): RiseUpMatchResult<R, T> {
  const rowSides: Array<RowSide<R>> = rows.map((r) => ({
    source: r,
    amount: amountKey(r.amount),
    desc: normalizeDescription(r.description),
    paymentDate: r.paymentDate,
    chargeDate: r.chargeDate,
  }));
  const txnSides: Array<TxnSide<T>> = txns
    .map((t) => ({
      source: t,
      id: t.id,
      amount: amountKey(t.amount),
      desc: normalizeDescription(t.description),
      date: t.date,
      processedDate: t.processedDate,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const byAmount = new Map<string, Array<TxnSide<T>>>();
  for (const t of txnSides) {
    const list = byAmount.get(t.amount) ?? [];
    list.push(t);
    byAmount.set(t.amount, list);
  }

  const matchedTo = new Map<RowSide<R>, { txn: TxnSide<T>; tier: MatchTier }>();
  const consumed = new Set<TxnSide<T>>();
  const reasons = new Map<RowSide<R>, string>();
  const equivalent = (a: TxnSide<T>, b: TxnSide<T>) => a.date === b.date && a.amount === b.amount && a.desc === b.desc;
  const pair = (candidates: Array<TxnSide<T>>, groupRows: Array<RowSide<R>>, tier: MatchTier) => {
    const n = Math.min(candidates.length, groupRows.length);
    for (let i = 0; i < n; i++) {
      const candidate = candidates[i];
      const r = groupRows[i];
      if (!candidate || !r) continue;
      consumed.add(candidate);
      matchedTo.set(r, { txn: candidate, tier });
    }
  };

  const tiers = MATCH_TIERS.filter((tier) => tier !== 'amount+payment-date' || options.amountDateFallback);
  for (const tier of tiers) {
    const pred = TIER_PREDICATES[tier];
    // Group still-unmatched identical rows so duplicates are paired one-to-one.
    const groups = new Map<string, Array<RowSide<R>>>();
    for (const r of rowSides) {
      if (matchedTo.has(r) || reasons.has(r)) continue;
      const sig = `${r.amount}|${r.paymentDate}|${r.chargeDate}|${r.desc}`;
      const list = groups.get(sig) ?? [];
      list.push(r);
      groups.set(sig, list);
    }
    for (const groupRows of groups.values()) {
      const r0 = groupRows[0];
      if (!r0) continue;
      const pool = byAmount.get(r0.amount) ?? [];
      const candidates = pool.filter((t) => !consumed.has(t) && pred(r0, t));
      if (candidates.length === 0) continue;
      if (candidates.length <= groupRows.length) {
        pair(candidates, groupRows, tier); // extra rows stay unmatched for later tiers
        continue;
      }
      const first = candidates[0];
      if (first !== undefined && candidates.every((c) => equivalent(c, first))) {
        pair(candidates, groupRows, tier);
      } else {
        for (const r of groupRows) {
          reasons.set(r, `ambiguous: ${candidates.length} distinct DB candidates in tier "${tier}"`);
        }
      }
    }
  }

  const dbMinDate = txnSides.reduce((m, t) => (t.date < m ? t.date : m), '9999-99-99');
  const dbMaxDate = txnSides.reduce((m, t) => (t.date > m ? t.date : m), '0000-00-00');
  const result: RiseUpMatchResult<R, T> = { matches: [], unmatched: [] };
  for (const r of rowSides) {
    const match = matchedTo.get(r);
    if (match) {
      result.matches.push({ row: r.source, txn: match.txn.source, tier: match.tier });
      continue;
    }
    const effDate = r.paymentDate ?? r.chargeDate;
    const reason = reasons.get(r)
      ?? (!effDate ? 'unparseable date'
        : effDate < dbMinDate || effDate > dbMaxDate ? `outside DB transaction date range (${dbMinDate}..${dbMaxDate})`
          : !(byAmount.get(r.amount) ?? []).length ? 'no DB transaction with this amount'
            : 'no DB transaction with matching amount+date+description');
    result.unmatched.push({ row: r.source, reason });
  }
  return result;
}
