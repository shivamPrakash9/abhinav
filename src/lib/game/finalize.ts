import { after } from 'next/server';

import { prisma } from '../db';
import { env } from '../env';
import { sendResultsEmail } from '../email';
import { recordAttemptInLeaderboards } from './leaderboard';
import { summarizeAttempt } from './scoring';

/**
 * Attempt finalization — shared by the `finalizeAttempt` Server Action and the
 * `/api/cron/sweep-attempts` sweeper.
 *
 * This module deliberately does NOT use `'use server'`. Every export of a
 * `'use server'` file becomes a client-callable Server Action, so placing the
 * sweeper there would let any browser trigger a global maintenance job. Here the
 * exports are reachable only from other server code.
 *
 * IDEMPOTENT: finalizing an already-finalized attempt is a no-op, so the sweeper
 * racing a player's own submit cannot double-apply leaderboard points.
 */

export type FinalizeOutcome = {
  attemptId: string;
  alreadyFinalized: boolean;
  score: number;
  maxScore: number;
  correctCount: number;
  incorrectCount: number;
  skippedCount: number;
  accuracy: number;
  passed: boolean;
};

/**
 * A completed attempt. The reason is a CAUSE, not a status:
 *   'user'      → the player pressed Submit (status GRADED)
 *   'timeout'   → the clock expired; the client auto-submitted (status GRADED)
 *   'abandoned' → nobody was watching; the cron sweeper closed it (status EXPIRED)
 *
 * The distinction matters: a player who hit "time's up" and auto-submitted still
 * completed the quiz and belongs on the leaderboard, whereas an abandoned attempt
 * (tab closed at question 2) should not be ranked.
 */
export type FinalizeReason = 'user' | 'timeout' | 'abandoned';

export async function finalizeAttemptCore(
  attemptId: string,
  options: { reason: FinalizeReason } = { reason: 'user' },
): Promise<FinalizeOutcome> {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      quizId: true,
      userId: true,
      status: true,
      startedAt: true,
      maxScore: true,
      quiz: {
        select: {
          title: true,
          slug: true,
          passScorePercent: true,
          averageScore: true,
          attemptCount: true,
          categoryId: true,
          _count: { select: { questions: true } },
        },
      },
      answers: { select: { isCorrect: true, awardedPoints: true } },
    },
  });

  if (!attempt) {
    throw new Error(`finalizeAttemptCore: attempt ${attemptId} not found`);
  }

  const questionCount = attempt.quiz._count.questions;
  const summary = summarizeAttempt(attempt.answers, questionCount);
  const maxScore = Math.max(attempt.maxScore, questionCount);
  const passed = maxScore > 0 && summary.score >= (attempt.quiz.passScorePercent / 100) * maxScore;

  const outcome: FinalizeOutcome = {
    attemptId: attempt.id,
    alreadyFinalized: attempt.status !== 'IN_PROGRESS',
    score: summary.score,
    maxScore,
    correctCount: summary.correctCount,
    incorrectCount: summary.incorrectCount,
    skippedCount: summary.skippedCount,
    accuracy: summary.accuracy,
    passed,
  };

  // Already graded: return the stored outcome untouched. Without this guard the
  // sweeper could re-award XP for an attempt the player already submitted.
  if (outcome.alreadyFinalized) return outcome;

  const submittedAt = new Date();
  const status = options.reason === 'abandoned' ? 'EXPIRED' : 'GRADED';
  const durationMs = Math.max(0, submittedAt.getTime() - attempt.startedAt.getTime());

  await prisma.$transaction(async (tx) => {
    await tx.attempt.update({
      where: { id: attempt.id },
      data: {
        status,
        submittedAt,
        durationMs,
        score: summary.score,
        maxScore,
        correctCount: summary.correctCount,
        incorrectCount: summary.incorrectCount,
        skippedCount: summary.skippedCount,
        accuracy: summary.accuracy,
      },
    });

    // Denormalised quiz counters, written in the same transaction as their source
    // so they cannot drift. A running mean avoids a full AVG scan on every view.
    const totalAttempts = attempt.quiz.attemptCount + 1;
    const averageScore =
      status !== 'GRADED'
        ? attempt.quiz.averageScore
        : attempt.quiz.averageScore === null
          ? summary.score
          : ((attempt.quiz.averageScore * attempt.quiz.attemptCount) + summary.score) / totalAttempts;

    await tx.quiz.update({
      where: { id: attempt.quizId },
      data: { attemptCount: { increment: 1 }, averageScore },
    });
  });

  // Leaderboards count genuine completions only, and only for signed-in players.
  if (status === 'GRADED' && attempt.userId) {
    try {
      await recordAttemptInLeaderboards({
        userId: attempt.userId,
        quizId: attempt.quizId,
        categoryId: attempt.quiz.categoryId,
        score: summary.score,
        accuracy: summary.accuracy,
        durationMs,
        submittedAt,
      });
    } catch (error) {
      // A leaderboard failure must never invalidate a completed attempt.
      console.error('[finalize] leaderboard update failed:', error);
    }
  }

  // Email is scheduled AFTER the response so it adds no latency to submit.
  // `after()` is the right primitive: a bare fire-and-forget promise can be killed
  // when a serverless invocation is frozen.
  scheduleResultsEmail(attempt.id, attempt.quiz.title, attempt.quiz.slug);

  return outcome;
}

