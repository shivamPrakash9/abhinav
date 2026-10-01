import { NextResponse, type NextRequest } from 'next/server';

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts` and made the Node.js runtime
 * the default. Middleware was deprecated because it was widely misused; the docs
 * explicitly say to treat it as a LAST RESORT and prefer layout/route-level
 * checks. This file follows that guidance strictly.
 *
 * What this does: an OPTIMISTIC check only. It looks for the presence of a
 * session cookie and bounces clearly-unauthenticated users away from protected
 * prefixes. It does NOT verify the session, and it never touches the database.
 *
 * Why not verify here?
 *   1. The proxy runs on nearly every request; a Postgres round-trip per request
 *      is the single easiest way to make a Next.js app feel slow.
 *   2. Optimistic checks cannot be the security boundary anyway — a forged cookie
 *      would pass them.
 *
 * The REAL authorization boundary is server-side, in each of these places:
 *   • src/app/(app)/layout.tsx      → `await requireUser()`
 *   • src/app/admin/layout.tsx      → `await requireRole('MODERATOR','ADMIN')`
 *   • every Server Action           → `requireUser()` / `requireRole()`
 *   • every /api/v1 route handler   → `requireUser()` / `requireRole()`
 *
 * Deliberate omission: we do NOT redirect signed-in users away from /sign-in.
 * With a stale cookie that would create a redirect loop
 * (/sign-in → /dashboard → requireUser fails → /sign-in → …). Re-authenticating
 * is always allowed instead.
 */

/** Auth.js cookie names across http/https and secure-prefixed variants. */
const SESSION_COOKIE_NAMES = [
  'authjs.session-token',
  '__Secure-authjs.session-token',
  '__Host-authjs.session-token',
] as const;

/** Route prefixes that require a signed-in user. */
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/analytics',
  '/host',
  '/user',
  '/settings',
  '/admin',
] as const;

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export default function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (!isProtectedPath(pathname)) {
    return NextResponse.next();
  }

  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));
  if (hasSessionCookie) {
    return NextResponse.next();
  }

  const signInUrl = request.nextUrl.clone();
  signInUrl.pathname = '/sign-in';
  signInUrl.search = '';
  signInUrl.searchParams.set('callbackUrl', `${pathname}${search}`);

  return NextResponse.redirect(signInUrl);
}

export const config = {
  /**
   * Skip static assets, image optimisation and the auth callback routes.
   * `/api` is deliberately included so you *can* add API-level optimistic checks,
   * even though the handlers enforce authorization themselves.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?)$).*)',
  ],
};
