import { randomUUID } from 'node:crypto';
import { DEFAULT_CHAT_TIMEOUT_MS, runChatModel } from './chatCli';
import {
  conversationTitle,
  historyFor,
  staleReason,
  toClientMessage,
  transition,
  type ChatMessageEvent,
  type ClientChatMessage,
} from './chatConversation';
import { DEFAULT_CHAT_MAX_ROUNDS, MAX_CHAT_MAX_ROUNDS, runChatLoop } from './chatLoop';
import type { ChatContext } from './chatProtocol';
import { executeReadonlyQuery } from './chatReadonlyDb';
import {
  ChatInvocationError,
  ChatRateLimiter,
  chatCliProvider,
  chatFailureResponse,
} from './chatSession';
import { buildScopedQuery, type ScopedQuery } from './chatSqlValidator';
import { prismaChatStore, type ChatStore, type StoredChatMessage } from './chatStore';
import { localCalendarDay } from './localDay';

/**
 * Finance chat (ADR-0026, ADR-0027): free-text questions answered by a
 * host-side, tool-less Hermes (default) or Kiro one-shot run, with the SERVER
 * running every data lookup read-only through the `finance_chat_ro` role.
 *
 * Questions are persisted (ChatConversation / ChatMessage) and run in the
 * BACKGROUND: submit returns the pending message at once, the loop runs in
 * this process independent of the HTTP request, and the page polls. A
 * client idempotency key makes a refresh / double-submit return the same
 * message instead of running the question twice. Pending messages whose
 * process died (restart) are recovered as failed/`interrupted` and can be
 * retried.
 *
 * Per question: up to CHAT_MAX_ROUNDS (default 4) model calls, each with the
 * capped conversation history (completed turns, from the database) replayed.
 * Chat work is serialized and globally rate limited.
 */

/** Errors the HTTP layer maps to a status + stable code (never CLI detail). */
export class ChatRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'not-found' | 'busy' | 'idempotency-conflict' | 'rate-limited' | 'not-retryable',
    message: string,
  ) {
    super(message);
    this.name = 'ChatRequestError';
  }
}

export interface ChatServiceDeps {
  store: ChatStore;
  invokeModel(prompt: string): Promise<string>;
  executeQuery(query: ScopedQuery): Promise<Record<string, unknown>[]>;
  loadContext?(userId: string | null): Promise<ChatContext>;
  /** Records one run against the global budget; false = rate limited. */
  acquireSlot(): boolean;
  /** Unique per process instance; pending rows of other ids are recovered. */
  runnerId: string;
  maxRounds: number;
  /** Per model call (CLI) timeout; the run deadline is derived from it. */
  timeoutMs: number;
  /** Max wait in the serialized queue before a message counts as timed out. */
  queueDeadlineMs?: number;
  now?(): Date;
  log?(message: string, error: unknown): void;
}

export interface SubmitInput {
  message: string;
  conversationId?: string;
  idempotencyKey: string;
  userId: string | null;
}

export interface ConversationView {
  conversation: { id: string; title: string; createdAt: string; updatedAt: string };
  messages: ClientChatMessage[];
}

export interface ConversationListItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pending: boolean;
}

export const DEFAULT_QUEUE_DEADLINE_MS = 60 * 60_000;
/** Slack on top of rounds × CLI timeout for context loading and DB lookups. */
const RUN_DEADLINE_SLACK_MS = 60_000;
export const MAX_LISTED_CONVERSATIONS = 50;

