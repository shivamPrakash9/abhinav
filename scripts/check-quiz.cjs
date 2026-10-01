const { PrismaClient } = require('@prisma/client');

(async () => {
  const p = new PrismaClient();
  const q = await p.quiz.findFirst({
    where: { slug: 'world-capitals-quiz' },
    include: { questions: { orderBy: { position: 'asc' }, include: { options: true } } },
  });
  for (const x of q.questions) {
    console.log(`${x.type} | ${x.prompt}`);
    for (const o of x.options) console.log(`   - ${o.label} correct=${o.isCorrect}`);
    if (x.acceptedAnswers.length) console.log(`   accepted=${JSON.stringify(x.acceptedAnswers)}`);
  }
  await p.$disconnect();
})();
