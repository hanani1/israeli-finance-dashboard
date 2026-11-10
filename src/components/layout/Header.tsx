'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarRange } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import { defaultLocale, dirFor, isLocale } from '@/i18n/config';
import { useGlobalFilters } from '@/lib/hooks/useGlobalFilters';
import { RELATIVE_DATE_PRESETS, type DatePreset } from '@/lib/services/datePresets';

interface HouseholdUser {
  id: string;
  name: string;
}

const ALL_HOUSEHOLD = '__all__';

/**
 * Top header: date range picker (custom dates or a relative "last N months"
 * preset) + multi-user (household) filter. Editing either date switches the
 * preset back to custom; the min/max bounds keep from <= to.
 */
export function Header() {
  const { filters, setFilters } = useGlobalFilters();
  const t = useTranslations('header');
  const locale = useLocale();
  // Radix Select defaults to LTR; pass the page direction so Hebrew labels
  // that start with a digit ("12 החודשים האחרונים") keep RTL order.
  const dir = dirFor(isLocale(locale) ? locale : defaultLocale);
  const pathname = usePathname();
  // The from/until date range only drives the main dashboard; other pages have
  // their own time controls (month picker / monthly navigation).
  const showDateRange = pathname === '/';
  const [users, setUsers] = useState<HouseholdUser[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/users')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: HouseholdUser[]) => {
        if (!cancelled) setUsers(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="sticky top-0 z-30 border-b bg-card/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/85 sm:flex sm:h-14 sm:items-center sm:gap-2 sm:px-6 sm:py-0">
      <div className="flex w-full items-center gap-2 sm:contents">
        <div className="min-w-0 flex-1 sm:order-2 sm:ms-auto sm:flex-none">
          <Select
            value={filters.userId || ALL_HOUSEHOLD}
            onValueChange={(value) => setFilters({ userId: value === ALL_HOUSEHOLD ? '' : value })}
          >
            <SelectTrigger className="h-10 w-full text-xs sm:h-8 sm:w-48" aria-label={t('householdFilter')}>
              <SelectValue placeholder={t('allHousehold')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_HOUSEHOLD}>{t('allHousehold')}</SelectItem>
              {users.map((user) => (
                <SelectItem key={user.id} value={user.id}>
                  {user.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="shrink-0 sm:order-3">
          <LocaleSwitcher />
        </div>
      </div>

      {showDateRange && (
        <div className="mt-2 flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:order-1 sm:mt-0 sm:w-auto sm:flex-nowrap">
          <CalendarRange
            className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block"
            aria-hidden
          />
          <Select
            dir={dir}
            value={filters.preset}
            onValueChange={(value) => setFilters({ preset: value as DatePreset })}
          >
            <SelectTrigger
              className="h-10 w-full basis-full text-xs sm:h-8 sm:w-40 sm:basis-auto"
              aria-label={t('datePreset')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="custom">{t('presetCustom')}</SelectItem>
              {RELATIVE_DATE_PRESETS.map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {t(`preset${preset}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="date"
            aria-label={t('fromDate')}
            className="h-10 min-w-0 flex-1 px-2 text-xs sm:h-8 sm:w-[8.5rem] sm:flex-none"
            value={filters.from}
            max={filters.to}
            onChange={(e) => setFilters({ from: e.target.value })}
          />
          <span className="shrink-0 text-xs text-muted-foreground">–</span>
          <Input
            type="date"
            aria-label={t('toDate')}
            className="h-10 min-w-0 flex-1 px-2 text-xs sm:h-8 sm:w-[8.5rem] sm:flex-none"
            value={filters.to}
            min={filters.from}
            onChange={(e) => setFilters({ to: e.target.value })}
          />
        </div>
      )}
    </header>
  );
}
