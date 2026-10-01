import QuizPlayClient from '@/components/quiz/quiz-play-client';

export const metadata = { title: 'Play quiz' };

export default async function PlayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <QuizPlayClient slug={slug} />;
}
