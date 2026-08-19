require('dotenv').config();
const dns = require('dns');
// Render's network doesn't support outbound IPv6, but Node 18+ resolves
// hostnames with both A/AAAA records (like smtp.gmail.com) IPv6-first by
// default — that mismatch is what caused ENETUNREACH connecting to Gmail.
// Forcing IPv4-first here fixes it without touching the nodemailer config.
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const { Resend } = require('resend');
const { exec } = require('child_process');
const path = require('path');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const Razorpay = require('razorpay');

// In-memory only — CSV rosters are realistically tens to low-thousands of
// rows, never large enough to need disk storage or a streaming parser. 2MB
// cap is generous for a plain-text student roster.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const app = express();
// The `verify` callback stashes the raw request-body bytes on req.rawBody —
// needed by the Razorpay webhook route to check X-Razorpay-Signature, which
// must be computed over the exact raw bytes Razorpay sent, not a
// re-serialized version of the already-parsed JSON (whitespace/key-order
// differences would break the HMAC compare). Extending the existing global
// parser (rather than adding a second, route-scoped raw parser just for the
// webhook) sidesteps an Express middleware-ordering trap: Express runs
// middleware in registration order, so a parser registered later in the
// file — where the webhook route naturally lives — would run AFTER this
// one has already consumed the stream, making it a no-op. This costs
// nothing for every other route (multer's multipart CSV upload is never
// touched by express.json() regardless).
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
const cors = require('cors');
app.use(cors({
  origin: ['http://localhost:5173',
  'https://pandadsgn.github.io', 'https://codejudge.page', 'https://www.codejudge.page'],
  credentials: true
}));

// ============================================================================
// System Setup: Temp Directory, Database, and Email
// ============================================================================

// Ensure a temp directory exists for code execution
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Initialize PostgreSQL Connection Pool
// ssl is required for Neon (and most hosted Postgres) even when sslmode=require
// is already in the connection string — this is a belt-and-braces fallback so
// pg doesn't reject Neon's cert chain.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
ensureOrganizationsSchema();

// Nullable — has to tolerate whatever pre-multi-tenancy rows still exist
// (this platform started single-tenant). Every new row from here on is
// always given one at the application level (signup, create-student, the
// Google Form webhook, exam/problem creation) — see the routes that use it.
async function ensureUsersOrgColumn() {
  await ensureOrganizationsSchema();
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id)');
  } catch (err) {
    console.error('Failed to ensure users.organization_id:', err);
  }
}
ensureUsersOrgColumn();

async function ensureProblemsOrgColumn() {
  await ensureOrganizationsSchema();
  try {
    await pool.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id)');
  } catch (err) {
    console.error('Failed to ensure problems.organization_id:', err);
  }
}
ensureProblemsOrgColumn();

// Auto-provisions the time-tracking table if it doesn't exist yet, so
// "true time on task" tracking (see POST /api/problems/:id/time-log) works
// immediately on deploy without a manual migration step. One row per
// (user, problem), accumulated across every visit — not per-attempt, since a
// student can spend time reading/re-reading a problem between submissions.
async function ensureTimeTrackingSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS problem_time_logs (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
ensureTimeTrackingSchema();

// Auto-provisions the optional per-assignment time limit column. NULL (the
// default for every existing row) means "no limit" — this is deliberately
// nullable rather than defaulting to 0, so "unset" and "zero minutes" can
// never be confused with each other anywhere downstream.
async function ensureTimeLimitColumn() {
  try {
    await pool.query(`ALTER TABLE problems ADD COLUMN IF NOT EXISTS time_limit_seconds INTEGER`);
  } catch (err) {
    console.error('Failed to ensure time_limit_seconds column:', err);
  }
}
ensureTimeLimitColumn();

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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exam_items (
        id SERIAL PRIMARY KEY,
        exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('mcq', 'short', 'long', 'coding')),
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
  }
}
ensureExamSchema();

// Auto-provisions the exam-taking data model: one `exam_attempts` row per
// (exam, student) — the UNIQUE(exam_id, user_id) constraint is what makes
// "one attempt ever, no resuming after you leave" structural rather than an
// app-level check that could race — plus `exam_answers`, one row per item
// answered. Separate from ensureExamSchema() above since that one only
// covers the admin-authored exam definition, not a student's progress
// through it.
async function ensureExamSubmissionSchema() {
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
  } catch (err) {
    console.error('Failed to ensure exam submission schema:', err);
  }
}
ensureExamSubmissionSchema();

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
ensureExamProctoringSchema();

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
ensureGradeBandsSchema();

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
ensureTagVisibilitySchema();

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
ensureMembershipsSchema();

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
ensureOrganizationVerificationSchema();

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
ensureOrgLevelDefsSchema();

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
ensureOrgUnitsSchema();

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
    subjectsSchemaPromise = Promise.all([ensureOrganizationsSchema(), ensureOrgUnitsSchema()]).then(async () => {
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
ensureSubjectsSchema();

// ============================================================================
// BILLING — subscription plans by student headcount, via Razorpay.
// ============================================================================

// Fixed product config, not admin-editable data — unlike grade_bands/
// tag_visibility_settings (genuinely per-org admin settings), nobody edits
// these tiers through a UI. A pricing change should go through code review
// + deploy, not a live UPDATE against the production DB, so this stays a
// constant rather than a table. Amounts in paise (Razorpay's own unit),
// not rupees, to avoid a float-rupee conversion bug at the one place it'd
// matter most.
// TEMPORARY test-mode pricing — knocked down to a few rupees so live
// checkout testing doesn't need real money riding on it. Real prices
// (commented below each line) go back in before this ever takes live
// payments — restoring them is a one-line-per-tier edit, nothing else
// in the billing system depends on the actual amounts.
const PLAN_CATALOG = {
  free:        { label: 'Free',        studentCap: 30,   monthlyPaise: 0,   annualPaise: 0   },
  starter:     { label: 'Starter',     studentCap: 150,  monthlyPaise: 100, annualPaise: 200  }, // real: 99900 / 999000
  growth:      { label: 'Growth',      studentCap: 500,  monthlyPaise: 200, annualPaise: 400  }, // real: 299900 / 2999000
  institution: { label: 'Institution', studentCap: 2000, monthlyPaise: 300, annualPaise: 600  }, // real: 799900 / 7999000
};
const PAID_PLAN_KEYS = ['starter', 'growth', 'institution'];
const BILLING_CYCLES = ['monthly', 'annual'];

// Global (not per-org) cache mapping this app's (plan_key, billing_cycle)
// to the Razorpay-side Plan object Razorpay itself generates an ID for —
// at most 6 rows (3 paid tiers x 2 cycles). Populated lazily on first real
// checkout (see ensureRazorpayPlan below), never at boot: no live Razorpay
// keys exist yet, and a boot-time call would either throw on every restart
// or silently no-op forever if guarded — both worse than calling it once,
// on demand, the first time anyone actually checks out into a given tier.
let razorpayPlansSchemaPromise = null;
function ensureRazorpayPlansSchema() {
  if (!razorpayPlansSchemaPromise) {
    razorpayPlansSchemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS razorpay_plans (
        id SERIAL PRIMARY KEY,
        plan_key TEXT NOT NULL CHECK (plan_key IN ('starter', 'growth', 'institution')),
        billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'annual')),
        razorpay_plan_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (plan_key, billing_cycle)
      )
    `).catch((err) => console.error('Failed to ensure razorpay_plans schema:', err));
  }
  return razorpayPlansSchemaPromise;
}
ensureRazorpayPlansSchema();

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
        plan_key TEXT NOT NULL DEFAULT 'free' CHECK (plan_key IN ('free', 'starter', 'growth', 'institution')),
        billing_cycle TEXT CHECK (billing_cycle IN ('monthly', 'annual')),
        status TEXT NOT NULL DEFAULT 'free' CHECK (status IN
          ('free', 'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired')),
        razorpay_subscription_id TEXT UNIQUE,
        razorpay_plan_id TEXT,
        current_period_end TIMESTAMPTZ,
        pending_plan_key TEXT CHECK (pending_plan_key IN ('starter', 'growth', 'institution')),
        pending_billing_cycle TEXT CHECK (pending_billing_cycle IN ('monthly', 'annual')),
        pending_razorpay_subscription_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)).catch((err) => console.error('Failed to ensure subscriptions schema:', err));
  }
  return subscriptionsSchemaPromise;
}
ensureSubscriptionsSchema();

// Lazily constructed — RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET don't exist yet
// in this deploy (test-mode keys are still being set up), so this can't be
// built at module load like most other external clients in this file
// (compare to `const resend = new Resend(...)`, built eagerly since Resend
// tolerates an unset key until actually used). Returns null — never
// throws — when unconfigured, so every caller can cleanly 503 instead of
// crashing the process.
let razorpayClient = null;
function getRazorpayClient() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
}

// Idempotent, on-demand Razorpay Plan creation — the first admin who
// checks out into a never-before-used (tier, cycle) combination creates it;
// every call after that is a single indexed SELECT. Never runs at boot, so
// there's no manual script to run against production once real keys land —
// the very first real checkout attempt bootstraps whichever plan it needs.
async function ensureRazorpayPlan(planKey, billingCycle) {
  await ensureRazorpayPlansSchema();
  const cached = await pool.query(
    'SELECT razorpay_plan_id FROM razorpay_plans WHERE plan_key = $1 AND billing_cycle = $2',
    [planKey, billingCycle]
  );
  if (cached.rows.length > 0) return cached.rows[0].razorpay_plan_id;

  const rzp = getRazorpayClient();
  if (!rzp) throw new Error('Razorpay is not configured (missing API keys)');

  const plan = PLAN_CATALOG[planKey];
  const amount = billingCycle === 'monthly' ? plan.monthlyPaise : plan.annualPaise;
  const created = await rzp.plans.create({
    period: billingCycle === 'monthly' ? 'monthly' : 'yearly',
    interval: 1,
    item: { name: `AssignMeant ${plan.label} (${billingCycle})`, amount, currency: 'INR' },
  });

  // ON CONFLICT covers two admins simultaneously triggering checkout for the
  // same never-before-used (planKey, cycle) pair — both would create a
  // Razorpay Plan object (harmless, Razorpay allows duplicates), but only
  // one row survives locally; the re-SELECT below picks up whichever won.
  const inserted = await pool.query(
    `INSERT INTO razorpay_plans (plan_key, billing_cycle, razorpay_plan_id) VALUES ($1, $2, $3)
     ON CONFLICT (plan_key, billing_cycle) DO NOTHING RETURNING razorpay_plan_id`,
    [planKey, billingCycle, created.id]
  );
  if (inserted.rows.length > 0) return inserted.rows[0].razorpay_plan_id;
  const winner = await pool.query(
    'SELECT razorpay_plan_id FROM razorpay_plans WHERE plan_key = $1 AND billing_cycle = $2',
    [planKey, billingCycle]
  );
  return winner.rows[0].razorpay_plan_id;
}

// A missing subscriptions row (an org that predates this feature) and a
// row whose status isn't currently 'active' (lapsed, cancelled, halted,
// still mid-checkout, etc.) both fall back to 'free' — this single rule is
// also what implements the downgrade/cancellation policy: the moment a
// webhook flips status away from 'active', every cap check everywhere
// immediately reflects it, with no separate "downgrade" code path needed.
async function getEffectivePlanKey(organizationId) {
  await ensureSubscriptionsSchema();
  const { rows } = await pool.query('SELECT plan_key, status FROM subscriptions WHERE organization_id = $1', [organizationId]);
  if (rows.length === 0) return 'free';
  return rows[0].status === 'active' ? rows[0].plan_key : 'free';
}

// Shared by every student-provisioning route (create-student, CSV import,
// the Google Form webhook) — hard-blocks once an org's student count would
// reach its plan's cap. `additional` lets a caller ask "is there room for N
// more" without adding them yet (used by CSV import to pre-flight-check
// remaining headroom once before its per-row loop, rather than re-querying
// the plan/count on every single row).
async function checkStudentCap(organizationId, additional = 1) {
  const planKey = await getEffectivePlanKey(organizationId);
  const cap = PLAN_CATALOG[planKey].studentCap;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'student'`,
    [organizationId]
  );
  const current = rows[0].n;
  return {
    ok: current + additional <= cap,
    current,
    cap,
    planKey,
    planLabel: PLAN_CATALOG[planKey].label,
    remaining: Math.max(0, cap - current),
  };
}

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
  await ensureSubjectsSchema();
  try {
    await pool.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL');
  } catch (err) {
    console.error('Failed to ensure problems.subject_id:', err);
  }
}
ensureProblemsSubjectColumn();

async function ensureExamsSubjectColumn() {
  await Promise.all([ensureSubjectsSchema(), ensureExamSchema()]);
  try {
    await pool.query('ALTER TABLE exams ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL');
  } catch (err) {
    console.error('Failed to ensure exams.subject_id:', err);
  }
}
ensureExamsSubjectColumn();

// Email sending via Resend's HTTPS API instead of raw SMTP — Render blocks
// outbound traffic on SMTP ports 25/465/587 for free web services (since
// Sep 2025), which is what made nodemailer/Gmail time out. Resend just makes
// a normal HTTPS request, so it isn't affected by that restriction.
const resend = new Resend(process.env.RESEND_API_KEY);
// Until you verify your own domain in the Resend dashboard, you can only
// send FROM this address, and only TO the email you signed up to Resend
// with — see the note further down where this is used.
const EMAIL_FROM = process.env.EMAIL_FROM || 'AssignMeant <onboarding@resend.dev>';
// Single source of truth for the deployed frontend URL, used by every email
// that needs to link back into the app (credentials email, reset-password
// email). Defined once so changing domains later only means updating one
// env var, not hunting down every hardcoded link across the file.
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

/**
 * Utility: Generates a cryptographically secure 10-character alphanumeric password
 */
function generateRandomPassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return password;
}

// Shared by admin create-student, the Google Form webhook, and CSV import —
// every path that provisions a person into an organization. `users` is a
// global identity now (one row per email, shared across every organization
// that email belongs to), so "add this email to my org" is really two
// separate questions: does a global identity already exist for it, and
// separately, does *this org* have a membership for it yet. This only ever
// answers the first question — it never touches an existing identity's
// password, so joining a second organization can never invalidate
// credentials that already work somewhere else.
async function findOrCreateGlobalUser(client, email) {
  const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return { userId: existing.rows[0].id, isNew: false, temporaryPassword: null };
  }
  const rawPassword = generateRandomPassword();
  const hashedPassword = await bcrypt.hash(rawPassword, 10);
  const inserted = await client.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hashedPassword]
  );
  return { userId: inserted.rows[0].id, isNew: true, temporaryPassword: rawPassword };
}

// Validates the optional per-assignment time limit sent from AssignmentForm.
// '', null, and undefined all mean "no limit" and normalize to null; any
// other value must be a positive whole number of seconds. Shared by the
// create and update routes so the rule can't drift between the two. Throws
// on anything invalid — callers turn that straight into a 400.
function normalizeTimeLimitSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Time limit must be a positive number of seconds, or left blank for no limit');
  }
  return Math.round(n);
}

const EXAM_ITEM_TYPES = new Set(['mcq', 'short', 'long', 'coding']);

// Validates + normalizes one item from the exam builder's payload, returning
// a clean object ready to insert. Throws a message naming the offending item
// (1-indexed, matching what the admin sees on screen), which the route
// handlers turn straight into a 400 — so a bad MCQ buried in item #7 doesn't
// just come back as a generic "bad request".
function normalizeExamItem(raw, index) {
  const label = `Item ${index + 1}`;
  if (!raw || !EXAM_ITEM_TYPES.has(raw.type)) {
    throw new Error(`${label}: type must be one of mcq, short, long, coding`);
  }

  const marks = Number(raw.marks);
  if (!Number.isFinite(marks) || marks <= 0) {
    throw new Error(`${label}: marks must be a positive number`);
  }

  let timeLimitSeconds;
  try {
    timeLimitSeconds = normalizeTimeLimitSeconds(raw.timeLimitSeconds);
  } catch {
    throw new Error(`${label}: time limit must be a positive number of seconds, or left blank`);
  }

  const base = { type: raw.type, marks: Math.round(marks), timeLimitSeconds };

  if (raw.type === 'mcq') {
    const prompt = String(raw.prompt || '').trim();
    if (!prompt) throw new Error(`${label}: question text is required`);

    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    const options = rawOptions
      .filter((o) => o && String(o.text || '').trim())
      .map((o, i) => ({ id: o.id != null ? String(o.id) : String(i), text: String(o.text).trim() }));
    if (options.length < 2) throw new Error(`${label}: MCQ needs at least 2 options`);

    const correctOptionId = raw.correctOptionId != null ? String(raw.correctOptionId) : null;
    if (!correctOptionId || !options.some((o) => o.id === correctOptionId)) {
      throw new Error(`${label}: select which option is correct`);
    }

    return { ...base, prompt, options, correctOptionId, wordLimit: null, problemId: null, starterCode: null, testCases: null };
  }

  if (raw.type === 'short' || raw.type === 'long') {
    const prompt = String(raw.prompt || '').trim();
    if (!prompt) throw new Error(`${label}: question text is required`);

    let wordLimit = null;
    if (raw.wordLimit !== null && raw.wordLimit !== undefined && raw.wordLimit !== '') {
      wordLimit = Number(raw.wordLimit);
      if (!Number.isFinite(wordLimit) || wordLimit <= 0) {
        throw new Error(`${label}: word limit must be a positive number, or left blank`);
      }
      wordLimit = Math.round(wordLimit);
    }

    return { ...base, prompt, options: null, correctOptionId: null, wordLimit, problemId: null, starterCode: null, testCases: null };
  }

  // coding — either "reuse" (problemId points at an existing assignment,
  // its problems/test_cases/starter_code rows are used as-is) or "custom"
  // (authored inline here: its own prompt/starterCode/testCases, no
  // problemId). Reuse mode is signaled by a problemId being present at all;
  // custom mode is everything else, mirroring AssignmentForm's own
  // cleanCases-then-require-at-least-one-case validation.
  if (raw.problemId !== null && raw.problemId !== undefined && raw.problemId !== '') {
    const problemId = Number(raw.problemId);
    if (!Number.isFinite(problemId)) {
      throw new Error(`${label}: pick an existing coding assignment`);
    }
    return {
      ...base,
      prompt: raw.prompt ? String(raw.prompt).trim() : null,
      options: null, correctOptionId: null, wordLimit: null,
      problemId, starterCode: null, testCases: null,
    };
  }

  const prompt = String(raw.prompt || '').trim();
  if (!prompt) throw new Error(`${label}: question text is required`);

  const rawStarterCode = raw.starterCode && typeof raw.starterCode === 'object' ? raw.starterCode : {};
  const starterCode = Object.fromEntries(
    Object.entries(rawStarterCode)
      .filter(([lang, code]) => ['python', 'c', 'cpp', 'java'].includes(lang) && String(code || '').trim())
      .map(([lang, code]) => [lang, String(code)])
  );

  const rawTestCases = Array.isArray(raw.testCases) ? raw.testCases : [];
  const testCases = rawTestCases
    .filter((tc) => tc && String(tc.expectedOutput || '').trim())
    .map((tc) => ({ input: String(tc.input || ''), expectedOutput: String(tc.expectedOutput), isHidden: !!tc.isHidden }));
  if (testCases.length === 0) {
    throw new Error(`${label}: pick an existing assignment, or add at least one test case with an expected output`);
  }

  return {
    ...base, prompt, options: null, correctOptionId: null, wordLimit: null,
    problemId: null, starterCode, testCases,
  };
}

// ============================================================================
// Auth Middleware
// ============================================================================

/**
 * Verifies the JWT cookie set at login and attaches { userId, role } to req.user.
 * Every route that touches the Docker sandbox or student data should sit behind this â€”
 * previously nothing did, which meant /api/execute/* was callable by anyone, logged in or not.
 */
function authenticateToken(req, res, next) {
  // Authorization header, not a cookie â€” deliberately. Frontend (github.io)
  // and backend (onrender.com) don't share a domain, and iOS forces every
  // browser onto WebKit, which blocks third-party cookies unconditionally.
  // A Bearer token in a header carries none of that baggage, on any browser,
  // on any device, today or as cookie policies keep tightening in future.
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // A pre-auth token (minted mid-login, before the caller has picked which
    // organization to enter — see POST /api/login) carries no role/org at
    // all, so it must never be usable against a real route.
    if (payload.type === 'preauth') {
      return res.status(401).json({ error: 'Login not complete — select an organization first' });
    }
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Problem/exam create/update/delete routes accept either role — an admin
// has unrestricted org-wide authority same as always; a teacher's actual
// authority is narrowed per-request inside the route itself (must supply a
// subject_id they're linked to via subject_teachers — see the routes
// below), not by this middleware alone.
function requireAdminOrTeacher(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'teacher') {
    return res.status(403).json({ error: 'Admin or teacher access required' });
  }
  next();
}

