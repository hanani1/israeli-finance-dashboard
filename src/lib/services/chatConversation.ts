/**
 * Pure state machine and helpers for persisted chat messages (card #66,
 * ADR-0027). One message = one user question and (eventually) its answer:
 *
 *   pending ──complete──▶ completed        (terminal: never run again)
 *      │
 *      ├──fail / recover──▶ failed ──retry──▶ pending
 *
 * - `complete` / `fail` are only accepted from `pending` AND only from the
 *   runner (process instance) that owns the run, so a late result from a run
 *   that was already recovered cannot overwrite newer state.
 * - `recover` turns a pending message whose runner is gone (server restart)
 *   or that blew its deadline into `failed` with a recoverable error code.
 * - `retry` is the only way back to `pending`, and only from `failed`.
 *
 * Side-effect free so it can be unit tested; persistence lives in
 * chatStore.ts and orchestration in chatService.ts.
 */
import { capHistory, MAX_CHAT_MESSAGE_LENGTH, type ChatTurn } from './chatSession';

export type ChatMessageStatus = 'pending' | 'completed' | 'failed';

export interface ToolCallRecord {
  tool: string;
  detail: string;
  rows?: number;
  truncated?: boolean;
  error?: string;
}

/** The fields of a persisted ChatMessage the state machine cares about. */
export interface ChatMessageState {
  status: ChatMessageStatus;
  answer: string | null;
  toolCalls: ToolCallRecord[] | null;
  errorCode: string | null;
  runnerId: string | null;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export type ChatMessageEvent =
  | { type: 'start'; runnerId: string; at: Date }
  | { type: 'complete'; runnerId: string; answer: string; toolCalls: ToolCallRecord[]; at: Date }
  | { type: 'fail'; runnerId: string; errorCode: string; at: Date }
  | { type: 'recover'; errorCode: StaleReason; at: Date }
  | { type: 'retry'; runnerId: string; at: Date };

export type TransitionResult =
  | { ok: true; state: ChatMessageState }
  | { ok: false; reason: string };

/** Error code a recovered (interrupted / overdue) pending message ends with. */
export type StaleReason = 'interrupted' | 'timeout';

/** Applies one event; illegal transitions are refused, never coerced. */
export function transition(state: ChatMessageState, event: ChatMessageEvent): TransitionResult {
  switch (event.type) {
    case 'start':
      if (state.status !== 'pending') return { ok: false, reason: `cannot start a ${state.status} message` };
      if (state.runnerId !== event.runnerId) return { ok: false, reason: 'message is owned by another runner' };
      return { ok: true, state: { ...state, startedAt: event.at } };
    case 'complete':
      if (state.status !== 'pending') return { ok: false, reason: `cannot complete a ${state.status} message` };
      if (state.runnerId !== event.runnerId) return { ok: false, reason: 'message is owned by another runner' };
      return {
        ok: true,
        state: {
          ...state,
          status: 'completed',
          answer: event.answer,
          toolCalls: event.toolCalls,
          errorCode: null,
          completedAt: event.at,
        },
      };
    case 'fail':
      if (state.status !== 'pending') return { ok: false, reason: `cannot fail a ${state.status} message` };
      if (state.runnerId !== event.runnerId) return { ok: false, reason: 'message is owned by another runner' };
      return { ok: true, state: { ...state, status: 'failed', errorCode: event.errorCode, completedAt: event.at } };
    case 'recover':
      if (state.status !== 'pending') return { ok: false, reason: `cannot recover a ${state.status} message` };
      return {
        ok: true,
        state: { ...state, status: 'failed', errorCode: event.errorCode, runnerId: null, completedAt: event.at },
      };
    case 'retry':
      if (state.status !== 'failed') return { ok: false, reason: `cannot retry a ${state.status} message` };
      return {
        ok: true,
        state: {
          ...state,
          status: 'pending',
          answer: null,
          toolCalls: null,
          errorCode: null,
          runnerId: event.runnerId,
          attempts: state.attempts + 1,
          startedAt: null,
          completedAt: null,
        },
      };
  }
}

export interface StalenessOptions {
  now: Date;
  /** This process instance's runner id. */
  runnerId: string;
  /** Max time a started run may take: rounds × CLI timeout + slack. */
  runDeadlineMs: number;
  /** Max time a message may wait in the serialized queue before starting. */
  queueDeadlineMs: number;
}

/**
 * Why a pending message can no longer complete, or null if it still can.
 * - `interrupted`: owned by another runner — the process that accepted it is
 *   gone (restart/crash), and in-process runs do not survive a restart.
 * - `timeout`: ours, but past its deadline (belt and braces: the CLI and DB
 *   timeouts should already have ended the run).
 */
export function staleReason(state: ChatMessageState, options: StalenessOptions): StaleReason | null {
  if (state.status !== 'pending') return null;
  if (state.runnerId !== options.runnerId) return 'interrupted';
  const now = options.now.getTime();
  if (state.startedAt) {
    return now - state.startedAt.getTime() > options.runDeadlineMs ? 'timeout' : null;
  }
  return now - state.createdAt.getTime() > options.queueDeadlineMs ? 'timeout' : null;
}

/** Sidebar title: the first question, whitespace collapsed, truncated. */
export const MAX_CONVERSATION_TITLE_LENGTH = 60;

export function conversationTitle(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= MAX_CONVERSATION_TITLE_LENGTH) return flat;
  return `${chars.slice(0, MAX_CONVERSATION_TITLE_LENGTH - 1).join('').trimEnd()}…`;
}

