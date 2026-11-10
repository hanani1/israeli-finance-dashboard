/**
 * Background chat runs end to end with a FAKE `hermes` executable (real
 * spawn through runChatModel) and the in-memory ChatStore: submit returns at
 * once, the run continues with no client attached, a later poll sees the
 * answer, duplicate submits never run twice, failures are retryable, and a
 * restart recovers stale pending rows (card #66, ADR-0027).
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { runChatModel } from './chatCli';
import type { ChatContext } from './chatProtocol';
import { ChatRequestError, createChatService, type ChatServiceDeps } from './chatService';
import { MemoryChatStore } from './chatStore';

const FAKE_HERMES = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const prompt = fs.readFileSync(argv[argv.indexOf('--query-file') + 1], 'utf8');
const question = (/CURRENT QUESTION: (.*)/.exec(prompt) || [])[1] || '';
fs.appendFileSync(path.join(__dirname, 'calls.log'), question + '\n');
const history = prompt.split('\n').filter((line) => line.startsWith('User: ')).length;
const nonce = (/BEGIN_FINANCE_CHAT_([A-Za-z0-9]+)/.exec(prompt) || [])[1];
const delay = /slow/.test(question) ? 400 : 20;
setTimeout(() => {
  if (/explode/.test(question)) { process.stderr.write('model provider error\n'); process.exit(3); }
  const text = 'answer to "' + question + '" with history=' + history;
  process.stdout.write('BEGIN_FINANCE_CHAT_' + nonce + '\n' + JSON.stringify({ type: 'answer', text }) + '\nEND_FINANCE_CHAT_' + nonce + '\n');
}, delay);
`;

let dir = '';
let cliPath = '';
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fd-chat-service-'));
  cliPath = path.join(dir, 'hermes');
  await writeFile(cliPath, FAKE_HERMES, 'utf8');
  await chmod(cliPath, 0o755);
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CONTEXT: ChatContext = { todayIso: '2026-11-03', categories: [], txnDateRange: null, memberFiltered: false };

function service(overrides: Partial<ChatServiceDeps> & { store: MemoryChatStore }) {
  return createChatService({
    invokeModel: (prompt) =>
      runChatModel('hermes', prompt, { timeoutMs: 5_000, environment: { PATH: process.env.PATH, CHAT_CLI_PATH: cliPath } }),
    executeQuery: async () => [],
    loadContext: async () => CONTEXT,
    acquireSlot: () => true,
    runnerId: 'runner-1',
    maxRounds: 2,
    timeoutMs: 5_000,
    log: () => undefined,
    ...overrides,
  });
}

const key = (label: string) => `test-key-${label}-0123456789`;

async function calls(): Promise<string[]> {
  return (await readFile(path.join(dir, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
}

test('submit returns a pending message at once; the answer lands later without any client attached', async () => {
  const store = new MemoryChatStore();
  const chat = service({ store });
  const started = Date.now();
  const { created, message } = await chat.submit({
    message: 'slow question one',
    idempotencyKey: key('one'),
    userId: null,
  });
  assert.equal(created, true);
  assert.equal(message.status, 'pending');
  assert.ok(Date.now() - started < 300, 'submit does not wait for the model');

  // "Leave the page": nobody awaits anything. Poll later.
  const early = await chat.getConversation(message.conversationId);
  assert.equal(early?.messages[0]?.status, 'pending');
  await chat.idle();
  const later = await chat.getConversation(message.conversationId);
  assert.equal(later?.messages[0]?.status, 'completed');
  assert.equal(later?.messages[0]?.answer, 'answer to "slow question one" with history=0');
  assert.equal(later?.conversation.title, 'slow question one');
});

test('a duplicate submit (refresh / double click) returns the same message and runs once', async () => {
  const store = new MemoryChatStore();
  const chat = service({ store });
  const before = (await calls()).filter((q) => q === 'slow dup question').length;
  const first = await chat.submit({ message: 'slow dup question', idempotencyKey: key('dup'), userId: null });
  const second = await chat.submit({ message: 'slow dup question', idempotencyKey: key('dup'), userId: null });
  assert.equal(second.created, false);
  assert.equal(second.message.id, first.message.id);
  await chat.idle();
  const third = await chat.submit({ message: 'slow dup question', idempotencyKey: key('dup'), userId: null });
  assert.equal(third.message.status, 'completed', 'revisit after completion sees the answer');
  assert.equal((await calls()).filter((q) => q === 'slow dup question').length - before, 1, 'model ran exactly once');
  assert.equal(store.messages.size, 1);

  await assert.rejects(
    chat.submit({ message: 'a different question', idempotencyKey: key('dup'), userId: null }),
    (error: unknown) => error instanceof ChatRequestError && error.code === 'idempotency-conflict',
  );
});

test('follow-ups replay the persisted history and a busy conversation refuses a second question', async () => {
  const store = new MemoryChatStore();
  const chat = service({ store });
  const first = await chat.submit({ message: 'slow first', idempotencyKey: key('f1'), userId: null });
  const conversationId = first.message.conversationId;
  await assert.rejects(
    chat.submit({ message: 'too early', conversationId, idempotencyKey: key('f2'), userId: null }),
    (error: unknown) => error instanceof ChatRequestError && error.code === 'busy',
  );
  await chat.idle();
  await chat.submit({ message: 'second', conversationId, idempotencyKey: key('f3'), userId: null });
  await chat.idle();
  const view = await chat.getConversation(conversationId);
  assert.deepEqual(
    view?.messages.map((message) => message.answer),
    ['answer to "slow first" with history=0', 'answer to "second" with history=1'],
  );

  await assert.rejects(
    chat.submit({ message: 'x', conversationId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', idempotencyKey: key('f4'), userId: null }),
    (error: unknown) => error instanceof ChatRequestError && error.code === 'not-found',
  );
});

test('a model failure ends as failed with a curated code, and retry re-runs it in place', async () => {
  const store = new MemoryChatStore();
  let explode = true;
  const chat = service({
    store,
    invokeModel: (prompt) =>
      runChatModel('hermes', explode ? prompt : prompt.replace('explode', 'fixed'), {
        timeoutMs: 5_000,
        environment: { PATH: process.env.PATH, CHAT_CLI_PATH: cliPath },
      }),
  });
  const { message } = await chat.submit({ message: 'please explode', idempotencyKey: key('boom'), userId: null });
  await chat.idle();
  const failed = (await chat.getConversation(message.conversationId))?.messages[0];
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.errorCode, 'cli-error');
  assert.equal(failed?.answer, null);

  explode = false;
  const retried = await chat.retry(message.id);
  assert.equal(retried.status, 'pending');
  assert.equal(retried.id, message.id);
  await chat.idle();
  const done = (await chat.getConversation(message.conversationId))?.messages[0];
  assert.equal(done?.status, 'completed');
  assert.match(done?.answer ?? '', /please fixed/);
  await assert.rejects(
    chat.retry(message.id),
    (error: unknown) => error instanceof ChatRequestError && error.code === 'not-retryable',
  );
});

test('a CLI timeout fails the message instead of leaving it loading', async () => {
  const store = new MemoryChatStore();
  const chat = service({
    store,
    invokeModel: (prompt) =>
      runChatModel('hermes', prompt, { timeoutMs: 100, environment: { PATH: process.env.PATH, CHAT_CLI_PATH: cliPath } }),
  });
  const { message } = await chat.submit({ message: 'slow timeout', idempotencyKey: key('to'), userId: null });
  await chat.idle();
  const failed = (await chat.getConversation(message.conversationId))?.messages[0];
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.errorCode, 'timeout');
});

test('after a restart, pending rows of the old process are recovered as interrupted and are retryable', async () => {
  const store = new MemoryChatStore();
  const neverAnswers = service({ store, invokeModel: () => new Promise<string>(() => undefined) });
  const { message } = await neverAnswers.submit({ message: 'in flight', idempotencyKey: key('crash'), userId: null });
  assert.equal(message.status, 'pending');

  // New process instance (different runner id) on the same store.
  const restarted = service({ store, runnerId: 'runner-2' });
  const listed = await restarted.listConversations();
  assert.equal(listed[0]?.pending, false);
  const recovered = (await restarted.getConversation(message.conversationId))?.messages[0];
  assert.equal(recovered?.status, 'failed');
  assert.equal(recovered?.errorCode, 'interrupted');

  // The same idempotency key still does not run it a second time…
  const replay = await restarted.submit({ message: 'in flight', idempotencyKey: key('crash'), userId: null });
  assert.equal(replay.created, false);
  assert.equal(replay.message.status, 'failed');
  // …only an explicit retry does.
  await restarted.retry(message.id);
  await restarted.idle();
  assert.equal((await restarted.getConversation(message.conversationId))?.messages[0]?.status, 'completed');
});

test('the rate limit refuses new runs but not idempotent replays', async () => {
  const store = new MemoryChatStore();
  let slots = 1;
  const chat = service({ store, acquireSlot: () => slots-- > 0 });
  const first = await chat.submit({ message: 'one', idempotencyKey: key('rl1'), userId: null });
  await assert.rejects(
    chat.submit({ message: 'two', idempotencyKey: key('rl2'), userId: null }),
    (error: unknown) => error instanceof ChatRequestError && error.code === 'rate-limited',
  );
  const replay = await chat.submit({ message: 'one', idempotencyKey: key('rl1'), userId: null });
  assert.equal(replay.message.id, first.message.id);
  await chat.idle();
});

test('conversations list most recently updated first', async () => {
  const store = new MemoryChatStore();
  let clock = Date.parse('2026-11-03T10:00:00Z');
  const chat = service({ store, now: () => new Date((clock += 1_000)) });
  const a = await chat.submit({ message: 'first chat', idempotencyKey: key('la'), userId: null });
  await chat.idle();
  await chat.submit({ message: 'second chat', idempotencyKey: key('lb'), userId: null });
  await chat.idle();
  assert.deepEqual((await chat.listConversations()).map((c) => c.title), ['second chat', 'first chat']);
  await chat.submit({ message: 'follow up', conversationId: a.message.conversationId, idempotencyKey: key('lc'), userId: null });
  await chat.idle();
  const titles = (await chat.listConversations()).map((c) => c.title);
  assert.deepEqual(titles, ['first chat', 'second chat'], 'activity moves a conversation up; title stays the first question');
});
