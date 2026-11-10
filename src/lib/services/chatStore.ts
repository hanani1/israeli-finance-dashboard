/**
 * Persistence for the dashboard chat (card #66, ADR-0027).
 *
 * `ChatStore` is the narrow interface chatService needs; `prismaChatStore`
 * implements it on the app's read-write client (DATABASE_URL), and tests use
 * `MemoryChatStore`. Status changes are compare-and-set on (status, runnerId)
 * so a late result from a recovered run can never overwrite newer state.
 *
 * The chat's read-only role (CHAT_DB_URL) has NO access to these tables, and
 * chatSqlValidator does not allowlist them: chat history is replayed by the
 * server, never queried by the model.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ChatMessageState, ChatMessageStatus, ToolCallRecord } from './chatConversation';

export interface StoredChatMessage extends ChatMessageState {
  id: string;
  conversationId: string;
  idempotencyKey: string;
  question: string;
  userId: string | null;
  updatedAt: Date;
}

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationSummary extends StoredConversation {
  /** True while a question in it is still running. */
  pending: boolean;
}

export interface NewChatMessage {
  /** Existing conversation, or undefined to start a new one titled `title`. */
  conversationId?: string;
  title: string;
  idempotencyKey: string;
  question: string;
  userId: string | null;
  runnerId: string;
  now: Date;
}

/** Fields a compare-and-set update may write (the next state from chatConversation.transition). */
export type ChatMessagePatch = Partial<
  Pick<StoredChatMessage, 'status' | 'answer' | 'toolCalls' | 'errorCode' | 'runnerId' | 'attempts' | 'startedAt' | 'completedAt'>
>;

export interface ChatStore {
  findMessageByIdempotencyKey(key: string): Promise<StoredChatMessage | null>;
  getMessage(id: string): Promise<StoredChatMessage | null>;
  getConversation(id: string): Promise<StoredConversation | null>;
  /** Messages of one conversation, oldest first. */
  listMessages(conversationId: string): Promise<StoredChatMessage[]>;
  listPendingMessages(): Promise<StoredChatMessage[]>;
  /** Most recently updated first. */
  listConversations(limit: number): Promise<ConversationSummary[]>;
  /**
   * Inserts a pending message (and its conversation when new). When the
   * idempotency key already exists — including a concurrent insert that won
   * the race — returns the existing row with created=false.
   */
  createMessage(input: NewChatMessage): Promise<{ created: boolean; message: StoredChatMessage }>;
  /**
   * Writes `patch` only if the row is still in `expected` (status + runnerId)
   * and bumps the conversation's updatedAt. Returns whether it applied.
   */
  updateMessage(
    id: string,
    expected: { status: ChatMessageStatus; runnerId: string | null },
    patch: ChatMessagePatch,
    now: Date,
  ): Promise<boolean>;
}

type MessageRow = Prisma.ChatMessageGetPayload<object>;

