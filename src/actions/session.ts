'use server';

import { headers } from 'next/headers';

import { z } from 'zod';

import { getCurrentUser, requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { AppError, actionFail, actionOk, type ActionResult } from '@/lib/errors';
import { generateRoomCode, normalizeRoomCode } from '@/lib/game/codes';
import { effectiveQuestionSeconds, transitionSession, type SessionAction } from '@/lib/game/engine';
import { broadcastToHost } from '@/lib/game/realtime-server';
import { clampResponseMs, gradeAnswer, DEFAULT_SCORING_RULES } from '@/lib/game/scoring';
import { applyPolicy, clientKeyFromHeaders, throwIfLimited } from '@/lib/ratelimit';
import {
  createSessionSchema,
  joinSessionSchema,
  sessionAnswerSchema,
  sessionControlSchema,
} from '@/lib/validation/session';

/**
 * Live multiplayer Server Actions.
 *
 * Answers are submitted over HTTP (not over the realtime channel) so they are
 * graded by the same server code as solo play, in a transaction, with the same
 * anti-replay guarantees. Realtime is used only to *announce* committed state.
 */

export type CreateSessionResult = {
  sessionId: string;
  code: string;
  joinUrl: string;
  hostUrl: string;
};

export async function createLiveSession(input: unknown): Promise<ActionResult<CreateSessionResult>> {
  try {
    const user = await requireUser();
    throwIfLimited(await applyPolicy('sessionCreate', user.id));

    const parsed = createSessionSchema.safeParse(input);
    if (!parsed.success) return actionFail('VALIDATION', undefined, parsed.error.flatten());

    const quiz = await prisma.quiz.findFirst({
      where: { id: parsed.data.quizId, authorId: user.id },
      select: { id: true, _count: { select: { questions: true } } },
    });
    if (!quiz) return actionFail('NOT_FOUND', 'That quiz does not exist, or you do not own it.');
    if (quiz._count.questions === 0) {
      return actionFail('CONFLICT', 'Add at least one question before hosting a live room.');
    }

    // A 6-character code space is large, but collisions are still possible with
    // enough concurrent rooms, so retry a few times on the unique constraint
    // instead of surfacing a database error to the host.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateRoomCode();
      const existing = await prisma.liveSession.findFirst({
        where: { code, status: { in: ['LOBBY', 'QUESTION_ACTIVE', 'REVEAL', 'SCOREBOARD'] } },
        select: { id: true },
      });
      if (existing) continue;

      const session = await prisma.liveSession.create({
        data: {
          code,
          hostId: user.id,
          quizId: quiz.id,
          maxParticipants: parsed.data.maxParticipants,
          settings: parsed.data.settings,
          status: 'LOBBY',
        },
        select: { id: true, code: true },
      });

      return actionOk({
        sessionId: session.id,
        code: session.code,
        joinUrl: `${env.appUrl}/play/${session.code}`,
        hostUrl: `${env.appUrl}/host/${session.id}`,
      });
    }

    return actionFail('UNAVAILABLE', 'Could not allocate a room code. Please try again.');
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action createLiveSession]', error);
    return actionFail('INTERNAL');
  }
}

export type JoinSessionResult = {
  participantId: string;
  sessionId: string;
  code: string;
  status: string;
  displayName: string;
  quizTitle: string;
  participantCount: number;
  capacity: number;
  serverTime: string;
  /** Present only for anonymous players; the client stores it to resume after a reload. */
  guestToken?: string;
  /**
   * Realtime coordinates. The anon key is public by design (it is already shipped
   * in the client bundle); access control is enforced by never publishing
   * correctness before `reveal`, and — for hardening — by Supabase RLS on
   * `realtime.messages` coupled with private channels (see README).
   */
  realtime: {
    url: string;
    anonKey: string;
    roomChannel: string;
    presenceChannel: string;
  };
};

/**
 * Joins a live room.
 *
 * Anonymous players receive a server-generated `guestToken`; hashing it produces a
 * stable participant identity across reloads WITHOUT letting a client impersonate
 * another player (a forged token simply hashes to a different participant).
 */
