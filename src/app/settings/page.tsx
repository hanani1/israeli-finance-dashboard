'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch, describeApiError } from '@/lib/client/api';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate } from '@/lib/utils';
import { HouseholdMembers } from '@/components/settings/HouseholdMembers';

/* ------------------------------- API types ------------------------------- */

interface UserOption {
  id: string;
  name: string;
}

interface CategoryOption {
  id: number;
  name: string;
  color: string;
  type: string;
}

interface Credential {
  id: string;
  userId: string;
  userName: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
}

interface Rule {
  id: number;
  pattern: string;
  priority: number;
  createdAt: string;
  category: {
    id: number;
    name: string;
    color: string;
  };
}

interface SyncSummary {
  credentialsProcessed: number;
  accountsUpserted: number;
  transactionsUpserted: number;
  rulesApplied: number;
  llmCategorized: number;
  errors: string[];
  /** Coverage problems (stale or gapped providers) that errors alone miss. */
  warnings?: string[];
  /** Isracard saved in Docker: the first import runs with the next host sync. */
  deferred?: boolean;
  deferredReason?: string;
}

interface CredentialCreateResponse {
  credential: Credential;
  sync: SyncSummary;
}

/* ------------------------------- Providers ------------------------------- */

/** israeli-bank-scrapers company ids with display labels. */
const PROVIDERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'hapoalim', label: 'Bank Hapoalim' },
  { value: 'leumi', label: 'Bank Leumi' },
  { value: 'discount', label: 'Discount Bank' },
  { value: 'mercantile', label: 'Mercantile Bank' },
  { value: 'mizrahi', label: 'Mizrahi Tefahot' },
  { value: 'otsarHahayal', label: 'Otsar HaHayal' },
  { value: 'visaCal', label: 'Visa Cal' },
  { value: 'max', label: 'Max' },
  { value: 'isracard', label: 'Isracard' },
  { value: 'amex', label: 'American Express' },
  { value: 'union', label: 'Union Bank' },
  { value: 'beinleumi', label: 'Beinleumi (First International)' },
  { value: 'massad', label: 'Massad' },
  { value: 'yahav', label: 'Yahav' },
  { value: 'oneZero', label: 'One Zero' },
  { value: 'behatsdaa', label: 'Behatsdaa' },
];

const LOGIN_FIELDS: ReadonlyArray<{
  key: keyof LoginFieldValues;
  type: 'text' | 'password';
}> = [
  { key: 'username', type: 'text' },
  { key: 'password', type: 'password' },
  { key: 'id', type: 'text' },
  { key: 'card6Digits', type: 'password' },
  { key: 'num', type: 'text' },
];

interface LoginFieldValues {
  username: string;
  password: string;
  id: string;
  card6Digits: string;
  num: string;
}

const EMPTY_LOGIN_FIELDS: LoginFieldValues = {
  username: '',
  password: '',
  id: '',
  card6Digits: '',
  num: '',
};

