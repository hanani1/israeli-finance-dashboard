import { NextResponse, type NextRequest } from 'next/server';
import { evaluateApiRequest } from '@/lib/services/requestGuard';

// CSRF / DNS-rebinding guard for every API route (card #45, ADR-0019).
// The decision lives in requestGuard.ts so it can be unit tested.
export function middleware(request: NextRequest) {
  const decision = evaluateApiRequest(request, { appOrigin: process.env.APP_ORIGIN });
  if (decision.allowed) return NextResponse.next();

  // Method + path only: never log headers, query strings, or bodies.
  console.warn(`[request-guard] 403 ${decision.error} ${request.method} ${request.nextUrl.pathname}`);
  return NextResponse.json({ error: decision.error }, { status: decision.status });
}

export const config = {
  matcher: '/api/:path*',
  // Node runtime so APP_ORIGIN is read at server start, not inlined at build time.
  runtime: 'nodejs',
};
