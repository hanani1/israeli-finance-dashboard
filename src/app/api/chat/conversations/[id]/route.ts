import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { isValidChatId } from '@/lib/services/chatConversation';
import { chatAccessDenied, chatErrorResponse } from '@/lib/services/chatHttp';
import { chatService } from '@/lib/services/chatService';

export const dynamic = 'force-dynamic';

/**
 * GET /api/chat/conversations/[id] — one conversation and its messages
 * (pending / completed / failed). The page polls this while a question is
 * pending (ADR-0027). Same opt-in + loopback gate as POST /api/chat.
 */
export const GET = withRouteErrors(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const denied = chatAccessDenied(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isValidChatId(id)) return NextResponse.json({ code: 'not-found', error: 'Conversation not found.' }, { status: 404 });
  try {
    const view = await (await chatService()).getConversation(id);
    if (!view) return NextResponse.json({ code: 'not-found', error: 'Conversation not found.' }, { status: 404 });
    return NextResponse.json(view, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return chatErrorResponse(error);
  }
});
