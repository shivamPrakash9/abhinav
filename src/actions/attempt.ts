'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { AppError, actionFail, actionOk, type ActionResult } from '@/lib/errors';
import { effectiveQuestionSeconds } from '@/lib/game/engine';
import {
  assertNoAnswerLeak,
  seedFromString,
  shuffled,
  toPlayableQuestion,
  type PlayableQuestion,
} from '@/lib/game/fetch';
import {
  finalizeAttemptCore,
  type FinalizeOutcome,
  type FinalizeReason,
} from '@/lib/game/finalize';
import { clampResponseMs, DEFAULT_SCORING_RULES, gradeAnswer } from '@/lib/game/scoring';
import { applyPolicy, clientKeyFromHeaders, throwIfLimited } from '@/lib/ratelimit';
import { startAttemptSchema, submitAnswerSchema, submitAttemptSchema } from '@/lib/validation/attempt';

/**
 * Attempt lifecycle: start → answer → finalize.
 *
 * THE CENTRAL SECURITY PROPERTY OF THE PRODUCT:
 * correctness is decided here, on the server, and is never sent back to the
 * client until the attempt is graded. A client can submit an answer; it cannot
 * learn whether it was right, cannot change its score, and cannot claim a faster
 * time than the question's own window allows.
 */

export type StartAttemptResult = {
  attemptId: string;
  /** null = untimed quiz (per-question limits still apply individually). */
  expiresAt: string | null;
  serverTime: string;
  /** Question ids already answered — lets a refreshed tab resume, not restart. */
  answeredQuestionIds: string[];
  quiz: {
    title: string;
    slug: string;
    timeLimitSeconds: number | null;
    passScorePercent: number;
    totalQuestions: number;
  };
  questions: PlayableQuestion[];
};

/**
 * Resolves who is playing.
 *
 * Signed-in players are keyed by user id. Anonymous players are keyed by an HMAC
 * of ip + user-agent, so the raw IP is never persisted and one device cannot
 * create unlimited concurrent anonymous attempts.
 */
async function resolveParticipant(): Promise<{ userId: string | null; participantKey: string }> {
  const user = await getCurrentUser();
  if (user) {
    if (user.isBanned) throw new AppError('FORBIDDEN', 'This account has been suspended.');
    return { userId: user.id, participantKey: `user:${user.id}` };
  }

  const requestHeaders = await headers();
  const participantKey = await clientKeyFromHeaders(requestHeaders, 'anon');
  return { userId: null, participantKey };
}

