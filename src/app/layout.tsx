import type { Metadata } from 'next';
import { PostHogProvider } from '@/components/analytics/posthog-provider';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Quizly — Create, play & host live quizzes', template: '%s · Quizly' },
  description:
    'Production-ready quiz platform: solo timed quizzes, real-time multiplayer rooms, leaderboards and analytics.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  openGraph: { type: 'website', siteName: 'Quizly', title: 'Quizly', description: 'Create, play & host live quizzes.' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow"
        >
          Skip to content
        </a>
        <header className="border-b bg-white/80 backdrop-blur">
          <nav aria-label="Primary" className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
            <a href="/" className="text-lg font-bold tracking-tight">
              Quizly<span className="text-indigo-600">.</span>
            </a>
            <div className="flex items-center gap-4 text-sm">
              <a className="hover:underline" href="/quizzes">Explore</a>
              <a className="hover:underline" href="/leaderboards">Leaderboards</a>
              <a className="hover:underline" href="/dashboard">Dashboard</a>
              <a
                href="/sign-in"
                className="rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700"
              >
                Sign in
              </a>
            </div>
          </nav>
        </header>
        <PostHogProvider>
          <main id="main" className="mx-auto w-full max-w-6xl px-4 py-8">{children}</main>
        </PostHogProvider>
        <footer className="border-t py-8 text-center text-xs text-slate-500">
          Quizly · solo + live quizzes · <a className="underline" href="/embed/demo">embed demo</a>
        </footer>
      </body>
    </html>
  );
}
