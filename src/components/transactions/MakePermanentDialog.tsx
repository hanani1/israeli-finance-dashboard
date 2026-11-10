'use client';

/**
 * Asked right after the user reclassifies a transaction from the monthly
 * breakdown drill-down: should this classification be permanent? "Yes" applies
 * the category to all identical (same-description) transactions and creates a
 * rule for future ones; "No" keeps just the single change already made.
 */
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

interface MakePermanentDialogProps {
  open: boolean;
  categoryName: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MakePermanentDialog({
  open,
  categoryName,
  busy = false,
  onConfirm,
  onCancel,
}: MakePermanentDialogProps) {
  const t = useTranslations('breakdown');
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('makePermanentTitle')}</DialogTitle>
          <DialogDescription>{t('makePermanentDesc', { category: categoryName })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {t('makePermanentCancel')}
          </Button>
          <Button disabled={busy} autoFocus onClick={onConfirm}>
            {busy ? t('saving') : t('makePermanentConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
