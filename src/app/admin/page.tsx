import { requireModerator } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin' };

export default async function AdminPage() {
  await requireModerator();
  const [reports, users, quizzes] = await Promise.all([
    prisma.moderationReport.count({ where: { status: 'OPEN' } }),
    prisma.user.count(),
    prisma.quiz.count(),
  ]);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Moderation</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border bg-white p-5"><p className="text-2xl font-bold">{reports}</p><p className="text-sm text-slate-500">Open reports</p></div>
        <div className="rounded-xl border bg-white p-5"><p className="text-2xl font-bold">{users}</p><p className="text-sm text-slate-500">Users</p></div>
        <div className="rounded-xl border bg-white p-5"><p className="text-2xl font-bold">{quizzes}</p><p className="text-sm text-slate-500">Quizzes</p></div>
      </div>
      <p className="text-sm text-slate-600">Reports queue, ban/unban and hard-delete actions live behind requireModerator(). Extend with tables as needed.</p>
    </div>
  );
}

