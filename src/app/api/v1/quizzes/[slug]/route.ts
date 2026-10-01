import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { ok, toErrorResponse } from '@/lib/errors';
import { applyPolicy, clientKeyFromHeaders, throwIfLimited } from '@/lib/ratelimit';

/** GET /api/v1/quizzes/[slug] — SEO-friendly public quiz detail (no answers). */
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    throwIfLimited(await applyPolicy('readPublic', await clientKeyFromHeaders(request.headers, 'quiz-detail')));
    const { slug } = await params;
    const quiz = await prisma.quiz.findFirst({
      where: { slug, status: 'PUBLISHED', visibility: { not: 'PRIVATE' } },
      select: {
        id: true, slug: true, title: true, description: true, coverImageUrl: true,
        timeLimitSeconds: true, defaultQuestionTimeSeconds: true, attemptCount: true,
        averageScore: true, publishedAt: true, allowAnonymous: true,
        author: { select: { name: true, username: true, image: true } },
        category: { select: { slug: true, name: true } },
        tags: { select: { tag: { select: { slug: true, name: true } } } },
        questions: {
          orderBy: { position: 'asc' },
          select: { id: true, type: true, difficulty: true, points: true, position: true },
        },
      },
    });
    if (!quiz) {
      return NextResponse.json({ data: null, error: { code: 'NOT_FOUND', message: 'Quiz not found.' } }, { status: 404 });
    }
    return NextResponse.json(
      ok({ ...quiz, tags: quiz.tags.map((t) => t.tag), questionCount: quiz.questions.length, url: `/quizzes/${quiz.slug}` }),
    );
  } catch (error) {
    return toErrorResponse(error, 'GET /api/v1/quizzes/[slug]');
  }
}
