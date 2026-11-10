/**
 * Relative dashboard date presets (pure, unit-tested).
 *
 * "Last N months" is a calendar-month window: the current Israeli month plus
 * the N-1 previous whole months, ending today. On 2026-11-02, "Last 3 months"
 * is 2026-09-01..2026-11-02. Starting on the 1st keeps every month in the
 * window whole (no partial first month), so totals line up with the monthly
 * view. "Today" is the Israel-local calendar day, not the UTC one, so a
 * refresh just after Israeli midnight already moves into the new day/month.
 *
 * The preset id lives in the URL (`range=3m|6m|12m`) next to `from`/`to`
 * (ADR-0006). A valid preset wins over the stored dates and is recomputed
 * against the current day, so a bookmarked "Last 3 months" stays relative.
 */
import { localCalendarDay } from './localDay';

export const RELATIVE_DATE_PRESETS = ['3m', '6m', '12m'] as const;

export type RelativeDatePreset = (typeof RELATIVE_DATE_PRESETS)[number];
export type DatePreset = RelativeDatePreset | 'custom';

const PRESET_MONTHS: Record<RelativeDatePreset, number> = { '3m': 3, '6m': 6, '12m': 12 };

export function parseDatePreset(value: string | null | undefined): RelativeDatePreset | null {
  return (RELATIVE_DATE_PRESETS as readonly string[]).includes(value ?? '')
    ? (value as RelativeDatePreset)
    : null;
}

/** Inclusive yyyy-MM-dd bounds of a relative preset as of `now`. */
export function relativePresetRange(
  preset: RelativeDatePreset,
  now: Date,
): { from: string; to: string } {
  const to = localCalendarDay(now);
  const year = Number(to.slice(0, 4));
  const month = Number(to.slice(5, 7)); // 1-12
  // Zero-based month index of the window start; may go negative (Jan rollover).
  const startIndex = year * 12 + (month - 1) - (PRESET_MONTHS[preset] - 1);
  const startYear = Math.floor(startIndex / 12);
  const startMonth = (startIndex % 12) + 1;
  return { from: `${startYear}-${String(startMonth).padStart(2, '0')}-01`, to };
}

/**
 * Resolve the dashboard date range from URL values. A valid `range` preset is
 * recomputed for `now`; otherwise the explicit dates (or defaults) are used
 * and the preset is "custom".
 */
export function resolveDateRange(
  params: { range?: string | null; from?: string | null; to?: string | null },
  now: Date,
  defaults: { from: string; to: string },
): { preset: DatePreset; from: string; to: string } {
  const preset = parseDatePreset(params.range);
  if (preset) return { preset, ...relativePresetRange(preset, now) };
  return {
    preset: 'custom',
    from: params.from || defaults.from,
    to: params.to || defaults.to,
  };
}
