import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ok, parseOrThrow, toErrorResponse } from '@/lib/errors';
import { applyPolicy, clientKeyFromHeaders, throwIfLimited } from '@/lib/ratelimit';
import { quizListQuerySchema } from '@/lib/validation/quiz';

/**
 * GET /api/v1/quizzes — public quiz discovery.
 *
 * Everything returned here is cacheable public data. Only published, non-private
 * quizzes are ever listed, and the card payload contains no question content at
 * all (so nothing to leak).
 *
 * Pagination is CURSOR based (`?cursor=<id>`), not offset based: an offset drifts
 * when new quizzes are published between page loads, which produces duplicated
 * and skipped cards.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const query = parseOrThrow(quizListQuerySchema, Object.fromEntries(url.searchParams));

    throwIfLimited(
      await applyPolicy('readPublic', await clientKeyFromHeaders(request.headers, 'quizzes-list')),
    );

    const quizzes = await prisma.quiz.findMany({
      where: {
        status: 'PUBLISHED',
        visibility: 'PUBLIC',
        ...(query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' } },
                { description: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(query.category ? { category: { slug: query.category } } : {}),
        ...(query.tag ? { tags: { some: { tag: { slug: query.tag } } } } : {}),
        ...(query.difficulty ? { questions: { some: { difficulty: query.difficulty } } } : {}),
      },
      orderBy:
        query.sort === 'popular'
          ? { attemptCount: 'desc' }
          : query.sort === 'rating'
            ? { ratingSum: 'desc' }
            : { publishedAt: 'desc' },
      take: query.limit + 1, // one extra row tells us whether a next page exists
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        coverImageUrl: true,
        attemptCount: true,
        averageScore: true,
        timeLimitSeconds: true,
        defaultQuestionTimeSeconds: true,
        publishedAt: true,
        author: { select: { id: true, name: true, image: true, username: true } },
        category: { select: { id: true, slug: true, name: true } },
        tags: { select: { tag: { select: { slug: true, name: true } } } },
        _count: { select: { questions: true } },
      },
    });

    const hasMore = quizzes.length > query.limit;
    const page = hasMore ? quizzes.slice(0, query.limit) : quizzes;

    return NextResponse.json(
      ok({
        items: page.map((quiz) => ({
          id: quiz.id,
          slug: quiz.slug,
          title: quiz.title,
          description: quiz.description,
          coverImageUrl: quiz.coverImageUrl,
          questionCount: quiz._count.questions,
          attemptCount: quiz.attemptCount,
          averageScore: quiz.averageScore,
          timeLimitSeconds: quiz.timeLimitSeconds,
          defaultValue: quiz.defaultQuestionTimeSeconds,
          publishedAt: quiz.publishedAt?.toISOString() ?? null,
          author: quiz.author,
          category: quiz.category,
          tags: quiz.tags.map((entry) => entry.tag),
          url: `/quizzes/${quiz.slug}`,
        })),
        pageInfo: {
          hasMore,
          nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        },
      }),
    );
  } catch (error) {
    return toErrorResponse(error, 'GET /api/v1/quizzes');
  }
}

/**
 * GET /api/v1/quizzes?mine=true is intentionally NOT supported here.
 * Authenticated authoring data is fetched directly in Server Components from
 * Prisma, so it never travels over a public, cacheable HTTP surface.
 */
export async function HEAD(): Promise<Response> {
  // Lightweight health probe used by CI smoke tests and uptime checks.
  const user = await getCurrentUser();
  return new Response(null, { status: 200, headers: { 'x-authenticated': String(Boolean(user)) } });
}
