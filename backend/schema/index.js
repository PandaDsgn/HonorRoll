// The ~46 boot-time schema-migration functions — split out of index.js
// as part of breaking that monolith into modules. Pure relocation:
// nothing about any function's SQL or behavior changed, only where it
// lives. Order in this file is LOAD-BEARING: several functions await a
// specific other ensureXSchema() as a named dependency, and every
// bootSchemaStep(fn) trigger call below queues onto the SAME serial
// chain (see lib/db.js's own bootSchemaStep) in the exact order those
// trigger calls run — which is this file's own top-to-bottom order,
// unchanged from index.js's original layout. Do not reorder these.
//
// Two schema functions that would otherwise sit in the middle of this
// file (ensureRazorpayPlansSchema/ensureSubscriptionsSchema) are kept
// here in their original relative position even though the BILLING
// business-logic functions they're interleaved with in the original
// file (getRazorpayClient, ensureRazorpayPlan, getEffectivePlanKey,
// checkStudentCap, PLAN_CATALOG) stayed behind in index.js for now —
// those get their own lib/billing.js in a later pass; index.js
// re-imports these two schema functions by name in the meantime.
const { pool, bootSchemaStep } = require('../lib/db');


// The root of multi-tenancy: every college/school is one row here. Several
// other schema functions below need this table to exist before they can add
// a `organization_id` FK column, so this is cached (not re-run) and awaited
// as the first line of each of those, rather than relying on file-order
// execution — the ensureXSchema() calls throughout this file are fire-and-
// forget promises, not actually sequenced, so without an explicit await a
// later ALTER TABLE ... REFERENCES organizations(id) could race the CREATE
// TABLE here and fail.
let organizationsSchemaPromise = null;
function ensureOrganizationsSchema() {
  if (!organizationsSchemaPromise) {
    organizationsSchemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        webhook_secret TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch((err) => console.error('Failed to ensure organizations schema:', err));
  }
  return organizationsSchemaPromise;
}
bootSchemaStep(ensureOrganizationsSchema);

// The global identity table — every other ensureXSchema function in this
// file assumes `users` already exists (memberships.user_id REFERENCES
// users(id), problems.created_by, etc.), but until now nothing actually
// created it: the three column-migration functions right below only ever
// ALTER it, and the production database has had a `users` table since
// before any of this ensureXSchema machinery existed, so the gap was
// invisible there. A genuinely fresh Postgres (a new deployment, this
// repo's own docker-compose `db` service) has no such history — without
// this, table creation, and therefore ALL of it: signup, login, every
// route that touches an account.
//
// id defaults via gen_random_uuid(), a built-in SQL function since
// Postgres 13 — no CREATE EXTENSION needed (unlike pre-13, which required
// pgcrypto or uuid-ossp for this). role/organization_id are included here
// only because ensureUsersOrgColumn below still needs to ADD COLUMN them
// on pre-existing databases that predate this function; a truly fresh
// table gets them from this CREATE TABLE directly instead, same end state
// either way. reset_token/token_expiry back the forgot-password flow
// (POST /api/forgot-password, /api/reset-password) — genuinely missing
// from every ALTER-column function until now, the same blind spot as the
// table itself.
let usersSchemaPromise = null;
function ensureUsersSchema() {
  if (!usersSchemaPromise) {
    usersSchemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        reset_token TEXT,
        token_expiry TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch((err) => console.error('Failed to ensure users schema:', err));
  }
  return usersSchemaPromise;
}
bootSchemaStep(ensureUsersSchema);

// Nullable — has to tolerate whatever pre-multi-tenancy rows still exist
// (this platform started single-tenant). Every new row from here on is
// always given one at the application level (signup, create-student, the
// Google Form webhook, exam/problem creation) — see the routes that use it.
async function ensureUsersOrgColumn() {
  await ensureUsersSchema();
  await ensureOrganizationsSchema();
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id)');
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT`);
  } catch (err) {
    console.error('Failed to ensure users.organization_id:', err);
  }
}
bootSchemaStep(ensureUsersOrgColumn);

// Nullable — a person's display name, collected wherever it's already
// naturally available (a CSV/Google Form "Name" column, or the manual add
// forms) and stored once on the global identity rather than per-org, since
// it's the same person regardless of which organization is asking.
async function ensureUsersNameColumn() {
  await ensureUsersSchema();
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT');
  } catch (err) {
    console.error('Failed to ensure users.name:', err);
  }
}
bootSchemaStep(ensureUsersNameColumn);

// Global, per-identity, not per-org — the Terms of Service/Privacy Policy
// are platform-wide, not something a person accepts separately for every
// institution they belong to. Set once: at signup for an admin (the
// checkbox on that form — see POST /api/organizations/signup), or on first
// login for a teacher/student (accounts admins create for them never ask
// this directly, so their own first login is the only moment to collect
// it — see the requiresTosAcceptance branch in POST /api/login). Superadmin
// sessions never touch this column at all — platform staff, not a
// customer accepting terms.
async function ensureUsersTosColumn() {
  await ensureUsersSchema();
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at TIMESTAMPTZ');
  } catch (err) {
    console.error('Failed to ensure users.tos_accepted_at:', err);
  }
}
bootSchemaStep(ensureUsersTosColumn);

// The other founding table nothing ever created — same gap as `users`
// (see ensureUsersSchema's own comment): every ALTER-column function below
// (org/subject/submission_mode/time_limit) and everything that joins
// against `problems` assumed this table already existed, which was only
// ever true because the real production database predates this whole
// ensureXSchema migration pattern. Base columns only — organization_id,
// subject_id, time_limit_seconds, submission_mode, and assignment_no all
// still arrive via their own existing ADD COLUMN IF NOT EXISTS functions
// right below, unchanged; this only adds the CREATE TABLE those functions
// were silently relying on. Schema (types, constraints, defaults) copied
// directly from the real production database via information_schema/
// pg_constraint, not guessed from call sites.
let problemsSchemaPromise = null;
function ensureProblemsSchema() {
  if (!problemsSchemaPromise) {
    problemsSchemaPromise = ensureUsersSchema().then(() => pool.query(`
      CREATE TABLE IF NOT EXISTS problems (
        id SERIAL PRIMARY KEY,
        title VARCHAR NOT NULL,
        description TEXT NOT NULL,
        difficulty VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by UUID REFERENCES users(id),
        opens_at TIMESTAMPTZ,
        closes_at TIMESTAMPTZ,
        notified BOOLEAN DEFAULT false
      )
    `)).catch((err) => console.error('Failed to ensure problems schema:', err));
  }
  return problemsSchemaPromise;
}
bootSchemaStep(ensureProblemsSchema);

// submissions/test_cases/starter_code are the third, fourth, and fifth
// founding tables with the same never-created gap — grouped in one
// function since all three depend on nothing but `problems` and each
// other's absence doesn't block the others. Schema again copied verbatim
// from production.
let judgeDataSchemaPromise = null;
function ensureJudgeDataSchema() {
  if (!judgeDataSchemaPromise) {
    judgeDataSchemaPromise = Promise.all([ensureProblemsSchema(), ensureUsersSchema()]).then(() => Promise.all([
      pool.query(`
        CREATE TABLE IF NOT EXISTS submissions (
          id SERIAL PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
          language VARCHAR NOT NULL,
          code TEXT NOT NULL,
          status VARCHAR NOT NULL,
          passed_count INTEGER NOT NULL DEFAULT 0,
          total_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT now()
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS test_cases (
          id SERIAL PRIMARY KEY,
          problem_id INTEGER REFERENCES problems(id) ON DELETE CASCADE,
          input TEXT NOT NULL,
          expected_output TEXT NOT NULL,
          is_hidden BOOLEAN DEFAULT true
        )
      `),
      pool.query(`
        CREATE TABLE IF NOT EXISTS starter_code (
          id SERIAL PRIMARY KEY,
          problem_id INTEGER REFERENCES problems(id) ON DELETE CASCADE,
          language VARCHAR NOT NULL,
          code TEXT NOT NULL
        )
      `),
    ])).catch((err) => console.error('Failed to ensure judge data schema:', err));
  }
  return judgeDataSchemaPromise;
}
bootSchemaStep(ensureJudgeDataSchema);

// Cross-student code-similarity flags for coding assignments — same shape
// and review workflow as scan_plagiarism_flags (open/confirmed/dismissed),
// just keyed against `submissions` instead of `scan_submissions`, and with
// no flag_type column since there's only ever one comparator here.
let submissionPlagiarismFlagsSchemaPromise = null;
function ensureSubmissionPlagiarismFlagsSchema() {
  if (!submissionPlagiarismFlagsSchemaPromise) {
    submissionPlagiarismFlagsSchemaPromise = ensureJudgeDataSchema().then(async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS submission_plagiarism_flags (
          id SERIAL PRIMARY KEY,
          problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
          submission_a_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
          submission_b_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
          similarity_score REAL NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'reviewed_confirmed', 'reviewed_dismissed')) DEFAULT 'open',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (submission_a_id < submission_b_id)
        )
      `);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS submission_plagiarism_flags_pair_idx ON submission_plagiarism_flags(problem_id, submission_a_id, submission_b_id)');
      await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS code_plagiarism_threshold REAL NOT NULL DEFAULT 0.6');
    }).catch((err) => console.error('Failed to ensure submission_plagiarism_flags schema:', err));
  }
  return submissionPlagiarismFlagsSchemaPromise;
}
bootSchemaStep(ensureSubmissionPlagiarismFlagsSchema);

