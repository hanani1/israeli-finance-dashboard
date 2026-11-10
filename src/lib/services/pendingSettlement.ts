/**
 * Pending → settled transaction supersession (pure, unit-tested).
 *
 * Card providers report a purchase twice: first as a *pending* row, later as
 * the *settled* row. The two do not share an identity the ingestion upsert can
 * key on, so both end up stored and the dashboard double counts the purchase:
 *
 *  - Isracard: pending rows carry a long zero-padded identifier
 *    (0010000000004), the full merchant text and processedDate == date; the
 *    settled row has a different short identifier (30000005), the merchant
 *    text truncated to ~20 chars and a later processedDate. Some re-scrapes
 *    also re-emit the *same* settled identifier with a leading zero
 *    (030000005 vs 30000005), producing a second "settled" twin.
 *  - Cal: pending rows have no identifier at all, the precise amount and
 *    processedDate == date; the settled row has an identifier, the amount
 *    charged (rounded to whole shekels, precise value kept in originalAmount)
 *    and sometimes a different merchant text (an ATM withdrawal shows as
 *    "משיכת מזומן" pending and as the bank's name once settled).
 *
 * Matching is conservative: same account, same amount (charged, or the
 * settled row's originalAmount), Israeli day gap ≤ MAX_DAY_GAP, and a
 * descending ladder of evidence. Two genuine same-amount purchases are never
 * merged because each settled row can absorb at most ONE pending snapshot,
 * and a settled row never supersedes another settled row — except
 * identifier-padding twins (identical text, amount and normalized identifier),
 * which are the same settled transaction scraped twice.
 */
import { localCalendarDay } from './localDay';
import { toAgorot, type MoneyInput } from './money';

export interface PendingSettlementRow {
  id: string;
  accountId: string;
  txnIdentifier: string | null;
  date: Date;
  processedDate: Date | null;
  chargedAmount: MoneyInput;
  originalAmount: MoneyInput | null;
  description: string;
  memo: string | null;
  createdAt: Date;
}

export type SupersessionRule =
  | 'identifier-padding'
  | 'description-prefix'
  | 'amount-only'
  | 'installment-original-amount';

export interface SupersededPending {
  /** Row that is now obsolete (hidden from totals and lists). */
  pendingId: string;
  /** Row that remains visible and represents the purchase. */
  settledId: string;
  rule: SupersessionRule;
}

export const MAX_DAY_GAP = 3;
/** Amount-only evidence is weak; only accept it for same/adjacent days. */
const AMOUNT_ONLY_MAX_DAY_GAP = 1;

const RULE_PRIORITY: Record<SupersessionRule, number> = {
  'identifier-padding': 0,
  'description-prefix': 1,
  'amount-only': 2,
  'installment-original-amount': 2,
};

/** Stringified values that mean "no identifier" (Isracard can yield NaN). */
const ABSENT_IDENTIFIER_STRINGS = new Set(['nan', 'undefined', 'null', 'infinity', '-infinity']);

/**
 * The provider's identifier as the string it was stored as before
 * normalization (String(identifier), untrimmed), or null when it is absent.
 * A non-finite number (Isracard parses empty fields to NaN) or its stringified
 * form must not become the literal "NaN", which every such row would share.
 */
export function rawTxnIdentifier(identifier: string | number | null | undefined): string | null {
  if (identifier == null) return null;
  if (typeof identifier === 'number' && !Number.isFinite(identifier)) return null;
  const value = String(identifier);
  const trimmed = value.trim();
  if (trimmed === '' || ABSENT_IDENTIFIER_STRINGS.has(trimmed.toLowerCase())) return null;
  return value;
}

/** Trim and drop leading zeros; absent (incl. NaN) → null. "000" → "0". */
export function normalizeTxnIdentifier(identifier: string | number | null | undefined): string | null {
  const raw = rawTxnIdentifier(identifier);
  return raw == null ? null : raw.trim().replace(/^0+(?=.)/, '');
}

const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  '₪': 'ILS',
  'ש"ח': 'ILS',
  'ש״ח': 'ILS', // gershayim U+05F4
  'שח': 'ILS',
  NIS: 'ILS',
  $: 'USD',
  'US$': 'USD',
  דולר: 'USD',
  '€': 'EUR',
  יורו: 'EUR',
  אירו: 'EUR',
  '£': 'GBP',
};

/** ISO-4217 code for a provider currency string (symbols, Hebrew names); default ILS. */
export function normalizeCurrencyCode(currency: string | null | undefined): string {
  const trimmed = (currency ?? '').trim();
  if (trimmed === '') return 'ILS';
  return CURRENCY_ALIASES[trimmed] ?? CURRENCY_ALIASES[trimmed.toUpperCase()] ?? trimmed.toUpperCase();
}

/** Exact agorot key (originalAmount's third decimal, if any, rounds half-up). */
const cents = toAgorot;

function dayOf(date: Date): string {
  return localCalendarDay(date);
}

function dayGap(a: Date, b: Date): number {
  const da = Date.parse(`${dayOf(a)}T00:00:00Z`);
  const db = Date.parse(`${dayOf(b)}T00:00:00Z`);
  return Math.abs(da - db) / 86_400_000;
}

/**
 * Provider still shows the row as pending: Cal pending rows carry no
 * identifier at all; Isracard pending rows carry a (long, padded) identifier
 * and are "processed" on the purchase day itself.
 */
function isPendingMarked(row: PendingSettlementRow): boolean {
  if (row.txnIdentifier === null) return true;
  return row.processedDate !== null && dayOf(row.processedDate) === dayOf(row.date);
}

