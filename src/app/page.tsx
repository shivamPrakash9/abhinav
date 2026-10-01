import Link from 'next/link';
import { prisma } from '@/lib/db';

export const revalidate = 60;

export default async function HomePage() {
  const quizzes = await prisma.quiz.findMany({
    where: { status: 'PUBLISHED', visibility: 'PUBLIC' },
    orderBy: { attemptCount: 'desc' },
    take: 6,
    select: { slug: true, title: true, description: true, attemptCount: true, _count: { select: { questions: true } } },
  });

  return (
    <div className="space-y-12">
      <section className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 p-8 text-white sm:p-12">
        <h1 className="max-w-xl text-3xl font-bold tracking-tight sm:text-5xl">
          Create, play &amp; host live quizzes
        </h1>
        <p className="mt-4 max-w-xl text-indigo-100">
          Timed solo attempts with auto-submit, real-time multiplayer rooms, leaderboards
          and per-question analytics — on free-tier managed services.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/quizzes" className="rounded-lg bg-white px-4 py-2 font-medium text-indigo-700 hover:bg-indigo-50">
            Explore quizzes
          </Link>
          <Link href="/dashboard" className="rounded-lg border border-white/40 px-4 py-2 font-medium hover:bg-white/10">
            Create a quiz
          </Link>
        </div>
      </section>

      <section aria-labelledby="popular">
        <h2 id="popular" className="text-xl font-semibold">Popular right now</h2>
        {quizzes.length === 0 ? (
          <p className="mt-3 rounded-xl border bg-white p-6 text-sm text-slate-600">
            No public quizzes yet. Run <code>npm run db:seed</code> to load demo content, then create your first quiz
            from the dashboard.
          </p>
        ) : (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {quizzes.map((q) => (
              <li key={q.slug} className="rounded-xl border bg-white p-5 shadow-sm">
                <Link href={`/quizzes/${q.slug}`} className="font-semibold hover:underline">{q.title}</Link>
                {q.description ? <p className="mt-1 line-clamp-2 text-sm text-slate-600">{q.description}</p> : null}
                <p className="mt-3 text-xs text-slate-500">
                  {q._count.questions} questions · {q.attemptCount} plays
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
