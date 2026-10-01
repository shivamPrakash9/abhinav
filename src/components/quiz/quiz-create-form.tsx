'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { createQuiz } from '@/actions/quiz';

const EMPTY_Q = { type: 'MULTIPLE_CHOICE', prompt: '', difficulty: 'MEDIUM', points: 10, timeLimitSeconds: null, options: [{ label: '', isCorrect: true }, { label: '', isCorrect: false }], acceptedAnswers: [], caseSensitive: false };

export default function QuizCreateForm() {
  const router = useRouter();
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [questions, setQuestions] = React.useState<any[]>([{ ...EMPTY_Q }]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await createQuiz({ title, description, questions });
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    router.push(`/dashboard`);
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Create quiz</h1>
      <div className="rounded-xl border bg-white p-5 space-y-3">
        <div>
          <label htmlFor="title" className="text-sm font-medium">Title</label>
          <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={160} className="mt-1 w-full rounded-lg border px-3 py-2" />
        </div>
        <div>
          <label htmlFor="desc" className="text-sm font-medium">Description</label>
          <textarea id="desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="mt-1 w-full rounded-lg border px-3 py-2" />
        </div>
      </div>
      {questions.map((q, qi) => (
        <fieldset key={qi} className="rounded-xl border bg-white p-5">
          <legend className="px-1 text-sm font-semibold">Question {qi + 1}</legend>
          <label className="text-sm font-medium" htmlFor={`prompt-${qi}`}>Prompt</label>
          <input id={`prompt-${qi}`} value={q.prompt} onChange={(e) => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, prompt: e.target.value } : x)))} className="mt-1 w-full rounded-lg border px-3 py-2" required />
          <div className="mt-3 space-y-2">
            {q.options.map((o: any, oi: number) => (
              <div key={oi} className="flex gap-2">
                <input aria-label={`Option ${oi + 1}`} value={o.label} onChange={(e) => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, options: x.options.map((op: any, j: number) => (j === oi ? { ...op, label: e.target.value } : op)) } : x)))} className="flex-1 rounded-lg border px-3 py-2 text-sm" placeholder={`Option ${oi + 1}`} />
                <label className="flex items-center gap-1 text-xs"><input type="radio" name={`correct-${qi}`} checked={o.isCorrect} onChange={() => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, options: x.options.map((op: any, j: number) => ({ ...op, isCorrect: j === oi })) } : x)))} /> correct</label>
              </div>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex gap-2">
        <button type="button" onClick={() => setQuestions((qs) => [...qs, { ...EMPTY_Q, options: EMPTY_Q.options.map((o) => ({ ...o })) }])} className="rounded-lg border px-4 py-2 text-sm font-medium">Add question</button>
        <button type="submit" disabled={busy} className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : 'Create quiz'}</button>
      </div>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
