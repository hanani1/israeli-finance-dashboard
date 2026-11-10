'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Languages } from 'lucide-react';
import { locales, type Locale } from '@/i18n/config';
import { cn } from '@/lib/utils';

/** Toggle between the available locales; persists the choice via /api/locale. */
export function LocaleSwitcher() {
  const active = useLocale();
  const t = useTranslations('locale');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const switchTo = (locale: Locale) => {
    if (locale === active) return;
    startTransition(async () => {
      await fetch('/api/locale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      router.refresh();
    });
  };

  return (
    <div
      className="flex items-center gap-0.5"
      role="group"
      aria-label={t('label')}
      aria-busy={pending}
    >
      <Languages className="me-1 hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
      {locales.map((locale) => (
        <button
          key={locale}
          type="button"
          onClick={() => switchTo(locale)}
          aria-pressed={locale === active}
          disabled={pending}
          className={cn(
            'rounded px-2 py-1 text-xs font-medium transition-colors',
            locale === active
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          {t(locale)}
        </button>
      ))}
    </div>
  );
}
