import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareLoginFields } from './providerCredentials';

test('maps the legacy Discount username field to num', () => {
  assert.deepEqual(
    prepareLoginFields('discount', {
      id: '123456789',
      password: 'secret',
      username: 'user-code',
    }),
    {
      id: '123456789',
      password: 'secret',
      num: 'user-code',
    },
  );
});

test('preserves an explicit Discount num field', () => {
  assert.deepEqual(
    prepareLoginFields('discount', {
      id: '123456789',
      password: 'secret',
      num: 'user-code',
      username: 'ignored-legacy-value',
    }),
    {
      id: '123456789',
      password: 'secret',
      num: 'user-code',
    },
  );
});

test('rejects incomplete Discount credentials with a clear error', () => {
  assert.throws(
    () => prepareLoginFields('discount', { id: '123456789', password: 'secret' }),
    /Missing required login field\(s\) for discount: num/,
  );
});

test('rejects an empty credential payload for every provider', () => {
  assert.throws(
    () => prepareLoginFields('hapoalim', {}),
    /At least one login field is required/,
  );
});

// Isracard's login form drops non-alphanumeric keystrokes, so a password with
// punctuation cannot be the account's real password; sending it verbatim makes
// the provider answer status -3 (INVALID_PASSWORD). Reject it up front.
test('rejects an Isracard password containing punctuation with an actionable message', () => {
  assert.throws(
    () => prepareLoginFields('isracard', { id: '123456789', card6Digits: '123456', password: 'Abc!12&xyz' }),
    /letters and digits only/,
  );
});

test('rejects an Isracard password without a digit or without a letter', () => {
  assert.throws(() => prepareLoginFields('isracard', { id: '1', card6Digits: '1', password: 'abcdefgh' }), /at least one of each/);
  assert.throws(() => prepareLoginFields('isracard', { id: '1', card6Digits: '1', password: '12345678' }), /at least one of each/);
});

test('accepts an Isracard password with 8-20 Latin letters and digits', () => {
  assert.deepEqual(
    prepareLoginFields('isracard', {
      id: '123456789',
      card6Digits: '123456',
      password: 'abc12345',
    }),
    {
      id: '123456789',
      card6Digits: '123456',
      password: 'abc12345',
    },
  );
});
