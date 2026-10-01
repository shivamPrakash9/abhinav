import { z } from 'zod';

import { idSchema } from './quiz';

/**
 * Attempt lifecycle validation.
 *
 * `submitAnswerSchema` deliberately accepts EITHER selected option ids OR free
 * text, and rejects an empty submission — a client cannot send "no answer" as if
 * it were a real answer, and cannot send both shapes for a choice question.
 */

export const startAttemptSchema = z.object({
  quizSlug: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid quiz link.'),
  /** Anonymous device token; required only when the quiz allows anonymous play. */
  guestToken: z.string().trim().min(8).max(128).optional(),
});

export const submitAnswerSchema = z
  .object({
    questionId: idSchema,
    selectedOptionIds: z.array(idSchema).max(10).default([]),
    textAnswer: z.string().trim().max(500).optional(),
    /**
     * Client-reported elapsed time. Used for the speed bonus and for the
     * "time per question" chart, so it is clamped server-side against the
     * question window — a client cannot claim to have answered instantly.
     */
    timeSpentMs: z.number().int().min(0).max(86_400_000).default(0),
    /** Monotonic client sequence number, used to drop out-of-order retries. */
    clientSeq: z.number().int().min(0).max(100_000).optional(),
  })
  .superRefine((answer, ctx) => {
    const hasOptions = answer.selectedOptionIds.length > 0;
    const hasText = Boolean(answer.textAnswer && answer.textAnswer.length > 0);

    if (!hasOptions && !hasText) {
      ctx.addIssue({
        code: 'custom',
        path: ['selectedOptionIds'],
        message: 'Provide an answer before submitting.',
      });
    }
    if (hasOptions && hasText) {
      ctx.addIssue({
        code: 'custom',
        path: ['textAnswer'],
        message: 'Submit either options or text, not both.',
      });
    }
  });

export const submitAttemptSchema = z.object({
  /** Set by the client when the countdown expired, so we can record the cause. */
  reason: z.enum(['user', 'timeout']).default('user'),
});

export const attemptListQuerySchema = z.object({
  quizId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: idSchema.optional(),
});

export type StartAttemptInput = z.infer<typeof startAttemptSchema>;
export type SubmitAnswerInput = z.infer<typeof submitAnswerSchema>;
