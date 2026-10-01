import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { toErrorResponse } from '@/lib/errors';
import { sweepExpiredAttempts, sweepStaleLiveSessions } from '@/lib/game/finalize';

/**
 * GET /api/cron/sweep — Vercel Cron (every minute).
 * Requires `Authorization: Bearer <CRON_SECRET>`.
 * Finalizes timed-out attempts (auto-submit) + cancels stale live rooms.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = request.headers.get('authorization');
    if (!env.cronSecret || auth !== `Bearer ${env.cronSecret}`) {
      return NextResponse.json({ data: null, error: { code: 'FORBIDDEN', message: 'Forbidden.' } }, { status: 403 });
    }
    const [attempts, sessions] = await Promise.all([
      sweepExpiredAttempts(200),
      sweepStaleLiveSessions(6),
    ]);
    return NextResponse.json({ data: { attempts, sessions, at: new Date().toISOString() }, error: null });
  } catch (error) {
    return toErrorResponse(error, 'GET /api/cron/sweep');
  }
}
