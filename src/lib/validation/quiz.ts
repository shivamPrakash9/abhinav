import { z } from 'zod';

/**
 * Quiz + question validation, shared by:
 *   • the quiz creation/edit form (same schema on the client, instant feedback)
 *   • the Server Actions in src/actions/quiz.ts
 *   • POST/PATCH /api/v1/quizzes
 *
 * IDs are validated as bounded strings rather than `.cuid()` so the schema does
 * not depend on a specific ID strategy (Prisma `cuid()` today, `uuid()` or a ULID
 * tomorrow) and so an unbounded client value is never accepted.
 */

export const QUESTION_TYPES = [
  'MULTIPLE_CHOICE',
  'MULTI_SELECT',
  'TRUE_FALSE',
  'SHORT_ANSWER',
] as const;

export const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
export const QUIZ_VISIBILITIES = ['PUBLIC', 'UNLISTED', 'PRIVATE'] as const;

export const idSchema = z.string().trim().min(1).max(64);

export const optionInputSchema = z.object({
  id: idSchema.optional(),
  label: z.string().trim().min(1, 'Option text is required.').max(500),
  isCorrect: z.boolean().default(false),
});

/**
 * Per-type rules live in one `superRefine` so the same guarantees hold whether
 * the payload arrives from the form, a Server Action or the REST API. These
 * mirror the CHECK constraints in 0002_integrity_constraints: the app produces
 * good error messages, the database is the last line of defence.
 */
export const questionInputSchema = z
  .object({
    id: idSchema.optional(),
    type: z.enum(QUESTION_TYPES),
    prompt: z.string().trim().min(1, 'Question text is required.').max(2000),
    explanation: z.string().trim().max(2000).optional(),
    difficulty: z.enum(DIFFICULTIES).default('MEDIUM'),
    points: z.number().int().min(1).max(100).default(1),
    timeLimitSeconds: z.number().int().min(5).max(600).nullable().default(null),
    options: z.array(optionInputSchema).max(10).default([]),
    acceptedAnswers: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    caseSensitive: z.boolean().default(false),
  })
  .superRefine((question, ctx) => {
    const correct = question.options.filter((option) => option.isCorrect);

    switch (question.type) {
      case 'MULTIPLE_CHOICE': {
        if (question.options.length < 2) {
          ctx.addIssue({
            code: 'custom',
            path: ['options'],
            message: 'A multiple-choice question needs at least 2 options.',
          });
        }
        if (correct.length !== 1) {
          ctx.addIssue({
            code: 'custom',
            path: ['options'],
            message: 'A multiple-choice question needs exactly one correct option.',
          });
        }
        break;
      }

      case 'MULTI_SELECT': {
        if (question.options.length < 3) {
          ctx.addIssue({
            code: 'custom',
            path: ['options'],
            message: 'A multi-select question needs at least 3 options.',
          });
        }
        if (correct.length < 2) {
          ctx.addIssue({
            code: 'custom',
            path: ['options'],
            message: 'A multi-select question needs at least 2 correct options.',
          });
        }
        if (question.options.length > 0 && correct.length === question.options.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['options'],
            message: 'Not every option can be correct — that question is unanswerable.',
          });
        }
        break;
      }

      case 'TRUE_FALSE': {
        if (question.options.length !== 2 || correct.length !== 1) {
          ctx.addIssue({
            code: 'custom',
            path: ['options'],
            message: 'A true/false question needs exactly 2 options with 1 correct answer.',
          });
        }
        break;
      }

      case 'SHORT_ANSWER': {
        if (question.options.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['options'],
            message: 'A short-answer question cannot have options.',
          });
        }
        if (question.acceptedAnswers.length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['acceptedAnswers'],
            message: 'Add at least one accepted answer.',
          });
        }
        break;
      }
    }
  });

export const quizCreateSchema = z.object({
  title: z.string().trim().min(3, 'Give the quiz a title (3+ characters).').max(160),
  description: z.string().trim().max(2000).optional(),
  categoryId: idSchema.nullable().optional(),
  visibility: z.enum(QUIZ_VISIBILITIES).default('UNLISTED'),

  timeLimitSeconds: z.number().int().min(10).max(86_400).nullable().default(null),
  defaultQuestionTimeSeconds: z.number().int().min(5).max(3600).default(30),
  shuffleQuestions: z.boolean().default(true),
  shuffleOptions: z.boolean().default(true),
  maxAttempts: z.number().int().min(1).max(100).nullable().default(null),
  passScorePercent: z.number().int().min(0).max(100).default(60),
  allowAnonymous: z.boolean().default(false),
  embedEnabled: z.boolean().default(true),

  /** Trimmed, lower-cased and de-duplicated before it reaches the database. */
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),

  questions: z
    .array(questionInputSchema)
    .min(1, 'Add at least one question.')
    .max(200, 'A quiz can have at most 200 questions.'),
});

export const quizUpdateSchema = quizCreateSchema
  .partial()
  .extend({ questions: z.array(questionInputSchema).min(1).max(200).optional() });

export const quizListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  tag: z.string().trim().max(60).optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  sort: z.enum(['recent', 'popular', 'rating']).default('recent'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: idSchema.optional(),
});

export const publishQuizSchema = z.object({
  visibility: z.enum(['PUBLIC', 'UNLISTED']).default('UNLISTED'),
});

export type QuizCreateInput = z.infer<typeof quizCreateSchema>;
export type QuizUpdateInput = z.infer<typeof quizUpdateSchema>;
export type QuestionInput = z.infer<typeof questionInputSchema>;
export type QuizListQuery = z.infer<typeof quizListQuerySchema>;

/** Normalises a tag list: trimmed, lower-cased, de-duplicated, sorted. */
export function normalizeTags(tags: readonly string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))).sort();
}