async function ensureProblemsOrgColumn() {
  await ensureProblemsSchema();
  await ensureOrganizationsSchema();
  try {
    await pool.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id)');
  } catch (err) {
    console.error('Failed to ensure problems.organization_id:', err);
  }
}
bootSchemaStep(ensureProblemsOrgColumn);

// Auto-provisions the time-tracking table if it doesn't exist yet, so
// "true time on task" tracking (see POST /api/problems/:id/time-log) works
// immediately on deploy without a manual migration step. One row per
// (user, problem), accumulated across every visit — not per-attempt, since a
// student can spend time reading/re-reading a problem between submissions.
async function ensureTimeTrackingSchema() {
  await ensureUsersSchema();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS problem_time_logs (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
        total_seconds INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, problem_id)
      )
    `);
  } catch (err) {
    console.error('Failed to ensure time-tracking schema:', err);
  }
}
bootSchemaStep(ensureTimeTrackingSchema);

// Auto-provisions the optional per-assignment time limit column. NULL (the
// default for every existing row) means "no limit" — this is deliberately
// nullable rather than defaulting to 0, so "unset" and "zero minutes" can
// never be confused with each other anywhere downstream.
async function ensureTimeLimitColumn() {
  await ensureProblemsSchema();
  try {
    await pool.query(`ALTER TABLE problems ADD COLUMN IF NOT EXISTS time_limit_seconds INTEGER`);
  } catch (err) {
    console.error('Failed to ensure time_limit_seconds column:', err);
  }
}
bootSchemaStep(ensureTimeLimitColumn);

// Auto-provisions the optional per-assignment plagiarism threshold override
// (scan-mode assignments only — see runTextPlagiarismComparator/
// runTypedTextPlagiarismComparator). NULL means "use the org-wide
// organizations.scan_plagiarism_threshold instead", same nullable-means-
// unset idiom as time_limit_seconds above, since a teacher usually wants
// the org default and only needs to override it for a specific assignment.
async function ensureProblemsPlagiarismThresholdColumn() {
  await ensureProblemsSchema();
  try {
    await pool.query(`ALTER TABLE problems ADD COLUMN IF NOT EXISTS plagiarism_threshold REAL`);
  } catch (err) {
    console.error('Failed to ensure problems.plagiarism_threshold column:', err);
  }
}
bootSchemaStep(ensureProblemsPlagiarismThresholdColumn);

// Auto-provisions the exam data model: `exams` (the container — total time,
// total marks, webcam requirement, scheduling) and `exam_items` (the actual
// questions inside it). One `exams` row can hold any mix of item types —
// coding items point at an existing `problems` row (reusing its test cases,
// starter code, and the judge pipeline entirely) rather than duplicating
// that infrastructure; mcq/short/long are self-contained on the item row
// itself since they have nothing to reuse.
//
// `total_marks` is deliberately NOT admin-editable directly — it's the sum
// of item marks, recomputed server-side on every create/update, so it can
// never silently drift out of sync with what the exam actually contains.
// Cached like ensureOrganizationsSchema() above — ensureExamsSubjectColumn()
// further down also awaits this, so a second concurrent caller reuses the
// same in-flight promise instead of racing its own CREATE TABLE IF NOT
// EXISTS against this one.
let examSchemaPromise = null;
function ensureExamSchema() {
  if (!examSchemaPromise) {
    examSchemaPromise = ensureExamSchemaImpl().catch((err) => console.error('Failed to ensure exam schema:', err));
  }
  return examSchemaPromise;
}
async function ensureExamSchemaImpl() {
  await ensureOrganizationsSchema();
  await ensureUsersSchema();
  {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exams (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        total_marks INTEGER NOT NULL DEFAULT 0,
        total_time_seconds INTEGER NOT NULL,
        webcam_required BOOLEAN NOT NULL DEFAULT false,
        opens_at TIMESTAMPTZ,
        closes_at TIMESTAMPTZ,
        created_by uuid REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('ALTER TABLE exams ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id)');
    await pool.query('ALTER TABLE exams ADD COLUMN IF NOT EXISTS calculator_allowed BOOLEAN NOT NULL DEFAULT false');
    await pool.query('ALTER TABLE exams ADD COLUMN IF NOT EXISTS calculator_type TEXT');
    // Mirrors problems.notified — flips true once sweepAssignmentExamNotifications
    // has fanned out a "new exam available" notification for this row, so a
    // restart of the sweep never double-notifies the same exam.
    await pool.query('ALTER TABLE exams ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT false');
    await pool.query(`
      ALTER TABLE exams ADD CONSTRAINT exams_calculator_type_check
        CHECK (calculator_type IS NULL OR calculator_type IN ('basic', 'scientific', 'programmer', 'statistics', 'financial'))
    `).catch((err) => { if (err.code !== '42710') throw err; });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exam_items (
        id SERIAL PRIMARY KEY,
        exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('mcq', 'short', 'long', 'coding', 'scan')),
        position INTEGER NOT NULL DEFAULT 0,
        marks INTEGER NOT NULL DEFAULT 1,
        -- NULL = no per-item sub-limit; the item is only bounded by the
        -- exam's overall total_time_seconds countdown.
        time_limit_seconds INTEGER,
        prompt TEXT,
        -- mcq only: [{ id, text }, ...]
        options JSONB,
        -- mcq only: must match one options[].id
        correct_option_id TEXT,
        -- short/long only
        word_limit INTEGER,
        -- coding only, "reuse" mode: an existing assignment — its
        -- problems/test_cases/starter_code tables and the sandboxed judge
        -- are reused entirely, and starter_code/test_cases below stay NULL.
        problem_id INTEGER REFERENCES problems(id) ON DELETE SET NULL
      )
    `);
    // coding only, "custom" mode (problem_id NULL instead): the question is
    // authored inline in the exam builder rather than reusing an assignment,
    // so its starter code and test cases live here instead of in
    // starter_code/test_cases. Added via ALTER rather than in the CREATE
    // TABLE above since exam_items already existed in production before
    // this — CREATE TABLE IF NOT EXISTS wouldn't retroactively add columns.
    await pool.query('ALTER TABLE exam_items ADD COLUMN IF NOT EXISTS starter_code JSONB');
    await pool.query('ALTER TABLE exam_items ADD COLUMN IF NOT EXISTS test_cases JSONB');
    // Widens the type CHECK for exam_items tables that already existed
    // before 'scan' was added — same DROP/re-ADD pattern as
    // ensureExamProctoringSchema's end_reason constraint further down.
    await pool.query('ALTER TABLE exam_items DROP CONSTRAINT IF EXISTS exam_items_type_check');
    await pool.query(`ALTER TABLE exam_items ADD CONSTRAINT exam_items_type_check CHECK (type IN ('mcq', 'short', 'long', 'coding', 'scan'))`);

    // Reusable item library — same column shape as exam_items minus
    // exam_id/position (an item lives here detached from any specific exam
    // until a teacher inserts it into one, at which point ExamForm copies
    // its fields into a fresh exam_items row; editing the copy never
    // touches the bank original). subject_id NULL = org-wide, admin-only
    // (mirrors exams.subject_id's own "no subject" option and the same
    // enforceSubjectAuthority gate).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS question_bank_items (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('mcq', 'short', 'long', 'coding', 'scan')),
        marks INTEGER NOT NULL DEFAULT 1,
        time_limit_seconds INTEGER,
        prompt TEXT,
        options JSONB,
        correct_option_id TEXT,
        word_limit INTEGER,
        problem_id INTEGER REFERENCES problems(id) ON DELETE SET NULL,
        starter_code JSONB,
        test_cases JSONB,
        created_by uuid REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS question_bank_items_subject_idx ON question_bank_items(subject_id)');
  }
}
bootSchemaStep(ensureExamSchema);

