import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCategorizationPrompt,
  parseCategorizationResponse,
  redactTransactionDescription,
} from './llmCategorizationService';

test('redacts long numeric identifiers and normalizes whitespace', () => {
  assert.equal(
    redactTransactionDescription('Transfer 12-000-0000-000000001   merchant 123456'),
    'Transfer <number> merchant <number>',
  );
});

test('builds prompts with redacted descriptions and opaque indexes', () => {
  const prompt = buildCategorizationPrompt(
    [{ description: 'Merchant account 123456789', chargedAmount: -42.129 }],
    [{ id: 4, name: 'Dining', type: 'EXPENSE' }],
  );
  assert.match(prompt, /<number>/);
  assert.doesNotMatch(prompt, /123456789/);
  assert.match(prompt, /"amount":-42\.13/);
});

test('parses a complete assignment array between output markers', () => {
  assert.deepEqual(
    parseCategorizationResponse(
      '\u001b[38;5;141m> \u001b[0mBEGIN_JSON_TEST ```json\n[{"index":1,"categoryId":4},{"index":0,"categoryId":2}]\n``` END_JSON_TEST suffix',
      2,
      new Set([2, 4]),
    ),
    [
      { index: 0, categoryId: 2 },
      { index: 1, categoryId: 4 },
    ],
  );
});

test('rejects unknown categories, duplicate indexes, and incomplete output', () => {
  assert.throws(
    () => parseCategorizationResponse('BEGIN_JSON_TEST [{"index":0,"categoryId":9}] END_JSON_TEST', 1, new Set([2])),
    /unknown category ID/,
  );
  assert.throws(
    () =>
      parseCategorizationResponse(
        'BEGIN_JSON_TEST [{"index":0,"categoryId":2},{"index":0,"categoryId":2}] END_JSON_TEST',
        2,
        new Set([2]),
      ),
    /invalid or duplicate index/,
  );
  assert.throws(
    () => parseCategorizationResponse('BEGIN_JSON_TEST [{"index":0,"categoryId":2}] END_JSON_TEST', 2, new Set([2])),
    /assigned 1 of 2/,
  );
});

test('uses the final nonce-marked response when earlier markers are echoed', () => {
  const markers = { start: 'BEGIN_JSON_NONCE', end: 'END_JSON_NONCE' };
  const output = [
    'echo BEGIN_JSON_NONCE [{"index":0,"categoryId":999}] END_JSON_NONCE',
    'answer BEGIN_JSON_NONCE [{"index":0,"categoryId":2}] END_JSON_NONCE',
  ].join('\n');
  assert.deepEqual(parseCategorizationResponse(output, 1, new Set([2]), markers), [
    { index: 0, categoryId: 2 },
  ]);
});

// --- CLI provider selection -------------------------------------------------
// The classifier can run through Kiro CLI (default) or Hermes Agent. Both are
// invoked as headless one-shot child processes reading the 0600 prompt file;
// everything downstream (markers, validation, lock) is shared.
import { buildCategorizationCommand, CATEGORIZER_SYSTEM_INSTRUCTIONS } from './llmCategorizationService';

test('defaults to the Kiro CLI with the finance-categorizer agent', () => {
  const command = buildCategorizationCommand({}, '/repo/.kiro/runtime/categorization-prompt.txt');
  assert.equal(command.provider, 'kiro');
  assert.equal(command.executable, 'kiro-cli');
  assert.deepEqual(command.args.slice(0, 7), [
    'chat',
    '--no-interactive',
    '--agent',
    'finance-categorizer',
    '--model',
    'gpt-5.6-sol',
    '--effort',
  ]);
  assert.equal(command.promptPrefix, '');
});

test('builds a hermes one-shot command that reads the prompt file and runs isolated with no tool turns', () => {
  const command = buildCategorizationCommand(
    { CATEGORIZATION_CLI: 'hermes' },
    '/repo/.kiro/runtime/categorization-prompt.txt',
  );
  assert.equal(command.provider, 'hermes');
  assert.equal(command.executable, 'hermes');
  assert.deepEqual(command.args, [
    'chat',
    '--oneshot',
    '--quiet',
    '--safe-mode',
    '--source',
    'tool',
    '--max-turns',
    '1',
    '--query-file',
    '/repo/.kiro/runtime/categorization-prompt.txt',
  ]);
  // Hermes has no per-call agent definition, so the classifier's system
  // instructions are prepended to the prompt file instead.
  assert.equal(command.promptPrefix, `${CATEGORIZER_SYSTEM_INSTRUCTIONS}\n\n`);
});

test('passes an explicit hermes model and executable path through', () => {
  const command = buildCategorizationCommand(
    {
      CATEGORIZATION_CLI: 'hermes',
      CATEGORIZATION_CLI_PATH: '/Users/me/.local/bin/hermes',
      HERMES_CATEGORIZATION_MODEL: 'gpt-5.5',
    },
    '/p.txt',
  );
  assert.equal(command.executable, '/Users/me/.local/bin/hermes');
  assert.deepEqual(command.args.slice(-2), ['--model', 'gpt-5.5']);
});

test('rejects an unknown categorization CLI provider', () => {
  assert.throws(
    () => buildCategorizationCommand({ CATEGORIZATION_CLI: 'gemini' }, '/p.txt'),
    /CATEGORIZATION_CLI must be "kiro" or "hermes"/,
  );
});
