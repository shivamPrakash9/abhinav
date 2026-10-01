import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function ResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch {
    redirect(`/sign-in?callbackUrl=/attempts/${id}/results`);
  }
  const attempt = await prisma.attempt.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true, score: true, maxScore: true, correctCount: true, incorrectCount: true, skippedCount: true,
      accuracy: true, durationMs: true, submittedAt: true,
      quiz: { select: { title: true, slug: true } },
      answers: { orderBy: { answeredAt: 'asc' }, select: { isCorrect: true, awardedPoints: true, timeSpentMs: true, question: { select: { prompt: true, points: true } } } },
    },
  });
  if (!attempt) notFound();
  const acc = Math.round((attempt.accuracy ?? 0) * 100);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 p-8 text-white">
        <p className="text-sm text-indigo-200">{attempt.quiz.title}</p>
        <h1 className="mt-1 text-3xl font-bold">{attempt.score} / {attempt.maxScore} pts</h1>
        <p className="mt-2 text-indigo-100">{attempt.correctCount} correct · {attempt.incorrectCount} wrong · {attempt.skippedCount} skipped · {acc}% accuracy</p>
      </div>
      <section aria-label="Per-question breakdown" className="rounded-xl border bg-white">
        <ul className="divide-y">
          {attempt.answers.map((a, i) => (
            <li key={i} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
              <span className="flex-1"><strong>Q{i + 1}.</strong> {a.question.prompt}</span>
              <span className={a.isCorrect ? 'font-medium text-green-700' : 'text-slate-500'}>
                {a.isCorrect ? `+${a.awardedPoints}` : '0'} pts
              </span>
              <span className="w-14 text-right text-xs text-slate-500">{(a.timeSpentMs / 1000).toFixed(1)}s</span>
            </li>
          ))}
        </ul>
      </section>
      <div className="flex gap-3">
        <a href={`/quizzes/${attempt.quiz.slug}`} className="rounded-lg border px-4 py-2 text-sm font-medium">Back to quiz</a>
        <a href={`/leaderboards?scope=QUIZ&quizSlug=${attempt.quiz.slug}`} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white">Leaderboard</a>
      </div>
    </div>
  );
}