// Auto-provisions the exam-taking data model: one `exam_attempts` row per
// (exam, student) — the UNIQUE(exam_id, user_id) constraint is what makes
// "one attempt ever, no resuming after you leave" structural rather than an
// app-level check that could race — plus `exam_answers`, one row per item
// answered. Separate from ensureExamSchema() above since that one only
// covers the admin-authored exam definition, not a student's progress
// through it.
async function ensureExamSubmissionSchema() {
  await ensureUsersSchema();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exam_attempts (
        id SERIAL PRIMARY KEY,
        exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deadline_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        end_reason TEXT CHECK (end_reason IN (
          'manual', 'time_up', 'violation_visibility', 'violation_blur',
          'violation_fullscreen_exit', 'violation_unload', 'reopened_stale'
        )),
        score INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (exam_id, user_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exam_answers (
        id SERIAL PRIMARY KEY,
        attempt_id INTEGER NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES exam_items(id) ON DELETE CASCADE,
        selected_option_id TEXT,
        text_answer TEXT,
        language TEXT,
        code TEXT,
        is_correct BOOLEAN,
        passed_count INTEGER,
        total_count INTEGER,
        marks_awarded INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (attempt_id, item_id)
      )
    `);

    // scan-type items don't get their own per-item answer row the way
    // mcq/short/long/coding do — every scan item in one attempt is
    // answered on paper and captured together into ONE compiled PDF (see
    // POST /api/exams/:id/submit), same "one PDF per submission" shape as
    // scan_submissions for assignments. These columns hold that PDF and
    // its OCR result at the ATTEMPT level, not per-item.
    await pool.query('ALTER TABLE exam_attempts ADD COLUMN IF NOT EXISTS scan_storage_key TEXT');
    await pool.query('ALTER TABLE exam_attempts ADD COLUMN IF NOT EXISTS scan_status TEXT');
    await pool.query('ALTER TABLE exam_attempts DROP CONSTRAINT IF EXISTS exam_attempts_scan_status_check');
    await pool.query(`ALTER TABLE exam_attempts ADD CONSTRAINT exam_attempts_scan_status_check CHECK (scan_status IN ('pending', 'processing', 'ocr_done', 'ocr_failed'))`);
    await pool.query('ALTER TABLE exam_attempts ADD COLUMN IF NOT EXISTS scan_ocr_text TEXT');
    await pool.query('ALTER TABLE exam_attempts ADD COLUMN IF NOT EXISTS scan_ocr_pages JSONB');
    await pool.query('ALTER TABLE exam_attempts ADD COLUMN IF NOT EXISTS scan_ocr_error TEXT');
    await pool.query('ALTER TABLE exam_attempts ADD COLUMN IF NOT EXISTS scan_ocr_completed_at TIMESTAMPTZ');

    // One row per (attempt, scan item) — where a teacher's marks_awarded
    // and the AI's aid-only assessment for that specific item live, since
    // the OCR text itself is one blob per attempt (scan_ocr_text above),
    // not split per item. Directly mirrors scan_submission_answers.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exam_scan_answers (
        id SERIAL PRIMARY KEY,
        attempt_id INTEGER NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES exam_items(id) ON DELETE CASCADE,
        ai_assessment TEXT,
        marks_awarded INTEGER,
        UNIQUE (attempt_id, item_id)
      )
    `);

    // A teacher's free-text note — one per answered item (any type, not
    // just the manually-graded ones), plus one covering the whole attempt.
    // Independent of marks_awarded/ai_assessment, same shape as the
    // scan_submission_answers/scan_submissions remarks columns.
    await pool.query('ALTER TABLE exam_answers ADD COLUMN IF NOT EXISTS remarks TEXT');
    await pool.query('ALTER TABLE exam_scan_answers ADD COLUMN IF NOT EXISTS remarks TEXT');
    await pool.query('ALTER TABLE exam_attempts ADD COLUMN IF NOT EXISTS overall_remarks TEXT');
    // Groq assist-only suggestion for short/long items, same role as
    // exam_scan_answers.ai_assessment — never touches marks_awarded, purely
    // a note for the teacher grading the item manually. See
    // runExamShortLongAiAssessment for how it gets populated.
    await pool.query('ALTER TABLE exam_answers ADD COLUMN IF NOT EXISTS ai_assessment TEXT');
  } catch (err) {
    console.error('Failed to ensure exam submission schema:', err);
  }
}
bootSchemaStep(ensureExamSubmissionSchema);

// Auto-provisions the ML webcam-proctoring flag log, and extends
// exam_attempts.end_reason to allow the two new major-flag violation
// reasons. That CHECK constraint already exists in production from before
// this feature (see ensureExamSubmissionSchema above), so — unlike a fresh
// CREATE TABLE — widening it needs an explicit DROP+ADD, run idempotently
// on every boot the same way the rest of this file's schema is evolved.
async function ensureExamProctoringSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exam_proctor_flags (
        id SERIAL PRIMARY KEY,
        attempt_id INTEGER NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
        severity TEXT NOT NULL CHECK (severity IN ('minor', 'major')),
        flag_type TEXT NOT NULL,
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('ALTER TABLE exam_attempts DROP CONSTRAINT IF EXISTS exam_attempts_end_reason_check');
    await pool.query(`
      ALTER TABLE exam_attempts ADD CONSTRAINT exam_attempts_end_reason_check CHECK (end_reason IN (
        'manual', 'time_up', 'violation_visibility', 'violation_blur',
        'violation_fullscreen_exit', 'violation_unload', 'reopened_stale',
        'violation_proctor_absence', 'violation_proctor_phone'
      ))
    `);
  } catch (err) {
    console.error('Failed to ensure exam proctoring schema:', err);
  }
}
bootSchemaStep(ensureExamProctoringSchema);

// Auto-provisions the configurable grade-band scale used for the
// individual exam/assignment score tag — e.g. "90-100 -> Excellent". Now
// per-organization (each org gets its own scale, seeded with these same
// defaults at signup time — see POST /api/organizations/signup) rather
// than the single shared platform-wide scale this started as.
async function ensureGradeBandsSchema() {
  await ensureOrganizationsSchema();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS grade_bands (
        id SERIAL PRIMARY KEY,
        label TEXT NOT NULL,
        min_percent NUMERIC NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('ALTER TABLE grade_bands ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id)');
  } catch (err) {
    console.error('Failed to ensure grade bands schema:', err);
  }
}
bootSchemaStep(ensureGradeBandsSchema);

// Auto-provisions the per-organization on/off switches for which of the two
// student-facing tags are shown to students. Now one row per org (unique on
// organization_id) rather than the single global singleton row (id pinned
// to 1) this started as — that old shape can't hold more than one
// organization's settings, so on first boot after this change we detect it
// (no organization_id column yet) and drop+recreate clean. Safe: this table
// only ever held disposable default-toggle config, never real user data.
async function ensureTagVisibilitySchema() {
  await ensureOrganizationsSchema();
  try {
    const colCheck = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'tag_visibility_settings' AND column_name = 'organization_id'`
    );
    if (colCheck.rows.length === 0) {
      await pool.query('DROP TABLE IF EXISTS tag_visibility_settings');
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tag_visibility_settings (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER UNIQUE REFERENCES organizations(id),
        show_percentile_tag BOOLEAN NOT NULL DEFAULT true,
        show_grade_tag BOOLEAN NOT NULL DEFAULT false
      )
    `);
  } catch (err) {
    console.error('Failed to ensure tag visibility schema:', err);
  }
}
bootSchemaStep(ensureTagVisibilitySchema);

// Global-identity membership table — the new source of truth for "who is
// this person in which organization, and with what role." `users` is being
// migrated to a pure identity (one row per email, shared across every
// organization that email belongs to — e.g. a student who also tutors at a
// separate institution); `users.role`/`users.organization_id` stay in the
// schema, untouched and unused going forward, purely as a rollback safety
// net during the cutover. The backfill below is a one-way, purely additive
// copy (never touches the old columns, idempotent via ON CONFLICT, safe to
// re-run every boot) so every pre-existing user ends up with exactly one
// membership row before any route starts reading from this table instead.
// org_unit_id is deliberately omitted from the initial CREATE TABLE — it
// references org_units, which doesn't exist until the org-structure-tree
// schema function runs, so it's added the same way organization_id is
// added to every other table in this file: a separate ALTER TABLE ADD
// COLUMN IF NOT EXISTS once its target table exists.
async function ensureMembershipsSchema() {
  await ensureOrganizationsSchema();
  await ensureUsersSchema();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memberships (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, organization_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS memberships_org_role_idx ON memberships(organization_id, role)');
    await pool.query(`
      INSERT INTO memberships (user_id, organization_id, role)
      SELECT id, organization_id, role FROM users WHERE organization_id IS NOT NULL
      ON CONFLICT (user_id, organization_id) DO NOTHING
    `);
  } catch (err) {
    console.error('Failed to ensure memberships schema:', err);
  }
}
bootSchemaStep(ensureMembershipsSchema);

