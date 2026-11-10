/**
 * Host CLI invocation for the chat (ADR-0026): one tool-less one-shot model
 * call per round. Same safety pattern as llmCategorizationService: arg-array
 * spawn (no shell), prompt passed through a 0600 file (never argv), capped
 * output, timeout with SIGTERM→SIGKILL, and a minimal allowlisted child
 * environment without DATABASE_URL / CHAT_DB_URL / ENCRYPTION_KEY.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatInvocationError, classifyCliFailure, type ChatCliProvider } from './chatSession';

export const DEFAULT_CHAT_TIMEOUT_MS = 120_000;
export const MAX_CHAT_OUTPUT_BYTES = 256_000;

type ChatEnvironment = Record<string, string | undefined>;

export interface ChatCommand {
  provider: ChatCliProvider;
  executable: string;
  args: string[];
  /** Where the prompt file must be written. */
  promptLocation: 'private-temp' | 'kiro-runtime';
}

/** Kiro's finance-chat agent loads this file as its only resource. */
export const KIRO_CHAT_PROMPT_FILE = path.join('.kiro', 'runtime', 'chat-prompt.txt');

/**
 * Builds the one-shot command for the configured provider.
 *
 * Hermes: `--safe-mode` drops the user's config, memory/rules, plugins, hooks
 * and MCP servers; `--toolsets todo` limits the runtime's own tools to the
 * in-session to-do list (no terminal/file/web/code tools); `--max-turns 1`
 * forbids a tool loop; `--source tool` keeps runs out of the session picker.
 * The run's cwd is an empty private temp dir. Data access never happens
 * inside Hermes — the server runs the lookups (chatLoop.ts).
 *
 * Kiro (fallback): the `finance-chat` agent has `tools: []` and reads the
 * prompt from its runtime resource file.
 */
export function buildChatCommand(
  provider: ChatCliProvider,
  environment: ChatEnvironment,
  promptPath: string,
): ChatCommand {
  const explicitPath = environment.CHAT_CLI_PATH?.trim();
  if (provider === 'hermes') {
    const args = [
      'chat',
      '--oneshot',
      '--quiet',
      '--safe-mode',
      '--source',
      'tool',
      '--max-turns',
      '1',
      '--toolsets',
      'todo',
      '--query-file',
      promptPath,
    ];
    const model = environment.HERMES_CHAT_MODEL?.trim();
    if (model) args.push('--model', model);
    return { provider, executable: explicitPath || 'hermes', args, promptLocation: 'private-temp' };
  }
  const model = environment.KIRO_CHAT_MODEL?.trim() || 'gpt-5.6-sol';
  const agent = environment.KIRO_CHAT_AGENT?.trim() || 'finance-chat';
  return {
    provider,
    executable: explicitPath || environment.KIRO_CLI_PATH?.trim() || 'kiro-cli',
    args: [
      'chat',
      '--no-interactive',
      '--agent',
      agent,
      '--model',
      model,
      '--effort',
      'low',
      '--wrap',
      'never',
      '--',
      'Answer using the runtime prompt resource and reply only in its exact marker format.',
    ],
    promptLocation: 'kiro-runtime',
  };
}

const PASSTHROUGH_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL', 'HERMES_HOME'];

/** Minimal child environment: enough for the CLI to find its own login, nothing of ours. */
export function chatChildEnvironment(environment: ChatEnvironment = process.env): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: '1', KIRO_LOG_NO_COLOR: '1' };
  for (const name of PASSTHROUGH_ENV) {
    const value = environment[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function spawnCollect(
  command: ChatCommand,
  cwd: string,
  options: { timeoutMs: number; maxOutputBytes: number; environment: ChatEnvironment },
): Promise<string> {
  const label = command.provider === 'hermes' ? 'Hermes' : 'Kiro CLI';
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd,
      env: chatChildEnvironment(options.environment) as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const terminate = (error: Error): void => {
      if (settled) return;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5_000);
      forceKillTimer.unref();
      finish(error);
    };
    const onData = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) {
        terminate(new ChatInvocationError('output-limit', `${label} output exceeded the safety limit.`));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };

    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    child.on('error', (error) =>
      finish(new ChatInvocationError('cli-missing', `Failed to start ${label}: ${error.message}`)),
    );
    child.on('close', (code) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (settled) return;
      if (code === 0) {
        finish();
        return;
      }
      const detail = `${stderr}\n${stdout}`.trim().slice(-500);
      finish(
        new ChatInvocationError(
          classifyCliFailure(detail),
          `${label} exited with code ${code}${detail ? `: ${detail}` : ''}`,
        ),
      );
    });

    const timeoutTimer = setTimeout(() => {
      terminate(new ChatInvocationError('timeout', `${label} timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);
  });
}

/**
 * Runs one model round: writes the prompt to a private 0600 file, spawns the
 * CLI, returns stdout, and always deletes the prompt file. Callers serialize
 * invocations (the Kiro runtime file is a fixed path).
 */
export async function runChatModel(
  provider: ChatCliProvider,
  prompt: string,
  options: { timeoutMs?: number; maxOutputBytes?: number; environment?: ChatEnvironment; repoRoot?: string } = {},
): Promise<string> {
  const environment = options.environment ?? process.env;
  const settings = {
    timeoutMs: options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? MAX_CHAT_OUTPUT_BYTES,
    environment,
  };

  if (provider === 'hermes') {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'finance-chat-'));
    try {
      await chmod(directory, 0o700);
      const promptPath = path.join(directory, 'prompt.txt');
      await writeFile(promptPath, prompt, { encoding: 'utf8', mode: 0o600 });
      return await spawnCollect(buildChatCommand(provider, environment, promptPath), directory, settings);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const repoRoot = options.repoRoot ?? process.cwd();
  const promptPath = path.join(repoRoot, KIRO_CHAT_PROMPT_FILE);
  await mkdir(path.dirname(promptPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(promptPath), 0o700);
  try {
    await writeFile(promptPath, prompt, { encoding: 'utf8', mode: 0o600 });
    await chmod(promptPath, 0o600);
    return await spawnCollect(buildChatCommand(provider, environment, promptPath), repoRoot, settings);
  } finally {
    await rm(promptPath, { force: true });
  }
}
