/**
 * Pure card-settlement detection logic. Raw transactions are never deleted;
 * callers mark duplicate bank rows so normal views can hide them.
 *
 * Max and Isracard bank settlements are covered when the corresponding card
 * provider has detailed transactions for that billing cycle. Exact sums are
 * preferred when assigning multiple same-provider cards, but are not required:
 * a scrape can contain only part of a cycle while the bank debit contains the
 * complete settlement.
 *
 * Cal's monthly statement debit on the bank ("כ.א.ל חיוב") is covered the same
 * way, but only when a visaCal card account has detailed rows for that cycle;
 * without card history there is nothing to double count, so the bank row stays
 * countable. Discount's pending-Cal snapshots ("חיוב לכרטיס …") are forecasts
 * of that same statement debit, never settlements: while a visaCal account has
 * detailed rows every snapshot is hidden (the purchases are already counted —
 * leaving the newest visible double counted ~₪8–10k a month); without card
 * history only the newest snapshot stays visible.
 */

import { toAgorot, type MoneyInput } from './money';

export interface SettlementCandidate {
  id: string;
  date: Date;
  chargedAmount: MoneyInput;
  description: string;
}

export interface CardCycleTxn {
  accountId: string;
  provider: string;
  processedDate: Date | null;
  chargedAmount: MoneyInput;
}

export interface SettlementMatch {
  settlementId: string;
  cardAccountId: string;
}

const SETTLEMENT_PATTERNS: ReadonlyArray<{ pattern: string; provider: string }> = [
  { pattern: 'מקס איט', provider: 'max' },
  { pattern: 'ישראכרט', provider: 'isracard' },
  // Leumi's bank-side description for an Isracard Mastercard settlement.
  { pattern: 'מאסטרקרד(יש)', provider: 'isracard' },
  { pattern: 'מאסטרקארד', provider: 'isracard' },
  // Leumi's EUR-account spelling omits the aleph.
  { pattern: 'מסטרקארד', provider: 'isracard' },
  // Discount's bank-side description for the monthly Cal statement debit.
  { pattern: 'כ.א.ל חיוב', provider: 'visaCal' },
];

/** Returns the detailed-card provider anchored by a bank description. */
export function settlementProviderFor(description: string): string | null {
  for (const { pattern, provider } of SETTLEMENT_PATTERNS) {
    if (description.includes(pattern)) return provider;
  }
  return null;
}

/**
 * Bank posting can lag (or, around weekends/holidays, precede) a card
 * statement's billing date by a few days. Six days covers the observed
 * Isracard/Max cycles while staying far below the monthly cycle length.
 */
export const SETTLEMENT_MAX_DAY_GAP = 6;

/**
 * Match settlement rows one-to-one with provider card-account billing cycles.
 *
 * A cycle exists when an account has any detailed row with the same
 * processed-date day. Candidate edges require provider agreement and a nearby
 * date. Exact amount edges win first; remaining rows are paired by closest
 * date and then closest partial-history sum. Thus partial card history still
 * hides the duplicate bank settlement without allowing one card cycle to hide
 * multiple bank rows.
 */
export function matchCoveredSettlements(
  settlements: readonly SettlementCandidate[],
  cardTxns: readonly CardCycleTxn[],
  options: { maxDayGap?: number } = {},
): SettlementMatch[] {
  const maxGapMs = (options.maxDayGap ?? SETTLEMENT_MAX_DAY_GAP) * 86_400_000;

  interface Cycle {
    provider: string;
    cardAccountId: string;
    chargeDate: Date;
    /** Exact cycle total in signed agorot. */
    sumAgorot: number;
  }

  const cycleByKey = new Map<string, Cycle>();
  for (const txn of cardTxns) {
    if (!txn.processedDate) continue;
    const day = txn.processedDate.toISOString().slice(0, 10);
    const key = `${txn.provider}|${txn.accountId}|${day}`;
    const cycle = cycleByKey.get(key) ?? {
      provider: txn.provider,
      cardAccountId: txn.accountId,
      chargeDate: new Date(`${day}T00:00:00.000Z`),
      sumAgorot: 0,
    };
    cycle.sumAgorot += toAgorot(txn.chargedAmount);
    cycleByKey.set(key, cycle);
  }

  interface Edge {
    settlementId: string;
    cycle: Cycle;
    exactAmount: boolean;
    gapMs: number;
    amountGap: number;
  }

  const edges: Edge[] = [];
  for (const settlement of settlements) {
    const settlementAgorot = toAgorot(settlement.chargedAmount);
    if (settlementAgorot >= 0) continue;
    const provider = settlementProviderFor(settlement.description);
    if (!provider) continue;

    for (const cycle of cycleByKey.values()) {
      if (cycle.provider !== provider) continue;
      const gapMs = Math.abs(cycle.chargeDate.getTime() - settlement.date.getTime());
      if (gapMs > maxGapMs) continue;
      edges.push({
        settlementId: settlement.id,
        cycle,
        exactAmount: Math.abs(cycle.sumAgorot) === Math.abs(settlementAgorot),
        gapMs,
        amountGap: Math.abs(Math.abs(cycle.sumAgorot) - Math.abs(settlementAgorot)),
      });
    }
  }

  edges.sort(
    (a, b) =>
      Number(b.exactAmount) - Number(a.exactAmount) ||
      a.gapMs - b.gapMs ||
      a.amountGap - b.amountGap ||
      a.settlementId.localeCompare(b.settlementId) ||
      a.cycle.cardAccountId.localeCompare(b.cycle.cardAccountId),
  );

  const claimedSettlements = new Set<string>();
  const claimedCycles = new Set<Cycle>();
  const matches: SettlementMatch[] = [];
  for (const edge of edges) {
    if (claimedSettlements.has(edge.settlementId) || claimedCycles.has(edge.cycle)) continue;
    claimedSettlements.add(edge.settlementId);
    claimedCycles.add(edge.cycle);
    matches.push({ settlementId: edge.settlementId, cardAccountId: edge.cycle.cardAccountId });
  }
  return matches;
}

export interface PendingSnapshotCandidate {
  id: string;
  accountId: string;
  date: Date;
  description: string;
  createdAt: Date;
}

const PENDING_SNAPSHOT_PATTERN = 'חיוב לכרטיס';

export function isPendingSnapshotDescription(description: string): boolean {
  return description.includes(PENDING_SNAPSHOT_PATTERN);
}

/** Return every repeated pending snapshot except the newest inserted row. */
export function detectObsoletePendingSnapshots(
  txns: readonly PendingSnapshotCandidate[],
): string[] {
  const groups = new Map<string, PendingSnapshotCandidate[]>();
  for (const txn of txns) {
    if (!isPendingSnapshotDescription(txn.description)) continue;
    const key = `${txn.accountId}|${txn.date.toISOString().slice(0, 10)}|${txn.description}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(txn);
    else groups.set(key, [txn]);
  }

  const obsolete: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    for (const stale of sorted.slice(1)) obsolete.push(stale.id);
  }
  return obsolete;
}

/**
 * Pending-snapshot rows to hide. With detailed Cal rows the forecast duplicates
 * card spending that is already counted, so every snapshot is hidden; without
 * them only repeated (stale) snapshots are, keeping the newest forecast.
 */
export function pendingSnapshotsToHide(
  txns: readonly PendingSnapshotCandidate[],
  options: { hasDetailedCalRows: boolean },
): string[] {
  if (options.hasDetailedCalRows) {
    return txns.filter((txn) => isPendingSnapshotDescription(txn.description)).map((txn) => txn.id);
  }
  return detectObsoletePendingSnapshots(txns);
}
