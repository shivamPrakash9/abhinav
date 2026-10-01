import type { DefaultSession } from 'next-auth';
import type { Role } from '@prisma/client';

/**
 * Module augmentation so `session.user.id` / `session.user.role` are typed.
 *
 * `User` fields are optional here because Auth.js also constructs User objects
 * internally (e.g. an OAuth profile) that do not carry our extra columns. The
 * `session` callback always fills them in from the database row.
 */
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: Role;
      username: string | null;
      isPremium: boolean;
    } & DefaultSession['user'];
  }

  interface User {
    role?: Role;
    username?: string | null;
    isBanned?: boolean;
    premiumUntil?: Date | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role?: Role;
  }
}

export {};
