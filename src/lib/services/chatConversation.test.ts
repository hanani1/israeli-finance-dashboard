import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CONVERSATION_TITLE_LENGTH,
  MAX_REPLAYED_ANSWER_CHARS,
  conversationTitle,
  historyFor,
  isValidChatId,
  isValidIdempotencyKey,
  parseToolCalls,
  staleReason,
  toClientMessage,
  transition,
  type ChatMessageEvent,
  type ChatMessageState,
} from './chatConversation';
import { MAX_HISTORY_TURNS } from './chatSession';

const T0 = new Date('2026-11-03T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function pending(overrides: Partial<ChatMessageState> = {}): ChatMessageState {
  return {
    status: 'pending',
    answer: null,
    toolCalls: null,
    errorCode: null,
    runnerId: 'runner-a',
    attempts: 1,
    startedAt: null,
    completedAt: null,
    createdAt: T0,
    ...overrides,
  };
}

function ok(result: ReturnType<typeof transition>): ChatMessageState {
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.ok ? result.state : pending();
}

test('pending → completed stores the answer and is terminal', () => {
  const started = ok(transition(pending(), { type: 'start', runnerId: 'runner-a', at: at(1) }));
  assert.equal(started.startedAt?.getTime(), at(1).getTime());
  const done = ok(
    transition(started, { type: 'complete', runnerId: 'runner-a', answer: '42', toolCalls: [], at: at(2) }),
  );
  assert.equal(done.status, 'completed');
  assert.equal(done.answer, '42');
  assert.equal(done.completedAt?.getTime(), at(2).getTime());

  // A completed question is never run again: no start, retry, fail or recover.
  const events: ChatMessageEvent[] = [
    { type: 'start', runnerId: 'runner-a', at: at(3) },
    { type: 'retry', runnerId: 'runner-a', at: at(3) },
    { type: 'fail', runnerId: 'runner-a', errorCode: 'timeout', at: at(3) },
    { type: 'recover', errorCode: 'interrupted', at: at(3) },
    { type: 'complete', runnerId: 'runner-a', answer: 'again', toolCalls: [], at: at(3) },
  ];
  for (const event of events) {
    assert.equal(transition(done, event).ok, false, event.type);
  }
});

test('pending → failed keeps a recoverable code; failed → retry → pending bumps attempts', () => {
  const failed = ok(transition(pending(), { type: 'fail', runnerId: 'runner-a', errorCode: 'timeout', at: at(1) }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'timeout');

  const retried = ok(transition(failed, { type: 'retry', runnerId: 'runner-b', at: at(2) }));
  assert.equal(retried.status, 'pending');
  assert.equal(retried.errorCode, null);
  assert.equal(retried.runnerId, 'runner-b');
  assert.equal(retried.attempts, 2);
  assert.equal(retried.startedAt, null);

  assert.equal(transition(retried, { type: 'retry', runnerId: 'runner-b', at: at(3) }).ok, false, 'pending is not retryable');
});

test('only the owning runner may start, complete or fail a pending message', () => {
  const message = pending({ runnerId: 'runner-a' });
  assert.equal(transition(message, { type: 'start', runnerId: 'runner-b', at: at(1) }).ok, false);
  assert.equal(
    transition(message, { type: 'complete', runnerId: 'runner-b', answer: 'x', toolCalls: [], at: at(1) }).ok,
    false,
  );
  assert.equal(transition(message, { type: 'fail', runnerId: 'runner-b', errorCode: 'x', at: at(1) }).ok, false);
});

test('a late result after recovery cannot overwrite the failed state', () => {
  const recovered = ok(transition(pending(), { type: 'recover', errorCode: 'interrupted', at: at(1) }));
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.runnerId, null);
  assert.equal(
    transition(recovered, { type: 'complete', runnerId: 'runner-a', answer: 'late', toolCalls: [], at: at(2) }).ok,
    false,
  );
});

