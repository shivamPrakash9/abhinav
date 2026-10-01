const { PrismaClient } = require('@prisma/client');

(async () => {
  const p = new PrismaClient();
  try {
    console.log(JSON.stringify({
      quizzes: await p.quiz.count(),
      published: await p.quiz.count({ where: { status: 'PUBLISHED' } }),
      attempts: await p.attempt.count(),
      leaderboard: await p.leaderboardEntry.count(),
      sessions: await p.liveSession.count(),
    }));
  } catch (e) {
    console.error('ERR', e.message);
  } finally {
    await p.$disconnect();
  }
})();