// One row per (student, academic year) of pre-platform score data, for
// institutions onboarding after already having a track record — imported
// via CSV (see POST /api/admin/legacy-scores/import) rather than entered
// per-assignment, since no actual problems/exams exist in this system for
// that history. UNIQUE(organization_id, user_id, academic_year) so
// re-uploading a corrected CSV for the same year overwrites in place
// (ON CONFLICT DO UPDATE) instead of accumulating duplicate rows. Both
// score columns are independently nullable — a school might only have
// exam records for an old year, or only assignment records, not
// necessarily both.
async function ensureLegacyScoresSchema() {
  await ensureOrganizationsSchema();
  await ensureUsersSchema();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS legacy_scores (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        academic_year TEXT NOT NULL,
        assignment_score_percent REAL CHECK (assignment_score_percent IS NULL OR (assignment_score_percent >= 0 AND assignment_score_percent <= 100)),
        exam_score_percent REAL CHECK (exam_score_percent IS NULL OR (exam_score_percent >= 0 AND exam_score_percent <= 100)),
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (organization_id, user_id, academic_year)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS legacy_scores_user_idx ON legacy_scores(user_id)');
  } catch (err) {
    console.error('Failed to ensure legacy_scores schema:', err);
  }
}
bootSchemaStep(ensureLegacyScoresSchema);

