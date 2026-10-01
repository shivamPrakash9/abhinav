import LivePlayPage from '@/components/live/live-play-client';
export const metadata = { title: 'Join live room' };
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <LivePlayPage code={code.toUpperCase()} />;
}