export async function joinLiveSession(input: unknown): Promise<ActionResult<JoinSessionResult>> {
  try {
    const parsed = joinSessionSchema.safeParse(input);
    if (!parsed.success) return actionFail('VALIDATION', undefined, parsed.error.flatten());

    const requestHeaders = await headers();
    const rateKey = await clientKeyFromHeaders(requestHeaders, 'join');
    throwIfLimited(await applyPolicy('sessionJoin', rateKey));

    const code = normalizeRoomCode(parsed.data.code);
    const session = await prisma.liveSession.findFirst({
      where: { code },
      include: { quiz: { select: { title: true } }, _count: { select: { participants: true } } },
    });

    if (!session) return actionFail('NOT_FOUND', 'No live room with that code.');
    if (session.status === 'FINISHED' || session.status === 'CANCELLED') {
      return actionFail('CONFLICT', 'That room has already ended.');
    }
    if (session._count.participants >= session.maxParticipants) {
      return actionFail('CONFLICT', 'That room is full.');
    }

    const user = await getCurrentUser();
    if (user?.isBanned) return actionFail('FORBIDDEN', 'This account has been suspended.');

    const serverTime = new Date();

    // Identity: the account when signed in, otherwise an HMAC of the guest token.
    let guestToken: string | undefined;
    let guestId: string | null = null;
    if (!user) {
      guestToken = parsed.data.guestToken ?? generateRoomCode(10);
      guestId = await clientKeyFromHeaders({ get: () => guestToken ?? null }, 'guest');
    }

    const existing = await prisma.sessionParticipant.findFirst({
      where: user
        ? { sessionId: session.id, userId: user.id }
        : { sessionId: session.id, guestId },
      select: { id: true },
    });

    const participant = existing
      ? await prisma.sessionParticipant.update({
          where: { id: existing.id },
          data: { displayName: parsed.data.displayName, lastSeenAt: serverTime },
          select: { id: true, displayName: true },
        })
      : await prisma.sessionParticipant.create({
          data: {
            sessionId: session.id,
            userId: user?.id ?? null,
            guestId,
            displayName: parsed.data.displayName,
            lastSeenAt: serverTime,
          },
          select: { id: true, displayName: true },
        });

    const participantCount = await prisma.sessionParticipant.count({
      where: { sessionId: session.id },
    });

    // Tell the host screen someone arrived (host channel only — no room-wide spam).
    await broadcastToHost(session.code, 'participant_joined', {
      serverTime: serverTime.toISOString(),
      participantId: participant.id,
      displayName: participant.displayName,
      participantCount,
    });

    return actionOk({
      participantId: participant.id,
      sessionId: session.id,
      code: session.code,
      status: session.status,
      displayName: participant.displayName,
      quizTitle: session.quiz.title,
      participantCount,
      capacity: session.maxParticipants,
      serverTime: serverTime.toISOString(),
      guestToken,
      realtime: {
        url: env.supabase.url ?? '',
        anonKey: env.supabase.anonKey ?? '',
        roomChannel: `room:${session.code}`,
        presenceChannel: `presence:room:${session.code}`,
      },
    });
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action joinLiveSession]', error);
    return actionFail('INTERNAL');
  }
}

const sessionAnswerInputSchema = z.object({
  /** Anonymous players must present the token issued at join time. */
  guestToken: z.string().trim().min(8).max(128).optional(),
  answer: sessionAnswerSchema,
});

export type SubmitSessionAnswerResult = {
  accepted: true;
  questionId: string;
  answeredCount: number;
  participantCount: number;
  /** Correctness is withheld until `reveal`, exactly as in solo play. */
};

/**
 * Records a live answer.
 *
 * The participant is resolved from the authenticated user or the hashed guest
 * token — the client never names a participant id, so it cannot attribute an
 * answer (or a score) to somebody else.
 */
