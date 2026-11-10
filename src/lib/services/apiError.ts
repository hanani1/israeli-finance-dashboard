/**
 * Pure helpers behind the client `apiFetch()` (card #51).
 *
 * API routes answer failures with `{ error: string }` (including the request
 * guard's 403 from `src/middleware.ts`). The UI used to drop that body and
 * either swallow the failure or show a generic message. These helpers turn a
 * non-2xx response — or a network failure — into one typed `ApiError` and a
 * user-facing message, without any React/DOM dependency so they can be unit
 * tested.
 */

/** Status used for failures where no HTTP response arrived (server down, offline). */
export const NETWORK_ERROR_STATUS = 0;

/** Longest server message we show verbatim; longer bodies are truncated. */
const MAX_SERVER_MESSAGE_LENGTH = 300;

export class ApiError extends Error {
  /** HTTP status, or `NETWORK_ERROR_STATUS` when the request never got a response. */
  readonly status: number;
  /** The server's `{ error }` message, when the response carried one. */
  readonly serverMessage: string | null;

  constructor(status: number, serverMessage: string | null) {
    super(
      serverMessage ??
        (status === NETWORK_ERROR_STATUS ? 'Network error' : `Request failed (${status})`),
    );
    this.name = 'ApiError';
    this.status = status;
    this.serverMessage = serverMessage;
  }

  get isNetworkError(): boolean {
    return this.status === NETWORK_ERROR_STATUS;
  }
}

/**
 * The `{ error }` string from a response body (raw text), or null when the body
 * is empty, not JSON, or has no usable string `error` field. HTML error pages
 * and stack-trace-ish blobs are deliberately not surfaced.
 */
export function extractServerError(bodyText: string): string | null {
  if (!bodyText.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'string') return null;
  const message = error.replace(/\s+/g, ' ').trim();
  if (!message) return null;
  return message.length > MAX_SERVER_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_SERVER_MESSAGE_LENGTH - 1)}…`
    : message;
}

/** Build the `ApiError` for a non-2xx response from its status and raw body text. */
export function apiErrorFromResponse(status: number, bodyText: string): ApiError {
  return new ApiError(status, extractServerError(bodyText));
}

export interface ApiRequestOptions {
  method?: string;
  /** JSON-serialisable body. When present, `Content-Type: application/json` is sent. */
  json?: unknown;
  signal?: AbortSignal;
}

/**
 * `fetch` init for an API call. A body is always JSON with an explicit
 * `Content-Type: application/json` — the request guard (ADR-0019) rejects any
 * other content type with a 403. Bodyless requests send no Content-Type.
 */
export function buildApiRequestInit(options: ApiRequestOptions = {}): RequestInit {
  const init: RequestInit = { method: options.method ?? (options.json === undefined ? 'GET' : 'POST') };
  if (options.json !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.json);
  }
  if (options.signal) init.signal = options.signal;
  return init;
}

/**
 * User-facing message for a failed mutation: the translated `fallback`
 * describing what failed, plus the server's reason when it sent one.
 * Network failures get `networkMessage` (e.g. "server unreachable") when given.
 * Non-`ApiError` values (bugs, aborted parsing) get the fallback only.
 */
export function describeApiError(
  error: unknown,
  fallback: string,
  options: { networkMessage?: string } = {},
): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.serverMessage) return `${fallback}: ${error.serverMessage}`;
  if (error.isNetworkError && options.networkMessage) return `${fallback}: ${options.networkMessage}`;
  return fallback;
}

/** Minimal `fetch` signature so the request flow can be tested with a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Run an API request and return the parsed JSON body (or `undefined` for an
 * empty body, e.g. 204). Throws `ApiError` on any non-2xx status, on a network
 * failure (status `NETWORK_ERROR_STATUS`), and on an unparseable success body.
 * Caller aborts (`AbortError`) are rethrown unchanged.
 */
export async function performApiRequest<T>(
  fetchImpl: FetchLike,
  url: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, buildApiRequestInit(options));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError(NETWORK_ERROR_STATUS, null);
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    throw new ApiError(response.ok ? NETWORK_ERROR_STATUS : response.status, null);
  }

  if (!response.ok) throw apiErrorFromResponse(response.status, bodyText);
  if (!bodyText.trim()) return undefined as T;
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new ApiError(response.status, null);
  }
}
