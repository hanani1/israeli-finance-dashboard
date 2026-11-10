/**
 * Client-side API helper (card #51). Every UI mutation goes through
 * `apiFetch()` so failures are never swallowed: non-2xx responses and network
 * failures throw an `ApiError` carrying the server's `{ error }` message, and
 * bodies are sent as JSON with the Content-Type the request guard requires.
 * The logic lives in `src/lib/services/apiError.ts` (unit tested).
 */
import { performApiRequest, type ApiRequestOptions } from '@/lib/services/apiError';

export { ApiError, describeApiError } from '@/lib/services/apiError';
export type { ApiRequestOptions } from '@/lib/services/apiError';

export function apiFetch<T = unknown>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  return performApiRequest<T>((input, init) => fetch(input, init), url, options);
}