test('staleReason: pending rows of another (dead) runner are interrupted', () => {
  const options = { now: at(1_000), runnerId: 'runner-new', runDeadlineMs: 60_000, queueDeadlineMs: 600_000 };
  assert.equal(staleReason(pending({ runnerId: 'runner-old' }), options), 'interrupted');
  assert.equal(staleReason(pending({ runnerId: null }), options), 'interrupted');
  assert.equal(staleReason(pending({ runnerId: 'runner-new' }), options), null, 'ours and fresh');
  assert.equal(staleReason({ ...pending(), status: 'completed' }, options), null);
  assert.equal(staleReason({ ...pending(), status: 'failed' }, options), null);
});

test('staleReason: our own pending rows time out after the run / queue deadlines', () => {
  const base = { runnerId: 'runner-a', runDeadlineMs: 60_000, queueDeadlineMs: 600_000 };
  const started = pending({ startedAt: at(0) });
  assert.equal(staleReason(started, { ...base, now: at(60_000) }), null);
  assert.equal(staleReason(started, { ...base, now: at(60_001) }), 'timeout');
  const queued = pending();
  assert.equal(staleReason(queued, { ...base, now: at(600_000) }), null);
  assert.equal(staleReason(queued, { ...base, now: at(600_001) }), 'timeout');
});

test('conversationTitle collapses whitespace and truncates long questions', () => {
  assert.equal(conversationTitle('  How much\n\non groceries?  '), 'How much on groceries?');
  const long = 'כמה הוצאתי '.repeat(20);
  const title = conversationTitle(long);
  assert.ok(Array.from(title).length <= MAX_CONVERSATION_TITLE_LENGTH);
  assert.ok(title.endsWith('…'));
});

test('historyFor replays only completed turns before the message, capped', () => {
  const messages = Array.from({ length: MAX_HISTORY_TURNS + 4 }, (_, index) => ({
    id: `m${index}`,
    status: index === 2 ? ('failed' as const) : ('completed' as const),
    question: `q${index}`,
    answer: index === 2 ? null : `a${index}`,
    createdAt: at(index * 1000),
  }));
  const last = messages.at(-1);
  assert.ok(last);
  const history = historyFor([...messages].reverse(), last.id);
  assert.equal(history.length, MAX_HISTORY_TURNS);
  assert.equal(history.at(-1)?.question, `q${messages.length - 2}`, 'stops before the current message');
  assert.ok(!history.some((turn) => turn.question === 'q2'), 'failed turns are not replayed');

  const big = historyFor(
    [
      { id: 'a', status: 'completed', question: 'q', answer: 'x'.repeat(5_000), createdAt: at(0) },
      { id: 'b', status: 'pending', question: 'now', answer: null, createdAt: at(1) },
    ],
    'b',
  );
  assert.equal(big[0]?.answer.length, MAX_REPLAYED_ANSWER_CHARS);
});

test('idempotency keys and ids are validated', () => {
  assert.ok(isValidIdempotencyKey('a1b2c3d4e5f6a7b8c9d0'));
  assert.ok(!isValidIdempotencyKey('short'));
  assert.ok(!isValidIdempotencyKey('has space in it 12345'));
  assert.ok(!isValidIdempotencyKey(42));
  assert.ok(isValidChatId('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'));
  assert.ok(!isValidChatId('../etc/passwd'));
});

test('toClientMessage exposes no runner/member ids and only finished fields', () => {
  const base = {
    id: 'm1',
    conversationId: 'c1',
    question: 'q',
    answer: 'secret-draft',
    toolCalls: [{ tool: 'query', detail: 'SELECT 1', rows: 1, extra: 'drop me' }],
    errorCode: null,
    createdAt: T0,
    updatedAt: T0,
    runnerId: 'runner-a',
    userId: 'user-1',
  };
  const shownPending = toClientMessage({ ...base, status: 'pending' });
  assert.equal(shownPending.answer, null);
  assert.deepEqual(shownPending.toolCalls, []);
  assert.ok(!('runnerId' in shownPending) && !('userId' in shownPending));

  const done = toClientMessage({ ...base, status: 'completed' });
  assert.equal(done.answer, 'secret-draft');
  assert.deepEqual(done.toolCalls, [{ tool: 'query', detail: 'SELECT 1', rows: 1 }]);

  const failed = toClientMessage({ ...base, status: 'failed', errorCode: null });
  assert.equal(failed.errorCode, 'unknown');
  assert.deepEqual(parseToolCalls('not an array'), []);
});