// Shared by every problem/exam create/update/delete route: a teacher must
// name a subject they're actually linked to (403, not 404 — they
// legitimately know the subject exists, this is a pure authorization
// denial); an admin has unrestricted authority and this is a no-op for
// them. Returns nothing on success, throws-via-response on failure — call
// sites should `if (await enforceSubjectAuthority(req, res, subjectId)) return;`.
async function enforceSubjectAuthority(req, res, subjectId) {
  if (req.user.role === 'admin') return false;
  if (!subjectId) {
    res.status(400).json({ error: 'Teachers must specify a subject' });
    return true;
  }
  const check = await pool.query(
    'SELECT 1 FROM subject_teachers st JOIN subjects s ON s.id = st.subject_id WHERE st.subject_id = $1 AND st.user_id = $2 AND s.organization_id = $3',
    [subjectId, req.user.userId, req.user.organizationId]
  );
  if (check.rows.length === 0) {
    res.status(403).json({ error: 'You are not assigned to this subject' });
    return true;
  }
  return false;
}

// Gates the platform-owner organization-approval routes. Deliberately NOT
// JWT/membership-based — a platform owner plausibly isn't a member of any
// tenant organization at all, which would fail the "0 memberships" branch
// of POST /api/login outright. A single shared secret, checked via a
// header, is the simplest mechanism that fits a single-operator surface;
// fails closed if the env var was never set.
function requirePlatformSecret(req, res, next) {
  const provided = req.headers['x-platform-secret'];
  if (!process.env.PLATFORM_OWNER_SECRET || provided !== process.env.PLATFORM_OWNER_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Generic consumer webmail domains a real institution is very unlikely to
// sign up with — a denylist rather than an allowlist, since there's no
// practical way to enumerate every legitimate school/college domain in
// advance. Doesn't guarantee legitimacy on its own (see the platform-owner
// approval gate below for that); it just filters out the trivial case.
const DENYLISTED_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com',
  'protonmail.com', 'proton.me', 'mail.com', 'gmx.com', 'yandex.com',
  'zoho.com', 'rediffmail.com',
]);

// ============================================================================
// Sandbox Runner â€” shared by Playground execution AND graded problem submissions
// ============================================================================

const LANGUAGE_CONFIG = {
  python: {
    filename: 'main.py',
    buildCmd: null,
    runCmd: ['python3', ['main.py']],
    memKb: 65536,   // ulimit -v, in KB
    cpuSec: 5,      // ulimit -t
  },
  c: {
    filename: 'main.c',
    buildCmd: ['gcc', ['main.c', '-o', 'program']],
    runCmd: ['./program', []],
    memKb: 65536,
    cpuSec: 5,
  },
  cpp: {
    filename: 'main.cpp',
    buildCmd: ['g++', ['main.cpp', '-o', 'program']],
    runCmd: ['./program', []],
    memKb: 98304,
    cpuSec: 5,
  },
  java: {
    filename: 'Main.java',
    // -J-Xmx / -Xmx cap the JVM's actual heap usage directly â€” this is the
    // correct way to limit Java memory. ulimit -v (virtual address space) is
    // NOT used for Java: JVMs reserve huge virtual address ranges on startup
    // (heap headroom, metaspace, JIT code cache, thread stacks) regardless of
    // real usage, so a tight -v limit kills the JVM before it can even print
    // an error â€” which is exactly what an empty-stderr "Compilation failed"
    // with no compiler output means.
    buildCmd: ['javac', ['-J-Xmx256m', 'Main.java']],
    runCmd: ['java', ['-Xmx256m', 'Main']],
    memKb: 262144,  // JVM baseline overhead is real â€” give it room
    cpuSec: 8,
    noVirtualMemLimit: true,
  },
};

// Dedicated low-privilege user that student code actually runs as, so a
// runaway/malicious submission can't touch the Express process, its env
// vars (DATABASE_URL, JWT_SECRET), or other students' temp files. Created
// in the Dockerfile with `useradd -m -s /usr/sbin/nologin sandbox`.
const SANDBOX_UID = Number(process.env.SANDBOX_UID || 1001);
const SANDBOX_GID = Number(process.env.SANDBOX_GID || 1001);

// Only the deployed container runs this process as root (see Dockerfile),
// which is what makes chown-ing temp files to the `sandbox` user and
// spawning as that uid possible. On local dev (your own Mac/Linux user
// account), there's no permission to do either and no uid 1001 to switch
// to, so we skip privilege-dropping entirely and just run as yourself â€”
// ulimits still apply either way, this only affects the extra user-isolation
// layer, which isn't needed against your own local test runs anyway.
const canDropPrivileges = typeof process.getuid === 'function' && process.getuid() === 0;

const { spawn } = require('child_process');

/**
 * Runs one command as the unprivileged `sandbox` user inside `cwd`, with
 * ulimits applied via a wrapping shell (ulimit is a shell builtin, not a
 * standalone binary, so it has to be set inside `sh -c` before exec'ing
 * the real program). Resolves { code, stdout, stderr, timedOut }.
 */
function runLimited(cwd, memKb, cpuSec, [cmd, args], stdinData = '', skipVirtualMemLimit = false) {
  return new Promise((resolve) => {
    const quotedArgs = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    // -v and -u are Linux-only here. -v breaks dyld's shared-library loading
    // on macOS (see above); -u (max processes) is worse on macOS because
    // RLIMIT_NPROC counts every process owned by the user SYSTEM-WIDE, not
    // just this command's subtree â€” any real dev machine already exceeds a
    // limit like 32 before compilation even starts, since Chrome/VS
    // Code/Docker Desktop/etc. all run under the same uid. Both are meaningful
    // and safe on Linux (production), where the container has its own
    // isolated process namespace with nothing else running under that uid.
    const isMac = process.platform === 'darwin';
    // Each ulimit call is wrapped with `2>/dev/null || true` so an unsupported
    // flag on whatever /bin/sh is actually running this (dash, BusyBox ash,
    // etc. all differ slightly) can never abort the script or leak a shell
    // error into stderr where it'd look like the program itself failed. The
    // limit just silently doesn't apply on shells that don't support it,
    // rather than breaking every submission in that language.
    const memLimitLine = (isMac || skipVirtualMemLimit) ? '' : `ulimit -v ${memKb} 2>/dev/null || true;`;
    const procLimitLine = isMac ? '' : `ulimit -u 32 2>/dev/null || true;`;
    const shellLine = `${memLimitLine} ulimit -t ${cpuSec} 2>/dev/null || true; ${procLimitLine} ulimit -f 2048 2>/dev/null || true; exec ${cmd} ${quotedArgs}`;

    const child = spawn('sh', ['-c', shellLine], {
      cwd,
      ...(canDropPrivileges ? { uid: SANDBOX_UID, gid: SANDBOX_GID } : {}),
      timeout: (cpuSec + 3) * 1000,
      env: { PATH: process.env.PATH },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (d) => { if (stdout.length < 1_000_000) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1_000_000) stderr += d; });
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message, timedOut: false }));
    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM') timedOut = true;
      resolve({ code, stdout, stderr, timedOut });
    });

    // If the child exits (or never reads stdin at all) before this write
    // finishes, the pipe closes underneath us and .write() throws EPIPE.
    // Without this handler that's an UNCAUGHT exception that crashes the
    // entire Node process â€” not just this one request â€” taking every
    // student's session down with it. The 'close' listener above still
    // resolves this promise normally either way, so silently swallowing the
    // write error here is safe: we just don't fail to deliver stdin to a
    // process that was never going to read it anyway.
    child.stdin.on('error', () => {});
    try {
      child.stdin.write(stdinData ?? '');
      child.stdin.end();
    } catch {
      // Same reasoning as above â€” pipe already gone, nothing to do.
    }
  });
}

/**
 * Runs `code` as the unprivileged `sandbox` user with per-language memory/
 * CPU ulimits, and returns its stdout. No Docker involved â€” this is what
 * lets the whole app run on a plain Render web service with no privileged
 * container access, at the cost of weaker filesystem/network isolation
 * than the old Docker version (acceptable for beginner-level submissions,
 * not a substitute for real container sandboxing against adversarial code).
 */
async function executeInSandboxRaw(language, code, stdin = '') {
  const config = LANGUAGE_CONFIG[language];
  if (!config) {
    return { success: false, timedOut: false, output: '', error: 'Unsupported language' };
  }

  const executionDir = path.join(tempDir, crypto.randomUUID());
  fs.mkdirSync(executionDir, { recursive: true, mode: 0o770 });

  const cleanup = () => {
    if (fs.existsSync(executionDir)) fs.rmSync(executionDir, { recursive: true, force: true });
  };

  try {
    fs.writeFileSync(path.join(executionDir, config.filename), code);
    if (canDropPrivileges) {
      fs.chownSync(executionDir, SANDBOX_UID, SANDBOX_GID);
      fs.chownSync(path.join(executionDir, config.filename), SANDBOX_UID, SANDBOX_GID);
    }
  } catch (err) {
    cleanup();
    return { success: false, timedOut: false, output: '', error: 'Failed to prepare execution files' };
  }

  if (config.buildCmd) {
    const build = await runLimited(executionDir, config.memKb, config.cpuSec, config.buildCmd, '', config.noVirtualMemLimit);
    if (build.code !== 0) {
      cleanup();
      return { success: false, timedOut: build.timedOut, output: '', error: build.stderr || 'Compilation failed' };
    }
  }

  const run = await runLimited(executionDir, config.memKb, config.cpuSec, config.runCmd, stdin, config.noVirtualMemLimit);
  cleanup();

  if (run.timedOut) {
    return { success: false, timedOut: true, output: '', error: 'Execution timed out (Infinite loop detected)' };
  }
  if (run.code !== 0) {
    return { success: false, timedOut: false, output: '', error: run.stderr || `Exited with code ${run.code}` };
  }
  return { success: true, timedOut: false, output: run.stdout, error: null };
}

// Caps how many student programs run at once on this instance. Without this,
// a deadline-night burst spawns dozens of compilers/interpreters simultaneously
// and starves the box (and this Express process along with it). Tune the
// number to your Render plan's actual vCPU count â€” don't exceed it for
// compile-heavy languages (C/C++/Java). Requires: npm install p-limit
const pLimit = require('p-limit');
const sandboxLimit = pLimit(Number(process.env.SANDBOX_CONCURRENCY || 4));

function executeInSandbox(language, code, stdin = '') {
  return sandboxLimit(() => executeInSandboxRaw(language, code, stdin));
}

function normalizeOutput(str) {
  return (str ?? '').replace(/\r\n/g, '\n').trim();
}

/**
 * Computes an assignment's availability from its opens_at/closes_at columns.
 * Both are nullable â€” no opens_at means "no start gate", no closes_at means "never closes".
 *   - 'upcoming': before opens_at â€” hidden from students entirely
 *   - 'open':     within the window (or no window at all) â€” visible and submittable
 *   - 'closed':   after closes_at â€” still visible, but read-only for students
 */
function getProblemStatus(problem) {
  const now = new Date();
  if (problem.opens_at && now < new Date(problem.opens_at)) return 'upcoming';
  if (problem.closes_at && now > new Date(problem.closes_at)) return 'closed';
  return 'open';
}

