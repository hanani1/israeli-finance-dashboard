/**
 * Request guard for `/api/*` (card #45, ADR-0019).
 *
 * The API has no authentication, and a cross-origin `text/plain` or
 * form-encoded POST is a CORS "simple" request that browsers send without a
 * preflight. Without this guard any page the user visits could trigger
 * `/api/sync` (live bank logins), overwrite `/api/credentials`, rewrite rules,
 * etc. This module is the pure decision; `src/middleware.ts` only adapts it.
 *
 * Rules:
 * 1. Host allowlist on every method (DNS-rebinding defence): loopback names
 *    plus the hosts of `APP_ORIGIN` (comma-separated origins).
 * 2. GET / HEAD / OPTIONS pass after the Host check.
 * 3. Other methods need browser provenance: `Sec-Fetch-Site` is authoritative
 *    when present (`same-origin` / `none` allowed, `same-site` / `cross-site`
 *    rejected); otherwise `Origin` must be a loopback origin or listed in
 *    `APP_ORIGIN`. A request carrying neither is rejected.
 * 4. A request body must be `application/json`. Bodyless requests (Sync Now
 *    POST, DELETE) may omit Content-Type; any other Content-Type is rejected.
 *
 * This is CSRF / rebinding hardening, not authentication: anything that can
 * reach the listener directly can still forge these headers.
 */

export interface GuardHeaders {
  get(name: string): string | null;
}

export interface GuardRequest {
  method: string;
  headers: GuardHeaders;
}

export interface GuardOptions {
  /** Comma-separated list of origins the app is served from, e.g. `https://finance.tailnet.ts.net`. */
  appOrigin?: string;
}

export type GuardError = 'host_not_allowed' | 'cross_site_request_rejected' | 'unsupported_content_type';

export type GuardDecision = { allowed: true } | { allowed: false; status: 403; error: GuardError };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

function reject(error: GuardError): GuardDecision {
  return { allowed: false, status: 403, error };
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Normalized `scheme://host[:port]` entries from `APP_ORIGIN`; invalid entries are dropped. */
export function parseAllowedOrigins(appOrigin: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const entry of (appOrigin ?? '').split(',')) {
    if (!entry.trim()) continue;
    const origin = normalizeOrigin(entry);
    if (origin) origins.add(origin);
  }
  return origins;
}

/** Lowercased `host[:port]` of a Host header value or URL host, or null when malformed. */
function normalizeHost(value: string): { host: string; hostname: string } | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /[\s/@?#\\]/.test(trimmed)) return null;
  try {
    const url = new URL(`http://${trimmed}`);
    return { host: url.host, hostname: url.hostname };
  } catch {
    return null;
  }
}

function isHostAllowed(hostHeader: string | null, allowedOrigins: Set<string>): boolean {
  if (!hostHeader) return false;
  const parsed = normalizeHost(hostHeader);
  if (!parsed) return false;
  if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) return true;
  for (const origin of allowedOrigins) {
    if (new URL(origin).host === parsed.host) return true;
  }
  return false;
}

function isOriginAllowed(originHeader: string, allowedOrigins: Set<string>): boolean {
  const origin = normalizeOrigin(originHeader);
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;
  return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
}

function hasBody(headers: GuardHeaders): boolean {
  if (headers.get('transfer-encoding')) return true;
  const length = headers.get('content-length');
  if (length === null) return false;
  return length.trim() !== '0';
}

export function evaluateApiRequest(request: GuardRequest, options: GuardOptions = {}): GuardDecision {
  const { headers } = request;
  const allowedOrigins = parseAllowedOrigins(options.appOrigin);

  if (!isHostAllowed(headers.get('host'), allowedOrigins)) return reject('host_not_allowed');

  if (SAFE_METHODS.has(request.method.toUpperCase())) return { allowed: true };

  const fetchSite = headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (fetchSite) {
    if (!ALLOWED_FETCH_SITES.has(fetchSite)) return reject('cross_site_request_rejected');
  } else {
    const origin = headers.get('origin');
    if (!origin || !isOriginAllowed(origin, allowedOrigins)) return reject('cross_site_request_rejected');
  }

  const contentType = headers.get('content-type');
  if (contentType === null || contentType.trim() === '') {
    return hasBody(headers) ? reject('unsupported_content_type') : { allowed: true };
  }
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (mediaType !== 'application/json') return reject('unsupported_content_type');

  return { allowed: true };
}
