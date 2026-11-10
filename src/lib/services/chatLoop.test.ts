import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildChatCommand, chatChildEnvironment, runChatModel } from './chatCli';
import { runChatLoop, type ChatLoopDeps } from './chatLoop';
import type { ChatContext } from './chatProtocol';
import { ChatInvocationError } from './chatSession';
import type { ScopedQuery } from './chatSqlValidator';

/**
 * A fake `hermes` executable: records argv/cwd/env/prompt to calls.jsonl next
 * to itself and replies per scenario.json, extracting the per-call nonce
 * marker from the prompt file like a well-behaved model would.
 */
const FAKE_CLI = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const argv = process.argv.slice(2);
const fileAt = argv.indexOf('--query-file');
const prompt = fileAt >= 0 ? fs.readFileSync(argv[fileAt + 1], 'utf8') : '';
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({
  argv, cwd: process.cwd(), envKeys: Object.keys(process.env), prompt,
}) + '\n');
const nonce = (/BEGIN_FINANCE_CHAT_([A-Za-z0-9]+)/.exec(prompt) || [])[1] || 'none';
const wrap = (obj) => 'thinking...\nBEGIN_FINANCE_CHAT_' + nonce + '\n' + JSON.stringify(obj) + '\nEND_FINANCE_CHAT_' + nonce + '\n';
const hasData = prompt.includes('DATA —');
switch (scenario.mode) {
  case 'answer':
    process.stdout.write(wrap({ type: 'answer', text: 'Hello from fake hermes' }));
    break;
  case 'tool-then-answer': {
    if (!hasData) {
      process.stdout.write(wrap({ type: 'tools', calls: [{ name: 'query', args: { sql: 'SELECT ROUND(SUM(-"chargedAmount")::numeric, 2) AS total FROM "Transaction" WHERE "chargedAmount" < 0' } }] }));
    } else {
      const lines = prompt.split('\n');
      const dataLine = lines[lines.findIndex((l) => l.startsWith('DATA —')) + 1];
      const result = JSON.parse(dataLine);
      process.stdout.write(wrap({ type: 'answer', text: 'You spent ' + result.rows[0].total + ' ILS.' }));
    }
    break;
  }
  case 'always-tool':
    process.stdout.write(wrap({ type: 'tools', calls: [{ name: 'account_balances', args: {} }] }));
    break;
  case 'garbage':
    process.stdout.write('I will just chat without markers.');
    break;
  case 'garbage-then-answer':
    process.stdout.write(prompt.includes('previous reply was rejected') ? wrap({ type: 'answer', text: 'recovered' }) : 'no markers');
    break;
  case 'not-logged-in':
    process.stderr.write('Error: no API key configured for provider. Run hermes login.\n');
    process.exit(2);
  case 'sleep':
    setTimeout(() => {}, 30000);
    break;
  case 'flood':
    process.stdout.write('x'.repeat(400000));
    break;
}
`;

async function setupFake(mode: string): Promise<{ dir: string; cli: string; calls: () => Promise<any[]> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-hermes-'));
  const cli = path.join(dir, 'hermes');
  await writeFile(cli, FAKE_CLI, 'utf8');
  await chmod(cli, 0o755);
  await writeFile(path.join(dir, 'scenario.json'), JSON.stringify({ mode }));
  return {
    dir,
    cli,
    calls: async () =>
      existsSync(path.join(dir, 'calls.jsonl'))
        ? (await readFile(path.join(dir, 'calls.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  };
}

const CONTEXT: ChatContext = {
  todayIso: '2026-11-02',
  categories: [{ name: 'סופר', type: 'EXPENSE', group: 'VARIABLE_EXPENSE' }],
  txnDateRange: { min: '2026-01-01', max: '2026-11-01' },
  memberFiltered: false,
};

function deps(cli: string, rows: Record<string, unknown>[] = [], seen: ScopedQuery[] = []): ChatLoopDeps {
  const environment = {
    CHAT_CLI_PATH: cli,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DATABASE_URL: 'postgresql://finance:secret@localhost/finance',
    CHAT_DB_URL: 'postgresql://finance_chat_ro:secret@localhost/finance',
    ENCRYPTION_KEY: 'deadbeef',
  };
  return {
    invokeModel: (prompt) => runChatModel('hermes', prompt, { environment, timeoutMs: 5_000 }),
    executeQuery: async (query) => {
      seen.push(query);
      return rows;
    },
  };
}

test('fake hermes: a direct answer takes one round and the CLI is invoked safely', async () => {
  const fake = await setupFake('answer');
  try {
    const result = await runChatLoop(
      { question: 'QUESTION_SENTINEL_42', history: [{ question: 'earlier', answer: 'before' }], context: CONTEXT, userId: null },
      deps(fake.cli),
    );
    assert.equal(result.answer, 'Hello from fake hermes');
    assert.equal(result.rounds, 1);
    assert.deepEqual(result.toolCalls, []);

    const [call] = await fake.calls();
    assert.deepEqual(call.argv.slice(0, 10), [
      'chat', '--oneshot', '--quiet', '--safe-mode', '--source', 'tool', '--max-turns', '1', '--toolsets', 'todo',
    ]);
    assert.equal(call.argv[10], '--query-file');
    assert.ok(!call.argv.some((arg: string) => arg.includes('QUESTION_SENTINEL_42')), 'question never in argv');
    assert.ok(call.prompt.includes('CURRENT QUESTION: QUESTION_SENTINEL_42'));
    assert.ok(call.prompt.includes('User: earlier'), 'history is replayed');
    for (const secret of ['DATABASE_URL', 'CHAT_DB_URL', 'ENCRYPTION_KEY']) {
      assert.ok(!call.envKeys.includes(secret), `${secret} must not reach the CLI`);
    }
    assert.ok(call.cwd.includes('finance-chat-'), 'runs in a private temp dir');
    assert.equal(existsSync(call.cwd), false, 'temp dir (and prompt file) removed afterwards');
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test('fake hermes: one tool round, then an answer computed from the server-run query', async () => {
  const fake = await setupFake('tool-then-answer');
  const seen: ScopedQuery[] = [];
  try {
    const result = await runChatLoop(
      { question: 'How much did I spend?', history: [], context: CONTEXT, userId: 'user-1' },
      deps(fake.cli, [{ total: { toNumber: () => 321.5 } }], seen),
    );
    assert.equal(result.answer, 'You spent 321.5 ILS.');
    assert.equal(result.rounds, 2);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]?.tool, 'query');
    assert.equal(result.toolCalls[0]?.rows, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.params[0], 'user-1', 'household filter applied by the server');
    assert.match(seen[0]?.text ?? '', /^WITH "User" AS NOT MATERIALIZED/);
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test('fake hermes: endless tool requests stop at max rounds', async () => {
  const fake = await setupFake('always-tool');
  try {
    await assert.rejects(
      runChatLoop({ question: 'q', history: [], context: CONTEXT, userId: null, maxRounds: 3 }, deps(fake.cli)),
      (error: unknown) => error instanceof ChatInvocationError && error.kind === 'max-rounds',
    );
    const calls = await fake.calls();
    assert.equal(calls.length, 3, 'exactly maxRounds model calls');
    assert.ok(calls[2].prompt.includes('LAST round'));
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test('fake hermes: malformed output fails as bad-output; a corrected reply recovers', async () => {
  const garbage = await setupFake('garbage');
  try {
    await assert.rejects(
      runChatLoop({ question: 'q', history: [], context: CONTEXT, userId: null, maxRounds: 2 }, deps(garbage.cli)),
      (error: unknown) => error instanceof ChatInvocationError && error.kind === 'bad-output',
    );
  } finally {
    await rm(garbage.dir, { recursive: true, force: true });
  }
  const recovering = await setupFake('garbage-then-answer');
  try {
    const result = await runChatLoop(
      { question: 'q', history: [], context: CONTEXT, userId: null },
      deps(recovering.cli),
    );
    assert.equal(result.answer, 'recovered');
    assert.equal(result.rounds, 2);
  } finally {
    await rm(recovering.dir, { recursive: true, force: true });
  }
});

test('fake hermes: rejected tool requests are fed back as errors, never executed', async () => {
  const seen: ScopedQuery[] = [];
  let round = 0;
  const result = await runChatLoop(
    { question: 'q', history: [], context: CONTEXT, userId: null },
    {
      nonce: () => 'n',
      invokeModel: async (prompt) => {
        round++;
        if (round === 1) {
          return 'BEGIN_FINANCE_CHAT_n {"type":"tools","calls":[{"name":"query","args":{"sql":"SELECT * FROM \\"BankCredential\\""}},{"name":"execute_bash","args":{"cmd":"id"}}]} END_FINANCE_CHAT_n';
        }
        assert.ok(prompt.includes('SQL rejected'));
        assert.ok(prompt.includes('Unknown tool'));
        return 'BEGIN_FINANCE_CHAT_n {"type":"answer","text":"I cannot access that."} END_FINANCE_CHAT_n';
      },
      executeQuery: async (query) => {
        seen.push(query);
        return [];
      },
    },
  );
  assert.equal(result.answer, 'I cannot access that.');
  assert.equal(seen.length, 0, 'nothing reached the database');
  assert.equal(result.toolCalls.filter((c) => c.error).length, 2);
});

test('fake hermes: CLI failures map to clear error kinds', async () => {
  const cases: Array<[string, string]> = [
    ['not-logged-in', 'not-logged-in'],
    ['flood', 'output-limit'],
  ];
  for (const [mode, kind] of cases) {
    const fake = await setupFake(mode);
    try {
      await assert.rejects(
        runChatModel('hermes', 'prompt', { environment: { CHAT_CLI_PATH: fake.cli, PATH: process.env.PATH }, maxOutputBytes: 100_000 }),
        (error: unknown) => error instanceof ChatInvocationError && error.kind === kind,
        mode,
      );
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  }
  const slow = await setupFake('sleep');
  try {
    await assert.rejects(
      runChatModel('hermes', 'prompt', { environment: { CHAT_CLI_PATH: slow.cli, PATH: process.env.PATH }, timeoutMs: 500 }),
      (error: unknown) => error instanceof ChatInvocationError && error.kind === 'timeout',
    );
  } finally {
    await rm(slow.dir, { recursive: true, force: true });
  }
  await assert.rejects(
    runChatModel('hermes', 'prompt', { environment: { CHAT_CLI_PATH: '/nonexistent/hermes', PATH: process.env.PATH } }),
    (error: unknown) => error instanceof ChatInvocationError && error.kind === 'cli-missing',
  );
});

test('buildChatCommand: provider selection, CHAT_CLI_PATH and HERMES_CHAT_MODEL', () => {
  const hermes = buildChatCommand('hermes', { HERMES_CHAT_MODEL: 'gpt-5.5' }, '/tmp/p.txt');
  assert.equal(hermes.executable, 'hermes');
  assert.deepEqual(hermes.args.slice(-4), ['--query-file', '/tmp/p.txt', '--model', 'gpt-5.5']);
  assert.ok(hermes.args.includes('--safe-mode'));

  const hermesPath = buildChatCommand('hermes', { CHAT_CLI_PATH: '/opt/bin/hermes' }, '/tmp/p.txt');
  assert.equal(hermesPath.executable, '/opt/bin/hermes');
  assert.ok(!hermesPath.args.includes('--model'));

  const kiro = buildChatCommand('kiro', { KIRO_CLI_PATH: '/usr/local/bin/kiro-cli' }, '/repo/.kiro/runtime/chat-prompt.txt');
  assert.equal(kiro.executable, '/usr/local/bin/kiro-cli');
  assert.deepEqual(kiro.args.slice(0, 4), ['chat', '--no-interactive', '--agent', 'finance-chat']);
  assert.equal(kiro.args.at(-2), '--', 'static instruction after the flag terminator');
  assert.ok(!kiro.args.some((arg) => arg.includes('chat-prompt')), 'prompt path comes from the agent resource');
  assert.equal(kiro.promptLocation, 'kiro-runtime');
});

test('chatChildEnvironment passes only the allowlist', () => {
  const env = chatChildEnvironment({
    PATH: '/bin',
    HOME: '/home/u',
    HERMES_HOME: '/home/u/.hermes',
    DATABASE_URL: 'x',
    CHAT_DB_URL: 'y',
    ENCRYPTION_KEY: 'z',
    OPENAI_API_KEY: 'k',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HERMES_HOME', 'HOME', 'KIRO_LOG_NO_COLOR', 'NO_COLOR', 'PATH']);
});
