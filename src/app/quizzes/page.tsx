import Link from 'next/link';
import { prisma } from '@/lib/db';

export const revalidate = 60;
export const metadata = { title: 'Explore quizzes' };

export default async function QuizzesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const params = await searchParams;
  const quizzes = await prisma.quiz.findMany({
    where: {
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      ...(params.q
        ? { OR: [{ title: { contains: params.q, mode: 'insensitive' } }, { description: { contains: params.q, mode: 'insensitive' } }] }
        : {}),
      ...(params.category ? { category: { slug: params.category } } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take: 24,
    select: {
      slug: true, title: true, description: true, attemptCount: true,
      category: { select: { name: true, slug: true } },
      _count: { select: { questions: true } },
    },
  });
  const categories = await prisma.category.findMany({ orderBy: { name: 'asc' }, select: { slug: true, name: true } });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Explore quizzes</h1>
          <p className="text-sm text-slate-600">SEO-friendly public catalog. Every card links to a shareable quiz page.</p>
        </div>
        <form className="flex gap-2" action="/quizzes" method="get">
          <label className="sr-only" htmlFor="q">Search quizzes</label>
          <input
            id="q" name="q" defaultValue={params.q ?? ''} placeholder="Search…"
            className="rounded-lg border px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white">Search</button>
        </form>
      </div>
      {categories.length > 0 ? (
        <nav aria-label="Categories" className="flex flex-wrap gap-2">
          <Link href="/quizzes" className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium">All</Link>
          {categories.map((c) => (
            <Link key={c.slug} href={`/quizzes?category=${c.slug}`} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium hover:bg-slate-200">
              {c.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {quizzes.length === 0 ? (
        <p className="rounded-xl border bg-white p-6 text-sm text-slate-600">No quizzes match. Try a different search.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {quizzes.map((q) => (
            <li key={q.slug} className="rounded-xl border bg-white p-5 shadow-sm">
              <Link href={`/quizzes/${q.slug}`} className="font-semibold hover:underline">{q.title}</Link>
              {q.description ? <p className="mt-1 line-clamp-2 text-sm text-slate-600">{q.description}</p> : null}
              <p className="mt-3 text-xs text-slate-500">
                {q.category?.name ?? 'Uncategorized'} · {q._count.questions} Qs · {q.attemptCount} plays
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