// A student's request to correct their own roster info (name, roll number,
// or anything else — `field` is free text, not an enum, since a student
// might reasonably need to flag something outside the two recognized
// fields). Routed to the institution's ADMIN queue rather than the super admin.
// On approval, `field` values of exactly 'name' or 'roll_number' are auto-applied
// to the DB; anything else is just recorded as approved for a human to action
// elsewhere, since arbitrary free-text fields can't be safely auto-applied.
async function ensureProfileChangeRequestsSchema() {
  await ensureOrganizationsSchema();
  await ensureUsersSchema();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profile_change_requests (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        current_value TEXT,
        requested_value TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        reviewed_by UUID REFERENCES users(id),
        reviewed_at TIMESTAMPTZ,
        review_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS profile_change_requests_user_idx ON profile_change_requests(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS profile_change_requests_status_idx ON profile_change_requests(status)');

    // Two-tier review: a student's request first lands with their own
    // org's admin (see POST /api/admin/profile-change-requests/:id/review).
    // An admin resolves it directly (approve/reject), or escalates it —
    // only escalated requests ever reach the superadmin queue (see GET
    // /api/superadmin/profile-change-requests's default filter below).
    await pool.query('ALTER TABLE profile_change_requests DROP CONSTRAINT IF EXISTS profile_change_requests_status_check');
    await pool.query(`ALTER TABLE profile_change_requests ADD CONSTRAINT profile_change_requests_status_check CHECK (status IN ('pending', 'escalated', 'approved', 'rejected'))`);
    await pool.query('ALTER TABLE profile_change_requests ADD COLUMN IF NOT EXISTS escalated_by UUID REFERENCES users(id)');
    await pool.query('ALTER TABLE profile_change_requests ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE profile_change_requests ADD COLUMN IF NOT EXISTS escalation_note TEXT');
  } catch (err) {
    console.error('Failed to ensure profile_change_requests schema:', err);
  }
}
bootSchemaStep(ensureProfileChangeRequestsSchema);

// A general, free-form message an institution admin sends directly to the
// platform owner — for anything that doesn't fit the profile-change-request
// escalation flow above, which requires a student to have filed a request
// first. Its own table since subject/message has nothing in common with
// profile_change_requests' field/current/requested shape.
async function ensureAdminRequestsSchema() {
  await ensureOrganizationsSchema();
  await ensureUsersSchema();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_requests (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        response_note TEXT,
        resolved_by UUID REFERENCES users(id),
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS admin_requests_org_idx ON admin_requests(organization_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS admin_requests_status_idx ON admin_requests(status)');
  } catch (err) {
    console.error('Failed to ensure admin_requests schema:', err);
  }
}
bootSchemaStep(ensureAdminRequestsSchema);

// The public /contact page's inbox — anyone reaching the marketing site,
// not necessarily an existing user of the platform at all (a prospective
// institution, a parent, a journalist), so this deliberately carries its
// own name/mobile/email rather than pointing at a `users` row the way
// admin_requests does. No organization_id either, for the same reason —
// there may not be one yet.
async function ensureContactMessagesSchema() {
  await ensureUsersSchema(); // resolved_by REFERENCES users(id) below
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contact_messages (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        mobile TEXT NOT NULL,
        email TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        response_note TEXT,
        resolved_by UUID REFERENCES users(id),
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS contact_messages_status_idx ON contact_messages(status)');
  } catch (err) {
    console.error('Failed to ensure contact_messages schema:', err);
  }
}
bootSchemaStep(ensureContactMessagesSchema);

// An admin's structured request to have another admin added to their own
// org — unlike admin_requests above (a free-form message a human has to
// read and act on manually), approving one of these actually creates the
// membership (see POST /api/superadmin/add-admin-requests/:id/approve),
// so it needs the new admin's name/email as real columns, not buried in
// prose. Org signup only ever creates one admin membership and nothing in
// AdminDashboard lets an admin add a co-admin directly (unlike
// teacher/student, which they can add themselves) — this is that missing
// path, gated through the superadmin since admin is the org's top role.
async function ensureAddAdminRequestsSchema() {
  await ensureOrganizationsSchema();
  await ensureUsersSchema();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS add_admin_requests (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        new_admin_name TEXT,
        new_admin_email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        reviewed_by UUID REFERENCES users(id),
        reviewed_at TIMESTAMPTZ,
        review_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS add_admin_requests_org_idx ON add_admin_requests(organization_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS add_admin_requests_status_idx ON add_admin_requests(status)');
  } catch (err) {
    console.error('Failed to ensure add_admin_requests schema:', err);
  }
}
bootSchemaStep(ensureAddAdminRequestsSchema);

// Institution-verification state. Two independent facts, not one 3-state
// machine: email_verified_at (did the signer click the confirmation link
// sent to what looks like their institutional address?) and status (has a
// platform owner actually reviewed and approved the organization?) —
// clicking the link never advances status on its own.
//
// CRITICAL: the column default is 'approved', not 'pending'. Postgres
// backfills a column's DEFAULT into every existing row on ADD COLUMN, so a
// 'pending' default would silently lock every organization that already
// existed before this feature shipped out of creating new students the
// moment this migration runs. Only POST /api/organizations/signup's own
// INSERT explicitly writes 'pending' for brand-new orgs going forward —
// every org that predates this column is grandfathered in as already
// approved, with no manual step required.
async function ensureOrganizationVerificationSchema() {
  await ensureOrganizationsSchema();
  try {
    await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected'))`);
    // 'terminated' added later, for the superadmin's blacklist action (see
    // POST /api/superadmin/organizations/:id/terminate) — a harder shutdown
    // than 'rejected' (which only ever applied pre-approval): it also blocks
    // login for every existing member, not just new roster growth. The
    // inline CHECK above only fires the one time this column is first
    // created, so a value added to it later needs its own DROP/ADD pass to
    // actually reach organizations created before this change, same pattern
    // as profile_change_requests_status_check further down.
    await pool.query('ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_status_check');
    await pool.query(`ALTER TABLE organizations ADD CONSTRAINT organizations_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'terminated'))`);
    await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_domain TEXT');
    await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verification_token_hash TEXT');
    await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verification_token_expiry TIMESTAMPTZ');
    await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS approved_by TEXT');
  } catch (err) {
    console.error('Failed to ensure organization verification schema:', err);
  }
}
bootSchemaStep(ensureOrganizationVerificationSchema);

// The *shape* of one org's hierarchy — an ordered list of tiers, e.g.
// [(0,"Campus"),(1,"Department"),(2,"Year")]. A large college might define
// 7-8 of these; a small tuition center just 2. tier_index starts at 0
// (the root tier). Deliberately no organization-agnostic default seed —
// every org designs its own from scratch via the admin UI.
//
// Cached like ensureOrganizationsSchema() above — this is called both at
// module load and (awaited) from ensureOrgUnitsSchema() below, and
// Postgres's CREATE TABLE IF NOT EXISTS isn't safe against two literally
// concurrent callers both racing the existence check, so without caching
// the promise the second caller can hit a duplicate-key error on pg_type.
let orgLevelDefsSchemaPromise = null;
function ensureOrgLevelDefsSchema() {
  if (!orgLevelDefsSchemaPromise) {
    orgLevelDefsSchemaPromise = ensureOrganizationsSchema().then(() => pool.query(`
      CREATE TABLE IF NOT EXISTS org_level_defs (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        tier_index INTEGER NOT NULL,
        label TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (organization_id, tier_index)
      )
    `)).catch((err) => console.error('Failed to ensure org level defs schema:', err));
  }
  return orgLevelDefsSchemaPromise;
}
bootSchemaStep(ensureOrgLevelDefsSchema);

// The actual tree node instances built against org_level_defs above —
// "North Campus" (tier 0), "Computer Science" (tier 1, parent = North
// Campus), "Year 2" (tier 2, parent = Computer Science). Tier adjacency
// (a node's level must be exactly one tier below its parent's) is
// validated in the route, not the DB — Postgres CHECK constraints can't
// cheaply enforce an invariant that spans a join to another row.
//
// Also backfills memberships.org_unit_id and subjects' eventual FK target
// here, since both reference this table and it didn't exist when
// ensureMembershipsSchema() first ran — same "add the column once its
// target table exists" idiom used throughout this file (see
// ensureUsersOrgColumn/ensureProblemsOrgColumn near the top).
//
// Cached for the same reason ensureOrgLevelDefsSchema() is above — this is
// now awaited from ensureSubjectsSchema() too, so a second concurrent
// caller must reuse the same in-flight promise rather than racing its own
// CREATE TABLE IF NOT EXISTS against the first.
let orgUnitsSchemaPromise = null;
function ensureOrgUnitsSchema() {
  if (!orgUnitsSchemaPromise) {
    orgUnitsSchemaPromise = Promise.all([ensureOrganizationsSchema(), ensureOrgLevelDefsSchema()]).then(async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS org_units (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          level_def_id INTEGER NOT NULL REFERENCES org_level_defs(id) ON DELETE RESTRICT,
          parent_unit_id INTEGER REFERENCES org_units(id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS org_units_parent_idx ON org_units(parent_unit_id)');
      await pool.query('ALTER TABLE memberships ADD COLUMN IF NOT EXISTS org_unit_id INTEGER REFERENCES org_units(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_org_unit_id INTEGER REFERENCES org_units(id) ON DELETE SET NULL');
    }).catch((err) => console.error('Failed to ensure org units schema:', err));
  }
  return orgUnitsSchemaPromise;
}
bootSchemaStep(ensureOrgUnitsSchema);

// Lives on memberships, not users — same reasoning as org_unit_id already
// living here: a roll number is a per-org-enrollment fact, not global
// identity (a student who's a member of two organizations could plausibly
// have a different roll number at each). Nullable — most orgs won't have
// this in their roster at all, and it's only ever set via CSV/webhook
// import (see splitTierAndIdentityColumns) or left blank.
async function ensureMembershipRollNumberColumn() {
  await ensureMembershipsSchema();
  try {
    await pool.query('ALTER TABLE memberships ADD COLUMN IF NOT EXISTS roll_number TEXT');
  } catch (err) {
    console.error('Failed to ensure memberships.roll_number:', err);
  }
}
bootSchemaStep(ensureMembershipRollNumberColumn);

// ---------------------------------------------------------------------------
// ID CARDS — profile photos, org logos, per-membership photo choice.
// ---------------------------------------------------------------------------

// Photos belong to the global user identity (users), not any one
// organization — same reasoning as "users is pure identity" in
// ensureMembershipsSchema's own comment below: a photo uploaded once is
// reusable as the picture on every institution's ID card the person holds,
// not re-uploaded per org. ON DELETE CASCADE on user_id (a deleted account
// takes its own photos with it); nothing else references this table by FK
// except memberships.active_photo_id, added separately below once this
// table exists to point at.
async function ensureUserPhotosSchema() {
  await ensureUsersSchema();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_photos (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        storage_key TEXT NOT NULL,
        original_filename TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS user_photos_user_idx ON user_photos(user_id)');
  } catch (err) {
    console.error('Failed to ensure user_photos schema:', err);
  }
}
bootSchemaStep(ensureUserPhotosSchema);

// One logo per organization, admin-uploaded — shown on every ID card
// issued under that org. Nullable: an org with no logo yet just renders
// its card without one, same "optional until set" posture as
// organizations.default_org_unit_id above.
async function ensureOrganizationLogoSchema() {
  await ensureOrganizationsSchema();
  try {
    await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_object_key TEXT');
  } catch (err) {
    console.error('Failed to ensure organizations.logo_object_key:', err);
  }
}
bootSchemaStep(ensureOrganizationLogoSchema);

// Which of the user's uploaded photos backs THIS SPECIFIC institution's ID
// card — a per-enrollment choice (like org_unit_id/roll_number above), not
// a global one, since someone might want a formal photo for one institution
// and a casual one for another. ON DELETE SET NULL: deleting a photo should
// never take out the membership row it happened to be attached to — the
// card just falls back to "no photo" until a new one's picked.
async function ensureMembershipActivePhotoColumn() {
  await Promise.all([ensureMembershipsSchema(), ensureUserPhotosSchema()]);
  try {
    await pool.query('ALTER TABLE memberships ADD COLUMN IF NOT EXISTS active_photo_id INTEGER REFERENCES user_photos(id) ON DELETE SET NULL');
  } catch (err) {
    console.error('Failed to ensure memberships.active_photo_id:', err);
  }
}
bootSchemaStep(ensureMembershipActivePhotoColumn);

// A subject is attached at whatever tier an admin picks — one on
// "Computer Science" (a Department-tier unit) is visible to every "Year"
// beneath it; one attached directly on a specific Year is scoped to just
// that year (see getVisibleSubjectIds() further down, used by the
// student-facing problem/exam listing routes). subject_teachers is a plain
// join table — a teacher's creation authority for problems/exams is scoped
// to exactly the subjects they're linked to here (see
// requireAdminOrTeacher below).
let subjectsSchemaPromise = null;
function ensureSubjectsSchema() {
  if (!subjectsSchemaPromise) {
    subjectsSchemaPromise = Promise.all([ensureOrganizationsSchema(), ensureOrgUnitsSchema(), ensureUsersSchema()]).then(async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS subjects (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          org_unit_id INTEGER NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS subject_teachers (
          subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (subject_id, user_id)
        )
      `);
    }).catch((err) => console.error('Failed to ensure subjects schema:', err));
  }
  return subjectsSchemaPromise;
}
bootSchemaStep(ensureSubjectsSchema);

// ============================================================================
// SCANNED ASSIGNMENTS — Phase 1 schema only. Students scan a handwritten
// answer sheet (instead of writing code) and upload the bundled PDF against
// a `problems` row with submission_mode='scan' (see ensureScanAssignmentColumns
// above). These three tables are created now, ahead of the OCR/upload/
// detection routes that will populate them in later phases, so nothing
// downstream needs its own migration step. No organization_id column on any
// of them — scoped indirectly via problem_id -> problems.organization_id,
// exactly like the existing `submissions` table.
// ============================================================================
let scanSubmissionsSchemaPromise = null;
function ensureScanSubmissionsSchema() {
  if (!scanSubmissionsSchemaPromise) {
    scanSubmissionsSchemaPromise = Promise.all([ensureProblemsSchema(), ensureUsersSchema()]).then(() => pool.query(`
      CREATE TABLE IF NOT EXISTS scan_submissions (
        id SERIAL PRIMARY KEY,
        problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ocr_done', 'ocr_failed')) DEFAULT 'pending',
        storage_key TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        page_count INTEGER,
        ocr_text TEXT,
        ocr_pages JSONB,
        ocr_error TEXT,
        handwriting_features JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ocr_completed_at TIMESTAMPTZ
      )
    `).then(async () => {
      await pool.query('CREATE INDEX IF NOT EXISTS scan_submissions_problem_idx ON scan_submissions(problem_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS scan_submissions_user_idx ON scan_submissions(user_id)');
      // At most one row per (problem, student) — a resubmission before the
      // deadline REPLACES the previous one outright (see the delete-then-
      // insert logic in POST /api/problems/:id/scan-submit), not a second
      // row to pick "the latest" from later. This index is the DB-level
      // backstop against that invariant breaking under a race (e.g. the
      // same student resubmitting from two tabs at once).
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS scan_submissions_problem_user_idx ON scan_submissions(problem_id, user_id)');
      // One free-text note covering the whole submission, separate from
      // each question's own per-question remark (scan_submission_answers.
      // remarks) — set alongside marks in PUT /api/admin/scan-submissions/
      // :id/grade.
      await pool.query('ALTER TABLE scan_submissions ADD COLUMN IF NOT EXISTS overall_remarks TEXT');
    })).catch((err) => console.error('Failed to ensure scan_submissions schema:', err));
  }
  return scanSubmissionsSchemaPromise;
}
bootSchemaStep(ensureScanSubmissionsSchema);

// Text-content similarity flags — same-assignment only (comparing two
// answers to the same question is meaningful; comparing across different
// questions isn't). submission_a_id < submission_b_id is enforced so a
// pair only ever gets one row regardless of comparison order.
let scanPlagiarismFlagsSchemaPromise = null;
function ensureScanPlagiarismFlagsSchema() {
  if (!scanPlagiarismFlagsSchemaPromise) {
    scanPlagiarismFlagsSchemaPromise = Promise.all([ensureScanSubmissionsSchema(), ensureScanAssignmentQuestionsSchema()]).then(async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS scan_plagiarism_flags (
          id SERIAL PRIMARY KEY,
          problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
          submission_a_id INTEGER NOT NULL REFERENCES scan_submissions(id) ON DELETE CASCADE,
          submission_b_id INTEGER NOT NULL REFERENCES scan_submissions(id) ON DELETE CASCADE,
          similarity_score REAL NOT NULL,
          flag_type TEXT NOT NULL DEFAULT 'text_similarity',
          status TEXT NOT NULL CHECK (status IN ('open', 'reviewed_confirmed', 'reviewed_dismissed')) DEFAULT 'open',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (submission_a_id < submission_b_id)
        )
      `);
      // NULL for whole-submission OCR-text flags (flag_type =
      // 'text_similarity', one row per submission pair) — set to the
      // specific question for per-question typed-answer flags (flag_type =
      // 'typed_text_similarity', see runTypedTextPlagiarismComparator),
      // since unlike the OCR blob, typed answers are already cleanly
      // separated by question and a per-question flag is more useful.
      await pool.query('ALTER TABLE scan_plagiarism_flags ADD COLUMN IF NOT EXISTS question_id INTEGER REFERENCES scan_assignment_questions(id) ON DELETE CASCADE');
      await pool.query('DROP INDEX IF EXISTS scan_plagiarism_flags_pair_idx');
      // Two partial indexes rather than one index including question_id:
      // NULL <> NULL in SQL, so a plain unique index over question_id
      // wouldn't actually stop duplicate whole-submission flags from being
      // inserted (every NULL would look distinct to it).
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS scan_plagiarism_flags_pair_submission_idx ON scan_plagiarism_flags(problem_id, submission_a_id, submission_b_id, flag_type) WHERE question_id IS NULL');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS scan_plagiarism_flags_pair_question_idx ON scan_plagiarism_flags(problem_id, submission_a_id, submission_b_id, flag_type, question_id) WHERE question_id IS NOT NULL');
    }).catch((err) => console.error('Failed to ensure scan_plagiarism_flags schema:', err));
  }
  return scanPlagiarismFlagsSchemaPromise;
}
bootSchemaStep(ensureScanPlagiarismFlagsSchema);

// Handwriting/style-match flags — deliberately NOT scoped to a single
// problem_id, since the whole point is comparing a submission against the
// organization's entire submission history (a student's handwriting from a
// past assignment is valid reference material for flagging a completely
// different assignment). Always review-only — no column here ever writes
// to a grade; see the comparator that will populate this table in a later
// phase for why (no trained writer-ID model, real false-positive risk).
let scanHandwritingFlagsSchemaPromise = null;
function ensureScanHandwritingFlagsSchema() {
  if (!scanHandwritingFlagsSchemaPromise) {
    scanHandwritingFlagsSchemaPromise = ensureScanSubmissionsSchema().then(async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS scan_handwriting_flags (
          id SERIAL PRIMARY KEY,
          submission_a_id INTEGER NOT NULL REFERENCES scan_submissions(id) ON DELETE CASCADE,
          submission_b_id INTEGER NOT NULL REFERENCES scan_submissions(id) ON DELETE CASCADE,
          similarity_score REAL NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'reviewed_confirmed', 'reviewed_dismissed')) DEFAULT 'open',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (submission_a_id < submission_b_id)
        )
      `);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS scan_handwriting_flags_pair_idx ON scan_handwriting_flags(submission_a_id, submission_b_id)');
    }).catch((err) => console.error('Failed to ensure scan_handwriting_flags schema:', err));
  }
  return scanHandwritingFlagsSchemaPromise;
}
bootSchemaStep(ensureScanHandwritingFlagsSchema);

// Questions a scan assignment actually asks — students see these before the
// camera opens (see GET /api/me/scan-context), teachers author them in
// AssignmentForm. Started out scan-only (a scan answer is always "written
// on paper"), same prompt/marks/position shape as exam_items; now mirrors
// exam_items' full mcq/short/long/coding/scan typing so a scan-mode
// assignment can mix digitally-answered items alongside scanned ones —
// every scan-type question's captured pages still compile into ONE PDF per
// submission (see scan_submissions), the digital ones just skip that
// entirely. No problem_id "reuse an existing assignment" mode the way
// exam_items' coding type has — a coding sub-item here is always inline
// (its own starter_code/test_cases), since nesting one assignment inside
// another has no clear meaning.
let scanAssignmentQuestionsSchemaPromise = null;
function ensureScanAssignmentQuestionsSchema() {
  if (!scanAssignmentQuestionsSchemaPromise) {
    scanAssignmentQuestionsSchemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS scan_assignment_questions (
        id SERIAL PRIMARY KEY,
        problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        marks INTEGER NOT NULL DEFAULT 1
      )
    `).then(async () => {
      await pool.query('CREATE INDEX IF NOT EXISTS scan_assignment_questions_problem_idx ON scan_assignment_questions(problem_id)');
      await pool.query(`ALTER TABLE scan_assignment_questions ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'scan'`);
      await pool.query('ALTER TABLE scan_assignment_questions DROP CONSTRAINT IF EXISTS scan_assignment_questions_type_check');
      await pool.query(`ALTER TABLE scan_assignment_questions ADD CONSTRAINT scan_assignment_questions_type_check CHECK (type IN ('mcq', 'short', 'long', 'coding', 'scan'))`);
      await pool.query('ALTER TABLE scan_assignment_questions ADD COLUMN IF NOT EXISTS options JSONB'); // mcq only: [{ id, text }, ...]
      await pool.query('ALTER TABLE scan_assignment_questions ADD COLUMN IF NOT EXISTS correct_option_id TEXT'); // mcq only
      await pool.query('ALTER TABLE scan_assignment_questions ADD COLUMN IF NOT EXISTS word_limit INTEGER'); // short/long only
      await pool.query('ALTER TABLE scan_assignment_questions ADD COLUMN IF NOT EXISTS starter_code JSONB'); // coding only
      await pool.query('ALTER TABLE scan_assignment_questions ADD COLUMN IF NOT EXISTS test_cases JSONB'); // coding only
    }).catch((err) => console.error('Failed to ensure scan_assignment_questions schema:', err));
  }
  return scanAssignmentQuestionsSchemaPromise;
}
bootSchemaStep(ensureScanAssignmentQuestionsSchema);

