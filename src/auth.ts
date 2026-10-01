import { PrismaAdapter } from '@auth/prisma-adapter';
import NextAuth from 'next-auth';

import { authConfig } from './auth.config';
import { prisma } from './lib/db';

/**
 * Auth.js v5 server instance — the ONLY place the Prisma adapter is attached.
 *
 * Import from Server Components, Server Actions and Route Handlers.
 * Do NOT import this from `proxy.ts`: the proxy runs on every request and only
 * needs a cheap cookie check (see src/proxy.ts for the reasoning).
 *
 * Exports:
 *   handlers → mount at app/api/auth/[...nextauth]/route.ts
 *   auth     → `await auth()` reads the current session
 *   signIn / signOut → server-side auth actions
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  // Trust the deployment host (Vercel sets the correct origin). Required for
  // OAuth callbacks to be accepted when AUTH_URL is not pinned.
  trustHost: true,
  debug: false,
});
