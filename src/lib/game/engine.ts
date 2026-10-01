import type { Option, Question } from '@prisma/client';

import { AppError } from '../errors';
import { prisma } from '../db';
import { toPlayableQuestion, toRevealedQuestion } from './fetch';
import { broadcastToRoom } from './realtime-server';

/**
 * Live-session state machine.
 *
 * ALL transitions are server-driven, executed by the host through authenticated
 * HTTP calls. The broadcast that follows notifies clients of a change that has
 * ALREADY been committed to Postgres — never the source of truth. Ordering
 * matters: reversed, a rolled-back transaction could leave every player looking
 * at a question that does not exist.
 *
 * Legal transitions (enforced below, not merely documented):
 *
 *   LOBBY             --start-->      QUESTION_ACTIVE
 *   QUESTION_ACTIVE   --reveal-->     REVEAL
 *   REVEAL            --scoreboard--> SCOREBOARD
 *   REVEAL|SCOREBOARD --next-->       QUESTION_ACTIVE | FINISHED
 *   any open state    --end-->        FINISHED
 */

export type SessionAction = 'start' | 'reveal' | 'scoreboard' | 'next' | 'end';

export type TransitionResult = {
  sessionId: string;
  code: string;
  status: string;
  currentQuestionIndex: number;
  totalQuestions: number;
  /** Absolute instants, so clients count down without trusting their own clock. */
  questionEndsAt: string | null;
  serverTime: string;
};

type SessionQuestion = Question & { options: Option[] };

/** Per-question window: question override → quiz default. */
export function effectiveQuestionSeconds(
  question: Pick<Question, 'timeLimitSeconds'>,
  quiz: { defaultQuestionTimeSeconds: number },
): number {
  return question.timeLimitSeconds ?? quiz.defaultQuestionTimeSeconds;
}

async function loadSessionForHost(sessionId: string, hostId: string) {
  const session = await prisma.liveSession.findUnique({
    where: { id: sessionId },
    include: {
      quiz: {
        include: {
          questions: {
            orderBy: { position: 'asc' },
            include: { options: { orderBy: { position: 'asc' } } },
          },
        },
      },
      participants: true,
    },
  });

  if (!session) throw new AppError('NOT_FOUND', 'That live room does not exist.');
  // Ownership is verified against the row we just loaded, so a host can never act
  // on someone else's room — even with a valid session id.
  if (session.hostId !== hostId) {
    throw new AppError('FORBIDDEN', 'Only the host can control this room.');
  }

  return session;
}

function requireStatus(current: string, allowed: readonly string[], action: SessionAction): void {
  if (!allowed.includes(current)) {
    throw new AppError(
      'CONFLICT',
      `Cannot "${action}" while the room is ${current}. Allowed from: ${allowed.join(', ')}.`,
    );
  }
}

/**
 * Applies one transition and broadcasts the resulting state.
 * Returns the authoritative state so the caller can respond with it directly
 * rather than depending on the broadcast arriving.
 */
