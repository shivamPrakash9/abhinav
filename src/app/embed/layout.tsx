import type { Metadata } from 'next';

export const metadata = {
  title: 'Embed quiz',
  robots: { index: false },
};

/** Embeddable widget shell: compact chrome, no site nav (see root layout). */
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-white p-4">{children}</div>;
}