export async function startAttempt(input: unknown): Promise<ActionResult<StartAttemptResult>> {
  try {
    const participant = await resolveParticipant();
    throwIfLimited(await applyPolicy('attemptStart', participant.participantKey));

    const parsed = startAttemptSchema.safeParse(input);
    if (!parsed.success) return actionFail('VALIDATION', undefined, parsed.error.flatten());

    const quiz = await prisma.quiz.findFirst({
      where: { slug: parsed.data.quizSlug },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        visibility: true,
        authorId: true,
        allowAnonymous: true,
        maxAttempts: true,
        timeLimitSeconds: true,
        defaultQuestionTimeSeconds: true,
        shuffleQuestions: true,
        shuffleOptions: true,
        passScorePercent: true,
        questions: {
          orderBy: { position: 'asc' },
          include: { options: { orderBy: { position: 'asc' } } },
        },
      },
    });

    // Drafts are visible to their author only (preview mode); everyone else gets
    // the same NOT_FOUND as for a non-existent slug, so draft titles do not leak.
    if (!quiz || quiz.visibility === 'PRIVATE') {
      return actionFail('NOT_FOUND', 'That quiz is not available.');
    }
    const isAuthor = participant.userId !== null && participant.userId === quiz.authorId;
    if (quiz.status !== 'PUBLISHED' && !isAuthor) {
      return actionFail('NOT_FOUND', 'That quiz is not available.');
    }
    if (!quiz.allowAnonymous && participant.userId === null) {
      return actionFail('UNAUTHENTICATED', 'Sign in to take this quiz.');
    }
    if (quiz.questions.length === 0) {
      return actionFail('CONFLICT', 'That quiz has no questions yet.');
    }

    // The attempt cap is only enforceable for identified players.
    if (quiz.maxAttempts !== null && participant.userId !== null) {
      const completed = await prisma.attempt.count({
        where: {
          quizId: quiz.id,
          userId: participant.userId,
          status: { in: ['SUBMITTED', 'GRADED'] },
        },
      });
      if (completed >= quiz.maxAttempts) {
        return actionFail('CONFLICT', `You have used all ${quiz.maxAttempts} attempts for this quiz.`);
      }
    }

    const serverTime = new Date();
    const expiresAt =
      quiz.timeLimitSeconds === null
        ? null
        : new Date(serverTime.getTime() + quiz.timeLimitSeconds * 1_000);

    // If an attempt is already IN_PROGRESS we resume it instead of creating a
    // second one — the same behaviour the partial unique index enforces at the
    // database level for two tabs racing at once.
    const existingInProgress = await prisma.attempt.findFirst({
      where: {
        quizId: quiz.id,
        participantKey: participant.participantKey,
        status: 'IN_PROGRESS',
      },
      include: { answers: { select: { questionId: true } } },
    });

    const attempt =
      existingInProgress ??
      (await prisma.attempt.create({
        data: {
          quizId: quiz.id,
          userId: participant.userId,
          participantKey: participant.participantKey,
          mode: 'SOLO',
          status: 'IN_PROGRESS',
          expiresAt,
          maxScore: quiz.questions.reduce((total, question) => total + question.points, 0),
        },
        include: { answers: { select: { questionId: true } } },
      }));

    // Deterministic per-attempt shuffle: stable across refreshes, different
    // between players, and it never changes which option is correct.
    const seed = seedFromString(attempt.id);
    const ordered = quiz.shuffleQuestions ? shuffled(quiz.questions, seed) : quiz.questions;
    const questions = ordered.map((question) => {
      const playable = toPlayableQuestion(question);
      if (!quiz.shuffleOptions) return playable;
      return {
        ...playable,
        options: shuffled(playable.options, seedFromString(`${attempt.id}:${question.id}`)),
      };
    });

    // Development tripwire: this payload must never contain correctness.
    assertNoAnswerLeak({ questions }, 'startAttempt');

    return actionOk({
      attemptId: attempt.id,
      expiresAt: attempt.expiresAt?.toISOString() ?? null,
      serverTime: serverTime.toISOString(),
      answeredQuestionIds: attempt.answers.map((answer) => answer.questionId),
      quiz: {
        title: quiz.title,
        slug: quiz.slug,
        timeLimitSeconds: quiz.timeLimitSeconds,
        passScorePercent: quiz.passScorePercent,
        totalQuestions: quiz.questions.length,
      },
      questions,
    });
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action startAttempt]', error);
    return actionFail('INTERNAL');
  }
}

export type SubmitAnswerResult = {
  accepted: true;
  questionId: string;
  answeredCount: number;
  totalQuestions: number;
  /** null when the quiz is untimed. */
  remainingMs: number | null;
  /** NOTE: correctness is deliberately absent — see the module docblock. */
};

/**
 * Records one answer. Grading happens HERE; the result is withheld.
 *
 * Why withhold correctness even for solo play? Because a client that learns
 * "correct/incorrect" immediately can binary-search a short-answer question, or
 * probe option combinations, while the clock is still running. Correctness is
 * returned by the results screen once the attempt is graded.
 *
 * Idempotent on (attemptId, questionId): a retried request cannot change an
 * answer that was already recorded, which also blocks "re-submit until correct".
 */
