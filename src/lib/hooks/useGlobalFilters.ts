'use client';

/**
 * Global dashboard filters (date range + household user), backed by URL
 * search params so they survive navigation and are shareable/bookmarkable.
 */
import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { startOfCurrentMonth, today } from '@/lib/utils';
import {
  parseDatePreset,
  relativePresetRange,
  resolveDateRange,
  type DatePreset,
} from '@/lib/services/datePresets';

export interface GlobalFilters {
  from: string;
  to: string;
  /**
   * Dashboard date preset. A relative preset (`range=3m|6m|12m` in the URL)
   * is recomputed against today on every load; 'custom' = explicit from/to.
   */
  preset: DatePreset;
  /** Empty string = all household members. */
  userId: string;
}

export function useGlobalFilters(): {
  filters: GlobalFilters;
  setFilters: (patch: Partial<GlobalFilters>) => void;
  toQueryString: () => string;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = useMemo<GlobalFilters>(
    () => ({
      ...resolveDateRange(
        {
          range: searchParams.get('range'),
          from: searchParams.get('from'),
          to: searchParams.get('to'),
        },
        new Date(),
        { from: startOfCurrentMonth(), to: today() },
      ),
      userId: searchParams.get('userId') ?? '',
    }),
    [searchParams],
  );

  const setFilters = useCallback(
    (patch: Partial<GlobalFilters>) => {
      const params = new URLSearchParams(searchParams.toString());
      const next = { ...filters, ...patch };
      const relative = parseDatePreset(patch.preset);
      if (relative) {
        // Choosing a preset sets the range; from/to are written too so the
        // URL stays readable, but `range` wins when the URL is read back.
        Object.assign(next, relativePresetRange(relative, new Date()));
        params.set('range', relative);
      } else if (patch.preset === 'custom' || patch.from !== undefined || patch.to !== undefined) {
        // Editing either date (or picking "Custom dates") leaves the preset;
        // the dates currently shown become the custom range.
        next.preset = 'custom';
        params.delete('range');
      }
      params.set('from', next.from);
      params.set('to', next.to);
      if (next.userId) {
        params.set('userId', next.userId);
      } else {
        params.delete('userId');
      }
      router.replace(`${pathname}?${params.toString()}`);
    },
    [filters, pathname, router, searchParams],
  );

  const toQueryString = useCallback(() => {
    const params = new URLSearchParams({ from: filters.from, to: filters.to });
    if (filters.userId) {
      params.set('userId', filters.userId);
    }
    return params.toString();
  }, [filters]);

  return { filters, setFilters, toQueryString };
}
