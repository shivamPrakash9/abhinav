import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';

export const revalidate = 60;

/** Embeddable widget — public quiz data only, permissive frame-ancestors (see next.config). */
export default async function EmbedPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const quiz = await prisma.quiz.findFirst({
    where: { slug, status: 'PUBLISHED', visibility: 'PUBLIC' },
    select: { title: true, description: true, slug: true, _count: { select: { questions: true } } },
  });
  if (!quiz) notFound();
  return (
    <div style={{ fontFamily: 'system-ui', padding: 16, border: '1px solid #e2e8f0', borderRadius: 12, maxWidth: 600 }}>
      <h3 style={{ margin: '0 0 4px' }}>{quiz.title}</h3>
      <p style={{ margin: '0 0 12px', color: '#64748b', fontSize: 13 }}>{quiz._count.questions} questions</p>
      <a href={`/quizzes/${quiz.slug}`} target="_blank" rel="noreferrer" style={{ background: '#4f46e5', color: '#fff', padding: '8px 16px', borderRadius: 8, textDecoration: 'none', fontSize: 14 }}>
        Play quiz
      </a>
    </div>
  );
}
