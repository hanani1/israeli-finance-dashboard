/**
 * Optional database-backed test for the persisted chat (card #66): the
 * Prisma ChatStore's idempotency under a concurrent double submit, the
 * compare-and-set status writes, and that the chat's read-only role can NOT
 * read the chat tables. Runs only against SCRATCH databases (name fd_*):
 *   CHAT_TEST_ADMIN_URL=postgresql://<owner>@127.0.0.1:5432/fd_xx
 *   CHAT_TEST_RO_URL=postgresql://<scratch_ro_role>:<pw>@127.0.0.1:5432/fd_xx
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { prismaChatStore } from './chatStore';

const adminUrl = process.env.CHAT_TEST_ADMIN_URL;
const roUrl = process.env.CHAT_TEST_RO_URL;
const scratch = (url: string | undefined) => !!url && /\/fd_[A-Za-z0-9_]+(\?|$)/.test(url);
const skip = !(scratch(adminUrl) && scratch(roUrl)) && 'set CHAT_TEST_ADMIN_URL / CHAT_TEST_RO_URL to fd_* scratch DBs';

test('prisma ChatStore: concurrent duplicate submit creates one row; CAS writes respect status and runner', { skip }, async () => {
  const prisma = new PrismaClient({ datasourceUrl: adminUrl });
  const store = prismaChatStore(prisma);
  const key = `db-test-${Date.now()}-0123456789`;
  try {
    const now = new Date();
    const input = { title: 'dup', idempotencyKey: key, question: 'dup', userId: null, runnerId: 'r1', now };
    const [a, b] = await Promise.all([store.createMessage(input), store.createMessage(input)]);
    assert.equal(a.message.id, b.message.id);
    assert.deepEqual([a.created, b.created].sort(), [false, true]);
    assert.equal(await prisma.chatMessage.count({ where: { idempotencyKey: key } }), 1);

    const id = a.message.id;
    assert.equal(
      await store.updateMessage(id, { status: 'pending', runnerId: 'other' }, { status: 'completed', answer: 'x' }, now),
      false,
      'wrong runner',
    );
    assert.equal(
      await store.updateMessage(
        id,
        { status: 'pending', runnerId: 'r1' },
        { status: 'completed', answer: 'ok', toolCalls: [{ tool: 'query', detail: 'SELECT 1', rows: 1 }] },
        new Date(now.getTime() + 1_000),
      ),
      true,
    );
    assert.equal(
      await store.updateMessage(id, { status: 'pending', runnerId: 'r1' }, { status: 'failed' }, now),
      false,
      'completed is terminal',
    );
    const stored = await store.getMessage(id);
    assert.equal(stored?.answer, 'ok');
    assert.deepEqual(stored?.toolCalls, [{ tool: 'query', detail: 'SELECT 1', rows: 1 }]);
    const conversation = await store.getConversation(a.message.conversationId);
    assert.equal(conversation?.updatedAt.getTime(), now.getTime() + 1_000, 'conversation activity bumped');
  } finally {
    await prisma.chatMessage.deleteMany({ where: { idempotencyKey: key } });
    await prisma.chatConversation.deleteMany({ where: { title: 'dup', messages: { none: {} } } });
    await prisma.$disconnect();
  }
});

test('the chat read-only role cannot read the chat history tables', { skip }, async () => {
  const ro = new PrismaClient({ datasourceUrl: roUrl });
  try {
    for (const table of ['ChatMessage', 'ChatConversation']) {
      await assert.rejects(ro.$queryRawUnsafe(`SELECT * FROM public."${table}" LIMIT 1`), /permission denied/i, table);
    }
    const rows = await ro.$queryRawUnsafe<Array<{ chat: boolean }>>(
      `SELECT has_table_privilege(current_user, to_regclass('public."ChatMessage"'), 'SELECT') AS chat`,
    );
    assert.equal(rows[0]?.chat, false);
  } finally {
    await ro.$disconnect();
  }
});
