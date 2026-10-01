'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { createLiveSession } from '@/actions/session';

export default function HostCreateClient({ quizId, quizTitle }: { quizId: string; quizTitle: string }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await createLiveSession({ quizId, maxParticipants: 100 });
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    router.push(`/host/${res.data.sessionId}`);
  }

  return (
    <form onSubmit={onCreate} className="mx-auto max-w-xl space-y-4 rounded-xl border bg-white p-6">
      <h1 className="text-xl font-bold">Host “{quizTitle}” live</h1>
      <p className="text-sm text-slate-600">
        Creates a room with a 6-character join code. Players join from any device; you control
        start → reveal → scoreboard → next from the host console.
      </p>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      <button type="submit" disabled={busy} className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
        {busy ? 'Creating room…' : 'Create live room'}
      </button>
    </form>
  );
}
