import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { isValidChatId, isValidIdempotencyKey } from '@/lib/services/chatConversation';
import { chatAccessDenied, chatErrorResponse } from '@/lib/services/chatHttp';
import { chatService } from '@/lib/services/chatService';
import {
  chatCliProvider,
  isChatEnabled,
  MAX_CHAT_MESSAGE_LENGTH,
  type ChatCliProvider,
} from '@/lib/services/chatSession';

export const dynamic = 'force-dynamic';

const USER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function configuredProvider(): ChatCliProvider | null {
  try {
    return chatCliProvider();
  } catch {
    return null;
  }
}

/** GET /api/chat — feature status for the page (no data, no model call). */
export const GET = withRouteErrors(async () => {
  return NextResponse.json({ enabled: isChatEnabled(), provider: configuredProvider() });
});

/**
 * POST /api/chat — submit one free-text question about the household's data.
 * Body: { message: string, idempotencyKey: string, conversationId?: string, userId?: string }.
 *
 * Returns at once (202, or 200 for a replayed idempotency key) with the
 * pending message; the answer is produced in the background and read via
 * GET /api/chat/conversations/[id] (ADR-0027). Opt-in (CHAT_ENABLED=true),
 * loopback-only (defense-in-depth; the 127.0.0.1 bind is the real boundary),
 * CSRF-guarded by src/middleware.ts, and globally rate limited. The model
 * runs on the host with no tools; the server runs every data lookup
 * read-only (ADR-0026).
 */
export const POST = withRouteErrors(async (request: NextRequest) => {
  const denied = chatAccessDenied(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const field = (name: string): unknown =>
    typeof body === 'object' && body !== null ? Reflect.get(body, name) : undefined;
  const message = field('message');
  const conversationId = field('conversationId');
  const idempotencyKey = field('idempotencyKey');
  const userId = field('userId');

  if (typeof message !== 'string' || message.trim().length === 0) {
    return NextResponse.json({ error: 'message is required.' }, { status: 400 });
  }
  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `message must be at most ${MAX_CHAT_MESSAGE_LENGTH} characters.` },
      { status: 400 },
    );
  }
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return NextResponse.json({ error: 'idempotencyKey is required (16-100 URL-safe characters).' }, { status: 400 });
  }
  if (conversationId !== undefined && conversationId !== null && !isValidChatId(conversationId)) {
    return NextResponse.json({ error: 'conversationId is invalid.' }, { status: 400 });
  }
  if (userId !== undefined && userId !== null && userId !== '' && (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId))) {
    return NextResponse.json({ error: 'userId is invalid.' }, { status: 400 });
  }

  try {
    const chat = await chatService();
    const result = await chat.submit({
      message: message.trim(),
      idempotencyKey,
      conversationId: typeof conversationId === 'string' ? conversationId : undefined,
      userId: typeof userId === 'string' && userId ? userId : null,
    });
    return NextResponse.json({ message: result.message }, { status: result.created ? 202 : 200 });
  } catch (error) {
    return chatErrorResponse(error);
  }
});