export async function transitionSession(
  sessionId: string,
  hostId: string,
  action: SessionAction,
): Promise<TransitionResult> {
  const session = await loadSessionForHost(sessionId, hostId);
  const questions = session.quiz.questions;
  const serverTime = new Date();

  if (questions.length === 0) {
    throw new AppError('CONFLICT', 'This quiz has no questions yet. Add at least one before hosting.');
  }

  let index = session.currentQuestionIndex;
  let status: string = session.status;
  let questionEndsAt: Date | null = session.questionEndsAt;

  switch (action) {
    case 'start': {
      requireStatus(session.status, ['LOBBY'], action);
      index = 0;
      status = 'QUESTION_ACTIVE';
      const question = questions[0] as SessionQuestion;
      const seconds = effectiveQuestionSeconds(question, session.quiz);
      questionEndsAt = new Date(serverTime.getTime() + seconds * 1_000);

      await prisma.liveSession.update({
        where: { id: session.id },
        data: {
          status: 'QUESTION_ACTIVE',
          currentQuestionIndex: index,
          questionStartedAt: serverTime,
          questionEndsAt,
          startedAt: session.startedAt ?? serverTime,
        },
      });

      // The first question is sent as `question_started` so there is exactly ONE
      // payload shape a client needs to handle per question.
      const playable = toPlayableQuestion(question);
      await broadcastToRoom(session.code, 'question_started', {
        serverTime: serverTime.toISOString(),
        index,
        questionNumber: 1,
        totalQuestions: questions.length,
        questionId: playable.id,
        type: playable.type,
        prompt: playable.prompt,
        imageUrl: playable.imageUrl,
        points: playable.points,
        options: playable.options.map((option) => ({ id: option.id, label: option.label })),
        maxAnswerLength: playable.maxAnswerLength,
        endsAt: questionEndsAt.toISOString(),
      });
      break;
    }

    case 'reveal': {
      requireStatus(session.status, ['QUESTION_ACTIVE'], action);
      status = 'REVEAL';
      questionEndsAt = null;

      await prisma.liveSession.update({
        where: { id: session.id },
        data: { status: 'REVEAL', questionEndsAt: null },
      });

      const question = questions[index] as SessionQuestion;
      // Only NOW may correctness reach a client.
      const revealed = toRevealedQuestion(question);
      const histogram = await answerHistogram(session.id, question.id, question.options);

      await broadcastToRoom(session.code, 'reveal', {
        serverTime: serverTime.toISOString(),
        questionId: question.id,
        correctOptionIds: revealed.correctOptionIds,
        acceptedAnswers: revealed.acceptedAnswers,
        explanation: revealed.explanation,
        histogram,
      });
      break;
    }

    case 'scoreboard': {
      requireStatus(session.status, ['REVEAL', 'QUESTION_ACTIVE'], action);
      status = 'SCOREBOARD';

      await prisma.liveSession.update({ where: { id: session.id }, data: { status: 'SCOREBOARD' } });

      const questionId = (questions[index] as SessionQuestion).id;
      const entries = await buildScoreboard(session.id, questionId);
      await broadcastToRoom(session.code, 'scoreboard', {
        serverTime: serverTime.toISOString(),
        entries,
        participantCount: session.participants.length,
      });
      break;
    }

    case 'next': {
      requireStatus(session.status, ['REVEAL', 'SCOREBOARD', 'QUESTION_ACTIVE'], action);
      index += 1;

      // Past the final question the session is over. `finishSession` returns
      // early, so no partial state is broadcast for a non-existent question.
      if (index >= questions.length) {
        return finishSession(session.id, session.code, questions.length);
      }

      status = 'QUESTION_ACTIVE';
      const question = questions[index] as SessionQuestion;
      const seconds = effectiveQuestionSeconds(question, session.quiz);
      questionEndsAt = new Date(serverTime.getTime() + seconds * 1_000);

      await prisma.liveSession.update({
        where: { id: session.id },
        data: {
          status: 'QUESTION_ACTIVE',
          currentQuestionIndex: index,
          questionStartedAt: serverTime,
          questionEndsAt,
        },
      });

      const playable = toPlayableQuestion(question);
      await broadcastToRoom(session.code, 'question_started', {
        serverTime: serverTime.toISOString(),
        index,
        questionNumber: index + 1,
        totalQuestions: questions.length,
        questionId: playable.id,
        type: playable.type,
        prompt: playable.prompt,
        imageUrl: playable.imageUrl,
        points: playable.points,
        options: playable.options.map((option) => ({ id: option.id, label: option.label })),
        maxAnswerLength: playable.maxAnswerLength,
        endsAt: questionEndsAt.toISOString(),
      });
      break;
    }

    case 'end': {
      return finishSession(session.id, session.code, questions.length);
    }

    /* helpers are defined below */

  }

  return {
    sessionId: session.id,
    code: session.code,
    status,
    currentQuestionIndex: index,
    totalQuestions: questions.length,
    questionEndsAt: questionEndsAt?.toISOString() ?? null,
    serverTime: serverTime.toISOString(),
  };
}

/**
 * How the room voted on an option-based question. Powers the reveal screen, and
 * in aggregate later becomes question-quality analytics ("78% picked the same
 * wrong answer" — a sign the question is ambiguous).
 */
async function answerHistogram(
  sessionId: string,
  questionId: string,
  options: readonly Option[],
): Promise<{ optionId: string; count: number }[]> {
  const rows = await prisma.sessionAnswer.findMany({
    where: { sessionId, questionId },
    select: { selectedOptionIds: true },
  });

  return options.map((option) => ({
    optionId: option.id,
    count: rows.filter((row) => row.selectedOptionIds.includes(option.id)).length,
  }));
}

/**
 * Top-20 standings plus the points each player gained on the current question,
 * which is what makes a scoreboard feel alive ("+180 · streak 4").
 * Only the top 20 is broadcast; a player's own rank is returned by the answer
 * endpoint so a 200-player room never fan-outs 200 rows.
 */
