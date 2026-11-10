import assert from 'node:assert/strict';
import test from 'node:test';
import { sortConversations, upsertConversation, type ConversationListEntry } from './chatConversationList';

const entry = (id: string, updatedAt: string, title = `title ${id}`, pending = false): ConversationListEntry => ({
  id,
  title,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt,
  pending,
});

test('sortConversations: most recently updated first, stable on ties', () => {
  const sorted = sortConversations([
    entry('b', '2026-11-03T10:00:00.000Z'),
    entry('c', '2026-11-03T12:00:00.000Z'),
    entry('a', '2026-11-03T10:00:00.000Z'),
  ]);
  assert.deepEqual(sorted.map((e) => e.id), ['c', 'a', 'b']);
});

test('upsertConversation adds a new conversation on top', () => {
  const list = [entry('a', '2026-11-03T10:00:00.000Z')];
  const next = upsertConversation(list, entry('n', '2026-11-03T11:00:00.000Z', 'New question', true));
  assert.deepEqual(next.map((e) => e.id), ['n', 'a']);
  assert.equal(next[0]?.pending, true);
});

test('upsertConversation moves an updated conversation up and keeps its original title', () => {
  const list = [entry('a', '2026-11-03T12:00:00.000Z'), entry('b', '2026-11-03T10:00:00.000Z', 'First question')];
  const next = upsertConversation(list, entry('b', '2026-11-03T13:00:00.000Z', 'Follow-up text'));
  assert.deepEqual(next.map((e) => e.id), ['b', 'a']);
  assert.equal(next[0]?.title, 'First question');
});

test('upsertConversation ignores an older snapshot', () => {
  const list = [entry('a', '2026-11-03T12:00:00.000Z', 'A', false)];
  const next = upsertConversation(list, entry('a', '2026-11-03T11:00:00.000Z', 'A', true));
  assert.equal(next[0]?.pending, false);
  assert.equal(next[0]?.updatedAt, '2026-11-03T12:00:00.000Z');
});
