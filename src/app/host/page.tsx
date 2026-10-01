import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import HostConsole from '@/components/live/host-console';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Host live' };

export default async function HostPage() {
  const user = await requireUser();
  const quizzes = await prisma.quiz.findMany({
    where: { authorId: user.id, status: 'PUBLISHED' },
    select: { id: true, title: true },
    take: 20,
  });
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Host a live quiz</h1>
      <HostConsole quizzes={quizzes} />
    </div>
  );
}