/** Queues the results email; silently skipped when the player is anonymous. */
function scheduleResultsEmail(attemptId: string, quizTitle: string, quizSlug: string): void {
  try {
    after(async () => {
      const attempt = await prisma.attempt.findUnique({
        where: { id: attemptId },
        select: {
          score: true,
          maxScore: true,
          correctCount: true,
          accuracy: true,
          user: { select: { email: true, name: true } },
          quiz: { select: { passScorePercent: true, _count: { select: { questions: true } } } },
        },
      });

      const email = attempt?.user?.email;
      // Anonymous attempts have no address on file — nothing to send.
      if (!attempt || !email) return;

      await sendResultsEmail({
        to: email,
        displayName: attempt.user?.name ?? 'there',
        quizTitle,
        quizUrl: `${env.appUrl}/quizzes/${quizSlug}`,
        score: attempt.score,
        maxScore: attempt.maxScore,
        correctCount: attempt.correctCount,
        totalQuestions: attempt.quiz._count.questions,
        accuracy: attempt.accuracy ?? 0,
        passed:
          attempt.maxScore > 0 &&
          attempt.score >= (attempt.quiz.passScorePercent / 100) * attempt.maxScore,
      });
    });
  } catch (error) {
    console.error('[finalize] could not schedule results email:', error);
  }
}

/**
 * Auto-submit sweeper.
 *
 * Recovers attempts whose player closed the tab, lost connectivity or crashed
 * mid-quiz. Without it those attempts stay IN_PROGRESS forever and their partial
 * answers never reach the leaderboards.
 *
 * Runs in bounded batches so a single invocation cannot exhaust a serverless
 * function's time budget: the cron schedule drains any backlog on the next tick.
 */
export async function sweepExpiredAttempts(
  limit = 200,
): Promise<{ finalized: number; failed: number }> {
  const expired = await prisma.attempt.findMany({
    where: { status: 'IN_PROGRESS', expiresAt: { not: null, lt: new Date() } },
    orderBy: { expiresAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  let finalized = 0;
  let failed = 0;

  for (const attempt of expired) {
    try {
      await finalizeAttemptCore(attempt.id, { reason: 'abandoned' });
      finalized += 1;
    } catch (error) {
      failed += 1;
      console.error(`[sweep] failed to finalize attempt ${attempt.id}:`, error);
    }
  }

  return { finalized, failed };
}

/**
 * Closes live rooms abandoned by their host (never pressed "end").
 * Rooms are marked CANCELLED and `endedAt` is stamped, so they stop appearing as
 * joinable and no client keeps counting down against a question that will never
 * be revealed.
 */
export async function sweepStaleLiveSessions(maxAgeHours = 6): Promise<{ cancelled: number }> {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1_000);

  const result = await prisma.liveSession.updateMany({
    where: {
      status: { in: ['LOBBY', 'QUESTION_ACTIVE', 'REVEAL', 'SCOREBOARD'] },
      createdAt: { lt: cutoff },
    },
    data: { status: 'CANCELLED', endedAt: new Date() },
  });

  return { cancelled: result.count };
}


