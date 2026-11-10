/**
 * Money helper (card #53, ADR-0027).
 *
 * Money columns (Transaction.chargedAmount / originalAmount, Account.balance,
 * Budget.amount) are PostgreSQL `DECIMAL(14,2)` and Prisma returns them as
 * `Prisma.Decimal`. Server code keeps money as Decimal — or as exact integer
 * agorot for matching keys — and converts to a JS number in exactly one
 * place: `moneyToNumber` when building a response DTO (the UI/JSON
 * boundary). Never `Number(x)` / `x.toNumber()` a money value elsewhere, and
 * never hand a raw Prisma row with Decimal fields to `NextResponse.json`:
 * `Decimal#toJSON` is a string.
 *
 * Every helper also accepts a plain number (literals, tests, scraper input):
 * it is read through its shortest decimal representation and rounded to the
 * agorot, so binary-float noise like 0.1 + 0.2 never reaches a total.
 */
import { Prisma } from '@prisma/client';

export type Decimal = Prisma.Decimal;
/** Anything the helpers accept as a money amount. */
export type MoneyInput = Prisma.Decimal | number | string;

/** Scale of every money column: DECIMAL(14,2) — agorot. */
export const MONEY_SCALE = 2;

/** Largest |amount| DECIMAL(14,2) can store. */
export const MAX_MONEY_AMOUNT = 999_999_999_999.99;

const HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

export const ZERO_MONEY: Decimal = new Prisma.Decimal(0);

function toScale(value: MoneyInput, scale: number): Decimal {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`money amount must be finite, got ${value}`);
  }
  const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  if (!decimal.isFinite()) throw new RangeError(`money amount must be finite, got ${String(value)}`);
  return decimal.toDecimalPlaces(scale, HALF_UP);
}

/** Exact 2-decimal Decimal for any money input (half-up, away from zero). */
export function money(value: MoneyInput): Decimal {
  return toScale(value, MONEY_SCALE);
}

export function moneyOrNull(value: MoneyInput | null | undefined): Decimal | null {
  return value === null || value === undefined ? null : money(value);
}

/** Exact sum; null/undefined (e.g. an empty `_sum`) count as zero. */
export function sumMoney(values: Iterable<MoneyInput | null | undefined>): Decimal {
  let total = ZERO_MONEY;
  for (const value of values) {
    if (value !== null && value !== undefined) total = total.add(money(value));
  }
  return total;
}

/** Exact integer agorot — the key for amount matching (transfers, settlements, refunds). */
export function toAgorot(value: MoneyInput): number {
  const agorot = money(value).mul(100).toNumber();
  if (!Number.isSafeInteger(agorot)) throw new RangeError(`amount out of range: ${String(value)}`);
  return agorot;
}

/** |amount| in agorot — sign-insensitive matching key. */
export function absAgorot(value: MoneyInput): number {
  return Math.abs(toAgorot(value));
}

export function fromAgorot(agorot: number): Decimal {
  if (!Number.isSafeInteger(agorot)) throw new RangeError(`agorot must be a safe integer, got ${agorot}`);
  return new Prisma.Decimal(agorot).div(100);
}

/** amount / divisor rounded half-up to the agorot (averages, pacing projections). */
export function divideMoney(value: MoneyInput, divisor: number | Decimal): Decimal {
  return money(value).div(divisor).toDecimalPlaces(MONEY_SCALE, HALF_UP);
}

/**
 * THE Decimal -> number conversion, for response DTOs / UI props only. Exact:
 * a 2-decimal Decimal maps to the nearest double, which prints back as the
 * same 2-decimal string.
 */
export function moneyToNumber(value: MoneyInput): number {
  return money(value).toNumber();
}

export function moneyToNumberOrNull(value: MoneyInput | null | undefined): number | null {
  return value === null || value === undefined ? null : moneyToNumber(value);
}

/**
 * Scale of Transaction.originalAmount: DECIMAL(14,3), because the original
 * (merchant) currency may have three minor-unit digits (JOD, KWD, BHD, OMR,
 * TND). Never summed into a total; display + pending-settlement matching only.
 */
export const ORIGINAL_AMOUNT_SCALE = 3;

/** Exact Decimal for an original-currency amount (scale 3). */
export function originalAmount(value: MoneyInput): Decimal {
  return toScale(value, ORIGINAL_AMOUNT_SCALE);
}

/** UI/JSON boundary for originalAmount (keeps the third decimal). */
export function originalAmountToNumberOrNull(value: MoneyInput | null | undefined): number | null {
  return value === null || value === undefined ? null : originalAmount(value).toNumber();
}

/** UI/JSON boundary for an exact agorot integer (matching/reconciliation totals). */
export function agorotToNumber(agorot: number): number {
  return moneyToNumber(fromAgorot(agorot));
}

/**
 * A dimensionless ratio derived from money (pace ratio, elapsed fraction) as
 * a JSON number, rounded half-up to `places`. Not for money amounts.
 */
export function ratioToNumber(value: Decimal, places: number): number {
  return value.toDecimalPlaces(places, HALF_UP).toNumber();
}
