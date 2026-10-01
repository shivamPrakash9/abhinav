import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';

/**
 * Authenticated area shell — this is the authorization boundary referenced by
 * src/proxy.ts. The proxy only bounces requests with no session cookie; this
 * layout verifies the session against Postgres, so a forged or stale cookie
 * cannot reach private data. Applies to every page under src/app/(app)/**.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireUser();
  } catch {
    // Includes banned accounts (requireUser throws FORBIDDEN for them).
    redirect('/sign-in');
  }
  return <>{children}</>;
}