// One row per (submission, question) — for scan-type questions, populated
// by the OCR pipeline once a submission's assignment deadline passes
// (ai_assessment filled in by aiGrading.js's Groq call), marks_awarded
// stays NULL until a teacher grades it in ScanReview. Never overwritten by
// re-running OCR since a resubmission deletes the old scan_submissions row
// outright (see POST /api/problems/:id/scan-submit) and CASCADEs these
// away with it.
//
// mcq/short/long/coding columns mirror exam_answers exactly — for those
// question types this row is populated at submit time instead (mcq/coding
// auto-graded immediately, short/long left for manual grading), the same
// digital-answer split exam_items/exam_answers already has.
let scanSubmissionAnswersSchemaPromise = null;
function ensureScanSubmissionAnswersSchema() {
  if (!scanSubmissionAnswersSchemaPromise) {
    scanSubmissionAnswersSchemaPromise = Promise.all([ensureScanSubmissionsSchema(), ensureScanAssignmentQuestionsSchema()]).then(async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS scan_submission_answers (
          id SERIAL PRIMARY KEY,
          submission_id INTEGER NOT NULL REFERENCES scan_submissions(id) ON DELETE CASCADE,
          question_id INTEGER NOT NULL REFERENCES scan_assignment_questions(id) ON DELETE CASCADE,
          ai_assessment TEXT,
          marks_awarded INTEGER
        )
      `);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS scan_submission_answers_pair_idx ON scan_submission_answers(submission_id, question_id)');
      await pool.query('ALTER TABLE scan_submission_answers ADD COLUMN IF NOT EXISTS selected_option_id TEXT');
      await pool.query('ALTER TABLE scan_submission_answers ADD COLUMN IF NOT EXISTS text_answer TEXT');
      await pool.query('ALTER TABLE scan_submission_answers ADD COLUMN IF NOT EXISTS is_correct BOOLEAN');
      await pool.query('ALTER TABLE scan_submission_answers ADD COLUMN IF NOT EXISTS language TEXT');
      await pool.query('ALTER TABLE scan_submission_answers ADD COLUMN IF NOT EXISTS code TEXT');
      await pool.query('ALTER TABLE scan_submission_answers ADD COLUMN IF NOT EXISTS passed_count INTEGER');
      await pool.query('ALTER TABLE scan_submission_answers ADD COLUMN IF NOT EXISTS total_count INTEGER');
      // A teacher's free-text note on this one question — independent of
      // marks_awarded and of ai_assessment (the AI's own aid-only note),
      // and addable to any question type, not just the manually-graded ones.
      await pool.query('ALTER TABLE scan_submission_answers ADD COLUMN IF NOT EXISTS remarks TEXT');
    }).catch((err) => console.error('Failed to ensure scan_submission_answers schema:', err));
  }
  return scanSubmissionAnswersSchemaPromise;
}
bootSchemaStep(ensureScanSubmissionAnswersSchema);

// Flips true the moment a text-plagiarism flag against this submission is
// confirmed (see PUT /api/admin/scan-flags/:id) — displayed total marks
// become 0 while true, regardless of whatever marks_awarded values already
// sit in scan_submission_answers, so un-penalizing later never loses a
// teacher's prior grading work.
async function ensureScanSubmissionPenalizedColumn() {
  await ensureScanSubmissionsSchema();
  try {
    await pool.query('ALTER TABLE scan_submissions ADD COLUMN IF NOT EXISTS penalized BOOLEAN NOT NULL DEFAULT false');
  } catch (err) {
    console.error('Failed to ensure scan_submissions.penalized:', err);
  }
}
bootSchemaStep(ensureScanSubmissionPenalizedColumn);

// Per-org Jaccard-similarity cutoff above which a pair of scan submissions
// for the same assignment gets flagged for teacher review (see the deadline
// sweep's text-plagiarism comparator). A single scalar, so a column on the
// org row rather than a whole new settings table — same reasoning as any
// other single per-org toggle in this file.
async function ensureOrganizationsPlagiarismThresholdColumn() {
  await ensureOrganizationsSchema();
  try {
    await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS scan_plagiarism_threshold REAL NOT NULL DEFAULT 0.4');
  } catch (err) {
    console.error('Failed to ensure organizations.scan_plagiarism_threshold:', err);
  }
}
bootSchemaStep(ensureOrganizationsPlagiarismThresholdColumn);

// Timestamp for when a submission actually entered 'processing' (set in
// processOneScanSubmission below) — distinct from created_at, which is
// upload time and can sit hours/days before OCR ever starts on the normal
// deadline-gated path. The frontend's progress ring needs the real start
// time to mean anything; created_at would make it read as already-almost-
// done the instant a long-pending row finally starts.
async function ensureScanSubmissionProcessingStartedColumn() {
  await ensureScanSubmissionsSchema();
  try {
    await pool.query('ALTER TABLE scan_submissions ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ');
  } catch (err) {
    console.error('Failed to ensure scan_submissions.processing_started_at:', err);
  }
}
bootSchemaStep(ensureScanSubmissionProcessingStartedColumn);

// ============================================================================
// NOTES — a teacher posts one of six media types against one of their own
// subjects (Uploads tab): pdf/image/video/audio (a file, stored in B2 same
// as scan submissions), text (body_text, no file at all), or link
// (external_url, no file, no B2 involvement either). Students whose own
// org_unit sees that subject (same ancestor-reaches-descendants rule as
// getVisibleSubjectIds) can browse and search them by title (Notes tab).
// subject_id is NOT NULL, unlike problems/exams' optional org-wide
// subject_id — the whole feature is "pick a subject, see its notes," so a
// subject-less note wouldn't fit anywhere in that UI.
// ============================================================================
let notesSchemaPromise = null;
function ensureNotesSchema() {
  if (!notesSchemaPromise) {
    notesSchemaPromise = Promise.all([ensureSubjectsSchema(), ensureUsersSchema()]).then(async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notes (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          original_filename TEXT NOT NULL,
          storage_key TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS notes_subject_id_idx ON notes(subject_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS notes_teacher_id_idx ON notes(teacher_id)');

      // The table above pre-dates the multi-media expansion (originally
      // PDF-only, both file columns NOT NULL) — these ALTERs bring an
      // already-created table up to date; every statement here is safe to
      // re-run on every boot. body_text/external_url are each only ever
      // populated by their own matching type ('text'/'link'); every other
      // type stores its payload as a B2 file via storage_key instead, same
      // as the original PDF-only shape.
      await pool.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'pdf'`);
      await pool.query('ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_type_check');
      await pool.query(`ALTER TABLE notes ADD CONSTRAINT notes_type_check CHECK (type IN ('pdf', 'image', 'video', 'audio', 'text', 'link'))`);
      await pool.query('ALTER TABLE notes ADD COLUMN IF NOT EXISTS body_text TEXT');
      await pool.query('ALTER TABLE notes ADD COLUMN IF NOT EXISTS external_url TEXT');
      await pool.query('ALTER TABLE notes ALTER COLUMN storage_key DROP NOT NULL');
      await pool.query('ALTER TABLE notes ALTER COLUMN original_filename DROP NOT NULL');
      await pool.query('ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_content_check');
      await pool.query(`
        ALTER TABLE notes ADD CONSTRAINT notes_content_check CHECK (
          (type IN ('pdf', 'image', 'video', 'audio') AND storage_key IS NOT NULL AND storage_key != '')
          OR (type = 'text' AND body_text IS NOT NULL)
          OR (type = 'link' AND external_url IS NOT NULL)
        )
      `);
    }).catch((err) => console.error('Failed to ensure notes schema:', err));
  }
  return notesSchemaPromise;
}
bootSchemaStep(ensureNotesSchema);

