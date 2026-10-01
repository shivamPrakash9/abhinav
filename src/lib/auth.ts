import { cache } from 'react';

import type { Role } from '@prisma/client';

import { auth } from '@/auth';
import { prisma } from './db';
import { AppError } from './errors';

/**
 * Server-side authorization helpers.
 *
 * This module is the AUTHORIZATION BOUNDARY. The proxy's cookie check is only a
 * UX optimisation; every Server Component, Server Action and Route Handler that
 * touches private data must call one of these functions.
 *
 * `cache()` memoises per render/request, so a page and its nested components
 * calling `requireUser()` cost exactly ONE session lookup and ONE user lookup,
 * not one per component. Outside a React render (e.g. a cron route) `cache()` is
 * a transparent pass-through, so it is always safe to call.
 */

export const getSession = cache(async () => auth());

export type CurrentUser = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  username: string | null;
  role: Role;
  xp: number;
  isBanned: boolean;
  premiumUntil: Date | null;
};

/** Returns the signed-in user's database row, or null. Never throws. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return null;

  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      username: true,
      role: true,
      xp: true,
      isBanned: true,
      premiumUntil: true,
    },
  });
});

/**
 * Requires an authenticated, non-banned user.
 * Throws AppError (401/403) — callers convert it with `toErrorResponse`, or let
 * it bubble to the error boundary in a Server Component.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError('UNAUTHENTICATED');
  if (user.isBanned) {
    throw new AppError('FORBIDDEN', 'This account has been suspended. Contact support if you believe this is a mistake.');
  }
  return user;
}

/**
 * Requires one of the given roles.
 *
 * The role is read from Postgres (not from OAuth claims or session cookies), so
 * revoking a moderator's access takes effect on their very next request.
 */
export async function requireRole(...roles: readonly Role[]): Promise<CurrentUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) {
    throw new AppError('FORBIDDEN', 'You do not have permission to access this area.');
  }
  return user;
}

export async function requireAdmin(): Promise<CurrentUser> {
  return requireRole('ADMIN');
}

export async function requireModerator(): Promise<CurrentUser> {
  return requireRole('MODERATOR', 'ADMIN');
}

/** True when the user has an active paid subscription. */
export function isPremium(user: Pick<CurrentUser, 'premiumUntil'> | null): boolean {
  return Boolean(user?.premiumUntil && user.premiumUntil.getTime() > Date.now());
}

/** Every value of the Role enum, for validation in admin forms. */
export const ALL_ROLES: readonly Role[] = ['USER', 'MODERATOR', 'ADMIN'] as const;
