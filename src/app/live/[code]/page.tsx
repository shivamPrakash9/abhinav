import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import LiveRoomClient from '@/components/live/live-room-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Live room' };

/**
 * The single live-room route. Accepts the public room code (e.g. /live/ABCD12)
 * and, defensively, a session id, so links from the join flow and the host
 * console both resolve here. There must be exactly ONE dynamic segment under
 * /live — Next.js rejects sibling routes with different slug names.
 */
export default async function LiveRoomPage({
  params, searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ session?: string; participant?: string; host?: string }>;
}) {
  const { code } = await params;
  const sp = await searchParams;
  const normalized = code.toUpperCase();

  const session =
    (await prisma.liveSession.findUnique({ where: { code: normalized }, select: { id: true, code: true } })) ??
    (await prisma.liveSession.findUnique({ where: { id: sp.session ?? code }, select: { id: true, code: true } }));
  if (!session) notFound();

  return (
    <LiveRoomClient
      sessionId={sp.session ?? session.id}
      roomCode={session.code}
      participantId={sp.participant ?? ''}
      isHost={sp.host === '1'}
    />
  );
}