// ============================================================================
// NOTICES — admin-posted, org-wide announcements. Same four non-audio/video
// note types (pdf/image/text/link) — a notice is meant to be read at a
// glance by the whole org, not sat through as a lecture recording. Unlike
// notes, there's no subject_id at all: a notice isn't attached to any one
// subject, so it's visible to every member of the org (student, teacher,
// admin alike) rather than following the subject-visibility rule.
// ============================================================================
let noticesSchemaPromise = null;
function ensureNoticesSchema() {
  if (!noticesSchemaPromise) {
    noticesSchemaPromise = Promise.all([ensureOrganizationsSchema(), ensureUsersSchema()]).then(async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notices (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          admin_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('pdf', 'image', 'text', 'link')),
          original_filename TEXT,
          storage_key TEXT,
          body_text TEXT,
          external_url TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS notices_organization_id_idx ON notices(organization_id)');
      await pool.query('ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_content_check');
      await pool.query(`
        ALTER TABLE notices ADD CONSTRAINT notices_content_check CHECK (
          (type IN ('pdf', 'image') AND storage_key IS NOT NULL AND storage_key != '')
          OR (type = 'text' AND body_text IS NOT NULL)
          OR (type = 'link' AND external_url IS NOT NULL)
        )
      `);
    }).catch((err) => console.error('Failed to ensure notices schema:', err));
  }
  return noticesSchemaPromise;
}
bootSchemaStep(ensureNoticesSchema);

// ============================================================================
// NOTIFICATIONS — generic per-user feed, one row per event. Two producers
// today: a teacher posting a note (POST /api/teacher/notes, unit-scoped to
// students under that subject) and an admin posting a notice (POST
// /api/admin/notices, org-wide to every student and teacher) — hence both
// note_id and notice_id, each nullable and only ever one populated per row
// depending on type. The shape (title/body/read_at) isn't specific to
// either, so a future notification kind can reuse this table rather than
// needing its own. read_at nullable (not a boolean) doubles as "when did
// they see it," which a plain flag would throw away for free.
// ============================================================================
let notificationsSchemaPromise = null;
function ensureNotificationsSchema() {
  if (!notificationsSchemaPromise) {
    notificationsSchemaPromise = Promise.all([ensureNotesSchema(), ensureNoticesSchema(), ensureUsersSchema(), ensureProblemsSchema(), ensureExamSchema()]).then(async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL DEFAULT 'note',
          title TEXT NOT NULL,
          body TEXT,
          note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
          read_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS notifications_user_id_created_at_idx ON notifications(user_id, created_at DESC)');
      // Partial index — only unread rows are ever looked up by user_id
      // alone (the badge count query below); read ones are always reached
      // through the (user_id, created_at) index above instead.
      await pool.query('CREATE INDEX IF NOT EXISTS notifications_user_id_unread_idx ON notifications(user_id) WHERE read_at IS NULL');
      // Added alongside notices — pre-dates it, same "bring an
      // already-created table up to date" posture as ensureNotesSchema's
      // own ALTERs above.
      await pool.query('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS notice_id INTEGER REFERENCES notices(id) ON DELETE CASCADE');
      // "New assignment/exam available" notifications — see
      // sweepAssignmentExamNotifications. Same one-FK-column-per-type
      // pattern as note_id/notice_id above.
      await pool.query('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS problem_id INTEGER REFERENCES problems(id) ON DELETE CASCADE');
      await pool.query('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE');
    }).catch((err) => console.error('Failed to ensure notifications schema:', err));
  }
  return notificationsSchemaPromise;
}
bootSchemaStep(ensureNotificationsSchema);