export async function submitAnswer(
  attemptId: string,
  input: unknown,
): Promise<ActionResult<SubmitAnswerResult>> {
  try {
    const participant = await resolveParticipant();
    throwIfLimited(await applyPolicy('answerSubmit', participant.participantKey));

    const parsed = submitAnswerSchema.safeParse(input);
    if (!parsed.success) return actionFail('VALIDATION', undefined, parsed.error.flatten());

    const attempt = await prisma.attempt.findUnique({
      where: { id: attemptId },
      select: {
        id: true,
        quizId: true,
        participantKey: true,
        status: true,
        expiresAt: true,
        maxScore: true,
        quiz: {
          select: {
            title: true,
            slug: true,
            defaultQuestionTimeSeconds: true,
            _count: { select: { questions: true } },
          },
        },
      },
    });

    if (!attempt) return actionFail('NOT_FOUND', 'That attempt no longer exists.');
    // Ownership: a player may only answer their own attempt.
    if (attempt.participantKey !== participant.participantKey) {
      return actionFail('FORBIDDEN', 'That attempt belongs to someone else.');
    }
    if (attempt.status !== 'IN_PROGRESS') {
      return actionFail('CONFLICT', 'This attempt has already been submitted.');
    }

    const now = new Date();
    if (attempt.expiresAt !== null && now > attempt.expiresAt) {
      // The whole-quiz clock has run out. Finalize (never discard their work) and
      // tell the client to navigate to the results screen.
      await finalizeAttemptCore(attemptId, { reason: 'timeout' });
      return actionFail('CONFLICT', 'Time is up for this quiz.', { expired: true });
    }

    const question = await prisma.question.findFirst({
      where: { id: parsed.data.questionId, quizId: attempt.quizId },
      select: {
        id: true,
        type: true,
        points: true,
        caseSensitive: true,
        acceptedAnswers: true,
        timeLimitSeconds: true,
        options: { select: { id: true, isCorrect: true } },
      },
    });
    if (!question) return actionFail('NOT_FOUND', 'That question is not part of this quiz.');

    const existing = await prisma.answer.findUnique({
      where: { attemptId_questionId: { attemptId, questionId: question.id } },
      select: { id: true },
    });

    const answeredCount = await prisma.answer.count({ where: { attemptId } });

    if (existing) {
      // Already answered: return the same acknowledgement without re-grading.
      return actionOk({
        accepted: true,
        questionId: question.id,
        answeredCount,
        totalQuestions: attempt.quiz._count.questions,
        remainingMs: attempt.expiresAt === null ? null : Math.max(0, attempt.expiresAt.getTime() - now.getTime()),
      });
    }

    const windowSeconds = effectiveQuestionSeconds(question, attempt.quiz);
    const windowMs = windowSeconds * 1_000;
    const responseMs = clampResponseMs(parsed.data.timeSpentMs, windowMs);

    // Streak must be derived from stored answers, never from a client claim.
    const previousAnswers = await prisma.answer.findMany({
      where: { attemptId },
      orderBy: { answeredAt: 'asc' },
      select: { isCorrect: true },
    });
    let currentStreak = 0;
    for (let i = previousAnswers.length - 1; i >= 0; i -= 1) {
      if (previousAnswers[i]?.isCorrect === true) currentStreak += 1;
      else break;
    }

    const graded = gradeAnswer({
      question: {
        type: question.type,
        points: question.points,
        caseSensitive: question.caseSensitive,
        acceptedAnswers: question.acceptedAnswers,
        options: question.options,
        windowMs,
      },
      selectedOptionIds: parsed.data.selectedOptionIds,
      textAnswer: parsed.data.textAnswer ?? null,
      responseMs,
      currentStreak,
      rules: DEFAULT_SCORING_RULES,
    });

    await prisma.answer.create({
      data: {
        attemptId,
        questionId: question.id,
        selectedOptionIds: parsed.data.selectedOptionIds,
        textAnswer: parsed.data.textAnswer ?? null,
        isCorrect: graded.isCorrect,
        awardedPoints: graded.awardedPoints,
        timeSpentMs: responseMs,
      },
    });

    return actionOk({
      accepted: true,
      questionId: question.id,
      answeredCount: answeredCount + 1,
      totalQuestions: attempt.quiz._count.questions,
      remainingMs:
        attempt.expiresAt === null ? null : Math.max(0, attempt.expiresAt.getTime() - now.getTime()),
    });
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action submitAnswer]', error);
    return actionFail('INTERNAL');
  }
}

/**
 * Finalizes an attempt: computes the summary, awards leaderboard points and
 * queues the results email.
 *
 * Authorization and rate limiting live here; the scoring work is delegated to
 * `finalizeAttemptCore` so the cron sweeper and this action can never diverge.
 */
export async function finalizeAttempt(
  attemptId: string,
  input: unknown = { reason: 'user' },
): Promise<ActionResult<FinalizeOutcome>> {
  try {
    const participant = await resolveParticipant();
    throwIfLimited(await applyPolicy('attemptSubmit', participant.participantKey));

    const ownership = await prisma.attempt.findUnique({
      where: { id: attemptId },
      select: { participantKey: true, quiz: { select: { slug: true } } },
    });
    if (!ownership) return actionFail('NOT_FOUND', 'That attempt no longer exists.');
    if (ownership.participantKey !== participant.participantKey) {
      return actionFail('FORBIDDEN', 'That attempt belongs to someone else.');
    }

    const parsed = submitAttemptSchema.safeParse(input);
    const reason: FinalizeReason = parsed.success ? parsed.data.reason : 'user';

    const outcome = await finalizeAttemptCore(attemptId, { reason });

    revalidatePath(`/attempts/${attemptId}/results`);
    revalidatePath('/dashboard');
    revalidatePath('/leaderboards');
    if (ownership.quiz?.slug) revalidatePath(`/quizzes/${ownership.quiz.slug}`);

    return actionOk(outcome);
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action finalizeAttempt]', error);
    return actionFail('INTERNAL');
  }
}



