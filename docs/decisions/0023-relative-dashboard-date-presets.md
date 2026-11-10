# ADR-0023: Relative dashboard date presets as calendar-month windows

- **Date:** 2026-11-02
- **Status:** Accepted
- **Area:** UI / Data
- **Owners:** Finance Dashboard maintainers

## Context

The dashboard header only offered explicit from/to dates. Looking at "the last
few months" meant picking two dates by hand and re-picking them every day.
"Last N months" is ambiguous: a rolling N×30-day window, the same day N months
ago, or whole calendar months. Card #64.

## Decision

- Presets: **Custom dates**, **Last 3 months**, **Last 6 months**, **Last 12 months**.
- "Last N months" = the **current calendar month plus the N-1 previous whole
  months**, ending **today**. Example on 2026-11-02: Last 3 months =
  2026-09-01..2026-11-02; Last 12 months = 2025-12-01..2026-11-02.
- "Today" and "current month" are the **Israel-local** calendar day
  (`localDay.ts`), not UTC, matching how transaction days are windowed.
- The preset is stored in the URL as `range=3m|6m|12m` alongside `from`/`to`
  (ADR-0006). When `range` is valid it wins and is **recomputed on every
  load**, so a bookmarked/refreshed preset stays relative. No `range` (or an
  unknown value) means custom dates.
- Editing either date input switches back to Custom dates (removes `range`)
  and keeps the dates shown as the custom range. Presets always yield
  from <= to; the inputs keep their min/max guard.
- Computation is pure in `src/lib/services/datePresets.ts` and unit-tested
  (month start, January rollover, Israel midnight vs UTC, leap day).

## Consequences

### Positive
- Every month in the window is whole (no partial first month), so totals line
  up with the monthly view and month-granularity trends.
- Refresh-safe and shareable; the URL still shows concrete from/to.

### Negative / risks
- The window length varies with the day of month (Last 3 months on the 2nd is
  ~2 months + 2 days; on the 30th it is ~3 months).
- A stale `from`/`to` beside a `range` in a shared URL is ignored, which may
  surprise someone editing the URL by hand.

## Alternatives considered

- **Rolling N months to the same day (2026-08-02..2026-11-02):** rejected; the
  first month is partial, so month buckets and averages are distorted.
- **N previous whole months excluding the current one:** rejected; the card
  requires the range to end today.
- **Store only from/to (no preset id):** rejected; refresh would freeze the
  window and the header could not show which preset is active.

## References

- `src/lib/services/datePresets.ts`, `src/lib/hooks/useGlobalFilters.ts`,
  `src/components/layout/Header.tsx`
- ADR-0006 (URL-backed filters), Trello card #64
