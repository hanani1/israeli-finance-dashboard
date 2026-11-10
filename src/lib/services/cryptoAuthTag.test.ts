import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { decryptSecret, encryptSecret } from '../security/crypto';

// Synthetic throwaway key. The loader resolves (and caches) the key lazily on
// first use, so setting it before any test runs is enough.
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');

// Card #50: without authTagLength, GCM decipher accepts any tag of 4–16 bytes,
// so a truncated prefix of the real tag still verifies and the effective
// integrity check drops to as little as 32 bits.

test('crypto: a payload round-trips with its full 16-byte tag', () => {
  const payload = encryptSecret('synthetic-secret');
  assert.equal(Buffer.from(payload.tag, 'base64').length, 16);
  assert.equal(decryptSecret(payload), 'synthetic-secret');
});

test('crypto: a truncated auth tag is rejected', () => {
  const payload = encryptSecret('synthetic-secret');
  for (const bytes of [4, 8, 12, 15]) {
    const tag = Buffer.from(payload.tag, 'base64').subarray(0, bytes).toString('base64');
    assert.throws(() => decryptSecret({ ...payload, tag }), `a ${bytes}-byte tag must not verify`);
  }
});
