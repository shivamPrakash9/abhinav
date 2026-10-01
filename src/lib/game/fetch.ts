import type { Difficulty, QuestionType } from '@prisma/client';

/**
 * Data-transfer objects for questions and quizzes.
 *
 * SECURITY: this module is the ONLY sanctioned way to send question data to a
 * client. `Option.isCorrect` must never appear in a payload before the question
 * is revealed — a naive `include: { options: true }` leaks every answer to
 * `view-source` (and to anyone with DevTools open during a live quiz).
 *
 * `assertNoAnswerLeak()` is a development-time tripwire: it throws if a payload
 * that should be answer-free contains a correctness field. Unit tests call it too.
 */

export type PublicOption = { id: string; label: string; position: number; imageUrl: string | null };

export type PlayableQuestion = {
  id: string;
  type: QuestionType;
  prompt: string;
  difficulty: Difficulty;
  points: number;
  timeLimitSeconds: number | null;
  position: number;
  imageUrl: string | null;
  /** SHORT_ANSWER only — how long an answer may be, for client-side input hints. */
  maxAnswerLength?: number;
  options: PublicOption[];
};

export type RevealedQuestion = PlayableQuestion & {
  explanation: string | null;
  correctOptionIds: string[];
  /** SHORT_ANSWER only — exposed strictly AFTER the question closes. */
  acceptedAnswers: string[];
};

type QuestionRow = {
  id: string;
  type: QuestionType;
  prompt: string;
  explanation: string | null;
  imageUrl: string | null;
  difficulty: Difficulty;
  points: number;
  timeLimitSeconds: number | null;
  position: number;
  caseSensitive: boolean;
  acceptedAnswers: string[];
  options: readonly { id: string; label: string; isCorrect: boolean; position: number; imageUrl: string | null }[];
};

const MAX_TEXT_ANSWER_LENGTH = 500;

/**
 * Projects a question for a player who has NOT yet answered.
 * No correctness information of any kind is included.
 */
export function toPlayableQuestion(question: QuestionRow): PlayableQuestion {
  const base: PlayableQuestion = {
    id: question.id,
    type: question.type,
    prompt: question.prompt,
    difficulty: question.difficulty,
    points: question.points,
    timeLimitSeconds: question.timeLimitSeconds,
    position: question.position,
    imageUrl: question.imageUrl,
    options: question.options
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((option) => ({
        id: option.id,
        label: option.label,
        position: option.position,
        imageUrl: option.imageUrl,
      })),
  };

  if (question.type === 'SHORT_ANSWER') {
    base.maxAnswerLength = MAX_TEXT_ANSWER_LENGTH;
  }

  return base;
}

/**
 * Projects a question AFTER it has closed (reveal / results review).
 * Only now may correctness be sent to a client.
 */
export function toRevealedQuestion(question: QuestionRow): RevealedQuestion {
  return {
    ...toPlayableQuestion(question),
    explanation: question.explanation,
    correctOptionIds: question.options.filter((option) => option.isCorrect).map((option) => option.id),
    acceptedAnswers: question.caseSensitive ? question.acceptedAnswers : question.acceptedAnswers,
  };
}

const CORRECTNESS_KEYS = ['isCorrect', 'correctOptionIds', 'acceptedAnswers', 'solution'] as const;

/**
 * Returns the JSON paths that leak correctness, or an empty array when clean.
 * Used by tests and by a development-mode assertion at serialisation boundaries.
 */
export function findAnswerLeaks(payload: unknown, path = '$'): string[] {
  if (payload === null || typeof payload !== 'object') return [];

  if (Array.isArray(payload)) {
    return payload.flatMap((item, index) => findAnswerLeaks(item, `${path}[${index}]`));
  }

  const leaks: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if ((CORRECTNESS_KEYS as readonly string[]).includes(key)) {
      leaks.push(`${path}.${key}`);
    }
    leaks.push(...findAnswerLeaks(value, `${path}.${key}`));
  }
  return leaks;
}

/**
 * Throws in development when an answer-free payload leaks correctness.
 * In production it logs, so a leak degrades observability instead of taking the
 * quiz-taking page offline mid-session.
 */
export function assertNoAnswerLeak(payload: unknown, context: string): void {
  const leaks = findAnswerLeaks(payload);
  if (leaks.length === 0) return;

  const message = `[answer-leak] ${context} exposed correctness at: ${leaks.join(', ')}`;
  if (process.env.NODE_ENV === 'production') {
    console.error(message);
  } else {
    throw new Error(message);
  }
}

/** Deterministic shuffle (mulberry32) so a seeded attempt renders reproducibly. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = copy[i] as T;
    const b = copy[j] as T;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

/** Stable numeric seed from a string id, so shuffling is per-attempt deterministic. */
export function seedFromString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
