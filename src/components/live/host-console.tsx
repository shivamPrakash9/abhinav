'use client';
import * as React from 'react';
import { createLiveSession, hostControlSession } from '@/actions/session';

/** Host console: create room from own quiz, drive start/reveal/next/end. */
export default function HostConsole({ quizzes }: { quizzes: { id: string; title: string }[] }) {
  const [session, setSession] = React.useState<{ sessionId: string; code: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function create(quizId: string) {
    setError(null);
    const res = await createLiveSession({ quizId, maxParticipants: 100 });
    if (!res.ok) { setError(res.message); return; }
    setSession(res.data);
  }
  async function control(action: 'start' | 'reveal' | 'scoreboard' | 'next' | 'end') {
    if (!session) return;
    const res = await hostControlSession(session.sessionId, { action });
    if (!res.ok) setError(res.message);
  }

  return (
    <div className="space-y-4">
      {!session ? (
        <div className="rounded-xl border bg-white p-5">
          <h2 className="font-semibold">Host a live room</h2>
          <ul className="mt-3 space-y-2">
            {quizzes.map((q) => (
              <li key={q.id} className="flex items-center justify-between gap-3 text-sm">
                <span>{q.title}</span>
                <button onClick={() => void create(q.id)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-white">Host</button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-xl border bg-white p-5">
          <p className="text-3xl font-bold tracking-[0.3em]">{session.code}</p>
          <p className="text-sm text-slate-500">Players join at /play/{session.code}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {(['start', 'reveal', 'scoreboard', 'next', 'end'] as const).map((a) => (
              <button key={a} onClick={() => void control(a)} className="rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-slate-50">{a}</button>
            ))}
          </div>
        </div>
      )}
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
