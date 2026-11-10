/**
 * Bounded server-side tool loop for one chat question (ADR-0026).
 *
 * round 1..maxRounds: build prompt → one tool-less model call → parse
 *   - answer  → done
 *   - tools   → validate each request (chatTools.planToolRequest), run the
 *               approved ones read-only, append results, next round
 *   - invalid → feed the parse error back once per round, next round
 * The last round tells the model it must answer; a tool request there ends
 * the turn with `max-rounds`. Dependencies are injected so the loop is
 * testable without a database or a real CLI.
 */
import { randomUUID } from 'node:crypto';
import {
  MAX_CALLS_PER_ROUND,
  buildChatPrompt,
  chatMarkers,
  parseModelReply,
  type ChatContext,
  type ToolStep,
} from './chatProtocol';
import { ChatInvocationError, type ChatTurn } from './chatSession';
import { planToolRequest, shapeToolRows } from './chatTools';
import type { ScopedQuery } from './chatSqlValidator';

export const DEFAULT_CHAT_MAX_ROUNDS = 4;
/** Upper bound for CHAT_MAX_ROUNDS, whatever the environment says. */
export const MAX_CHAT_MAX_ROUNDS = 6;

export interface ChatLoopDeps {
  /** One model round: prompt in, raw CLI stdout out. */
  invokeModel(prompt: string): Promise<string>;
  /** Runs a scoped query read-only and returns raw rows. Throw ChatInvocationError('db-unavailable') to abort. */
  executeQuery(query: ScopedQuery): Promise<Record<string, unknown>[]>;
  /** Per-call nonce source (overridable in tests). */
  nonce?(): string;
}

export interface ChatLoopInput {
  question: string;
  history: readonly ChatTurn[];
  context: ChatContext;
  userId: string | null;
  maxRounds?: number;
}

/** What the UI shows about each lookup: transparency without raw rows. */
export interface ToolCallSummary {
  tool: string;
  detail: string;
  rows?: number;
  truncated?: boolean;
  error?: string;
}

export interface ChatLoopResult {
  answer: string;
  toolCalls: ToolCallSummary[];
  rounds: number;
}

function summarize(step: ToolStep): ToolCallSummary {
  return {
    tool: step.request.name,
    detail: step.summary,
    ...(step.result ? { rows: step.result.rows.length, truncated: step.result.truncated } : {}),
    ...(step.error ? { error: step.error } : {}),
  };
}

function dbErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Keep only the Postgres error line; never echo connection strings.
  const line = message.split('\n').find((part) => /error|denied|does not exist|syntax|timeout|cancel/i.test(part)) ?? message;
  return `Query failed: ${line.replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').trim().slice(0, 300)}`;
}

export async function runChatLoop(input: ChatLoopInput, deps: ChatLoopDeps): Promise<ChatLoopResult> {
  const maxRounds = Math.min(Math.max(input.maxRounds ?? DEFAULT_CHAT_MAX_ROUNDS, 1), MAX_CHAT_MAX_ROUNDS);
  const nonce = deps.nonce ?? (() => randomUUID().replace(/-/g, ''));
  const steps: ToolStep[] = [];
  let correction: string | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    const markers = chatMarkers(nonce());
    const prompt = buildChatPrompt({
      markers,
      context: input.context,
      history: input.history,
      question: input.question,
      steps,
      round,
      maxRounds,
      correction,
    });
    const output = await deps.invokeModel(prompt);
    const reply = parseModelReply(output, markers);

    if (reply.kind === 'answer') {
      return { answer: reply.text, toolCalls: steps.map(summarize), rounds: round };
    }
    if (reply.kind === 'invalid') {
      correction = reply.reason;
      continue;
    }
    correction = undefined;
    if (round === maxRounds) break;

    for (const request of reply.calls.slice(0, MAX_CALLS_PER_ROUND)) {
      const plan = planToolRequest(request, input.userId);
      if (!plan.ok) {
        steps.push({ request, summary: `${request.name} (rejected)`, error: plan.error });
        continue;
      }
      try {
        const rows = await deps.executeQuery(plan.query);
        steps.push({ request, summary: plan.summary, result: shapeToolRows(rows) });
      } catch (error) {
        if (error instanceof ChatInvocationError) throw error;
        steps.push({ request, summary: plan.summary, error: dbErrorMessage(error) });
      }
    }
  }

  if (correction !== undefined) {
    throw new ChatInvocationError('bad-output', `Model reply could not be parsed: ${correction}`);
  }
  throw new ChatInvocationError('max-rounds', `No answer after ${maxRounds} rounds.`);
}
