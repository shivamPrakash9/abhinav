import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Demo seed: 1 category, 1 quiz with 5 questions. Idempotent via slug upserts. */
async function main() {
  const category = await prisma.category.upsert({
    where: { slug: 'general-knowledge' },
    create: { slug: 'general-knowledge', name: 'General Knowledge', description: 'Trivia for everyone' },
    update: {},
  });

  const author = await prisma.user.upsert({
    where: { email: 'demo@quizly.local' },
    create: { email: 'demo@quizly.local', name: 'Demo Author', username: 'demo-author' },
    update: {},
  });

  const quiz = await prisma.quiz.upsert({
    where: { slug: 'world-capitals-quiz' },
    create: {
      slug: 'world-capitals-quiz',
      title: 'World Capitals Quiz',
      description: 'Test your knowledge of world capitals.',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      timeLimitSeconds: 300,
      defaultQuestionTimeSeconds: 30,
      categoryId: category.id,
      authorId: author.id,
      publishedAt: new Date(),
      questions: {
        create: [
          {
            type: 'MULTIPLE_CHOICE', prompt: 'What is the capital of France?', difficulty: 'EASY', points: 10, position: 0,
            options: { create: [
              { label: 'Paris', isCorrect: true, position: 0 },
              { label: 'London', isCorrect: false, position: 1 },
              { label: 'Berlin', isCorrect: false, position: 2 },
              { label: 'Madrid', isCorrect: false, position: 3 },
            ]},
          },
          {
            type: 'TRUE_FALSE', prompt: 'Tokyo is the capital of Japan.', difficulty: 'EASY', points: 10, position: 1,
            options: { create: [
              { label: 'True', isCorrect: true, position: 0 },
              { label: 'False', isCorrect: false, position: 1 },
            ]},
          },
          {
            type: 'SHORT_ANSWER', prompt: 'What is the capital of Australia?', difficulty: 'MEDIUM', points: 20, position: 2,
            acceptedAnswers: ['Canberra'],
          },
        ],
      },
    },
    update: {},
  });

  console.log(`Seeded quiz: ${quiz.slug}`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