async function buildScoreboard(sessionId: string, currentQuestionId: string) {
  const participants = await prisma.sessionParticipant.findMany({
    where: { sessionId },
    orderBy: [{ score: 'desc' }, { joinedAt: 'asc' }],
    take: 20,
    select: { id: true, displayName: true, score: true, streak: true },
  });

  const deltas = await prisma.sessionAnswer.groupBy({
    by: ['participantId'],
    where: { sessionId, questionId: currentQuestionId },
    _sum: { awardedPoints: true },
  });
  const deltaByParticipant = new Map(
    deltas.map((row) => [row.participantId, row._sum.awardedPoints ?? 0]),
  );

  return participants.map((participant, position) => ({
    participantId: participant.id,
    displayName: participant.displayName,
    score: participant.score,
    delta: deltaByParticipant.get(participant.id) ?? 0,
    rank: position + 1,
    streak: participant.streak,
  }));
}

/**
 * Ends the session: persists the final standings, broadcasts them, and feeds
 * signed-in players' results into the per-quiz leaderboard as GRADED attempts.
 *
 * The attempt mirroring is isolated in its own try/catch: a failure writing
 * leaderboard rows must never stop players from seeing their final scores.
 */
async function finishSession(
  sessionId: string,
  roomCode: string,
  totalQuestions: number,
): Promise<TransitionResult> {
  const serverTime = new Date();

  const session = await prisma.liveSession.update({
    where: { id: sessionId },
    data: { status: 'FINISHED', endedAt: serverTime, questionEndsAt: null },
    include: { participants: { orderBy: [{ score: 'desc' }, { joinedAt: 'asc' }] } },
  });

  const finalScoreboard = session.participants.map((participant, position) => ({
    participantId: participant.id,
    displayName: participant.displayName,
    score: participant.score,
    delta: 0,
    rank: position + 1,
    streak: participant.streak,
  }));

  await broadcastToRoom(roomCode, 'end', {
    serverTime: serverTime.toISOString(),
    endedAt: serverTime.toISOString(),
    finalScoreboard: finalScoreboard.slice(0, 20),
    totalQuestions,
  });

  try {
    await mirrorLiveResultsToAttempts(session.id, session.quizId);
  } catch (error) {
    console.error('[live] failed to mirror results into attempts:', error);
  }

  return {
    sessionId: session.id,
    code: roomCode,
    status: 'FINISHED',
    currentQuestionIndex: session.currentQuestionIndex,
    totalQuestions,
    questionEndsAt: null,
    serverTime: serverTime.toISOString(),
  };
}

/**
 * Creates one GRADED Attempt per signed-in participant so live games feed the
 * same per-quiz leaderboards and analytics as solo attempts.
 *
 * `sourceKey` is the idempotency key (`live:{sessionId}:{participantId}`), so the
 * UNIQUE constraint makes this safe to retry — `end` twice cannot double-count.
 * `participantKey` is the player identity and is intentionally NOT unique, since
 * a player may hold several attempts for the same quiz.
 */
async function mirrorLiveResultsToAttempts(sessionId: string, quizId: string): Promise<void> {
  const participants = await prisma.sessionParticipant.findMany({
    where: { sessionId, userId: { not: null } },
    select: { id: true, userId: true, score: true, correctCount: true, joinedAt: true },
  });
  if (participants.length === 0) return;

  const totalQuestions = await prisma.question.count({ where: { quizId } });

  for (const participant of participants) {
    if (!participant.userId) continue;
    const sourceKey = `live:${sessionId}:${participant.id}`;
    const incorrectCount = Math.max(0, totalQuestions - participant.correctCount);

    await prisma.attempt.upsert({
      where: { sourceKey },
      create: {
        quizId,
        userId: participant.userId,
        participantKey: `user:${participant.userId}`,
        sourceKey,
        mode: 'LIVE',
        status: 'GRADED',
        startedAt: participant.joinedAt,
        submittedAt: new Date(),
        score: participant.score,
        maxScore: totalQuestions,
        correctCount: participant.correctCount,
        incorrectCount,
        accuracy: totalQuestions === 0 ? 0 : participant.correctCount / totalQuestions,
      },
      update: {
        score: participant.score,
        correctCount: participant.correctCount,
        status: 'GRADED',
        submittedAt: new Date(),
      },
    });
  }
}




