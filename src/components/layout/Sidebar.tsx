'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowLeftRight,
  CalendarDays,
  LayoutDashboard,
  MessageCircle,
  PiggyBank,
  ReceiptText,
  Settings,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export const NAV_ITEMS = [
  { href: '/', key: 'dashboard', icon: LayoutDashboard },
  { href: '/monthly', key: 'monthly', icon: CalendarDays },
  { href: '/transactions', key: 'transactions', icon: ReceiptText },
  { href: '/transfers', key: 'transfers', icon: ArrowLeftRight },
  { href: '/investments', key: 'investments', icon: TrendingUp },
  { href: '/budgets', key: 'budgets', icon: PiggyBank },
  { href: '/chat', key: 'chat', icon: MessageCircle },
  { href: '/settings', key: 'settings', icon: Settings },
] as const;

/** Collapsible sidebar (inline-start) — desktop (md+) only. */
export function Sidebar() {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const tApp = useTranslations('app');

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-e bg-card md:flex">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Wallet className="h-5 w-5 text-primary" aria-hidden />
        <span className="text-sm font-semibold">{tApp('title')}</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Main navigation">
        {NAV_ITEMS.map(({ href, key, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t(key)}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
