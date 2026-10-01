import { handlers } from '@/auth';

/**
 * Auth.js route handlers (sign-in, sign-out, OAuth callbacks, session).
 *
 * Mounted at /api/auth/[...nextauth]:
 *   GET  /api/auth/signin             → interactive sign-in
 *   GET  /api/auth/callback/google    → register this exact URL with Google
 *   GET  /api/auth/callback/github    → and this one with GitHub
 *   GET  /api/auth/session            → current session JSON
 *   POST /api/auth/signout
 */
export const { GET, POST } = handlers;

// Auth.js must never be statically optimised or cached.
export const dynamic = 'force-dynamic';