// Global (not per-org) cache mapping this app's (plan_key, billing_cycle)
// to the Razorpay-side Plan object Razorpay itself generates an ID for —
// at most 6 rows (3 paid tiers x 2 cycles). Populated lazily on first real
// checkout (see lib/billing.js's ensureRazorpayPlan), never at boot: no
// live Razorpay keys exist yet, and a boot-time call would either throw on
// every restart or silently no-op forever if guarded — both worse than
// calling it once, on demand, the first time anyone actually checks out
// into a given tier.
let razorpayPlansSchemaPromise = null;
function ensureRazorpayPlansSchema() {
  if (!razorpayPlansSchemaPromise) {
    razorpayPlansSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS razorpay_plans (
          id SERIAL PRIMARY KEY,
          plan_key TEXT NOT NULL CHECK (plan_key IN ('starter', 'growth', 'institution', 'scale')),
          billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'annual')),
          razorpay_plan_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (plan_key, billing_cycle)
        )
      `);
      // Widens the CHECK for tables that already existed before 'scale' was
      // added as a paid tier — same DROP/re-ADD pattern as
      // ensureExamProctoringSchema's end_reason constraint above.
      await pool.query('ALTER TABLE razorpay_plans DROP CONSTRAINT IF EXISTS razorpay_plans_plan_key_check');
      await pool.query(`ALTER TABLE razorpay_plans ADD CONSTRAINT razorpay_plans_plan_key_check CHECK (plan_key IN ('starter', 'growth', 'institution', 'scale'))`);
    })().catch((err) => console.error('Failed to ensure razorpay_plans schema:', err));
  }
  return razorpayPlansSchemaPromise;
}
bootSchemaStep(ensureRazorpayPlansSchema);

// One row per organization — the entitlement source of truth. organization_id
// is inline in the initial CREATE TABLE (rather than the ALTER-after pattern
// used elsewhere in this file) because this is a brand-new table with zero
// pre-existing rows to worry about; that pattern exists specifically to avoid
// NOT-NULL-backfill problems on tables that already have data.
//
// status reuses Razorpay's own real subscription states, plus a synthetic
// 'free' for orgs that have never subscribed to anything. The pending_*
// trio holds an in-flight checkout until a signature-verified webhook
// confirms it — a client-side checkout "success" callback must NEVER
// itself promote plan_key/status; see POST /api/webhook/razorpay.
let subscriptionsSchemaPromise = null;
function ensureSubscriptionsSchema() {
  if (!subscriptionsSchemaPromise) {
    subscriptionsSchemaPromise = ensureOrganizationsSchema().then(() => pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
        plan_key TEXT NOT NULL DEFAULT 'free' CHECK (plan_key IN ('free', 'starter', 'growth', 'institution', 'scale')),
        billing_cycle TEXT CHECK (billing_cycle IN ('monthly', 'annual')),
        status TEXT NOT NULL DEFAULT 'free' CHECK (status IN
          ('free', 'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired')),
        razorpay_subscription_id TEXT UNIQUE,
        razorpay_plan_id TEXT,
        current_period_end TIMESTAMPTZ,
        pending_plan_key TEXT CHECK (pending_plan_key IN ('starter', 'growth', 'institution', 'scale')),
        pending_billing_cycle TEXT CHECK (pending_billing_cycle IN ('monthly', 'annual')),
        pending_razorpay_subscription_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)).then(() => Promise.all([
      // Widens the two CHECKs for tables that already existed before 'scale'
      // was added as a paid tier — same DROP/re-ADD pattern as
      // ensureExamProctoringSchema's end_reason constraint.
      pool.query('ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_key_check').then(() =>
        pool.query(`ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_key_check CHECK (plan_key IN ('free', 'starter', 'growth', 'institution', 'scale'))`)),
      pool.query('ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_pending_plan_key_check').then(() =>
        pool.query(`ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_pending_plan_key_check CHECK (pending_plan_key IN ('starter', 'growth', 'institution', 'scale'))`)),
    ])).catch((err) => console.error('Failed to ensure subscriptions schema:', err));
  }
  return subscriptionsSchemaPromise;
}
bootSchemaStep(ensureSubscriptionsSchema);

// subject_id is nullable on purpose — it doesn't retroactively touch any
// existing problems/exams row, and an admin can still create an org-wide
// item with no subject at all (visible to every student in the org, same
// as before this feature existed). ON DELETE SET NULL, not RESTRICT or
// CASCADE: given the earlier unresolved incident where problems/exams data
// was found unexpectedly empty, no FK added by this feature should ever be
// capable of deleting a real assignment/exam row as a side effect — the
// subject-delete route itself pre-checks and blocks (409) while anything
// still references it; this FK is only a non-destructive backstop.
async function ensureProblemsSubjectColumn() {
  await ensureProblemsSchema();
  await ensureSubjectsSchema();
  try {
    await pool.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL');
  } catch (err) {
    console.error('Failed to ensure problems.subject_id:', err);
  }
}
bootSchemaStep(ensureProblemsSubjectColumn);

// 'scan' assignments (student scans a handwritten answer sheet instead of
// writing code) reuse the `problems` table rather than a parallel one —
// same org/subject scoping, same opens_at/closes_at window, same admin
// list — distinguished only by this column. assignment_no is free-text
// (e.g. "3", "HW-3"), needed verbatim for the scanned-PDF auto-filename
// pattern; nullable for existing code rows, required at the route level
// only when submission_mode='scan'.
async function ensureScanAssignmentColumns() {
  await ensureProblemsSchema();
  try {
    await pool.query(`ALTER TABLE problems ADD COLUMN IF NOT EXISTS submission_mode TEXT NOT NULL DEFAULT 'code' CHECK (submission_mode IN ('code', 'scan'))`);
    await pool.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS assignment_no TEXT');
  } catch (err) {
    console.error('Failed to ensure problems scan-assignment columns:', err);
  }
}
bootSchemaStep(ensureScanAssignmentColumns);

async function ensureExamsSubjectColumn() {
  await Promise.all([ensureSubjectsSchema(), ensureExamSchema()]);
  try {
    await pool.query('ALTER TABLE exams ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL');
  } catch (err) {
    console.error('Failed to ensure exams.subject_id:', err);
  }
}
bootSchemaStep(ensureExamsSubjectColumn);

module.exports = {
  ensureAddAdminRequestsSchema,
  ensureAdminRequestsSchema,
  ensureContactMessagesSchema,
  ensureExamProctoringSchema,
  ensureExamSchema,
  ensureExamSchemaImpl,
  ensureExamSubmissionSchema,
  ensureExamsSubjectColumn,
  ensureGradeBandsSchema,
  ensureJudgeDataSchema,
  ensureLegacyScoresSchema,
  ensureMembershipActivePhotoColumn,
  ensureMembershipRollNumberColumn,
  ensureMembershipsSchema,
  ensureNotesSchema,
  ensureNoticesSchema,
  ensureNotificationsSchema,
  ensureOrgLevelDefsSchema,
  ensureOrgUnitsSchema,
  ensureOrganizationLogoSchema,
  ensureOrganizationVerificationSchema,
  ensureOrganizationsPlagiarismThresholdColumn,
  ensureOrganizationsSchema,
  ensureProblemsOrgColumn,
  ensureProblemsPlagiarismThresholdColumn,
  ensureProblemsSchema,
  ensureProblemsSubjectColumn,
  ensureProfileChangeRequestsSchema,
  ensureRazorpayPlansSchema,
  ensureScanAssignmentColumns,
  ensureScanAssignmentQuestionsSchema,
  ensureScanHandwritingFlagsSchema,
  ensureScanPlagiarismFlagsSchema,
  ensureScanSubmissionAnswersSchema,
  ensureScanSubmissionPenalizedColumn,
  ensureScanSubmissionProcessingStartedColumn,
  ensureScanSubmissionsSchema,
  ensureSubjectsSchema,
  ensureSubmissionPlagiarismFlagsSchema,
  ensureSubscriptionsSchema,
  ensureTagVisibilitySchema,
  ensureTimeLimitColumn,
  ensureTimeTrackingSchema,
  ensureUserPhotosSchema,
  ensureUsersNameColumn,
  ensureUsersOrgColumn,
  ensureUsersSchema,
  ensureUsersTosColumn,
};
