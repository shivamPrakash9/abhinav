import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { ok, toErrorResponse } from '@/lib/errors';

/** GET /api/v1/sessions/[id]/state — polling fallback for realtime clients. */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const session = await prisma.liveSession.findUnique({
      where: { id },
      select: {
        id: true, code: true, status: true, currentQuestionIndex: true, questionEndsAt: true,
        quiz: {
          select: {
            title: true,
            questions: {
              orderBy: { position: 'asc' },
              select: {
                id: true, type: true, prompt: true, imageUrl: true, points: true,
                options: { orderBy: { position: 'asc' }, select: { id: true, label: true } },
              },
            },
          },
        },
        _count: { select: { participants: true } },
      },
    });
    if (!session) {
      return NextResponse.json({ data: null, error: { code: 'NOT_FOUND', message: 'Room not found.' } }, { status: 404 });
    }
    const current = session.status === 'QUESTION_ACTIVE'
      ? (session.quiz.questions[session.currentQuestionIndex] ?? null)
      : null;
    return NextResponse.json(
      ok({
        sessionId: session.id, code: session.code, status: session.status,
        participantCount: session._count.participants,
        totalQuestions: session.quiz.questions.length,
        index: session.currentQuestionIndex,
        endsAt: session.questionEndsAt,
        current,
      }),
      { headers: { 'Cache-Control': 'private, max-age=2' } },
    );
  } catch (error) {
    return toErrorResponse(error, 'GET /api/v1/sessions/[id]/state');
  }
}
