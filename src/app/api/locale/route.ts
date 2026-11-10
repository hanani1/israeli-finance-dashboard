import { NextRequest, NextResponse } from 'next/server';
import { withRouteErrors } from '@/lib/api/routeError';
import { isLocale, LOCALE_COOKIE } from '@/i18n/config';

export const dynamic = 'force-dynamic';

interface PostBody {
  locale: string;
}

/** Persist the reader's locale choice in a long-lived cookie. */
export const POST = withRouteErrors(async (request: NextRequest): Promise<NextResponse> => {
  const body = (await request.json()) as PostBody;

  if (!isLocale(body.locale)) {
    return NextResponse.json({ error: 'unsupported locale' }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true, locale: body.locale });
  response.cookies.set(LOCALE_COOKIE, body.locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  return response;
});