// Every subject a student can see given their own org_unit — not just
// subjects attached directly to their unit, but any subject attached to an
// ANCESTOR of it too (a subject on "Computer Science", a Department-tier
// unit, reaches every Year beneath it). Tree depth is capped at ~8 tiers in
// practice, so this recursive walk is cheap. A student with no org_unit at
// all (orgUnitId null) can only see org-wide, subject-less items.
async function getVisibleSubjectIds(orgUnitId) {
  if (!orgUnitId) return [];
  const { rows } = await pool.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_unit_id FROM org_units WHERE id = $1
       UNION ALL
       SELECT ou.id, ou.parent_unit_id FROM org_units ou JOIN ancestors a ON ou.id = a.parent_unit_id
     )
     SELECT s.id FROM subjects s WHERE s.org_unit_id IN (SELECT id FROM ancestors)`,
    [orgUnitId]
  );
  return rows.map((r) => r.id);
}

// Fetches every org_unit + level label for an org once, so a whole list of
// students can each have their tier path (e.g. "North Campus / Computer
// Science / Year 1") resolved by walking an in-memory map instead of one
// recursive SQL query per row — matters once a roster has a few hundred
// students in it.
async function getOrgUnitLookup(organizationId) {
  const [levelsRes, unitsRes] = await Promise.all([
    pool.query('SELECT id, label FROM org_level_defs WHERE organization_id = $1', [organizationId]),
    pool.query('SELECT id, parent_unit_id, name, level_def_id FROM org_units WHERE organization_id = $1', [organizationId]),
  ]);
  const levelsById = new Map(levelsRes.rows.map((l) => [l.id, l.label]));
  const unitsById = new Map(unitsRes.rows.map((u) => [u.id, u]));
  return { levelsById, unitsById };
}

// Root-to-leaf breadcrumb for one unit — [{label:'Campus', name:'North
// Campus'}, {label:'Department', name:'Computer Science'}, ...]. Empty
// array for a student with no org_unit assigned at all.
function resolveOrgUnitPath({ levelsById, unitsById }, orgUnitId) {
  const parts = [];
  let current = orgUnitId ? unitsById.get(orgUnitId) : null;
  while (current) {
    parts.unshift({ label: levelsById.get(current.level_def_id) || null, name: current.name });
    current = current.parent_unit_id ? unitsById.get(current.parent_unit_id) : null;
  }
  return parts;
}

// Bootstraps (or validates) an org's tier shape directly from a roster
// file/form's own column headers — no separate "build your structure
// first" step. tierLabels is the ordered list of non-name/email column
// headers (left to right = top tier to bottom tier), exactly matching the
// shape the user described: "Campus -> Department -> Year -> credentials".
//
// First use for an org with zero org_level_defs: creates them from
// tierLabels, in order. Every later call just needs the same COLUMN COUNT
// — the org's own tier labels win from then on (a slightly reworded header
// shouldn't fracture the tree), so this only ever compares lengths, never
// label text, once levels already exist.
async function ensureLevelsForTierLabels(organizationId, tierLabels) {
  const existing = await pool.query(
    'SELECT id, tier_index, label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC',
    [organizationId]
  );
  if (existing.rows.length > 0) {
    if (existing.rows.length !== tierLabels.length) {
      const have = existing.rows.map((l) => l.label).join(', ');
      return { error: true, reason: `Your organization structure has ${existing.rows.length} tier(s) (${have}) but this file has ${tierLabels.length} — the columns before Name/Email must match in count` };
    }
    return { levels: existing.rows };
  }
  if (tierLabels.length === 0) return { levels: [] };

  const inserted = [];
  for (let i = 0; i < tierLabels.length; i++) {
    const r = await pool.query(
      'INSERT INTO org_level_defs (organization_id, tier_index, label) VALUES ($1, $2, $3) RETURNING id, tier_index, label',
      [organizationId, i, tierLabels[i]]
    );
    inserted.push(r.rows[0]);
  }
  return { levels: inserted };
}

// Walks tierValues (same order as `levels`) root-to-leaf, finding or
// CREATING each org_unit along the way — a roster upload is now the
// primary way an org's tree gets populated at all, not just a consumer of
// one built by hand first. Case-insensitive, trimmed match against an
// existing unit's name before creating a new one, so re-uploading the same
// roster (or a form filled out by many students in the same class) doesn't
// fragment into duplicates over a stray space or capitalization.
async function resolveOrCreateOrgUnit(organizationId, levels, tierValues) {
  let parentUnitId = null;
  let resolvedUnitId = null;
  const created = [];
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const value = String(tierValues[i] ?? '').trim();
    if (!value) return { error: true, reason: `Missing value for "${level.label}"` };

    const existing = parentUnitId === null
      ? await pool.query(
          'SELECT id FROM org_units WHERE organization_id = $1 AND level_def_id = $2 AND name ILIKE $3 AND parent_unit_id IS NULL',
          [organizationId, level.id, value]
        )
      : await pool.query(
          'SELECT id FROM org_units WHERE organization_id = $1 AND level_def_id = $2 AND name ILIKE $3 AND parent_unit_id = $4',
          [organizationId, level.id, value, parentUnitId]
        );

    if (existing.rows.length > 0) {
      resolvedUnitId = existing.rows[0].id;
    } else {
      const inserted = await pool.query(
        'INSERT INTO org_units (organization_id, level_def_id, parent_unit_id, name) VALUES ($1, $2, $3, $4) RETURNING id',
        [organizationId, level.id, parentUnitId, value]
      );
      resolvedUnitId = inserted.rows[0].id;
      created.push(`${level.label}: ${value}`);
    }
    parentUnitId = resolvedUnitId;
  }
  return { orgUnitId: resolvedUnitId, created };
}

// Given a header row (or, for the webhook, the POSTed field names), splits
// out which columns are Name/Email and returns the rest in their original
// left-to-right order — that order IS the tier chain, top to bottom.
function splitTierAndIdentityColumns(headerKeys) {
  let nameKey = null;
  let emailKey = null;
  const tierKeys = [];
  for (const key of headerKeys) {
    const normalized = key.trim().toLowerCase();
    if (normalized === 'name' && nameKey === null) nameKey = key;
    else if (normalized === 'email' && emailKey === null) emailKey = key;
    else tierKeys.push(key);
  }
  return { nameKey, emailKey, tierKeys };
}

// Resolves the FULL (including hidden) test-case list for a coding exam
// item, regardless of whether it's "reuse" mode (problem_id set — pull from
// the problems/test_cases tables like the assignment judge does) or
// "custom" mode (problem_id NULL — the item authored its own test_cases
// JSONB inline). Callers that only care about grading don't need to know
// which source they came from. If the linked problem was since deleted
// (exam_items.problem_id -> NULL via its existing ON DELETE SET NULL) or a
// custom item somehow has none, returns an empty list rather than throwing,
// so one dangling item can't fail an entire submit.
async function getExamItemTestCases(item) {
  if (item.problem_id) {
    const res = await pool.query(
      'SELECT input, expected_output FROM test_cases WHERE problem_id = $1',
      [item.problem_id]
    );
    return res.rows;
  }
  if (Array.isArray(item.test_cases)) {
    return item.test_cases.map((tc) => ({ input: tc.input, expected_output: tc.expectedOutput }));
  }
  return [];
}

// Runs EVERY test case (unlike /api/problems/:id/submit, which stops at the
// first failure) so the item can be awarded proportional partial credit
// instead of one binary pass/fail verdict.
async function gradeCodingAnswer(testCases, language, code) {
  if (!testCases || testCases.length === 0 || !language || !code) return { passedCount: 0, totalCount: 0 };

  let passedCount = 0;
  for (const tc of testCases) {
    const result = await executeInSandbox(language, code, tc.input);
    if (result.success && normalizeOutput(result.output) === normalizeOutput(tc.expected_output)) {
      passedCount += 1;
    }
  }
  return { passedCount, totalCount: testCases.length };
}

// Grades every answer in `answers` against `examItems`, upserts one row per
// item into exam_answers, and returns the summed auto-graded score. Shared
// by the real submit route and the "reopened a stale in-progress attempt"
// path in /start, so grading logic never forks between the two callers.
// mcq is graded exactly (full marks or zero); coding gets proportional
// partial credit; short/long are stored raw with marks_awarded left NULL —
// grading those is a manual-review feature that doesn't exist yet.
async function finalizeExamAttempt(attemptId, examItems, answers) {
  const itemsById = new Map(examItems.map((it) => [it.id, it]));
  let score = 0;

  for (const ans of answers || []) {
    const item = itemsById.get(Number(ans.itemId));
    if (!item) continue; // ignore ids that don't belong to this exam

    let row = {
      selected_option_id: null, text_answer: null, language: null, code: null,
      is_correct: null, passed_count: null, total_count: null, marks_awarded: null,
    };

    if (item.type === 'mcq') {
      const selected = ans.selectedOptionId != null ? String(ans.selectedOptionId) : null;
      const correct = selected != null && selected === item.correct_option_id;
      row.selected_option_id = selected;
      row.is_correct = correct;
      row.marks_awarded = correct ? item.marks : 0;
      score += row.marks_awarded;
    } else if (item.type === 'short' || item.type === 'long') {
      row.text_answer = ans.textAnswer != null ? String(ans.textAnswer) : null;
      // marks_awarded stays NULL — ungraded, doesn't contribute to score
    } else if (item.type === 'coding') {
      const language = ans.language || null;
      const code = ans.code != null ? String(ans.code) : '';
      let passedCount = 0;
      let totalCount = 0;
      try {
        const testCases = await getExamItemTestCases(item);
        ({ passedCount, totalCount } = await gradeCodingAnswer(testCases, language, code));
      } catch (err) {
        console.error('Coding answer grading error:', err);
      }
      const marksAwarded = totalCount > 0 ? Math.round((item.marks * passedCount) / totalCount) : 0;
      row.language = language;
      row.code = code;
      row.passed_count = passedCount;
      row.total_count = totalCount;
      row.marks_awarded = marksAwarded;
      score += marksAwarded;
    }

    await pool.query(
      `INSERT INTO exam_answers (attempt_id, item_id, selected_option_id, text_answer, language, code, is_correct, passed_count, total_count, marks_awarded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (attempt_id, item_id) DO UPDATE SET
         selected_option_id = EXCLUDED.selected_option_id, text_answer = EXCLUDED.text_answer,
         language = EXCLUDED.language, code = EXCLUDED.code, is_correct = EXCLUDED.is_correct,
         passed_count = EXCLUDED.passed_count, total_count = EXCLUDED.total_count, marks_awarded = EXCLUDED.marks_awarded`,
      [attemptId, item.id, row.selected_option_id, row.text_answer, row.language, row.code,
        row.is_correct, row.passed_count, row.total_count, row.marks_awarded]
    );
  }

  return score;
}

// An attempt is "fully graded" once every short/long answer has a
// non-NULL marks_awarded — mcq and coding are always auto-graded at submit
// time, so an exam with no short/long items is fully graded the instant it's
// submitted, no admin action ever needed. Used to gate percentage/grade/
// percentile tags, which are meaningless while any item is still ungraded.
async function isAttemptFullyGraded(attemptId) {
  const res = await pool.query(
    `SELECT NOT EXISTS (
       SELECT 1 FROM exam_answers ea
       JOIN exam_items ei ON ei.id = ea.item_id
       WHERE ea.attempt_id = $1 AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
     ) AS fully_graded`,
    [attemptId]
  );
  return res.rows[0].fully_graded;
}

// Picks the highest band a percentage qualifies for, e.g. a 95% with the
// seeded default bands -> "Excellent". `bands` need not be pre-sorted.
// Returns null if no band's min_percent is low enough to match (e.g. every
// band was deleted, or the lowest remaining band's floor is above the score).
function gradeTagForPercentage(bands, pct) {
  const sorted = [...bands].sort((a, b) => Number(b.min_percent) - Number(a.min_percent));
  const match = sorted.find((b) => pct >= Number(b.min_percent));
  return match ? match.label : null;
}

// Standard mid-rank percentile: ties split the credit rather than one
// arbitrarily outranking the other. Returns a lookup function rather than
// a single value since callers need to place many students against the
// same population (once, not once per student). 5 fixed quintile tiers —
// only the grade bands above were asked to be admin-configurable.
function computePercentileTiers(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.length;
  const tierFor = (percentile) => {
    if (percentile >= 80) return 'Very Strong';
    if (percentile >= 60) return 'Strong';
    if (percentile >= 40) return 'Average';
    if (percentile >= 20) return 'Weak';
    return 'Very Weak';
  };
  return (value) => {
    if (total === 0) return { percentile: null, tag: null };
    let below = 0;
    let equal = 0;
    for (const v of sorted) {
      if (v < value) below += 1;
      else if (v === value) equal += 1;
    }
    const percentile = ((below + 0.5 * equal) / total) * 100;
    return { percentile, tag: tierFor(percentile) };
  };
}

// Per-organization on/off pair gating what students (not teachers — admin
// views never call this) get to see of their own tags.
async function getTagVisibility(organizationId) {
  const res = await pool.query('SELECT show_percentile_tag, show_grade_tag FROM tag_visibility_settings WHERE organization_id = $1', [organizationId]);
  return res.rows[0] || { show_percentile_tag: true, show_grade_tag: false };
}

// ============================================================================
// 1. ADMIN ENDPOINT: Create a single student manually
// ============================================================================
app.post('/api/admin/create-student', authenticateToken, requireAdmin, async (req, res) => {
  const { email } = req.body;
  const orgUnitId = req.body.orgUnitId != null ? Number(req.body.orgUnitId) : null;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const client = await pool.connect();
  try {
    const orgRes = await client.query('SELECT status FROM organizations WHERE id = $1', [req.user.organizationId]);
    if (orgRes.rows[0]?.status !== 'approved') {
      return res.status(403).json({ error: 'Your organization is still pending approval — you cannot add students yet' });
    }

    const cap = await checkStudentCap(req.user.organizationId, 1);
    if (!cap.ok) {
      return res.status(403).json({
        error: `Your ${cap.planLabel} plan (${cap.cap} students) is full — remove a student or upgrade your plan to add more.`,
        planKey: cap.planKey, cap: cap.cap, current: cap.current,
      });
    }

    if (orgUnitId !== null) {
      const unitCheck = await client.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
      if (unitCheck.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    }

    await client.query('BEGIN');

    const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email);

    const memberRes = await client.query(
      `INSERT INTO memberships (user_id, organization_id, role, org_unit_id) VALUES ($1, $2, 'student', $3)
       ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
      [userId, req.user.organizationId, orgUnitId]
    );
    if (memberRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This email is already a member of your organization' });
    }

    await client.query('COMMIT');

    const student = { id: userId, email, role: 'student' };
    if (isNew) {
      res.status(201).json({ message: 'Student account created successfully', student, temporaryPassword });
    } else {
      res.status(201).json({
        message: 'This email already had an AssignMeant account elsewhere — added to your organization. They sign in with their existing password.',
        student,
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Admin create-student error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Mirrors create-student above — same global-identity find-or-create logic,
// just a different membership role. A teacher's actual authority (which
// subjects they can touch) comes from subject_teachers, assigned
// separately via POST /api/admin/subjects/:id/teachers below; orgUnitId
// here is optional and purely informational (org-chart placement), not an
// authority boundary for teachers.
app.post('/api/admin/create-teacher', authenticateToken, requireAdmin, async (req, res) => {
  const { email } = req.body;
  const orgUnitId = req.body.orgUnitId != null ? Number(req.body.orgUnitId) : null;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const client = await pool.connect();
  try {
    const orgRes = await client.query('SELECT status FROM organizations WHERE id = $1', [req.user.organizationId]);
    if (orgRes.rows[0]?.status !== 'approved') {
      return res.status(403).json({ error: 'Your organization is still pending approval — you cannot add teachers yet' });
    }

    if (orgUnitId !== null) {
      const unitCheck = await client.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
      if (unitCheck.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    }

    await client.query('BEGIN');

    const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email);

    const memberRes = await client.query(
      `INSERT INTO memberships (user_id, organization_id, role, org_unit_id) VALUES ($1, $2, 'teacher', $3)
       ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
      [userId, req.user.organizationId, orgUnitId]
    );
    if (memberRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This email is already a member of your organization' });
    }

    await client.query('COMMIT');

    const teacher = { id: userId, email, role: 'teacher' };
    if (isNew) {
      res.status(201).json({ message: 'Teacher account created successfully', teacher, temporaryPassword });
    } else {
      res.status(201).json({
        message: 'This email already had an AssignMeant account elsewhere — added to your organization. They sign in with their existing password.',
        teacher,
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Admin create-teacher error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/teachers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, m.org_unit_id
       FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE m.organization_id = $1 AND m.role = 'teacher'
       ORDER BY u.email ASC`,
      [req.user.organizationId]
    );
    res.status(200).json({ teachers: result.rows });
  } catch (err) {
    console.error('List teachers error:', err);
    res.status(500).json({ error: 'Failed to load teachers' });
  }
});

// ============================================================================
// CSV BULK IMPORT — the manual/roster-file counterpart to the Google Form
// webhook, and the first bulk-provisioning path built (Google Form gets
// upgraded to reuse the same resolution logic right below this section).
// ============================================================================

// Generates a template header row. If the org already has tiers (from an
// earlier upload, or the manual structure builder), it's exactly those
// labels, in order, plus Name/Email — built live from org_level_defs, no
// storage needed. If the org has no structure yet, this is just an
// illustrative starting example — the columns you actually upload with are
// what defines the tiers, nothing needs to be pre-built first.
app.get('/api/admin/students/csv-template', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const levels = await pool.query(
      'SELECT label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC',
      [req.user.organizationId]
    );
    const headers = levels.rows.length > 0
      ? [...levels.rows.map((l) => l.label), 'Name', 'Email']
      : ['Campus', 'Department', 'Year', 'Name', 'Email'];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="student-import-template.csv"');
    res.status(200).send(`${headers.join(',')}\n`);
  } catch (err) {
    console.error('CSV template error:', err);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

app.post('/api/admin/students/csv-import', authenticateToken, requireAdmin, csvUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });

  const orgRes = await pool.query('SELECT status FROM organizations WHERE id = $1', [req.user.organizationId]);
  if (orgRes.rows[0]?.status !== 'approved') {
    return res.status(403).json({ error: 'Your organization is still pending approval — you cannot import students yet' });
  }

  let rows;
  try {
    rows = parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not parse CSV file — check it is valid CSV with a header row' });
  }
  if (rows.length === 0) {
    return res.status(400).json({ error: 'CSV has no data rows' });
  }

  // The header row itself defines the structure — every column that isn't
  // Name/Email, left to right, is one tier (Campus -> Department -> Year,
  // exactly the shape described when this was designed: no separate
  // "build your structure first" step required before a roster can be
  // uploaded at all).
  const { emailKey, nameKey, tierKeys } = splitTierAndIdentityColumns(Object.keys(rows[0]));
  if (!emailKey) {
    return res.status(400).json({ error: 'CSV must have an Email column' });
  }

  const levelsResult = await ensureLevelsForTierLabels(req.user.organizationId, tierKeys);
  if (levelsResult.error) {
    return res.status(400).json({ error: levelsResult.reason });
  }
  const levels = levelsResult.levels;

  // Checked once before the loop, not per-row — the cap doesn't change
  // mid-file. `consumed` tracks headroom used so far; only rows that
  // actually add a NEW member to this org (created or existingAdded) count
  // against it — a row that turns out to already be a member of this org
  // (`skipped`) doesn't consume any of the org's remaining headroom.
  const capBefore = await checkStudentCap(req.user.organizationId, 0);
  let consumed = 0;

  const results = { created: 0, existingAdded: 0, skipped: 0, unitsCreated: [], errors: [] };
  const newAccounts = []; // { email, name, temporaryPassword } — emailed after the loop
  const seenCreatedUnits = new Set();

  // One transaction per ROW, not one for the whole file — a bad row further
  // down shouldn't roll back rows already successfully committed above it.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // +1 for 0-index, +1 for the header row itself
    const email = String(row[emailKey] || '').trim();
    const name = nameKey ? String(row[nameKey] || '').trim() : '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.errors.push({ row: rowNum, email, reason: email ? 'Malformed email' : 'Missing email' });
      continue;
    }

    if (consumed >= capBefore.remaining) {
      results.errors.push({ row: rowNum, email, reason: `Plan cap reached — ${capBefore.planLabel} plan is full (${capBefore.cap} students), row not processed` });
      continue;
    }

    let orgUnitId = null;
    if (levels.length > 0) {
      const resolution = await resolveOrCreateOrgUnit(req.user.organizationId, levels, tierKeys.map((k) => row[k]));
      if (resolution.error) {
        results.errors.push({ row: rowNum, email, reason: resolution.reason });
        continue;
      }
      orgUnitId = resolution.orgUnitId;
      resolution.created.forEach((c) => seenCreatedUnits.add(c));
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email);
      const memberRes = await client.query(
        `INSERT INTO memberships (user_id, organization_id, role, org_unit_id) VALUES ($1, $2, 'student', $3)
         ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
        [userId, req.user.organizationId, orgUnitId]
      );
      await client.query('COMMIT');

      if (memberRes.rows.length === 0) {
        results.skipped++;
      } else if (isNew) {
        results.created++;
        consumed++;
        newAccounts.push({ email, name, temporaryPassword });
      } else {
        results.existingAdded++;
        consumed++;
      }
    } catch (err) {
      await client.query('ROLLBACK');
      results.errors.push({ row: rowNum, email, reason: 'Database error creating this row' });
    } finally {
      client.release();
    }
  }

  // Best-effort, after everything's committed — one bad Resend send
  // shouldn't stop the rest of the batch from going out.
  await Promise.allSettled(newAccounts.map((a) => resend.emails.send({
    from: EMAIL_FROM,
    to: a.email,
    subject: 'Your AssignMeant Account Credentials',
    text: `Hello ${a.name || 'Student'},\n\nYour AssignMeant account is ready!\n\nYour temporary password is: ${a.temporaryPassword}\n\nLogin via ${FRONTEND_URL}\n\nPlease log in and change your password after logging in.`,
  })));

  results.unitsCreated = [...seenCreatedUnits];
  res.status(200).json(results);
});

// Admin-only — includes the org's Google Form webhook secret, so this
// can't live in GET /api/me (which students also call).
app.get('/api/admin/organization', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT name, webhook_secret, default_org_unit_id FROM organizations WHERE id = $1', [req.user.organizationId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    res.status(200).json({
      name: result.rows[0].name,
      webhookSecret: result.rows[0].webhook_secret,
      defaultOrgUnitId: result.rows[0].default_org_unit_id,
    });
  } catch (err) {
    console.error('Get organization error:', err);
    res.status(500).json({ error: 'Failed to load organization' });
  }
});

// The webhook's fallback placement for a bare {name,email}-only form
// submission — one with no other questions to derive a tier chain from.
app.put('/api/admin/organization/default-unit', authenticateToken, requireAdmin, async (req, res) => {
  const orgUnitId = req.body.orgUnitId != null ? Number(req.body.orgUnitId) : null;
  try {
    if (orgUnitId !== null) {
      const unit = await pool.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
      if (unit.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    }
    await pool.query('UPDATE organizations SET default_org_unit_id = $1 WHERE id = $2', [orgUnitId, req.user.organizationId]);
    res.status(200).json({ message: 'Default unit updated' });
  } catch (err) {
    console.error('Update default unit error:', err);
    res.status(500).json({ error: 'Failed to update default unit' });
  }
});

// ============================================================================
// BILLING — plan status, checkout, cancellation. The Razorpay webhook that
// actually confirms a checkout lives further down, unauthenticated, near
// the other public webhooks in this file.
// ============================================================================

// Public plan catalog (no auth needed — the pricing page can show this to
// a signed-out visitor too, though today only the admin Billing tab reads it).
app.get('/api/billing/plans', (req, res) => {
  res.status(200).json({ plans: PLAN_CATALOG });
});

app.get('/api/admin/billing/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await ensureSubscriptionsSchema();
    const subRes = await pool.query('SELECT * FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
    const sub = subRes.rows[0] || { plan_key: 'free', status: 'free', billing_cycle: null, current_period_end: null };
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'student'`,
      [req.user.organizationId]
    );
    const effectivePlanKey = sub.status === 'active' ? sub.plan_key : 'free';
    res.status(200).json({
      planKey: sub.plan_key,
      effectivePlanKey,
      status: sub.status,
      billingCycle: sub.billing_cycle,
      currentPeriodEnd: sub.current_period_end,
      pendingPlanKey: sub.pending_plan_key,
      studentCap: PLAN_CATALOG[effectivePlanKey].studentCap,
      currentStudentCount: countRes.rows[0].n,
      razorpayConfigured: !!getRazorpayClient(),
    });
  } catch (err) {
    console.error('Billing status error:', err);
    res.status(500).json({ error: 'Failed to load billing status' });
  }
});

app.post('/api/admin/billing/checkout', authenticateToken, requireAdmin, async (req, res) => {
  const { planKey, billingCycle } = req.body;
  if (!PAID_PLAN_KEYS.includes(planKey) || !BILLING_CYCLES.includes(billingCycle)) {
    return res.status(400).json({ error: 'Invalid plan or billing cycle' });
  }
  const rzp = getRazorpayClient();
  if (!rzp) return res.status(503).json({ error: 'Billing is not yet configured' });

  try {
    const razorpayPlanId = await ensureRazorpayPlan(planKey, billingCycle);

    // total_count = how many billing cycles Razorpay auto-charges before
    // stopping on its own — Razorpay has no "forever" value, so this is
    // set high enough to mean "renews indefinitely until cancelled".
    const totalCount = billingCycle === 'monthly' ? 120 : 20;

    const subscription = await rzp.subscriptions.create({
      plan_id: razorpayPlanId,
      customer_notify: 1,
      total_count: totalCount,
      quantity: 1,
      notes: { organizationId: String(req.user.organizationId), planKey, billingCycle },
    });

    await ensureSubscriptionsSchema();
    await pool.query(
      `INSERT INTO subscriptions (organization_id, pending_plan_key, pending_billing_cycle, pending_razorpay_subscription_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id) DO UPDATE SET
         pending_plan_key = $2, pending_billing_cycle = $3, pending_razorpay_subscription_id = $4, updated_at = now()`,
      [req.user.organizationId, planKey, billingCycle, subscription.id]
    );

    res.status(200).json({
      subscriptionId: subscription.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      planLabel: PLAN_CATALOG[planKey].label,
      billingCycle,
    });
  } catch (err) {
    console.error('Billing checkout error:', err);
    res.status(500).json({ error: 'Failed to start checkout' });
  }
});

