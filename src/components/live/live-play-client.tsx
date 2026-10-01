'use client';
import * as React from 'react';
import { joinLiveSession, submitSessionAnswer } from '@/actions/session';
import { useLiveSession } from '@/hooks/use-live-session';

/** Player view: join with code + name, answer live questions as they appear. */
export default function LivePlayPage({ code }: { code: string }) {
  const [name, setName] = React.useState('');
  const [joined, setJoined] = React.useState<Record<string, any> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const live = useLiveSession(joined?.realtime ?? { url: '', anonKey: '', roomChannel: '', presenceChannel: '' });

  async function join(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    const res = await joinLiveSession({ code, displayName: name });
    if (!res.ok) { setError(res.message); return; }
    setJoined(res.data as unknown as Record<string, any>);
    if ((res.data as any).guestToken) {
      try { localStorage.setItem(`quizly-guest-${code}`, (res.data as any).guestToken); } catch {}
    }
  }

  async function answer(optionId?: string) {
    if (!joined || !live.question) return;
    const res = await submitSessionAnswer((joined as any).sessionId, {
      questionId: (live.question as any).questionId,
      selectedOptionIds: optionId ? [optionId] : [],
      responseMs: 1000,
    });
    if (!res.ok) setError(res.message);
  }

  if (!joined) {
    return (
      <form onSubmit={join} className="mx-auto max-w-md space-y-4 rounded-xl border bg-white p-6">
        <h1 className="text-xl font-bold">Join room {code}</h1>
        <label className="block text-sm font-medium">Display name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={24} className="mt-1 w-full rounded-lg border px-3 py-2" />
        </label>
        <button className="w-full rounded-lg bg-indigo-600 py-2 font-medium text-white">Join</button>
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      </form>
    );
  }

  const q = live.question as any;
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <p className="text-sm text-slate-500">Room {code} · {live.count} present · {live.status}</p>
      {!q ? <p className="rounded-xl border bg-white p-6">Waiting for the host to start…</p> : (
        <div className="rounded-xl border bg-white p-6">
          <h1 className="text-lg font-semibold">{q.prompt}</h1>
          <div className="mt-4 space-y-2">
            {(q.options ?? []).map((o: any) => (
              <button key={o.id} onClick={() => void answer(o.id)} className="w-full rounded-lg border px-3 py-2 text-left hover:bg-slate-50">{o.label}</button>
            ))}
          </div>
        </div>
      )}
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