/* --------------------------------- Page ---------------------------------- */

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tRules = useTranslations('rules');
  const tCommon = useTranslations('common');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);

  // Bank connection form state
  const [credentialUserId, setCredentialUserId] = useState('');
  const [provider, setProvider] = useState('');
  const [loginFields, setLoginFields] = useState<LoginFieldValues>(EMPTY_LOGIN_FIELDS);
  const [savingCredential, setSavingCredential] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  /** Credential awaiting delete confirmation. */
  const [credentialPendingDelete, setCredentialPendingDelete] = useState<Credential | null>(null);
  const [deletingCredential, setDeletingCredential] = useState(false);

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Rule form state
  const [rulePattern, setRulePattern] = useState('');
  const [ruleCategoryId, setRuleCategoryId] = useState('');
  const [rulePriority, setRulePriority] = useState('1');
  const [savingRule, setSavingRule] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
  /** Rule awaiting delete confirmation. */
  const [rulePendingDelete, setRulePendingDelete] = useState<Rule | null>(null);
  const [deletingRule, setDeletingRule] = useState(false);

  const loadCredentials = useCallback(async () => {
    try {
      const res = await fetch('/api/credentials');
      if (!res.ok) throw new Error(`Failed to load credentials (${res.status})`);
      setCredentials((await res.json()) as Credential[]);
    } catch {
      setCredentialError(t('errLoadCredentials'));
    }
  }, [t]);

  const loadRules = useCallback(async () => {
    try {
      const res = await fetch('/api/rules');
      if (!res.ok) throw new Error(`Failed to load rules (${res.status})`);
      setRules((await res.json()) as Rule[]);
    } catch {
      setRuleError(tRules('errLoad'));
    }
  }, [tRules]);

  const loadUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/users');
      if (!res.ok) throw new Error(`Failed to load household members (${res.status})`);
      setUsers((await res.json()) as UserOption[]);
    } catch {
      setCredentialError(t('errLoadMembers'));
    }
  }, [t]);

  useEffect(() => {
    void loadUsers();
    fetch('/api/categories')
      .then((res) => (res.ok ? (res.json() as Promise<CategoryOption[]>) : []))
      .then(setCategories)
      .catch(() => setRuleError(t('errLoadCategories')));
    void loadCredentials();
    void loadRules();
  }, [loadUsers, loadCredentials, loadRules, t]);

  /** Translated failure + the server's reason (card #51). */
  const describeError = (error: unknown, fallback: string): string =>
    describeApiError(error, fallback, { networkMessage: tCommon('networkError') });

  /* --------------------------- Bank connections --------------------------- */

  const handleLoginFieldChange = (key: keyof LoginFieldValues, value: string) => {
    setLoginFields((current) => ({ ...current, [key]: value }));
  };

  const handleCredentialSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!credentialUserId || !provider) {
      setCredentialError(t('errChooseMemberProvider'));
      return;
    }
    setSavingCredential(true);
    setCredentialError(null);
    setSyncError(null);
    setSyncSummary(null);
    try {
      const filledFields: Record<string, string> = {};
      for (const { key } of LOGIN_FIELDS) {
        if (loginFields[key].trim()) {
          filledFields[key] = loginFields[key].trim();
        }
      }
      const result = await apiFetch<CredentialCreateResponse>('/api/credentials', {
        method: 'POST',
        json: {
          userId: credentialUserId,
          provider,
          loginFields: filledFields,
        },
      });
      // Never keep secrets around in state after a successful save.
      setLoginFields(EMPTY_LOGIN_FIELDS);
      setSyncSummary(result.sync);
      if (result.sync.errors.length > 0) {
        setSyncError(t('errInitialSync'));
      }
      await loadCredentials();
    } catch (error) {
      // Surface the server's reason (e.g. "Initial sync failed; the connection was not saved.").
      // 409: another sync holds the ingestion lock; the server rolled the save back.
      if (error instanceof ApiError && error.status === 409) setCredentialError(t('errCredentialSyncBusy'));
      else setCredentialError(describeError(error, t('errSaveCredential')));
    } finally {
      setSavingCredential(false);
    }
  };

  /** Runs after the user confirms in the ConfirmDialog. */
  const handleCredentialDeleteConfirmed = async () => {
    if (!credentialPendingDelete) return;
    setCredentialError(null);
    setDeletingCredential(true);
    try {
      await apiFetch(`/api/credentials/${credentialPendingDelete.id}`, { method: 'DELETE' });
      setCredentialPendingDelete(null);
      await loadCredentials();
    } catch (error) {
      setCredentialError(describeError(error, t('errDeleteCredential')));
      setCredentialPendingDelete(null);
    } finally {
      setDeletingCredential(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncSummary(null);
    try {
      setSyncSummary(await apiFetch<SyncSummary>('/api/sync', { method: 'POST' }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setSyncError(t('syncAlreadyRunning'));
      else setSyncError(describeError(error, t('errSync')));
    } finally {
      setSyncing(false);
    }
  };

  /* ------------------------------ Rules ----------------------------------- */

  const handleRuleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rulePattern.trim() || !ruleCategoryId) {
      setRuleError(tRules('errValidation'));
      return;
    }
    setSavingRule(true);
    setRuleError(null);
    try {
      await apiFetch('/api/rules', {
        method: 'POST',
        json: {
          pattern: rulePattern.trim(),
          categoryId: Number(ruleCategoryId),
          priority: Number(rulePriority) || 1,
        },
      });
      setRulePattern('');
      setRuleCategoryId('');
      setRulePriority('1');
      await loadRules();
    } catch (error) {
      setRuleError(describeError(error, tRules('errCreate')));
    } finally {
      setSavingRule(false);
    }
  };

  /** Runs after the user confirms in the ConfirmDialog. */
  const handleRuleDeleteConfirmed = async () => {
    if (!rulePendingDelete) return;
    setRuleError(null);
    setDeletingRule(true);
    try {
      await apiFetch(`/api/rules/${rulePendingDelete.id}`, { method: 'DELETE' });
      setRulePendingDelete(null);
      await loadRules();
    } catch (error) {
      setRuleError(describeError(error, tRules('errDelete')));
      setRulePendingDelete(null);
    } finally {
      setDeletingRule(false);
    }
  };

  const providerLabel = (value: string): string =>
    PROVIDERS.find((p) => p.value === value)?.label ?? value;

  return (
    <div className="flex flex-col gap-6">
      {/* --------------------------- Household members -------------------------- */}
      <HouseholdMembers members={users} onChanged={loadUsers} />

      {/* --------------------------- Bank connections --------------------------- */}
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle>{t('bankConnections')}</CardTitle>
            <CardDescription>{t('bankConnectionsDesc')}</CardDescription>
          </div>
          <Button onClick={handleSync} disabled={syncing} aria-label={t('syncAria')}>
            <RefreshCw className={syncing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
            {syncing ? t('syncing') : t('syncNow')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-6">
          {syncError && <p className="text-sm text-destructive">{syncError}</p>}
          {syncSummary?.deferred && (
            <div className="rounded-md border bg-muted/50 p-3 text-sm">
              <p>{t('syncDeferred')}</p>
            </div>
          )}
          {syncSummary && !syncSummary.deferred && (
            <div className="rounded-md border bg-muted/50 p-3 text-sm">
              <p>
                {t('syncComplete', {
                  creds: syncSummary.credentialsProcessed,
                  accounts: syncSummary.accountsUpserted,
                  txns: syncSummary.transactionsUpserted,
                  rules: syncSummary.rulesApplied,
                  llm: syncSummary.llmCategorized,
                })}
              </p>
              {syncSummary.errors.length > 0 && (
                <ul className="mt-2 list-inside list-disc text-destructive">
                  {syncSummary.errors.map((error, index) => (
                    <li key={index}>{error}</li>
                  ))}
                </ul>
              )}
              {(syncSummary.warnings?.length ?? 0) > 0 && (
                <ul className="mt-2 list-inside list-disc text-amber-600">
                  {syncSummary.warnings!.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <form onSubmit={handleCredentialSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="credential-user">{t('member')}</Label>
                <Select value={credentialUserId} onValueChange={setCredentialUserId}>
                  <SelectTrigger id="credential-user" aria-label={t('member')}>
                    <SelectValue placeholder={t('chooseMember')} />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((user) => (
                      <SelectItem key={user.id} value={String(user.id)}>
                        {user.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credential-provider">{t('provider')}</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger id="credential-provider" aria-label={t('provider')}>
                    <SelectValue placeholder={t('chooseProvider')} />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {LOGIN_FIELDS.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`login-${field.key}`}>{t(`field.${field.key}`)}</Label>
                  <Input
                    id={`login-${field.key}`}
                    type={field.type}
                    autoComplete="off"
                    value={loginFields[field.key]}
                    onChange={(e) => handleLoginFieldChange(field.key, e.target.value)}
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t('fieldsHint')}</p>
            <p className="text-xs font-medium text-amber-700">{t('viewOnlyHint')}</p>

            {credentialError && <p className="text-sm text-destructive">{credentialError}</p>}

            <Button type="submit" disabled={savingCredential}>
              {savingCredential ? t('addingAndSyncing') : t('addConnection')}
            </Button>
          </form>

          {credentials.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noConnections')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('colProvider')}</TableHead>
                  <TableHead>{t('colMember')}</TableHead>
                  <TableHead>{t('colUpdated')}</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">{tCommon('actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.map((credential) => (
                  <TableRow key={credential.id}>
                    <TableCell>{providerLabel(credential.provider)}</TableCell>
                    <TableCell>{credential.userName}</TableCell>
                    <TableCell>{formatDate(credential.updatedAt)}</TableCell>
                    <TableCell>
                      <Button
                        variant="destructive"
                        size="icon"
                        aria-label={t('deleteConnAria', {
                          provider: providerLabel(credential.provider),
                          member: credential.userName,
                        })}
                        onClick={() => setCredentialPendingDelete(credential)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* -------------------------- Categorization rules ------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle>{tRules('title')}</CardTitle>
          <CardDescription>{tRules('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form
            onSubmit={handleRuleSubmit}
            className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="rule-pattern">{tRules('pattern')}</Label>
              <Input
                id="rule-pattern"
                value={rulePattern}
                placeholder={tRules('patternPlaceholder')}
                onChange={(e) => setRulePattern(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-category">{tRules('category')}</Label>
              <Select value={ruleCategoryId} onValueChange={setRuleCategoryId}>
                <SelectTrigger id="rule-category" aria-label={tRules('category')}>
                  <SelectValue placeholder={tRules('chooseCategory')} />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={String(category.id)}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-priority">{tRules('priority')}</Label>
              <Input
                id="rule-priority"
                type="number"
                min={1}
                value={rulePriority}
                onChange={(e) => setRulePriority(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={savingRule}>
              {savingRule ? tRules('adding') : tRules('add')}
            </Button>
          </form>

          {ruleError && <p className="text-sm text-destructive">{ruleError}</p>}

          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tRules('empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tRules('pattern')}</TableHead>
                  <TableHead>{tRules('category')}</TableHead>
                  <TableHead>{tRules('priority')}</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">{tCommon('actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className="font-mono text-xs">{rule.pattern}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: rule.category.color }}
                          aria-hidden
                        />
                        {rule.category.name}
                      </span>
                    </TableCell>
                    <TableCell>{rule.priority}</TableCell>
                    <TableCell>
                      <Button
                        variant="destructive"
                        size="icon"
                        aria-label={tRules('deleteAria', { pattern: rule.pattern })}
                        onClick={() => setRulePendingDelete(rule)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------- Security -------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>{t('security')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('securityText')}</p>
        </CardContent>
      </Card>

      {/* ------------------------ Delete confirmations -------------------------- */}
      <ConfirmDialog
        open={credentialPendingDelete !== null}
        title={t('deleteConnTitle')}
        description={
          credentialPendingDelete
            ? t('deleteConnDesc', {
                provider: providerLabel(credentialPendingDelete.provider),
                member: credentialPendingDelete.userName,
              })
            : ''
        }
        confirmLabel={t('deleteConnConfirm')}
        busy={deletingCredential}
        onConfirm={() => void handleCredentialDeleteConfirmed()}
        onCancel={() => setCredentialPendingDelete(null)}
      />
      <ConfirmDialog
        open={rulePendingDelete !== null}
        title={tRules('deleteTitle')}
        description={
          rulePendingDelete
            ? tRules('deleteDesc', {
                pattern: rulePendingDelete.pattern,
                category: rulePendingDelete.category.name,
              })
            : ''
        }
        confirmLabel={tRules('deleteConfirm')}
        busy={deletingRule}
        onConfirm={() => void handleRuleDeleteConfirmed()}
        onCancel={() => setRulePendingDelete(null)}
      />
    </div>
  );
}
