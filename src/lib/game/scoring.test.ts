import { describe, expect, it } from 'vitest';
import { gradeAnswer, clampResponseMs, summarizeAttempt, speedBonusPoints } from './scoring';

const mcq = {
  type: 'MULTIPLE_CHOICE' as const,
  points: 100,
  caseSensitive: false,
  acceptedAnswers: [] as readonly string[],
  options: [
    { id: 'a', isCorrect: true },
    { id: 'b', isCorrect: false },
  ] as readonly { id: string; isCorrect: boolean }[],
  windowMs: 30_000,
};

describe('gradeAnswer', () => {
  it('grades a correct MCQ with speed + streak bonus', () => {
    const r = gradeAnswer({ question: mcq, selectedOptionIds: ['a'], responseMs: 0, currentStreak: 2 });
    expect(r.isCorrect).toBe(true);
    expect(r.awardedPoints).toBeGreaterThan(100);
    expect(r.nextStreak).toBe(3);
  });
  it('resets streak on wrong answer', () => {
    const r = gradeAnswer({ question: mcq, selectedOptionIds: ['b'], responseMs: 1000, currentStreak: 4 });
    expect(r.isCorrect).toBe(false);
    expect(r.nextStreak).toBe(0);
  });
  it('flags implausibly fast answers', () => {
    const r = gradeAnswer({ question: mcq, selectedOptionIds: ['a'], responseMs: 10, currentStreak: 0 });
    expect(r.flaggedAsSuspicious).toBe(true);
  });
  it('grades short answer case-insensitively', () => {
    const q = { ...mcq, type: 'SHORT_ANSWER' as const, acceptedAnswers: ['Paris'] as readonly string[], options: [] as const };
    expect(gradeAnswer({ question: q, selectedOptionIds: [], textAnswer: '  paris ', responseMs: 2000, currentStreak: 0 }).isCorrect).toBe(true);
  });
});

describe('clampResponseMs', () => {
  it('clamps negatives and overflows', () => {
    expect(clampResponseMs(-5, 30_000)).toBe(0);
    expect(clampResponseMs(99_999, 30_000)).toBe(30_000);
  });
});

describe('summarizeAttempt', () => {
  it('reconciles skipped counts', () => {
    const s = summarizeAttempt([{ isCorrect: true, awardedPoints: 10 }], 3);
    expect(s.skippedCount).toBe(2);
    expect(s.accuracy).toBe(1);
  });
});

describe('speedBonusPoints', () => {
  it('decays linearly', () => {
    expect(speedBonusPoints(100, 0, 30_000)).toBe(50);
    expect(speedBonusPoints(100, 30_000, 30_000)).toBe(0);
  });
});
