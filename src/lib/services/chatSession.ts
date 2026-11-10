/**
 * Pure logic for the finance chat feature (ADR-0026): history replay caps
 * (the history itself is persisted, ADR-0027), a global rate limiter,
 * loopback request detection (defense-in-depth only; see isLoopbackRequest),
 * feature/provider configuration, and failure mapping.
 *
 * Everything here is side-effect free so it can be unit tested; process
 * handling lives in chatCli.ts and orchestration in chatService.ts.
 */

/** Reject over-long inputs before they reach the CLI. */
export const MAX_CHAT_MESSAGE_LENGTH = 4_000;

/** History replayed into each one-shot call: at most this many previous turns… */
export const MAX_HISTORY_TURNS = 6;
/** …and at most this many characters in total (oldest turns dropped first). */
export const MAX_HISTORY_CHARS = 8_000;

export interface ChatTurn {
  question: string;
  answer: string;
}

/** Keeps the newest turns within MAX_HISTORY_TURNS and MAX_HISTORY_CHARS. */
export function capHistory(turns: readonly ChatTurn[]): ChatTurn[] {
  const kept: ChatTurn[] = [];
  let chars = 0;
  for (let index = turns.length - 1; index >= 0 && kept.length < MAX_HISTORY_TURNS; index--) {
    const turn = turns[index];
    if (!turn) continue;
    const size = turn.question.length + turn.answer.length;
    if (chars + size > MAX_HISTORY_CHARS) break;
    chars += size;
    kept.unshift(turn);
  }
  return kept;
}

/**
 * Sliding-window limiter for chat messages. The app is single-household and
 * loopback-only, so one global window bounds model cost regardless of who is
 * asking (each message may run up to CHAT_MAX_ROUNDS model calls).
 */
export class ChatRateLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
  ) {}

  /** Records a hit and returns true when allowed; returns false (no record) when over the limit. */
  tryAcquire(now: number = Date.now()): boolean {
    while (this.hits.length > 0 && now - (this.hits[0] ?? 0) >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}

type ChatEnvironment = Record<string, string | undefined>;

/** The chat is opt-in: questions and derived data go to the model provider. */
export function isChatEnabled(environment: ChatEnvironment = process.env): boolean {
  return environment.CHAT_ENABLED?.trim().toLowerCase() === 'true';
}

export type ChatCliProvider = 'hermes' | 'kiro';

/** CHAT_CLI=hermes|kiro, default hermes. Unknown values are a configuration error. */
export function chatCliProvider(environment: ChatEnvironment = process.env): ChatCliProvider {
  const value = environment.CHAT_CLI?.trim().toLowerCase() || 'hermes';
  if (value !== 'hermes' && value !== 'kiro') {
    throw new ChatInvocationError('config', `CHAT_CLI must be "hermes" or "kiro" (got "${value}").`);
  }
  return value;
}

function isLoopbackAddress(value: string): boolean {
  const address = value.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (address === '::1' || address === '::ffff:127.0.0.1') return true;
  return /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

function isLoopbackHostname(value: string): boolean {
  return value.trim().toLowerCase() === 'localhost' || isLoopbackAddress(value);
}

function hostWithoutPort(hostHeader: string): string {
  const host = hostHeader.trim();
  // Bracketed IPv6 with optional port, e.g. "[::1]:3000".
  const ipv6 = /^(\[[^\]]+\])(?::\d+)?$/.exec(host);
  if (ipv6?.[1]) return ipv6[1];
  return host.replace(/:\d+$/, '');
}

/** Fetch Metadata values a browser sends for same-origin or user-initiated requests. */
const TRUSTED_FETCH_SITES = new Set(['same-origin', 'none']);

type HeaderReader = { get(name: string): string | null };

/**
 * Decides whether a chat request may proceed as "from this machine".
 *
 * Next.js 15 App Router route handlers do not expose the socket peer address
 * (`NextRequest.ip` is gone). The closest signal is `X-Forwarded-For`, which
 * Next's server fills with `socket.remoteAddress` — but only when the client
 * did not send the header itself (`??=`), so it is spoofable. Every check here
 * is therefore defense-in-depth that fails closed; the real access-control
 * wall is the network bind (127.0.0.1 by default, see README "Security").
 *
 * Accepted only when ALL of the following hold:
 * - Host is a loopback name/address (blocks DNS rebinding and LAN Host
 *   spoofing that a non-loopback Host would reveal);
 * - X-Forwarded-For is exactly one loopback address (what Next records for a
 *   direct loopback peer; a non-loopback peer that does not forge the header
 *   is caught here, and any multi-hop chain means a proxy was involved);
 * - no X-Real-IP / Forwarded header (Next never sets them; a direct client
 *   has no reason to) and X-Forwarded-Host, if present, equals Host;
 * - browser signals, when present, say same-origin: Sec-Fetch-Site is
 *   `same-origin` or `none`, and Origin equals `http://<Host>`.
 *
 * Residual risk (documented, not fixable without the socket): a peer that can
 * reach the listener AND forges `Host: localhost` + `X-Forwarded-For:
 * 127.0.0.1` from a non-browser client is accepted. Keep the bind private.
 */
export function isLoopbackRequest(headers: HeaderReader): boolean {
  const host = headers.get('host')?.trim();
  if (!host || !isLoopbackHostname(hostWithoutPort(host))) return false;

  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor === null) return false;
  const hops = forwardedFor.split(',').map((hop) => hop.trim());
  if (hops.length !== 1 || !hops[0] || !isLoopbackAddress(hops[0])) return false;

  if (headers.get('x-real-ip') !== null || headers.get('forwarded') !== null) return false;
  const forwardedHost = headers.get('x-forwarded-host');
  if (forwardedHost !== null && forwardedHost.trim().toLowerCase() !== host.toLowerCase()) {
    return false;
  }

  const fetchSite = headers.get('sec-fetch-site');
  if (fetchSite !== null && !TRUSTED_FETCH_SITES.has(fetchSite.trim().toLowerCase())) return false;

  const origin = headers.get('origin');
  if (origin !== null) {
    const expected = new Set([`http://${host.toLowerCase()}`, `https://${host.toLowerCase()}`]);
    if (!expected.has(origin.trim().toLowerCase())) return false;
  }
  return true;
}