// Keeps the org's current paid cap through whatever billing period they've
// already paid for (cancel_at_cycle_end) — the fallback to Free happens
// automatically via the subscription.cancelled webhook once that period
// ends, same mechanism as any other status change (see getEffectivePlanKey).
app.post('/api/admin/billing/cancel', authenticateToken, requireAdmin, async (req, res) => {
  const rzp = getRazorpayClient();
  if (!rzp) return res.status(503).json({ error: 'Billing is not yet configured' });

  try {
    await ensureSubscriptionsSchema();
    const subRes = await pool.query('SELECT razorpay_subscription_id FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
    const razorpaySubscriptionId = subRes.rows[0]?.razorpay_subscription_id;
    if (!razorpaySubscriptionId) {
      return res.status(400).json({ error: 'No active subscription to cancel' });
    }
    await rzp.subscriptions.cancel(razorpaySubscriptionId, { cancel_at_cycle_end: 1 });
    res.status(200).json({ message: 'Your subscription will not renew after the current billing period.' });
  } catch (err) {
    console.error('Billing cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ============================================================================
// ORG STRUCTURE: the tier shape (org_level_defs) and the actual tree nodes
// built against it (org_units). A big college might define 7-8 tiers
// (Campus -> Department -> Year); a small tuition center just 2 — the tree
// depth is however many rows exist in org_level_defs for that org, nothing
// hardcoded. Structural edits (add/reorder/delete a tier) are locked the
// instant any org_units row exists anywhere in the org — inserting a tier
// into a half-populated tree has no sane semantics, and structure design
// happens once, before real students exist under it. Renaming a label
// stays allowed at any time since it's purely cosmetic.
// ============================================================================
app.get('/api/admin/org-levels', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, tier_index, label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC',
      [req.user.organizationId]
    );
    res.status(200).json({ levels: result.rows });
  } catch (err) {
    console.error('List org levels error:', err);
    res.status(500).json({ error: 'Failed to load organization structure' });
  }
});

app.post('/api/admin/org-levels', authenticateToken, requireAdmin, async (req, res) => {
  const label = String(req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Level label is required' });

  try {
    const unitsExist = await pool.query('SELECT 1 FROM org_units WHERE organization_id = $1 LIMIT 1', [req.user.organizationId]);
    if (unitsExist.rows.length > 0) {
      return res.status(409).json({ error: 'Cannot add a level once units exist — the structure is locked' });
    }

    const maxTier = await pool.query('SELECT COALESCE(MAX(tier_index), -1) AS max_tier FROM org_level_defs WHERE organization_id = $1', [req.user.organizationId]);
    const nextTier = Number(maxTier.rows[0].max_tier) + 1;

    const result = await pool.query(
      'INSERT INTO org_level_defs (organization_id, tier_index, label) VALUES ($1, $2, $3) RETURNING id, tier_index, label',
      [req.user.organizationId, nextTier, label]
    );
    res.status(201).json({ level: result.rows[0] });
  } catch (err) {
    console.error('Create org level error:', err);
    res.status(500).json({ error: 'Failed to add level' });
  }
});

app.put('/api/admin/org-levels/:id', authenticateToken, requireAdmin, async (req, res) => {
  const label = String(req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Level label is required' });

  try {
    const result = await pool.query(
      'UPDATE org_level_defs SET label = $1 WHERE id = $2 AND organization_id = $3 RETURNING id, tier_index, label',
      [label, req.params.id, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Level not found' });
    res.status(200).json({ level: result.rows[0] });
  } catch (err) {
    console.error('Rename org level error:', err);
    res.status(500).json({ error: 'Failed to rename level' });
  }
});

app.delete('/api/admin/org-levels/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const level = await pool.query('SELECT tier_index FROM org_level_defs WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (level.rows.length === 0) return res.status(404).json({ error: 'Level not found' });

    const unitsExist = await pool.query('SELECT 1 FROM org_units WHERE organization_id = $1 LIMIT 1', [req.user.organizationId]);
    if (unitsExist.rows.length > 0) {
      return res.status(409).json({ error: 'Cannot remove a level once units exist — the structure is locked' });
    }

    const maxTier = await pool.query('SELECT MAX(tier_index) AS max_tier FROM org_level_defs WHERE organization_id = $1', [req.user.organizationId]);
    if (Number(level.rows[0].tier_index) !== Number(maxTier.rows[0].max_tier)) {
      return res.status(400).json({ error: 'Only the deepest level can be removed' });
    }

    await pool.query('DELETE FROM org_level_defs WHERE id = $1', [req.params.id]);
    res.status(200).json({ message: 'Level removed' });
  } catch (err) {
    console.error('Delete org level error:', err);
    res.status(500).json({ error: 'Failed to remove level' });
  }
});

// Flat fetch — {levels, units} — the client builds the parent/child tree
// itself via a simple adjacency map. Realistic scale here is hundreds of
// nodes across at most ~8 tiers, never large enough to need pagination or
// a lazy per-node fetch.
app.get('/api/admin/org-units', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [levels, units] = await Promise.all([
      pool.query('SELECT id, tier_index, label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC', [req.user.organizationId]),
      pool.query('SELECT id, level_def_id, parent_unit_id, name FROM org_units WHERE organization_id = $1 ORDER BY id ASC', [req.user.organizationId]),
    ]);
    res.status(200).json({ levels: levels.rows, units: units.rows });
  } catch (err) {
    console.error('List org units error:', err);
    res.status(500).json({ error: 'Failed to load organization structure' });
  }
});

app.post('/api/admin/org-units', authenticateToken, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const levelDefId = Number(req.body.levelDefId);
  const parentUnitId = req.body.parentUnitId != null ? Number(req.body.parentUnitId) : null;
  if (!name) return res.status(400).json({ error: 'Unit name is required' });
  if (!Number.isFinite(levelDefId)) return res.status(400).json({ error: 'levelDefId is required' });

  try {
    const level = await pool.query('SELECT tier_index FROM org_level_defs WHERE id = $1 AND organization_id = $2', [levelDefId, req.user.organizationId]);
    if (level.rows.length === 0) return res.status(404).json({ error: 'Level not found' });
    const tierIndex = level.rows[0].tier_index;

    if (tierIndex === 0) {
      if (parentUnitId !== null) return res.status(400).json({ error: 'A root-tier unit cannot have a parent' });
    } else {
      if (parentUnitId === null) return res.status(400).json({ error: 'A parent unit is required for this level' });
      const parent = await pool.query(
        `SELECT u.id FROM org_units u JOIN org_level_defs l ON l.id = u.level_def_id
         WHERE u.id = $1 AND u.organization_id = $2 AND l.tier_index = $3`,
        [parentUnitId, req.user.organizationId, tierIndex - 1]
      );
      if (parent.rows.length === 0) return res.status(400).json({ error: 'Parent unit must belong to the tier directly above this one' });
    }

    const result = await pool.query(
      'INSERT INTO org_units (organization_id, level_def_id, parent_unit_id, name) VALUES ($1, $2, $3, $4) RETURNING id, level_def_id, parent_unit_id, name',
      [req.user.organizationId, levelDefId, parentUnitId, name]
    );
    res.status(201).json({ unit: result.rows[0] });
  } catch (err) {
    console.error('Create org unit error:', err);
    res.status(500).json({ error: 'Failed to add unit' });
  }
});

app.put('/api/admin/org-units/:id', authenticateToken, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Unit name is required' });

  try {
    const result = await pool.query(
      'UPDATE org_units SET name = $1 WHERE id = $2 AND organization_id = $3 RETURNING id, level_def_id, parent_unit_id, name',
      [name, req.params.id, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    res.status(200).json({ unit: result.rows[0] });
  } catch (err) {
    console.error('Rename org unit error:', err);
    res.status(500).json({ error: 'Failed to rename unit' });
  }
});

app.delete('/api/admin/org-units/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const unit = await pool.query('SELECT id FROM org_units WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (unit.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });

    const children = await pool.query('SELECT 1 FROM org_units WHERE parent_unit_id = $1 LIMIT 1', [req.params.id]);
    if (children.rows.length > 0) {
      return res.status(409).json({ error: 'Cannot remove a unit that still has child units' });
    }
    const members = await pool.query('SELECT 1 FROM memberships WHERE org_unit_id = $1 LIMIT 1', [req.params.id]);
    if (members.rows.length > 0) {
      return res.status(409).json({ error: 'Cannot remove a unit that still has people assigned to it' });
    }
    const subjects = await pool.query('SELECT 1 FROM subjects WHERE org_unit_id = $1 LIMIT 1', [req.params.id]);
    if (subjects.rows.length > 0) {
      return res.status(409).json({ error: 'Cannot remove a unit that still has subjects attached to it' });
    }

    await pool.query('DELETE FROM org_units WHERE id = $1', [req.params.id]);
    res.status(200).json({ message: 'Unit removed' });
  } catch (err) {
    console.error('Delete org unit error:', err);
    res.status(500).json({ error: 'Failed to remove unit' });
  }
});

// ============================================================================
// SUBJECTS: attached to whatever org_unit tier an admin picks (not fixed to
// one depth) — see getVisibleSubjectIds() further down for how a subject on
// a Department-tier unit reaches every Year beneath it. Creating/renaming/
// deleting a subject and assigning its teachers is admin-only; a teacher's
// authority is to USE a subject they're assigned to (create/edit problems
// and exams under it), enforced by enforceSubjectAuthority() above.
// ============================================================================
// Admins see every subject in the org; teachers only see the subjects
// they're actually linked to via subject_teachers — this powers the
// subject-picker on the assignment/exam forms, which is the one place a
// teacher legitimately needs read access to (a subset of) this list.
app.get('/api/admin/subjects', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.org_unit_id, s.name, u.name AS org_unit_name,
              COALESCE(json_agg(json_build_object('id', t.id, 'email', t.email)) FILTER (WHERE t.id IS NOT NULL), '[]') AS teachers
       FROM subjects s
       JOIN org_units u ON u.id = s.org_unit_id
       LEFT JOIN subject_teachers st ON st.subject_id = s.id
       LEFT JOIN users t ON t.id = st.user_id
       WHERE s.organization_id = $1
         AND ($2::text != 'teacher' OR EXISTS (SELECT 1 FROM subject_teachers mine WHERE mine.subject_id = s.id AND mine.user_id = $3))
       GROUP BY s.id, s.org_unit_id, s.name, u.name
       ORDER BY s.name ASC`,
      [req.user.organizationId, req.user.role, req.user.userId]
    );
    res.status(200).json({ subjects: result.rows });
  } catch (err) {
    console.error('List subjects error:', err);
    res.status(500).json({ error: 'Failed to load subjects' });
  }
});

app.post('/api/admin/subjects', authenticateToken, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const orgUnitId = Number(req.body.orgUnitId);
  if (!name) return res.status(400).json({ error: 'Subject name is required' });
  if (!Number.isFinite(orgUnitId)) return res.status(400).json({ error: 'orgUnitId is required' });

  try {
    const unit = await pool.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
    if (unit.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });

    const result = await pool.query(
      'INSERT INTO subjects (organization_id, org_unit_id, name) VALUES ($1, $2, $3) RETURNING id, org_unit_id, name',
      [req.user.organizationId, orgUnitId, name]
    );
    res.status(201).json({ subject: result.rows[0] });
  } catch (err) {
    console.error('Create subject error:', err);
    res.status(500).json({ error: 'Failed to create subject' });
  }
});

app.put('/api/admin/subjects/:id', authenticateToken, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Subject name is required' });

  try {
    const result = await pool.query(
      'UPDATE subjects SET name = $1 WHERE id = $2 AND organization_id = $3 RETURNING id, org_unit_id, name',
      [name, req.params.id, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });
    res.status(200).json({ subject: result.rows[0] });
  } catch (err) {
    console.error('Rename subject error:', err);
    res.status(500).json({ error: 'Failed to rename subject' });
  }
});

app.delete('/api/admin/subjects/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const subject = await pool.query('SELECT id FROM subjects WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (subject.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    const problems = await pool.query('SELECT 1 FROM problems WHERE subject_id = $1 LIMIT 1', [req.params.id]);
    if (problems.rows.length > 0) return res.status(409).json({ error: 'Cannot remove a subject that still has assignments attached to it' });
    const exams = await pool.query('SELECT 1 FROM exams WHERE subject_id = $1 LIMIT 1', [req.params.id]);
    if (exams.rows.length > 0) return res.status(409).json({ error: 'Cannot remove a subject that still has exams attached to it' });

    await pool.query('DELETE FROM subjects WHERE id = $1', [req.params.id]);
    res.status(200).json({ message: 'Subject removed' });
  } catch (err) {
    console.error('Delete subject error:', err);
    res.status(500).json({ error: 'Failed to remove subject' });
  }
});

app.post('/api/admin/subjects/:id/teachers', authenticateToken, requireAdmin, async (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!email) return res.status(400).json({ error: 'Teacher email is required' });

  try {
    const subject = await pool.query('SELECT id FROM subjects WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (subject.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    const teacher = await pool.query(
      `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE u.email = $1 AND m.organization_id = $2 AND m.role = 'teacher'`,
      [email, req.user.organizationId]
    );
    if (teacher.rows.length === 0) return res.status(404).json({ error: 'No teacher with that email in your organization — create their account first' });

    await pool.query(
      'INSERT INTO subject_teachers (subject_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, teacher.rows[0].id]
    );
    res.status(201).json({ message: 'Teacher assigned to subject' });
  } catch (err) {
    console.error('Assign subject teacher error:', err);
    res.status(500).json({ error: 'Failed to assign teacher' });
  }
});

app.delete('/api/admin/subjects/:id/teachers/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const subject = await pool.query('SELECT id FROM subjects WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (subject.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    await pool.query('DELETE FROM subject_teachers WHERE subject_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    res.status(200).json({ message: 'Teacher removed from subject' });
  } catch (err) {
    console.error('Remove subject teacher error:', err);
    res.status(500).json({ error: 'Failed to remove teacher' });
  }
});

// ============================================================================
// 1b. ADMIN: List every student with a grade/performance summary
// ============================================================================
app.get('/api/admin/students', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Optional ?problemId=<n> scopes every metric below to a single
    // assignment instead of aggregating across all of them — lets the admin
    // panel sort "who's doing well on Assignment 3" instead of only overall.
    // $1::int IS NULL is a deliberate pass-through: when problemId isn't
    // given, every join condition below is a no-op and the query returns
    // the exact same combined totals it always has.
    const problemId = req.query.problemId && !Number.isNaN(Number(req.query.problemId))
      ? Number(req.query.problemId)
      : null;

    const result = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.created_at,
        m.org_unit_id,
        COUNT(DISTINCT s.problem_id) FILTER (WHERE s.status = 'Accepted')::int AS problems_solved,
        COUNT(s.id)::int AS total_submissions,
        MAX(s.created_at) AS last_submission_at,
        COALESCE(t.total_seconds, 0)::int AS total_seconds,
        GREATEST(MAX(s.created_at), t.last_time_log_at) AS last_active_at,
        COALESCE(best.successful_test_cases, 0)::int AS successful_test_cases
      FROM users u
      JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2 AND m.role = 'student'
      LEFT JOIN submissions s
        ON s.user_id = u.id AND ($1::int IS NULL OR s.problem_id = $1)
      -- Time-on-task, summed across every problem the student has opened
      -- (or just the one problem, when scoped).
      LEFT JOIN (
        SELECT user_id,
               SUM(total_seconds)::int AS total_seconds,
               MAX(updated_at) AS last_time_log_at
        FROM problem_time_logs
        WHERE $1::int IS NULL OR problem_id = $1
        GROUP BY user_id
      ) t ON t.user_id = u.id
      -- "Successful test cases run" = test cases passed on each problem's BEST
      -- attempt (highest passed_count, Accepted breaking ties), summed across
      -- problems — same "best, not latest" rule used on the student-facing
      -- assignments list, so a weaker retry afterward can't lower this.
      LEFT JOIN (
        SELECT user_id, SUM(passed_count)::int AS successful_test_cases
        FROM (
          SELECT DISTINCT ON (user_id, problem_id) user_id, problem_id, passed_count
          FROM submissions
          WHERE $1::int IS NULL OR problem_id = $1
          ORDER BY user_id, problem_id, (status = 'Accepted') DESC, passed_count DESC, created_at DESC
        ) best_per_problem
        GROUP BY user_id
      ) best ON best.user_id = u.id
      GROUP BY u.id, u.email, u.created_at, m.org_unit_id, t.total_seconds, t.last_time_log_at, best.successful_test_cases
      ORDER BY u.email ASC
    `, [problemId, req.user.organizationId]);

    // One lookup for the whole org, then an in-memory walk per student —
    // avoids one recursive SQL query per row on a roster of any real size.
    const unitLookup = await getOrgUnitLookup(req.user.organizationId);

    // Composite "time:attempts:success" efficiency score — higher is better
    // (more test cases passed, in fewer attempts, in less time). Ratio-based
    // rather than a fixed weighted sum so it stays meaningful across classes
    // of very different sizes/durations; tune the two `1 + ...` denominators
    // below if you want attempts or time to matter more/less relative to
    // successful test cases.
    const students = result.rows.map((s) => {
      const hours = s.total_seconds / 3600;
      const compositeScore = s.successful_test_cases / ((1 + s.total_submissions) * (1 + hours));
      const unitPath = resolveOrgUnitPath(unitLookup, s.org_unit_id);
      return { ...s, composite_score: Number(compositeScore.toFixed(4)), unit_path: unitPath };
    });

    res.status(200).json({ students });
  } catch (error) {
    console.error('List students error:', error);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

// ============================================================================
// 1c. ADMIN: Per-student breakdown â€” every problem attempted and its result
// ============================================================================
app.get('/api/admin/students/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const studentRes = await pool.query(
      `SELECT u.id, u.email, u.created_at, m.org_unit_id FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2 AND m.role = 'student'
       WHERE u.id = $1`,
      [req.params.id, req.user.organizationId]
    );
    if (studentRes.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const unitPath = resolveOrgUnitPath(await getOrgUnitLookup(req.user.organizationId), studentRes.rows[0].org_unit_id);

    const perProblemRes = await pool.query(
      `SELECT
         p.id AS problem_id,
         p.title,
         p.difficulty,
         bool_or(s.status = 'Accepted') AS solved,
         COUNT(s.id)::int AS attempts,
         MAX(s.created_at) AS last_attempt_at
       FROM submissions s
       JOIN problems p ON p.id = s.problem_id
       WHERE s.user_id = $1 AND p.organization_id = $2
       GROUP BY p.id, p.title, p.difficulty
       ORDER BY MAX(s.created_at) DESC`,
      [req.params.id, req.user.organizationId]
    );

    // Overall (exams) percentile: each student's average percentage across
    // their own fully-graded submitted exam attempts, only counting exams
    // whose own deadline has passed (matches the student-facing route's
    // rule — a still-open exam elsewhere shouldn't skew "overall" early),
    // ranked against every other student who also has at least one such attempt.
    const overallExamsRes = await pool.query(
      `SELECT a.user_id, AVG(a.score::float / e.total_marks * 100) AS avg_percentage
       FROM exam_attempts a
       JOIN exams e ON e.id = a.exam_id
       WHERE a.status = 'submitted' AND e.total_marks > 0 AND e.organization_id = $1
         AND (e.closes_at IS NULL OR e.closes_at <= now())
         AND NOT EXISTS (
           SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
           WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
         )
       GROUP BY a.user_id`,
      [req.user.organizationId]
    );
    const overallExamsFor = computePercentileTiers(overallExamsRes.rows.map((r) => Number(r.avg_percentage)));
    const studentOverallExams = overallExamsRes.rows.find((r) => r.user_id === req.params.id);
    const overallExamsPercentileTag = studentOverallExams ? overallExamsFor(Number(studentOverallExams.avg_percentage)).tag : null;

    // Overall (assignments): same idea, best-submission % averaged across
    // every problem the student's submitted to, only counting problems
    // whose deadline has passed.
    const overallAssignmentsRes = await pool.query(
      `SELECT best.user_id, AVG(best.passed_count::float / best.total_count * 100) AS avg_percentage
       FROM (
         SELECT DISTINCT ON (s.user_id, s.problem_id) s.user_id, s.problem_id, s.passed_count, s.total_count
         FROM submissions s
         JOIN problems p ON p.id = s.problem_id
         WHERE p.organization_id = $1 AND (p.closes_at IS NULL OR p.closes_at <= now())
         ORDER BY s.user_id, s.problem_id, (s.status = 'Accepted') DESC, s.passed_count DESC, s.created_at DESC
       ) best
       WHERE best.total_count > 0
       GROUP BY best.user_id`,
      [req.user.organizationId]
    );
    const overallAssignmentsFor = computePercentileTiers(overallAssignmentsRes.rows.map((r) => Number(r.avg_percentage)));
    const studentOverallAssignments = overallAssignmentsRes.rows.find((r) => r.user_id === req.params.id);
    const overallAssignmentsPercentileTag = studentOverallAssignments
      ? overallAssignmentsFor(Number(studentOverallAssignments.avg_percentage)).tag
      : null;

    res.status(200).json({
      student: studentRes.rows[0],
      unitPath,
      problems: perProblemRes.rows,
      overallExamsPercentileTag,
      overallAssignmentsPercentileTag,
    });
  } catch (error) {
    console.error('Student detail error:', error);
    res.status(500).json({ error: 'Failed to load student detail' });
  }
});

// ============================================================================
// 1c-2. ADMIN: Full submission history (including code) for one student on
// one problem â€” lets an admin see exactly what a student tried, in what
// order, and how their code changed between attempts.
// ============================================================================
app.get('/api/admin/students/:studentId/problems/:problemId/submissions', authenticateToken, requireAdmin, async (req, res) => {
  const { studentId, problemId } = req.params;
  try {
    // The join back to memberships/problems (rather than trusting the raw
    // ids) is what stops one org's admin from reading another org's
    // submission history by guessing/enumerating ids in the URL.
    const result = await pool.query(
      `SELECT s.id, s.language, s.code, s.status, s.passed_count, s.total_count, s.created_at
       FROM submissions s
       JOIN memberships m ON m.user_id = s.user_id AND m.organization_id = $3
       JOIN problems p ON p.id = s.problem_id
       WHERE s.user_id = $1 AND s.problem_id = $2 AND p.organization_id = $3
       ORDER BY s.created_at DESC`,
      [studentId, problemId, req.user.organizationId]
    );
    res.status(200).json({ submissions: result.rows });
  } catch (error) {
    console.error('Submission history error:', error);
    res.status(500).json({ error: 'Failed to load submission history' });
  }
});

// ============================================================================
// 1d. ADMIN: Remove a student from the platform
// ============================================================================
// Scoped to role = 'student' in the WHERE clause on purpose â€” even if an admin's
// id is passed in here (typo, stale UI, whatever), this 404s instead of touching
// another admin account. There's no route that lets one admin delete another.
app.delete('/api/admin/students/:id', authenticateToken, requireAdmin, async (req, res) => {
  const studentId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const target = await client.query(
      `SELECT u.id, u.email FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2 AND m.role = 'student'
       WHERE u.id = $1`,
      [studentId, req.user.organizationId]
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Student not found' });
    }

    // Scoped to THIS org's own data only — a global identity can belong to
    // more than one organization now (e.g. a student who's also enrolled
    // elsewhere), so an unscoped delete here would wipe their submissions,
    // or even their whole account, in an org they aren't even being
    // removed from.
    await client.query(
      'DELETE FROM submissions WHERE user_id = $1 AND problem_id IN (SELECT id FROM problems WHERE organization_id = $2)',
      [studentId, req.user.organizationId]
    );
    await client.query('DELETE FROM memberships WHERE user_id = $1 AND organization_id = $2', [studentId, req.user.organizationId]);
    // Only drops the global identity itself once it has no memberships left
    // anywhere — otherwise this leaves a harmless, inert users row behind.
    await client.query(
      'DELETE FROM users WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1)',
      [studentId]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: `${target.rows[0].email} was removed from the platform` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete student error:', error);
    res.status(500).json({ error: 'Failed to remove student' });
  } finally {
    client.release();
  }
});

