import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { env } from './env';
import { AppError } from './errors';

/**
 * Rate limiting.
 *
 * Production: Upstash Redis sliding window (free tier = 500K commands/month).
 * Development / unconfigured: in-memory fallback so local work is never blocked.
 *
 * FAIL-OPEN: if Redis is unreachable we allow the request and log. A rate limiter
 * protects availability; taking the whole product down because the limiter's own
 * dependency blipped would defeat the purpose. Abuse protection still exists at
 * the edge (Vercel WAF) and at the DB constraint level (unique participantKey).
 */

export type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds at which the window resets. */
  reset: number;
};

type Duration = `${number} ${'s' | 'm' | 'h' | 'd'}`;

const redis =
  env.upstash.url && env.upstash.token
    ? new Redis({ url: env.upstash.url, token: env.upstash.token })
    : null;

const limiters = new Map<string, Ratelimit>();

function getLimiter(points: number, window: Duration, prefix: string): Ratelimit | null {
  if (!redis) return null;
  const cacheKey = `${prefix}:${points}:${window}`;
  const existing = limiters.get(cacheKey);
  if (existing) return existing;

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(points, window),
    prefix: `quizly:${prefix}`,
    analytics: false,
  });
  limiters.set(cacheKey, limiter);
  return limiter;
}

// ---------------------------------------------------------------------------
// In-memory fallback (single process only — NOT suitable for multi-instance prod)
// ---------------------------------------------------------------------------

type Bucket = { timestamps: number[] };
const memoryBuckets = new Map<string, Bucket>();

function memoryLimit(key: string, points: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = memoryBuckets.get(key) ?? { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

  const success = bucket.timestamps.length < points;
  if (success) bucket.timestamps.push(now);
  memoryBuckets.set(key, bucket);

  // Opportunistic cleanup so a long-lived process does not leak keys.
  if (memoryBuckets.size > 5_000) {
    for (const [k, v] of memoryBuckets) {
      if (v.timestamps.every((t) => now - t >= windowMs)) memoryBuckets.delete(k);
    }
  }

  const oldest = bucket.timestamps[0] ?? now;
  return {
    success,
    limit: points,
    remaining: Math.max(0, points - bucket.timestamps.length),
    reset: oldest + windowMs,
  };
}

const WINDOW_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function durationToMs(window: Duration): number {
  const [amount, unit] = window.split(' ') as [string, keyof typeof WINDOW_MS];
  return Number(amount) * (WINDOW_MS[unit] ?? 60_000);
}

/**
 * Applies a rate limit.
 *
 * @param identifier Stable bucket key — prefer the authenticated user id,
 *                   otherwise a hashed IP (never the raw IP).
 */
export async function limit(
  identifier: string,
  points: number,
  window: Duration,
  prefix = 'global',
): Promise<RateLimitResult> {
  const limiter = getLimiter(points, window, prefix);

  if (!limiter) {
    return memoryLimit(`${prefix}:${identifier}`, points, durationToMs(window));
  }

  try {
    const result = await limiter.limit(identifier);
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (error) {
    console.error('[ratelimit] Upstash unavailable, failing open:', error);
    return {
      success: true,
      limit: points,
      remaining: points,
      reset: Date.now() + durationToMs(window),
    };
  }
}

/**
 * Named policies, so limits are defined in one place and are reviewable.
 * Tuned so a legitimate power user never notices, but scripted abuse is capped.
 */
export const POLICIES = {
  quizCreate: { points: 10, window: '1 m', prefix: 'quiz-create' },
  quizUpdate: { points: 30, window: '1 m', prefix: 'quiz-update' },
  quizDelete: { points: 10, window: '1 m', prefix: 'quiz-delete' },
  attemptStart: { points: 5, window: '1 m', prefix: 'attempt-start' },
  answerSubmit: { points: 120, window: '1 m', prefix: 'answer-submit' },
  attemptSubmit: { points: 20, window: '1 m', prefix: 'attempt-submit' },
  sessionCreate: { points: 10, window: '1 m', prefix: 'session-create' },
  sessionJoin: { points: 20, window: '1 m', prefix: 'session-join' },
  reportCreate: { points: 5, window: '1 m', prefix: 'report-create' },
  readPublic: { points: 120, window: '1 m', prefix: 'read-public' },
  adminAction: { points: 30, window: '1 m', prefix: 'admin-action' },
} as const satisfies Record<string, { points: number; window: Duration; prefix: string }>;

export type PolicyName = keyof typeof POLICIES;

export async function applyPolicy(
  policyName: PolicyName,
  identifier: string,
): Promise<RateLimitResult> {
  const policy = POLICIES[policyName];
  return limit(identifier, policy.points, policy.window, policy.prefix);
}

/**
 * Derives a privacy-preserving bucket key from request headers.
 * We never store or log the raw IP address.
 *
 * Typed structurally (not as `Headers`) so it accepts Next.js' `ReadonlyHeaders`
 * from `next/headers()` as well as a plain `Headers` in a route handler.
 */
export async function clientKeyFromHeaders(
  headers: { get(name: string): string | null },
  scope: string,
): Promise<string> {
  const forwarded = headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? headers.get('x-real-ip') ?? 'unknown';
  const userAgent = headers.get('user-agent') ?? 'unknown';
  return `${scope}:${await hashWithSecret(`${ip}|${userAgent}`)}`;
}

/**
 * HMAC-SHA256 truncated to 32 hex chars.
 * Uses APP_SECRET; falls back to a constant in development so local work runs.
 */
export async function hashWithSecret(value: string): Promise<string> {
  const secret = env.appSecret ?? 'quizly-development-secret';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Converts a failed rate-limit result into a 429 AppError with `Retry-After`.
 * Call sites stay one line: `throwIfLimited(await applyPolicy(...))`.
 */
export function throwIfLimited(result: RateLimitResult): void {
  if (result.success) return;
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  throw new AppError('RATE_LIMITED', undefined, { retryAfter });
}

