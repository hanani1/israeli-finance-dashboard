/**
 * A client error with a message that is safe — and meant — to show the user
 * (card #53). Services throw it for input they reject (a blank name, a
 * negative budget, a member that still owns accounts); `handleRouteError`
 * answers with its status and message. Any other error becomes a generic 500.
 *
 * Dependency-free so services, scripts and the worker can throw it without
 * pulling in Next.js.
 */
export class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    if (!Number.isInteger(status) || status < 400 || status > 499) {
      throw new RangeError(`RequestError status must be 4xx, got ${status}`);
    }
    this.name = 'RequestError';
    this.status = status;
  }
}
