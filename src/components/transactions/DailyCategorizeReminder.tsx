'use client';

/**
 * Once-per-day in-app reminder to categorize expenses. On the first visit each
 * day, if there are transactions the user has not confirmed (source != MANUAL),
 * it prompts them to start the review flow (`/transactions?review=1`).
 *
 * Self-hosted apps have no push channel, so this is the pragmatic reminder; a
 * launchd/cron OS notification could be layered on separately.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const STORAGE_KEY = 'financeCategorizeReminderShown';

export function DailyCategorizeReminder() {
  const t = useTranslations('reminder');
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(STORAGE_KEY) === today) return;

    let cancelled = false;
    fetch('/api/transactions?needsReview=true')
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: unknown[]) => {
        if (cancelled || !Array.isArray(rows) || rows.length === 0) return;
        setCount(rows.length);
        setOpen(true);
        localStorage.setItem(STORAGE_KEY, today);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const startReview = () => {
    setOpen(false);
    router.push('/transactions?review=1');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('body', { count })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('later')}
          </Button>
          <Button onClick={startReview}>{t('start')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
