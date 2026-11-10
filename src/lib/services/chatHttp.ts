/**
 * Shared HTTP plumbing for the /api/chat* routes (ADR-0026, ADR-0027): the
 * opt-in + loopback gate every chat route applies (they all expose or create
 * private chat data), and the mapping of chat errors to a status and a stable
 * `code` the page localizes. Detail stays in the server log.
 */
import { NextResponse } from 'next/server';
import { ChatRequestError } from './chatService';
import { chatFailureResponse, isChatEnabled, isLoopbackRequest } from './chatSession';

type HeaderReader = { get(name: string): string | null };

/** Returns the refusal response, or null when the request may proceed. */
export function chatAccessDenied(request: { headers: HeaderReader }): NextResponse | null {
  if (!isChatEnabled()) {
    return NextResponse.json(
      { code: 'disabled', error: 'Chat is turned off. Set CHAT_ENABLED=true on the server to enable it.' },
      { status: 403 },
    );
  }
  if (!isLoopbackRequest(request.headers)) {
    return NextResponse.json({ code: 'not-local', error: 'Chat is available from this machine only.' }, { status: 403 });
  }
  return null;
}

/** Maps a thrown chat error to a curated JSON response. */
export function chatErrorResponse(error: unknown): NextResponse {
  if (error instanceof ChatRequestError) {
    return NextResponse.json({ code: error.code, error: error.message }, { status: error.status });
  }
  console.error('[chat] request failed:', error);
  const { status, code, error: message } = chatFailureResponse(error);
  return NextResponse.json({ code, error: message }, { status });
}