export function createChatService(deps: ChatServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, error) => console.error(message, error));
  const loadContext = deps.loadContext ?? ((userId) => loadReadonlyContext(userId, deps.executeQuery));
  const runDeadlineMs = deps.maxRounds * deps.timeoutMs + RUN_DEADLINE_SLACK_MS;
  const queueDeadlineMs = deps.queueDeadlineMs ?? DEFAULT_QUEUE_DEADLINE_MS;

  let queue: Promise<unknown> = Promise.resolve();
  function enqueue(task: () => Promise<void>): Promise<void> {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  }

  /** Applies a state-machine event as a compare-and-set write. */
  async function apply(message: StoredChatMessage, event: ChatMessageEvent): Promise<StoredChatMessage | null> {
    const next = transition(message, event);
    if (!next.ok) return null;
    const { status, answer, toolCalls, errorCode, runnerId, attempts, startedAt, completedAt } = next.state;
    const applied = await deps.store.updateMessage(
      message.id,
      { status: message.status, runnerId: message.runnerId },
      { status, answer, toolCalls, errorCode, runnerId, attempts, startedAt, completedAt },
      event.at,
    );
    return applied ? { ...message, ...next.state, updatedAt: event.at } : null;
  }

  /** Marks pending messages that can no longer complete as failed (restart / overdue). */
  async function recoverStale(messages?: StoredChatMessage[]): Promise<void> {
    const candidates = messages ?? (await deps.store.listPendingMessages());
    const at = now();
    for (const message of candidates) {
      const reason = staleReason(message, { now: at, runnerId: deps.runnerId, runDeadlineMs, queueDeadlineMs });
      if (reason) await apply(message, { type: 'recover', errorCode: reason, at });
    }
  }

  async function run(messageId: string): Promise<void> {
    let message = await deps.store.getMessage(messageId);
    if (!message) return;
    // Recovered (deadline) or retried by someone else while queued: skip.
    message = await apply(message, { type: 'start', runnerId: deps.runnerId, at: now() });
    if (!message) return;
    try {
      const turns = historyFor(await deps.store.listMessages(message.conversationId), message.id);
      const context = await loadContext(message.userId);
      const result = await runChatLoop(
        { question: message.question, history: turns, context, userId: message.userId, maxRounds: deps.maxRounds },
        { invokeModel: deps.invokeModel, executeQuery: deps.executeQuery },
      );
      const done = await apply(message, {
        type: 'complete',
        runnerId: deps.runnerId,
        answer: result.answer,
        toolCalls: result.toolCalls,
        at: now(),
      });
      if (!done) log('[chat] result dropped: message is no longer pending', message.id);
    } catch (error) {
      // Full detail (including CLI stderr) stays in the server log; the row
      // only gets the curated code the page localizes.
      log('[chat] message failed:', error);
      const { code } = chatFailureResponse(error);
      await apply(message, { type: 'fail', runnerId: deps.runnerId, errorCode: code, at: now() });
    }
  }

  function schedule(messageId: string): void {
    void enqueue(() => run(messageId)).catch((error) => log('[chat] background run crashed:', error));
  }

  return {
    /**
     * Accepts a question and returns its (usually pending) message at once;
     * the answer is produced in the background. Same idempotency key → same
     * message, never a second run.
     */
    async submit(input: SubmitInput): Promise<{ created: boolean; message: ClientChatMessage }> {
      const existing = await deps.store.findMessageByIdempotencyKey(input.idempotencyKey);
      if (existing) return { created: false, message: toClientMessage(sameSubmission(existing, input)) };

      if (input.conversationId) {
        const conversation = await deps.store.getConversation(input.conversationId);
        if (!conversation) throw new ChatRequestError(404, 'not-found', 'Conversation not found.');
        const messages = await deps.store.listMessages(input.conversationId);
        await recoverStale(messages.filter((message) => message.status === 'pending'));
        const refreshed = await deps.store.listMessages(input.conversationId);
        if (refreshed.some((message) => message.status === 'pending')) {
          throw new ChatRequestError(409, 'busy', 'A question in this conversation is still running.');
        }
      }

      if (!deps.acquireSlot()) {
        throw new ChatRequestError(429, 'rate-limited', 'Too many chat messages. Wait a minute and try again.');
      }
      const { created, message } = await deps.store.createMessage({
        conversationId: input.conversationId,
        title: conversationTitle(input.message),
        idempotencyKey: input.idempotencyKey,
        question: input.message,
        userId: input.userId,
        runnerId: deps.runnerId,
        now: now(),
      });
      if (!created) return { created: false, message: toClientMessage(sameSubmission(message, input)) };
      schedule(message.id);
      return { created: true, message: toClientMessage(message) };
    },

    /** Re-runs a failed message in place (same id, same question). */
    async retry(messageId: string): Promise<ClientChatMessage> {
      await recoverStale();
      const message = await deps.store.getMessage(messageId);
      if (!message) throw new ChatRequestError(404, 'not-found', 'Message not found.');
      if (message.status !== 'failed') {
        // Completed answers are never re-run; a pending one is already running.
        if (message.status === 'pending') return toClientMessage(message);
        throw new ChatRequestError(409, 'not-retryable', 'Only a failed question can be retried.');
      }
      const siblings = await deps.store.listMessages(message.conversationId);
      if (siblings.some((sibling) => sibling.status === 'pending')) {
        throw new ChatRequestError(409, 'busy', 'A question in this conversation is still running.');
      }
      if (!deps.acquireSlot()) {
        throw new ChatRequestError(429, 'rate-limited', 'Too many chat messages. Wait a minute and try again.');
      }
      const retried = await apply(message, { type: 'retry', runnerId: deps.runnerId, at: now() });
      if (!retried) {
        const current = await deps.store.getMessage(messageId);
        if (!current) throw new ChatRequestError(404, 'not-found', 'Message not found.');
        return toClientMessage(current);
      }
      schedule(retried.id);
      return toClientMessage(retried);
    },

    /** One conversation with all its messages (stale pending ones recovered first). */
    async getConversation(conversationId: string): Promise<ConversationView | null> {
      const conversation = await deps.store.getConversation(conversationId);
      if (!conversation) return null;
      const pending = (await deps.store.listMessages(conversationId)).filter((m) => m.status === 'pending');
      if (pending.length > 0) await recoverStale(pending);
      const messages = await deps.store.listMessages(conversationId);
      const current = (await deps.store.getConversation(conversationId)) ?? conversation;
      return {
        conversation: {
          id: current.id,
          title: current.title,
          createdAt: current.createdAt.toISOString(),
          updatedAt: current.updatedAt.toISOString(),
        },
        messages: messages.map(toClientMessage),
      };
    },

    /** Recent conversations, most recently updated first. */
    async listConversations(limit: number = MAX_LISTED_CONVERSATIONS): Promise<ConversationListItem[]> {
      await recoverStale();
      const conversations = await deps.store.listConversations(limit);
      return conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
        pending: conversation.pending,
      }));
    },

    recoverStale: () => recoverStale(),
    /** Resolves when every queued run has finished (tests). */
    idle: () => queue.then(() => undefined),
  };
}

