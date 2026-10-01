'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { startAttempt, submitAnswer, finalizeAttempt, type StartAttemptResult } from '@/actions/attempt';
import { formatDuration } from '@/lib/utils';

/**
 * Quiz-taking UI: server-graded answers, countdown with auto-submit.
 * Correctness is NEVER shown until finalize — answers return acceptance only.
 */
export default function QuizPlayClient({ slug }: { slug: string }) {
  const router = useRouter();
  const [state, setState] = React.useState<StartAttemptResult | null>(null);
  const [index, setIndex] = React.useState(0);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [remainingMs, setRemainingMs] = React.useState<number | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const startedAtRef = React.useRef<number>(Date.now());
  const questionStartedRef = React.useRef<number>(Date.now());

  React.useEffect(() => {
    let cancelled = false;
    startAttempt({ quizSlug: slug }).then((res) => {
      if (cancelled) return;
      if (!res.ok) { setError(res.message); return; }
      setState(res.data);
      setRemainingMs(res.data.expiresAt ? Math.max(0, new Date(res.data.expiresAt).getTime() - Date.now()) : null);
      startedAtRef.current = Date.now();
      questionStartedRef.current = Date.now();
    });
    return () => { cancelled = true; };
  }, [slug]);

  // Countdown tick + auto-submit at zero.
  React.useEffect(() => {
    if (!state?.expiresAt) return;
    const expiresAt = state.expiresAt;
    const id = window.setInterval(() => {
      const left = new Date(expiresAt).getTime() - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0) {
        window.clearInterval(id);
        void finalizeAttempt(state.attemptId, { reason: 'timeout' }).then((res) => {
          if (!res.ok) setError(res.message);
          else router.push(`/attempts/${state.attemptId}/results`);
        });
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [state?.attemptId, state?.expiresAt, router]);

  async function handleFinalize(reason: 'user' | 'timeout') {
    if (!state) return;
    const res = await finalizeAttempt(state.attemptId, { reason });
    if (!res.ok) { setError(res.message); return; }
    router.push(`/attempts/${state.attemptId}/results`);
  }

  async function handleSubmitAnswer() {
    if (!state) return;
    const q = state.questions[index];
    if (!q) {
      await handleFinalize('user');
      return;
    }
    setSubmitting(true);
    setError(null);
    const timeSpentMs = Date.now() - questionStartedRef.current;
    const res = await submitAnswer(state.attemptId, {
      questionId: q.id,
      selectedOptionIds: q.type === 'SHORT_ANSWER' ? [] : selected,
      textAnswer: q.type === 'SHORT_ANSWER' ? text : undefined,
      timeSpentMs,
    });
    setSubmitting(false);
    if (!res.ok) { setError(res.message); return; }
    setSelected([]); setText('');
    questionStartedRef.current = Date.now();
    if (index + 1 >= state.questions.length) await handleFinalize('user');
    else setIndex((i) => i + 1);
  }

  async function handleFinishEarly() {
    await handleFinalize('user');
  }

  if (error && !state) {
    return <p role="alert" className="rounded-xl border bg-white p-6 text-sm text-red-700">{error}</p>;
  }
  if (!state) return <p className="rounded-xl border bg-white p-6 text-sm text-slate-600" aria-live="polite">Loading quiz…</p>;

  const q = state.questions[index];
  if (!q) return <p className="rounded-xl border bg-white p-6">No questions.</p>;
  const total = state.questions.length;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center justify-between text-sm">
        <p aria-live="polite">Question {index + 1} of {total}</p>
        {remainingMs !== null ? (
          <p role="timer" aria-label="Time remaining" className={remainingMs < 60_000 ? 'font-bold text-red-600' : 'font-medium'}>
            {formatDuration(remainingMs)}
          </p>
        ) : <p className="text-slate-500">Untimed</p>}
      </div>
      <fieldset className="rounded-xl border bg-white p-6 shadow-sm">
        <legend className="sr-only">Question {index + 1}</legend>
        <h1 className="text-lg font-semibold">{q.prompt}</h1>
        <p className="mt-1 text-xs text-slate-500">{q.points} pts · {q.difficulty}</p>
        <div className="mt-4 space-y-2">
          {q.type === 'SHORT_ANSWER' ? (
            <div>
              <label htmlFor="answer-text" className="text-sm font-medium">Your answer</label>
              <input
                id="answer-text" value={text} onChange={(e) => setText(e.target.value)}
                maxLength={q.maxAnswerLength ?? 500}
                className="mt-1 w-full rounded-lg border px-3 py-2" autoComplete="off"
              />
            </div>
          ) : q.type === 'MULTI_SELECT' ? (
            q.options.map((o) => (
              <label key={o.id} className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 hover:bg-slate-50">
                <input
                  type="checkbox" checked={selected.includes(o.id)}
                  onChange={() => setSelected((s) => (s.includes(o.id) ? s.filter((x) => x !== o.id) : [...s, o.id]))}
                  className="h-4 w-4"
                />
                <span className="text-sm">{o.label}</span>
              </label>
            ))
          ) : (
            q.options.map((o) => (
              <label key={o.id} className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 hover:bg-slate-50">
                <input type="radio" name={`q-${q.id}`} checked={selected[0] === o.id} onChange={() => setSelected([o.id])} className="h-4 w-4" />
                <span className="text-sm">{o.label}</span>
              </label>
            ))
          )}
        </div>
        {error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}
        <div className="mt-5 flex justify-between">
          <button type="button" onClick={() => void handleFinishEarly()} className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-slate-50">
            Finish early
          </button>
          <button
            type="button" onClick={() => void handleSubmitAnswer()} disabled={submitting}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : index + 1 === total ? 'Submit quiz' : 'Next question'}
          </button>
        </div>
      </fieldset>
    </div>
  );
}