// ============================================================================
// 2. WEBHOOK ENDPOINT: Automated Onboarding from Google Forms
// (left unauthenticated â€” Google Forms/Zapier can't carry a session cookie)
// ============================================================================
// Public/unauthenticated by necessity — Google Forms can't send a Bearer
// token — so the org has to be identified some other way. :webhookSecret is
// a random per-org token (not the guessable sequential organizations.id)
// shown to each admin in their dashboard, so each school points their own
// Google Form's webhook at their own URL.
app.post('/api/webhook/google-form/:webhookSecret', async (req, res) => {
  // Every field the form POSTs that isn't Name/Email is a tier, left to
  // right in whatever order the form sends them — same contract as CSV
  // import, so an admin building a Google Form question-by-question
  // (Campus -> Department -> Year -> Name -> Email) gets the exact same
  // auto-built structure a CSV upload would.
  const { emailKey, nameKey, tierKeys } = splitTierAndIdentityColumns(Object.keys(req.body || {}));
  const email = emailKey ? String(req.body[emailKey] || '').trim() : '';
  const name = nameKey ? String(req.body[nameKey] || '').trim() : '';

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  const client = await pool.connect();
  try {
    const orgRes = await client.query('SELECT id, status, default_org_unit_id FROM organizations WHERE webhook_secret = $1', [req.params.webhookSecret]);
    if (orgRes.rows.length === 0) {
      return res.status(404).json({ error: 'Unknown webhook' });
    }
    const organizationId = orgRes.rows[0].id;
    if (orgRes.rows[0].status !== 'approved') {
      // Never 500 here — Google Forms/Zapier can't surface a failure to
      // anyone, so a still-pending org just gets a clean, silent no-op.
      return res.status(200).send('Organization pending approval, no account created');
    }

    const cap = await checkStudentCap(organizationId, 1);
    if (!cap.ok) {
      return res.status(200).send(`Skipped: ${cap.planLabel} plan is full (${cap.cap} students)`);
    }

    // A bare {name,email}-only form (no other questions) falls back to
    // whatever default_org_unit_id the admin configured. A form WITH other
    // questions auto-builds/extends the org's structure from them, exactly
    // like CSV import — no separate "build your structure first" step.
    let orgUnitId = orgRes.rows[0].default_org_unit_id;
    if (tierKeys.length > 0) {
      const levelsResult = await ensureLevelsForTierLabels(organizationId, tierKeys);
      if (levelsResult.error) {
        return res.status(200).send(`Skipped: ${levelsResult.reason}`);
      }
      const resolution = await resolveOrCreateOrgUnit(organizationId, levelsResult.levels, tierKeys.map((k) => req.body[k]));
      if (resolution.error) {
        return res.status(200).send(`Skipped: ${resolution.reason}`);
      }
      orgUnitId = resolution.orgUnitId;
    }

    await client.query('BEGIN');
    const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email);

    // ON CONFLICT DO NOTHING means a repeat form submission for someone
    // who's already a member of this org is silently skipped — but a
    // brand-new temporaryPassword above was only ever generated for a
    // brand-new identity, so we must only email it out when BOTH the
    // identity and the membership were newly created this call, or the
    // student gets a password that doesn't match what's actually stored.
    const memberRes = await client.query(
      `INSERT INTO memberships (user_id, organization_id, role, org_unit_id) VALUES ($1, $2, 'student', $3)
       ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
      [userId, organizationId, orgUnitId]
    );
    await client.query('COMMIT');

    if (memberRes.rows.length === 0) {
      console.log(`Skipped onboarding email for ${email} - already a member of this organization`);
      return res.status(200).send('Already a member, no email sent');
    }
    if (!isNew) {
      console.log(`Added existing account ${email} to organization ${organizationId} - no email sent`);
      return res.status(200).send('Existing account added, no email sent');
    }

    // Best-effort, not fatal — the account/membership are already
    // committed above; Google Forms can't surface a failure to anyone, so
    // an email hiccup here shouldn't turn an otherwise-successful signup
    // into a 500 (matches the same best-effort treatment CSV import gives
    // its own credentials emails).
    const { error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'Your AssignMeant Account Credentials',
      text: `Hello ${name || 'Student'},\n\nYour AssignMeant account is ready!\n\nYour temporary password is: ${temporaryPassword}\n\nLogin via ${FRONTEND_URL}\n\nPlease log in and change your password after logging in.`,
    });
    if (emailError) console.error('Onboarding email failed to send:', emailError);

    console.log(`Automated Onboarding Complete for: ${email}`);
    res.status(200).send('Success');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Webhook error:', error);
    res.status(500).send('Error processing webhook');
  } finally {
    client.release();
  }
});

// ============================================================================
// RAZORPAY WEBHOOK — the source of truth for plan changes. A client-side
// checkout "success" callback (see the frontend Billing panel) NEVER writes
// plan state directly; only a signature-verified event from here does.
// Configure this URL (https://<your-backend>/api/webhook/razorpay) in
// Razorpay's dashboard under Settings -> Webhooks, and set
// RAZORPAY_WEBHOOK_SECRET to the secret shown there (a different value
// from RAZORPAY_KEY_SECRET — this one exists purely to sign webhook
// payloads, not to authenticate API calls).
// ============================================================================
app.post('/api/webhook/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !req.rawBody) {
    return res.status(400).json({ error: 'Missing signature' });
  }

  let valid = false;
  try {
    valid = Razorpay.validateWebhookSignature(req.rawBody.toString(), signature, secret);
  } catch (err) {
    valid = false;
  }
  if (!valid) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  const sub = event?.payload?.subscription?.entity;
  if (!sub) {
    // Not a subscription event (Razorpay sends other event types too) —
    // nothing for this app to do with it.
    return res.status(200).end();
  }

  try {
    await ensureSubscriptionsSchema();
    await applyRazorpaySubscriptionEvent(event.event, sub);
  } catch (err) {
    // Still 200 — Razorpay retries on non-2xx, and every write this makes
    // is an absolute SET (not an increment), so a redelivered event is a
    // safe no-op; logging is enough to catch a real, persistent bug.
    console.error('Razorpay webhook processing error:', err);
  }
  res.status(200).end();
});

// One absolute SET per event, never an increment — redelivery-safe by
// construction (Razorpay does redeliver on a non-2xx response, and even on
// a 200 can occasionally send the same event twice). COALESCE lets the
// 'activated' case promote pending_* into the real columns exactly once;
// a second delivery finds pending_* already NULL and no-ops on those
// specific fields while the rest of the SET still safely reapplies.
async function applyRazorpaySubscriptionEvent(eventType, sub) {
  const razorpaySubscriptionId = sub.id;
  const currentPeriodEnd = sub.current_end ? new Date(sub.current_end * 1000) : null;

  switch (eventType) {
    case 'subscription.authenticated':
      await pool.query(
        `UPDATE subscriptions SET status = 'authenticated', updated_at = now()
         WHERE razorpay_subscription_id = $1 OR pending_razorpay_subscription_id = $1`,
        [razorpaySubscriptionId]
      );
      break;

    case 'subscription.activated': {
      const result = await pool.query(
        `UPDATE subscriptions SET
           plan_key = COALESCE(pending_plan_key, plan_key),
           billing_cycle = COALESCE(pending_billing_cycle, billing_cycle),
           razorpay_subscription_id = COALESCE(pending_razorpay_subscription_id, razorpay_subscription_id),
           razorpay_plan_id = $2,
           status = 'active',
           current_period_end = $3,
           pending_plan_key = NULL, pending_billing_cycle = NULL, pending_razorpay_subscription_id = NULL,
           updated_at = now()
         WHERE pending_razorpay_subscription_id = $1 OR razorpay_subscription_id = $1
         RETURNING organization_id, plan_key`,
        [razorpaySubscriptionId, sub.plan_id, currentPeriodEnd]
      );
      const org = result.rows[0];
      if (org) await sendBillingEmail(org.organization_id, 'Your subscription is now active', `Your ${PLAN_CATALOG[org.plan_key]?.label || org.plan_key} plan is now active. Thank you!`);
      break;
    }

    case 'subscription.charged':
      await pool.query(
        `UPDATE subscriptions SET status = 'active', current_period_end = $2, updated_at = now()
         WHERE razorpay_subscription_id = $1`,
        [razorpaySubscriptionId, currentPeriodEnd]
      );
      break;

    case 'subscription.pending': {
      const result = await pool.query(
        `UPDATE subscriptions SET status = 'pending', updated_at = now()
         WHERE razorpay_subscription_id = $1 RETURNING organization_id`,
        [razorpaySubscriptionId]
      );
      const org = result.rows[0];
      if (org) await sendBillingEmail(org.organization_id, 'Payment failed — action needed', 'Your last subscription payment failed. Please update your payment method to avoid losing access to your plan.');
      break;
    }

    case 'subscription.halted':
      await pool.query(`UPDATE subscriptions SET status = 'halted', updated_at = now() WHERE razorpay_subscription_id = $1`, [razorpaySubscriptionId]);
      break;

    case 'subscription.completed':
      await pool.query(`UPDATE subscriptions SET status = 'completed', updated_at = now() WHERE razorpay_subscription_id = $1`, [razorpaySubscriptionId]);
      break;

    case 'subscription.cancelled': {
      const result = await pool.query(
        `UPDATE subscriptions SET status = 'cancelled', updated_at = now()
         WHERE razorpay_subscription_id = $1 RETURNING organization_id`,
        [razorpaySubscriptionId]
      );
      const org = result.rows[0];
      if (org) await sendBillingEmail(org.organization_id, 'Subscription cancelled', 'Your subscription has been cancelled and will not renew. You can resubscribe any time from your Billing tab.');
      break;
    }

    case 'subscription.paused':
      await pool.query(`UPDATE subscriptions SET status = 'halted', updated_at = now() WHERE razorpay_subscription_id = $1`, [razorpaySubscriptionId]);
      break;

    case 'subscription.resumed':
      await pool.query(`UPDATE subscriptions SET status = 'active', updated_at = now() WHERE razorpay_subscription_id = $1`, [razorpaySubscriptionId]);
      break;

    default:
      // subscription.updated and anything else not explicitly handled —
      // no local state change; not every Razorpay event needs one.
      break;
  }
}

// Best-effort billing notification — reuses the same Resend pattern as
// every other transactional email in this file. Looks up the org's admin
// by membership role rather than requiring callers to already have an
// email address on hand.
async function sendBillingEmail(organizationId, subject, text) {
  try {
    const adminRes = await pool.query(
      `SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE m.organization_id = $1 AND m.role = 'admin' LIMIT 1`,
      [organizationId]
    );
    const to = adminRes.rows[0]?.email;
    if (!to) return;
    const { error } = await resend.emails.send({ from: EMAIL_FROM, to, subject: `AssignMeant — ${subject}`, text });
    if (error) console.error('Billing email failed to send:', error);
  } catch (err) {
    console.error('Billing email error:', err);
  }
}

// ============================================================================
// 2b. ORGANIZATION SIGNUP — a college/school registers itself and becomes
// its own admin, who then creates/invites their own teachers and students
// (existing POST /api/admin/create-student, now org-scoped). Self-serve,
// unauthenticated by necessity — this IS how an org's first account gets made.
// ============================================================================
app.post('/api/organizations/signup', async (req, res) => {
  const { organizationName, email, password } = req.body;
  if (!organizationName || !String(organizationName).trim()) {
    return res.status(400).json({ error: 'Organization name is required' });
  }
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const emailDomain = String(email).split('@')[1]?.toLowerCase() || '';
  if (DENYLISTED_EMAIL_DOMAINS.has(emailDomain)) {
    return res.status(400).json({ error: 'Please sign up with your institutional email address, not a personal webmail account' });
  }

  const client = await pool.connect();
  try {
    // A global identity may already exist for this email (e.g. they're a
    // student somewhere else already) — that's fine, they can still found
    // their own organization with it, as long as they prove they own that
    // password. Only a genuinely wrong password blocks signup.
    const existing = await client.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      const isMatch = await bcrypt.compare(password, existing.rows[0].password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'An account with this email already exists with a different password' });
      }
    }

    await client.query('BEGIN');

    // Two independent gates before this org can provision students: they
    // must click the confirmation link sent to their institutional address
    // (email_verified_at), AND a platform owner must separately approve the
    // organization (status) — see requirePlatformSecret's routes below.
    // Raw token goes out in the email; only its hash is ever stored, same
    // pattern as the password-reset flow further down this file.
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationTokenHash = crypto.createHash('sha256').update(verificationToken).digest('hex');

    const webhookSecret = crypto.randomBytes(16).toString('hex');
    const orgRes = await client.query(
      `INSERT INTO organizations (name, webhook_secret, status, email_domain, verification_token_hash, verification_token_expiry)
       VALUES ($1, $2, 'pending', $3, $4, now() + interval '24 hours') RETURNING id, name`,
      [organizationName.trim(), webhookSecret, emailDomain, verificationTokenHash]
    );
    const org = orgRes.rows[0];

    // Reuses the matched existing identity's password untouched if one
    // exists; only hashes+stores the supplied password for a brand-new one.
    const userId = existing.rows.length > 0
      ? existing.rows[0].id
      : (await client.query(
          'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
          [email, await bcrypt.hash(password, 10)]
        )).rows[0].id;

    await client.query(
      `INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'admin')`,
      [userId, org.id]
    );

    // Same defaults every fresh install seeded before this was per-org.
    await client.query(
      `INSERT INTO grade_bands (label, min_percent, organization_id) VALUES
        ('Excellent', 90, $1), ('Very good', 80, $1), ('Good', 70, $1),
        ('Satisfactory', 60, $1), ('Pass', 40, $1), ('Unsatisfactory', 0, $1)`,
      [org.id]
    );
    await client.query('INSERT INTO tag_visibility_settings (organization_id) VALUES ($1)', [org.id]);
    // Every org starts on Free — no payment step required to sign up at all.
    await client.query('INSERT INTO subscriptions (organization_id) VALUES ($1)', [org.id]);

    await client.query('COMMIT');

    // Admin can log in immediately and start building their org structure
    // while verification/approval is pending — see the status check inside
    // create-student/the webhook for what's actually gated on 'approved'.
    const verifyLink = `${FRONTEND_URL}/#/verify-organization?token=${verificationToken}`;
    const { error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'Confirm your AssignMeant organization',
      text: `Hello,\n\nPlease confirm you own this email address to continue setting up "${org.name}" on AssignMeant:\n\n${verifyLink}\n\nThis link expires in 24 hours. You can already sign in and start building your organization's structure — but you'll need to confirm this email, and have your organization approved, before you can add students.`,
    });
    if (emailError) console.error('Verification email failed to send:', emailError);

    const token = jwt.sign(
      { userId, role: 'admin', organizationId: org.id, orgUnitId: null },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRATION || '24h' }
    );

    res.status(201).json({
      message: 'Organization created — check your email to confirm it, and an administrator will review it before you can add students.',
      token,
      user: { id: userId, email, role: 'admin', organization_name: org.name },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Organization signup error:', err);
    res.status(500).json({ error: 'Failed to create organization' });
  } finally {
    client.release();
  }
});

