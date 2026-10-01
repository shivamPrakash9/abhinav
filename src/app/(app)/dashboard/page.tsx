import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const user = await requireUser();
  const quizzes = await prisma.quiz.findMany({
    where: { authorId: user.id },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { id: true, slug: true, title: true, status: true, visibility: true, attemptCount: true, _count: { select: { questions: true } } },
  });
  const attempts = await prisma.attempt.findMany({
    where: { userId: user.id, status: 'GRADED' },
    orderBy: { submittedAt: 'desc' },
    take: 10,
    select: { id: true, score: true, accuracy: true, submittedAt: true, quiz: { select: { title: true, slug: true } } },
  });

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <a href="/dashboard/new" className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">New quiz</a>
      </div>
      <section aria-labelledby="my-quizzes">
        <h2 id="my-quizzes" className="font-semibold">My quizzes ({quizzes.length})</h2>
        {quizzes.length === 0 ? (
          <p className="mt-2 rounded-xl border bg-white p-5 text-sm text-slate-600">No quizzes yet. Create your first one.</p>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {quizzes.map((q) => (
              <li key={q.id} className="rounded-xl border bg-white p-4">
                <p className="font-medium">{q.title}</p>
                <p className="text-xs text-slate-500">{q.status} · {q.visibility} · {q._count.questions} Qs · {q.attemptCount} plays</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="recent">
        <h2 id="recent" className="font-semibold">Recent attempts</h2>
        {attempts.length === 0 ? (
          <p className="mt-2 rounded-xl border bg-white p-5 text-sm text-slate-600">No graded attempts yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {attempts.map((a) => (
              <li key={a.id} className="rounded-xl border bg-white p-4 text-sm">
                <a className="font-medium hover:underline" href={`/attempts/${a.id}/results`}>{a.quiz.title}</a>
                <span className="text-slate-500"> · {a.score} pts · {Math.round((a.accuracy ?? 0) * 100)}%</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
