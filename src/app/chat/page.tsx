'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MessageCircle, RefreshCw, SendHorizonal } from 'lucide-react';
import { ConversationDrawer, ConversationList } from '@/components/chat/ConversationSidebar';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useGlobalFilters } from '@/lib/hooks/useGlobalFilters';
import { sortConversations, upsertConversation, type ConversationListEntry } from '@/lib/services/chatConversationList';
import { cn } from '@/lib/utils';

interface ToolCall {
  tool: string;
  detail: string;
  rows?: number;
  truncated?: boolean;
  error?: string;
}

/** Mirrors ClientChatMessage (src/lib/services/chatConversation.ts). */
interface ChatMessage {
  id: string;
  conversationId: string;
  question: string;
  status: 'pending' | 'completed' | 'failed';
  answer: string | null;
  toolCalls: ToolCall[];
  errorCode: string | null;
}

/** A question accepted locally but not yet confirmed by the server. */
interface Outbox {
  idempotencyKey: string;
  message: string;
  conversationId: string | null;
  userId: string | null;
}

const ERROR_CODES = new Set([
  'disabled', 'not-local', 'rate-limited', 'config', 'db', 'cli-missing', 'not-logged-in',
  'timeout', 'output-limit', 'cli-error', 'bad-output', 'max-rounds', 'interrupted', 'busy',
  'not-found', 'idempotency-conflict', 'unknown',
]);

const ACTIVE_KEY = 'finance-chat:active-conversation';
const OUTBOX_KEY = 'finance-chat:outbox';
const POLL_MS = 1_500;

/** Works on plain-http LAN origins too (crypto.randomUUID needs a secure context). */
function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readOutbox(): Outbox | null {
  try {
    const raw = sessionStorage.getItem(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as Outbox) : null;
  } catch {
    return null;
  }
}

/**
 * צ׳אט — free-text questions about the household's finances (ADR-0026).
 * Answered by a tool-less Hermes (or Kiro) run on the host; the server runs
 * every data lookup read-only and the lookups are listed under each answer.
 *
 * Questions run in the background on the server and are persisted
 * (ADR-0028): this page submits with an idempotency key, then polls the
 * conversation while a question is pending, so leaving / refreshing the page
 * neither loses nor re-runs a question. A chat-only conversation list (a
 * column on md+, a drawer below md) switches between saved conversations.
 */
