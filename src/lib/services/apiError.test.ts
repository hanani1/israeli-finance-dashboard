import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError,
  NETWORK_ERROR_STATUS,
  apiErrorFromResponse,
  buildApiRequestInit,
  describeApiError,
  extractServerError,
  performApiRequest,
  type FetchLike,
} from './apiError';

// Card #51: UI mutations used to swallow failures (`if (!res.ok) return;`) or
// discard the server's `{ error }` body. These helpers back `apiFetch()`.

test('extracts the { error } message from a JSON body', () => {
  assert.equal(extractServerError('{"error":"Category not found"}'), 'Category not found');
});

test('extracts the request-guard 403 error code', () => {
  assert.equal(
    extractServerError('{"error":"unsupported_content_type"}'),
    'unsupported_content_type',
  );
});

test('returns null for empty, non-JSON, HTML, or error-less bodies', () => {
  assert.equal(extractServerError(''), null);
  assert.equal(extractServerError('   '), null);
  assert.equal(extractServerError('<html><body>502 Bad Gateway</body></html>'), null);
  assert.equal(extractServerError('Internal Server Error'), null);
  assert.equal(extractServerError('{"message":"nope"}'), null);
  assert.equal(extractServerError('{"error":""}'), null);
  assert.equal(extractServerError('{"error":{"code":1}}'), null);
  assert.equal(extractServerError('["error"]'), null);
  assert.equal(extractServerError('null'), null);
});

test('collapses whitespace and truncates very long server messages', () => {
  assert.equal(extractServerError('{"error":"  multi\\n  line  "}'), 'multi line');
  const long = extractServerError(JSON.stringify({ error: 'x'.repeat(1000) }));
  assert.ok(long);
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
});

test('apiErrorFromResponse carries status and server message', () => {
  const error = apiErrorFromResponse(403, '{"error":"cross_site_request_rejected"}');
  assert.ok(error instanceof ApiError);
  assert.ok(error instanceof Error);
  assert.equal(error.status, 403);
  assert.equal(error.serverMessage, 'cross_site_request_rejected');
  assert.equal(error.message, 'cross_site_request_rejected');
  assert.equal(error.isNetworkError, false);
});

test('apiErrorFromResponse without a usable body falls back to the status', () => {
  const error = apiErrorFromResponse(500, '<html/>');
  assert.equal(error.serverMessage, null);
  assert.equal(error.message, 'Request failed (500)');
});

test('buildApiRequestInit sends JSON with Content-Type when there is a body', () => {
  const init = buildApiRequestInit({ method: 'PATCH', json: { categoryId: 3 } });
  assert.equal(init.method, 'PATCH');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
  assert.equal(init.body, '{"categoryId":3}');
});

test('buildApiRequestInit defaults to POST with a body and GET without', () => {
  assert.equal(buildApiRequestInit({ json: {} }).method, 'POST');
  assert.equal(buildApiRequestInit().method, 'GET');
});

test('buildApiRequestInit omits Content-Type and body for bodyless requests', () => {
  const init = buildApiRequestInit({ method: 'DELETE' });
  assert.equal(init.method, 'DELETE');
  assert.equal(init.headers, undefined);
  assert.equal(init.body, undefined);
});

test('describeApiError appends the server reason to the translated fallback', () => {
  assert.equal(
    describeApiError(new ApiError(400, 'Invalid amount'), 'Could not save budget'),
    'Could not save budget: Invalid amount',
  );
});

test('describeApiError uses the network message only for network failures', () => {
  const network = new ApiError(NETWORK_ERROR_STATUS, null);
  assert.equal(network.isNetworkError, true);
  assert.equal(
    describeApiError(network, 'Could not save', { networkMessage: 'server unreachable' }),
    'Could not save: server unreachable',
  );
  assert.equal(describeApiError(network, 'Could not save'), 'Could not save');
  assert.equal(
    describeApiError(new ApiError(502, null), 'Could not save', { networkMessage: 'server unreachable' }),
    'Could not save',
  );
});

test('describeApiError ignores non-ApiError values', () => {
  assert.equal(describeApiError(new Error('stack-ish internals'), 'Failed'), 'Failed');
  assert.equal(describeApiError('boom', 'Failed'), 'Failed');
});

/* ---------------------------- performApiRequest --------------------------- */

function fakeFetch(response: Response | Error, calls: Array<[string, RequestInit | undefined]> = []): FetchLike {
  return async (input, init) => {
    calls.push([input, init]);
    if (response instanceof Error) throw response;
    return response;
  };
}

test('performApiRequest returns parsed JSON on success and sends the JSON body', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const result = await performApiRequest<{ id: number }>(
    fakeFetch(new Response('{"id":7}', { status: 201 }), calls),
    '/api/rules',
    { method: 'POST', json: { pattern: 'x', categoryId: 1 } },
  );
  assert.deepEqual(result, { id: 7 });
  assert.equal(calls[0]?.[0], '/api/rules');
  assert.deepEqual(calls[0]?.[1]?.headers, { 'Content-Type': 'application/json' });
});

test('performApiRequest returns undefined for an empty success body', async () => {
  const result = await performApiRequest(fakeFetch(new Response(null, { status: 204 })), '/api/x', {
    method: 'DELETE',
  });
  assert.equal(result, undefined);
});

test('performApiRequest throws ApiError with the server message on non-2xx', async () => {
  await assert.rejects(
    performApiRequest(
      fakeFetch(new Response('{"error":"Transaction not found"}', { status: 404 })),
      '/api/transactions/x',
      { method: 'PATCH', json: { categoryId: 1 } },
    ),
    (error: unknown) =>
      error instanceof ApiError && error.status === 404 && error.serverMessage === 'Transaction not found',
  );
});

test('performApiRequest maps a rejected fetch to a network ApiError', async () => {
  await assert.rejects(
    performApiRequest(fakeFetch(new TypeError('Failed to fetch')), '/api/budgets', {
      method: 'POST',
      json: {},
    }),
    (error: unknown) => error instanceof ApiError && error.isNetworkError,
  );
});

test('performApiRequest rethrows caller aborts unchanged', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  await assert.rejects(performApiRequest(fakeFetch(abort), '/api/x'), (error: unknown) => error === abort);
});

test('performApiRequest rejects an unparseable success body', async () => {
  await assert.rejects(
    performApiRequest(fakeFetch(new Response('<html/>', { status: 200 })), '/api/x'),
    (error: unknown) => error instanceof ApiError && error.status === 200 && error.serverMessage === null,
  );
});
