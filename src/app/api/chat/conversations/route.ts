import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { chatAccessDenied, chatErrorResponse } from '@/lib/services/chatHttp';
import { chatService } from '@/lib/services/chatService';

export const dynamic = 'force-dynamic';

/**
 * GET /api/chat/conversations — the chat page's conversation sidebar (card
 * #67): the most recently updated conversations with their stable title
 * (first question) and whether a question is still running. Same opt-in +
 * loopback gate as POST /api/chat (ADR-0028).
 */
export const GET = withRouteErrors(async (request: NextRequest) => {
  const denied = chatAccessDenied(request);
  if (denied) return denied;
  try {
    const conversations = await (await chatService()).listConversations();
    return NextResponse.json({ conversations }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return chatErrorResponse(error);
  }
});