export default function ChatPage() {
  const t = useTranslations('chat');
  const { filters } = useGlobalFilters();
  const [status, setStatus] = useState<{ enabled: boolean; provider: string | null } | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [conversations, setConversations] = useState<ConversationListEntry[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);

  const errorText = useCallback(
    (code: string | null | undefined, fallback?: string) => {
      if (code && ERROR_CODES.has(code)) return t(`errors.${code}`);
      return fallback ? `${t('error')}\n${fallback}` : t('error');
    },
    [t],
  );

  const selectConversation = useCallback((id: string | null) => {
    if (activeRef.current !== id) setMessages([]);
    activeRef.current = id;
    setConversationId(id);
    setNotice(null);
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const response = await fetch('/api/chat/conversations', { cache: 'no-store' });
      const payload = (await response.json().catch(() => ({}))) as { conversations?: ConversationListEntry[] };
      if (response.ok && Array.isArray(payload.conversations)) setConversations(sortConversations(payload.conversations));
    } catch (error) {
      console.error(error);
    } finally {
      setListLoaded(true);
    }
  }, []);

  /** Loads (or re-polls) a conversation; ignores responses for a conversation no longer shown. */
  const loadConversation = useCallback(
    async (id: string) => {
      const response = await fetch(`/api/chat/conversations/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (activeRef.current !== id) return;
      if (response.status === 404) {
        selectConversation(null);
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as {
        conversation?: Omit<ConversationListEntry, 'pending'>;
        messages?: ChatMessage[];
        code?: string;
        error?: string;
      };
      if (activeRef.current !== id) return;
      if (!response.ok || !Array.isArray(payload.messages)) {
        setNotice(errorText(payload.code, payload.error));
        return;
      }
      const loaded = payload.messages;
      setMessages(loaded);
      if (payload.conversation) {
        const entry = { ...payload.conversation, pending: loaded.some((m) => m.status === 'pending') };
        setConversations((previous) => upsertConversation(previous, entry));
      }
    },
    [errorText, selectConversation],
  );

  const send = useCallback(
    async (item: Outbox) => {
      sessionStorage.setItem(OUTBOX_KEY, JSON.stringify(item));
      setOutbox(item);
      setNotice(null);
      let settled = false;
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          // Outlives a page close / full navigation, so the server still gets
          // the question; the answer is then picked up from the conversation.
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: item.message,
            idempotencyKey: item.idempotencyKey,
            conversationId: item.conversationId ?? undefined,
            userId: item.userId ?? undefined,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as { message?: ChatMessage; code?: string; error?: string };
        settled = true;
        if (response.ok && payload.message) {
          const message = payload.message;
          // Follow the answer only if the user is still where they asked it
          // (they may have switched conversations while the POST was in flight).
          if (activeRef.current === item.conversationId || activeRef.current === message.conversationId) {
            if (activeRef.current !== message.conversationId) selectConversation(message.conversationId);
            setMessages((previous) => [...previous.filter((m) => m.id !== message.id), message]);
            void loadConversation(message.conversationId);
          }
          void refreshList();
        } else {
          setNotice(errorText(payload.code, payload.error));
          if (payload.code === 'busy' && item.conversationId) void loadConversation(item.conversationId);
          if (payload.code === 'not-found') selectConversation(null);
        }
      } catch (error) {
        console.error(error);
        setNotice(t('error'));
      } finally {
        // No server answer (network error, page unloading): keep the stored
        // outbox so the next visit replays it under the same idempotency key.
        if (settled) sessionStorage.removeItem(OUTBOX_KEY);
        setOutbox(null);
      }
    },
    [errorText, loadConversation, refreshList, selectConversation, t],
  );

  useEffect(() => {
    fetch('/api/chat')
      .then((response) => response.json())
      .then((payload: { enabled?: boolean; provider?: string | null }) =>
        setStatus({ enabled: payload.enabled === true, provider: payload.provider ?? null }),
      )
      .catch(() => setStatus({ enabled: false, provider: null }));
  }, []);

  // Restore after navigation / refresh: the last active conversation, and a
  // question whose POST may not have reached the server (same idempotency
  // key, so it can never run twice).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!status?.enabled || restoredRef.current) return;
    restoredRef.current = true;
    void refreshList();
    const pendingSend = readOutbox();
    const active = localStorage.getItem(ACTIVE_KEY);
    if (active) {
      selectConversation(active);
      void loadConversation(active);
    }
    if (pendingSend) void send(pendingSend);
  }, [status?.enabled, loadConversation, refreshList, selectConversation, send]);

  const hasPending = messages.some((message) => message.status === 'pending');
  useEffect(() => {
    if (!conversationId || !hasPending) return;
    const timer = setInterval(() => void loadConversation(conversationId), POLL_MS);
    return () => clearInterval(timer);
  }, [conversationId, hasPending, loadConversation]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, outbox, notice]);

  const busy = hasPending || outbox !== null;

  // Other conversations may still be answering in the background: keep their
  // pending markers fresh while any is shown as pending.
  const anyListedPending = conversations.some((c) => c.pending && c.id !== conversationId);
  useEffect(() => {
    if (!anyListedPending) return;
    const timer = setInterval(() => void refreshList(), POLL_MS * 2);
    return () => clearInterval(timer);
  }, [anyListedPending, refreshList]);

  function openConversation(id: string) {
    if (id === activeRef.current) return;
    selectConversation(id);
    void loadConversation(id);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    void send({
      idempotencyKey: newIdempotencyKey(),
      message,
      conversationId,
      userId: filters.userId || null,
    });
  }

  async function retry(id: string) {
    setNotice(null);
    const response = await fetch(`/api/chat/messages/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    const payload = (await response.json().catch(() => ({}))) as { message?: ChatMessage; code?: string; error?: string };
    if (response.ok && payload.message) {
      const message = payload.message;
      setMessages((previous) => previous.map((m) => (m.id === message.id ? message : m)));
    } else {
      setNotice(errorText(payload.code, payload.error));
    }
    if (conversationId) void loadConversation(conversationId);
  }

  const disabled = status !== null && !status.enabled;
  const providerLabel = status?.provider === 'kiro' ? 'Kiro CLI' : 'Hermes';
  const showOutbox =
    outbox !== null &&
    outbox.conversationId === conversationId &&
    !messages.some((m) => m.question === outbox.message && m.status === 'pending');

  const listProps = {
    conversations,
    activeId: conversationId,
    loading: !listLoaded,
    newChatDisabled: outbox !== null || (conversationId === null && messages.length === 0),
    onSelect: openConversation,
    onNewChat: () => selectConversation(null),
  };
  const activeTitle = conversations.find((c) => c.id === conversationId)?.title;

  return (
    <div className="mx-auto flex h-[calc(100dvh-11.5rem)] max-w-5xl gap-4 md:h-[calc(100dvh-8rem)]">
      {!disabled && (
        <aside className="hidden w-60 shrink-0 flex-col border-e pe-3 md:flex" data-testid="chat-sidebar">
          <ConversationList {...listProps} />
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {disabled ? (
          <p className="rounded-md border border-muted bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            {t('disabled')}
          </p>
        ) : (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {t('disclosure', { provider: providerLabel })}
            {filters.userId ? <span className="mt-1 block">{t('memberScope')}</span> : null}
          </p>
        )}

        {!disabled && (
          <div className="flex items-center gap-2 md:hidden">
            <ConversationDrawer {...listProps} open={drawerOpen} onOpenChange={setDrawerOpen} />
            <span dir="auto" className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="chat-active-title">
              {activeTitle ?? t('newChat')}
            </span>
          </div>
        )}

        <Card className="flex min-h-0 flex-1 flex-col">
          <CardContent
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
            aria-live="polite"
            data-testid="chat-messages"
          >
            {messages.length === 0 && !showOutbox && (
              <div className="m-auto flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
                <MessageCircle className="h-8 w-8" aria-hidden />
                <p>{t('empty')}</p>
                <p className="text-xs">{t('exampleQuestion')}</p>
              </div>
            )}
            {messages.map((message) => (
              <ChatTurn key={message.id} message={message} busy={busy} describe={errorText} onRetry={retry} />
            ))}
            {showOutbox && outbox && (
              <>
                <Bubble role="user">{outbox.message}</Bubble>
                <Thinking label={t('thinking')} />
              </>
            )}
            {notice && <Bubble role="error">{notice}</Bubble>}
            <div ref={bottomRef} />
          </CardContent>
        </Card>

        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <Input
            dir="auto"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={busy ? t('waitForAnswer') : t('placeholder')}
            maxLength={4000}
            aria-label={t('placeholder')}
            disabled={disabled}
          />
          <Button type="submit" disabled={busy || disabled || input.trim().length === 0} aria-label={t('send')}>
            <SendHorizonal className="h-4 w-4 rtl:rotate-180" aria-hidden />
          </Button>
        </form>
      </div>
    </div>
  );
}

function ChatTurn({
  message,
  busy,
  describe,
  onRetry,
}: {
  message: ChatMessage;
  busy: boolean;
  describe: (code: string | null) => string;
  onRetry: (id: string) => void;
}) {
  const t = useTranslations('chat');
  return (
    <>
      <Bubble role="user">{message.question}</Bubble>
      {message.status === 'pending' && <Thinking label={t('thinking')} />}
      {message.status === 'completed' && (
        <Bubble role="assistant">
          {message.answer}
          {message.toolCalls.length > 0 && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">{t('lookups', { count: message.toolCalls.length })}</summary>
              <ul className="mt-1 space-y-1">
                {message.toolCalls.map((call, callIndex) => (
                  <li key={callIndex} dir="ltr" className="break-words font-mono text-[11px]">
                    {call.detail}
                    {call.rows !== undefined && ` — ${t('lookupRows', { rows: call.rows })}`}
                    {call.truncated && ` ${t('lookupTruncated')}`}
                    {call.error && <span className="block text-destructive">{call.error}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Bubble>
      )}
      {message.status === 'failed' && (
        <Bubble role="error">
          {describe(message.errorCode)}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 flex gap-1.5"
            onClick={() => onRetry(message.id)}
            disabled={busy}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            {t('retry')}
          </Button>
        </Bubble>
      )}
    </>
  );
}

function Bubble({ role, children }: { role: 'user' | 'assistant' | 'error'; children: React.ReactNode }) {
  return (
    <div
      dir="auto"
      data-role={role}
      className={cn(
        'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
        role === 'user' && 'self-end rounded-ee-sm bg-primary text-primary-foreground',
        role === 'assistant' && 'self-start rounded-ss-sm bg-muted',
        role === 'error' && 'self-start bg-destructive/10 text-destructive',
      )}
    >
      {children}
    </div>
  );
}

function Thinking({ label }: { label: string }) {
  return (
    <div
      data-role="pending"
      className="max-w-[85%] self-start rounded-2xl rounded-ss-sm bg-muted px-3.5 py-2 text-sm text-muted-foreground"
    >
      <span className="animate-pulse">{label}</span>
    </div>
  );
}
