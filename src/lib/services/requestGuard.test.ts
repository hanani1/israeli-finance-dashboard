import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateApiRequest, parseAllowedOrigins, type GuardRequest } from './requestGuard';

// Card #45: any web page the user visits can fire a CORS "simple" POST
// (text/plain, form-encoded) at this unauthenticated API. The guard rejects
// cross-site mutations, non-JSON bodies, and unexpected Host headers
// (DNS rebinding) before a route handler runs.

function request(
  method: string,
  headers: Record<string, string>,
): GuardRequest {
  const lower = Object.fromEntries(
    Object.entries({ host: '127.0.0.1:3000', ...headers }).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { method, headers: { get: (name) => lower[name.toLowerCase()] ?? null } };
}

const JSON_BODY = { 'content-type': 'application/json', 'content-length': '17' };

test('allows a same-origin JSON mutation from the UI', () => {
  const decision = evaluateApiRequest(
    request('POST', { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3000', ...JSON_BODY }),
  );
  assert.deepEqual(decision, { allowed: true });
});

test('allows charset parameters on application/json', () => {
  const decision = evaluateApiRequest(
    request('PATCH', { 'sec-fetch-site': 'same-origin', 'content-type': 'Application/JSON; charset=utf-8', 'content-length': '2' }),
  );
  assert.equal(decision.allowed, true);
});

test('allows Sec-Fetch-Site: none (user-initiated navigation)', () => {
  assert.equal(evaluateApiRequest(request('POST', { 'sec-fetch-site': 'none', ...JSON_BODY })).allowed, true);
});

test('blocks a cross-site mutation even with a JSON content type', () => {
  const decision = evaluateApiRequest(
    request('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', ...JSON_BODY }),
  );
  assert.deepEqual(decision, { allowed: false, status: 403, error: 'cross_site_request_rejected' });
});

test('blocks same-site (other port / subdomain) mutations', () => {
  const decision = evaluateApiRequest(
    request('POST', { 'sec-fetch-site': 'same-site', origin: 'http://localhost:5173', ...JSON_BODY }),
  );
  assert.equal(decision.allowed, false);
});

test('Sec-Fetch-Site is authoritative over an allowlisted-looking Origin', () => {
  const decision = evaluateApiRequest(
    request('POST', { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:3000', ...JSON_BODY }),
  );
  assert.equal(decision.allowed, false);
});

test('blocks a text/plain body (CORS simple request) even when same-origin', () => {
  const decision = evaluateApiRequest(
    request('POST', { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain;charset=UTF-8', 'content-length': '10' }),
  );
  assert.deepEqual(decision, { allowed: false, status: 403, error: 'unsupported_content_type' });
});

test('blocks form-encoded and multipart bodies', () => {
  for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const decision = evaluateApiRequest(
      request('POST', { 'sec-fetch-site': 'same-origin', 'content-type': contentType, 'content-length': '10' }),
    );
    assert.equal(decision.allowed, false, contentType);
  }
});

test('blocks a body with no content type', () => {
  const decision = evaluateApiRequest(request('POST', { 'sec-fetch-site': 'same-origin', 'content-length': '5' }));
  assert.equal(decision.allowed, false);
  const chunked = evaluateApiRequest(request('POST', { 'sec-fetch-site': 'same-origin', 'transfer-encoding': 'chunked' }));
  assert.equal(chunked.allowed, false);
});

test('allows bodyless same-origin mutations (Sync Now POST, DELETE) without a content type', () => {
  assert.equal(evaluateApiRequest(request('POST', { 'sec-fetch-site': 'same-origin', 'content-length': '0' })).allowed, true);
  assert.equal(evaluateApiRequest(request('DELETE', { 'sec-fetch-site': 'same-origin' })).allowed, true);
});

test('blocks a spoofed / foreign Origin when Sec-Fetch-Site is absent', () => {
  for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1.evil.example', 'not a url']) {
    const decision = evaluateApiRequest(request('POST', { origin, ...JSON_BODY }));
    assert.deepEqual(decision, { allowed: false, status: 403, error: 'cross_site_request_rejected' }, origin);
  }
});

test('falls back to an allowlisted Origin when Sec-Fetch-Site is absent', () => {
  assert.equal(evaluateApiRequest(request('POST', { origin: 'http://localhost:3000', ...JSON_BODY })).allowed, true);
  const appOrigin = 'https://finance.tail1234.ts.net';
  const decision = evaluateApiRequest(
    request('POST', { host: 'finance.tail1234.ts.net', origin: 'https://finance.tail1234.ts.net', ...JSON_BODY }),
    { appOrigin },
  );
  assert.equal(decision.allowed, true);
});

test('blocks mutations with neither Sec-Fetch-Site nor Origin', () => {
  assert.equal(evaluateApiRequest(request('POST', JSON_BODY)).allowed, false);
});

test('blocks a disallowed Host on any method (DNS rebinding)', () => {
  for (const method of ['GET', 'POST']) {
    const decision = evaluateApiRequest(
      request(method, { host: 'attacker.example', 'sec-fetch-site': 'same-origin', ...JSON_BODY }),
    );
    assert.deepEqual(decision, { allowed: false, status: 403, error: 'host_not_allowed' }, method);
  }
  assert.equal(evaluateApiRequest(request('GET', { host: '' })).allowed, false);
});

test('allows loopback hosts and hosts from APP_ORIGIN', () => {
  for (const host of ['localhost', 'localhost:3002', '127.0.0.1:3145', '[::1]:3000', 'LOCALHOST:3000']) {
    assert.equal(evaluateApiRequest(request('GET', { host })).allowed, true, host);
  }
  const options = { appOrigin: 'https://finance.tail1234.ts.net, http://100.64.0.7:3002' };
  assert.equal(evaluateApiRequest(request('GET', { host: 'finance.tail1234.ts.net' }), options).allowed, true);
  assert.equal(evaluateApiRequest(request('GET', { host: '100.64.0.7:3002' }), options).allowed, true);
  assert.equal(evaluateApiRequest(request('GET', { host: '100.64.0.8:3002' }), options).allowed, false);
});

test('GET, HEAD and OPTIONS pass without provenance or content type checks', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const decision = evaluateApiRequest(
      request(method, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', 'content-type': 'text/plain' }),
    );
    assert.deepEqual(decision, { allowed: true }, method);
  }
});

test('parseAllowedOrigins: normalizes APP_ORIGIN entries and drops invalid ones', () => {
  const origins = parseAllowedOrigins(' https://Finance.example/ , bogus,, http://10.0.0.5:3002/path ');
  assert.ok(origins.has('https://finance.example'));
  assert.ok(origins.has('http://10.0.0.5:3002'));
  assert.ok(!origins.has('bogus'));
  assert.ok(parseAllowedOrigins(undefined).size === 0);
});
