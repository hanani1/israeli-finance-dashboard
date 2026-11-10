import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsLikePattern, escapeLikePattern, parseRulePriority } from './rulePattern';

// Card #50: rule patterns are user text matched with ILIKE '%pattern%'. The
// query is parameterized, but LIKE metacharacters in the pattern still widen
// the match ("50%" matched every description containing "50").

test('escapeLikePattern: escapes %, _ and backslash so they match literally', () => {
  assert.equal(escapeLikePattern('50%'), '50\\%');
  assert.equal(escapeLikePattern('a_b'), 'a\\_b');
  assert.equal(escapeLikePattern('c:\\d'), 'c:\\\\d');
  assert.equal(escapeLikePattern('\\%_'), '\\\\\\%\\_');
  assert.equal(escapeLikePattern('שופרסל'), 'שופרסל');
});

test('containsLikePattern: wraps the escaped pattern in % wildcards', () => {
  assert.equal(containsLikePattern('50%'), '%50\\%%');
  assert.equal(containsLikePattern('plain'), '%plain%');
});

// Postgres-semantics reference matcher for ILIKE with the default "\" escape.
function ilike(value: string, like: string): boolean {
  let re = '';
  for (let i = 0; i < like.length; i++) {
    const ch = like.charAt(i);
    if (ch === '\\') re += like.charAt(++i).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is').test(value);
}

test('containsLikePattern: a % or _ pattern no longer over-matches', () => {
  assert.equal(ilike('discount 50 shekel', containsLikePattern('50%')), false);
  assert.equal(ilike('discount 50% off', containsLikePattern('50%')), true);
  assert.equal(ilike('AXB', containsLikePattern('a_b')), false);
  assert.equal(ilike('x A_B y', containsLikePattern('a_b')), true);
});

test('parseRulePriority: omitted defaults to 1; positive integers pass through', () => {
  assert.deepEqual(parseRulePriority(undefined), { ok: true, value: 1 });
  assert.deepEqual(parseRulePriority(1), { ok: true, value: 1 });
  assert.deepEqual(parseRulePriority(50), { ok: true, value: 50 });
});

test('parseRulePriority: rejects zero, negatives, fractions, non-numbers and out-of-range values', () => {
  for (const bad of [0, -1, 1.5, '3', null, NaN, Infinity, true, 2 ** 31]) {
    assert.equal(parseRulePriority(bad).ok, false, `${String(bad)} must be rejected`);
  }
});
