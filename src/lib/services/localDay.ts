/**
 * Israeli calendar-day helpers (pure, unit-tested).
 *
 * Provider dates are *days*, not instants. The scrapers (and the Mac host
 * that runs them) emit them as Israel-local midnight, so a Discount row dated
 * 2026-09-01 is stored as 2026-08-31T21:00:00Z. Older CSV imports stored the
 * same day as 2026-09-01T00:00:00Z. Attributing rows to a day or month with
 * UTC boundaries therefore pushed every 1st-of-month scraped row (the
 * mortgage debit, Isracard purchases) into the previous month. Everything
 * that windows transactions by day or month must go through these helpers so
 * both storage styles land on the provider's day.
 */

export const ISRAEL_TIME_ZONE = 'Asia/Jerusalem';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ISRAEL_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function localParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of partsFormatter.formatToParts(date)) {
    if (part.type in out) out[part.type as keyof typeof out] = Number(part.value);
  }
  return out;
}

/** Offset of Israel local time from UTC at `date`, in minutes (120 or 180). */
function offsetMinutesAt(date: Date): number {
  const p = localParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

function parseDay(label: string): { year: number; month: number; day: number } {
  const match = DAY_PATTERN.exec(label);
  if (!match) throw new Error(`Invalid day ${label}; expected yyyy-MM-dd.`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** UTC instant of Israel-local midnight starting the given yyyy-MM-dd. */
export function localDayStart(label: string): Date {
  const { year, month, day } = parseDay(label);
  const naive = Date.UTC(year, month - 1, day);
  let offset = offsetMinutesAt(new Date(naive));
  let instant = naive - offset * 60_000;
  // Re-evaluate once in case the guess straddled a DST transition.
  const corrected = offsetMinutesAt(new Date(instant));
  if (corrected !== offset) {
    offset = corrected;
    instant = naive - offset * 60_000;
  }
  return new Date(instant);
}

/** Israel-local yyyy-MM-dd of an instant. */
export function localCalendarDay(date: Date): string {
  const p = localParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Israel-local yyyy-MM of an instant. */
export function localCalendarMonth(date: Date): string {
  return localCalendarDay(date).slice(0, 7);
}

/** Day after a yyyy-MM-dd label. */
export function nextDay(label: string): string {
  const { year, month, day } = parseDay(label);
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Inclusive yyyy-MM-dd bounds → half-open UTC window [gte, lt) on Israeli
 * days, ready for a Prisma `date` filter. Missing bounds are left open.
 */
export function localDateRange(from?: string, to?: string): { gte?: Date; lt?: Date } {
  return {
    ...(from ? { gte: localDayStart(from) } : {}),
    ...(to ? { lt: localDayStart(nextDay(to)) } : {}),
  };
}
