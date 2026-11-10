'use client';

/**
 * Reusable confirmation dialog for destructive actions.
 *
 * Controlled component: the parent owns the `open` state (typically by keeping
 * the "pending target" in state) and performs the actual action in `onConfirm`.
 * Button labels are translated (`common.*`); ADR-0007 requires every
 * destructive UI action to go through this dialog.
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

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  /** Label for the destructive action button. Defaults to the translated "Delete". */
  confirmLabel?: string;
  /** Disables both buttons while the action is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useTranslations('common');
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button variant="destructive" disabled={busy} autoFocus onClick={onConfirm}>
            {busy ? t('deleting') : (confirmLabel ?? t('delete'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
