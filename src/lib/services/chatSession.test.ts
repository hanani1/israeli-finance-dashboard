import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChatInvocationError,
  ChatRateLimiter,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  capHistory,
  chatCliProvider,
  chatFailureResponse,
  classifyCliFailure,
  isChatEnabled,
  isLoopbackRequest,
} from './chatSession';

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

test('capHistory keeps the newest turns within the turn and character caps', () => {
  const many = Array.from({ length: MAX_HISTORY_TURNS + 3 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
  const kept = capHistory(many);
  assert.equal(kept.length, MAX_HISTORY_TURNS);
  assert.equal(kept.at(-1)?.question, `q${MAX_HISTORY_TURNS + 2}`, 'newest turn kept');

  const big = 'x'.repeat(MAX_HISTORY_CHARS / 2);
  const capped = capHistory([
    { question: 'old', answer: big },
    { question: 'mid', answer: big },
    { question: 'new', answer: 'short' },
  ]);
  assert.deepEqual(capped.map((t) => t.question), ['mid', 'new'], 'oldest dropped first by size');
});

test('ChatRateLimiter allows `limit` hits per window, then refuses until the window slides', () => {
  const limiter = new ChatRateLimiter(2, 60_000);
  assert.equal(limiter.tryAcquire(0), true);
  assert.equal(limiter.tryAcquire(1_000), true);
  assert.equal(limiter.tryAcquire(2_000), false);
  assert.equal(limiter.tryAcquire(60_000), true, 'first hit left the window');
});

test('isChatEnabled is opt-in (off unless CHAT_ENABLED=true)', () => {
  assert.equal(isChatEnabled({}), false);
  assert.equal(isChatEnabled({ CHAT_ENABLED: 'false' }), false);
  assert.equal(isChatEnabled({ CHAT_ENABLED: '1' }), false);
  assert.equal(isChatEnabled({ CHAT_ENABLED: 'true' }), true);
  assert.equal(isChatEnabled({ CHAT_ENABLED: ' TRUE ' }), true);
});

test('chatCliProvider defaults to hermes, accepts kiro, rejects anything else', () => {
  assert.equal(chatCliProvider({}), 'hermes');
  assert.equal(chatCliProvider({ CHAT_CLI: 'Kiro' }), 'kiro');
  assert.equal(chatCliProvider({ CHAT_CLI: 'hermes' }), 'hermes');
  assert.throws(() => chatCliProvider({ CHAT_CLI: 'bash' }), (error: unknown) => {
    return error instanceof ChatInvocationError && error.kind === 'config';
  });
});

test('classifyCliFailure detects missing logins', () => {
  assert.equal(classifyCliFailure('Error: No API key configured for provider openai'), 'not-logged-in');
  assert.equal(classifyCliFailure('You are not logged in. Run hermes login.'), 'not-logged-in');
  assert.equal(classifyCliFailure('HTTP 401 Unauthorized'), 'not-logged-in');
  assert.equal(classifyCliFailure('Traceback: something else'), 'cli-error');
});

// What `next start` hands a route handler for a direct request from this
// machine: Next fills X-Forwarded-For with the socket peer (only when the
// client did not send one) and X-Forwarded-Host with the Host header.
function directLoopback(extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: 'localhost:3000',
    'x-forwarded-host': 'localhost:3000',
    'x-forwarded-for': '127.0.0.1',
    ...extra,
  };
}

test('isLoopbackRequest accepts a direct loopback client in common forms', () => {
  assert.equal(isLoopbackRequest(headers(directLoopback())), true, 'curl http://localhost:3000');
  assert.equal(
    isLoopbackRequest(headers({ host: '127.0.0.1:3000', 'x-forwarded-for': '::ffff:127.0.0.1' })),
    true,
  );
  assert.equal(isLoopbackRequest(headers({ host: '[::1]:3000', 'x-forwarded-for': '::1' })), true);
  assert.equal(
    isLoopbackRequest(headers({ host: 'localhost', 'x-forwarded-for': '127.0.0.1' })),
    true,
  );
});

test('isLoopbackRequest accepts a genuine same-origin localhost browser request', () => {
  assert.equal(
    isLoopbackRequest(
      headers(
        directLoopback({
          origin: 'http://localhost:3000',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'user-agent': 'Mozilla/5.0',
        }),
      ),
    ),
    true,
  );
  // Typed into the address bar / bookmark.
  assert.equal(isLoopbackRequest(headers(directLoopback({ 'sec-fetch-site': 'none' }))), true);
});

test('isLoopbackRequest rejects non-loopback Host headers', () => {
  for (const host of ['192.168.1.20:3000', 'finance.example.com', 'localhost.evil.com']) {
    assert.equal(isLoopbackRequest(headers({ host, 'x-forwarded-for': '127.0.0.1' })), false, host);
  }
  assert.equal(isLoopbackRequest(headers({ 'x-forwarded-for': '127.0.0.1' })), false, 'no Host');
});

test('isLoopbackRequest rejects a spoofed Host from a non-loopback peer', () => {
  // `curl -H 'Host: localhost:3000' http://<lan-ip>:3000/api/chat` — Next
  // records the real peer in X-Forwarded-For.
  assert.equal(
    isLoopbackRequest(headers({ host: 'localhost:3000', 'x-forwarded-for': '192.168.1.20' })),
    false,
  );
  assert.equal(
    isLoopbackRequest(headers({ host: 'localhost:3000', 'x-forwarded-for': '100.101.102.103' })),
    false,
    'tailnet peer',
  );
  // Docker bridge gateway: a host request into the container is not loopback.
  assert.equal(
    isLoopbackRequest(headers({ host: 'localhost:3002', 'x-forwarded-for': '172.17.0.1' })),
    false,
  );
});

test('isLoopbackRequest fails closed when the peer is unknown', () => {
  // Host alone is client-controlled and never sufficient.
  assert.equal(isLoopbackRequest(headers({ host: 'localhost:3000' })), false);
  assert.equal(
    isLoopbackRequest(headers({ host: 'localhost:3000', 'x-forwarded-for': '' })),
    false,
  );
  assert.equal(
    isLoopbackRequest(headers({ host: 'localhost:3000', 'x-forwarded-for': 'unknown' })),
    false,
  );
});

test('isLoopbackRequest rejects forwarding chains and proxy headers that claim loopback', () => {
  assert.equal(
    isLoopbackRequest(headers({ host: 'localhost:3000', 'x-forwarded-for': '127.0.0.1, ::1' })),
    false,
    'a multi-hop chain means a proxy was involved',
  );
  assert.equal(
    isLoopbackRequest(
      headers({ host: 'localhost:3000', 'x-forwarded-for': '192.168.1.20, 127.0.0.1' }),
    ),
    false,
  );
  assert.equal(isLoopbackRequest(headers(directLoopback({ 'x-real-ip': '127.0.0.1' }))), false);
  assert.equal(isLoopbackRequest(headers(directLoopback({ 'x-real-ip': '10.0.0.5' }))), false);
  assert.equal(isLoopbackRequest(headers(directLoopback({ forwarded: 'for=127.0.0.1' }))), false);
  assert.equal(
    isLoopbackRequest(headers(directLoopback({ 'x-forwarded-host': 'finance.example.com' }))),
    false,
    'X-Forwarded-Host must agree with Host',
  );
});

test('isLoopbackRequest rejects cross-site browser requests even with loopback headers', () => {
  // A page on another origin POSTing to http://localhost:3000 (CSRF) or a
  // DNS-rebound page: the browser sets Sec-Fetch-Site / Origin itself.
  assert.equal(
    isLoopbackRequest(
      headers(directLoopback({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })),
    ),
    false,
  );
  assert.equal(isLoopbackRequest(headers(directLoopback({ 'sec-fetch-site': 'same-site' }))), false);
  assert.equal(isLoopbackRequest(headers(directLoopback({ 'sec-fetch-site': 'bogus' }))), false);
  assert.equal(
    isLoopbackRequest(headers(directLoopback({ origin: 'https://evil.example' }))),
    false,
    'foreign Origin without Fetch Metadata',
  );
  assert.equal(
    isLoopbackRequest(
      headers(directLoopback({ origin: 'http://localhost:4000', 'sec-fetch-site': 'same-origin' })),
    ),
    false,
    'Origin must match Host exactly',
  );
  assert.equal(isLoopbackRequest(headers(directLoopback({ origin: 'null' }))), false, 'opaque origin');
});

test('chatFailureResponse maps failure kinds to actionable statuses, codes and messages', () => {
  assert.equal(chatFailureResponse(new ChatInvocationError('cli-missing', 'x')).status, 503);
  assert.equal(chatFailureResponse(new ChatInvocationError('timeout', 'x')).status, 504);
  assert.equal(chatFailureResponse(new ChatInvocationError('output-limit', 'x')).status, 502);
  assert.equal(chatFailureResponse(new ChatInvocationError('max-rounds', 'x')).code, 'max-rounds');
  const login = chatFailureResponse(new ChatInvocationError('not-logged-in', 'x'), 'hermes');
  assert.equal(login.code, 'not-logged-in');
  assert.ok(login.error.includes('hermes doctor'));
  const cliError = chatFailureResponse(new ChatInvocationError('cli-error', 'boom /private/path'), 'kiro');
  assert.equal(cliError.status, 502);
  assert.ok(!cliError.error.includes('/private/path'), 'internal detail never reaches the client');
  assert.ok(cliError.error.includes('kiro-cli whoami'), 'message tells the user what to check');
  const db = chatFailureResponse(new ChatInvocationError('db-unavailable', 'postgresql://u:pw@h/db'));
  assert.ok(!db.error.includes('pw'), 'connection strings never reach the client');
  assert.equal(chatFailureResponse(new Error('other')).status, 502);
});
