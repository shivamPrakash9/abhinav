import { Resend } from 'resend';

import { env } from './env';

/**
 * Email delivery (Resend).
 *
 * Fully optional: with no `RESEND_API_KEY` every function becomes a no-op that
 * logs in development. That keeps local development and a preview deployment
 * working without an email provider, and means a missing variable can never
 * break the quiz flow (email is always a side effect, never load-bearing).
 *
 * Free tier: 3,000 emails/month, capped at 100/day — comfortable for invites and
 * result summaries, but the daily cap is the reason we never send on every answer.
 */

const resend = env.resend.apiKey ? new Resend(env.resend.apiKey) : null;

export function isEmailConfigured(): boolean {
  return resend !== null;
}

type SendResult = { sent: boolean; id?: string; skipped?: boolean; error?: string };

async function send(to: string, subject: string, html: string): Promise<SendResult> {
  if (!resend) {
    if (env.nodeEnv === 'development') {
      console.info(`[email] skipped "${subject}" → ${to} (RESEND_API_KEY not set)`);
    }
    return { sent: false, skipped: true };
  }

  try {
    const response = await resend.emails.send({ from: env.resend.from, to, subject, html });
    if (response.error) return { sent: false, error: response.error.message };
    return { sent: true, id: response.data?.id };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Escapes user-authored strings before interpolating them into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type ResultsEmailInput = {
  to: string;
  displayName: string;
  quizTitle: string;
  quizUrl: string;
  score: number;
  maxScore: number;
  correctCount: number;
  totalQuestions: number;
  accuracy: number;
  passed: boolean;
};

/** Sends the post-attempt summary with a link back to the full breakdown. */
export async function sendResultsEmail(input: ResultsEmailInput): Promise<SendResult> {
  const percent = Math.round(input.accuracy * 100);
  const subject = `${input.passed ? 'You passed' : 'Your results for'} — ${input.quizTitle}`;

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(input.passed ? 'Nice work!' : 'Quiz complete')}</h1>
      <p style="color:#475569;margin:0 0 20px">
        Hi ${escapeHtml(input.displayName)}, here are your results for
        <strong>${escapeHtml(input.quizTitle)}</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0">Score</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right">
            <strong>${input.score} / ${input.maxScore}</strong>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0">Correct answers</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right">
            ${input.correctCount} / ${input.totalQuestions}
          </td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0">Accuracy</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right">${percent}%</td>
        </tr>
      </table>
      <a href="${input.quizUrl}"
         style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">
        View the full breakdown
      </a>
      <p style="color:#94a3b8;font-size:12px;margin-top:24px">
        You are receiving this because you completed a quiz on Quizly.
      </p>
    </div>
  `;

  return send(input.to, subject, html);
}

type InviteEmailInput = {
  to: string;
  quizTitle: string;
  hostName: string;
  joinUrl: string;
  roomCode: string;
};

export async function sendLiveInviteEmail(input: InviteEmailInput): Promise<SendResult> {
  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(input.hostName)} invited you to a live quiz</h1>
      <p style="color:#475569;margin:0 0 16px"><strong>${escapeHtml(input.quizTitle)}</strong></p>
      <p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:0 0 20px">
        ${escapeHtml(input.roomCode)}
      </p>
      <a href="${input.joinUrl}"
         style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">
        Join the room
      </a>
    </div>
  `;

  return send(input.to, `${input.hostName} invited you to "${input.quizTitle}"`, html);
}
