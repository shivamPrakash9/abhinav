-- =============================================================================
-- 0002_integrity_constraints
--
-- Constraints and indexes that Prisma's schema language cannot express. These
-- are the database-level safety net for invariants that the application also
-- enforces in Zod — defence in depth against direct SQL writes, future
-- migrations, and bugs in a single code path.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Structural integrity
-- -----------------------------------------------------------------------------

-- A Question belongs to exactly ONE container: a Quiz (quizId) or a
-- QuestionBank (bankId). Never both, never neither.
ALTER TABLE "Question"
  ADD CONSTRAINT "question_container_xor"
  CHECK (num_nonnulls("quizId", "bankId") = 1);

-- A SessionParticipant is either a signed-in user (userId) or an anonymous
-- guest (guestId) — exactly one identity, so scores can never be double-attributed.
ALTER TABLE "SessionParticipant"
  ADD CONSTRAINT "session_participant_identity_xor"
  CHECK (num_nonnulls("userId", "guestId") = 1);

-- -----------------------------------------------------------------------------
-- Value-domain guards
-- -----------------------------------------------------------------------------

ALTER TABLE "Question"
  ADD CONSTRAINT "question_points_positive" CHECK ("points" > 0),
  ADD CONSTRAINT "question_time_limit_range"
    CHECK ("timeLimitSeconds" IS NULL OR ("timeLimitSeconds" BETWEEN 5 AND 3600)),
  -- Choice-based questions need a text prompt; short answers need a prompt too.
  ADD CONSTRAINT "question_prompt_not_blank" CHECK (length(btrim("prompt")) > 0);

ALTER TABLE "Quiz"
  ADD CONSTRAINT "quiz_pass_score_range" CHECK ("passScorePercent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "quiz_question_time_range"
    CHECK ("defaultQuestionTimeSeconds" BETWEEN 5 AND 3600),
  ADD CONSTRAINT "quiz_time_limit_range"
    CHECK ("timeLimitSeconds" IS NULL OR ("timeLimitSeconds" BETWEEN 10 AND 86400)),
  ADD CONSTRAINT "quiz_max_attempts_positive"
    CHECK ("maxAttempts" IS NULL OR "maxAttempts" > 0),
  ADD CONSTRAINT "quiz_title_not_blank" CHECK (length(btrim("title")) > 0);

ALTER TABLE "Attempt"
  ADD CONSTRAINT "attempt_scores_non_negative"
    CHECK (score >= 0 AND "maxScore" >= 0 AND "correctCount" >= 0
           AND "incorrectCount" >= 0 AND "skippedCount" >= 0),
  ADD CONSTRAINT "attempt_accuracy_range"
    CHECK (accuracy IS NULL OR (accuracy >= 0 AND accuracy <= 1)),
  ADD CONSTRAINT "attempt_duration_non_negative"
    CHECK ("durationMs" IS NULL OR "durationMs" >= 0);

ALTER TABLE "Answer"
  ADD CONSTRAINT "answer_time_non_negative" CHECK ("timeSpentMs" >= 0),
  ADD CONSTRAINT "answer_has_a_response"
    CHECK (array_length("selectedOptionIds", 1) IS NOT NULL OR "textAnswer" IS NOT NULL);

ALTER TABLE "SessionAnswer"
  ADD CONSTRAINT "session_answer_time_non_negative" CHECK ("responseMs" >= 0);

ALTER TABLE "LiveSession"
  ADD CONSTRAINT "live_session_capacity_range" CHECK ("maxParticipants" BETWEEN 2 AND 1000),
  ADD CONSTRAINT "live_session_code_format"
    CHECK ("code" ~ '^[A-HJ-NP-Z2-9]{6}$');

ALTER TABLE "Option"
  ADD CONSTRAINT "option_label_not_blank" CHECK (length(btrim("label")) > 0);

-- -----------------------------------------------------------------------------
-- Case-insensitive uniqueness for public identifiers
--
-- "Ada" and "ada" must not be able to claim the same username, and quiz slugs
-- are used in URLs (SEO), so they must be unique case-insensitively too.
-- `lower()` in a partial unique index is the standard Postgres approach —
-- it needs no extensions (unlike citext).
-- -----------------------------------------------------------------------------

CREATE UNIQUE INDEX "User_email_lower_key"
  ON "User" (lower("email")) WHERE "email" IS NOT NULL;

CREATE UNIQUE INDEX "User_username_lower_key"
  ON "User" (lower("username")) WHERE "username" IS NOT NULL;

CREATE UNIQUE INDEX "Quiz_slug_lower_key"
  ON "Quiz" (lower("slug"));

-- -----------------------------------------------------------------------------
-- Partial indexes for the hot read paths
--
-- These are deliberately PARTIAL: they only index rows the query can actually
-- match, which keeps them small and lets the planner use them for an
-- index-only scan on the leaderboard queries.
-- -----------------------------------------------------------------------------

-- Per-quiz leaderboard: rank by score, tie-break by fastest time.
-- Only GRADED attempts are ever ranked.
CREATE INDEX "Attempt_quiz_ranking_idx"
  ON "Attempt" ("quizId", "score" DESC, "durationMs" ASC)
  WHERE status = 'GRADED';

-- Global leaderboard: only real, active players.
CREATE INDEX "User_global_rank_idx"
  ON "User" (xp DESC)
  WHERE "isBanned" = false AND role <> 'ADMIN';

-- Auto-submit sweeper (/api/cron/sweep-attempts) scans only unfinished attempts.
CREATE INDEX "Attempt_expiry_sweep_idx"
  ON "Attempt" ("expiresAt")
  WHERE status = 'IN_PROGRESS';

-- Only ONE attempt may be in progress per (quiz, participant).
--
-- A plain UNIQUE(quizId, participantKey) would be wrong: it would permanently
-- forbid a player from ever retrying a quiz. A PARTIAL unique index enforces the
-- real invariant — no two concurrent attempts — while allowing unlimited
-- sequential ones. It also closes the two-tabs race where both tabs POST
-- /attempts at the same moment.
CREATE UNIQUE INDEX "Attempt_one_in_progress_per_participant"
  ON "Attempt" ("quizId", "participantKey")
  WHERE status = 'IN_PROGRESS';

-- Discovery queries only surface published, public quizzes.
CREATE INDEX "Quiz_public_discovery_idx"
  ON "Quiz" ("publishedAt" DESC)
  WHERE status = 'PUBLISHED' AND visibility = 'PUBLIC';
