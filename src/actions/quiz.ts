'use server';

import { revalidatePath } from 'next/cache';
import type { Prisma, QuestionType } from '@prisma/client';

import { requireUser, requireModerator } from '@/lib/auth';
import { prisma, isUniqueViolation } from '@/lib/db';
import { AppError, actionFail, actionOk, type ActionResult } from '@/lib/errors';
import { applyPolicy, throwIfLimited } from '@/lib/ratelimit';
import { slugify, withSlugSuffix } from '@/lib/game/codes';
import {
  normalizeTags,
  publishQuizSchema,
  quizCreateSchema,
  quizUpdateSchema,
  type QuizCreateInput,
  type QuestionInput,
} from '@/lib/validation/quiz';

/**
 * Quiz authoring Server Actions.
 *
 * Server Actions are used for first-party mutations (no hand-written fetch, no
 * CORS surface, and Next.js blocks cross-origin POSTs). They return an
 * `ActionResult` instead of throwing, so forms can render field-level errors
 * without an error boundary.
 */

/** Creates a slug that is unique case-insensitively, retrying on collision. */
async function allocateSlug(title: string): Promise<string> {
  const base = slugify(title);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : withSlugSuffix(base);
    const existing = await prisma.quiz.findFirst({
      where: { slug: { equals: candidate, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!existing) return candidate;
  }

  // Extremely unlikely: fall back to a longer random suffix.
  return withSlugSuffix(base, 10);
}

function mapQuestionCreate(question: QuestionInput, index: number) {
  return {
    type: question.type as QuestionType,
    prompt: question.prompt,
    explanation: question.explanation ?? null,
    difficulty: question.difficulty,
    points: question.points,
    timeLimitSeconds: question.timeLimitSeconds,
    position: index,
    caseSensitive: question.caseSensitive,
    acceptedAnswers: question.type === 'SHORT_ANSWER' ? question.acceptedAnswers : [],
    options: {
      create: question.options.map((option, optionIndex) => ({
        label: option.label,
        isCorrect: option.isCorrect,
        position: optionIndex,
      })),
    },
  };
}

/** Upserts tags and links them to the quiz, keeping `usageCount` accurate. */
async function syncQuizTags(
  tx: Prisma.TransactionClient,
  quizId: string,
  tags: readonly string[],
): Promise<void> {
  for (const slug of tags) {
    const tag = await tx.tag.upsert({
      where: { slug },
      create: { slug, name: slug, usageCount: 1 },
      update: { usageCount: { increment: 1 } },
    });
    await tx.quizTag.upsert({
      where: { quizId_tagId: { quizId, tagId: tag.id } },
      create: { quizId, tagId: tag.id },
      update: {},
    });
  }
}

export async function createQuiz(input: unknown): Promise<ActionResult<{ id: string; slug: string }>> {
  try {
    const user = await requireUser();
    throwIfLimited(await applyPolicy('quizCreate', user.id));

    const parsed = quizCreateSchema.safeParse(input);
    if (!parsed.success) {
      return actionFail('VALIDATION', 'Please fix the highlighted problems.', parsed.error.flatten());
    }
    const data: QuizCreateInput = parsed.data;

    const slug = await allocateSlug(data.title);
    const tags = normalizeTags(data.tags);

    const quiz = await prisma.$transaction(async (tx) => {
      const created = await tx.quiz.create({
        data: {
          slug,
          title: data.title,
          description: data.description ?? null,
          categoryId: data.categoryId ?? null,
          authorId: user.id,
          visibility: data.visibility,
          timeLimitSeconds: data.timeLimitSeconds,
          defaultQuestionTimeSeconds: data.defaultQuestionTimeSeconds,
          shuffleQuestions: data.shuffleQuestions,
          shuffleOptions: data.shuffleOptions,
          maxAttempts: data.maxAttempts,
          passScorePercent: data.passScorePercent,
          allowAnonymous: data.allowAnonymous,
          embedEnabled: data.embedEnabled,
          questions: { create: data.questions.map(mapQuestionCreate) },
        },
        select: { id: true, slug: true },
      });

      await syncQuizTags(tx, created.id, tags);
      return created;
    });

    revalidatePath('/dashboard');
    revalidatePath('/quizzes');
    return actionOk(quiz);
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    if (isUniqueViolation(error)) {
      return actionFail('CONFLICT', 'That quiz URL is already taken. Try a different title.');
    }
    console.error('[action createQuiz]', error);
    return actionFail('INTERNAL');
  }
}

/**
 * Updates a quiz. Ownership is enforced by scoping the query to `authorId`,
 * which is an authorization check and a not-found check in one query:
 *   • a non-owner cannot edit the quiz
 *   • a non-owner also cannot distinguish "exists but not yours" from "missing",
 *     so the API never leaks which quiz ids exist (IDOR-safe)
 *
 * Questions are replaced wholesale inside the transaction rather than diffed: a
 * quiz has at most 200 questions, deletes cascade to options, and this avoids an
 * entire class of ordering/diffing bugs. Note that `Answer` rows reference
 * `questionId`, so editing away a question removes its answer history — which is
 * exactly why the edit UI warns before publishing changes to a live quiz.
 */
export async function updateQuiz(
  quizId: string,
  input: unknown,
): Promise<ActionResult<{ id: string; slug: string }>> {
  try {
    const user = await requireUser();
    throwIfLimited(await applyPolicy('quizUpdate', user.id));

    const parsed = quizUpdateSchema.safeParse(input);
    if (!parsed.success) {
      return actionFail('VALIDATION', 'Please fix the highlighted problems.', parsed.error.flatten());
    }
    const data = parsed.data;

    const existing = await prisma.quiz.findFirst({
      where: { id: quizId, authorId: user.id },
      select: { id: true },
    });
    if (!existing) return actionFail('NOT_FOUND', 'That quiz does not exist, or you do not own it.');

    const tags = data.tags ? normalizeTags(data.tags) : undefined;

    const updated = await prisma.$transaction(async (tx) => {
      const quiz = await tx.quiz.update({
        where: { id: existing.id },
        data: {
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
          ...(data.visibility !== undefined ? { visibility: data.visibility } : {}),
          ...(data.timeLimitSeconds !== undefined ? { timeLimitSeconds: data.timeLimitSeconds } : {}),
          ...(data.defaultQuestionTimeSeconds !== undefined
            ? { defaultQuestionTimeSeconds: data.defaultQuestionTimeSeconds }
            : {}),
          ...(data.shuffleQuestions !== undefined ? { shuffleQuestions: data.shuffleQuestions } : {}),
          ...(data.shuffleOptions !== undefined ? { shuffleOptions: data.shuffleOptions } : {}),
          ...(data.maxAttempts !== undefined ? { maxAttempts: data.maxAttempts } : {}),
          ...(data.passScorePercent !== undefined ? { passScorePercent: data.passScorePercent } : {}),
          ...(data.allowAnonymous !== undefined ? { allowAnonymous: data.allowAnonymous } : {}),
          ...(data.embedEnabled !== undefined ? { embedEnabled: data.embedEnabled } : {}),
        },
        select: { id: true, slug: true },
      });

      if (data.questions) {
        await tx.question.deleteMany({ where: { quizId: quiz.id } });
        for (const [index, question] of data.questions.entries()) {
          await tx.question.create({
            data: { ...mapQuestionCreate(question, index), quizId: quiz.id },
          });
        }
      }

      if (tags) {
        await tx.quizTag.deleteMany({ where: { quizId: quiz.id } });
        await syncQuizTags(tx, quiz.id, tags);
      }

      return quiz;
    });

    revalidatePath('/dashboard');
    revalidatePath(`/quizzes/${updated.slug}`);
    return actionOk(updated);
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action updateQuiz]', error);
    return actionFail('INTERNAL');
  }
}

/**
 * Publishing requires at least one question — otherwise a published quiz is a
 * dead end for anyone who follows the shared link.
 */
export async function publishQuiz(
  quizId: string,
  input: unknown = {},
): Promise<ActionResult<{ id: string; slug: string; visibility: string }>> {
  try {
    const user = await requireUser();
    throwIfLimited(await applyPolicy('quizUpdate', user.id));

    const parsed = publishQuizSchema.safeParse(input);
    if (!parsed.success) return actionFail('VALIDATION', undefined, parsed.error.flatten());

    const quiz = await prisma.quiz.findFirst({
      where: { id: quizId, authorId: user.id },
      select: { id: true, _count: { select: { questions: true } } },
    });
    if (!quiz) return actionFail('NOT_FOUND', 'That quiz does not exist, or you do not own it.');
    if (quiz._count.questions === 0) {
      return actionFail('CONFLICT', 'Add at least one question before publishing.');
    }

    const published = await prisma.quiz.update({
      where: { id: quiz.id },
      data: {
        status: 'PUBLISHED',
        visibility: parsed.data.visibility,
        publishedAt: new Date(),
      },
      select: { id: true, slug: true, visibility: true },
    });

    revalidatePath('/quizzes');
    revalidatePath('/dashboard');
    revalidatePath(`/quizzes/${published.slug}`);
    return actionOk(published);
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action publishQuiz]', error);
    return actionFail('INTERNAL');
  }
}