function fromRow(row: MessageRow): StoredChatMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    idempotencyKey: row.idempotencyKey,
    question: row.question,
    userId: row.userId,
    status: row.status,
    answer: row.answer,
    toolCalls: Array.isArray(row.toolCalls) ? (row.toolCalls as unknown as ToolCallRecord[]) : null,
    errorCode: row.errorCode,
    runnerId: row.runnerId,
    attempts: row.attempts,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function prismaChatStore(prisma: PrismaClient): ChatStore {
  return {
    async findMessageByIdempotencyKey(key) {
      const row = await prisma.chatMessage.findUnique({ where: { idempotencyKey: key } });
      return row ? fromRow(row) : null;
    },
    async getMessage(id) {
      const row = await prisma.chatMessage.findUnique({ where: { id } });
      return row ? fromRow(row) : null;
    },
    async getConversation(id) {
      return prisma.chatConversation.findUnique({
        where: { id },
        select: { id: true, title: true, createdAt: true, updatedAt: true },
      });
    },
    async listMessages(conversationId) {
      const rows = await prisma.chatMessage.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map(fromRow);
    },
    async listPendingMessages() {
      const rows = await prisma.chatMessage.findMany({ where: { status: 'pending' } });
      return rows.map(fromRow);
    },
    async listConversations(limit) {
      const rows = await prisma.chatConversation.findMany({
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: limit,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          messages: { where: { status: 'pending' }, select: { id: true }, take: 1 },
        },
      });
      return rows.map(({ messages, ...conversation }) => ({ ...conversation, pending: messages.length > 0 }));
    },
    async createMessage(input) {
      try {
        const row = await prisma.$transaction(async (tx) => {
          let conversationId = input.conversationId;
          if (conversationId) {
            await tx.chatConversation.update({ where: { id: conversationId }, data: { updatedAt: input.now } });
          } else {
            conversationId = (
              await tx.chatConversation.create({
                data: { id: randomUUID(), title: input.title, createdAt: input.now, updatedAt: input.now },
              })
            ).id;
          }
          return tx.chatMessage.create({
            data: {
              conversationId,
              idempotencyKey: input.idempotencyKey,
              question: input.question,
              userId: input.userId,
              status: 'pending',
              runnerId: input.runnerId,
              createdAt: input.now,
              updatedAt: input.now,
            },
          });
        });
        return { created: true, message: fromRow(row) };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = await prisma.chatMessage.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (!existing) throw error;
        return { created: false, message: fromRow(existing) };
      }
    },
    async updateMessage(id, expected, patch, now) {
      const { toolCalls, ...rest } = patch;
      return prisma.$transaction(async (tx) => {
        const result = await tx.chatMessage.updateMany({
          where: { id, status: expected.status, runnerId: expected.runnerId },
          data: {
            ...rest,
            ...(toolCalls !== undefined
              ? { toolCalls: toolCalls === null ? Prisma.DbNull : (toolCalls as unknown as Prisma.InputJsonValue) }
              : {}),
            updatedAt: now,
          },
        });
        if (result.count !== 1) return false;
        const message = await tx.chatMessage.findUnique({ where: { id }, select: { conversationId: true } });
        if (message) {
          await tx.chatConversation.update({ where: { id: message.conversationId }, data: { updatedAt: now } });
        }
        return true;
      });
    },
  };
}

/** In-memory ChatStore with the same semantics, for tests. */
export class MemoryChatStore implements ChatStore {
  readonly conversations = new Map<string, StoredConversation>();
  readonly messages = new Map<string, StoredChatMessage>();

  async findMessageByIdempotencyKey(key: string) {
    for (const message of this.messages.values()) if (message.idempotencyKey === key) return { ...message };
    return null;
  }
  async getMessage(id: string) {
    const message = this.messages.get(id);
    return message ? { ...message } : null;
  }
  async getConversation(id: string) {
    const conversation = this.conversations.get(id);
    return conversation ? { ...conversation } : null;
  }
  async listMessages(conversationId: string) {
    return [...this.messages.values()]
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((message) => ({ ...message }));
  }
  async listPendingMessages() {
    return [...this.messages.values()].filter((message) => message.status === 'pending').map((m) => ({ ...m }));
  }
  async listConversations(limit: number) {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((conversation) => ({
        ...conversation,
        pending: [...this.messages.values()].some(
          (message) => message.conversationId === conversation.id && message.status === 'pending',
        ),
      }));
  }
  async createMessage(input: NewChatMessage) {
    const existing = await this.findMessageByIdempotencyKey(input.idempotencyKey);
    if (existing) return { created: false, message: existing };
    let conversationId = input.conversationId;
    if (conversationId) {
      const conversation = this.conversations.get(conversationId);
      if (!conversation) throw new Error('conversation not found');
      conversation.updatedAt = input.now;
    } else {
      conversationId = randomUUID();
      this.conversations.set(conversationId, {
        id: conversationId,
        title: input.title,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
    const message: StoredChatMessage = {
      id: randomUUID(),
      conversationId,
      idempotencyKey: input.idempotencyKey,
      question: input.question,
      userId: input.userId,
      status: 'pending',
      answer: null,
      toolCalls: null,
      errorCode: null,
      runnerId: input.runnerId,
      attempts: 1,
      startedAt: null,
      completedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.messages.set(message.id, message);
    return { created: true, message: { ...message } };
  }
  async updateMessage(
    id: string,
    expected: { status: ChatMessageStatus; runnerId: string | null },
    patch: ChatMessagePatch,
    now: Date,
  ) {
    const message = this.messages.get(id);
    if (!message || message.status !== expected.status || message.runnerId !== expected.runnerId) return false;
    Object.assign(message, patch, { updatedAt: now });
    const conversation = this.conversations.get(message.conversationId);
    if (conversation) conversation.updatedAt = now;
    return true;
  }
}
