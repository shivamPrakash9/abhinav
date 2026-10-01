import { z } from 'zod';

/**
 * The complete realtime contract for a live quiz room.
 *
 * Both the server (src/lib/game/realtime-server.ts) and the browser hook
 * (src/hooks/use-live-session.ts) import this file, so an event cannot be
 * renamed on one side and silently ignored on the other — the schemas are parsed
 * at both ends.
 *
 * DESIGN RULE: realtime carries STATE TRANSITIONS only, never grading results and
 * never a client-authored answer. Answers are submitted over HTTP to a route
 * handler that grades them server-side. Broadcast is one-way, ordered, and cheap;
 * it is not a data store and must not be treated as one.
 */

export const channels = {
  /** Public room state for every participant. */
  room: (code: string) => `room:${code}`,
  /** Presence tracking for the lobby. */
  presence: (code: string) => `presence:room:${code}`,
  /** Host-only control acknowledgements (answer ticker, join/leave notices). */
  host: (code: string) => `host:room:${code}`,
} as const;

/** Server → all participants. */
export const ROOM_EVENTS = [
  'lobby_update',
  'start',
  'question_started',
  'reveal',
  'scoreboard',
  'heartbeat',
  'end',
  'cancelled',
] as const;

/** Server → host only. */
export const HOST_EVENTS = ['answer_ack', 'participant_joined', 'participant_left'] as const;

export type RoomEvent = (typeof ROOM_EVENTS)[number];
export type HostEvent = (typeof HOST_EVENTS)[number];

const isoDateTime = z.string().datetime();

export const serverTimeSchema = z.object({
  /** Server clock at emit time — clients derive an offset and never trust their own clock. */
  serverTime: isoDateTime,
});

export const lobbyUpdateSchema = serverTimeSchema.extend({
  participantCount: z.number().int().min(0),
  capacity: z.number().int().min(2),
  hostName: z.string().max(60),
});

export const startSchema = serverTimeSchema.extend({
  sessionId: z.string(),
  totalQuestions: z.number().int().min(1),
  /** Absolute instant the first question begins; all clients count down to it. */
  startsAt: isoDateTime,
});

export const questionStartedSchema = serverTimeSchema.extend({
  index: z.number().int().min(0),
  questionNumber: z.number().int().min(1),
  totalQuestions: z.number().int().min(1),
  questionId: z.string(),
  type: z.enum(['MULTIPLE_CHOICE', 'MULTI_SELECT', 'TRUE_FALSE', 'SHORT_ANSWER']),
  prompt: z.string(),
  imageUrl: z.string().nullable(),
  points: z.number().int().min(1),
  /** NOTE: deliberately no correctness information — see src/lib/game/fetch.ts. */
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  maxAnswerLength: z.number().int().min(1).optional(),
  endsAt: isoDateTime,
});

export const revealSchema = serverTimeSchema.extend({
  questionId: z.string(),
  correctOptionIds: z.array(z.string()),
  /** SHORT_ANSWER only, and only after the question has closed. */
  acceptedAnswers: z.array(z.string()).optional(),
  explanation: z.string().nullable(),
  /** How the room voted: useful for the "surprising result" moment on screen. */
  histogram: z.array(z.object({ optionId: z.string(), count: z.number().int().min(0) })),
});

export const scoreboardSchema = serverTimeSchema.extend({
  entries: z.array(
    z.object({
      participantId: z.string(),
      displayName: z.string(),
      score: z.number().int().min(0),
      /** Points gained since the previous scoreboard — drives the "+180" animation. */
      delta: z.number().int(),
      rank: z.number().int().min(1),
      streak: z.number().int().min(0),
    }),
  ),
  participantCount: z.number().int().min(0),
});

export const heartbeatSchema = serverTimeSchema.extend({
  index: z.number().int(),
  remainingMs: z.number().int().min(0),
});

export const endSchema = serverTimeSchema.extend({
  endedAt: isoDateTime,
  finalScoreboard: scoreboardSchema.shape.entries,
  totalQuestions: z.number().int().min(0),
});

export const cancelledSchema = serverTimeSchema.extend({
  reason: z.string().max(200),
});

export const answerAckSchema = serverTimeSchema.extend({
  questionId: z.string(),
  answeredCount: z.number().int().min(0),
  participantCount: z.number().int().min(0),
});

export const participantJoinedSchema = serverTimeSchema.extend({
  participantId: z.string(),
  displayName: z.string(),
  participantCount: z.number().int().min(0),
});

export const participantLeftSchema = serverTimeSchema.extend({
  participantId: z.string(),
  displayName: z.string(),
  participantCount: z.number().int().min(0),
});

/** Schema per event name — the single source of truth for payload shape. */
export const ROOM_EVENT_SCHEMAS = {
  lobby_update: lobbyUpdateSchema,
  start: startSchema,
  question_started: questionStartedSchema,
  reveal: revealSchema,
  scoreboard: scoreboardSchema,
  heartbeat: heartbeatSchema,
  end: endSchema,
  cancelled: cancelledSchema,
} as const;

export const HOST_EVENT_SCHEMAS = {
  answer_ack: answerAckSchema,
  participant_joined: participantJoinedSchema,
  participant_left: participantLeftSchema,
} as const;

/** Safe parse used by the client hook; invalid payloads are ignored, never rendered. */
export function parseRoomEvent(event: string, payload: unknown) {
  const schema = ROOM_EVENT_SCHEMAS[event as RoomEvent];
  if (!schema) return null;
  const result = schema.safeParse(payload);
  return result.success ? result.data : null;
}
