import { localCalendarDay } from './localDay';

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

function parseMonth(value: string): { year: number; month: number } {
  const match = MONTH_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid month ${value}; expected YYYY-MM.`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

function shiftMonth(value: string, offset: number): string {
  const { year, month } = parseMonth(value);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function comparisonRange(snapshotFrom: string, snapshotTo: string, months?: number): { from: string; to: string } {
  parseMonth(snapshotFrom);
  parseMonth(snapshotTo);
  if (months === undefined) return { from: snapshotFrom, to: snapshotTo };
  if (!Number.isInteger(months) || months <= 0) throw new Error('--months must be a positive integer.');
  const requestedFrom = shiftMonth(snapshotTo, 1 - months);
  return { from: requestedFrom < snapshotFrom ? snapshotFrom : requestedFrom, to: snapshotTo };
}

export function calendarDay(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid transaction date: ${String(value)}`);
  return localCalendarDay(date);
}

export function effectiveMonth(flowMonth: string | null | undefined, date: string | Date): string {
  return flowMonth ?? calendarDay(date).slice(0, 7);
}
