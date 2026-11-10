'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from '@/components/layout/Sidebar';

/** Bottom tab bar — mobile (<768px) only. */
export function BottomNav() {
  const pathname = usePathname();
  const t = useTranslations('nav');

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-card/95 px-1 pb-[max(env(safe-area-inset-bottom),0.25rem)] pt-1 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur supports-[backdrop-filter]:bg-card/90 md:hidden"
      aria-label="Mobile navigation"
    >
      {NAV_ITEMS.map(({ href, key, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'min-w-0 flex flex-1 flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] font-medium transition-colors active:scale-95',
              active ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
            )}
          >
            <Icon className="h-5 w-5 shrink-0" aria-hidden />
            <span className="max-w-full truncate">{t(key)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
