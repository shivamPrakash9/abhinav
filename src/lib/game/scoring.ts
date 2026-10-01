/**
 * Pure scoring + grading logic.
 *
 * Deliberately free of database, network and framework imports so it can be
 * unit-tested exhaustively (see scoring.test.ts) — this is the code that decides
 * whether a player's answer is right, so it is the highest-value code to test.
 */

export type ScoringRules = {
  /** Award a time-based bonus for correct answers. */
  speedBonus: boolean;
  /** Award a bonus for consecutive correct answers. */
  streakBonus: boolean;
  /** Fraction of base points granted for an instantaneous correct answer. */
  maxSpeedBonusRatio: number;
  /** Fraction of base points granted per streak step. */
  streakBonusRatio: number;
  /** Streak bonus stops growing after this many consecutive correct answers. */
  maxStreakBonusSteps: number;
  /**
   * Multi-select questions are all-or-nothing by default. Set true to award a
   * proportional share instead (correct picks minus wrong picks, floored at 0).
   */
  partialCreditMultiSelect: boolean;
};

export const DEFAULT_SCORING_RULES: ScoringRules = {
  speedBonus: true,
  streakBonus: true,
  maxSpeedBonusRatio: 0.5,
  streakBonusRatio: 0.1,
  maxStreakBonusSteps: 5,
  partialCreditMultiSelect: false,
};

/**
 * A human cannot read a question and answer it in under this long. Responses
 * faster than this are recorded but flagged (see `isSuspiciouslyFast`) for
 * moderation rather than silently rewarded as legitimate speed-bonus farming.
 */
export const MIN_HUMAN_RESPONSE_MS = 250;

export type GradeableQuestion = {
  type: 'MULTIPLE_CHOICE' | 'MULTI_SELECT' | 'TRUE_FALSE' | 'SHORT_ANSWER';
  points: number;
  caseSensitive: boolean;
  acceptedAnswers: readonly string[];
  options: readonly { id: string; isCorrect: boolean }[];
  /** Effective per-question window in milliseconds (used for the speed bonus). */
  windowMs: number;
};

export type GradeInput = {
  question: GradeableQuestion;
  selectedOptionIds: readonly string[];
  textAnswer?: string | null;
  responseMs: number;
  /** Consecutive correct answers BEFORE this one. */
  currentStreak: number;
  rules?: ScoringRules;
};

