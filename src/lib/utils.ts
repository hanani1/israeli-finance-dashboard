import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind class names, resolving conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format an amount in ILS (or any currency) for display. */
export function formatCurrency(amount: number, currency: string = 'ILS'): string {
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Format an ISO date string / Date as a short local date. */
export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(date));
}

/** First day of the current month, as yyyy-MM-dd. */
export function startOfCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Today, as yyyy-MM-dd. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
