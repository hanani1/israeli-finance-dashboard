const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface MonthDateRange {
  from: string;
  to: string;
}

/** Return the inclusive local-calendar date range represented by yyyy-MM. */
export function monthDateRange(month: string): MonthDateRange {
  if (!MONTH_PATTERN.test(month)) throw new Error(`Invalid month: ${month}`);
  const [year = 0, monthNumber = 1] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
}
