import { redirect } from 'next/navigation';
import { requireModerator } from '@/lib/auth';

/** Moderation shell: MODERATOR or ADMIN only. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireModerator();
  } catch {
    redirect('/sign-in?callbackUrl=/admin');
  }
  return (
    <div className="space-y-6">
      <nav aria-label="Admin" className="flex gap-4 border-b pb-3 text-sm">
        <a className="font-semibold" href="/admin">Overview</a>
        <a href="/admin/quizzes">Quizzes</a>
        <a href="/admin/reports">Reports</a>
        <a href="/admin/users">Users</a>
      </nav>
      {children}
    </div>
  );
}
