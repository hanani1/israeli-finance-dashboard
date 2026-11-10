/** Pure helpers for showing a slice's share of a chart total (e.g. pie tooltips). */

export function sliceSharePercent(
  total: number,
  slices: ReadonlyArray<{ total: number }>,
): number {
  const sum = slices.reduce((acc, slice) => acc + slice.total, 0);
  if (sum <= 0) return 0;
  return (total / sum) * 100;
}

/** "33.3%" / "60%" — one decimal, trailing .0 removed. */
export function formatSharePercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}
