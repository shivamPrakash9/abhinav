import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import HostCreateClient from '@/components/live/host-create-client';

export const dynamic = 'force-dynamic';

export default async function HostNewPage({ searchParams }: { searchParams: Promise<{ quizId?: string }> }) {
  await requireUser();
  const { quizId } = await searchParams;
  if (!quizId) notFound();
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId }, select: { id: true, title: true } });
  if (!quiz) notFound();
  return <HostCreateClient quizId={quiz.id} quizTitle={quiz.title} />;
}