export type ChatService = ReturnType<typeof createChatService>;

/** A replayed idempotency key must describe the same question. */
function sameSubmission(message: StoredChatMessage, input: SubmitInput): StoredChatMessage {
  const sameConversation = !input.conversationId || input.conversationId === message.conversationId;
  if (message.question !== input.message || !sameConversation) {
    throw new ChatRequestError(409, 'idempotency-conflict', 'This idempotency key was already used for a different question.');
  }
  return message;
}

async function loadReadonlyContext(
  userId: string | null,
  executeQuery: (query: ScopedQuery) => Promise<Record<string, unknown>[]>,
): Promise<ChatContext> {
  const [categories, range] = await Promise.all([
    executeQuery(
      buildScopedQuery(`SELECT name, type::text AS type, "group"::text AS "group" FROM "Category" ORDER BY id`, {
        userId,
        rowCap: 500,
      }),
    ),
    executeQuery(buildScopedQuery(`SELECT MIN(date) AS min, MAX(date) AS max FROM "Transaction"`, { userId })),
  ]);
  const min = range[0]?.min;
  const max = range[0]?.max;
  return {
    todayIso: localCalendarDay(new Date()),
    categories: categories.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      group: String(row.group),
    })),
    txnDateRange:
      min instanceof Date && max instanceof Date
        ? { min: localCalendarDay(min), max: localCalendarDay(max) }
        : null,
    memberFiltered: userId !== null,
  };
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Shared across route bundles and hot reloads: one queue, one limiter and one
// runner id per server process.
const globalForChat = globalThis as unknown as {
  financeChatService?: ChatService;
  financeChatLimiter?: ChatRateLimiter;
};

/** The process-wide chat service on the real CLI, read-only DB and Prisma store. */
export async function chatService(): Promise<ChatService> {
  if (globalForChat.financeChatService) return globalForChat.financeChatService;
  const { prisma } = await import('../db');
  const provider = chatCliProvider();
  const timeoutMs = positiveIntegerFromEnv('CHAT_TIMEOUT_MS', DEFAULT_CHAT_TIMEOUT_MS);
  const limiter = (globalForChat.financeChatLimiter ??= new ChatRateLimiter(
    positiveIntegerFromEnv('CHAT_RATE_LIMIT_PER_MINUTE', 6),
  ));
  const service = createChatService({
    store: prismaChatStore(prisma),
    invokeModel: (prompt) => runChatModel(provider, prompt, { timeoutMs }),
    executeQuery: executeReadonlyQuery,
    acquireSlot: () => limiter.tryAcquire(),
    runnerId: randomUUID(),
    maxRounds: Math.min(positiveIntegerFromEnv('CHAT_MAX_ROUNDS', DEFAULT_CHAT_MAX_ROUNDS), MAX_CHAT_MAX_ROUNDS),
    timeoutMs,
  });
  globalForChat.financeChatService ??= service;
  // Server (re)start: pending rows from the previous process can never finish.
  void globalForChat.financeChatService.recoverStale().catch((error) => console.error('[chat] recovery failed:', error));
  return globalForChat.financeChatService;
}

export { ChatInvocationError };
