'use client';
import * as React from 'react';
import { useLiveSession } from '@/hooks/use-live-session';
type Props = { sessionId: string; roomCode?: string; code?: string; participantId?: string; isHost?: boolean };
export default function LiveRoomClient(props: Props) {
  const code = props.roomCode ?? props.code ?? '';
  const live = useLiveSession({ url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', roomChannel: `room:${code}`, presenceChannel: `presence:room:${code}` });
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <p className="text-sm text-slate-500">Room {code} · session {props.sessionId.slice(0, 8)}… · {live.status}</p>
      {!live.question ? <p className="rounded-xl border bg-white p-6">Waiting for the host to start…</p> : <div className="rounded-xl border bg-white p-6"><h1 className="text-lg font-semibold">{String((live.question as Record<string, unknown>).prompt ?? 'Question')}</h1></div>}
    </div>
  );
}