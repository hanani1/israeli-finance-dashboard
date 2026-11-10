import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Sidebar } from '@/components/layout/Sidebar';
import { BottomNav } from '@/components/layout/BottomNav';
import { Header } from '@/components/layout/Header';
import { DailyCategorizeReminder } from '@/components/transactions/DailyCategorizeReminder';
import { dirFor, type Locale } from '@/i18n/config';
import './globals.css';

export const metadata: Metadata = {
  title: 'Finance Dashboard',
  description: 'Self-hosted household finance dashboard with automatic bank ingestion.',
  applicationName: 'Finance Dashboard',
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f766e',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const messages = await getMessages();

  return (
    <html lang={locale} dir={dirFor(locale)}>
      <body className="min-h-screen overflow-x-hidden overscroll-y-none">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <div className="flex min-h-screen">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={<div className="h-14 border-b bg-card" />}>
                <Header />
              </Suspense>
              <main className="mx-auto w-full max-w-screen-2xl flex-1 p-3 pb-28 sm:p-6 md:pb-6">
                <Suspense>{children}</Suspense>
              </main>
            </div>
          </div>
          <BottomNav />
          <DailyCategorizeReminder />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