export type GradeResult = {
  isCorrect: boolean;
  awardedPoints: number;
  nextStreak: number;
  /** True when the answer was correct but the response time is implausible. */
  flaggedAsSuspicious: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Normalises free-text answers so "  Café  " and "cafe" can both match.
 * NFKC folds compatibility characters (full-width digits, ligatures) so users on
 * non-Latin keyboards are not unfairly marked wrong.
 */
export function normalizeShortAnswer(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return caseSensitive ? normalized : normalized.toLocaleLowerCase();
}

export function isShortAnswerCorrect(
  answer: string | null | undefined,
  acceptedAnswers: readonly string[],
  caseSensitive: boolean,
): boolean {
  if (!answer) return false;
  const normalized = normalizeShortAnswer(answer, caseSensitive);
  if (normalized.length === 0) return false;
  return acceptedAnswers.some(
    (accepted) => normalizeShortAnswer(accepted, caseSensitive) === normalized,
  );
}

/** Set equality — the order in which options were selected must not matter. */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

/**
 * Decides correctness for one answer.
 *
 * MULTIPLE_CHOICE / TRUE_FALSE: exactly-one selection matching the correct option.
 * MULTI_SELECT: exact set match (all-or-nothing) by default.
 * SHORT_ANSWER: normalised comparison against any accepted answer.
 */
export function isAnswerCorrect(
  question: GradeableQuestion,
  selectedOptionIds: readonly string[],
  textAnswer: string | null | undefined,
): boolean {
  if (question.type === 'SHORT_ANSWER') {
    return isShortAnswerCorrect(textAnswer, question.acceptedAnswers, question.caseSensitive);
  }

  if (selectedOptionIds.length === 0) return false;

  const correctIds = question.options
    .filter((option) => option.isCorrect)
    .map((option) => option.id);
  // Guard against malformed data (a question with zero correct options): an empty
  // correct set must never be satisfiable by a crafted submission.
  if (correctIds.length === 0) return false;

  return sameIdSet(selectedOptionIds, correctIds);
}

/**
 * Proportional credit for multi-select: correct picks contribute, wrong picks
 * subtract, and the result never falls below zero.
 */
function partialMultiSelectPoints(
  question: GradeableQuestion,
  selectedOptionIds: readonly string[],
): number {
  const totalCorrect = question.options.filter((option) => option.isCorrect).length;
  if (totalCorrect === 0) return 0;

  const selected = new Set(selectedOptionIds);
  const selectedCorrect = question.options.filter(
    (option) => option.isCorrect && selected.has(option.id),
  ).length;
  const selectedWrong = question.options.filter(
    (option) => !option.isCorrect && selected.has(option.id),
  ).length;

  const ratio = clamp((selectedCorrect - selectedWrong) / totalCorrect, 0, 1);
  return Math.round(question.points * ratio);
}

/** Points for answering `responseMs` into a `windowMs` question. Linear decay. */
export function speedBonusPoints(
  basePoints: number,
  responseMs: number,
  windowMs: number,
  rules: ScoringRules = DEFAULT_SCORING_RULES,
): number {
  if (!rules.speedBonus) return 0;
  if (windowMs <= 0) return 0;
  const remainingRatio = clamp(1 - responseMs / windowMs, 0, 1);
  return Math.round(basePoints * rules.maxSpeedBonusRatio * remainingRatio);
}

/** Streak bonus; `currentStreak` counts consecutive correct answers before this one. */
export function streakBonusPoints(
  basePoints: number,
  currentStreak: number,
  rules: ScoringRules = DEFAULT_SCORING_RULES,
): number {
  if (!rules.streakBonus) return 0;
  const steps = clamp(currentStreak, 0, rules.maxStreakBonusSteps);
  return Math.round(basePoints * rules.streakBonusRatio * steps);
}

export function isSuspiciouslyFast(responseMs: number): boolean {
  return responseMs < MIN_HUMAN_RESPONSE_MS;
}

/**
 * Full grade + score for a single answer. The only function that turns a
 * submission into points, and it runs server-side exclusively.
 */
export function gradeAnswer(input: GradeInput): GradeResult {
  const rules = input.rules ?? DEFAULT_SCORING_RULES;
  const { question } = input;

  const correct = isAnswerCorrect(question, input.selectedOptionIds, input.textAnswer);

  if (!correct) {
    const partial =
      rules.partialCreditMultiSelect && question.type === 'MULTI_SELECT'
        ? partialMultiSelectPoints(question, input.selectedOptionIds)
        : 0;
    return {
      isCorrect: false,
      awardedPoints: partial,
      nextStreak: 0,
      flaggedAsSuspicious: isSuspiciouslyFast(input.responseMs),
    };
  }

  const speed = speedBonusPoints(question.points, input.responseMs, question.windowMs, rules);
  const streak = streakBonusPoints(question.points, input.currentStreak, rules);

  return {
    isCorrect: true,
    awardedPoints: question.points + speed + streak,
    nextStreak: input.currentStreak + 1,
    flaggedAsSuspicious: isSuspiciouslyFast(input.responseMs),
  };
}

/**
 * Clamps a client-reported elapsed time into [0, windowMs].
 * A client can claim a negative or absurd duration; neither may affect scoring.
 */
export function clampResponseMs(reportedMs: number, windowMs: number): number {
  if (!Number.isFinite(reportedMs) || reportedMs < 0) return 0;
  return Math.round(clamp(reportedMs, 0, windowMs));
}

/** Computes the stored attempt aggregates from graded answers. */
export function summarizeAttempt(
  answers: readonly { isCorrect: boolean | null; awardedPoints: number }[],
  questionCount: number,
): {
  score: number;
  correctCount: number;
  incorrectCount: number;
  skippedCount: number;
  accuracy: number;
} {
  const correctCount = answers.filter((answer) => answer.isCorrect === true).length;
  const incorrectCount = answers.filter((answer) => answer.isCorrect === false).length;
  // Unanswered questions count as skipped so the totals always reconcile.
  const skippedCount = Math.max(0, questionCount - correctCount - incorrectCount);
  const score = answers.reduce((total, answer) => total + answer.awardedPoints, 0);
  const attempted = correctCount + incorrectCount;

  return {
    score,
    correctCount,
    incorrectCount,
    skippedCount,
    accuracy: attempted === 0 ? 0 : correctCount / attempted,
  };
}