// Public confirmation-link target from the signup email above. Advances
// only email_verified_at — never status, which stays gated behind the
// separate platform-owner approval routes further down.
app.get('/api/organizations/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const result = await pool.query(
      `UPDATE organizations SET email_verified_at = now(), verification_token_hash = NULL, verification_token_expiry = NULL
       WHERE verification_token_hash = $1 AND verification_token_expiry > now()
       RETURNING id, name`,
      [tokenHash]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification link' });
    }
    res.status(200).json({ message: `${result.rows[0].name}'s email is confirmed. An administrator will review your organization before you can add students.` });
  } catch (err) {
    console.error('Organization verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// PLATFORM OWNER: review queue for new organization signups. Not tied to any
// JWT/membership — a platform owner plausibly isn't a member of any tenant
// org — see requirePlatformSecret above. curl/Postman is a legitimate v1
// interface here; this is a single-operator surface, not something that
// needs a full frontend yet.
// ============================================================================
app.get('/api/platform/organizations', requirePlatformSecret, async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const result = await pool.query(
      `SELECT o.id, o.name, o.email_domain, o.status, o.email_verified_at, o.created_at,
              (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = o.id AND m.role = 'admin' LIMIT 1) AS admin_email
       FROM organizations o WHERE o.status = $1 ORDER BY o.created_at ASC`,
      [status]
    );
    res.status(200).json({ organizations: result.rows });
  } catch (err) {
    console.error('Platform list organizations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/platform/organizations/:id/approve', requirePlatformSecret, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE organizations SET status = 'approved', approved_at = now(), approved_by = 'platform-owner' WHERE id = $1 RETURNING id, name`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    res.status(200).json({ message: `${result.rows[0].name} approved` });
  } catch (err) {
    console.error('Platform approve organization error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/platform/organizations/:id/reject', requirePlatformSecret, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE organizations SET status = 'rejected', approved_at = now(), approved_by = 'platform-owner' WHERE id = $1 RETURNING id, name`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    res.status(200).json({ message: `${result.rows[0].name} rejected` });
  } catch (err) {
    console.error('Platform reject organization error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mints the real, fully-privileged session token for one specific
// membership row — shared by the single-membership fast path in
// POST /api/login and by POST /api/login/select-organization, so the two
// routes can never drift on what a "real" session token looks like.
function mintSessionToken(membership) {
  return jwt.sign(
    {
      userId: membership.user_id,
      role: membership.role,
      organizationId: membership.organization_id,
      orgUnitId: membership.org_unit_id ?? null,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRATION || '24h' }
  );
}

// ============================================================================
// 3. AUTH ENDPOINT: Student & Admin Login
// ============================================================================
// Two-step under the hood: `users` is a single global identity per email
// (shared across every organization that email belongs to — e.g. a student
// who also tutors at a separate institution), so a successful password
// check can resolve to more than one organization. One membership -> log
// straight in, identical response shape to before. More than one -> no
// usable token yet; the client gets a short-lived pre-auth token and a list
// of organizations to choose from, and completes login via
// POST /api/login/select-organization below.
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const userResult = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = userResult.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const memberships = await pool.query(
      `SELECT m.role, m.organization_id, m.org_unit_id, o.name AS organization_name
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1
       ORDER BY o.name ASC`,
      [user.id]
    );

    if (memberships.rows.length === 0) {
      return res.status(403).json({ error: 'No organization membership found. Contact your administrator.' });
    }

    if (memberships.rows.length === 1) {
      const m = memberships.rows[0];
      const token = mintSessionToken({ user_id: user.id, role: m.role, organization_id: m.organization_id, org_unit_id: m.org_unit_id });
      // Returned in the body, not set as a cookie â€” see authenticateToken for
      // why. The frontend stores this and attaches it as an Authorization
      // header on every request from here on.
      return res.status(200).json({
        message: 'Login successful',
        token,
        user: { id: user.id, email, role: m.role, organization_name: m.organization_name },
      });
    }

    // More than one organization â€” don't hand out a usable session token
    // yet. This pre-auth token only ever proves "this email's password was
    // already verified a moment ago"; it carries no role/org, and
    // authenticateToken explicitly refuses to accept it on any real route.
    const preAuthToken = jwt.sign({ type: 'preauth', userId: user.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res.status(200).json({
      requiresOrgSelection: true,
      preAuthToken,
      organizations: memberships.rows.map((m) => ({
        organizationId: m.organization_id,
        organizationName: m.organization_name,
        role: m.role,
      })),
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Completes a multi-membership login: verifies the pre-auth token, then
// re-derives role/org from the DB for the token's own userId â€” never from
// anything the client sent standalone, so a tampered organizationId in the
// request body can't grant a role/org the caller doesn't actually hold.
app.post('/api/login/select-organization', async (req, res) => {
  const { preAuthToken, organizationId } = req.body;
  if (!preAuthToken || !organizationId) {
    return res.status(400).json({ error: 'preAuthToken and organizationId are required' });
  }

  let payload;
  try {
    payload = jwt.verify(preAuthToken, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Login session expired â€” please sign in again' });
  }
  if (payload.type !== 'preauth') {
    return res.status(401).json({ error: 'Invalid login session' });
  }

  try {
    const result = await pool.query(
      `SELECT u.id AS user_id, u.email, m.role, m.organization_id, m.org_unit_id, o.name AS organization_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.organization_id = $2`,
      [payload.userId, organizationId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not a member of that organization' });
    }

    const m = result.rows[0];
    const token = mintSessionToken(m);
    res.status(200).json({
      message: 'Login successful',
      token,
      user: { id: m.user_id, email: m.email, role: m.role, organization_name: m.organization_name },
    });
  } catch (error) {
    console.error('Select-organization error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// 3b. SESSION: Who am I? â€” lets the frontend recover role/identity on refresh
// ============================================================================
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, m.role, m.org_unit_id, o.name AS organization_name
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2
       JOIN organizations o ON o.id = m.organization_id
       WHERE u.id = $1`,
      [req.user.userId, req.user.organizationId]
    );
    if (result.rows.length === 0) {
      // Token is still valid but the membership behind it is gone (e.g.
      // admin removed them from this org, or the account itself is gone)
      return res.status(401).json({ error: 'Session no longer valid' });
    }
    res.status(200).json({ user: result.rows[0] });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stateless token, so there's nothing server-side to invalidate here â€” the
// frontend just discards the token from localStorage. This route stays
// mainly so AuthContext has a consistent place to call, and so a future
// token-blacklist (if ever needed) has a natural home.
app.post('/api/logout', authenticateToken, (req, res) => {
  res.status(200).json({ message: 'Logged out' });
});

// ============================================================================
// 4. FORGOT PASSWORD: Generate token and send email
// ============================================================================
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(200).json({ message: 'If that email exists, a reset link was sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const tokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store only the hash â€” like a password, the raw token should never sit in the DB.
    await pool.query(
      'UPDATE users SET reset_token = $1, token_expiry = $2 WHERE email = $3',
      [tokenHash, tokenExpiry, email]
    );

    // This has to point at the frontend (Vite/React app), not the backend API â€”
    // there's no route on port 3000 for a user to actually land on.
    // App.jsx uses HashRouter, so the route only matches with a /#/ prefix —
    // without it, the browser just loads the SPA shell at "/" and React
    // Router never sees "/reset-password" at all.
    const resetLink = `${FRONTEND_URL}/#/reset-password?token=${resetToken}`;

    const { error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'AssignMeant Password Reset',
      text: `You requested a password reset.\n\nClick here to reset it: ${resetLink}\n\nThis link expires in 1 hour.`
    });
    if (emailError) throw emailError;

    res.status(200).json({ message: 'If that email exists, a reset link was sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// 5. RESET PASSWORD: Verify token and update password
// ============================================================================
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password required' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      'SELECT * FROM users WHERE reset_token = $1 AND token_expiry > NOW()',
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const email = result.rows[0].email;
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, token_expiry = NULL WHERE email = $2',
      [hashedPassword, email]
    );

    res.status(200).json({ message: 'Password reset successful. You can now log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// 6. PLAYGROUND â€” free-form code execution, not tied to any problem
// ============================================================================

/**
 * Legacy raw-run endpoint, kept for backward compatibility with the existing
 * "Run Code" button on the problem-solving page. Functionally identical to
 * the Playground route below â€” both just return whatever the program printed.
 */
app.post('/api/execute/:language', authenticateToken, async (req, res) => {
  const { language } = req.params;
  const { code, stdin } = req.body;

  if (!code) return res.status(400).json({ error: 'Code is required' });
  if (!LANGUAGE_CONFIG[language]) return res.status(400).json({ error: 'Unsupported language' });

  const result = await executeInSandbox(language, code, stdin || '');
  if (!result.success) return res.status(400).json({ error: result.error });
  res.status(200).json({ output: result.output });
});

/**
 * The Playground: same sandbox, explicitly namespaced so the frontend can
 * treat it as its own "just write and run code" section, separate from any
 * problem/judge context. Supports optional custom stdin.
 */
app.post('/api/playground/execute/:language', authenticateToken, async (req, res) => {
  const { language } = req.params;
  const { code, stdin } = req.body;

  if (!code) return res.status(400).json({ error: 'Code is required' });
  if (!LANGUAGE_CONFIG[language]) return res.status(400).json({ error: 'Unsupported language' });

  const result = await executeInSandbox(language, code, stdin || '');
  if (!result.success) return res.status(400).json({ error: result.error });
  res.status(200).json({ output: result.output });
});

// ============================================================================
// 7. PROBLEMS â€” LeetCode-style problem bank, browsing, and graded submissions
// ============================================================================

// List all problems (for a problem-list / index page)
app.get('/api/problems', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, difficulty, opens_at, closes_at, subject_id FROM problems WHERE organization_id = $1 ORDER BY id ASC',
      [req.user.organizationId]
    );

    const withStatus = result.rows.map((p) => ({ ...p, status: getProblemStatus(p) }));

    // Students never see an assignment before its opens_at; admins see everything
    // (open, closed, and upcoming) so they can manage the whole set.
    let visible = req.user.role === 'admin'
      ? withStatus
      : withStatus.filter((p) => p.status !== 'upcoming');

    // Subject visibility: a subject attached at "Department" reaches every
    // unit beneath it (e.g. every year), so this checks the student's own
    // unit AND all of its ancestors — not the unit alone. An item with no
    // subject at all (subject_id NULL) stays org-wide visible, same as
    // every problem behaved before this feature existed.
    if (req.user.role !== 'admin') {
      const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
      visible = visible.filter((p) => p.subject_id == null || visibleSubjectIds.includes(p.subject_id));
    }

    // Attach each student's own BEST submission per problem (most test cases
    // passed, with an Accepted verdict breaking ties) so the list can render
    // a pending / partial / accepted indicator without a second round-trip
    // per card. "Best" rather than "latest" so a student's progress doesn't
    // regress in the UI just because they re-ran a weaker attempt afterward.
    if (visible.length > 0) {
      const problemIds = visible.map((p) => p.id);
      const bestRes = await pool.query(
        `SELECT DISTINCT ON (problem_id) problem_id, status, passed_count, total_count, created_at
         FROM submissions
         WHERE user_id = $1 AND problem_id = ANY($2::int[])
         ORDER BY problem_id, (status = 'Accepted') DESC, passed_count DESC, created_at DESC`,
        [req.user.userId, problemIds]
      );
      const bestByProblem = {};
      bestRes.rows.forEach((row) => { bestByProblem[row.problem_id] = row; });

      visible.forEach((p) => {
        const best = bestByProblem[p.id];
        p.submission = best
          ? { status: best.status, passed: best.passed_count, total: best.total_count }
          : null;
      });
    }

    res.status(200).json({ problems: visible });
  } catch (err) {
    console.error('List problems error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetch a specific problem, its starter code, and its visible sample test cases
app.get('/api/problems/:id', authenticateToken, async (req, res) => {
  try {
    const problemId = req.params.id;

    const problemRes = await pool.query('SELECT * FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });

    const status = getProblemStatus(problemRes.rows[0]);
    if (status === 'upcoming' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'This assignment is not open yet' });
    }

    const codeRes = await pool.query(
      'SELECT language, code FROM starter_code WHERE problem_id = $1',
      [problemId]
    );
    const starterCode = {};
    codeRes.rows.forEach((row) => {
      starterCode[row.language] = row.code;
    });

    // Hidden test cases never leave the server â€” only samples are shown, LeetCode-style
    const sampleRes = await pool.query(
      'SELECT input, expected_output FROM test_cases WHERE problem_id = $1 AND is_hidden = false ORDER BY id ASC',
      [problemId]
    );

    // How much time this student has already logged on this specific
    // assignment (see problem_time_logs / POST /api/problems/:id/time-log).
    // Sent back so the frontend timer can seed itself with the real running
    // total instead of starting over at 0 every time the page is opened.
    const timeRes = await pool.query(
      'SELECT total_seconds FROM problem_time_logs WHERE user_id = $1 AND problem_id = $2',
      [req.user.userId, problemId]
    );
    const timeSpentSeconds = timeRes.rows[0]?.total_seconds ?? 0;

    res.json({
      problem: { ...problemRes.rows[0], status },
      starterCode,
      samples: sampleRes.rows,
      timeSpentSeconds,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Student's own result for one assignment — mirrors GET /api/exams/:id/result:
// whichever of percentile/grade tag are currently switched on platform-wide,
// gated on the assignment's own deadline having passed (assignments have no
// manual-grading step, so there's no separate "still being graded" state —
// every submission is auto-judged the instant it's made).
app.get('/api/problems/:id/result', authenticateToken, async (req, res) => {
  const problemId = req.params.id;
  try {
    const bestRes = await pool.query(
      `SELECT passed_count, total_count FROM submissions
       WHERE user_id = $1 AND problem_id = $2
       ORDER BY (status = 'Accepted') DESC, passed_count DESC, created_at DESC LIMIT 1`,
      [req.user.userId, problemId]
    );
    if (bestRes.rows.length === 0) return res.status(404).json({ error: 'No submission found for this assignment' });

    const problemRes = await pool.query('SELECT closes_at FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });

    if (problemRes.rows[0].closes_at && new Date(problemRes.rows[0].closes_at) > new Date()) {
      return res.status(200).json({ status: 'pending', reason: 'deadline' });
    }

    const best = bestRes.rows[0];
    const myPercentage = best.total_count > 0 ? (best.passed_count / best.total_count) * 100 : 0;

    // Per-assignment percentile, among every student's best submission for
    // this problem. No deadline filter needed on the population itself —
    // we only ever reach this line once this problem's own closes_at has
    // already passed.
    const allBestRes = await pool.query(
      `SELECT DISTINCT ON (user_id) user_id, passed_count, total_count
       FROM submissions WHERE problem_id = $1
       ORDER BY user_id, (status = 'Accepted') DESC, passed_count DESC, created_at DESC`,
      [problemId]
    );
    const problemPercentages = allBestRes.rows
      .filter((r) => r.total_count > 0)
      .map((r) => (r.passed_count / r.total_count) * 100);
    const { tag: percentileTag } = computePercentileTiers(problemPercentages)(myPercentage);

    // Overall (assignments) percentile: every student's average best-submission
    // % across every problem they've submitted to, only counting problems
    // whose own deadline has already passed — same fairness rule as exams'
    // "overall" so a still-open assignment elsewhere can't skew it early.
    const overallRes = await pool.query(
      `SELECT best.user_id, AVG(best.passed_count::float / best.total_count * 100) AS avg_percentage
       FROM (
         SELECT DISTINCT ON (s.user_id, s.problem_id) s.user_id, s.problem_id, s.passed_count, s.total_count
         FROM submissions s
         JOIN problems p ON p.id = s.problem_id
         WHERE p.organization_id = $1 AND (p.closes_at IS NULL OR p.closes_at <= now())
         ORDER BY s.user_id, s.problem_id, (s.status = 'Accepted') DESC, s.passed_count DESC, s.created_at DESC
       ) best
       WHERE best.total_count > 0
       GROUP BY best.user_id`,
      [req.user.organizationId]
    );
    const overallPercentileFor = computePercentileTiers(overallRes.rows.map((r) => Number(r.avg_percentage)));
    const myOverall = overallRes.rows.find((r) => r.user_id === req.user.userId);
    const overallAssignmentsPercentileTag = myOverall ? overallPercentileFor(Number(myOverall.avg_percentage)).tag : null;

    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [req.user.organizationId]);
    const gradeTag = gradeTagForPercentage(bandsRes.rows, myPercentage);

    const visibility = await getTagVisibility(req.user.organizationId);
    res.status(200).json({
      status: 'graded',
      percentileTag: visibility.show_percentile_tag ? percentileTag : undefined,
      overallAssignmentsPercentileTag: visibility.show_percentile_tag ? overallAssignmentsPercentileTag : undefined,
      gradeTag: visibility.show_grade_tag ? gradeTag : undefined,
    });
  } catch (err) {
    console.error('Assignment result error:', err);
    res.status(500).json({ error: 'Failed to load result' });
  }
});

// Admin: upload a new problem with its starter code and test cases in one shot
app.post('/api/admin/problems', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { title, difficulty, description, starterCode = {}, testCases = [], opensAt = null, closesAt = null } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;

  if (!title || !difficulty || !description) {
    return res.status(400).json({ error: 'Title, difficulty, and description are required' });
  }
  if (!Array.isArray(testCases) || testCases.length === 0) {
    return res.status(400).json({ error: 'At least one test case is required' });
  }
  if (await enforceSubjectAuthority(req, res, subjectId)) return;

  let timeLimitSeconds;
  try {
    timeLimitSeconds = normalizeTimeLimitSeconds(req.body.timeLimitSeconds);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const problemRes = await client.query(
      `INSERT INTO problems (title, difficulty, description, created_by, opens_at, closes_at, time_limit_seconds, organization_id, subject_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [title, difficulty, description, req.user.userId, opensAt, closesAt, timeLimitSeconds, req.user.organizationId, subjectId]
    );
    const problemId = problemRes.rows[0].id;

    for (const [language, code] of Object.entries(starterCode)) {
      await client.query(
        `INSERT INTO starter_code (problem_id, language, code) VALUES ($1, $2, $3)`,
        [problemId, language, code]
      );
    }

    for (const testCase of testCases) {
      if (!testCase.expectedOutput) continue;
      await client.query(
        `INSERT INTO test_cases (problem_id, input, expected_output, is_hidden)
         VALUES ($1, $2, $3, $4)`,
        [problemId, testCase.input || '', testCase.expectedOutput, testCase.isHidden !== false]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Problem created successfully', problemId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Problem upload error:', error);
    res.status(500).json({ error: 'Failed to create problem' });
  } finally {
    client.release();
  }
});

// ============================================================================
// 7a-1. ADMIN: Fetch one assignment's full editable details (incl. hidden
// test cases) â€” used by AdminDashboard's "Edit" button to pre-fill the form.
// ============================================================================
app.get('/api/admin/problems/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const problemId = req.params.id;
  try {
    const problemRes = await pool.query(
      'SELECT id, title, difficulty, description, opens_at, closes_at, subject_id FROM problems WHERE id = $1 AND organization_id = $2',
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    const problem = problemRes.rows[0];
    if (await enforceSubjectAuthority(req, res, problem.subject_id)) return;

    const codeRes = await pool.query(
      'SELECT language, code FROM starter_code WHERE problem_id = $1',
      [problemId]
    );
    const starterCode = {};
    codeRes.rows.forEach((row) => { starterCode[row.language] = row.code; });

    // Every test case, hidden ones included â€” unlike the student-facing
    // GET /api/problems/:id, which only returns visible samples.
    const testCasesRes = await pool.query(
      'SELECT input, expected_output, is_hidden FROM test_cases WHERE problem_id = $1 ORDER BY id ASC',
      [problemId]
    );
    const testCases = testCasesRes.rows.map((tc) => ({
      input: tc.input,
      expectedOutput: tc.expected_output,
      isHidden: tc.is_hidden,
    }));

    res.status(200).json({
      title: problem.title,
      difficulty: problem.difficulty,
      description: problem.description,
      starterCode,
      testCases,
      opensAt: problem.opens_at,
      closesAt: problem.closes_at,
      subjectId: problem.subject_id,
    });
  } catch (err) {
    console.error('Fetch full problem error:', err);
    res.status(500).json({ error: 'Failed to load assignment details' });
  }
});

// ============================================================================
// 7a-2. ADMIN: Full update of an assignment â€” title, difficulty, description,
// starter code, and the complete set of test cases (full replace). Used by
// AssignmentForm's edit-mode submit.
// ============================================================================
app.put('/api/admin/problems/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const problemId = req.params.id;
  const { title, difficulty, description, starterCode = {}, testCases = [], opensAt = null, closesAt = null } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;

  if (!title || !difficulty || !description) {
    return res.status(400).json({ error: 'Title, difficulty, and description are required' });
  }
  if (!Array.isArray(testCases) || testCases.length === 0) {
    return res.status(400).json({ error: 'At least one test case is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Problem not found' });
    }
    // A teacher must be authorized on both the item's current subject and
    // whatever subject they're moving it to (a no-op check for admins).
    if (await enforceSubjectAuthority(req, res, existing.rows[0].subject_id)) { await client.query('ROLLBACK'); return; }
    if (subjectId !== existing.rows[0].subject_id && await enforceSubjectAuthority(req, res, subjectId)) { await client.query('ROLLBACK'); return; }

    await client.query(
      `UPDATE problems SET title = $1, difficulty = $2, description = $3, opens_at = $4, closes_at = $5, subject_id = $6 WHERE id = $7`,
      [title, difficulty, description, opensAt, closesAt, subjectId, problemId]
    );

    // Starter code and test cases are fully replaced rather than diffed â€”
    // matches how AssignmentForm sends its payload (the whole set at once).
    await client.query('DELETE FROM starter_code WHERE problem_id = $1', [problemId]);
    for (const [language, code] of Object.entries(starterCode)) {
      if (!code) continue;
      await client.query(
        `INSERT INTO starter_code (problem_id, language, code) VALUES ($1, $2, $3)`,
        [problemId, language, code]
      );
    }

    await client.query('DELETE FROM test_cases WHERE problem_id = $1', [problemId]);
    for (const testCase of testCases) {
      if (!testCase.expectedOutput) continue;
      await client.query(
        `INSERT INTO test_cases (problem_id, input, expected_output, is_hidden) VALUES ($1, $2, $3, $4)`,
        [problemId, testCase.input || '', testCase.expectedOutput, testCase.isHidden !== false]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Assignment updated successfully', problemId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Problem update error:', error);
    res.status(500).json({ error: 'Failed to update assignment' });
  } finally {
    client.release();
  }
});

// ============================================================================
// 7b. ADMIN: Open/close an assignment's time slot
// ============================================================================
// Only touches the field(s) actually present in the body, so you can e.g. close
// an assignment right now without clobbering a previously-scheduled opens_at.
app.patch('/api/admin/problems/:id/window', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const problemId = req.params.id;
  const hasOpensAt = Object.prototype.hasOwnProperty.call(req.body, 'opensAt');
  const hasClosesAt = Object.prototype.hasOwnProperty.call(req.body, 'closesAt');

  if (!hasOpensAt && !hasClosesAt) {
    return res.status(400).json({ error: 'Provide opensAt and/or closesAt (send null to clear one)' });
  }

  try {
    const current = await pool.query('SELECT opens_at, closes_at, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    if (await enforceSubjectAuthority(req, res, current.rows[0].subject_id)) return;

    const nextOpensAt = hasOpensAt ? req.body.opensAt : current.rows[0].opens_at;
    const nextClosesAt = hasClosesAt ? req.body.closesAt : current.rows[0].closes_at;

    const result = await pool.query(
      `UPDATE problems SET opens_at = $1, closes_at = $2 WHERE id = $3
       RETURNING id, title, opens_at, closes_at`,
      [nextOpensAt, nextClosesAt, problemId]
    );

    const problem = result.rows[0];
    res.status(200).json({ message: 'Assignment window updated', problem: { ...problem, status: getProblemStatus(problem) } });
  } catch (err) {
    console.error('Update assignment window error:', err);
    res.status(500).json({ error: 'Failed to update assignment window' });
  }
});

// ============================================================================
// 7c. ADMIN: Test case management for an existing assignment
// ============================================================================

// List every test case for a problem, hidden ones included (admin-only view)
app.get('/api/admin/problems/:id/test-cases', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;

    const result = await pool.query(
      'SELECT id, input, expected_output, is_hidden FROM test_cases WHERE problem_id = $1 ORDER BY id ASC',
      [req.params.id]
    );
    res.status(200).json({ testCases: result.rows });
  } catch (err) {
    console.error('List test cases error:', err);
    res.status(500).json({ error: 'Failed to load test cases' });
  }
});

// Add one or more test cases to an existing problem
app.post('/api/admin/problems/:id/test-cases', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const problemId = req.params.id;
  const { testCases } = req.body;

  if (!Array.isArray(testCases) || testCases.length === 0) {
    return res.status(400).json({ error: 'At least one test case is required' });
  }

  try {
    const problemRes = await pool.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;

    const inserted = [];
    for (const tc of testCases) {
      if (!tc.expectedOutput) continue;
      const result = await pool.query(
        `INSERT INTO test_cases (problem_id, input, expected_output, is_hidden)
         VALUES ($1, $2, $3, $4) RETURNING id, input, expected_output, is_hidden`,
        [problemId, tc.input || '', tc.expectedOutput, tc.isHidden !== false]
      );
      inserted.push(result.rows[0]);
    }

    res.status(201).json({ message: `${inserted.length} test case(s) added`, testCases: inserted });
  } catch (err) {
    console.error('Add test cases error:', err);
    res.status(500).json({ error: 'Failed to add test cases' });
  }
});

// Remove a single test case by its own id
app.delete('/api/admin/test-cases/:testCaseId', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    // Join back to problems for the org check — test_cases itself has no
    // organization_id, it's scoped transitively via the problem it belongs to.
    const owner = await pool.query(
      `SELECT p.subject_id FROM test_cases tc JOIN problems p ON p.id = tc.problem_id
       WHERE tc.id = $1 AND p.organization_id = $2`,
      [req.params.testCaseId, req.user.organizationId]
    );
    if (owner.rows.length === 0) return res.status(404).json({ error: 'Test case not found' });
    if (await enforceSubjectAuthority(req, res, owner.rows[0].subject_id)) return;

    const result = await pool.query('DELETE FROM test_cases WHERE id = $1 RETURNING id', [req.params.testCaseId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Test case not found' });
    res.status(200).json({ message: 'Test case deleted' });
  } catch (err) {
    console.error('Delete test case error:', err);
    res.status(500).json({ error: 'Failed to delete test case' });
  }
});

// ============================================================================
// 7d. ADMIN: Delete an assignment entirely
// ============================================================================
// This is a hard delete â€” it also wipes that problem's starter code, test cases,
// and every student submission tied to it, so grade history for it goes with it.
// If you'd rather keep submission history around, consider closing the time
// slot instead (closesAt in the past) rather than deleting.
app.delete('/api/admin/problems/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const problemId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const problemRes = await client.query('SELECT id, title, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Problem not found' });
    }
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) { await client.query('ROLLBACK'); return; }

    await client.query('DELETE FROM submissions WHERE problem_id = $1', [problemId]);
    await client.query('DELETE FROM test_cases WHERE problem_id = $1', [problemId]);
    await client.query('DELETE FROM starter_code WHERE problem_id = $1', [problemId]);
    await client.query('DELETE FROM problems WHERE id = $1', [problemId]);

    await client.query('COMMIT');
    res.status(200).json({ message: `"${problemRes.rows[0].title}" and all related data were deleted` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete assignment error:', err);
    res.status(500).json({ error: 'Failed to delete assignment' });
  } finally {
    client.release();
  }
});

// Admin: every student's best submission for one assignment, with
// percentage/grade tag/percentile tag — mirrors GET /api/admin/exams/:id/attempts.
// Population for the percentile is every student's best submission for
// this problem, live (not deadline-filtered) — same as the exam version,
// teachers see current standings regardless of whether the deadline has
// passed; the deadline gate only affects the student-facing /result route.
app.get('/api/admin/problems/:id/attempts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });

    const bestRes = await pool.query(
      `SELECT DISTINCT ON (s.user_id) s.user_id, u.email, s.status, s.passed_count, s.total_count, s.created_at
       FROM submissions s
       JOIN users u ON u.id = s.user_id
       WHERE s.problem_id = $1
       ORDER BY s.user_id, (s.status = 'Accepted') DESC, s.passed_count DESC, s.created_at DESC`,
      [req.params.id]
    );

    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [req.user.organizationId]);
    const bands = bandsRes.rows;

    const percentages = bestRes.rows.filter((r) => r.total_count > 0).map((r) => (r.passed_count / r.total_count) * 100);
    const percentileFor = computePercentileTiers(percentages);

    const attempts = bestRes.rows.map((r) => {
      const percentage = r.total_count > 0 ? (r.passed_count / r.total_count) * 100 : null;
      return {
        email: r.email,
        status: r.status,
        passedCount: r.passed_count,
        totalCount: r.total_count,
        lastSubmittedAt: r.created_at,
        percentage,
        gradeTag: percentage != null ? gradeTagForPercentage(bands, percentage) : null,
        percentileTag: percentage != null ? percentileFor(percentage).tag : null,
      };
    });

    res.status(200).json({ attempts });
  } catch (err) {
    console.error('List assignment attempts error:', err);
    res.status(500).json({ error: 'Failed to load attempts' });
  }
});

// ============================================================================
// EXAMS (ADMIN) â€” foundation for exam mode: create/list/edit/delete exams,
// each holding an ordered mix of mcq/short/long/coding items. This block
// only covers the admin builder; the student-facing exam-taking flow
// (lockdown, webcam proctoring, grading) is separate follow-up work.
// ============================================================================

// Create an exam with its full set of items in one transaction.
app.post('/api/admin/exams', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { title, description = null, totalTimeSeconds, webcamRequired = false, opensAt = null, closesAt = null, items = [] } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (await enforceSubjectAuthority(req, res, subjectId)) return;
  const totalTime = Number(totalTimeSeconds);
  if (!Number.isFinite(totalTime) || totalTime <= 0) {
    return res.status(400).json({ error: 'Total exam time must be a positive number of seconds' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'An exam needs at least one item' });
  }

  let normalizedItems;
  try {
    normalizedItems = items.map((item, i) => normalizeExamItem(item, i));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Coding items reference an existing assignment's problem_id â€” verified up
  // front so a typo'd/deleted id fails with a clear message instead of
  // tripping the FK constraint mid-transaction.
  const codingProblemIds = [...new Set(normalizedItems.filter((i) => i.type === 'coding' && i.problemId != null).map((i) => i.problemId))];
  if (codingProblemIds.length > 0) {
    // Scoped to the caller's own org — otherwise an admin could reference
    // (and thereby leak samples/starter code from) another org's assignment.
    const existing = await pool.query('SELECT id FROM problems WHERE id = ANY($1::int[]) AND organization_id = $2', [codingProblemIds, req.user.organizationId]);
    const existingIds = new Set(existing.rows.map((r) => r.id));
    const missing = codingProblemIds.find((id) => !existingIds.has(id));
    if (missing !== undefined) {
      return res.status(400).json({ error: `Coding item references a missing assignment (id ${missing})` });
    }
  }

  const totalMarks = normalizedItems.reduce((sum, i) => sum + i.marks, 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const examRes = await client.query(
      `INSERT INTO exams (title, description, total_marks, total_time_seconds, webcam_required, opens_at, closes_at, created_by, organization_id, subject_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [title.trim(), description, totalMarks, Math.round(totalTime), !!webcamRequired, opensAt, closesAt, req.user.userId, req.user.organizationId, subjectId]
    );
    const examId = examRes.rows[0].id;

    for (let i = 0; i < normalizedItems.length; i++) {
      const item = normalizedItems[i];
      await client.query(
        `INSERT INTO exam_items (exam_id, type, position, marks, time_limit_seconds, prompt, options, correct_option_id, word_limit, problem_id, starter_code, test_cases)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [examId, item.type, i, item.marks, item.timeLimitSeconds, item.prompt,
         item.options ? JSON.stringify(item.options) : null, item.correctOptionId, item.wordLimit, item.problemId,
         item.starterCode ? JSON.stringify(item.starterCode) : null, item.testCases ? JSON.stringify(item.testCases) : null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Exam created successfully', examId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Exam create error:', error);
    res.status(500).json({ error: 'Failed to create exam' });
  } finally {
    client.release();
  }
});

// List exams for the admin table â€” item_count only, not the full items
// (those load on-demand when actually editing one).
app.get('/api/admin/exams', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.id, e.title, e.total_marks, e.total_time_seconds, e.webcam_required,
             e.opens_at, e.closes_at, COUNT(ei.id)::int AS item_count
      FROM exams e
      LEFT JOIN exam_items ei ON ei.exam_id = e.id
      WHERE e.organization_id = $1
      GROUP BY e.id
      ORDER BY e.created_at DESC
    `, [req.user.organizationId]);
    const exams = result.rows.map((e) => ({ ...e, status: getProblemStatus(e) }));
    res.status(200).json({ exams });
  } catch (err) {
    console.error('List exams error:', err);
    res.status(500).json({ error: 'Failed to load exams' });
  }
});

// Full detail for one exam, items included â€” used by ExamForm to pre-fill
// edit mode (including each MCQ's correct answer, unlike whatever the
// eventual student-facing fetch will return).
app.get('/api/admin/exams/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const examId = req.params.id;
  try {
    const examRes = await pool.query(
      'SELECT id, title, description, total_marks, total_time_seconds, webcam_required, opens_at, closes_at, subject_id FROM exams WHERE id = $1 AND organization_id = $2',
      [examId, req.user.organizationId]
    );
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
    if (await enforceSubjectAuthority(req, res, examRes.rows[0].subject_id)) return;

    const itemsRes = await pool.query(
      `SELECT id, type, position, marks, time_limit_seconds, prompt, options, correct_option_id, word_limit, problem_id, starter_code, test_cases
       FROM exam_items WHERE exam_id = $1 ORDER BY position ASC`,
      [examId]
    );

    res.status(200).json({ ...examRes.rows[0], items: itemsRes.rows });
  } catch (err) {
    console.error('Fetch full exam error:', err);
    res.status(500).json({ error: 'Failed to load exam details' });
  }
});

// Full update â€” same "replace the whole item set" approach as assignment
// editing, matching how ExamForm will send its payload (everything at once).
app.put('/api/admin/exams/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const examId = req.params.id;
  const { title, description = null, totalTimeSeconds, webcamRequired = false, opensAt = null, closesAt = null, items = [] } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  const totalTime = Number(totalTimeSeconds);
  if (!Number.isFinite(totalTime) || totalTime <= 0) {
    return res.status(400).json({ error: 'Total exam time must be a positive number of seconds' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'An exam needs at least one item' });
  }

  let normalizedItems;
  try {
    normalizedItems = items.map((item, i) => normalizeExamItem(item, i));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const codingProblemIds = [...new Set(normalizedItems.filter((i) => i.type === 'coding' && i.problemId != null).map((i) => i.problemId))];
  if (codingProblemIds.length > 0) {
    const existingProblems = await pool.query('SELECT id FROM problems WHERE id = ANY($1::int[]) AND organization_id = $2', [codingProblemIds, req.user.organizationId]);
    const existingIds = new Set(existingProblems.rows.map((r) => r.id));
    const missing = codingProblemIds.find((id) => !existingIds.has(id));
    if (missing !== undefined) {
      return res.status(400).json({ error: `Coding item references a missing assignment (id ${missing})` });
    }
  }

  const totalMarks = normalizedItems.reduce((sum, i) => sum + i.marks, 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id, subject_id FROM exams WHERE id = $1 AND organization_id = $2', [examId, req.user.organizationId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Exam not found' });
    }
    if (await enforceSubjectAuthority(req, res, existing.rows[0].subject_id)) { await client.query('ROLLBACK'); return; }
    if (subjectId !== existing.rows[0].subject_id && await enforceSubjectAuthority(req, res, subjectId)) { await client.query('ROLLBACK'); return; }

    await client.query(
      `UPDATE exams SET title = $1, description = $2, total_marks = $3, total_time_seconds = $4,
       webcam_required = $5, opens_at = $6, closes_at = $7, subject_id = $8 WHERE id = $9`,
      [title.trim(), description, totalMarks, Math.round(totalTime), !!webcamRequired, opensAt, closesAt, subjectId, examId]
    );

    await client.query('DELETE FROM exam_items WHERE exam_id = $1', [examId]);
    for (let i = 0; i < normalizedItems.length; i++) {
      const item = normalizedItems[i];
      await client.query(
        `INSERT INTO exam_items (exam_id, type, position, marks, time_limit_seconds, prompt, options, correct_option_id, word_limit, problem_id, starter_code, test_cases)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [examId, item.type, i, item.marks, item.timeLimitSeconds, item.prompt,
         item.options ? JSON.stringify(item.options) : null, item.correctOptionId, item.wordLimit, item.problemId,
         item.starterCode ? JSON.stringify(item.starterCode) : null, item.testCases ? JSON.stringify(item.testCases) : null]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Exam updated successfully', examId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Exam update error:', error);
    res.status(500).json({ error: 'Failed to update exam' });
  } finally {
    client.release();
  }
});

// Delete an exam â€” exam_items cascade automatically (ON DELETE CASCADE).
// The referenced `problems` rows for any coding items are untouched, since
// those are owned by the Assignments side, not the exam.
app.delete('/api/admin/exams/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const existing = await pool.query('SELECT id, subject_id FROM exams WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
    if (await enforceSubjectAuthority(req, res, existing.rows[0].subject_id)) return;

    const result = await pool.query('DELETE FROM exams WHERE id = $1 RETURNING id, title', [req.params.id]);
    res.status(200).json({ message: `"${result.rows[0].title}" was deleted` });
  } catch (err) {
    console.error('Delete exam error:', err);
    res.status(500).json({ error: 'Failed to delete exam' });
  }
});

// ============================================================================
// GRADE BANDS — the global (not per-exam) configurable scale behind the
// individual exam score tag, e.g. "90-100 -> Excellent". Admin-only, in
// both who can edit it and who ever sees the resulting tag.
// ============================================================================
app.get('/api/admin/grade-bands', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, label, min_percent FROM grade_bands WHERE organization_id = $1 ORDER BY min_percent DESC', [req.user.organizationId]);
    res.status(200).json({ gradeBands: result.rows });
  } catch (err) {
    console.error('List grade bands error:', err);
    res.status(500).json({ error: 'Failed to load grade bands' });
  }
});

function validateGradeBandBody(body) {
  const label = String(body.label || '').trim();
  if (!label) throw new Error('Label is required');
  const minPercent = Number(body.minPercent);
  if (!Number.isFinite(minPercent) || minPercent < 0 || minPercent > 100) {
    throw new Error('Minimum percent must be between 0 and 100');
  }
  return { label, minPercent };
}

app.post('/api/admin/grade-bands', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { label, minPercent } = validateGradeBandBody(req.body);
    const result = await pool.query(
      'INSERT INTO grade_bands (label, min_percent, organization_id) VALUES ($1, $2, $3) RETURNING id, label, min_percent',
      [label, minPercent, req.user.organizationId]
    );
    res.status(201).json({ gradeBand: result.rows[0] });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create grade band' });
  }
});

app.put('/api/admin/grade-bands/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { label, minPercent } = validateGradeBandBody(req.body);
    const result = await pool.query(
      'UPDATE grade_bands SET label = $1, min_percent = $2 WHERE id = $3 AND organization_id = $4 RETURNING id, label, min_percent',
      [label, minPercent, req.params.id, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Grade band not found' });
    res.status(200).json({ gradeBand: result.rows[0] });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to update grade band' });
  }
});

app.delete('/api/admin/grade-bands/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM grade_bands WHERE id = $1 AND organization_id = $2 RETURNING id', [req.params.id, req.user.organizationId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Grade band not found' });
    res.status(200).json({ message: 'Grade band deleted' });
  } catch (err) {
    console.error('Delete grade band error:', err);
    res.status(500).json({ error: 'Failed to delete grade band' });
  }
});

// Per-organization switch for which of the two tags students ever see of
// their own results — teachers/admins always see both regardless of this
// setting; it only gates the student-facing /result routes (exams and assignments).
app.get('/api/admin/tag-visibility', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const settings = await getTagVisibility(req.user.organizationId);
    res.status(200).json({
      showPercentileTag: settings.show_percentile_tag,
      showGradeTag: settings.show_grade_tag,
    });
  } catch (err) {
    console.error('Get tag visibility error:', err);
    res.status(500).json({ error: 'Failed to load tag visibility settings' });
  }
});

app.put('/api/admin/tag-visibility', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE tag_visibility_settings SET show_percentile_tag = $1, show_grade_tag = $2 WHERE organization_id = $3
       RETURNING show_percentile_tag, show_grade_tag`,
      [!!req.body.showPercentileTag, !!req.body.showGradeTag, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tag visibility settings not found' });
    res.status(200).json({
      showPercentileTag: result.rows[0].show_percentile_tag,
      showGradeTag: result.rows[0].show_grade_tag,
    });
  } catch (err) {
    console.error('Update tag visibility error:', err);
    res.status(500).json({ error: 'Failed to update tag visibility settings' });
  }
});

// ============================================================================
// EXAMS (STUDENT) — the actual exam-taking flow: browse, start, submit.
// One attempt ever per (exam, student), enforced by the UNIQUE(exam_id,
// user_id) constraint on exam_attempts (not just app logic), so a race
// between two tabs/requests can't produce two attempts.
// ============================================================================

// List exams available to the caller, with their own attempt (if any)
// left-joined in so the UI can show "Not started" / "Completed" without a
// second round-trip per exam. Mirrors GET /api/problems: students never see
// an 'upcoming' exam, admins see everything.
app.get('/api/exams', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.title, e.description, e.total_marks, e.total_time_seconds,
              e.opens_at, e.closes_at, e.subject_id, a.status AS attempt_status
       FROM exams e
       LEFT JOIN exam_attempts a ON a.exam_id = e.id AND a.user_id = $1
       WHERE e.organization_id = $2
       ORDER BY e.opens_at NULLS LAST, e.created_at DESC`,
      [req.user.userId, req.user.organizationId]
    );

    const withStatus = result.rows.map((e) => ({ ...e, status: getProblemStatus(e) }));
    let visible = req.user.role === 'admin'
      ? withStatus
      : withStatus.filter((e) => e.status !== 'upcoming');

    if (req.user.role !== 'admin') {
      const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
      visible = visible.filter((e) => e.subject_id == null || visibleSubjectIds.includes(e.subject_id));
    }

    res.status(200).json({ exams: visible });
  } catch (err) {
    console.error('List exams error:', err);
    res.status(500).json({ error: 'Failed to load exams' });
  }
});

// Pre-start metadata only — item content (prompts/options/correct answers)
// is never exposed here, just a bare summary. Full items are handed to the
// client exactly once, in the response of POST /start.
app.get('/api/exams/:id', authenticateToken, async (req, res) => {
  try {
    const examRes = await pool.query(
      'SELECT id, title, description, total_marks, total_time_seconds, webcam_required, opens_at, closes_at FROM exams WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user.organizationId]
    );
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });

    const exam = examRes.rows[0];
    const status = getProblemStatus(exam);
    if (status === 'upcoming' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'This exam is not open yet' });
    }

    const itemsRes = await pool.query(
      'SELECT type, marks, position FROM exam_items WHERE exam_id = $1 ORDER BY position ASC',
      [req.params.id]
    );

    const attemptRes = await pool.query(
      'SELECT status FROM exam_attempts WHERE exam_id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );

    res.status(200).json({
      exam: { ...exam, status },
      itemsSummary: itemsRes.rows,
      attemptStatus: attemptRes.rows[0]?.status ?? null,
    });
  } catch (err) {
    console.error('Fetch exam error:', err);
    res.status(500).json({ error: 'Failed to load exam' });
  }
});

// Starts a timed attempt. 409s if one already exists for this student —
// either it's still in_progress (forcibly ended right here as
// 'reopened_stale', since re-entering after leaving is exactly the
// lockdown escape hatch this feature exists to close) or already submitted.
app.post('/api/exams/:id/start', authenticateToken, async (req, res) => {
  const examId = req.params.id;
  try {
    const examRes = await pool.query('SELECT * FROM exams WHERE id = $1 AND organization_id = $2', [examId, req.user.organizationId]);
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });

    const exam = examRes.rows[0];
    const status = getProblemStatus(exam);
    if (status !== 'open' && req.user.role !== 'admin') {
      return res.status(403).json({
        error: status === 'upcoming' ? 'This exam is not open yet' : 'This exam is closed',
      });
    }

    const itemsRes = await pool.query(
      'SELECT * FROM exam_items WHERE exam_id = $1 ORDER BY position ASC',
      [examId]
    );
    const items = itemsRes.rows;

    const deadlineCandidates = [Date.now() + exam.total_time_seconds * 1000];
    if (exam.closes_at) deadlineCandidates.push(new Date(exam.closes_at).getTime());
    const deadlineAt = new Date(Math.min(...deadlineCandidates));

    let attempt;
    try {
      const insertRes = await pool.query(
        'INSERT INTO exam_attempts (exam_id, user_id, deadline_at) VALUES ($1, $2, $3) RETURNING *',
        [examId, req.user.userId, deadlineAt]
      );
      attempt = insertRes.rows[0];
    } catch (err) {
      if (err.code !== '23505') throw err; // not a unique-violation — a real error

      const existingRes = await pool.query(
        'SELECT * FROM exam_attempts WHERE exam_id = $1 AND user_id = $2',
        [examId, req.user.userId]
      );
      const existing = existingRes.rows[0];
      if (existing.status === 'in_progress') {
        const score = await finalizeExamAttempt(existing.id, items, []);
        await pool.query(
          `UPDATE exam_attempts SET status = 'submitted', ended_at = now(), end_reason = 'reopened_stale', score = $1 WHERE id = $2`,
          [score, existing.id]
        );
        return res.status(409).json({ error: 'This exam was already started and has ended — it cannot be restarted.' });
      }
      return res.status(409).json({ error: 'You have already completed this exam.' });
    }

    // Hidden test cases and correct_option_id never leave the server — build
    // a sanitized item list, joining starter code + visible samples for
    // coding items exactly like GET /api/problems/:id does, so the frontend
    // never needs a second privileged fetch mid-exam.
    const codingProblemIds = items.filter((it) => it.type === 'coding' && it.problem_id).map((it) => it.problem_id);
    const starterByProblem = {};
    const samplesByProblem = {};
    const descriptionByProblem = {};
    if (codingProblemIds.length > 0) {
      const starterRes = await pool.query(
        'SELECT problem_id, language, code FROM starter_code WHERE problem_id = ANY($1::int[])',
        [codingProblemIds]
      );
      starterRes.rows.forEach((row) => {
        starterByProblem[row.problem_id] = starterByProblem[row.problem_id] || {};
        starterByProblem[row.problem_id][row.language] = row.code;
      });
      const sampleRes = await pool.query(
        'SELECT problem_id, input, expected_output FROM test_cases WHERE problem_id = ANY($1::int[]) AND is_hidden = false ORDER BY id ASC',
        [codingProblemIds]
      );
      sampleRes.rows.forEach((row) => {
        samplesByProblem[row.problem_id] = samplesByProblem[row.problem_id] || [];
        samplesByProblem[row.problem_id].push({ input: row.input, expected_output: row.expected_output });
      });
      // A "reuse" coding item never collects its own prompt in the exam
      // builder (ExamForm only shows the assignment picker for it) — the
      // question text students see has to be the linked assignment's own
      // description, same as Sandbox.jsx shows for a normal assignment.
      const descRes = await pool.query(
        'SELECT id, description FROM problems WHERE id = ANY($1::int[])',
        [codingProblemIds]
      );
      descRes.rows.forEach((row) => { descriptionByProblem[row.id] = row.description; });
    }

    const sanitizedItems = items.map((it) => {
      const base = { id: it.id, type: it.type, marks: it.marks, prompt: it.prompt };
      if (it.type === 'mcq') return { ...base, options: it.options };
      if (it.type === 'short' || it.type === 'long') return { ...base, wordLimit: it.word_limit };
      if (it.type === 'coding') {
        if (it.problem_id) {
          return {
            ...base,
            prompt: it.prompt || descriptionByProblem[it.problem_id] || null,
            starterCode: starterByProblem[it.problem_id] || {},
            samples: samplesByProblem[it.problem_id] || [],
          };
        }
        // Custom-authored item — everything already lives inline on the
        // item itself, no join needed. Hidden cases are filtered out here,
        // same as the reuse path filters them out at the SQL level above.
        const customSamples = Array.isArray(it.test_cases)
          ? it.test_cases.filter((tc) => !tc.isHidden).map((tc) => ({ input: tc.input, expected_output: tc.expectedOutput }))
          : [];
        return { ...base, starterCode: it.starter_code || {}, samples: customSamples };
      }
      return base;
    });

    res.status(201).json({
      attemptId: attempt.id,
      deadlineAt: attempt.deadline_at,
      exam: { id: exam.id, title: exam.title, totalMarks: exam.total_marks, totalTimeSeconds: exam.total_time_seconds },
      items: sanitizedItems,
    });
  } catch (err) {
    console.error('Start exam error:', err);
    res.status(500).json({ error: 'Failed to start exam' });
  }
});

// Ends the caller's attempt — the single endpoint behind the manual Submit
// button, every lockdown violation, time-up, AND the pagehide/beforeunload
// keepalive beacon (see useExamLockdown.js), all funneling through one
// `reason`. The UPDATE ... WHERE status = 'in_progress' claim is atomic, so
// a violation firing at the same moment as the unload beacon (or a student
// double-clicking Submit) can't double-grade — the loser just gets back
// `alreadyEnded: true` instead of an error.
const EXAM_END_REASONS = new Set([
  'manual', 'time_up', 'violation_visibility', 'violation_blur',
  'violation_fullscreen_exit', 'violation_unload',
  'violation_proctor_absence', 'violation_proctor_phone',
]);
// The two ML-proctoring reasons additionally get an exam_proctor_flags row
// (in the same shape minor flags use) so the admin timeline shows the exact
// event that ended the exam, not just the bare end_reason string.
const PROCTOR_END_REASONS = new Set(['violation_proctor_absence', 'violation_proctor_phone']);

app.post('/api/exams/:id/submit', authenticateToken, async (req, res) => {
  const examId = req.params.id;
  const { reason, answers = [], detail = null } = req.body;
  if (!EXAM_END_REASONS.has(reason)) {
    return res.status(400).json({ error: 'Invalid submit reason' });
  }

  try {
    const claimRes = await pool.query(
      `UPDATE exam_attempts SET status = 'submitted', ended_at = now(), end_reason = $1
       WHERE exam_id = $2 AND user_id = $3 AND status = 'in_progress' RETURNING id`,
      [reason, examId, req.user.userId]
    );
    if (claimRes.rows.length === 0) {
      return res.status(200).json({ alreadyEnded: true });
    }

    const attemptId = claimRes.rows[0].id;
    const itemsRes = await pool.query('SELECT * FROM exam_items WHERE exam_id = $1', [examId]);
    const score = await finalizeExamAttempt(attemptId, itemsRes.rows, answers);
    await pool.query('UPDATE exam_attempts SET score = $1 WHERE id = $2', [score, attemptId]);

    if (PROCTOR_END_REASONS.has(reason)) {
      const flagType = reason === 'violation_proctor_absence' ? 'face_absent' : 'phone_detected';
      await pool.query(
        'INSERT INTO exam_proctor_flags (attempt_id, severity, flag_type, detail) VALUES ($1, $2, $3, $4)',
        [attemptId, 'major', flagType, detail]
      );
    }

    res.status(200).json({ submitted: true });
  } catch (err) {
    console.error('Submit exam error:', err);
    res.status(500).json({ error: 'Failed to submit exam' });
  }
});

// Student's own result for one exam — whichever of the two tags are
// currently switched on platform-wide (see tag_visibility_settings), both
// per-exam and overall. Raw score is never returned here regardless of the
// toggle — that stays teacher-only, unconditionally.
app.get('/api/exams/:id/result', authenticateToken, async (req, res) => {
  const examId = req.params.id;
  try {
    const attemptRes = await pool.query(
      'SELECT id, status, score FROM exam_attempts WHERE exam_id = $1 AND user_id = $2',
      [examId, req.user.userId]
    );
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: 'No attempt found for this exam' });

    const attempt = attemptRes.rows[0];
    if (attempt.status !== 'submitted') {
      return res.status(409).json({ error: 'This exam has not been finished yet' });
    }

    const examRes = await pool.query('SELECT total_marks, closes_at FROM exams WHERE id = $1', [examId]);
    const exam = examRes.rows[0];

    // Deadline gate: don't reveal rankings while other students might
    // still be mid-exam — an early finisher shouldn't see a percentile
    // computed from a tiny, still-growing population. No closes_at means
    // no deadline to wait for at all.
    if (exam.closes_at && new Date(exam.closes_at) > new Date()) {
      return res.status(200).json({ status: 'pending', reason: 'deadline' });
    }

    const fullyGraded = await isAttemptFullyGraded(attempt.id);
    if (!fullyGraded) {
      return res.status(200).json({ status: 'pending', reason: 'grading' });
    }

    const totalMarks = exam.total_marks;
    const myPercentage = totalMarks > 0 ? (attempt.score / totalMarks) * 100 : 0;

    // Per-exam percentile, among this exam's own fully-graded population.
    // No extra deadline filter needed here — we only ever reach this line
    // once this exam's own closes_at has already passed.
    const examAttemptsRes = await pool.query(
      `SELECT a.score,
              NOT EXISTS (
                SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
                WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
              ) AS fully_graded
       FROM exam_attempts a WHERE a.exam_id = $1 AND a.status = 'submitted'`,
      [examId]
    );
    const examPercentages = totalMarks > 0
      ? examAttemptsRes.rows.filter((a) => a.fully_graded).map((a) => (a.score / totalMarks) * 100)
      : [];
    const { tag: percentileTag } = computePercentileTiers(examPercentages)(myPercentage);

    // Overall (exams) percentile: every student's average % across their
    // own fully-graded exams, but only counting exams whose OWN deadline
    // has passed — otherwise a still-open exam elsewhere would already be
    // skewing everyone's "overall" before it's actually concluded.
    const overallRes = await pool.query(
      `SELECT a.user_id, AVG(a.score::float / e.total_marks * 100) AS avg_percentage
       FROM exam_attempts a
       JOIN exams e ON e.id = a.exam_id
       WHERE a.status = 'submitted' AND e.total_marks > 0 AND e.organization_id = $1
         AND (e.closes_at IS NULL OR e.closes_at <= now())
         AND NOT EXISTS (
           SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
           WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
         )
       GROUP BY a.user_id`,
      [req.user.organizationId]
    );
    const overallPercentileFor = computePercentileTiers(overallRes.rows.map((r) => Number(r.avg_percentage)));
    const myOverall = overallRes.rows.find((r) => r.user_id === req.user.userId);
    const overallExamsPercentileTag = myOverall ? overallPercentileFor(Number(myOverall.avg_percentage)).tag : null;

    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [req.user.organizationId]);
    const gradeTag = gradeTagForPercentage(bandsRes.rows, myPercentage);

    const visibility = await getTagVisibility(req.user.organizationId);
    res.status(200).json({
      status: 'graded',
      percentileTag: visibility.show_percentile_tag ? percentileTag : undefined,
      overallExamsPercentileTag: visibility.show_percentile_tag ? overallExamsPercentileTag : undefined,
      gradeTag: visibility.show_grade_tag ? gradeTag : undefined,
    });
  } catch (err) {
    console.error('Exam result error:', err);
    res.status(500).json({ error: 'Failed to load result' });
  }
});

const PROCTOR_FLAG_SEVERITIES = new Set(['minor', 'major']);

// Logs a non-ending ML-proctoring observation (head turned, gaze away —
// things that are ambiguous on their own and shouldn't interrupt the
// exam). Major, exam-ending flags don't come through here — they go
// through POST /submit with a violation_proctor_* reason instead, which
// both ends the attempt and logs the flag in one atomic step. Silently
// no-ops if the caller has no in_progress attempt for this exam (harmless:
// either they already finished, or a stray flag arrived after the fact).
app.post('/api/exams/:id/proctor-flag', authenticateToken, async (req, res) => {
  const { severity, flagType, detail = null } = req.body;
  if (!PROCTOR_FLAG_SEVERITIES.has(severity) || !flagType) {
    return res.status(400).json({ error: 'Invalid proctor flag' });
  }

  try {
    const attemptRes = await pool.query(
      `SELECT id FROM exam_attempts WHERE exam_id = $1 AND user_id = $2 AND status = 'in_progress'`,
      [req.params.id, req.user.userId]
    );
    if (attemptRes.rows.length === 0) {
      return res.status(200).json({ logged: false });
    }

    await pool.query(
      'INSERT INTO exam_proctor_flags (attempt_id, severity, flag_type, detail) VALUES ($1, $2, $3, $4)',
      [attemptRes.rows[0].id, severity, String(flagType), detail]
    );
    res.status(200).json({ logged: true });
  } catch (err) {
    console.error('Log proctor flag error:', err);
    res.status(500).json({ error: 'Failed to log proctor flag' });
  }
});

// Admin: every attempt at one exam, with its flag counts, for the flag
// timeline viewer in the admin Exams panel.
app.get('/api/admin/exams/:id/attempts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const examRes = await pool.query('SELECT total_marks FROM exams WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
    const totalMarks = examRes.rows[0].total_marks;

    const result = await pool.query(
      `SELECT a.id, a.status, a.score, a.end_reason, a.started_at, a.ended_at, u.email,
              COUNT(f.id) FILTER (WHERE f.severity = 'minor') AS minor_flag_count,
              COUNT(f.id) FILTER (WHERE f.severity = 'major') AS major_flag_count,
              NOT EXISTS (
                SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
                WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
              ) AS fully_graded
       FROM exam_attempts a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN exam_proctor_flags f ON f.attempt_id = a.id
       WHERE a.exam_id = $1
       GROUP BY a.id, u.email
       ORDER BY a.started_at DESC`,
      [req.params.id]
    );

    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [req.user.organizationId]);
    const bands = bandsRes.rows;

    // Percentile is relative to this exam's own fully-graded population —
    // an attempt not yet fully graded isn't in the ranking pool at all
    // (its own percentage isn't final yet either).
    const gradedPercentages = totalMarks > 0
      ? result.rows.filter((a) => a.status === 'submitted' && a.fully_graded).map((a) => (a.score / totalMarks) * 100)
      : [];
    const percentileFor = computePercentileTiers(gradedPercentages);

    const attempts = result.rows.map((a) => {
      const eligible = a.status === 'submitted' && a.fully_graded && totalMarks > 0;
      const percentage = eligible ? (a.score / totalMarks) * 100 : null;
      const { tag: percentileTag } = eligible ? percentileFor(percentage) : { tag: null };
      return {
        ...a,
        percentage,
        gradeTag: eligible ? gradeTagForPercentage(bands, percentage) : null,
        percentileTag,
      };
    });

    res.status(200).json({ attempts });
  } catch (err) {
    console.error('List exam attempts error:', err);
    res.status(500).json({ error: 'Failed to load attempts' });
  }
});

// Admin: full flag timeline for one attempt.
app.get('/api/admin/exam-attempts/:attemptId/flags', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // exam_proctor_flags has no organization_id of its own — scoped
    // transitively via attempt -> exam, checked here so one org's admin
    // can't read another's flag timeline by guessing an attempt id.
    const result = await pool.query(
      `SELECT f.severity, f.flag_type, f.detail, f.created_at
       FROM exam_proctor_flags f
       JOIN exam_attempts a ON a.id = f.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE f.attempt_id = $1 AND e.organization_id = $2
       ORDER BY f.created_at ASC`,
      [req.params.attemptId, req.user.organizationId]
    );
    res.status(200).json({ flags: result.rows });
  } catch (err) {
    console.error('List proctor flags error:', err);
    res.status(500).json({ error: 'Failed to load flags' });
  }
});

// Admin: every answer in one attempt, joined with its item's prompt/marks —
// powers the grading UI (short/long) and doubles as a full answer review
// for every item type, not just the ones needing manual grading.
app.get('/api/admin/exam-attempts/:attemptId/answers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ea.id AS answer_id, ei.id AS item_id, ei.type, ei.prompt, ei.marks,
              ea.marks_awarded, ea.selected_option_id, ea.text_answer, ea.is_correct,
              ea.passed_count, ea.total_count, ea.code, ea.language
       FROM exam_answers ea
       JOIN exam_items ei ON ei.id = ea.item_id
       JOIN exam_attempts a ON a.id = ea.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE ea.attempt_id = $1 AND e.organization_id = $2
       ORDER BY ei.position ASC`,
      [req.params.attemptId, req.user.organizationId]
    );
    res.status(200).json({ answers: result.rows });
  } catch (err) {
    console.error('List exam answers error:', err);
    res.status(500).json({ error: 'Failed to load answers' });
  }
});

// Admin: manually award marks for one short/long answer. mcq/coding stay
// auto-graded — not overridable here in this pass.
app.put('/api/admin/exam-answers/:answerId/grade', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const answerRes = await pool.query(
      `SELECT ea.id, ea.attempt_id, ei.type, ei.marks
       FROM exam_answers ea
       JOIN exam_items ei ON ei.id = ea.item_id
       JOIN exam_attempts a ON a.id = ea.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE ea.id = $1 AND e.organization_id = $2`,
      [req.params.answerId, req.user.organizationId]
    );
    if (answerRes.rows.length === 0) return res.status(404).json({ error: 'Answer not found' });

    const answer = answerRes.rows[0];
    if (answer.type !== 'short' && answer.type !== 'long') {
      return res.status(400).json({ error: 'Only short/long answers can be manually graded' });
    }

    const marksAwarded = Number(req.body.marksAwarded);
    if (!Number.isFinite(marksAwarded) || marksAwarded < 0 || marksAwarded > answer.marks) {
      return res.status(400).json({ error: `Marks must be between 0 and ${answer.marks}` });
    }

    await pool.query('UPDATE exam_answers SET marks_awarded = $1 WHERE id = $2', [Math.round(marksAwarded), answer.id]);

    const scoreRes = await pool.query(
      'SELECT COALESCE(SUM(marks_awarded), 0) AS score FROM exam_answers WHERE attempt_id = $1',
      [answer.attempt_id]
    );
    const score = scoreRes.rows[0].score;
    await pool.query('UPDATE exam_attempts SET score = $1 WHERE id = $2', [score, answer.attempt_id]);

    const fullyGraded = await isAttemptFullyGraded(answer.attempt_id);
    res.status(200).json({ score, fullyGraded });
  } catch (err) {
    console.error('Grade exam answer error:', err);
    res.status(500).json({ error: 'Failed to save grade' });
  }
});

app.post('/api/problems/:id/submit', authenticateToken, async (req, res) => {
  const problemId = req.params.id;
  const { language, code } = req.body;

  if (!language || !code) {
    return res.status(400).json({ error: 'Language and code are required' });
  }
  if (!LANGUAGE_CONFIG[language]) {
    return res.status(400).json({ error: 'Unsupported language' });
  }

  try {
    const problemRes = await pool.query('SELECT opens_at, closes_at FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });

    const status = getProblemStatus(problemRes.rows[0]);
    if (status !== 'open' && req.user.role !== 'admin') {
      return res.status(403).json({
        error: status === 'upcoming' ? 'This assignment is not open yet' : 'This assignment is closed',
      });
    }

    const testCasesRes = await pool.query(
      'SELECT id, input, expected_output, is_hidden FROM test_cases WHERE problem_id = $1 ORDER BY id ASC',
      [problemId]
    );
    const testCases = testCasesRes.rows;

    if (testCases.length === 0) {
      return res.status(404).json({ error: 'No test cases found for this problem' });
    }

    let passedCount = 0;
    let verdict = 'Accepted';
    let failedCase = null;

    // Run sequentially and stop at the first failure â€” mirrors how most judges behave on Submit
    for (const testCase of testCases) {
      const result = await executeInSandbox(language, code, testCase.input);

      if (!result.success) {
        verdict = result.timedOut ? 'Time Limit Exceeded' : 'Runtime Error';
        failedCase = { ...testCase, actualOutput: null, errorMessage: result.error };
        break;
      }

      if (normalizeOutput(result.output) === normalizeOutput(testCase.expected_output)) {
        passedCount += 1;
      } else {
        verdict = 'Wrong Answer';
        failedCase = { ...testCase, actualOutput: result.output };
        break;
      }
    }

    await pool.query(
      `INSERT INTO submissions (user_id, problem_id, language, code, status, passed_count, total_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.userId, problemId, language, code, verdict, passedCount, testCases.length]
    );

    const response = { verdict, passed: passedCount, total: testCases.length };

    if (failedCase) {
      // Only reveal the actual input/output if the failing case was a visible sample â€”
      // hidden cases stay hidden even on failure, same as a real judge
      response.failedCase = failedCase.is_hidden
        ? { hidden: true }
        : {
            input: failedCase.input,
            expectedOutput: failedCase.expected_output,
            actualOutput: failedCase.actualOutput,
            error: failedCase.errorMessage || null,
          };
    }

    res.status(200).json(response);
  } catch (err) {
    console.error('Submission error:', err);
    res.status(500).json({ error: 'Failed to grade submission' });
  }
});

// Accumulates real time-on-task for one (student, problem) pair. The
// frontend calls this repeatedly with small deltas — on heartbeat, on the
// tab going background, and on the page actually closing — rather than once
// with a total, so a crashed tab or a closed laptop lid never loses more
// than one heartbeat interval's worth of time. Deliberately NOT gated on the
// assignment's open/closed window: time still counts if a student revisits
// a closed assignment, and repeat visits keep adding to the same total.
app.post('/api/problems/:id/time-log', authenticateToken, async (req, res) => {
  const problemId = req.params.id;
  const seconds = Number(req.body?.seconds);

  // Nothing to record (0, negative, missing, or NaN) isn't an error — the
  // tab may have been hidden the whole interval. Just acknowledge it.
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return res.status(200).json({ ok: true });
  }

  // Clamp each individual delta so a stale/suspended tab waking up (or a
  // tampered client) can't inflate a student's tracked time in one call —
  // this is well above the heartbeat interval the frontend actually uses.
  const clamped = Math.min(Math.round(seconds), 300);

  try {
    const problemRes = await pool.query('SELECT id FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });

    await pool.query(
      `INSERT INTO problem_time_logs (user_id, problem_id, total_seconds)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, problem_id)
       DO UPDATE SET total_seconds = problem_time_logs.total_seconds + EXCLUDED.total_seconds,
                     updated_at = now()`,
      [req.user.userId, problemId, clamped]
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Time log error:', err);
    res.status(500).json({ error: 'Failed to log time' });
  }
});


// child_process interactions (closed pipes, unexpected signals, timing races)
// are inherently more prone to unforeseen edge cases than typical API code.
// Without this, ANY single uncaught error anywhere â€” not just in the sandbox
// â€” kills the entire Node process and takes every student's session down
// with it, possibly mid-deadline. Logging and staying alive is far safer
// than the default "crash the whole server" behavior for this kind of app.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stayed alive):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server stayed alive):', err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AssignMeant API running on http://localhost:${PORT}`);
});
