import { ZodError, type ZodType } from 'zod';

/**
 * Typed application errors + the single response envelope used by every
 * /api/v1 route handler.
 *
 * Why one envelope: clients (including the embed widget) can branch on
 * `error.code` instead of string-matching messages, and the shape never changes
 * between endpoints.
 */

export const ERROR_CODES = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
  UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** Seconds until the caller may retry (rate limits only). */
  readonly retryAfter?: number;

  constructor(code: ErrorCode, message?: string, options?: { details?: unknown; retryAfter?: number }) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.details = options?.details;
    this.retryAfter = options?.retryAfter;
  }

  get status(): number {
    return ERROR_CODES[this.code];
  }
}

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'You must be signed in to do that.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'That resource does not exist.',
  CONFLICT: 'That action conflicts with the current state.',
  VALIDATION: 'The submitted data is invalid.',
  RATE_LIMITED: 'Too many requests. Please slow down.',
  PAYLOAD_TOO_LARGE: 'The submitted payload is too large.',
  INTERNAL: 'Something went wrong on our end.',
  UNAVAILABLE: 'The service is temporarily unavailable.',
};

export type ApiOk<T> = { data: T; error: null };
export type ApiFail = {
  data: null;
  error: { code: ErrorCode; message: string; details?: unknown };
};
export type ApiResponse<T> = ApiOk<T> | ApiFail;

export function ok<T>(data: T): ApiOk<T> {
  return { data, error: null };
}

export function fail(code: ErrorCode, message?: string, details?: unknown): ApiFail {
  return {
    data: null,
    error: { code, message: message ?? DEFAULT_MESSAGES[code], ...(details ? { details } : {}) },
  };
}

/** Result type for Server Actions (which cannot return a Response object). */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; details?: unknown };

export function actionOk<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function actionFail<T = never>(
  code: ErrorCode,
  message?: string,
  details?: unknown,
): ActionResult<T> {
  return { ok: false, code, message: message ?? DEFAULT_MESSAGES[code], details };
}

/** Flattens a ZodError into `{ fieldPath: [messages] }` for form UIs. */
export function zodFieldErrors(error: ZodError): Record<string, string[]> {
  const flattened: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_root';
    (flattened[path] ??= []).push(issue.message);
  }
  return flattened;
}

/**
 * Parses input with a Zod schema and throws a VALIDATION AppError on failure.
 * Keeps route handlers free of repeated `if (!parsed.success)` noise.
 */
export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('VALIDATION', undefined, { details: zodFieldErrors(result.error) });
  }
  return result.data;
}

/**
 * Converts any thrown value into a Response with the standard envelope.
 * Unknown errors are logged and returned as INTERNAL — never leak stack traces
 * or database messages to clients.
 */
export function toErrorResponse(error: unknown, context?: string): Response {
  if (error instanceof AppError) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (error.retryAfter !== undefined) headers['Retry-After'] = String(error.retryAfter);
    return new Response(JSON.stringify(fail(error.code, error.message, error.details)), {
      status: error.status,
      headers,
    });
  }

  console.error(`[api${context ? ` ${context}` : ''}] Unhandled error:`, error);
  return new Response(
    JSON.stringify(fail('INTERNAL', 'Something went wrong on our end.')),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Wraps JSON body parsing so malformed JSON yields VALIDATION, not a 500. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (text.length === 0) return {};
    if (text.length > 256_000) throw new AppError('PAYLOAD_TOO_LARGE');
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('VALIDATION', 'Request body must be valid JSON.');
  }
}