/** Each replayed answer is truncated to this length (as the in-memory store did). */
export const MAX_REPLAYED_ANSWER_CHARS = 2_000;

/**
 * History replayed to the model for a question: the COMPLETED turns before it
 * in the same conversation, oldest first, then capped (MAX_HISTORY_TURNS /
 * MAX_HISTORY_CHARS). Failed and pending turns are not replayed.
 */
export function historyFor(
  messages: ReadonlyArray<{ id: string; status: ChatMessageStatus; question: string; answer: string | null; createdAt: Date }>,
  beforeMessageId: string,
): ChatTurn[] {
  const ordered = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const turns: ChatTurn[] = [];
  for (const message of ordered) {
    if (message.id === beforeMessageId) break;
    if (message.status !== 'completed' || message.answer === null) continue;
    turns.push({
      question: message.question.slice(0, MAX_CHAT_MESSAGE_LENGTH),
      answer: message.answer.slice(0, MAX_REPLAYED_ANSWER_CHARS),
    });
  }
  return capHistory(turns);
}

/** Client idempotency keys: opaque, URL-safe, long enough to be unguessable. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value);
}

/** Server-generated ids (uuid) accepted from the client in paths/bodies. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidChatId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** What the browser sees of a message: no runner ids, no member ids, no stderr. */
export interface ClientChatMessage {
  id: string;
  conversationId: string;
  question: string;
  status: ChatMessageStatus;
  answer: string | null;
  toolCalls: ToolCallRecord[];
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toClientMessage(message: {
  id: string;
  conversationId: string;
  question: string;
  status: ChatMessageStatus;
  answer: string | null;
  toolCalls: unknown;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ClientChatMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    question: message.question,
    status: message.status,
    answer: message.status === 'completed' ? message.answer : null,
    toolCalls: message.status === 'completed' ? parseToolCalls(message.toolCalls) : [],
    errorCode: message.status === 'failed' ? (message.errorCode ?? 'unknown') : null,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

/** Defensive read of the JSON column: keep only the known summary fields. */
export function parseToolCalls(value: unknown): ToolCallRecord[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCallRecord[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { tool, detail, rows, truncated, error } = item as Record<string, unknown>;
    if (typeof tool !== 'string' || typeof detail !== 'string') continue;
    calls.push({
      tool,
      detail,
      ...(typeof rows === 'number' ? { rows } : {}),
      ...(typeof truncated === 'boolean' ? { truncated } : {}),
      ...(typeof error === 'string' ? { error } : {}),
    });
  }
  return calls;
}
