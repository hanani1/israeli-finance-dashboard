import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { createRuleAndApply, listRules } from '@/lib/services/ruleEngine';
import { parseRulePriority } from '@/lib/services/rulePattern';

export const dynamic = 'force-dynamic';

export const GET = withRouteErrors(async (): Promise<NextResponse> => {
  const rules = await listRules();
  return NextResponse.json(rules);
});

interface PostBody {
  pattern: string;
  categoryId: number;
  priority?: unknown;
  matchMemo?: boolean;
}

export const POST = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const body = (await request.json()) as PostBody;

  if (typeof body.pattern !== 'string' || body.pattern.trim().length === 0) {
    return NextResponse.json({ error: 'pattern is required' }, { status: 400 });
  }
  if (!Number.isInteger(body.categoryId)) {
    return NextResponse.json({ error: 'categoryId must be an integer' }, { status: 400 });
  }
  const priority = parseRulePriority(body.priority);
  if (!priority.ok) {
    return NextResponse.json({ error: priority.error }, { status: 400 });
  }

  const result = await createRuleAndApply({
    pattern: body.pattern,
    categoryId: body.categoryId,
    priority: priority.value,
    matchMemo: body.matchMemo === true,
  });
  return NextResponse.json(result, { status: 201 });
});
