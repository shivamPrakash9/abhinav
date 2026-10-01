import { z } from 'zod';

import { idSchema } from './quiz';

/**
 * Live multiplayer (Realtime room) validation.
 */

export const createSessionSchema = z.object({
  quizId: idSchema,
  /** Players per room. Capped at 200 to stay inside Realtime connection limits. */
  maxParticipants: z.number().int().min(2).max(200).default(100),
  settings: z
    .object({
      speedBonus: z.boolean().default(true),
      streakBonus: z.boolean().default(true),
      showLiveLeaderboard: z.boolean().default(true),
    })
    .default({ speedBonus: true, streakBonus: true, showLiveLeaderboard: true }),
});

export const joinSessionSchema = z.object({
  /** 6-character join code, ambiguous characters excluded by the generator. */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .length(6)
    .regex(/^[A-HJ-NP-Z2-9]{6}$/, 'That is not a valid room code.'),
  displayName: z
    .string()
    .trim()
    .min(1, 'Pick a display name.')
    .max(24, 'Display names are limited to 24 characters.')
    // Strip anything that could be used for markup injection in the leaderboard.
    .regex(/^[\p{L}\p{N} _.'-]+$/u, 'Use letters, numbers, spaces and . _ \' - only.'),
  guestToken: z.string().trim().min(8).max(128).optional(),
});

export const sessionControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('reveal') }),
  z.object({ action: z.literal('scoreboard') }),
  z.object({ action: z.literal('next') }),
  z.object({ action: z.literal('end') }),
  z.object({ action: z.literal('kick'), participantId: idSchema }),
]);

export const sessionAnswerSchema = z.object({
  questionId: idSchema,
  selectedOptionIds: z.array(idSchema).max(10).default([]),
  textAnswer: z.string().trim().max(500).optional(),
  responseMs: z.number().int().min(0).max(86_400_000).default(0),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type JoinSessionInput = z.infer<typeof joinSessionSchema>;
export type SessionControlInput = z.infer<typeof sessionControlSchema>;
export type SessionAnswerInput = z.infer<typeof sessionAnswerSchema>;
