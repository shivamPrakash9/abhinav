import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { ok, toErrorResponse } from '@/lib/errors';
import { applyPolicy, clientKeyFromHeaders, throwIfLimited } from '@/lib/ratelimit';

/**
 * GET /api/v1/live/[code] — polling fallback snapshot for live rooms.
 * Used when Supabase Realtime is unavailable; correctness-safe because it
 * never includes answers, only the current public question + scores.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }): Promise<Response> {
  try {
    throwIfLimited(await applyPolicy('readPublic', await clientKeyFromHeaders(new Headers(), 'live-poll')));
    const { code } = await params;
    const session = await prisma.liveSession.findUnique({
      where: { code: code.toUpperCase() },
      select: {
        id: true, status: true, currentQuestionIndex: true,
        quiz: { select: { questions: { orderBy: { position: 'asc' }, select: { id: true, type: true, prompt: true, points: true, options: { select: { id: true, label: true } } } } } },
        participants: { orderBy: { score: 'desc' }, take: 25, select: { id: true, displayName: true, score: true } },
      },
    });
    if (!session) return NextResponse.json({ data: null, error: { code: 'NOT_FOUND', message: 'Room not found.' } }, { status: 404 });
    const question = session.currentQuestionIndex >= 0 ? session.quiz.questions[session.currentQuestionIndex] ?? null : null;
    return NextResponse.json(ok({ status: session.status, question, board: session.participants }), {
      headers: { 'Cache-Control': 'private, max-age=1' },
    });
  } catch (error) {
    return toErrorResponse(error, 'GET /api/v1/live/[code]');
  }
}
