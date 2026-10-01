/**
 * Environment variable access with LAZY validation.
 *
 * Why lazy: `next build` must succeed on a clean checkout (CI, a new contributor,
 * a Vercel preview without every secret configured). Throwing at module-import
 * time would make the build fail. Instead, integration modules check for their
 * own configuration and degrade gracefully:
 *
 *   if (!env.upstash) return memoryLimiter(...);   // rate limiting still works
 *   if (!env.resend)  return;                      // email becomes a no-op
 *
 * `assertRequiredEnv()` is called once from `instrumentation.ts` so genuinely
 * required variables fail fast in production, at boot rather than at request time.
 *
 * NOTE: `NEXT_PUBLIC_*` values are inlined at BUILD time by Next.js, so they must
 * be referenced as literal `process.env.NEXT_PUBLIC_X` expressions in client code
 * (see src/components/analytics/posthog-provider.tsx). This module is server-side.
 */

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export const isProduction = process.env.NODE_ENV === 'production';
export const isDevelopment = process.env.NODE_ENV === 'development';

/** Variables without which the application cannot function at all. */
const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'DIRECT_URL',
  'AUTH_SECRET',
  'APP_SECRET',
  'NEXT_PUBLIC_APP_URL',
] as const;

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  appUrl: optional('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000',

  /** HMAC secret for participant keys, IP hashing and Realtime tokens. */
  appSecret: optional('APP_SECRET'),
  cronSecret: optional('CRON_SECRET'),

  databaseUrl: optional('DATABASE_URL'),

  supabase: {
    url: optional('NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: optional('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    serviceRoleKey: optional('SUPABASE_SERVICE_ROLE_KEY'),
    bucket: optional('SUPABASE_STORAGE_BUCKET') ?? 'quiz-media',
  },

  upstash: {
    url: optional('UPSTASH_REDIS_REST_URL'),
    token: optional('UPSTASH_REDIS_REST_TOKEN'),
  },

  resend: {
    apiKey: optional('RESEND_API_KEY'),
    from: optional('EMAIL_FROM') ?? 'Quizly <onboarding@resend.dev>',
  },

  posthog: {
    /** Server-side project key (not the NEXT_PUBLIC_ one). */
    apiKey: optional('POSTHOG_API_KEY'),
    host: optional('NEXT_PUBLIC_POSTHOG_HOST') ?? 'https://us.i.posthog.com',
  },

  stripe: {
    secretKey: optional('STRIPE_SECRET_KEY'),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET'),
    priceIdPremiumMonthly: optional('STRIPE_PRICE_ID_PREMIUM_MONTHLY'),
  },
} as const;

/**
 * Fails fast at boot in production when a required variable is missing.
 * Returns the list of missing names so the caller can log them meaningfully.
 */
export function assertRequiredEnv(): string[] {
  const missing = REQUIRED_IN_PRODUCTION.filter((name) => optional(name) === undefined);
  if (missing.length > 0 && isProduction) {
    throw new Error(
      `Missing required environment variables in production: ${missing.join(', ')}. ` +
        'See .env.example for the full list.',
    );
  }
  return missing;
}
