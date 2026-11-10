import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { isValidChatId } from '@/lib/services/chatConversation';
import { chatAccessDenied, chatErrorResponse } from '@/lib/services/chatHttp';
import { chatService } from '@/lib/services/chatService';

export const dynamic = 'force-dynamic';

/**
 * POST /api/chat/messages/[id]/retry — re-run a FAILED question in place
 * (timeout, CLI error, server restart). Completed answers are never re-run
 * (409); a pending one is returned as is. Rate limited like a new question.
 */
export const POST = withRouteErrors(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const denied = chatAccessDenied(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isValidChatId(id)) return NextResponse.json({ code: 'not-found', error: 'Message not found.' }, { status: 404 });
  try {
    const message = await (await chatService()).retry(id);
    return NextResponse.json({ message }, { status: 202 });
  } catch (error) {
    return chatErrorResponse(error);
  }
});