export async function submitSessionAnswer(
  sessionId: string,
  input: unknown,
): Promise<ActionResult<SubmitSessionAnswerResult>> {
  try {
    const parsed = sessionAnswerInputSchema.safeParse(input);
    if (!parsed.success) return actionFail('VALIDATION', undefined, parsed.error.flatten());

    const session = await prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        code: true,
        status: true,
        currentQuestionIndex: true,
        questionEndsAt: true,
        quiz: { select: { defaultQuestionTimeSeconds: true } },
      },
    });
    if (!session) return actionFail('NOT_FOUND', 'That room no longer exists.');
    if (session.status !== 'QUESTION_ACTIVE') {
      return actionFail('CONFLICT', 'No question is open right now.');
    }

    const user = await getCurrentUser();
    const guestId = parsed.data.guestToken
      ? await clientKeyFromHeaders({ get: () => parsed.data.guestToken ?? null }, 'guest')
      : null;

    const participant = await prisma.sessionParticipant.findFirst({
      where: user ? { sessionId, userId: user.id } : { sessionId, guestId },
      select: { id: true, score: true, streak: true, correctCount: true },
    });
    if (!participant) return actionFail('NOT_FOUND', 'Join the room before answering.');

    const now = new Date();
    if (session.questionEndsAt !== null && now > session.questionEndsAt) {
      return actionFail('CONFLICT', 'That question has closed.', { closed: true });
    }

    // Only the question the host has actually opened may be answered, which stops
    // a client from racing ahead or answering Q7 during Q1.
    const question = await prisma.question.findFirst({
      where: { quiz: { sessions: { some: { id: sessionId } } } },
      orderBy: { position: 'asc' },
      skip: Math.max(0, session.currentQuestionIndex),
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
    if (!question || question.id !== parsed.data.answer.questionId) {
      return actionFail('CONFLICT', 'That is not the current question.', { closed: true });
    }

    const existing = await prisma.sessionAnswer.findUnique({
      where: { participantId_questionId: { participantId: participant.id, questionId: question.id } },
      select: { id: true },
    });

    const participantCount = await prisma.sessionParticipant.count({ where: { sessionId } });
    const answeredCount = await prisma.sessionAnswer.count({
      where: { sessionId, questionId: question.id },
    });

    if (existing) {
      // Idempotent: a duplicate tap or a retry cannot score twice.
      return actionOk({ accepted: true, questionId: question.id, answeredCount, participantCount });
    }

    const windowMs = effectiveQuestionSeconds(question, session.quiz) * 1_000;
    const responseMs = clampResponseMs(parsed.data.answer.responseMs, windowMs);

    const graded = gradeAnswer({
      question: {
        type: question.type,
        points: question.points,
        caseSensitive: question.caseSensitive,
        acceptedAnswers: question.acceptedAnswers,
        options: question.options,
        windowMs,
      },
      selectedOptionIds: parsed.data.answer.selectedOptionIds,
      textAnswer: parsed.data.answer.textAnswer ?? null,
      responseMs,
      currentStreak: participant.streak,
      rules: DEFAULT_SCORING_RULES,
    });

    // One transaction: the answer and the running score must never disagree.
    await prisma.$transaction([
      prisma.sessionAnswer.create({
        data: {
          sessionId,
          participantId: participant.id,
          questionId: question.id,
          selectedOptionIds: parsed.data.answer.selectedOptionIds,
          textAnswer: parsed.data.answer.textAnswer ?? null,
          isCorrect: graded.isCorrect,
          awardedPoints: graded.awardedPoints,
          responseMs,
        },
      }),
      prisma.sessionParticipant.update({
        where: { id: participant.id },
        data: {
          score: { increment: graded.awardedPoints },
          streak: graded.nextStreak,
          correctCount: graded.isCorrect ? { increment: 1 } : undefined,
          lastSeenAt: now,
        },
      }),
    ]);

    // Host-only ticker ("37 / 42 answered"). Broadcasting this to the room would
    // leak how many rivals have answered and how quickly.
    await broadcastToHost(session.code, 'answer_ack', {
      serverTime: now.toISOString(),
      questionId: question.id,
      answeredCount: answeredCount + 1,
      participantCount,
    });

    return actionOk({
      accepted: true,
      questionId: question.id,
      answeredCount: answeredCount + 1,
      participantCount,
    });
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action submitSessionAnswer]', error);
    return actionFail('INTERNAL');
  }
}

export type HostControlResult = {
  action: SessionAction | 'kick';
  status: string;
  currentQuestionIndex: number;
  totalQuestions: number;
  serverTime: string;
};

/**
 * Host-only room control (start / reveal / scoreboard / next / end / kick).
 *
 * The client sends an intent; the server decides whether it is legal for the
 * room's current state. Ownership is re-verified inside `transitionSession`
 * against the freshly-loaded row, so a stolen session id is not enough.
 */
export async function hostControlSession(
  sessionId: string,
  input: unknown,
): Promise<ActionResult<HostControlResult>> {
  try {
    const user = await requireUser();
    throwIfLimited(await applyPolicy('sessionCreate', user.id));

    const parsed = sessionControlSchema.safeParse(input);
    if (!parsed.success) return actionFail('VALIDATION', undefined, parsed.error.flatten());

    if (parsed.data.action === 'kick') {
      const session = await prisma.liveSession.findFirst({
        where: { id: sessionId, hostId: user.id },
        select: { id: true, code: true },
      });
      if (!session) {
        return actionFail('NOT_FOUND', 'That room does not exist, or you are not the host.');
      }

      const removed = await prisma.sessionParticipant.deleteMany({
        where: { id: parsed.data.participantId, sessionId: session.id },
      });
      if (removed.count === 0) return actionFail('NOT_FOUND', 'That player has already left.');

      const participantCount = await prisma.sessionParticipant.count({
        where: { sessionId: session.id },
      });
      await broadcastToHost(session.code, 'participant_left', {
        serverTime: new Date().toISOString(),
        participantId: parsed.data.participantId,
        displayName: 'removed by host',
        participantCount,
      });

      const current = await prisma.liveSession.findUniqueOrThrow({
        where: { id: session.id },
        select: {
          status: true,
          currentQuestionIndex: true,
          quiz: { select: { _count: { select: { questions: true } } } },
        },
      });

      return actionOk({
        action: 'kick',
        status: current.status,
        currentQuestionIndex: current.currentQuestionIndex,
        totalQuestions: current.quiz._count.questions,
        serverTime: new Date().toISOString(),
      });
    }

    const result = await transitionSession(sessionId, user.id, parsed.data.action);
    return actionOk({
      action: parsed.data.action,
      status: result.status,
      currentQuestionIndex: result.currentQuestionIndex,
      totalQuestions: result.totalQuestions,
      serverTime: result.serverTime,
    });
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action hostControlSession]', error);
    return actionFail('INTERNAL');
  }
}



