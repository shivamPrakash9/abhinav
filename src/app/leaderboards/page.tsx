import { prisma } from '@/lib/db';
import { getLeaderboard } from '@/lib/game/leaderboard';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Leaderboards' };

export default async function LeaderboardsPage({ searchParams }: { searchParams: Promise<{ scope?: string; quizSlug?: string }> }) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const quizId = params.quizSlug
    ? (await prisma.quiz.findUnique({ where: { slug: params.quizSlug }, select: { id: true } }))?.id
    : undefined;
  const rows = await getLeaderboard(
    { scope: params.scope === 'QUIZ' ? 'QUIZ' : 'GLOBAL', period: 'ALL_TIME', quizId, limit: 25 },
    user?.id ?? null,
  );
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Leaderboard</h1>
      <ol className="rounded-xl border bg-white divide-y">
        {rows.length === 0 ? <li className="p-5 text-sm text-slate-500">No entries yet — be the first.</li> :
          rows.map((e) => (
            <li key={e.userId} className="flex items-center gap-4 px-5 py-3 text-sm">
              <span className="w-8 font-bold text-slate-400">#{e.rank}</span>
              <span className="flex-1 font-medium">{e.displayName}{e.isCurrentUser ? ' (you)' : ''}</span>
              <span className="text-slate-500">{Math.round(e.accuracy * 100)}%</span>
              <span className="font-semibold">{e.score} pts</span>
            </li>
          ))}
      </ol>
    </div>
  );
}
