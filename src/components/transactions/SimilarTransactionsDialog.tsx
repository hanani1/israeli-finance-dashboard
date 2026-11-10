'use client';

/**
 * Reusable "find similar transactions" dialog. Give it a source transaction
 * (id + description for the heading) and it fetches ranked matches from
 * GET /api/transactions/:id/similar, showing per-row match reasons and a
 * bounded "load more" pagination. Works from any screen that shows
 * transaction rows (transactions table, monthly drill-down, …).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TransactionAmount } from '@/components/transactions/TransactionAmount';
import { formatDate } from '@/lib/utils';

export interface SimilarSourceRef {
  id: string;
  description: string;
}

type SimilarReason =
  | 'exactDescription'
  | 'sameMerchant'
  | 'sharedTokens'
  | 'similarAmount'
  | 'sameCategory';

interface SimilarItem {
  id: string;
  date: string;
  description: string;
  chargedAmount: number;
  chargedCurrency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
  account: { displayName: string };
  category: { id: number; name: string; color: string } | null;
  score: number;
  reasons: SimilarReason[];
}

interface SimilarResponse {
  generic: boolean;
  items: SimilarItem[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

interface SimilarTransactionsDialogProps {
  /** The row the user asked about, or null when the dialog is closed. */
  source: SimilarSourceRef | null;
  onClose: () => void;
}

const PAGE_SIZE = 20;

export function SimilarTransactionsDialog({ source, onClose }: SimilarTransactionsDialogProps) {
  const t = useTranslations('similar');
  const [items, setItems] = useState<SimilarItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [generic, setGeneric] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const fetchPage = useCallback(
    async (sourceId: string, offset: number) => {
      setLoading(true);
      setError(false);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        const res = await fetch(`/api/transactions/${encodeURIComponent(sourceId)}/similar?${params}`);
        if (!res.ok) throw new Error(`Similar request failed (${res.status})`);
        const data = (await res.json()) as SimilarResponse;
        setItems((current) => (offset === 0 ? data.items : [...current, ...data.items]));
        setTotal(data.total);
        setHasMore(data.hasMore);
        setGeneric(data.generic);
      } catch (err) {
        console.error(err);
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Fresh fetch whenever a new source row is selected.
  useEffect(() => {
    if (!source) return;
    setItems([]);
    setTotal(0);
    setHasMore(false);
    setGeneric(false);
    void fetchPage(source.id, 0);
  }, [source, fetchPage]);

  const loadMore = () => {
    if (source && !loading) void fetchPage(source.id, items.length);
  };

  return (
    <Dialog open={source !== null} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="truncate" title={source?.description}>
            {source ? t('sourceLabel', { description: source.description }) : ''}
          </DialogDescription>
        </DialogHeader>

        {generic && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            {t('genericNote')}
          </p>
        )}

        <div className="max-h-[50vh] overflow-y-auto pe-1" role="region" aria-live="polite">
          {error ? (
            <p className="py-8 text-center text-sm text-red-600">{t('error')}</p>
          ) : loading && items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('loading')}</p>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <>
              <p className="pb-2 text-xs text-muted-foreground">
                {t('resultCount', { count: total })}
              </p>
              <ul className="space-y-1.5">
                {items.map((item) => (
                  <li key={item.id} className="rounded-md border p-2 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 truncate font-medium" title={item.description}>
                        {item.description}
                      </span>
                      <TransactionAmount txn={item} className="shrink-0" />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDate(item.date)} · {item.account.displayName}
                      {item.category ? ` · ${item.category.name}` : ''}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Badge variant="secondary" className="text-[10px]">
                        {t('score', { percent: Math.round(item.score * 100) })}
                      </Badge>
                      {item.reasons.map((reason) => (
                        <Badge key={reason} variant="outline" className="text-[10px]">
                          {t(`reason.${reason}`)}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <div className="pt-2 text-center">
                  <Button variant="outline" size="sm" disabled={loading} onClick={loadMore}>
                    {loading ? t('loading') : t('loadMore')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
