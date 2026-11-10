/**
 * Shared API error policy (card #53, ADR-0027). Every route handler is
 * exported as `withRouteErrors(handler)`; whatever it throws is answered here:
 *
 * - RequestError                     -> its 4xx status + its explicit message
 * - SyntaxError (bad JSON body)      -> 400 { error: 'Invalid JSON body' }
 * - Prisma P2025 (record not found)  -> 404 { error: 'Not found' }
 * - Prisma P2002 / P2003 (conflict)  -> 409 { error: 'Conflict: …' }
 * - anything else                    -> 500 { error: 'Internal server error' }
 *
 * Bodies never carry a stack, a Prisma message or any internal detail; the
 * full error of a 500 goes to the server log. Routes keep their own explicit
 * 4xx validation responses — this only handles what they throw.
 */
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { RequestError } from '@/lib/services/requestError';

const INTERNAL_ERROR = 'Internal server error';

function json(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export function handleRouteError(error: unknown, context = 'API route'): NextResponse {
  if (error instanceof RequestError) return json(error.status, error.message);
  if (error instanceof SyntaxError) return json(400, 'Invalid JSON body');
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2025':
        return json(404, 'Not found');
      case 'P2002':
        return json(409, 'Conflict: a record with these values already exists');
      case 'P2003':
        return json(409, 'Conflict: a related record is missing or still in use');
    }
  }
  console.error(`[api] ${context} failed:`, error);
  return json(500, INTERNAL_ERROR);
}

/**
 * Wrap a route handler so every thrown error is answered by handleRouteError.
 * Keeps the handler's exact parameter types (Next.js checks route exports).
 */
export function withRouteErrors<Args extends unknown[], R extends Response>(
  handler: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R | NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      const request = args[0];
      const context =
        request instanceof Request ? `${request.method} ${new URL(request.url).pathname}` : undefined;
      return handleRouteError(error, context);
    }
  };
}
