'use client';

import * as React from 'react';
import { joinLiveSession } from '@/actions/session';
import { useRouter } from 'next/navigation';

export default function LiveJoinForm() {
  const router = useRouter();
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await joinLiveSession({ code, displayName: name });
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    router.push(`/live/${code.toUpperCase().trim()}?session=${res.data.sessionId}&participant=${res.data.participantId}`);
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-md space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
      <h1 className="text-xl font-bold">Join a live room</h1>
      <div>
        <label htmlFor="code" className="text-sm font-medium">Room code</label>
        <input id="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="KQ7XPA" maxLength={6} required pattern="[A-HJ-NP-Z2-9]{6}" className="mt-1 w-full rounded-lg border px-3 py-2 tracking-[0.3em] uppercase" autoComplete="off" />
      </div>
      <div>
        <label htmlFor="name" className="text-sm font-medium">Display name</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} maxLength={24} className="mt-1 w-full rounded-lg border px-3 py-2" autoComplete="nickname" />
      </div>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      <button type="submit" disabled={busy} className="w-full rounded-lg bg-indigo-600 py-2.5 font-medium text-white disabled:opacity-50">
        {busy ? 'Joining…' : 'Join room'}
      </button>
    </form>
  );
}
