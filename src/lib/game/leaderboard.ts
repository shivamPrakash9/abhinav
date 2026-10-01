import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../db';

/**
 * Leaderboards.
 *
 * THREE SCOPES, TWO STRATEGIES — chosen per access pattern rather than uniformly:
 *
 *   QUIZ     → computed on read from `Attempt` (GRADED). The composite index
 *              (quizId, score DESC, durationMs ASC) makes a top-50 query an
 *              index-only scan, so materialising it would be pure write
 *              amplification for a board that is cheap to derive.
 *
 *   GLOBAL   → materialised in `LeaderboardEntry`, because an all-time board
 *   CATEGORY   aggregates every attempt ever made and cannot be derived cheaply.
 *
 * Ranks are computed AT READ TIME with a SQL window function. Storing `rank`
 * would require rewriting every row of the board on each score change (an O(n)
 * write per attempt) and would be permanently stale under concurrency.
 */

export const LEADERBOARD_SCOPES = ['GLOBAL', 'CATEGORY', 'QUIZ'] as const;
export const LEADERBOARD_PERIODS = ['ALL_TIME', 'MONTHLY', 'WEEKLY'] as const;

export const leaderboardQuerySchema = z.object({
  scope: z.enum(LEADERBOARD_SCOPES).default('GLOBAL'),
  period: z.enum(LEADERBOARD_PERIODS).default('ALL_TIME'),
  categoryId: z.string().trim().min(1).max(64).optional(),
  quizId: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

export type LeaderboardRow = {
  rank: number;
  userId: string;
  displayName: string;
  imageUrl: string | null;
  score: number;
  accuracy: number;
  attemptCount: number;
  /** Only populated for QUIZ boards. */
  bestTimeMs: number | null;
  isCurrentUser: boolean;
};

/** Fixed epoch for ALL_TIME so the upsert key is stable (never "null"). */
const ALL_TIME_START = new Date('2020-01-01T00:00:00.000Z');

/** Monday 00:00 UTC of the current ISO week. */
export function startOfIsoWeek(now = new Date()): Date {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay: 0 = Sunday. ISO weeks start on Monday.
  const day = date.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - diff);
  return date;
}

/** First day of the current month, 00:00 UTC. */
export function startOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function periodStartFor(period: (typeof LEADERBOARD_PERIODS)[number], now = new Date()): Date {
  switch (period) {
    case 'WEEKLY':
      return startOfIsoWeek(now);
    case 'MONTHLY':
      return startOfMonth(now);
    case 'ALL_TIME':
    default:
      return ALL_TIME_START;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type RawRow = {
  rank: bigint | number;
  userId: string;
  displayName: string | null;
  imageUrl: string | null;
  score: bigint | number | null;
  accuracy: number | null;
  attemptCount: bigint | number | null;
  bestTimeMs: number | null;
};

function normaliseRow(row: RawRow, currentUserId: string | null): LeaderboardRow {
  return {
    // BigInt cannot be JSON-serialised, so every numeric aggregate is coerced.
    rank: Number(row.rank),
    userId: row.userId,
    displayName: row.displayName ?? 'Anonymous',
    imageUrl: row.imageUrl,
    score: Number(row.score ?? 0),
    accuracy: Number(row.accuracy ?? 0),
    attemptCount: Number(row.attemptCount ?? 0),
    bestTimeMs: row.bestTimeMs === null ? null : Number(row.bestTimeMs),
    isCurrentUser: currentUserId !== null && row.userId === currentUserId,
  };
}

/**
 * Per-quiz board, derived from attempts.
 *
 * A player's board entry is their BEST single attempt (highest score, then
 * fastest), which is fairer than a running total — otherwise whoever plays the
 * quiz 40 times always wins.
 * DISTINCT ON is the cheapest way to express "best attempt per user" in Postgres
 * and it matches the ranking index exactly.
 */
export async function getQuizLeaderboard(
  quizId: string,
  limit: number,
  currentUserId: string | null = null,
): Promise<LeaderboardRow[]> {
  const rows = await prisma.$queryRaw<RawRow[]>`
    WITH best AS (
      SELECT DISTINCT ON (a."userId")
             a."userId",
             a.score,
             a.accuracy,
             a."durationMs",
             a."submittedAt"
        FROM "Attempt" a
       WHERE a."quizId" = ${quizId}
         AND a.status = 'GRADED'
         AND a."userId" IS NOT NULL
       ORDER BY a."userId", a.score DESC, a."durationMs" ASC NULLS LAST
    )
    SELECT RANK() OVER (ORDER BY b.score DESC, b."durationMs" ASC NULLS LAST) AS rank,
           b."userId"        AS "userId",
           u.name            AS "displayName",
           u.image           AS "imageUrl",
           b.score           AS score,
           b.accuracy        AS accuracy,
           1                 AS "attemptCount",
           b."durationMs"    AS "bestTimeMs"
      FROM best b
      JOIN "User" u ON u.id = b."userId"
     WHERE u."isBanned" = false
     ORDER BY b.score DESC, b."durationMs" ASC NULLS LAST
     LIMIT ${limit}
  `;

  return rows.map((row) => normaliseRow(row, currentUserId));
}

/**
 * GLOBAL / CATEGORY board from the materialised `LeaderboardEntry` table.
 * Ranking happens in the window function, so no stored rank can drift.
 */
export async function getAggregateLeaderboard(
  options: {
    scope: 'GLOBAL' | 'CATEGORY';
    period: (typeof LEADERBOARD_PERIODS)[number];
    categoryId?: string;
    limit: number;
    currentUserId?: string | null;
  },
): Promise<LeaderboardRow[]> {
  const periodStart = periodStartFor(options.period);
  // GLOBAL rows are stored with categoryId = '' — never NULL, because Postgres
  // treats NULLs as distinct in UNIQUE indexes which would break upserts.
  const categoryId = options.scope === 'CATEGORY' ? (options.categoryId ?? '') : '';

  const rows = await prisma.$queryRaw<RawRow[]>`
    WITH totals AS (
      SELECT l."userId",
             SUM(l.score)        AS score,
             AVG(l.accuracy)     AS accuracy,
             SUM(l."attemptCount") AS "attemptCount",
             MIN(l."bestTimeMs") AS "bestTimeMs"
        FROM "LeaderboardEntry" l
       WHERE l.scope = ${options.scope}::"LeaderboardScope"
         AND l.period = ${options.period}::"LeaderboardPeriod"
         AND l."periodStart" = ${periodStart}
         AND l."categoryId" = ${categoryId}
       GROUP BY l."userId"
    )
    SELECT RANK() OVER (ORDER BY t.score DESC) AS rank,
           t."userId"      AS "userId",
           u.name          AS "displayName",
           u.image         AS "imageUrl",
           t.score         AS score,
           COALESCE(t.accuracy, 0) AS accuracy,
           t."attemptCount" AS "attemptCount",
           t."bestTimeMs"  AS "bestTimeMs"
      FROM totals t
      JOIN "User" u ON u.id = t."userId"
     WHERE u."isBanned" = false
     ORDER BY t.score DESC
     LIMIT ${options.limit}
  `;

  return rows.map((row) => normaliseRow(row, options.currentUserId ?? null));
}

/** Dispatch used by GET /api/v1/leaderboards. */
export async function getLeaderboard(
  query: LeaderboardQuery,
  currentUserId: string | null = null,
): Promise<LeaderboardRow[]> {
  if (query.scope === 'QUIZ') {
    if (!query.quizId) return [];
    return getQuizLeaderboard(query.quizId, query.limit, currentUserId);
  }
  return getAggregateLeaderboard({
    scope: query.scope,
    period: query.period,
    categoryId: query.categoryId,
    limit: query.limit,
    currentUserId,
  });
}

/** A user's own position, so the UI can show "You are #412" outside the top N. */
export async function getUserRank(
  userId: string,
  period: (typeof LEADERBOARD_PERIODS)[number] = 'ALL_TIME',
): Promise<{ rank: number; score: number } | null> {
  const periodStart = periodStartFor(period);
  const rows = await prisma.$queryRaw<{ rank: bigint | number; score: bigint | number | null }[]>`
    WITH totals AS (
      SELECT l."userId", SUM(l.score) AS score
        FROM "LeaderboardEntry" l
       WHERE l.scope = 'GLOBAL'
         AND l.period = ${period}::"LeaderboardPeriod"
         AND l."periodStart" = ${periodStart}
         AND l."categoryId" = ''
       GROUP BY l."userId"
    )
    SELECT RANK() OVER (ORDER BY t.score DESC) AS rank, t.score
      FROM totals t
     WHERE t."userId" = ${userId}
  `;

  const row = rows[0];
  return row ? { rank: Number(row.rank), score: Number(row.score ?? 0) } : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Records a finished attempt on every applicable board.
 *
 * METRIC CHOICE — a deliberate, uniform decision:
 * every scope accumulates only the *improvement over the player's previous best*
 * for that quiz ("xpDelta"), and `attemptCount` increments on every attempt.
 *
 * Consequences, both of them desirable:
 *   • Grinding an easy quiz 50 times cannot buy a leaderboard position.
 *   • `User.xp` is exactly the sum of a player's GLOBAL/ALL_TIME entries, so the
 *     denormalised column and the board can never disagree (a verifiable
 *     invariant, asserted in leaderboard tests).
 *
 * Per-quiz boards are computed from `Attempt` with the same best-attempt
 * semantics, so all three scopes agree on what "better" means.
 */
export async function recordAttemptInLeaderboards(params: {
  userId: string;
  quizId: string;
  categoryId: string | null;
  score: number;
  accuracy: number;
  durationMs: number | null;
  submittedAt?: Date;
}): Promise<{ xpDelta: number }> {
  const submittedAt = params.submittedAt ?? new Date();

  const previousBest = await prisma.attempt.findFirst({
    where: { userId: params.userId, quizId: params.quizId, status: 'GRADED' },
    orderBy: { score: 'desc' },
    select: { score: true },
  });

  const previousBestScore = previousBest?.score ?? 0;
  const xpDelta = Math.max(0, params.score - previousBestScore);

  const scopes: { scope: 'GLOBAL' | 'CATEGORY'; categoryId: string }[] = [
    { scope: 'GLOBAL', categoryId: '' },
  ];
  if (params.categoryId) {
    scopes.push({ scope: 'CATEGORY', categoryId: params.categoryId });
  }

  const periods = ['ALL_TIME', 'MONTHLY', 'WEEKLY'] as const;

  await prisma.$transaction(async (tx) => {
    for (const { scope, categoryId } of scopes) {
      for (const period of periods) {
        const periodStart = periodStartFor(period, submittedAt);
        const key = {
          scope,
          period,
          periodStart,
          categoryId,
          quizId: '',
          userId: params.userId,
        };

        const existing = await tx.leaderboardEntry.findUnique({
          where: {
            scope_period_periodStart_categoryId_quizId_userId: key,
          },
          select: { attemptCount: true, accuracy: true },
        });

        const totalAttempts = (existing?.attemptCount ?? 0) + 1;
        // Rolling mean: (oldMean * oldCount + newValue) / newCount.
        const accuracy =
          existing === null
            ? params.accuracy
            : ((existing.accuracy * existing.attemptCount) + params.accuracy) / totalAttempts;

        await tx.leaderboardEntry.upsert({
          where: { scope_period_periodStart_categoryId_quizId_userId: key },
          create: {
            ...key,
            score: xpDelta,
            attemptCount: 1,
            accuracy: params.accuracy,
            bestTimeMs: params.durationMs,
          },
          update: {
            score: { increment: xpDelta },
            attemptCount: { increment: 1 },
            accuracy,
            // Keep the fastest time ever recorded on this board.
            bestTimeMs:
              params.durationMs === null
                ? undefined
                : { set: params.durationMs },
          },
        });
      }
    }

    if (xpDelta > 0) {
      await tx.user.update({
        where: { id: params.userId },
        data: { xp: { increment: xpDelta } },
      });
    }
  });

  return { xpDelta };
}

/**
 * Rebuilds the GLOBAL/ALL_TIME board from scratch using the same personal-best
 * rule. Intended for operations: run after a scoring bug fix, a data import, or
 * a manual XP correction. Safe to run repeatedly.
 */
export async function rebuildGlobalLeaderboard(): Promise<{ entries: number }> {
  const rows = await prisma.$queryRaw<
    { userId: string; score: bigint | number; attempts: bigint | number; accuracy: number | null; bestTimeMs: number | null }[]
  >`
    WITH per_quiz_best AS (
      SELECT a."userId",
             a."quizId",
             MAX(a.score)              AS best_score,
             COUNT(*)                  AS attempts,
             AVG(a.accuracy)           AS accuracy,
             MIN(a."durationMs")       AS best_time
        FROM "Attempt" a
       WHERE a.status = 'GRADED'
         AND a."userId" IS NOT NULL
       GROUP BY a."userId", a."quizId"
    )
    SELECT "userId"                                   AS "userId",
           SUM(best_score)                            AS score,
           SUM(attempts)                              AS attempts,
           AVG(accuracy)                              AS accuracy,
           MIN(best_time)                             AS "bestTimeMs"
      FROM per_quiz_best
     GROUP BY "userId"
  `;

  const periodStart = periodStartFor('ALL_TIME');

  await prisma.$transaction(async (tx) => {
    await tx.leaderboardEntry.deleteMany({
      where: { scope: 'GLOBAL', period: 'ALL_TIME', periodStart, categoryId: '' },
    });

    if (rows.length > 0) {
      await tx.leaderboardEntry.createMany({
        data: rows.map((row) => ({
          scope: 'GLOBAL' as const,
          period: 'ALL_TIME' as const,
          periodStart,
          categoryId: '',
          quizId: '',
          userId: row.userId,
          score: Number(row.score),
          attemptCount: Number(row.attempts),
          accuracy: Number(row.accuracy ?? 0),
          bestTimeMs: row.bestTimeMs === null ? null : Number(row.bestTimeMs),
        })),
      });

      // Keep the denormalised column in lock-step with the board.
      for (const row of rows) {
        await tx.user.update({
          where: { id: row.userId },
          data: { xp: Number(row.score) },
        });
      }
    }
  });

  return { entries: rows.length };
}


