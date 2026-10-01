import type { NextAuthConfig } from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';

/**
 * Auth.js v5 base configuration.
 *
 * This file contains NO adapter and NO database imports on purpose. It is safe
 * to import from anywhere (including the proxy), which keeps deployment flexible
 * if you later move the proxy to the edge runtime.
 *
 * The Prisma adapter is attached in `src/auth.ts`, which is server-only.
 *
 * Session strategy: DATABASE.
 * Sessions are stored in Postgres, so signing out everywhere, banning a user and
 * revoking a session take effect immediately — a JWT session cannot be revoked
 * before it expires. The cost is one indexed lookup per authenticated request,
 * which is why `requireUser()` is wrapped in React's `cache()`.
 */
export const authConfig = {
  providers: [
    // Both providers are always registered so the app boots without secrets.
    // The sign-in page only renders buttons for providers that are configured.
    Google({
      // NEVER enable this: it lets an attacker take over an account by creating a
      // new OAuth identity that reuses an existing verified email.
      allowDangerousEmailAccountLinking: false,
    }),
    GitHub({
      allowDangerousEmailAccountLinking: false,
    }),
  ],

  pages: {
    signIn: '/sign-in',
    error: '/sign-in',
  },

  session: {
    strategy: 'database',
    // 30 days, refreshed on activity.
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },

  callbacks: {
    /**
     * Blocks banned accounts at the authentication boundary, and rejects
     * sign-ins from providers that do not return an email address (we require an
     * email for account recovery and for results emails).
     */
    async signIn({ user }) {
      if (!user.email) return false;
      if ('isBanned' in user && user.isBanned === true) return false;
      return true;
    },

    /**
     * With the database strategy the `user` argument is the full DB row, so we
     * can expose `id` and `role` on the session without an extra query.
     * Server code still re-validates the role through `requireRole()`.
     */
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        // `role` is optional on the augmented User type (Auth.js also constructs
        // User objects that lack our extra columns), so fall back to the schema
        // default rather than ever presenting `undefined` as a role.
        session.user.role = user.role ?? 'USER';
        session.user.username = user.username ?? null;
        session.user.isPremium =
          user.premiumUntil !== null && user.premiumUntil !== undefined
            ? user.premiumUntil.getTime() > Date.now()
            : false;
      }
      return session;
    },
  },

  events: {
    async signIn({ user, isNewUser }) {
      if (isNewUser) {
        console.info(`[auth] new user provisioned: ${user.id}`);
      }
    },
    async signOut() {
      // Session rows are deleted by the adapter.
    },
  },
} satisfies NextAuthConfig;

/** True when the matching OAuth credentials are present in the environment. */
export const configuredProviders = {
  google: Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
  github: Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET),
} as const;