/** Failure categories a chat invocation can end in, for useful API errors. */
export type ChatFailureKind =
  | 'config'
  | 'cli-missing'
  | 'not-logged-in'
  | 'timeout'
  | 'output-limit'
  | 'cli-error'
  | 'bad-output'
  | 'max-rounds'
  | 'db-unavailable';

export class ChatInvocationError extends Error {
  constructor(
    readonly kind: ChatFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ChatInvocationError';
  }
}

/** stderr/stdout phrases Hermes and Kiro print when there is no usable login/provider. */
const NOT_LOGGED_IN_PATTERN =
  /not (?:logged|signed) in|no (?:api key|provider|credentials)|(?:log|sign) ?in (?:first|required)|unauthori[sz]ed|authentication (?:failed|required)|invalid api key|\b401\b/i;

/** Classifies a non-zero CLI exit from its captured output. */
export function classifyCliFailure(output: string): ChatFailureKind {
  return NOT_LOGGED_IN_PATTERN.test(output) ? 'not-logged-in' : 'cli-error';
}

/**
 * Maps a chat failure to the HTTP status and a stable `code` the page
 * localizes, plus an English fallback message. Messages are curated —
 * stderr details stay in the server log only, so internal paths/config never
 * reach the browser.
 */
export function chatFailureResponse(
  error: unknown,
  provider: ChatCliProvider = 'hermes',
): { status: number; code: string; error: string } {
  const cli = provider === 'hermes' ? 'Hermes' : 'Kiro CLI';
  const loginHint = provider === 'hermes' ? '`hermes doctor` / `hermes login`' : '`kiro-cli whoami`';
  const pathHint = provider === 'hermes' ? 'hermes' : 'kiro-cli';
  if (error instanceof ChatInvocationError) {
    switch (error.kind) {
      case 'config':
        return { status: 503, code: 'config', error: 'Chat is misconfigured on the server. Check the CHAT_* settings in .env and the server log.' };
      case 'db-unavailable':
        return { status: 503, code: 'db', error: 'The read-only chat database connection is not available. Check CHAT_DB_URL and the finance_chat_ro role (see README).' };
      case 'cli-missing':
        return { status: 503, code: 'cli-missing', error: `${cli} could not be started on the server. Install ${pathHint} or set CHAT_CLI_PATH to its absolute path.` };
      case 'not-logged-in':
        return { status: 503, code: 'not-logged-in', error: `${cli} is not logged in to a model provider. Run ${loginHint} on the host, then try again.` };
      case 'timeout':
        return { status: 504, code: 'timeout', error: 'The assistant took too long to answer. Try again, or ask a simpler question.' };
      case 'output-limit':
        return { status: 502, code: 'output-limit', error: 'The assistant produced too much output. Try asking a narrower question.' };
      case 'cli-error':
        return { status: 502, code: 'cli-error', error: `${cli} failed to answer. Check ${loginHint} on the host, then try again.` };
      case 'bad-output':
        return { status: 502, code: 'bad-output', error: 'The assistant replied in an unexpected format. Please try again or rephrase the question.' };
      case 'max-rounds':
        return { status: 502, code: 'max-rounds', error: 'The assistant needed too many data lookups for this question. Try a narrower question.' };
    }
  }
  return { status: 502, code: 'unknown', error: 'Chat request failed unexpectedly. Please try again.' };
}