/**
 * `settled` can stand in for `pending`: it has an identifier and, when the
 * pending row also has one (Isracard), it was processed after its purchase
 * day. Cal settles ATM withdrawals on the purchase day, so for no-id pending
 * rows the identifier alone marks the settled side.
 */
function isSettledFor(pending: PendingSettlementRow, settled: PendingSettlementRow): boolean {
  if (settled.txnIdentifier === null) return false;
  if (pending.txnIdentifier === null) return true;
  return settled.processedDate !== null && dayOf(settled.processedDate) > dayOf(settled.date);
}

function amountsMatch(pending: PendingSettlementRow, settled: PendingSettlementRow): boolean {
  const p = cents(pending.chargedAmount);
  if (p === cents(settled.chargedAmount)) return true;
  return settled.originalAmount !== null && p === cents(settled.originalAmount);
}

/** A zero-value pending snapshot for a purchase later posted in installments. */
function installmentOriginalAmountMatches(
  pending: PendingSettlementRow,
  settled: PendingSettlementRow,
): boolean {
  return (
    cents(pending.chargedAmount) === 0 &&
    pending.originalAmount !== null &&
    settled.originalAmount !== null &&
    cents(pending.originalAmount) === cents(settled.originalAmount) &&
    cents(settled.chargedAmount) < 0 &&
    (settled.memo ?? '').includes('תשלום') &&
    (settled.memo ?? '').includes('מתוך')
  );
}

function descriptionsAgree(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (x === '' || y === '') return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

interface Edge extends SupersededPending {
  gap: number;
  createdGapMs: number;
}

export function detectSupersededPendingRows(rows: readonly PendingSettlementRow[]): SupersededPending[] {
  const byAccount = new Map<string, PendingSettlementRow[]>();
  for (const row of rows) {
    const list = byAccount.get(row.accountId) ?? [];
    list.push(row);
    byAccount.set(row.accountId, list);
  }

  const edges: Edge[] = [];
  for (const group of byAccount.values()) {
    for (const a of group) {
      for (const b of group) {
        if (a.id === b.id) continue;
        const gap = dayGap(a.date, b.date);
        if (gap > MAX_DAY_GAP) continue;

        // Rule 1: same settled transaction re-scraped with a zero-padded id.
        // Evaluate once per unordered pair (a older than b).
        const na = normalizeTxnIdentifier(a.txnIdentifier);
        const nb = normalizeTxnIdentifier(b.txnIdentifier);
        if (
          na !== null &&
          na === nb &&
          a.txnIdentifier !== b.txnIdentifier &&
          cents(a.chargedAmount) === cents(b.chargedAmount) &&
          a.description === b.description
        ) {
          const aIsOlder =
            a.createdAt.getTime() < b.createdAt.getTime() ||
            (a.createdAt.getTime() === b.createdAt.getTime() &&
              (a.txnIdentifier ?? '').length > (b.txnIdentifier ?? '').length);
          if (aIsOlder) {
            edges.push({ pendingId: a.id, settledId: b.id, rule: 'identifier-padding', gap, createdGapMs: 0 });
          }
          continue;
        }

        // Rules 2/3: a is the provider's pending snapshot, b its settled row.
        if (!isPendingMarked(a) || !isSettledFor(a, b)) continue;
        const createdGapMs = Math.abs(a.createdAt.getTime() - b.createdAt.getTime());
        if (installmentOriginalAmountMatches(a, b)) {
          edges.push({ pendingId: a.id, settledId: b.id, rule: 'installment-original-amount', gap, createdGapMs });
          continue;
        }
        if (!amountsMatch(a, b)) continue;
        if (descriptionsAgree(a.description, b.description)) {
          edges.push({ pendingId: a.id, settledId: b.id, rule: 'description-prefix', gap, createdGapMs });
        } else if (a.txnIdentifier === null && b.txnIdentifier !== null && gap <= AMOUNT_ONLY_MAX_DAY_GAP) {
          edges.push({ pendingId: a.id, settledId: b.id, rule: 'amount-only', gap, createdGapMs });
        }
      }
    }
  }

  edges.sort(
    (x, y) =>
      RULE_PRIORITY[x.rule] - RULE_PRIORITY[y.rule] ||
      x.gap - y.gap ||
      x.createdGapMs - y.createdGapMs ||
      x.pendingId.localeCompare(y.pendingId) ||
      x.settledId.localeCompare(y.settledId),
  );

  const superseded = new Set<string>(); // rows already hidden
  const survivors = new Set<string>(); // rows that stand in for a hidden row
  const absorbedSnapshot = new Set<string>(); // survivors that already absorbed a pending snapshot
  const matches: SupersededPending[] = [];
  for (const edge of edges) {
    // A hidden row cannot hide others, and a survivor cannot be hidden.
    if (superseded.has(edge.pendingId) || survivors.has(edge.pendingId)) continue;
    if (superseded.has(edge.settledId)) continue;
    // One pending snapshot per settled row — two genuine same-amount purchases
    // each keep their own settled row and their own snapshot.
    if (edge.rule !== 'identifier-padding') {
      if (absorbedSnapshot.has(edge.settledId)) continue;
      absorbedSnapshot.add(edge.settledId);
    }
    superseded.add(edge.pendingId);
    survivors.add(edge.settledId);
    matches.push({ pendingId: edge.pendingId, settledId: edge.settledId, rule: edge.rule });
  }
  return matches;
}
