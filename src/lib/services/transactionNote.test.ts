import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTE_MAX_LENGTH, normalizeNote, NoteValidationError } from './transactionNote';

test('normalizeNote trims surrounding whitespace and keeps inner formatting', () => {
  assert.equal(normalizeNote('  paid back by Dana  '), 'paid back by Dana');
  assert.equal(normalizeNote('line 1\nline 2'), 'line 1\nline 2');
});

test('normalizeNote: empty or whitespace-only text means "no note" (delete)', () => {
  assert.equal(normalizeNote(''), null);
  assert.equal(normalizeNote('   \n\t '), null);
  assert.equal(normalizeNote(null), null);
  assert.equal(normalizeNote(undefined), null);
});

test('normalizeNote accepts Hebrew, English, emoji and punctuation', () => {
  const text = 'החזר מדנה 50% — "Dana" & co. 🍕 #ref:12/3';
  assert.equal(normalizeNote(text), text);
});

test('normalizeNote rejects notes longer than NOTE_MAX_LENGTH code points', () => {
  assert.equal(normalizeNote('א'.repeat(NOTE_MAX_LENGTH)), 'א'.repeat(NOTE_MAX_LENGTH));
  assert.throws(() => normalizeNote('a'.repeat(NOTE_MAX_LENGTH + 1)), NoteValidationError);
});

test('normalizeNote rejects non-string input', () => {
  assert.throws(() => normalizeNote(42 as unknown as string), NoteValidationError);
  assert.throws(() => normalizeNote({} as unknown as string), NoteValidationError);
});
