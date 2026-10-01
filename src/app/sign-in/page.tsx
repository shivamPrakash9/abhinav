import { redirect } from 'next/navigation';
import { auth, signIn } from '@/auth';
import { configuredProviders } from '@/auth.config';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const session = await auth();
  const params = await searchParams;
  if (session?.user) redirect(params.callbackUrl || '/dashboard');

  const callbackUrl = params.callbackUrl || '/dashboard';

  return (
    <div className="mx-auto max-w-md space-y-6 rounded-2xl border bg-white p-8 shadow-sm">
      <div>
        <h1 className="text-2xl font-bold">Welcome back</h1>
        <p className="mt-1 text-sm text-slate-600">Sign in with email-linked OAuth to create quizzes and track scores.</p>
      </div>
      {params.error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          Sign-in failed ({params.error}). {params.error === 'AccessDenied' ? 'Banned accounts and email-less providers are rejected.' : 'Please try again.'}
        </p>
      ) : null}
      <div className="space-y-3">
        {configuredProviders.google ? (
          <form
            action={async () => {
              'use server';
              await signIn('google', { redirectTo: callbackUrl });
            }}
          >
            <button type="submit" className="w-full rounded-lg border px-4 py-2.5 font-medium hover:bg-slate-50">
              Continue with Google
            </button>
          </form>
        ) : null}
        {configuredProviders.github ? (
          <form
            action={async () => {
              'use server';
              await signIn('github', { redirectTo: callbackUrl });
            }}
          >
            <button type="submit" className="w-full rounded-lg border px-4 py-2.5 font-medium hover:bg-slate-50">
              Continue with GitHub
            </button>
          </form>
        ) : null}
        {!configuredProviders.google && !configuredProviders.github ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            No OAuth providers configured. Set <code>AUTH_GOOGLE_ID/SECRET</code> and/or{' '}
            <code>AUTH_GITHUB_ID/SECRET</code> in <code>.env</code>, then restart.
          </p>
        ) : null}
      </div>
      <p className="text-xs text-slate-500">
        Database sessions (30 days). Banned users are rejected at sign-in and on every request.
      </p>
    </div>
  );
}
