'use client';

/**
 * Household member management — add, rename (inline), and delete members.
 * Deleting is refused by the API while a member still owns bank connections.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Pencil, Trash2, UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface Member {
  id: string;
  name: string;
}

interface HouseholdMembersProps {
  members: Member[];
  /** Ask the parent to re-fetch the member list after a mutation. */
  onChanged: () => Promise<void> | void;
}

export function HouseholdMembers({ members, onChanged }: HouseholdMembersProps) {
  const t = useTranslations('members');
  const tCommon = useTranslations('common');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Member awaiting delete confirmation. */
  const [pendingDelete, setPendingDelete] = useState<Member | null>(null);

  const readError = async (res: Response, fallback: string): Promise<string> => {
    try {
      const body = (await res.json()) as { error?: string };
      return body.error ?? fallback;
    } catch {
      return fallback;
    }
  };

  const handleAdd = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newName.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res, t('errAdd')));
      setNewName('');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errAdd'));
    } finally {
      setAdding(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res, t('errRename')));
      setEditingId(null);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errRename'));
    } finally {
      setBusy(false);
    }
  };

  /** Runs after the user confirms in the ConfirmDialog. */
  const handleDeleteConfirmed = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${pendingDelete.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await readError(res, t('errDelete')));
      setPendingDelete(null);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errDelete'));
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleAdd} className="flex items-end gap-3">
          <div className="max-w-xs flex-1 space-y-1.5">
            <Label htmlFor="new-member-name">{t('name')}</Label>
            <Input
              id="new-member-name"
              value={newName}
              placeholder={t('namePlaceholder')}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={adding || !newName.trim()}>
            <UserPlus className="h-4 w-4" aria-hidden />
            {adding ? t('adding') : t('add')}
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colName')}</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">{tCommon('actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  {editingId === member.id ? (
                    <Input
                      aria-label={t('newNameAria', { name: member.name })}
                      className="h-8 max-w-xs"
                      value={editName}
                      autoFocus
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRename(member.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                  ) : (
                    <span className="font-medium">{member.name}</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {editingId === member.id ? (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t('saveName')}
                          disabled={busy || !editName.trim()}
                          onClick={() => void handleRename(member.id)}
                        >
                          <Check className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t('cancelRename')}
                          onClick={() => setEditingId(null)}
                        >
                          <X className="h-4 w-4" aria-hidden />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t('renameAria', { name: member.name })}
                          onClick={() => {
                            setEditingId(member.id);
                            setEditName(member.name);
                          }}
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button
                          size="icon"
                          variant="destructive"
                          aria-label={t('deleteAria', { name: member.name })}
                          disabled={busy}
                          onClick={() => setPendingDelete(member)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('deleteTitle')}
        description={pendingDelete ? t('deleteDesc', { name: pendingDelete.name }) : ''}
        confirmLabel={t('deleteConfirm')}
        busy={busy}
        onConfirm={() => void handleDeleteConfirmed()}
        onCancel={() => setPendingDelete(null)}
      />
    </Card>
  );
}