/**
 * Archives rather than deletes. Attempts, leaderboard entries and analytics all
 * reference the quiz, so a hard delete would silently corrupt historical results.
 * Moderators can hard-delete through the admin dashboard when required.
 */
export async function archiveQuiz(quizId: string): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireUser();
    throwIfLimited(await applyPolicy('quizDelete', user.id));

    const result = await prisma.quiz.updateMany({
      where: { id: quizId, authorId: user.id },
      data: { status: 'ARCHIVED', visibility: 'PRIVATE' },
    });
    if (result.count === 0) {
      return actionFail('NOT_FOUND', 'That quiz does not exist, or you do not own it.');
    }

    revalidatePath('/dashboard');
    revalidatePath('/quizzes');
    return actionOk({ id: quizId });
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action archiveQuiz]', error);
    return actionFail('INTERNAL');
  }
}

/**
 * Moderator-only hard delete. Cascades to questions, attempts, answers and
 * leaderboard rows. Always writes an AuditLog entry in the same transaction.
 */
export async function hardDeleteQuiz(quizId: string): Promise<ActionResult<{ id: string }>> {
  try {
    const moderator = await requireModerator();
    throwIfLimited(await applyPolicy('adminAction', moderator.id));

    await prisma.$transaction([
      prisma.auditLog.create({
        data: { actorId: moderator.id, action: 'quiz.hard_delete', target: quizId },
      }),
      prisma.quiz.delete({ where: { id: quizId } }),
    ]);

    revalidatePath('/quizzes');
    revalidatePath('/admin');
    return actionOk({ id: quizId });
  } catch (error) {
    if (error instanceof AppError) return actionFail(error.code, error.message, error.details);
    console.error('[action hardDeleteQuiz]', error);
    return actionFail('INTERNAL');
  }
}


