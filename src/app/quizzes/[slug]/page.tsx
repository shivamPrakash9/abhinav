import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@/lib/db';

export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const quiz = await prisma.quiz.findFirst({
    where: { slug, status: 'PUBLISHED', visibility: { not: 'PRIVATE' } },
    select: { title: true, description: true },
  });
  if (!quiz) return { title: 'Quiz not found' };
  return {
    title: quiz.title,
    description: quiz.description ?? `Play “${quiz.title}” on Quizly.`,
    openGraph: { title: quiz.title, description: quiz.description ?? undefined, type: 'article' },
    alternates: { canonical: `/quizzes/${slug}` },
  };
}

/** Public SEO-friendly quiz page: metadata + question counts, but NEVER answers. */
export default async function QuizDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const quiz = await prisma.quiz.findFirst({
    where: { slug, status: 'PUBLISHED', visibility: { not: 'PRIVATE' } },
    select: {
      slug: true, title: true, description: true, coverImageUrl: true,
      timeLimitSeconds: true, attemptCount: true, averageScore: true, allowAnonymous: true,
      author: { select: { name: true, username: true } },
      category: { select: { name: true } },
      tags: { select: { tag: { select: { name: true } } } },
      questions: { orderBy: { position: 'asc' }, select: { type: true, difficulty: true, points: true } },
    },
  });
  if (!quiz) notFound();

  const shareUrl = `/quizzes/${quiz.slug}`;
  const embedCode = `<iframe src="${shareUrl.replace('/quizzes/', '/embed/')}" width="640" height="520" loading="lazy" title="${quiz.title.replace(/"/g, '')}"></iframe>`;

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-indigo-600">{quiz.category?.name ?? 'Quiz'}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{quiz.title}</h1>
        {quiz.description ? <p className="mt-2 text-slate-600">{quiz.description}</p> : null}
        <p className="mt-2 text-sm text-slate-500">
          by {quiz.author.name ?? quiz.author.username ?? 'Anonymous'} · {quiz.questions.length} questions ·{' '}
          {quiz.attemptCount} plays
          {quiz.averageScore !== null ? ` · avg ${Math.round(quiz.averageScore)}` : ''}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link href={`/quizzes/${quiz.slug}/play`} className="rounded-lg bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-700">
          Start quiz{quiz.timeLimitSeconds ? ` (${Math.round(quiz.timeLimitSeconds / 60)} min)` : ''}
        </Link>
        <Link href={`/leaderboards?scope=QUIZ&quizSlug=${quiz.slug}`} className="rounded-lg border px-5 py-2.5 font-medium hover:bg-slate-50">
          Leaderboard
        </Link>
      </div>

      <section aria-label="Share" className="rounded-xl border bg-white p-5">
        <h2 className="font-semibold">Share or embed</h2>
        <p className="mt-1 text-sm text-slate-600">
          Link: <code className="rounded bg-slate-100 px-1">{shareUrl}</code>
        </p>
        <label htmlFor="embed" className="mt-3 block text-sm font-medium">Embed widget</label>
        <textarea id="embed" readOnly rows={3} value={embedCode} className="mt-1 w-full rounded-lg border bg-slate-50 p-2 font-mono text-xs" />
      </section>

      {quiz.tags.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label="Tags">
          {quiz.tags.map((t) => (
            <span key={t.tag.name} className="rounded-full bg-slate-100 px-3 py-1 text-xs">{t.tag.name}</span>
          ))}
        </div>
      ) : null}
    </article>
  );
}
