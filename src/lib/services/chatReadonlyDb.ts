/**
 * Read-only database access for the chat (ADR-0026). Every query the chat
 * runs — typed tools and validated `query` SQL alike — goes through a
 * separate Prisma client connected as the SELECT-only `finance_chat_ro` role
 * (CHAT_DB_URL), inside a READ ONLY transaction with a 5 s statement timeout.
 * The app's read-write DATABASE_URL is never used here.
 */
import { PrismaClient } from '@prisma/client';
import { ChatInvocationError } from './chatSession';
import type { ScopedQuery } from './chatSqlValidator';

export const CHAT_STATEMENT_TIMEOUT = '5s';

const globalForChatDb = globalThis as unknown as {
  financeChatReadonly?: { url: string; client: PrismaClient; verified: boolean };
};

function chatDbUrl(): string {
  const url = process.env.CHAT_DB_URL?.trim();
  if (!url) {
    throw new ChatInvocationError(
      'config',
      'CHAT_DB_URL is not set. Point it at the finance_chat_ro role (see scripts/setup-chat-readonly-role.sql).',
    );
  }
  if (url === process.env.DATABASE_URL?.trim()) {
    throw new ChatInvocationError('config', 'CHAT_DB_URL must not be the read-write DATABASE_URL.');
  }
  return url;
}

function readonlyState(): { client: PrismaClient; verified: boolean; url: string } {
  const url = chatDbUrl();
  const cached = globalForChatDb.financeChatReadonly;
  if (cached && cached.url === url) return cached;
  void cached?.client.$disconnect();
  const state = {
    url,
    verified: false,
    client: new PrismaClient({ datasourceUrl: url, log: ['error'] }),
  };
  globalForChatDb.financeChatReadonly = state;
  return state;
}

function isConnectionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { errorCode?: unknown; code?: unknown }).errorCode ?? (error as { code?: unknown }).code;
  return (
    name === 'PrismaClientInitializationError' ||
    name === 'PrismaClientRustPanicError' ||
    (typeof code === 'string' && /^P10\d\d$/.test(code))
  );
}

/**
 * Refuses to run when CHAT_DB_URL turns out to be a privileged login: the
 * role must not be a superuser or bypass RLS, must not read BankCredential,
 * account numbers or the persisted chat history (ADR-0027), and must not be
 * able to INSERT.
 */
async function verifyRole(client: PrismaClient): Promise<void> {
  const rows = await client.$queryRawUnsafe<
    Array<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      credentials: boolean;
      account_numbers: boolean;
      can_insert: boolean;
      chat_history: boolean | null;
    }>
  >(
    `SELECT r.rolsuper, r.rolbypassrls,
       has_table_privilege(current_user, 'public."BankCredential"', 'SELECT') AS credentials,
       has_column_privilege(current_user, 'public."Account"', 'accountNumber', 'SELECT') AS account_numbers,
       has_table_privilege(current_user, 'public."Transaction"', 'INSERT,UPDATE,DELETE') AS can_insert,
       (has_table_privilege(current_user, to_regclass('public."ChatMessage"'), 'SELECT')
         OR has_table_privilege(current_user, to_regclass('public."ChatConversation"'), 'SELECT')) AS chat_history
     FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const role = rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || role.credentials || role.account_numbers || role.can_insert || role.chat_history) {
    throw new ChatInvocationError(
      'config',
      'CHAT_DB_URL role is over-privileged (superuser, write access, or BankCredential/account-number/chat-history access). Run scripts/setup-chat-readonly-role.sql and use finance_chat_ro.',
    );
  }
}

/** Runs one scoped query in a READ ONLY transaction with a statement timeout. */
export async function executeReadonlyQuery(query: ScopedQuery): Promise<Record<string, unknown>[]> {
  const state = readonlyState();
  try {
    if (!state.verified) {
      await verifyRole(state.client);
      state.verified = true;
    }
    return await state.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${CHAT_STATEMENT_TIMEOUT}'`);
        return tx.$queryRawUnsafe<Record<string, unknown>[]>(query.text, ...query.params);
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
  } catch (error) {
    if (error instanceof ChatInvocationError) throw error;
    if (isConnectionError(error)) {
      throw new ChatInvocationError('db-unavailable', `Read-only chat database unavailable: ${(error as Error).message}`);
    }
    throw error;
  }
}
