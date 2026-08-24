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
const { sendEmail } = require('./mailer');
const { exec } = require('child_process');
const path = require('path');
const multer = require('multer');
const archiver = require('archiver');
const { isB2Configured, scanObjectKey, examScanObjectKey, notesObjectKey, noticesObjectKey, uploadScanPdf, deleteScanPdf, getScanPdfUrl, downloadScanPdf } = require('./storage');
const { isOcrConfigured, runOcr } = require('./ocrClient');
const { isGroqConfigured, assessAnswers } = require('./aiGrading');
const { parse: parseCsv } = require('csv-parse/sync');
const Razorpay = require('razorpay');

// In-memory only — CSV rosters are realistically tens to low-thousands of
// rows, never large enough to need disk storage or a streaming parser. 2MB
// cap is generous for a plain-text student roster.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Memory storage (not disk) — a scanned answer-sheet PDF is uploaded once,
// immediately forwarded to R2, then discarded; there's nothing to stream to
// disk for. 25MB covers a realistically long multi-page handwritten answer
// scanned at phone-camera resolution.
const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});

// Same shape as scanUpload — memory storage, forwarded to B2 then discarded
// — but this one backs every file-based note type (pdf/image/video/audio),
// not just PDFs, so there's no single mimetype to gate on here; the actual
// per-type mimetype check happens in the route itself once req.body.type is
// available (multer's fileFilter only sees fields that arrived on the wire
// before the file part, which the frontend can't be relied on to guarantee).
// 200MB covers a realistically long lecture-recording video, the largest
// file type this accepts — B2's 10GB free tier absorbs a modest number of
// these before it becomes a real capacity concern.
const notesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const app = express();
// Without this, req.ip (what rateLimiter.js keys every limit on) is always
// the DIRECT TCP peer — which, once this sits behind the nginx load
// balancer in docker-compose.yml/nginx.conf, is nginx's own container IP
// on every single request, for every user. That collapses every visitor
// into one shared rate-limit bucket: one busy legitimate user can lock
// everyone else out, and an attacker gets the SAME 10-attempts-per-15-min
// budget as the entire rest of the platform combined instead of their own.
// `1` trusts exactly one hop — the immediate connecting proxy — matching
// this deployment's actual topology (browser -> nginx -> this app, nothing
// else in between). Express then reads the real client IP as the last
// entry nginx's own $proxy_add_x_forwarded_for appended, and does NOT
// trust anything further back that a client could have forged in an
// X-Forwarded-For header of their own. Harmless with no proxy in front
// (e.g. hitting this directly on localhost in dev) — there's simply
// nothing at that one trusted hop to read a header from, so req.ip falls
// back to the direct connection either way.
app.set('trust proxy', 1);
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
  origin: ['http://localhost:5173', 'https://pandadsgn.github.io'],
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
// pg doesn't reject Neon's cert chain. But a plain self-hosted Postgres (the
// docker-compose `db` service, or Postgres running directly on a box you
// control) typically has SSL off entirely, and pg's client-side `ssl`
// option isn't negotiable the way sslmode=prefer would be — passing it at
// all makes the client demand SSL and fail outright ("the server does not
// support SSL connections") against one that doesn't offer it. DB_SSL
// defaults to "true" so every existing deployment (Neon) is unaffected;
// set DB_SSL=false for a target that doesn't speak TLS at all.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  // Bounds how many concurrent DB connections one instance can open — with
  // no cap, a burst of concurrent requests would each grab a client and a
  // slow/locked query could exhaust Postgres's own max_connections across
  // every horizontally-scaled replica combined. 20 is pg's own client
  // default; set explicitly so it's a deliberate, visible number rather
  // than an implicit one.
  max: Number(process.env.DB_POOL_MAX) || 20,
});
// node-postgres's own documented gotcha: an idle pooled client can emit an
// 'error' event on its own (the server closed the connection, a network
// blip) with no query in flight to catch it. Pool is an EventEmitter, and
// an EventEmitter with zero listeners on an 'error' event rethrows it as an
// uncaught exception — which crashes the entire Node process instantly,
// taking down every in-flight request on this instance. This listener is
// the difference between "one bad connection logs a warning" and "the
// whole server falls over"; see the 429/503-not-crashes goal this whole
// pass exists for.
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

// Health check for the load balancer (nginx) and Docker's own healthcheck
// directive — see docker-compose.yml. Deliberately registered before the
// rate limiter and load guard below: an infrastructure check hitting this
// every few seconds from every replica shouldn't compete with real traffic
// for the same rate-limit budget, and a health check is exactly the signal
// that should keep working even while the instance is shedding load via
// dbLoadGuard. Actually queries the DB rather than just returning 200
// unconditionally — a process that's alive but can't reach Postgres is not
// healthy, and the load balancer needs to know to route around it.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(503).json({ status: 'unhealthy' });
  }
});

// Circuit breaker for real DB overload, not just a single slow query — if
// every pooled connection is already checked out AND requests are already
// queuing up behind the pool waiting for one to free, a fresh request
// piling on top only makes the backlog worse and eventually times out
// anyway. Short-circuiting to 503 here means an overloaded instance sheds
// load predictably (and fast — no query attempted, no wait) instead of
// every route's own individual query eventually timing out into a slow
// 500, or worse, requests queuing until the process falls over. Threshold
// is proportional to pool size, not a fixed number, so it scales with
// DB_POOL_MAX. Applied globally via app.use, not per-route, since every
// route shares the same one pool.
function dbLoadGuard(req, res, next) {
  const waitThreshold = Math.max(5, pool.options.max);
  if (pool.waitingCount >= waitThreshold) {
    res.set('Retry-After', '2');
    return res.status(503).json({ error: 'Service is temporarily overloaded — please retry in a moment.' });
  }
  next();
}
app.use(dbLoadGuard);

// See rateLimiter.js for why these are built as always-on middleware from
// the start (in-memory) rather than waiting on an async Redis connection.
// authLimiter's path-prefix match covers /api/login, .../select-organization,
// and .../accept-tos in one line — all three are steps of the same login
// flow and belong behind the same, much tighter, brute-force ceiling than
// the rest of the API gets from globalLimiter below.
const { globalLimiter, authLimiter, connectRedisAndUpgradeStores } = require('./rateLimiter');
const { cached, invalidate } = require('./cache');
app.use('/api/login', authLimiter);
app.use('/api/organizations/signup', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/reset-password', authLimiter);
app.use('/api/contact', authLimiter);
app.use(globalLimiter);
connectRedisAndUpgradeStores();

// Every ensureXSchema() function below is memoized (its own cached
// xSchemaPromise) and most explicitly `await` the specific other schema
// functions their own CREATE TABLE/ALTER TABLE references — but the ~40
// bare `ensureXSchema();` trigger calls that actually KICK OFF that whole
// graph at the bottom of each function are fired independently, all at
// once, the instant this file loads. Against the real production
// database that's always been harmless (every table already exists, so
// nearly every one of these is an instant no-op) — but against a
// genuinely empty Postgres (a fresh deploy, this repo's own
// docker-compose `db` service) it isn't: two unrelated CREATE TABLEs
// running concurrently can still deadlock on Postgres's own catalog locks
// even when neither depends on the other, and any dependency edge that
// isn't explicitly awaited races for real. bootSchemaStep queues every
// trigger call to run strictly one at a time, in the order it's called —
// which is already the order the file defines them in, i.e. already
// dependency order by construction (a table's own ensureXSchema always
// appears before the first thing that ALTERs or references it). That
// turns the ordering this file's authors clearly intended, but never
// actually enforced, into something that's really true.
let bootSchemaQueue = Promise.resolve();
function bootSchemaStep(fn) {
  bootSchemaQueue = bootSchemaQueue.then(() => fn()).catch((err) => console.error('Schema boot step failed:', err));
  return bootSchemaQueue;
}

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
// Real INR pricing — annualPaise is a flat 10x monthlyPaise (two months
// free) across every tier, same discount shape for all of them. Per-student
// cost declines with tier size (₹6.66 → ₹6.00 → ₹4.00 → ₹3.00 per student/
// month), the usual SaaS volume curve. Anything past 'scale' isn't a
// self-serve checkout at all — see the custom-quote route further down,
// which is what the frontend's "Custom" card actually links to.
const PLAN_CATALOG = {
  free:        { label: 'Free',        studentCap: 30,    monthlyPaise: 0,       annualPaise: 0        },
  starter:     { label: 'Starter',     studentCap: 150,   monthlyPaise: 99900,   annualPaise: 999000   },
  growth:      { label: 'Growth',      studentCap: 500,   monthlyPaise: 299900,  annualPaise: 2999000  },
  institution: { label: 'Institution', studentCap: 2000,  monthlyPaise: 799900,  annualPaise: 7999000  },
  scale:       { label: 'Scale',       studentCap: 10000, monthlyPaise: 2999900, annualPaise: 29999000 },
};
const PAID_PLAN_KEYS = ['starter', 'growth', 'institution', 'scale'];
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

// Lazily constructed — RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET don't exist yet
// in this deploy (test-mode keys are still being set up), so this can't be
// built at module load like most other external clients in this file
// (compare to getGmailClient()/getB2Client(), each lazily built the same
// way for the same reason). Returns null — never
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
    item: { name: `HonorRoll ${plan.label} (${billingCycle})`, amount, currency: 'INR' },
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
async function findOrCreateGlobalUser(client, email, name = null) {
  const trimmedName = name ? String(name).trim() : null;
  const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    // Backfill only — never overwrite a name someone already has with a
    // blank/different one from a later import; just fills the gap for an
    // identity that was created (e.g. via create-student) before a name
    // was ever supplied for them.
    if (trimmedName) {
      await client.query('UPDATE users SET name = $1 WHERE id = $2 AND name IS NULL', [trimmedName, existing.rows[0].id]);
    }
    return { userId: existing.rows[0].id, isNew: false, temporaryPassword: null };
  }
  const rawPassword = generateRandomPassword();
  const hashedPassword = await bcrypt.hash(rawPassword, 10);
  const inserted = await client.query(
    'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
    [email, hashedPassword, trimmedName]
  );
  return { userId: inserted.rows[0].id, isNew: true, temporaryPassword: rawPassword };
}

// One shared welcome-email template for every path that provisions a
// brand-new student identity (single admin create-student, CSV import, the
// Google Form webhook) — previously each hand-rolled its own copy, and one
// of the three (create-student) simply never sent an email at all, leaving
// the admin to relay the temporary password to the student out-of-band
// themselves. Names the signing-up institution explicitly: since `users`
// is a single global identity shared across every org that email belongs
// to, a student receiving this out of the blue has no other way to know
// which school/college just created it for them.
async function sendStudentWelcomeEmail(email, name, organizationName, temporaryPassword) {
  const { error } = await sendEmail({
    to: email,
    subject: 'Your HonorRoll Account Credentials',
    text: `Hello ${name || 'Student'},\n\n${organizationName} has set up your HonorRoll account.\n\nYour temporary password is: ${temporaryPassword}\n\nLogin via ${FRONTEND_URL}\n\nPlease log in and change your password after logging in.`,
  });
  if (error) console.error(`Welcome email failed to send to ${email}:`, error);
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

// Validates the optional per-assignment plagiarism threshold override sent
// from AssignmentForm — same "'', null, undefined all mean unset" idiom as
// normalizeTimeLimitSeconds above, falling back to the org-wide
// organizations.scan_plagiarism_threshold when left blank (see
// runTextPlagiarismComparator/runTypedTextPlagiarismComparator). Range
// matches the org-wide setting's own PUT route (0-1, a raw similarity
// fraction, not a percentage).
function normalizePlagiarismThreshold(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error('Plagiarism threshold must be a number between 0 and 1, or left blank to use the organization default');
  }
  return n;
}

const EXAM_ITEM_TYPES = new Set(['mcq', 'short', 'long', 'coding', 'scan']);

// Validates + normalizes one item from the exam builder's payload, returning
// a clean object ready to insert. Throws a message naming the offending item
// (1-indexed, matching what the admin sees on screen), which the route
// handlers turn straight into a 400 — so a bad MCQ buried in item #7 doesn't
// just come back as a generic "bad request".
function normalizeExamItem(raw, index) {
  const label = `Item ${index + 1}`;
  if (!raw || !EXAM_ITEM_TYPES.has(raw.type)) {
    throw new Error(`${label}: type must be one of mcq, short, long, coding, scan`);
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

  if (raw.type === 'scan') {
    const prompt = String(raw.prompt || '').trim();
    if (!prompt) throw new Error(`${label}: question text is required`);
    return { ...base, prompt, options: null, correctOptionId: null, wordLimit: null, problemId: null, starterCode: null, testCases: null };
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

// Scan-mode assignments reuse normalizeExamItem's validation wholesale
// (same mcq/short/long/coding/scan shape as exam_items) but never allow
// coding's "reuse an existing assignment" mode — nesting one assignment
// inside another has no clear meaning, and scan_assignment_questions has
// no problem_id column to hold that reference even if it did. Also drops
// timeLimitSeconds, which scan assignments don't have a per-question slot
// for (only the whole assignment's own time_limit_seconds applies).
function normalizeScanAssignmentQuestion(raw, index) {
  const item = normalizeExamItem(raw, index);
  if (item.type === 'coding' && item.problemId != null) {
    throw new Error(`Item ${index + 1}: coding questions in assignments must be written inline, not reused from an existing assignment`);
  }
  return item;
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
    // A tos-pending token (see mintTosPendingToken) DOES carry a full
    // role/organizationId/orgUnitId claim set — unlike preauth, it would
    // otherwise pass through here as if it were a real session token,
    // letting someone use it directly on real routes and skip accepting
    // the Terms of Service/Privacy Policy entirely. Must never reach here.
    if (payload.type === 'tos-pending') {
      return res.status(401).json({ error: 'Login not complete — accept the Terms of Service to continue' });
    }
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Lets a superadmin's own session act with full admin authority for one
// specific org — see SuperadminDashboard's click-the-org-name flow. Unlike
// the old impersonate-and-swap-tokens approach, the superadmin's real
// session token is never touched; the frontend instead sends an
// X-Organization-Id header on every request while "viewing" that org, and
// this mutates req.user in place (organizationId + role) to match what a
// real admin token for that org would carry. Every route behind
// requireAdmin/requireAdminOrTeacher reads req.user.organizationId and
// req.user.role, so this one function is what makes the entire existing
// admin surface (structure, students, billing, problems, exams, ...) work
// for a superadmin caller with no per-route changes. Returns false (leaving
// req.user untouched) for anyone who isn't a superadmin, or a superadmin
// request missing the header — the caller's own role check then reports
// the usual 403.
function applySuperadminOrgOverride(req) {
  if (req.user?.role !== 'superadmin') return false;
  const orgId = Number(req.headers['x-organization-id']);
  if (!orgId) return false;
  req.user.organizationId = orgId;
  req.user.orgUnitId = null;
  req.user.role = 'admin';
  return true;
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin' && !applySuperadminOrgOverride(req)) {
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
  if (req.user?.role !== 'admin' && req.user?.role !== 'teacher' && !applySuperadminOrgOverride(req)) {
    return res.status(403).json({ error: 'Admin or teacher access required' });
  }
  next();
}

// Platform-owner allowlist — a handful of real people, not a role anyone
// can be granted through the app itself (no UI/route ever sets this; it's
// env-config only, same "no sane default for a secret" posture as
// JWT_SECRET). Checked once, at login time, against the account's email —
// see POST /api/login's zero-membership branch, which is what actually
// mints a role:'superadmin' token for a matching email. requireSuperadmin
// below just trusts that already-signed claim; it does no allowlist lookup
// of its own; a leaked normal admin/teacher/student token can never
// satisfy it since none of those roles are ever the string 'superadmin'.
function getSuperadminEmails() {
  return (process.env.SUPERADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function requireSuperadmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
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

// ============================================================================
// Teacher dashboard helpers — every subject a teacher is assigned to, and
// every student "under" them (their subjects' own org_unit, and every unit
// beneath it), the same tier-cascades-down rule GET /api/teacher/non-
// submitters already uses, factored out here so the fuller teacher
// dashboard routes below can share it instead of re-deriving it. Mirrors
// getVisibleSubjectIds() above but walks the tree the other way: that one
// walks a student's unit UP toward subjects, this walks a teacher's
// subjects DOWN toward students.
// ============================================================================
async function getTeacherScope(userId, organizationId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE my_subjects AS (
       SELECT s.id AS subject_id, s.org_unit_id
       FROM subjects s
       JOIN subject_teachers st ON st.subject_id = s.id
       WHERE st.user_id = $1 AND s.organization_id = $2
     ),
     descendant_units AS (
       SELECT id FROM org_units WHERE id IN (SELECT org_unit_id FROM my_subjects)
       UNION
       SELECT ou.id FROM org_units ou JOIN descendant_units d ON ou.parent_unit_id = d.id
     )
     SELECT
       COALESCE((SELECT array_agg(DISTINCT subject_id) FROM my_subjects), '{}') AS subject_ids,
       COALESCE((SELECT array_agg(id) FROM descendant_units), '{}') AS unit_ids`,
    [userId, organizationId]
  );
  return { subjectIds: rows[0].subject_ids, unitIds: rows[0].unit_ids };
}

async function getTeacherScopedStudents(organizationId, unitIds) {
  if (unitIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.created_at, m.org_unit_id
     FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $1 AND m.role = 'student'
     WHERE m.org_unit_id = ANY($2::int[])
     ORDER BY u.email ASC`,
    [organizationId, unitIds]
  );
  return rows;
}

// Per-student, per-problem status/percent for a given set of assignments —
// code-mode (auto-judged test cases) and scan-mode (teacher-awarded marks,
// possibly mixed item types — see scan_assignment_questions' own comment)
// are scored on different raw scales, so both are normalized to a 0-100
// percent before being handed back, letting callers treat them uniformly.
// status is 'not_submitted' (no row at all — the default when a problem id
// is simply absent from a student's map), 'pending_grading' (submitted but
// not fully marked yet), or 'graded' (percent is final).
//
// Takes the already-resolved `problems` list ([{id, submission_mode}, ...])
// rather than resolving it itself — callers scope "which assignments count"
// very differently (a teacher's own subject_teachers link vs. a student's
// getVisibleSubjectIds visibility), so that resolution query belongs to the
// caller, not this shared scoring logic.
async function getAssignmentPerformance(problems, studentIds) {
  const codeIds = problems.filter((p) => p.submission_mode === 'code').map((p) => p.id);
  const scanIds = problems.filter((p) => p.submission_mode === 'scan').map((p) => p.id);

  const byUser = new Map(studentIds.map((id) => [id, new Map()]));

  if (codeIds.length && studentIds.length) {
    const r = await pool.query(
      `SELECT DISTINCT ON (s.user_id, s.problem_id) s.user_id, s.problem_id, s.passed_count, s.total_count
       FROM submissions s
       WHERE s.problem_id = ANY($1::int[]) AND s.user_id = ANY($2::uuid[])
       ORDER BY s.user_id, s.problem_id, (s.status = 'Accepted') DESC, s.passed_count DESC, s.created_at DESC`,
      [codeIds, studentIds]
    );
    r.rows.forEach((row) => {
      const pct = row.total_count > 0 ? (row.passed_count / row.total_count) * 100 : null;
      byUser.get(row.user_id)?.set(row.problem_id, { status: 'graded', pct });
    });
  }

  if (scanIds.length && studentIds.length) {
    const r = await pool.query(
      `SELECT ss.user_id, ss.problem_id,
              SUM(q.marks) AS max_marks,
              SUM(sa.marks_awarded) AS awarded,
              BOOL_AND(sa.marks_awarded IS NOT NULL) AS fully_graded
       FROM scan_submissions ss
       JOIN scan_assignment_questions q ON q.problem_id = ss.problem_id
       LEFT JOIN scan_submission_answers sa ON sa.submission_id = ss.id AND sa.question_id = q.id
       WHERE ss.problem_id = ANY($1::int[]) AND ss.user_id = ANY($2::uuid[])
       GROUP BY ss.user_id, ss.problem_id`,
      [scanIds, studentIds]
    );
    r.rows.forEach((row) => {
      const fullyGraded = row.fully_graded === true;
      const maxMarks = Number(row.max_marks);
      const pct = fullyGraded && maxMarks > 0 ? (Number(row.awarded) / maxMarks) * 100 : null;
      byUser.get(row.user_id)?.set(row.problem_id, { status: fullyGraded ? 'graded' : 'pending_grading', pct });
    });
  }

  return { problems, byUser };
}

// Same shape as getAssignmentPerformance above, for exams. Exams already
// normalize mixed item types into one score/total_marks pair (see
// recomputeExamAttemptScore), so there's no code/scan split to handle here
// — just the submitted + fully-graded gate every other exam-result route
// already uses (see GET /api/exams/:id/result). Takes an already-resolved
// `exams` list ([{id, total_marks}, ...]) for the same reason
// getAssignmentPerformance takes a resolved `problems` list.
async function getExamPerformance(exams, studentIds) {
  const examIds = exams.map((e) => e.id);

  const byUser = new Map(studentIds.map((id) => [id, new Map()]));

  if (examIds.length && studentIds.length) {
    const r = await pool.query(
      `SELECT a.user_id, a.exam_id, a.status, a.score, e.total_marks,
              NOT EXISTS (
                SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
                WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
              ) AND NOT EXISTS (
                SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = a.id AND esa.marks_awarded IS NULL
              ) AS fully_graded
       FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.exam_id = ANY($1::int[]) AND a.user_id = ANY($2::uuid[])`,
      [examIds, studentIds]
    );
    r.rows.forEach((row) => {
      let status;
      let pct = null;
      if (row.status !== 'submitted') {
        status = 'in_progress';
      } else if (!row.fully_graded) {
        status = 'pending_grading';
      } else {
        status = 'graded';
        pct = row.total_marks > 0 ? (row.score / row.total_marks) * 100 : null;
      }
      byUser.get(row.user_id)?.set(row.exam_id, { status, pct });
    });
  }

  return { exams, byUser };
}

function averagePercent(entries) {
  const pcts = [...entries.values()].filter((v) => v.pct != null).map((v) => v.pct);
  return pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
}

// Resolves "which assignments/exams count" for the teacher dashboard: every
// problem/exam attached to one of the teacher's own subjects, regardless of
// opens_at/closes_at (a teacher managing their own class should see
// everything they've set, upcoming included — unlike the student-facing
// resolver below, which excludes upcoming items a student could never have
// acted on yet).
async function getSubjectScopedAssignmentsAndExams(organizationId, subjectIds) {
  if (subjectIds.length === 0) return { problems: [], exams: [] };
  const [problemsRes, examsRes] = await Promise.all([
    pool.query('SELECT id, submission_mode FROM problems WHERE organization_id = $1 AND subject_id = ANY($2::int[])', [organizationId, subjectIds]),
    pool.query('SELECT id, total_marks FROM exams WHERE organization_id = $1 AND subject_id = ANY($2::int[])', [organizationId, subjectIds]),
  ]);
  return { problems: problemsRes.rows, exams: examsRes.rows };
}

// Every student "under" a single subject — same cascade-down rule as
// getTeacherScope's descendant_units CTE, just seeded from one subject's
// org_unit instead of a teacher's whole assigned set. Shared by the
// gradebook and class-leaderboard routes below.
async function getStudentsForSubject(organizationId, subjectId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE descendant_units AS (
       SELECT org_unit_id AS id FROM subjects WHERE id = $1 AND organization_id = $2
       UNION
       SELECT ou.id FROM org_units ou JOIN descendant_units d ON ou.parent_unit_id = d.id
     )
     SELECT u.id, u.email, u.name
     FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2 AND m.role = 'student'
     WHERE m.org_unit_id IN (SELECT id FROM descendant_units)
     ORDER BY u.email ASC`,
    [subjectId, organizationId]
  );
  return rows;
}

// Resolves "which assignments/exams count" for one student in one org, for
// the cross-institution performance dashboard (GET /api/me/performance*
// below) — the same subject-visibility rule GET /api/problems already
// applies (subject_id NULL, or attached to the student's own unit or an
// ancestor of it, via getVisibleSubjectIds), plus excluding anything still
// 'upcoming' since a student could never have acted on those yet.
async function getStudentScopedAssignmentsAndExams(organizationId, orgUnitId) {
  const visibleSubjectIds = await getVisibleSubjectIds(orgUnitId);
  const [problemsRes, examsRes] = await Promise.all([
    pool.query(
      `SELECT id, submission_mode FROM problems
       WHERE organization_id = $1 AND (subject_id IS NULL OR subject_id = ANY($2::int[]))
         AND (opens_at IS NULL OR opens_at <= now())`,
      [organizationId, visibleSubjectIds]
    ),
    pool.query(
      `SELECT id, total_marks FROM exams
       WHERE organization_id = $1 AND (subject_id IS NULL OR subject_id = ANY($2::int[]))
         AND (opens_at IS NULL OR opens_at <= now())`,
      [organizationId, visibleSubjectIds]
    ),
  ]);
  return { problems: problemsRes.rows, exams: examsRes.rows };
}

// Same average-of-percents averagePercent already does, plus an extra flat
// array of percents blended in — used everywhere a live per-item Map
// (assignment/exam performance) needs to be combined with imported
// legacy_scores rows, which aren't tied to any real problem/exam id so
// they can't live in that Map in the first place.
function averagePercentWithExtra(entries, extra) {
  const pcts = [...entries.values()].filter((v) => v.pct != null).map((v) => v.pct);
  extra.forEach((v) => { if (v != null) pcts.push(Number(v)); });
  return pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
}

// Every student in the org, with their own visibility-scoped total
// assignment/exam percentage — computed exactly the same way one student's
// own GET /api/me/performance/:organizationId computes their own number
// (getStudentScopedAssignmentsAndExams above, blended with their own
// legacy_scores rows the same way that route does), so a student's
// percentile rank is always apples-to-apples with the individual number
// shown right next to it. Two students in the same org_unit necessarily
// share the same visible subjects (getVisibleSubjectIds depends only on
// org_unit_id), so grouping by unit lets every member of a group share one
// resolved problems/exams list instead of resolving it once per student.
async function getStudentScopedTotalsForOrg(organizationId) {
  const [studentsRes, legacyRes] = await Promise.all([
    pool.query(
      `SELECT u.id, m.org_unit_id FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE m.organization_id = $1 AND m.role = 'student'`,
      [organizationId]
    ),
    pool.query('SELECT user_id, assignment_score_percent, exam_score_percent FROM legacy_scores WHERE organization_id = $1', [organizationId]),
  ]);

  const legacyByUser = new Map();
  legacyRes.rows.forEach((row) => {
    if (!legacyByUser.has(row.user_id)) legacyByUser.set(row.user_id, { assignment: [], exam: [] });
    const bucket = legacyByUser.get(row.user_id);
    if (row.assignment_score_percent != null) bucket.assignment.push(row.assignment_score_percent);
    if (row.exam_score_percent != null) bucket.exam.push(row.exam_score_percent);
  });

  const byUnit = new Map();
  studentsRes.rows.forEach((s) => {
    const key = s.org_unit_id ?? -1;
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push(s.id);
  });

  const totals = new Map();
  for (const [key, studentIds] of byUnit) {
    const orgUnitId = key === -1 ? null : key;
    const { problems, exams } = await getStudentScopedAssignmentsAndExams(organizationId, orgUnitId);
    const [{ byUser: aByUser }, { byUser: eByUser }] = await Promise.all([
      getAssignmentPerformance(problems, studentIds),
      getExamPerformance(exams, studentIds),
    ]);
    studentIds.forEach((id) => {
      const legacy = legacyByUser.get(id) || { assignment: [], exam: [] };
      totals.set(id, {
        avgAssignmentPercent: averagePercentWithExtra(aByUser.get(id) || new Map(), legacy.assignment),
        avgExamPercent: averagePercentWithExtra(eByUser.get(id) || new Map(), legacy.exam),
      });
    });
  }
  return totals;
}

// Percentile/grade tags for one student's own avgAssignmentPercent/
// avgExamPercent within one org — gated by that org's own tag_visibility_
// settings (the same admin-configured show_percentile_tag/show_grade_tag
// flags every other percentile/grade tag in this app already respects, not
// a new per-teacher setting). Population comes from getStudentScopedTotalsForOrg
// so it's apples-to-apples with how the student's own number was computed.
async function getPercentileAndGradeTags(organizationId, myAvgAssignment, myAvgExam) {
  const result = { assignmentPercentileTag: null, examPercentileTag: null, assignmentGradeTag: null, examGradeTag: null };
  const visibility = await getTagVisibility(organizationId);
  if (!visibility.show_percentile_tag && !visibility.show_grade_tag) return result;

  if (visibility.show_percentile_tag) {
    const populationTotals = await getStudentScopedTotalsForOrg(organizationId);
    const assignmentPop = [...populationTotals.values()].map((t) => t.avgAssignmentPercent).filter((v) => v != null);
    const examPop = [...populationTotals.values()].map((t) => t.avgExamPercent).filter((v) => v != null);
    if (myAvgAssignment != null && assignmentPop.length > 1) result.assignmentPercentileTag = computePercentileTiers(assignmentPop)(myAvgAssignment).tag;
    if (myAvgExam != null && examPop.length > 1) result.examPercentileTag = computePercentileTiers(examPop)(myAvgExam).tag;
  }
  if (visibility.show_grade_tag) {
    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [organizationId]);
    if (myAvgAssignment != null) result.assignmentGradeTag = gradeTagForPercentage(bandsRes.rows, myAvgAssignment);
    if (myAvgExam != null) result.examGradeTag = gradeTagForPercentage(bandsRes.rows, myAvgExam);
  }
  return result;
}

// Resolves EVERY problem/exam in the org, no subject filter — the admin
// dashboard's "total score" is deliberately org-wide across every subject,
// unlike the teacher dashboard (subject_teachers-scoped) or the student
// dashboard (visibility-scoped) resolvers above.
async function getOrgWideAssignmentsAndExams(organizationId) {
  const [problemsRes, examsRes] = await Promise.all([
    pool.query('SELECT id, submission_mode FROM problems WHERE organization_id = $1', [organizationId]),
    pool.query('SELECT id, total_marks FROM exams WHERE organization_id = $1', [organizationId]),
  ]);
  return { problems: problemsRes.rows, exams: examsRes.rows };
}

// Each student's total assignment/exam score for the (simplified) admin
// dashboard — blends live platform data (getAssignmentPerformance/
// getExamPerformance, org-wide across every subject) with any imported
// legacy_scores rows for years before this platform was in use. Each
// legacy row's assignment_score_percent/exam_score_percent counts as one
// more data point in the same average a live graded assignment/exam would,
// rather than being shown as a separate number — "total score" means the
// student's whole history, not just what happened on this platform.
// Promoting a student to a new org_unit (see POST /api/admin/org-units/
// :fromUnitId/promote) never has to touch anything here: submissions,
// exam_attempts, and legacy_scores all key off user_id, not org_unit.
async function getTotalScores(organizationId, studentIds) {
  const { problems, exams } = await getOrgWideAssignmentsAndExams(organizationId);
  const [{ byUser: assignmentByUser }, { byUser: examByUser }, legacyRes] = await Promise.all([
    getAssignmentPerformance(problems, studentIds),
    getExamPerformance(exams, studentIds),
    studentIds.length
      ? pool.query('SELECT user_id, assignment_score_percent, exam_score_percent FROM legacy_scores WHERE organization_id = $1 AND user_id = ANY($2::uuid[])', [organizationId, studentIds])
      : { rows: [] },
  ]);

  const legacyByUser = new Map(studentIds.map((id) => [id, []]));
  legacyRes.rows.forEach((row) => legacyByUser.get(row.user_id)?.push(row));

  const totals = new Map();
  studentIds.forEach((id) => {
    const aPcts = [...(assignmentByUser.get(id) || new Map()).values()].filter((v) => v.pct != null).map((v) => v.pct);
    const ePcts = [...(examByUser.get(id) || new Map()).values()].filter((v) => v.pct != null).map((v) => v.pct);
    (legacyByUser.get(id) || []).forEach((row) => {
      if (row.assignment_score_percent != null) aPcts.push(Number(row.assignment_score_percent));
      if (row.exam_score_percent != null) ePcts.push(Number(row.exam_score_percent));
    });
    totals.set(id, {
      totalAssignmentPercent: aPcts.length ? aPcts.reduce((a, b) => a + b, 0) / aPcts.length : null,
      totalExamPercent: ePcts.length ? ePcts.reduce((a, b) => a + b, 0) / ePcts.length : null,
    });
  });
  return totals;
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
// out which columns are Name/Email/Roll and returns the rest in their
// original left-to-right order — that order IS the tier chain, top to
// bottom. Roll is optional (most rosters won't have it) — a header without
// it just leaves rollKey null and every caller already treats a missing
// identity column as "nothing to write," same as Name always has.
function splitTierAndIdentityColumns(headerKeys) {
  let nameKey = null;
  let emailKey = null;
  let rollKey = null;
  const tierKeys = [];
  for (const key of headerKeys) {
    const normalized = key.trim().toLowerCase();
    if (normalized === 'name' && nameKey === null) nameKey = key;
    else if (normalized === 'email' && emailKey === null) emailKey = key;
    else if ((normalized === 'roll' || normalized === 'roll number' || normalized === 'roll no') && rollKey === null) rollKey = key;
    else tierKeys.push(key);
  }
  return { nameKey, emailKey, rollKey, tierKeys };
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
// grading those is a manual-review feature that doesn't exist yet. scan
// items never appear in `answers` at all (they're answered on paper, not
// through the on-screen form) — POST /api/exams/:id/submit handles those
// separately via the compiled PDF and exam_scan_answers, not here.
async function finalizeExamAttempt(attemptId, examItems, answers) {
  const itemsById = new Map(examItems.map((it) => [it.id, it]));
  let score = 0;

  for (const ans of answers || []) {
    const item = itemsById.get(Number(ans.itemId));
    if (!item || item.type === 'scan') continue; // ignore ids that don't belong to this exam, and scan items (see above)

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

// Assist-only AI suggestion for short/long items, same posture as the scan-
// grading pipeline's assessAnswers call: never touches marks_awarded, purely
// a note a teacher sees next to the grade input in GradingForm. Deliberately
// NOT awaited inline in POST /api/exams/:id/submit (see the call site) —
// each item is its own Groq call, and blocking a student's submit response
// on that would add real latency/failure risk to every exam finish. One
// assessAnswers call per item rather than one batched call for all of them:
// unlike the OCR pipeline (one text blob that may cover several questions,
// needing the model to disentangle which answer belongs to which prompt),
// each short/long item already has its own cleanly separated text_answer —
// batching would just reintroduce an ambiguity that doesn't exist here.
async function runExamShortLongAiAssessment(attemptId, examItems) {
  if (!isGroqConfigured()) return;
  const shortLongItems = examItems.filter((it) => it.type === 'short' || it.type === 'long');
  if (shortLongItems.length === 0) return;
  const itemsById = new Map(shortLongItems.map((it) => [it.id, it]));

  try {
    const answersRes = await pool.query(
      'SELECT id, item_id, text_answer FROM exam_answers WHERE attempt_id = $1 AND item_id = ANY($2::int[])',
      [attemptId, shortLongItems.map((it) => it.id)]
    );
    for (const row of answersRes.rows) {
      if (!row.text_answer || !row.text_answer.trim()) continue;
      const item = itemsById.get(row.item_id);
      if (!item) continue;
      const [assessment] = await assessAnswers([{ prompt: item.prompt, marks: item.marks }], row.text_answer, { isOcr: false });
      await pool.query('UPDATE exam_answers SET ai_assessment = $1 WHERE id = $2', [assessment || null, row.id]);
    }
  } catch (err) {
    console.error(`Exam short/long AI assessment failed for attempt ${attemptId}:`, err);
  }
}

// Recomputes and saves an attempt's total score from scratch — marks_awarded
// summed across BOTH exam_answers (mcq/coding auto-graded, short/long once
// manually graded) and exam_scan_answers (scan items, always manually
// graded). Called after any manual grade so a teacher grading a scan item
// doesn't leave the attempt's score stale by only ever having summed
// exam_answers, the way a single-table SUM would.
async function recomputeExamAttemptScore(attemptId) {
  const res = await pool.query(
    `SELECT
       COALESCE((SELECT SUM(marks_awarded) FROM exam_answers WHERE attempt_id = $1), 0) +
       COALESCE((SELECT SUM(marks_awarded) FROM exam_scan_answers WHERE attempt_id = $1), 0) AS score`,
    [attemptId]
  );
  const score = res.rows[0].score;
  await pool.query('UPDATE exam_attempts SET score = $1 WHERE id = $2', [score, attemptId]);
  return score;
}

// An attempt is "fully graded" once every short/long answer AND every scan
// item has a non-NULL marks_awarded — mcq and coding are always auto-graded
// at submit time, so an exam with none of those manually-graded types is
// fully graded the instant it's submitted, no admin action ever needed.
// Used to gate percentage/grade/percentile tags, which are meaningless
// while any item is still ungraded.
async function isAttemptFullyGraded(attemptId) {
  const res = await pool.query(
    `SELECT NOT EXISTS (
       SELECT 1 FROM exam_answers ea
       JOIN exam_items ei ON ei.id = ea.item_id
       WHERE ea.attempt_id = $1 AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
     ) AND NOT EXISTS (
       SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = $1 AND esa.marks_awarded IS NULL
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
// views never call this) get to see of their own tags. Cached: this is
// called from nearly every performance/result route in the app (a student
// loading their dashboard alone can trigger it several times over), and
// it's written by exactly one place — an admin flipping the toggle on the
// settings panel — so a 60s TTL trades a bounded, rare staleness window
// (an admin's own toggle takes up to a minute to show up elsewhere) for
// cutting a DB round trip off a very hot path.
async function getTagVisibility(organizationId) {
  return cached(`tagvis:${organizationId}`, 60, async () => {
    const res = await pool.query('SELECT show_percentile_tag, show_grade_tag FROM tag_visibility_settings WHERE organization_id = $1', [organizationId]);
    return res.rows[0] || { show_percentile_tag: true, show_grade_tag: false };
  });
}

// ============================================================================
// 1. ADMIN ENDPOINT: Create a single student manually
// ============================================================================
app.post('/api/admin/create-student', authenticateToken, requireAdmin, async (req, res) => {
  const { email, name } = req.body;
  const orgUnitId = req.body.orgUnitId != null ? Number(req.body.orgUnitId) : null;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const client = await pool.connect();
  try {
    const orgRes = await client.query('SELECT status, name FROM organizations WHERE id = $1', [req.user.organizationId]);
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

    const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);

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

    // Best-effort, after the transaction is already committed — an email
    // hiccup here shouldn't turn an otherwise-successful account creation
    // into a 500 (matches the CSV import / Google Form webhook posture).
    if (isNew) {
      await sendStudentWelcomeEmail(email, name, orgRes.rows[0].name, temporaryPassword);
    }

    const student = { id: userId, email, name: name || null, role: 'student' };
    if (isNew) {
      res.status(201).json({ message: 'Student account created successfully — credentials emailed to them', student, temporaryPassword });
    } else {
      res.status(201).json({
        message: 'This email already had a HonorRoll account elsewhere — added to your organization. They sign in with their existing password.',
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
  const { email, name } = req.body;
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

    const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);

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

    const teacher = { id: userId, email, name: name || null, role: 'teacher' };
    if (isNew) {
      res.status(201).json({ message: 'Teacher account created successfully', teacher, temporaryPassword });
    } else {
      res.status(201).json({
        message: 'This email already had a HonorRoll account elsewhere — added to your organization. They sign in with their existing password.',
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
      `SELECT u.id, u.email, u.name, m.org_unit_id
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

// Mirrors PUT /api/admin/students/:id — name and org_unit_id only, no
// roll_number (student-only) and no email (same reasoning as the student
// route's own comment: users.email is the global-identity key shared
// across every organization that email belongs to, so it's never editable
// from inside one org's roster view). A teacher's own org_unit_id also
// newly matters beyond being informational: POST /api/admin/subjects/:id/
// teachers now only allows assigning a teacher whose org_unit_id matches
// the subject's own unit, so this is how an admin corrects a teacher's
// unit after the fact if it was left unset or wrong at creation time.
app.put('/api/admin/teachers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const teacherId = req.params.id;
  const name = req.body.name !== undefined ? (String(req.body.name || '').trim() || null) : undefined;
  const orgUnitId = req.body.orgUnitId !== undefined
    ? (req.body.orgUnitId === null || req.body.orgUnitId === '' ? null : Number(req.body.orgUnitId))
    : undefined;

  try {
    // Scoped to role='teacher' on purpose, same reasoning as the student
    // route — never lets this touch an admin/student account even if a
    // stale/tampered id is passed in. 404, not 403, on a miss so this can't
    // be used to probe which ids exist in another organization.
    const membershipRes = await pool.query(
      `SELECT m.id FROM memberships m WHERE m.user_id = $1 AND m.organization_id = $2 AND m.role = 'teacher'`,
      [teacherId, req.user.organizationId]
    );
    if (membershipRes.rows.length === 0) return res.status(404).json({ error: 'Teacher not found' });

    if (orgUnitId !== undefined && orgUnitId !== null) {
      const unitCheck = await pool.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
      if (unitCheck.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    }

    if (name !== undefined) {
      await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name, teacherId]);
    }
    if (orgUnitId !== undefined) {
      // Same "explicitly sent null clears it" vs "not sent at all leaves it
      // alone" distinction as the student route — orgUnitId is the only
      // field here that can be legitimately cleared back to null.
      await pool.query('UPDATE memberships SET org_unit_id = $1 WHERE user_id = $2 AND organization_id = $3', [orgUnitId, teacherId, req.user.organizationId]);
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.name, m.org_unit_id FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE u.id = $1 AND m.organization_id = $2`,
      [teacherId, req.user.organizationId]
    );
    res.status(200).json({ teacher: result.rows[0] });
  } catch (err) {
    console.error('Update teacher error:', err);
    res.status(500).json({ error: 'Failed to update teacher' });
  }
});

// Teacher counterpart to the student CSV template/import pair below —
// same header-defines-structure contract (any column besides Name/Email is
// a tier, left to right), reusing splitTierAndIdentityColumns/
// ensureLevelsForTierLabels/resolveOrCreateOrgUnit exactly as-is. No
// student-cap check here — teacher seats aren't billed.
app.get('/api/admin/teachers/csv-template', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const levels = await pool.query(
      'SELECT label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC',
      [req.user.organizationId]
    );
    const headers = levels.rows.length > 0
      ? [...levels.rows.map((l) => l.label), 'Name', 'Email']
      : ['Campus', 'Department', 'Name', 'Email'];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="teacher-import-template.csv"');
    res.status(200).send(`${headers.join(',')}\n`);
  } catch (err) {
    console.error('Teacher CSV template error:', err);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

app.post('/api/admin/teachers/csv-import', authenticateToken, requireAdmin, csvUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });

  const orgRes = await pool.query('SELECT status FROM organizations WHERE id = $1', [req.user.organizationId]);
  if (orgRes.rows[0]?.status !== 'approved') {
    return res.status(403).json({ error: 'Your organization is still pending approval — you cannot import teachers yet' });
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

  const { emailKey, nameKey, rollKey, tierKeys } = splitTierAndIdentityColumns(Object.keys(rows[0]));
  if (!emailKey) {
    return res.status(400).json({ error: 'CSV must have an Email column' });
  }

  const levelsResult = await ensureLevelsForTierLabels(req.user.organizationId, tierKeys);
  if (levelsResult.error) {
    return res.status(400).json({ error: levelsResult.reason });
  }
  const levels = levelsResult.levels;

  // Unlike student import, temp passwords are returned in the response
  // rather than emailed — matching the single create-teacher route, which
  // has never sent a welcome email and instead relies on the admin relaying
  // the password shown on screen.
  const results = { created: 0, existingAdded: 0, skipped: 0, unitsCreated: [], newAccounts: [], errors: [] };
  const seenCreatedUnits = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const email = String(row[emailKey] || '').trim();
    const name = nameKey ? String(row[nameKey] || '').trim() : '';
    const rollNumber = rollKey ? String(row[rollKey] || '').trim() || null : null;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.errors.push({ row: rowNum, email, reason: email ? 'Malformed email' : 'Missing email' });
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
      const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);
      const memberRes = await client.query(
        `INSERT INTO memberships (user_id, organization_id, role, org_unit_id, roll_number) VALUES ($1, $2, 'teacher', $3, $4)
         ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
        [userId, req.user.organizationId, orgUnitId, rollNumber]
      );
      await client.query('COMMIT');

      if (memberRes.rows.length === 0) {
        results.skipped++;
      } else if (isNew) {
        results.created++;
        results.newAccounts.push({ email, name, temporaryPassword });
      } else {
        results.existingAdded++;
      }
    } catch (err) {
      await client.query('ROLLBACK');
      results.errors.push({ row: rowNum, email, reason: 'Database error creating this row' });
    } finally {
      client.release();
    }
  }

  results.unitsCreated = [...seenCreatedUnits];
  res.status(200).json(results);
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

  const orgRes = await pool.query('SELECT status, name FROM organizations WHERE id = $1', [req.user.organizationId]);
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
  const { emailKey, nameKey, rollKey, tierKeys } = splitTierAndIdentityColumns(Object.keys(rows[0]));
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
    const rollNumber = rollKey ? String(row[rollKey] || '').trim() || null : null;

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
      const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);
      const memberRes = await client.query(
        `INSERT INTO memberships (user_id, organization_id, role, org_unit_id, roll_number) VALUES ($1, $2, 'student', $3, $4)
         ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
        [userId, req.user.organizationId, orgUnitId, rollNumber]
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
  await Promise.allSettled(newAccounts.map((a) => sendStudentWelcomeEmail(a.email, a.name, orgRes.rows[0].name, a.temporaryPassword)));

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
    let subRes = await pool.query('SELECT * FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
    let sub = subRes.rows[0] || { plan_key: 'free', status: 'free', billing_cycle: null, current_period_end: null };

    // Auto-sync with Razorpay API if subscription is pending/upgraded
    if (sub.pending_razorpay_subscription_id) {
      const rzp = getRazorpayClient();
      if (rzp) {
        try {
          const rzpSub = await rzp.subscriptions.fetch(sub.pending_razorpay_subscription_id);
          if (rzpSub && (rzpSub.status === 'active' || rzpSub.status === 'authenticated' || rzpSub.paid_count > 0)) {
            const currentPeriodEnd = rzpSub.current_end ? new Date(rzpSub.current_end * 1000) : null;
            const promoted = await promoteSubscriptionToActive(sub.pending_razorpay_subscription_id, rzpSub.plan_id, currentPeriodEnd);
            if (promoted?.wasPromotion) {
              await sendBillingEmail(
                req.user.organizationId,
                'Your subscription is now active',
                `Your ${PLAN_CATALOG[promoted.plan_key]?.label || promoted.plan_key} plan is now active. Thank you!`
              );
            }
            subRes = await pool.query('SELECT * FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
            if (subRes.rows[0]) sub = subRes.rows[0];
          }
        } catch (err) {
          // Ignore transient fetch errors in status polling
        }
      }
    }

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

    const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]);
    const adminUser = userRes.rows[0];

    res.status(200).json({
      subscriptionId: subscription.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      planLabel: PLAN_CATALOG[planKey].label,
      billingCycle,
      prefill: {
        name: adminUser?.name || '',
        email: adminUser?.email || '',
      }
    });
  } catch (err) {
    console.error('Billing checkout error:', err);
    res.status(500).json({ error: 'Failed to start checkout' });
  }
});

// Immediate post-checkout verification endpoint. Called directly by the
// Razorpay client-side handler on payment success to confirm and activate the plan
// without waiting for asynchronous webhooks.
app.post('/api/admin/billing/verify', authenticateToken, requireAdmin, async (req, res) => {
  const { razorpayPaymentId, razorpaySubscriptionId, razorpaySignature } = req.body;

  try {
    await ensureSubscriptionsSchema();
    const subRes = await pool.query('SELECT * FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
    const sub = subRes.rows[0];
    if (!sub) return res.status(404).json({ error: 'Subscription record not found' });

    const targetSubId = razorpaySubscriptionId || sub.pending_razorpay_subscription_id || sub.razorpay_subscription_id;
    if (!targetSubId) {
      return res.status(400).json({ error: 'No subscription ID provided' });
    }

    const rzpSecret = process.env.RAZORPAY_KEY_SECRET;
    let signatureVerified = false;

    if (razorpayPaymentId && razorpaySignature && rzpSecret) {
      try {
        const expectedSignature = crypto
          .createHmac('sha256', rzpSecret)
          .update(`${razorpayPaymentId}|${targetSubId}`)
          .digest('hex');
        if (expectedSignature === razorpaySignature) {
          signatureVerified = true;
        }
      } catch (sigErr) {
        console.error('Signature verification calculation error:', sigErr);
      }
    }

    const rzp = getRazorpayClient();
    let rzpSub = null;
    let currentPeriodEnd = null;
    let planId = sub.razorpay_plan_id;

    if (rzp) {
      try {
        rzpSub = await rzp.subscriptions.fetch(targetSubId);
        if (rzpSub) {
          planId = rzpSub.plan_id || planId;
          if (rzpSub.current_end) {
            currentPeriodEnd = new Date(rzpSub.current_end * 1000);
          }
        }
      } catch (err) {
        console.error('Razorpay subscription fetch error in verify route:', err);
      }
    }

    const isRzpActive = rzpSub && (rzpSub.status === 'active' || rzpSub.status === 'authenticated' || rzpSub.paid_count > 0);

    // If signature is verified OR Razorpay API confirms subscription OR payment ID is present
    if (signatureVerified || isRzpActive || razorpayPaymentId) {
      const org = await promoteSubscriptionToActive(targetSubId, planId, currentPeriodEnd);
      if (org?.wasPromotion) {
        await sendBillingEmail(
          req.user.organizationId,
          'Your subscription is now active',
          `Your ${PLAN_CATALOG[org.plan_key]?.label || org.plan_key} plan is now active. Thank you!`
        );
      }

      const updatedSubRes = await pool.query('SELECT * FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
      const updatedSub = updatedSubRes.rows[0];
      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'student'`,
        [req.user.organizationId]
      );
      const effectivePlanKey = updatedSub.status === 'active' ? updatedSub.plan_key : 'free';

      return res.status(200).json({
        success: true,
        message: 'Subscription confirmed and activated',
        status: {
          planKey: updatedSub.plan_key,
          effectivePlanKey,
          status: updatedSub.status,
          billingCycle: updatedSub.billing_cycle,
          currentPeriodEnd: updatedSub.current_period_end,
          pendingPlanKey: updatedSub.pending_plan_key,
          studentCap: PLAN_CATALOG[effectivePlanKey].studentCap,
          currentStudentCount: countRes.rows[0].n,
          razorpayConfigured: !!getRazorpayClient(),
        }
      });
    }

    return res.status(400).json({ error: 'Payment could not be verified with Razorpay' });
  } catch (err) {
    console.error('Billing verify error:', err);
    res.status(500).json({ error: 'Failed to verify payment' });
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

// Above 'scale' (10,000 students) isn't a self-serve checkout at all — too
// large a deployment to price with a fixed card, and this account's
// Razorpay Subscriptions product doesn't even cover it. This is a plain
// lead-capture form instead: mails the request to the platform owner, who
// follows up and issues a real invoice out-of-band. No Razorpay involved,
// no DB row created — same "best-effort email, nothing else depends on it"
// posture as sendBillingEmail below.
app.post('/api/admin/billing/custom-quote', authenticateToken, requireAdmin, async (req, res) => {
  const studentCount = String(req.body.studentCount || '').trim();
  const contactPhone = String(req.body.contactPhone || '').trim();
  const notes = String(req.body.notes || '').trim();
  if (!studentCount) return res.status(400).json({ error: 'Approximate student count is required' });

  try {
    const result = await pool.query(
      `SELECT u.name, u.email, o.name AS organization_name
       FROM users u JOIN organizations o ON o.id = $2
       WHERE u.id = $1`,
      [req.user.userId, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const { name, email, organization_name: organizationName } = result.rows[0];

    const { error: emailError } = await sendEmail({
      to: 'honorroll.admin@gmail.com',
      subject: `Custom plan request — ${organizationName}`,
      text: `New custom-plan quote request:\n\nInstitution: ${organizationName}\nContact: ${name || 'Not given'} <${email}>\nPhone: ${contactPhone || 'Not given'}\nApprox. student count: ${studentCount}\n\nNotes:\n${notes || '(none)'}`,
    });
    if (emailError) {
      console.error('Custom-quote email failed to send:', emailError);
      return res.status(502).json({ error: 'Failed to send your request — please try again or email honorroll.admin@gmail.com directly.' });
    }

    // Best-effort ack to the requester — a failure here shouldn't turn an
    // already-successfully-sent lead into an error response.
    const { error: ackError } = await sendEmail({
      to: email,
      subject: 'We received your HonorRoll custom plan request',
      text: `Hi ${name || 'there'},\n\nThanks for reaching out about a custom plan for ${organizationName} (~${studentCount} students). Our team will follow up shortly with a quote and invoice.\n\n— HonorRoll`,
    });
    if (ackError) console.error('Custom-quote ack email failed to send:', ackError);

    res.status(200).json({ message: 'Request sent — our team will follow up by email shortly.' });
  } catch (err) {
    console.error('Custom-quote request error:', err);
    res.status(500).json({ error: 'Failed to send your request' });
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
    await invalidate(`orgunits:${req.user.organizationId}`);
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
    await invalidate(`orgunits:${req.user.organizationId}`);
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
    await invalidate(`orgunits:${req.user.organizationId}`);
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
// Cached: the org structure tree is read on nearly every admin/teacher
// page (student lists, subject pickers, CSV import templates, ...) but
// only ever written by an admin deliberately editing it — the write routes
// below (org-levels and org-units create/update/delete) all invalidate
// this same key, so a structure edit is visible immediately rather than
// waiting out the TTL; the TTL itself is just a backstop.
app.get('/api/admin/org-units', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const data = await cached(`orgunits:${req.user.organizationId}`, 120, async () => {
      const [levels, units] = await Promise.all([
        pool.query('SELECT id, tier_index, label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC', [req.user.organizationId]),
        pool.query('SELECT id, level_def_id, parent_unit_id, name FROM org_units WHERE organization_id = $1 ORDER BY id ASC', [req.user.organizationId]),
      ]);
      return { levels: levels.rows, units: units.rows };
    });
    res.status(200).json(data);
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
    await invalidate(`orgunits:${req.user.organizationId}`);
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
    await invalidate(`orgunits:${req.user.organizationId}`);
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
    await invalidate(`orgunits:${req.user.organizationId}`);
    res.status(200).json({ message: 'Unit removed' });
  } catch (err) {
    console.error('Delete org unit error:', err);
    res.status(500).json({ error: 'Failed to remove unit' });
  }
});

// End-of-year promotion: bulk-moves students from one unit to another —
// deliberately just a plain org_unit_id reassignment on their membership
// row, nothing more. Every score a student has (submissions, exam_attempts,
// legacy_scores) keys off user_id, never org_unit, so there is nothing to
// migrate or recompute here — their whole history is automatically intact
// under the new unit the instant this UPDATE commits. `studentIds`
// (optional) lets an admin hold specific students back instead of
// promoting the whole unit at once; omitted, every student currently in
// fromUnit gets moved.
app.post('/api/admin/org-units/:fromUnitId/promote', authenticateToken, requireAdmin, async (req, res) => {
  const toUnitId = Number(req.body.toUnitId);
  if (!toUnitId) return res.status(400).json({ error: 'toUnitId is required' });
  if (toUnitId === Number(req.params.fromUnitId)) return res.status(400).json({ error: 'From and to units must be different' });

  try {
    const [fromRes, toRes] = await Promise.all([
      pool.query('SELECT id FROM org_units WHERE id = $1 AND organization_id = $2', [req.params.fromUnitId, req.user.organizationId]),
      pool.query('SELECT id, name FROM org_units WHERE id = $1 AND organization_id = $2', [toUnitId, req.user.organizationId]),
    ]);
    if (fromRes.rows.length === 0) return res.status(404).json({ error: 'Source unit not found' });
    if (toRes.rows.length === 0) return res.status(404).json({ error: 'Destination unit not found' });

    const studentIds = Array.isArray(req.body.studentIds) && req.body.studentIds.length > 0
      ? req.body.studentIds
      : null;

    const result = await pool.query(
      `UPDATE memberships SET org_unit_id = $1
       WHERE organization_id = $2 AND org_unit_id = $3 AND role = 'student'
         AND ($4::uuid[] IS NULL OR user_id = ANY($4::uuid[]))
       RETURNING user_id`,
      [toUnitId, req.user.organizationId, req.params.fromUnitId, studentIds]
    );

    res.status(200).json({ promoted: result.rows.length, toUnitName: toRes.rows[0].name });
  } catch (err) {
    console.error('Promote students error:', err);
    res.status(500).json({ error: 'Failed to promote students' });
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
              COALESCE(json_agg(json_build_object('id', t.id, 'email', t.email, 'name', t.name)) FILTER (WHERE t.id IS NOT NULL), '[]') AS teachers
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

// Takes userId, not email — a subject's own unit is now the actual
// eligibility boundary for who can be assigned to it (an admin picks from
// GET /api/admin/teachers pre-filtered to teachers whose own org_unit_id
// matches this subject's, in SubjectsPanel.jsx), so the free-text "type an
// email and hope they exist" flow is gone: the frontend only ever offers
// teachers that already pass this check, and the check itself is
// re-enforced here so a direct API call can't bypass it either.
app.post('/api/admin/subjects/:id/teachers', authenticateToken, requireAdmin, async (req, res) => {
  const userId = String(req.body.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'A teacher must be selected' });

  try {
    const subject = await pool.query('SELECT id, org_unit_id FROM subjects WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (subject.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    const teacher = await pool.query(
      `SELECT u.id, m.org_unit_id FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE u.id = $1 AND m.organization_id = $2 AND m.role = 'teacher'`,
      [userId, req.user.organizationId]
    );
    if (teacher.rows.length === 0) return res.status(404).json({ error: 'Teacher not found in your organization' });
    if (teacher.rows[0].org_unit_id !== subject.rows[0].org_unit_id) {
      return res.status(400).json({ error: "This teacher isn't part of the subject's unit" });
    }

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
// 1b. ADMIN: List every student with their total assignment/exam score —
// deliberately just the two headline numbers (see getTotalScores), not the
// attempt-count/time-on-task/efficiency-score detail this route used to
// return. An admin managing a roster doesn't need per-attempt forensics;
// that level of detail is still available lower down for one student at a
// time (GET /api/admin/students/:studentId/problems/:problemId/submissions)
// for the rare case it's actually needed.
// ============================================================================
app.get('/api/admin/students', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const membershipsRes = await pool.query(
      `SELECT u.id, u.email, u.name, u.created_at, m.org_unit_id
       FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $1 AND m.role = 'student'
       ORDER BY u.email ASC`,
      [req.user.organizationId]
    );
    const roster = membershipsRes.rows;
    const studentIds = roster.map((s) => s.id);

    const [unitLookup, totals] = await Promise.all([
      getOrgUnitLookup(req.user.organizationId),
      getTotalScores(req.user.organizationId, studentIds),
    ]);

    const students = roster.map((s) => {
      const t = totals.get(s.id) || { totalAssignmentPercent: null, totalExamPercent: null };
      return {
        id: s.id,
        email: s.email,
        name: s.name,
        created_at: s.created_at,
        org_unit_id: s.org_unit_id,
        unit_path: resolveOrgUnitPath(unitLookup, s.org_unit_id),
        totalAssignmentPercent: t.totalAssignmentPercent,
        totalExamPercent: t.totalExamPercent,
      };
    });

    res.status(200).json({ students });
  } catch (error) {
    console.error('List students error:', error);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

// ============================================================================
// GRADEBOOK - full per-student x per-item score matrix for one subject
// (not just the rollup averages /api/teacher/students returns), plus a
// class-average row. Admin can view any subject in their org; a teacher is
// gated to their own assigned subjects via enforceSubjectAuthority, the
// same check every other subject-scoped exam/assignment route already uses.
// ============================================================================
app.get('/api/admin/gradebook', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectId = req.query.subjectId != null ? Number(req.query.subjectId) : null;
  if (!subjectId || !Number.isFinite(subjectId)) {
    return res.status(400).json({ error: 'subjectId is required' });
  }
  if (await enforceSubjectAuthority(req, res, subjectId)) return;

  try {
    const subjectRes = await pool.query('SELECT id, name FROM subjects WHERE id = $1 AND organization_id = $2', [subjectId, req.user.organizationId]);
    if (subjectRes.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    const [students, problemsRes, examsRes] = await Promise.all([
      getStudentsForSubject(req.user.organizationId, subjectId),
      pool.query('SELECT id, title, submission_mode FROM problems WHERE organization_id = $1 AND subject_id = $2 ORDER BY created_at ASC', [req.user.organizationId, subjectId]),
      pool.query('SELECT id, title, total_marks FROM exams WHERE organization_id = $1 AND subject_id = $2 ORDER BY created_at ASC', [req.user.organizationId, subjectId]),
    ]);
    const problems = problemsRes.rows;
    const exams = examsRes.rows;
    const studentIds = students.map((s) => s.id);

    const [{ byUser: assignmentByUser }, { byUser: examByUser }] = await Promise.all([
      getAssignmentPerformance(problems, studentIds),
      getExamPerformance(exams, studentIds),
    ]);

    const rows = students.map((s) => {
      const aMap = assignmentByUser.get(s.id) || new Map();
      const eMap = examByUser.get(s.id) || new Map();
      return {
        id: s.id,
        name: s.name,
        email: s.email,
        assignments: Object.fromEntries(problems.map((p) => [p.id, aMap.get(p.id) || { status: 'not_submitted', pct: null }])),
        exams: Object.fromEntries(exams.map((e) => [e.id, eMap.get(e.id) || { status: 'not_submitted', pct: null }])),
        avgAssignmentPercent: averagePercent(aMap),
        avgExamPercent: averagePercent(eMap),
      };
    });

    // Class-average row — mean of graded percentages per column, ignoring
    // students who haven't been graded on that item yet (same convention
    // averagePercent already uses for a single student's row).
    const classAvgFor = (getPct) => {
      const vals = rows.map(getPct).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const classAverages = {
      assignments: Object.fromEntries(problems.map((p) => [p.id, classAvgFor((r) => r.assignments[p.id].pct)])),
      exams: Object.fromEntries(exams.map((e) => [e.id, classAvgFor((r) => r.exams[e.id].pct)])),
      overallAssignment: classAvgFor((r) => r.avgAssignmentPercent),
      overallExam: classAvgFor((r) => r.avgExamPercent),
    };

    res.status(200).json({
      subject: subjectRes.rows[0],
      assignments: problems.map((p) => ({ id: p.id, title: p.title })),
      exams: exams.map((e) => ({ id: e.id, title: e.title })),
      students: rows,
      classAverages,
    });
  } catch (err) {
    console.error('Gradebook error:', err);
    res.status(500).json({ error: 'Failed to load gradebook' });
  }
});

// ============================================================================
// LEADERBOARD - ranked class view for one exam or one assignment, using the
// same mid-rank percentile math as the student-facing gauge
// (computePercentileTiers, see GET /api/me/performance*) rather than
// reinventing it. type is 'exam' | 'assignment'; itemId is that item's own
// id. Authorization derives the subject from the item itself (not a query
// param) so a teacher can't probe an item's subject by guessing.
// ============================================================================
app.get('/api/admin/leaderboard', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const type = req.query.type;
  const itemId = req.query.itemId != null ? Number(req.query.itemId) : null;
  if (!['exam', 'assignment'].includes(type) || !itemId || !Number.isFinite(itemId)) {
    return res.status(400).json({ error: 'type ("exam" or "assignment") and itemId are required' });
  }

  try {
    const table = type === 'exam' ? 'exams' : 'problems';
    const itemRes = await pool.query(`SELECT id, title, subject_id FROM ${table} WHERE id = $1 AND organization_id = $2`, [itemId, req.user.organizationId]);
    if (itemRes.rows.length === 0) {
      return res.status(404).json({ error: type === 'exam' ? 'Exam not found' : 'Assignment not found' });
    }
    const item = itemRes.rows[0];
    if (await enforceSubjectAuthority(req, res, item.subject_id)) return;

    // Org-wide items (subject_id null) only ever reach here as an admin —
    // enforceSubjectAuthority already 400s a teacher on a null subjectId —
    // so the population is every student in the org rather than one
    // subject's cascade-down set.
    const students = item.subject_id
      ? await getStudentsForSubject(req.user.organizationId, item.subject_id)
      : (await pool.query(
          `SELECT u.id, u.email, u.name FROM users u
           JOIN memberships m ON m.user_id = u.id AND m.organization_id = $1 AND m.role = 'student'
           ORDER BY u.email ASC`,
          [req.user.organizationId]
        )).rows;
    const studentIds = students.map((s) => s.id);

    let byUser;
    if (type === 'exam') {
      const examRow = await pool.query('SELECT id, total_marks FROM exams WHERE id = $1', [itemId]);
      ({ byUser } = await getExamPerformance(examRow.rows, studentIds));
    } else {
      const probRow = await pool.query('SELECT id, submission_mode FROM problems WHERE id = $1', [itemId]);
      ({ byUser } = await getAssignmentPerformance(probRow.rows, studentIds));
    }

    const graded = [];
    const ungraded = [];
    students.forEach((s) => {
      const entry = byUser.get(s.id)?.get(itemId);
      if (entry && entry.pct != null) graded.push({ id: s.id, name: s.name, email: s.email, pct: entry.pct });
      else ungraded.push({ id: s.id, name: s.name, email: s.email, status: entry?.status || 'not_submitted' });
    });

    const tierFor = computePercentileTiers(graded.map((g) => g.pct));
    const ranked = graded
      .map((g) => ({ ...g, ...tierFor(g.pct) }))
      .sort((a, b) => b.pct - a.pct)
      .map((g, i) => ({ ...g, rank: i + 1 }));

    res.status(200).json({
      item: { id: item.id, title: item.title, type },
      ranked,
      ungraded,
      classAverage: ranked.length ? ranked.reduce((sum, g) => sum + g.pct, 0) / ranked.length : null,
    });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// ============================================================================
// TEACHER DASHBOARD - every student "under" the teacher (their subjects'
// org units and everything beneath them, see getTeacherScope above), with
// performance rolled up ONLY from assignments/exams attached to the
// teacher's own subjects - not an org-wide report, deliberately narrower
// than /api/admin/students. Teacher-only, same posture as non-submitters
// above: admins already have their own fuller student views.
// ============================================================================
app.get('/api/teacher/students', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  try {
    const { subjectIds, unitIds } = await getTeacherScope(req.user.userId, req.user.organizationId);
    const students = await getTeacherScopedStudents(req.user.organizationId, unitIds);
    const studentIds = students.map((s) => s.id);

    const { problems, exams } = await getSubjectScopedAssignmentsAndExams(req.user.organizationId, subjectIds);
    const [{ byUser: assignmentByUser }, { byUser: examByUser }] = await Promise.all([
      getAssignmentPerformance(problems, studentIds),
      getExamPerformance(exams, studentIds),
    ]);

    const unitLookup = await getOrgUnitLookup(req.user.organizationId);

    const result = students.map((s) => {
      const aMap = assignmentByUser.get(s.id) || new Map();
      const eMap = examByUser.get(s.id) || new Map();
      return {
        id: s.id,
        email: s.email,
        name: s.name,
        created_at: s.created_at,
        unit_path: resolveOrgUnitPath(unitLookup, s.org_unit_id),
        assignmentsTotal: problems.length,
        assignmentsSubmitted: aMap.size,
        avgAssignmentPercent: averagePercent(aMap),
        examsTotal: exams.length,
        examsAttempted: eMap.size,
        avgExamPercent: averagePercent(eMap),
      };
    });

    res.status(200).json({ students: result, subjectCount: subjectIds.length });
  } catch (err) {
    console.error('Teacher students list error:', err);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

// Teacher: one student's full breakdown, scoped the same way as the list
// above - 404s (rather than 403) if the student exists but falls outside
// this teacher's own subjects/units, so a teacher can't fish for arbitrary
// student ids by trying them one at a time.
app.get('/api/teacher/students/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  try {
    const { subjectIds, unitIds } = await getTeacherScope(req.user.userId, req.user.organizationId);
    if (unitIds.length === 0) return res.status(404).json({ error: 'Student not found' });

    const studentRes = await pool.query(
      `SELECT u.id, u.email, u.name, u.created_at, m.org_unit_id
       FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $1 AND m.role = 'student'
       WHERE u.id = $2 AND m.org_unit_id = ANY($3::int[])`,
      [req.user.organizationId, req.params.id, unitIds]
    );
    if (studentRes.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const student = studentRes.rows[0];

    const classmates = await getTeacherScopedStudents(req.user.organizationId, unitIds);
    const studentIds = classmates.map((s) => s.id);

    const { problems, exams } = await getSubjectScopedAssignmentsAndExams(req.user.organizationId, subjectIds);
    const [{ byUser: assignmentByUser }, { byUser: examByUser }] = await Promise.all([
      getAssignmentPerformance(problems, studentIds),
      getExamPerformance(exams, studentIds),
    ]);

    const [problemMetaRes, examMetaRes, scanRemarksRes, examRemarksRes] = await Promise.all([
      problems.length
        ? pool.query(
            `SELECT p.id, p.title, s.name AS subject_name FROM problems p
             LEFT JOIN subjects s ON s.id = p.subject_id WHERE p.id = ANY($1::int[])`,
            [problems.map((p) => p.id)]
          )
        : { rows: [] },
      exams.length
        ? pool.query(
            `SELECT e.id, e.title, s.name AS subject_name FROM exams e
             LEFT JOIN subjects s ON s.id = e.subject_id WHERE e.id = ANY($1::int[])`,
            [exams.map((e) => e.id)]
          )
        : { rows: [] },
      problems.length
        ? pool.query('SELECT problem_id, overall_remarks FROM scan_submissions WHERE user_id = $1 AND problem_id = ANY($2::int[])', [student.id, problems.map((p) => p.id)])
        : { rows: [] },
      exams.length
        ? pool.query('SELECT exam_id, overall_remarks FROM exam_attempts WHERE user_id = $1 AND exam_id = ANY($2::int[])', [student.id, exams.map((e) => e.id)])
        : { rows: [] },
    ]);
    const problemMetaById = new Map(problemMetaRes.rows.map((r) => [r.id, r]));
    const examMetaById = new Map(examMetaRes.rows.map((r) => [r.id, r]));
    const scanRemarksByProblem = new Map(scanRemarksRes.rows.map((r) => [r.problem_id, r.overall_remarks]));
    const examRemarksByExam = new Map(examRemarksRes.rows.map((r) => [r.exam_id, r.overall_remarks]));

    const myAssignments = assignmentByUser.get(student.id) || new Map();
    const myExams = examByUser.get(student.id) || new Map();

    const assignments = problems.map((p) => {
      const meta = problemMetaById.get(p.id);
      const entry = myAssignments.get(p.id);
      return {
        problemId: p.id,
        title: meta?.title,
        subjectName: meta?.subject_name,
        status: entry?.status || 'not_submitted',
        percent: entry?.pct ?? null,
        remarks: scanRemarksByProblem.get(p.id) || null,
      };
    });

    const examsOut = exams.map((e) => {
      const meta = examMetaById.get(e.id);
      const entry = myExams.get(e.id);
      return {
        examId: e.id,
        title: meta?.title,
        subjectName: meta?.subject_name,
        status: entry?.status || 'not_attempted',
        percent: entry?.pct ?? null,
        remarks: examRemarksByExam.get(e.id) || null,
      };
    });

    // Percentile against this teacher's own class only (not org-wide) - a
    // student's standing among peers actually taking the same subjects,
    // rather than being diluted by every other department/year in the
    // institution the way the admin-side percentile is.
    const classmateAssignmentAvgs = [];
    const classmateExamAvgs = [];
    studentIds.forEach((sid) => {
      const aAvg = averagePercent(assignmentByUser.get(sid) || new Map());
      if (aAvg != null) classmateAssignmentAvgs.push(aAvg);
      const eAvg = averagePercent(examByUser.get(sid) || new Map());
      if (eAvg != null) classmateExamAvgs.push(eAvg);
    });
    const myAvgAssignment = averagePercent(myAssignments);
    const myAvgExam = averagePercent(myExams);
    const assignmentPercentileTag = myAvgAssignment != null && classmateAssignmentAvgs.length > 1
      ? computePercentileTiers(classmateAssignmentAvgs)(myAvgAssignment).tag
      : null;
    const examPercentileTag = myAvgExam != null && classmateExamAvgs.length > 1
      ? computePercentileTiers(classmateExamAvgs)(myAvgExam).tag
      : null;

    const unitLookup = await getOrgUnitLookup(req.user.organizationId);

    res.status(200).json({
      student: { id: student.id, email: student.email, name: student.name, created_at: student.created_at },
      unitPath: resolveOrgUnitPath(unitLookup, student.org_unit_id),
      assignments,
      exams: examsOut,
      avgAssignmentPercent: myAvgAssignment,
      avgExamPercent: myAvgExam,
      assignmentPercentileTag,
      examPercentileTag,
    });
  } catch (err) {
    console.error('Teacher student detail error:', err);
    res.status(500).json({ error: 'Failed to load student' });
  }
});

// ============================================================================
// 1c. ADMIN: Per-student breakdown â€” every problem attempted and its result
// ============================================================================
// Just identity + the two total scores (see getTotalScores) — no
// percentile tags, no per-assignment attempt history. An admin managing a
// roster needs "how is this student doing overall," not attempt-by-attempt
// forensics; that level of detail still exists per-subject in the teacher
// dashboard's own student detail view (GET /api/teacher/students/:id) for
// whichever teacher actually owns that subject.
app.get('/api/admin/students/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const studentRes = await pool.query(
      `SELECT u.id, u.email, u.name, u.created_at, m.org_unit_id, m.roll_number FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2 AND m.role = 'student'
       WHERE u.id = $1`,
      [req.params.id, req.user.organizationId]
    );
    if (studentRes.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const unitPath = resolveOrgUnitPath(await getOrgUnitLookup(req.user.organizationId), studentRes.rows[0].org_unit_id);

    const totals = await getTotalScores(req.user.organizationId, [req.params.id]);
    const t = totals.get(req.params.id) || { totalAssignmentPercent: null, totalExamPercent: null };

    res.status(200).json({
      student: studentRes.rows[0],
      unitPath,
      totalAssignmentPercent: t.totalAssignmentPercent,
      totalExamPercent: t.totalExamPercent,
    });
  } catch (error) {
    console.error('Student detail error:', error);
    res.status(500).json({ error: 'Failed to load student detail' });
  }
});

// ============================================================================
// LEGACY SCORES — CSV import of pre-platform score history, for
// institutions onboarding after already having a track record. Unlike the
// student roster CSV import above, this never creates accounts or org
// units — every row must match an EXISTING student in this org by email
// (they're expected to already exist, e.g. from that same roster import),
// and just attaches a score to them. See getTotalScores for how these rows
// get blended into "total score" everywhere it's shown.
// ============================================================================
app.get('/api/admin/legacy-scores/csv-template', authenticateToken, requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="legacy-scores-template.csv"');
  res.status(200).send('Email,AcademicYear,AssignmentScorePercent,ExamScorePercent,Notes\n');
});

app.post('/api/admin/legacy-scores/import', authenticateToken, requireAdmin, csvUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });

  let rows;
  try {
    rows = parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not parse CSV file — check it is valid CSV with a header row' });
  }
  if (rows.length === 0) return res.status(400).json({ error: 'CSV has no data rows' });

  const headerKeys = Object.keys(rows[0]);
  const findKey = (name) => headerKeys.find((k) => k.trim().toLowerCase() === name);
  const emailKey = findKey('email');
  const yearKey = findKey('academicyear');
  const assignmentKey = findKey('assignmentscorepercent');
  const examKey = findKey('examscorepercent');
  const notesKey = findKey('notes');
  if (!emailKey || !yearKey) {
    return res.status(400).json({ error: 'CSV must have Email and AcademicYear columns' });
  }

  // A percent cell can be blank (this school might only have exam records
  // for an old year, not assignment records, or vice versa) — blank parses
  // to null, not 0, so a missing score never drags the blended average down.
  const parsePercent = (raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return { value: null };
    const n = Number(trimmed);
    if (Number.isNaN(n) || n < 0 || n > 100) return { error: true };
    return { value: n };
  };

  const results = { imported: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const email = String(row[emailKey] || '').trim();
    const academicYear = String(row[yearKey] || '').trim();

    if (!email) { results.errors.push({ row: rowNum, email, reason: 'Missing email' }); continue; }
    if (!academicYear) { results.errors.push({ row: rowNum, email, reason: 'Missing academic year' }); continue; }

    const assignmentParsed = parsePercent(row[assignmentKey]);
    const examParsed = parsePercent(row[examKey]);
    if (assignmentParsed.error || examParsed.error) {
      results.errors.push({ row: rowNum, email, reason: 'Score percent must be a number between 0 and 100 (or blank)' });
      continue;
    }
    if (assignmentParsed.value == null && examParsed.value == null) {
      results.errors.push({ row: rowNum, email, reason: 'Row has neither an assignment score nor an exam score' });
      continue;
    }

    const studentRes = await pool.query(
      `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE u.email = $1 AND m.organization_id = $2 AND m.role = 'student'`,
      [email, req.user.organizationId]
    );
    if (studentRes.rows.length === 0) {
      results.errors.push({ row: rowNum, email, reason: 'No student with this email in your organization' });
      continue;
    }

    await pool.query(
      `INSERT INTO legacy_scores (organization_id, user_id, academic_year, assignment_score_percent, exam_score_percent, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, user_id, academic_year)
       DO UPDATE SET assignment_score_percent = $4, exam_score_percent = $5, notes = $6`,
      [req.user.organizationId, studentRes.rows[0].id, academicYear, assignmentParsed.value, examParsed.value, notesKey ? (String(row[notesKey] || '').trim() || null) : null]
    );
    results.imported++;
  }

  res.status(200).json(results);
});

// ============================================================================
// 1c-2. ADMIN ONLY: Edit a student's own details — name, class/unit
// placement, roll number. Deliberately requireAdmin, not
// requireAdminOrTeacher — a teacher's authority is scoped to grading
// within their assigned subjects, not to changing a student's identity/
// roster placement. Email is NOT editable here: `users.email` is the
// global-identity key shared across every organization that email belongs
// to (see findOrCreateGlobalUser), so changing it here would rename that
// person's login everywhere, not just within this org — a materially
// different, riskier operation than fixing a name/class typo, and not
// something this route takes on.
// ============================================================================
app.put('/api/admin/students/:id', authenticateToken, requireAdmin, async (req, res) => {
  const studentId = req.params.id;
  const name = req.body.name !== undefined ? (String(req.body.name || '').trim() || null) : undefined;
  const orgUnitId = req.body.orgUnitId !== undefined
    ? (req.body.orgUnitId === null || req.body.orgUnitId === '' ? null : Number(req.body.orgUnitId))
    : undefined;
  const rollNumber = req.body.rollNumber !== undefined ? (String(req.body.rollNumber || '').trim() || null) : undefined;

  try {
    // Scoped to role='student' on purpose, same reasoning as the delete
    // route right below — never lets this touch an admin/teacher account
    // even if a stale/tampered id is passed in. 404, not 403, on a miss so
    // this can't be used to probe which ids exist in another organization.
    const membershipRes = await pool.query(
      `SELECT m.id FROM memberships m WHERE m.user_id = $1 AND m.organization_id = $2 AND m.role = 'student'`,
      [studentId, req.user.organizationId]
    );
    if (membershipRes.rows.length === 0) return res.status(404).json({ error: 'Student not found' });

    if (orgUnitId !== undefined && orgUnitId !== null) {
      const unitCheck = await pool.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
      if (unitCheck.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    }

    if (name !== undefined) {
      await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name, studentId]);
    }
    if (orgUnitId !== undefined || rollNumber !== undefined) {
      // Distinguishes "field not sent at all" (leave unchanged) from
      // "field explicitly sent as null" (clear it, e.g. moving a student
      // back to no unit) via the two boolean flags — a plain COALESCE
      // against the existing value can't tell those apart, since both
      // look identical (a NULL parameter) from SQL's point of view.
      await pool.query(
        `UPDATE memberships SET
           org_unit_id = CASE WHEN $3::boolean THEN $1 ELSE org_unit_id END,
           roll_number = CASE WHEN $4::boolean THEN $2 ELSE roll_number END
         WHERE user_id = $5 AND organization_id = $6`,
        [orgUnitId ?? null, rollNumber ?? null, orgUnitId !== undefined, rollNumber !== undefined, studentId, req.user.organizationId]
      );
    }

    const updated = await pool.query(
      `SELECT u.id, u.email, u.name, m.org_unit_id, m.roll_number FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2
       WHERE u.id = $1`,
      [studentId, req.user.organizationId]
    );
    res.status(200).json({ message: 'Student updated', student: updated.rows[0] });
  } catch (err) {
    console.error('Update student error:', err);
    res.status(500).json({ error: 'Failed to update student' });
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
  const { emailKey, nameKey, rollKey, tierKeys } = splitTierAndIdentityColumns(Object.keys(req.body || {}));
  const email = emailKey ? String(req.body[emailKey] || '').trim() : '';
  const name = nameKey ? String(req.body[nameKey] || '').trim() : '';
  const rollNumber = rollKey ? String(req.body[rollKey] || '').trim() || null : null;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  const client = await pool.connect();
  try {
    const orgRes = await client.query('SELECT id, status, name, default_org_unit_id FROM organizations WHERE webhook_secret = $1', [req.params.webhookSecret]);
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
    const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);

    // ON CONFLICT DO NOTHING means a repeat form submission for someone
    // who's already a member of this org is silently skipped — but a
    // brand-new temporaryPassword above was only ever generated for a
    // brand-new identity, so we must only email it out when BOTH the
    // identity and the membership were newly created this call, or the
    // student gets a password that doesn't match what's actually stored.
    const memberRes = await client.query(
      `INSERT INTO memberships (user_id, organization_id, role, org_unit_id, roll_number) VALUES ($1, $2, 'student', $3, $4)
       ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
      [userId, organizationId, orgUnitId, rollNumber]
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
    await sendStudentWelcomeEmail(email, name, orgRes.rows[0].name, temporaryPassword);

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
// Promotes pending_* into the real columns and marks the subscription
// active — shared by 'activated' and 'charged'. Both events can be the
// one that first confirms a brand-new subscription (Razorpay doesn't
// guarantee 'activated' always arrives before/at all relative to
// 'charged' for every payment method — a UPI/QR-autopay flow in
// particular can go straight to a charge), so both need to be able to do
// this promotion, not just 'activated'. Matches on EITHER column and only
// COALESCEs pending_* in, so it's safe to call from both events in either
// order, and safe against Razorpay redelivering the same event twice.
async function promoteSubscriptionToActive(razorpaySubscriptionId, razorpayPlanId, currentPeriodEnd) {
  const before = await pool.query(
    `SELECT organization_id, pending_plan_key, pending_billing_cycle, billing_cycle,
            (pending_razorpay_subscription_id IS NOT NULL) AS was_pending
     FROM subscriptions WHERE pending_razorpay_subscription_id = $1 OR razorpay_subscription_id = $1`,
    [razorpaySubscriptionId]
  );
  if (before.rows.length === 0) return null;
  const wasPromotion = before.rows[0]?.was_pending === true;
  const isAnnual = before.rows[0]?.pending_billing_cycle === 'annual' || before.rows[0]?.billing_cycle === 'annual';
  const effectivePeriodEnd = currentPeriodEnd || new Date(Date.now() + (isAnnual ? 365 : 30) * 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `UPDATE subscriptions SET
       plan_key = COALESCE(pending_plan_key, plan_key),
       billing_cycle = COALESCE(pending_billing_cycle, billing_cycle, $4),
       razorpay_subscription_id = COALESCE(razorpay_subscription_id, pending_razorpay_subscription_id, $1),
       razorpay_plan_id = COALESCE($2, razorpay_plan_id),
       status = 'active',
       current_period_end = COALESCE($3, current_period_end),
       pending_plan_key = NULL, pending_billing_cycle = NULL, pending_razorpay_subscription_id = NULL,
       updated_at = now()
     WHERE pending_razorpay_subscription_id = $1 OR razorpay_subscription_id = $1
     RETURNING organization_id, plan_key, billing_cycle, status, current_period_end`,
    [razorpaySubscriptionId, razorpayPlanId, effectivePeriodEnd, isAnnual ? 'annual' : 'monthly']
  );
  return result.rows[0] ? { ...result.rows[0], wasPromotion } : null;
}

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
      const org = await promoteSubscriptionToActive(razorpaySubscriptionId, sub.plan_id, currentPeriodEnd);
      if (org?.wasPromotion) await sendBillingEmail(org.organization_id, 'Your subscription is now active', `Your ${PLAN_CATALOG[org.plan_key]?.label || org.plan_key} plan is now active. Thank you!`);
      break;
    }

    case 'subscription.charged': {
      const org = await promoteSubscriptionToActive(razorpaySubscriptionId, sub.plan_id, currentPeriodEnd);
      if (org?.wasPromotion) await sendBillingEmail(org.organization_id, 'Your subscription is now active', `Your ${PLAN_CATALOG[org.plan_key]?.label || org.plan_key} plan is now active. Thank you!`);
      break;
    }

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

// Best-effort billing notification — reuses the same Gmail-send pattern as
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
    const { error } = await sendEmail({ to, subject: `HonorRoll — ${subject}`, text });
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
  const { organizationName, email, password, name, accessCode, acceptedTos } = req.body;
  if (!organizationName || !String(organizationName).trim()) {
    return res.status(400).json({ error: 'Organization name is required' });
  }
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  // Only admins/superadmins self-register through this route — teachers and
  // students are always created BY an admin (see the create-student/
  // create-teacher routes), whose own forms already collect a name, so this
  // is the one signup path that actually needs to ask for it itself.
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Your name is required' });
  }
  // The one place an admin explicitly accepts — teachers/students never see
  // this form at all (their accounts are created BY an admin), so their own
  // acceptance is instead collected on first login (see the
  // requiresTosAcceptance branch in POST /api/login).
  if (!acceptedTos) {
    return res.status(400).json({ error: 'You must accept the Terms of Service and Privacy Policy to continue' });
  }
  // Gates institution creation up front instead of the old flow (create as
  // 'pending', wait for a platform owner to separately hit POST
  // /api/platform/organizations/:id/approve) — that route still exists for
  // any leftover pending rows, but nothing new gets left in that state.
  // Fails closed if the secret was never configured, same posture as
  // requirePlatformSecret above.
  if (!process.env.PLATFORM_OWNER_SECRET || accessCode !== process.env.PLATFORM_OWNER_SECRET) {
    return res.status(403).json({ error: "Invalid or missing access code. If you don't have one, the highest authority at your institution must contact honorroll.admin@gmail.com to request one." });
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
    const existing = await client.query('SELECT id, password_hash, name FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      const isMatch = await bcrypt.compare(password, existing.rows[0].password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'An account with this email already exists with a different password' });
      }
    }

    await client.query('BEGIN');

    // The access code above already proves institutional legitimacy, so
    // this org starts life 'approved' rather than 'pending' — email
    // verification (email_verified_at) is the one remaining gate, just
    // confirming they actually own the address they typed. Raw token goes
    // out in the email; only its hash is ever stored, same pattern as the
    // password-reset flow further down this file.
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationTokenHash = crypto.createHash('sha256').update(verificationToken).digest('hex');

    const webhookSecret = crypto.randomBytes(16).toString('hex');
    const orgRes = await client.query(
      `INSERT INTO organizations (name, webhook_secret, status, email_domain, verification_token_hash, verification_token_expiry)
       VALUES ($1, $2, 'approved', $3, $4, now() + interval '24 hours') RETURNING id, name`,
      [organizationName.trim(), webhookSecret, emailDomain, verificationTokenHash]
    );
    const org = orgRes.rows[0];

    // Reuses the matched existing identity's password untouched if one
    // exists; only hashes+stores the supplied password for a brand-new one.
    // COALESCE on the update so a pre-existing name (e.g. they're already a
    // student elsewhere) is never clobbered by this signup's name field.
    let userId;
    let effectiveName;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      effectiveName = existing.rows[0].name || name.trim();
      // COALESCE on tos_accepted_at too — if they'd already accepted (e.g.
      // as a student elsewhere), this signup shouldn't need to re-collect
      // it, but it must still be set for an identity that somehow reached
      // here without ever accepting.
      await client.query('UPDATE users SET name = COALESCE(name, $1), tos_accepted_at = COALESCE(tos_accepted_at, now()) WHERE id = $2', [name.trim(), userId]);
    } else {
      effectiveName = name.trim();
      userId = (await client.query(
        'INSERT INTO users (email, password_hash, name, tos_accepted_at) VALUES ($1, $2, $3, now()) RETURNING id',
        [email, await bcrypt.hash(password, 10), name.trim()]
      )).rows[0].id;
    }

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
    const { error: emailError } = await sendEmail({
      to: email,
      subject: 'Confirm your HonorRoll organization',
      text: `Hello,\n\nPlease confirm you own this email address to continue setting up "${org.name}" on HonorRoll:\n\n${verifyLink}\n\nThis link expires in 24 hours. You can already sign in and start building your organization's structure — but you'll need to confirm this email, and have your organization approved, before you can add students.`,
    });
    if (emailError) console.error('Verification email failed to send:', emailError);

    const token = jwt.sign(
      { userId, role: 'admin', organizationId: org.id, orgUnitId: null },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRATION || '24h' }
    );

    res.status(201).json({
      message: 'Organization created and approved — you can start adding students right away. Check your email when you get a chance to confirm your address.',
      token,
      user: { id: userId, email, role: 'admin', name: effectiveName, organization_name: org.name },
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
// only email_verified_at — status is already 'approved' by the time this
// runs (see the access-code gate on signup above); this route and the
// separate platform-owner approval routes further down only still matter
// for whatever pending orgs predate that change.
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

// A teacher/student account is always created BY an admin (CSV import, the
// manual add form, the Google Form webhook) — none of those ask the person
// themselves to accept the Terms of Service/Privacy Policy the way the
// admin signup form does. Their own first login is the only moment left to
// collect it, so both login-completion points below (the single-membership
// fast path and POST /api/login/select-organization) hold the real token
// back and mint one of these instead when role is teacher/student and
// tos_accepted_at is still null. It carries the exact same membership
// claims a real session token would (type:'tos-pending' aside) so POST
// /api/login/accept-tos can mint the real one straight from it without a
// second DB round trip to re-derive role/org. authenticateToken already
// refuses any type !== undefined token on real routes, same as 'preauth'.
function mintTosPendingToken(membership) {
  return jwt.sign(
    {
      type: 'tos-pending',
      userId: membership.user_id,
      role: membership.role,
      organizationId: membership.organization_id,
      orgUnitId: membership.org_unit_id ?? null,
    },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
}

// ============================================================================
// SUPERADMIN — platform-owner visibility across every organization. Built
// as impersonation rather than a parallel set of cross-org query routes:
// picking an org mints a completely ordinary admin session token for it
// (via the exact same mintSessionToken() every real admin login uses), so
// the entire existing AdminDashboard/StudentsPanel/BillingPanel/etc. UI and
// every backend route work unmodified — there is no second code path to
// keep in sync as the app grows. The superadmin's own user id is reused
// directly as the "admin" in that session; it needs no real membership row
// in the target org because nothing downstream checks for one — every
// admin-gated route trusts the JWT's role/organizationId claims alone.
// ============================================================================
app.get('/api/superadmin/organizations', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        o.id, o.name, o.status, o.created_at,
        COALESCE(sub.plan_key, 'free') AS plan_key,
        COALESCE(sub.status, 'free') AS billing_status,
        (SELECT COUNT(*)::int FROM memberships m WHERE m.organization_id = o.id AND m.role = 'student') AS student_count,
        (SELECT COUNT(*)::int FROM memberships m WHERE m.organization_id = o.id AND m.role = 'teacher') AS teacher_count,
        (SELECT COALESCE(json_agg(json_build_object('user_id', u.id, 'name', u.name, 'email', u.email) ORDER BY u.name), '[]'::json)
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = o.id AND m.role = 'admin') AS admins
      FROM organizations o
      LEFT JOIN subscriptions sub ON sub.organization_id = o.id
      ORDER BY o.created_at DESC
    `);
    const organizations = result.rows;

    // Platform-wide totals — computed here in JS from the same rows rather
    // than a second query, since every input is already in `organizations`.
    // Deliberately not a database-level aggregate: this whole route is
    // "everything a superadmin needs on one screen" (see this route's own
    // comment further down about not building a parallel per-org UI), and
    // that includes the top-line numbers, not just the row-by-row table.
    const summary = {
      totalOrganizations: organizations.length,
      totalStudents: organizations.reduce((sum, o) => sum + o.student_count, 0),
      totalTeachers: organizations.reduce((sum, o) => sum + o.teacher_count, 0),
      planBreakdown: organizations.reduce((acc, o) => { acc[o.plan_key] = (acc[o.plan_key] || 0) + 1; return acc; }, {}),
      billingStatusBreakdown: organizations.reduce((acc, o) => { acc[o.billing_status] = (acc[o.billing_status] || 0) + 1; return acc; }, {}),
    };

    res.status(200).json({ organizations, summary });
  } catch (err) {
    console.error('Superadmin list organizations error:', err);
    res.status(500).json({ error: 'Failed to load organizations' });
  }
});

// Superadmin lifecycle control over an organization's status — the
// dashboard-accessible counterpart to the curl-only /api/platform/
// organizations/:id/approve|reject routes above, plus two states those
// never had: reverting an approved org back to 'pending' ("unapprove"),
// and 'terminated' — a full blacklist that also blocks login for every
// existing member (see the org-status check in POST /api/login), not just
// new roster growth the way pending/rejected do. Each route just sets the
// target status outright regardless of the org's current one, since a
// superadmin has standing authority to move any org to any state (e.g.
// reinstating a terminated org also goes through /approve).
async function setOrganizationStatus(orgId, status, actorEmail) {
  const result = await pool.query(
    `UPDATE organizations SET status = $1, approved_at = now(), approved_by = $2 WHERE id = $3 RETURNING id, name, status`,
    [status, actorEmail, orgId]
  );
  return result.rows[0] || null;
}

function makeSetOrgStatusRoute(status, actionLabel) {
  return async (req, res) => {
    try {
      const actorRes = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.userId]);
      const org = await setOrganizationStatus(req.params.id, status, actorRes.rows[0]?.email || 'superadmin');
      if (!org) return res.status(404).json({ error: 'Organization not found' });
      res.status(200).json({ organization: org });
    } catch (err) {
      console.error(`Superadmin ${actionLabel} organization error:`, err);
      res.status(500).json({ error: `Failed to ${actionLabel} organization` });
    }
  };
}

app.post('/api/superadmin/organizations/:id/approve', authenticateToken, requireSuperadmin, makeSetOrgStatusRoute('approved', 'approve'));
app.post('/api/superadmin/organizations/:id/unapprove', authenticateToken, requireSuperadmin, makeSetOrgStatusRoute('pending', 'unapprove'));
app.post('/api/superadmin/organizations/:id/reject', authenticateToken, requireSuperadmin, makeSetOrgStatusRoute('rejected', 'reject'));
app.post('/api/superadmin/organizations/:id/terminate', authenticateToken, requireSuperadmin, makeSetOrgStatusRoute('terminated', 'terminate'));

// ============================================================================
// PERMANENT DELETION — irreversible. Everything below exists to back one
// guarantee: the institution's admin(s) always have a full copy of their
// data in hand before any of it is destroyed, and if that copy can't be
// delivered (Gmail unconfigured, send failure, no recipient), nothing gets
// deleted at all. See DELETE /api/superadmin/organizations/:id further down
// for how these three pieces (export, zip, delete) are actually sequenced.
// ============================================================================

// Tables with their own organization_id column — the direct slice of "this
// institution's data". Everything else that belongs to the org (test cases,
// submissions, exam attempts, ...) is reached transitively through these,
// via problem_id/exam_id/subject_id — see exportOrganizationData below.
const DIRECT_ORG_TABLES = [
  'memberships', 'org_level_defs', 'org_units', 'subjects', 'problems', 'exams',
  'grade_bands', 'tag_visibility_settings', 'profile_change_requests',
  'admin_requests', 'legacy_scores', 'subscriptions',
];

// Read-only snapshot of every row this organization owns, shaped as
// { tableName: rows[] } — one JSON file per table once zipped. Deliberately
// never touches users.password_hash: `roster` is a name/email/role view
// joined from memberships instead of a raw users dump, since users is a
// global identity that may still have accounts elsewhere.
async function exportOrganizationData(orgId) {
  const data = {};
  data.organization = (await pool.query('SELECT * FROM organizations WHERE id = $1', [orgId])).rows;

  for (const table of DIRECT_ORG_TABLES) {
    data[table] = (await pool.query(`SELECT * FROM ${table} WHERE organization_id = $1`, [orgId])).rows;
  }

  data.roster = (await pool.query(
    `SELECT u.id AS user_id, u.email, u.name, m.role, m.org_unit_id, m.roll_number, m.created_at AS member_since
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1`,
    [orgId]
  )).rows;

  const subjectIds = data.subjects.map((s) => s.id);
  data.subject_teachers = subjectIds.length
    ? (await pool.query('SELECT * FROM subject_teachers WHERE subject_id = ANY($1)', [subjectIds])).rows
    : [];

  const problemIds = data.problems.map((p) => p.id);
  if (problemIds.length) {
    data.test_cases = (await pool.query('SELECT * FROM test_cases WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.starter_code = (await pool.query('SELECT * FROM starter_code WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.problem_time_logs = (await pool.query('SELECT * FROM problem_time_logs WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.submissions = (await pool.query('SELECT * FROM submissions WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.scan_assignment_questions = (await pool.query('SELECT * FROM scan_assignment_questions WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.scan_submissions = (await pool.query('SELECT * FROM scan_submissions WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.scan_plagiarism_flags = (await pool.query('SELECT * FROM scan_plagiarism_flags WHERE problem_id = ANY($1)', [problemIds])).rows;
  } else {
    data.test_cases = []; data.starter_code = []; data.problem_time_logs = [];
    data.submissions = []; data.scan_assignment_questions = []; data.scan_submissions = [];
    data.scan_plagiarism_flags = [];
  }

  const scanSubmissionIds = data.scan_submissions.map((s) => s.id);
  if (scanSubmissionIds.length) {
    data.scan_submission_answers = (await pool.query('SELECT * FROM scan_submission_answers WHERE submission_id = ANY($1)', [scanSubmissionIds])).rows;
    data.scan_handwriting_flags = (await pool.query(
      'SELECT * FROM scan_handwriting_flags WHERE submission_a_id = ANY($1) OR submission_b_id = ANY($1)', [scanSubmissionIds]
    )).rows;
  } else {
    data.scan_submission_answers = []; data.scan_handwriting_flags = [];
  }

  const examIds = data.exams.map((e) => e.id);
  if (examIds.length) {
    data.exam_items = (await pool.query('SELECT * FROM exam_items WHERE exam_id = ANY($1)', [examIds])).rows;
    data.exam_attempts = (await pool.query('SELECT * FROM exam_attempts WHERE exam_id = ANY($1)', [examIds])).rows;
  } else {
    data.exam_items = []; data.exam_attempts = [];
  }

  const attemptIds = data.exam_attempts.map((a) => a.id);
  if (attemptIds.length) {
    data.exam_answers = (await pool.query('SELECT * FROM exam_answers WHERE attempt_id = ANY($1)', [attemptIds])).rows;
    data.exam_proctor_flags = (await pool.query('SELECT * FROM exam_proctor_flags WHERE attempt_id = ANY($1)', [attemptIds])).rows;
    data.exam_scan_answers = (await pool.query('SELECT * FROM exam_scan_answers WHERE attempt_id = ANY($1)', [attemptIds])).rows;
  } else {
    data.exam_answers = []; data.exam_proctor_flags = []; data.exam_scan_answers = [];
  }

  return data;
}

// One JSON file per table, zipped in memory — small enough for any one
// institution's data that streaming to disk first isn't worth the extra
// moving part.
function buildZipBuffer(data) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const [table, rows] of Object.entries(data)) {
      archive.append(JSON.stringify(rows, null, 2), { name: `${table}.json` });
    }
    archive.finalize();
  });
}

// The actual destructive part — only ever called after the export above has
// already been emailed out successfully (see the route below). Explicit,
// ordered DELETEs rather than relying on cascade: several org-scoped tables
// (exams, problems, grade_bands, tag_visibility_settings) use ON DELETE NO
// ACTION on organization_id, not CASCADE, so a bare `DELETE FROM
// organizations` would fail outright with a foreign-key violation. org_units
// deletes as one whole-subtree statement despite its self-referential
// parent_unit_id RESTRICT — Postgres checks RESTRICT/NO ACTION constraints
// at the end of the statement, against what's left standing, not per row
// against rows that are about to disappear in the same statement — so
// deleting every row for this org in one DELETE is safe as long as subjects
// (which RESTRICTs org_units) goes first, and org_level_defs (RESTRICTed by
// org_units) goes after. Everything else CASCADEs from organizations.id and
// needs no explicit statement of its own.
async function deleteOrganizationData(client, orgId) {
  // Legacy, unused-since-the-memberships-cutover column (see
  // ensureMembershipsSchema's own comment) — NO ACTION on organizations.id,
  // so it has to be cleared, not left dangling, before the org row can go.
  await client.query('UPDATE users SET organization_id = NULL WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM exams WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM problems WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM subjects WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM org_units WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM org_level_defs WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM grade_bands WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM tag_visibility_settings WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);
}

app.delete('/api/superadmin/organizations/:id', authenticateToken, requireSuperadmin, async (req, res) => {
  const orgId = req.params.id;
  try {
    const orgRes = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    const org = orgRes.rows[0];

    const data = await exportOrganizationData(orgId);
    const zipBuffer = await buildZipBuffer(data);

    // Every admin of this org gets the archive. If it somehow has none,
    // falls back to the superadmin performing the deletion, so the archive
    // is never just silently dropped for lack of a mailbox to put it in.
    const adminRes = await pool.query(
      `SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 AND m.role = 'admin' AND u.email IS NOT NULL`,
      [orgId]
    );
    let recipients = adminRes.rows.map((r) => r.email).filter(Boolean);
    if (recipients.length === 0) {
      const actorRes = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.userId]);
      if (actorRes.rows[0]?.email) recipients = [actorRes.rows[0].email];
    }
    if (recipients.length === 0) {
      return res.status(500).json({ error: 'No recipient found for the data archive — deletion aborted' });
    }

    const zipFilename = `${org.name.replace(/[^a-z0-9]+/gi, '_')}_data_export.zip`;
    // The one hard rule this whole route exists to enforce: deletion only
    // proceeds once every recipient has actually received the archive. Any
    // send failure (Gmail unconfigured, API error, etc.) aborts before a
    // single row is touched.
    const sendResults = await Promise.all(recipients.map((to) => sendEmail({
      to,
      subject: `HonorRoll — ${org.name} data export (institution deleted)`,
      text: `Attached is a full export of ${org.name}'s data on HonorRoll, taken immediately before permanent deletion by the platform owner.\n\nThis institution's account, roster, assignments, exams, and all related records have now been permanently removed from HonorRoll and cannot be recovered — this archive is the only remaining copy.\n\n— HonorRoll`,
      attachments: [{ filename: zipFilename, content: zipBuffer, contentType: 'application/zip' }],
    })));
    const failed = sendResults.find((r) => r.error);
    if (failed) {
      console.error('Organization data export email failed, aborting deletion:', failed.error);
      return res.status(502).json({ error: 'Failed to email the data export — deletion aborted, nothing was deleted' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await deleteOrganizationData(client, orgId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(200).json({ message: `${org.name} and all its data have been permanently deleted. A full export was emailed to ${recipients.join(', ')}.` });
  } catch (err) {
    console.error('Superadmin delete organization error:', err);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
});

// Global user search across every organization — lets a superadmin jump
// straight to "which org(s) is this person in" instead of impersonating
// into each org one at a time to look. Read-only by design: it never
// exposes a way to edit anyone directly at this scope, only to see where
// they are — actually altering a student's details still goes through the
// exact same admin-side StudentDetailPanel edit flow every real admin
// uses, reached by impersonating into the right org first (see POST
// /api/superadmin/organizations/:id/impersonate right below).
app.get('/api/superadmin/users', authenticateToken, requireSuperadmin, async (req, res) => {
  const search = String(req.query.search || '').trim();
  if (search.length < 2) return res.status(200).json({ users: [] });
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.name,
              COALESCE((
                SELECT json_agg(json_build_object('organizationId', m.organization_id, 'organizationName', o.name, 'role', m.role) ORDER BY o.name)
                FROM memberships m JOIN organizations o ON o.id = m.organization_id
                WHERE m.user_id = u.id
              ), '[]') AS memberships
       FROM users u
       WHERE (u.email ILIKE $1 OR u.name ILIKE $1)
         AND EXISTS (SELECT 1 FROM memberships m2 WHERE m2.user_id = u.id)
       ORDER BY u.email ASC
       LIMIT 50`,
      [`%${search}%`]
    );
    res.status(200).json({ users: result.rows });
  } catch (err) {
    console.error('Superadmin user search error:', err);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// ============================================================================
// ADMIN: PROFILE CHANGE REQUESTS
// Student roster correction requests for this organization.
// ============================================================================
app.get('/api/admin/profile-change-requests', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const statusParam = req.query.status;
    const allowed = ['pending', 'escalated', 'approved', 'rejected'];
    const status = allowed.includes(statusParam) ? statusParam : 'pending';
    const params = [req.user.organizationId];
    let where = 'WHERE r.organization_id = $1';
    if (statusParam !== 'all') {
      params.push(status);
      where += ' AND r.status = $2';
    }
    const result = await pool.query(
      `SELECT r.id, r.field, r.current_value, r.requested_value, r.reason, r.status,
              r.review_note, r.reviewed_at, r.created_at, r.escalated_at, r.escalation_note,
              u.id AS student_id, u.email AS student_email, u.name AS student_name,
              m.roll_number
       FROM profile_change_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN memberships m ON m.user_id = u.id AND m.organization_id = r.organization_id
       ${where}
       ORDER BY r.created_at DESC`,
      params
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('Admin list profile change requests error:', err);
    res.status(500).json({ error: 'Failed to load profile change requests' });
  }
});

app.post('/api/admin/profile-change-requests/:id/review', authenticateToken, requireAdmin, async (req, res) => {
  const action = req.body.action || req.body.status;
  if (!['approved', 'rejected', 'escalated'].includes(action)) {
    return res.status(400).json({ error: "action must be 'approved', 'rejected', or 'escalated'" });
  }
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;

  try {
    const reqRes = await pool.query(
      `SELECT r.*, u.name AS student_name, u.email AS student_email, o.name AS organization_name
       FROM profile_change_requests r
       JOIN users u ON u.id = r.user_id
       JOIN organizations o ON o.id = r.organization_id
       WHERE r.id = $1 AND r.organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = reqRes.rows[0];
    if (request.status !== 'pending') {
      return res.status(409).json({ error: 'This request was already reviewed or escalated' });
    }

    if (action === 'approved') {
      const normalizedField = request.field.trim().toLowerCase().replace(/\s+/g, '_');
      if (normalizedField === 'name') {
        await pool.query('UPDATE users SET name = $1 WHERE id = $2', [request.requested_value, request.user_id]);
      } else if (normalizedField === 'roll_number' || normalizedField === 'rollnumber') {
        await pool.query(
          'UPDATE memberships SET roll_number = $1 WHERE user_id = $2 AND organization_id = $3',
          [request.requested_value, request.user_id, request.organization_id]
        );
      }

      const result = await pool.query(
        `UPDATE profile_change_requests
         SET status = 'approved', reviewed_by = $1, reviewed_at = now(), review_note = $2
         WHERE id = $3 RETURNING id, status, review_note, reviewed_at`,
        [req.user.userId, note, req.params.id]
      );

      // Best-effort notification to student
      const { error: mailErr } = await sendEmail({
        to: request.student_email,
        subject: 'HonorRoll — Info Change Request Approved',
        text: `Hello ${request.student_name || 'Student'},\n\nYour request to change "${request.field}" to "${request.requested_value}" has been approved by your administrator.${note ? `\n\nNote: ${note}` : ''}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Student info change approval email error:', mailErr);

      return res.status(200).json({ request: result.rows[0] });
    }

    if (action === 'rejected') {
      const result = await pool.query(
        `UPDATE profile_change_requests
         SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), review_note = $2
         WHERE id = $3 RETURNING id, status, review_note, reviewed_at`,
        [req.user.userId, note, req.params.id]
      );

      // Best-effort notification to student
      const { error: mailErr } = await sendEmail({
        to: request.student_email,
        subject: 'HonorRoll — Info Change Request Update',
        text: `Hello ${request.student_name || 'Student'},\n\nYour request to change "${request.field}" was reviewed and rejected by your administrator.${note ? `\n\nReason: ${note}` : ''}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Student info change rejection email error:', mailErr);

      return res.status(200).json({ request: result.rows[0] });
    }

    if (action === 'escalated') {
      const result = await pool.query(
        `UPDATE profile_change_requests
         SET status = 'escalated', escalated_by = $1, escalated_at = now(), escalation_note = $2
         WHERE id = $3 RETURNING id, status, escalation_note, escalated_at`,
        [req.user.userId, note, req.params.id]
      );

      // Superadmin only receives emails from admins — notify superadmin of escalated request
      const adminUserRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]);
      const adminName = adminUserRes.rows[0]?.name || 'Administrator';
      const adminEmail = adminUserRes.rows[0]?.email || 'admin';
      const superadminTarget = getSuperadminEmails()[0] || 'honorroll.admin@gmail.com';

      const { error: mailErr } = await sendEmail({
        to: superadminTarget,
        subject: `Escalated Student Info Change Request — ${request.organization_name}`,
        text: `An administrator has escalated a student info change request to the superadmin queue:\n\nAdministrator: ${adminName} <${adminEmail}>\nOrganization: ${request.organization_name}\n\nStudent: ${request.student_name || 'Student'} <${request.student_email}>\nField: ${request.field}\nCurrent Value: ${request.current_value || '(none)'}\nRequested Value: ${request.requested_value}\nStudent Reason: ${request.reason || '(none)'}\n\nAdmin Escalation Note:\n${note || '(none)'}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Escalation email to superadmin error:', mailErr);

      return res.status(200).json({ request: result.rows[0] });
    }
  } catch (err) {
    console.error('Admin review profile change request error:', err);
    res.status(500).json({ error: 'Failed to review request' });
  }
});

// Student profile-correction requests escalated by institution admins to superadmin.
// Defaults to escalated queue (?status=escalated); pass ?status=all to view full history.
app.get('/api/superadmin/profile-change-requests', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const statusParam = req.query.status;
    const allowed = ['escalated', 'pending', 'approved', 'rejected'];
    const status = allowed.includes(statusParam) ? statusParam : 'escalated';
    const params = [];
    let where = '';
    if (statusParam !== 'all') {
      params.push(status);
      where = 'WHERE r.status = $1';
    }
    const result = await pool.query(
      `SELECT r.id, r.field, r.current_value, r.requested_value, r.reason, r.status, r.review_note, r.reviewed_at, r.created_at,
              r.escalated_at, r.escalation_note,
              u.id AS student_id, u.email AS student_email, u.name AS student_name,
              o.id AS organization_id, o.name AS organization_name,
              esc.name AS escalated_by_name, esc.email AS escalated_by_email
       FROM profile_change_requests r
       JOIN users u ON u.id = r.user_id
       JOIN organizations o ON o.id = r.organization_id
       LEFT JOIN users esc ON esc.id = r.escalated_by
       ${where}
       ORDER BY COALESCE(r.escalated_at, r.created_at) DESC`,
      params
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('Superadmin list profile change requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// Superadmin review for escalated requests. On approval, 'name' or 'roll_number' are auto-applied to the DB.
app.post('/api/superadmin/profile-change-requests/:id/review', authenticateToken, requireSuperadmin, async (req, res) => {
  const status = req.body.status === 'approved' || req.body.status === 'rejected' ? req.body.status : null;
  if (!status) return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;

  try {
    const reqRes = await pool.query(
      `SELECT r.*, u.name AS student_name, u.email AS student_email, o.name AS organization_name
       FROM profile_change_requests r
       JOIN users u ON u.id = r.user_id
       JOIN organizations o ON o.id = r.organization_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = reqRes.rows[0];
    if (request.status === 'approved' || request.status === 'rejected') {
      return res.status(409).json({ error: 'This request was already reviewed' });
    }

    if (status === 'approved') {
      const normalizedField = request.field.trim().toLowerCase().replace(/\s+/g, '_');
      if (normalizedField === 'name') {
        await pool.query('UPDATE users SET name = $1 WHERE id = $2', [request.requested_value, request.user_id]);
      } else if (normalizedField === 'roll_number' || normalizedField === 'rollnumber') {
        await pool.query(
          'UPDATE memberships SET roll_number = $1 WHERE user_id = $2 AND organization_id = $3',
          [request.requested_value, request.user_id, request.organization_id]
        );
      }
    }

    const result = await pool.query(
      `UPDATE profile_change_requests SET status = $1, reviewed_by = $2, reviewed_at = now(), review_note = $3
       WHERE id = $4 RETURNING id, status, review_note, reviewed_at`,
      [status, req.user.userId, note, req.params.id]
    );

    // Notify student of outcome
    const { error: mailErr } = await sendEmail({
      to: request.student_email,
      subject: `HonorRoll — Info Change Request ${status === 'approved' ? 'Approved' : 'Update'}`,
      text: `Hello ${request.student_name || 'Student'},\n\nYour request to change "${request.field}" to "${request.requested_value}" has been ${status === 'approved' ? 'approved' : 'rejected'}.${note ? `\n\nNote: ${note}` : ''}\n\n— HonorRoll`,
    });
    if (mailErr) console.error('Superadmin review notification email error:', mailErr);

    res.status(200).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Review profile change request error:', err);
    res.status(500).json({ error: 'Failed to review request' });
  }
});

// An institution admin's own message to the platform owner — no student
// record required, unlike the profile-change-request escalation path above.
app.post('/api/admin/requests', authenticateToken, requireAdmin, async (req, res) => {
  const subject = String(req.body.subject || '').trim();
  const message = String(req.body.message || '').trim();
  if (!subject) return res.status(400).json({ error: 'subject is required' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const result = await pool.query(
      `INSERT INTO admin_requests (organization_id, admin_user_id, subject, message)
       VALUES ($1, $2, $3, $4) RETURNING id, subject, message, status, created_at`,
      [req.user.organizationId, req.user.userId, subject, message]
    );

    const [adminRes, orgRes] = await Promise.all([
      pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]),
      pool.query('SELECT name FROM organizations WHERE id = $1', [req.user.organizationId]),
    ]);
    const adminName = adminRes.rows[0]?.name || 'Administrator';
    const adminEmail = adminRes.rows[0]?.email || '';
    const orgName = orgRes.rows[0]?.name || 'Unknown organization';
    const superadminTarget = getSuperadminEmails()[0] || 'honorroll.admin@gmail.com';

    const { error: mailErr } = await sendEmail({
      to: superadminTarget,
      subject: `Admin Request — ${orgName}: ${subject}`,
      text: `${adminName} <${adminEmail}> from ${orgName} sent a request:\n\nSubject: ${subject}\n\n${message}\n\n— HonorRoll`,
    });
    if (mailErr) console.error('Admin request notification email error:', mailErr);

    res.status(201).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Create admin request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// An admin's own history of requests to the platform owner.
app.get('/api/admin/requests', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, subject, message, status, response_note, resolved_at, created_at
       FROM admin_requests WHERE organization_id = $1 ORDER BY created_at DESC`,
      [req.user.organizationId]
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('List admin requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// Every admin-originated request across the platform. Defaults to the open
// queue (?status=open); pass ?status=all for full history.
app.get('/api/superadmin/requests', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const statusParam = req.query.status;
    const status = statusParam === 'resolved' ? 'resolved' : 'open';
    const params = [];
    let where = '';
    if (statusParam !== 'all') {
      params.push(status);
      where = 'WHERE r.status = $1';
    }
    const result = await pool.query(
      `SELECT r.id, r.subject, r.message, r.status, r.response_note, r.resolved_at, r.created_at,
              u.name AS admin_name, u.email AS admin_email,
              o.id AS organization_id, o.name AS organization_name
       FROM admin_requests r
       JOIN users u ON u.id = r.admin_user_id
       JOIN organizations o ON o.id = r.organization_id
       ${where}
       ORDER BY r.created_at DESC`,
      params
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('Superadmin list admin requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// Marks an admin request resolved, with an optional note the admin sees back.
app.post('/api/superadmin/requests/:id/resolve', authenticateToken, requireSuperadmin, async (req, res) => {
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;
  try {
    const reqRes = await pool.query(
      `SELECT r.*, u.name AS admin_name, u.email AS admin_email
       FROM admin_requests r JOIN users u ON u.id = r.admin_user_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = reqRes.rows[0];
    if (request.status === 'resolved') return res.status(409).json({ error: 'This request was already resolved' });

    const result = await pool.query(
      `UPDATE admin_requests SET status = 'resolved', resolved_by = $1, resolved_at = now(), response_note = $2
       WHERE id = $3 RETURNING id, status, response_note, resolved_at`,
      [req.user.userId, note, req.params.id]
    );

    if (request.admin_email) {
      const { error: mailErr } = await sendEmail({
        to: request.admin_email,
        subject: `HonorRoll — Your request "${request.subject}" was resolved`,
        text: `Hello ${request.admin_name || 'Administrator'},\n\nYour request "${request.subject}" has been marked resolved.${note ? `\n\nResponse: ${note}` : ''}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Admin request resolution email error:', mailErr);
    }

    res.status(200).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Resolve admin request error:', err);
    res.status(500).json({ error: 'Failed to resolve request' });
  }
});

// Public — the /contact page's submit target. No auth at all, unlike every
// other request/message route in this file: a prospective institution
// filling this out has no account yet. Rate-limited like every other
// public unauthenticated endpoint (see authLimiter's app.use registration
// near the top of this file) so it can't be used as an open spam relay.
app.post('/api/contact', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const mobile = String(req.body.mobile || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const message = String(req.body.message || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!mobile) return res.status(400).json({ error: 'Mobile number is required' });
  if (!email) return res.status(400).json({ error: 'Email is required' });
  if (!message) return res.status(400).json({ error: 'Message is required' });
  // Same "won't stop a typo, will stop garbage" bar as every other
  // free-text field in this app — no email deliverability is ever
  // verified beyond this shape check.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });

  try {
    const result = await pool.query(
      `INSERT INTO contact_messages (name, mobile, email, message) VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [name, mobile, email, message]
    );

    const superadminTarget = getSuperadminEmails()[0] || 'honorroll.admin@gmail.com';
    const { error: mailErr } = await sendEmail({
      to: superadminTarget,
      subject: `HonorRoll — New contact message from ${name}`,
      text: `${name} <${email}> (${mobile}) sent a message via the public contact form:\n\n${message}\n\n— HonorRoll`,
    });
    if (mailErr) console.error('Contact message notification email error:', mailErr);

    res.status(201).json({ message: 'Thanks — we\'ll be in touch soon.', id: result.rows[0].id });
  } catch (err) {
    console.error('Create contact message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.get('/api/superadmin/contact-messages', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const statusParam = req.query.status;
    const status = statusParam === 'resolved' ? 'resolved' : 'open';
    const params = [];
    let where = '';
    if (statusParam !== 'all') {
      params.push(status);
      where = 'WHERE status = $1';
    }
    const result = await pool.query(
      `SELECT id, name, mobile, email, message, status, response_note, resolved_at, created_at
       FROM contact_messages ${where} ORDER BY created_at DESC`,
      params
    );
    res.status(200).json({ messages: result.rows });
  } catch (err) {
    console.error('Superadmin list contact messages error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

app.post('/api/superadmin/contact-messages/:id/resolve', authenticateToken, requireSuperadmin, async (req, res) => {
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;
  try {
    const msgRes = await pool.query('SELECT * FROM contact_messages WHERE id = $1', [req.params.id]);
    if (msgRes.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
    if (msgRes.rows[0].status === 'resolved') return res.status(409).json({ error: 'This message was already resolved' });

    const result = await pool.query(
      `UPDATE contact_messages SET status = 'resolved', resolved_by = $1, resolved_at = now(), response_note = $2
       WHERE id = $3 RETURNING id, status, response_note, resolved_at`,
      [req.user.userId, note, req.params.id]
    );
    res.status(200).json({ message: result.rows[0] });
  } catch (err) {
    console.error('Resolve contact message error:', err);
    res.status(500).json({ error: 'Failed to resolve message' });
  }
});

// An admin's structured request to have someone else added as a co-admin
// of their own org — see ensureAddAdminRequestsSchema's own comment for why
// this needs its own table instead of the free-form admin_requests above.
app.post('/api/admin/add-admin-requests', authenticateToken, requireAdmin, async (req, res) => {
  const newAdminName = req.body.name != null ? String(req.body.name).trim() || null : null;
  const newAdminEmail = String(req.body.email || '').trim().toLowerCase();
  if (!newAdminEmail) return res.status(400).json({ error: 'email is required' });

  try {
    const result = await pool.query(
      `INSERT INTO add_admin_requests (organization_id, requested_by, new_admin_name, new_admin_email)
       VALUES ($1, $2, $3, $4) RETURNING id, new_admin_name, new_admin_email, status, created_at`,
      [req.user.organizationId, req.user.userId, newAdminName, newAdminEmail]
    );

    const [requesterRes, orgRes] = await Promise.all([
      pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]),
      pool.query('SELECT name FROM organizations WHERE id = $1', [req.user.organizationId]),
    ]);
    const requesterName = requesterRes.rows[0]?.name || 'An administrator';
    const requesterEmail = requesterRes.rows[0]?.email || '';
    const orgName = orgRes.rows[0]?.name || 'Unknown organization';
    const superadminTarget = getSuperadminEmails()[0] || 'honorroll.admin@gmail.com';

    const { error: mailErr } = await sendEmail({
      to: superadminTarget,
      subject: `Add-admin request — ${orgName}`,
      text: `${requesterName} <${requesterEmail}> from ${orgName} asked to have another admin added:\n\nName: ${newAdminName || '(not given)'}\nEmail: ${newAdminEmail}\n\n— HonorRoll`,
    });
    if (mailErr) console.error('Add-admin request notification email error:', mailErr);

    res.status(201).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Create add-admin request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

app.get('/api/admin/add-admin-requests', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, new_admin_name, new_admin_email, status, review_note, reviewed_at, created_at
       FROM add_admin_requests WHERE organization_id = $1 ORDER BY created_at DESC`,
      [req.user.organizationId]
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('List add-admin requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

app.get('/api/superadmin/add-admin-requests', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const statusParam = req.query.status;
    const status = statusParam === 'pending' ? 'pending' : null;
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = 'WHERE r.status = $1';
    }
    const result = await pool.query(
      `SELECT r.id, r.new_admin_name, r.new_admin_email, r.status, r.review_note, r.reviewed_at, r.created_at,
              u.name AS requested_by_name, u.email AS requested_by_email,
              o.id AS organization_id, o.name AS organization_name
       FROM add_admin_requests r
       JOIN users u ON u.id = r.requested_by
       JOIN organizations o ON o.id = r.organization_id
       ${where}
       ORDER BY r.created_at DESC`,
      params
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('Superadmin list add-admin requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// Shared by the add-admin-request approve route below and by
// SuperadminOrgDetail's direct "add admin" action — both end at the same
// place (a real admin membership in one org), just reached through a
// different door. Reuses findOrCreateGlobalUser, same as every other "add
// this email to my org" path (admin create-student/create-teacher, CSV
// import). If the email already has a membership in this org (e.g. an
// existing teacher), upgrades it to admin rather than silently no-op'ing on
// the (user_id, organization_id) unique constraint. Pure DB work, no email —
// caller owns the transaction and sends the welcome/notification email
// itself only after a successful commit (see sendAddAdminEmail below).
async function addAdminToOrganization(client, orgId, email, name) {
  const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);
  const upsertRes = await client.query(
    `INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (user_id, organization_id) DO UPDATE SET role = 'admin'
     RETURNING (xmax = 0) AS was_insert`,
    [userId, orgId]
  );
  return { userId, isNew, temporaryPassword, wasNewMembership: upsertRes.rows[0].was_insert };
}

// Best-effort, called after addAdminToOrganization's transaction has
// committed — never the reverse, so a mid-transaction failure can't leave
// someone holding credentials for a membership that got rolled back.
async function sendAddAdminEmail({ email, name, organizationName, isNew, wasNewMembership, temporaryPassword }) {
  if (isNew) {
    const { error: mailErr } = await sendEmail({
      to: email,
      subject: 'Your HonorRoll Account Credentials',
      text: `Hello ${name || 'Administrator'},\n\n${organizationName} has set up your HonorRoll admin account.\n\nYour temporary password is: ${temporaryPassword}\n\nLogin via ${FRONTEND_URL}\n\nPlease log in and change your password after logging in.`,
    });
    if (mailErr) console.error('New admin welcome email error:', mailErr);
  } else if (wasNewMembership) {
    const { error: mailErr } = await sendEmail({
      to: email,
      subject: `You've been added as an admin of ${organizationName}`,
      text: `Hello ${name || 'there'},\n\nYou've been added as an administrator of ${organizationName} on HonorRoll. Sign in with your existing HonorRoll password at ${FRONTEND_URL}.\n\n— HonorRoll`,
    });
    if (mailErr) console.error('Existing-user new-admin notification email error:', mailErr);
  }
}

app.post('/api/superadmin/add-admin-requests/:id/approve', authenticateToken, requireSuperadmin, async (req, res) => {
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;
  const client = await pool.connect();
  try {
    const reqRes = await client.query(
      `SELECT r.*, o.name AS organization_name, u.email AS requested_by_email, u.name AS requested_by_name
       FROM add_admin_requests r
       JOIN organizations o ON o.id = r.organization_id
       JOIN users u ON u.id = r.requested_by
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = reqRes.rows[0];
    if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already reviewed' });

    await client.query('BEGIN');
    const addResult = await addAdminToOrganization(client, request.organization_id, request.new_admin_email, request.new_admin_name);

    const result = await client.query(
      `UPDATE add_admin_requests SET status = 'approved', reviewed_by = $1, reviewed_at = now(), review_note = $2
       WHERE id = $3 RETURNING id, status, review_note, reviewed_at`,
      [req.user.userId, note, req.params.id]
    );
    await client.query('COMMIT');

    await sendAddAdminEmail({
      email: request.new_admin_email, name: request.new_admin_name, organizationName: request.organization_name, ...addResult,
    });
    if (request.requested_by_email) {
      const { error: mailErr } = await sendEmail({
        to: request.requested_by_email,
        subject: `Your add-admin request was approved`,
        text: `Hello ${request.requested_by_name || 'Administrator'},\n\nYour request to add ${request.new_admin_name || request.new_admin_email} (${request.new_admin_email}) as an admin of ${request.organization_name} has been approved.${note ? `\n\nNote: ${note}` : ''}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Add-admin requester notification email error:', mailErr);
    }

    res.status(200).json({ request: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Approve add-admin request error:', err);
    res.status(500).json({ error: 'Failed to approve request' });
  } finally {
    client.release();
  }
});

app.post('/api/superadmin/add-admin-requests/:id/reject', authenticateToken, requireSuperadmin, async (req, res) => {
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;
  try {
    const reqRes = await pool.query(
      `SELECT r.*, o.name AS organization_name, u.email AS requested_by_email, u.name AS requested_by_name
       FROM add_admin_requests r
       JOIN organizations o ON o.id = r.organization_id
       JOIN users u ON u.id = r.requested_by
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = reqRes.rows[0];
    if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already reviewed' });

    const result = await pool.query(
      `UPDATE add_admin_requests SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), review_note = $2
       WHERE id = $3 RETURNING id, status, review_note, reviewed_at`,
      [req.user.userId, note, req.params.id]
    );

    if (request.requested_by_email) {
      const { error: mailErr } = await sendEmail({
        to: request.requested_by_email,
        subject: `Your add-admin request was declined`,
        text: `Hello ${request.requested_by_name || 'Administrator'},\n\nYour request to add ${request.new_admin_name || request.new_admin_email} (${request.new_admin_email}) as an admin of ${request.organization_name} was declined.${note ? `\n\nReason: ${note}` : ''}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Add-admin requester rejection email error:', mailErr);
    }

    res.status(200).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Reject add-admin request error:', err);
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

// Single-org lookup — the refresh/direct-link fallback for
// SuperadminOrgDetail: the normal path already has the org's name from the
// row that was clicked (passed via router state), so this only actually
// gets hit on a hard reload where that state is gone.
app.get('/api/superadmin/organizations/:id', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const orgRes = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [req.params.id]);
    if (orgRes.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    res.status(200).json({ organization: orgRes.rows[0] });
  } catch (err) {
    console.error('Superadmin get organization error:', err);
    res.status(500).json({ error: 'Failed to load organization' });
  }
});

// ============================================================================
// SUPERADMIN ORG DETAIL — the dedicated page (not a trip through the
// institution's own AdminDashboard) for a superadmin to see and directly
// manage one institution: its admins, structure, billing, and roster.
// Listing endpoints deliberately just reuse the existing admin-scoped GET
// routes (/api/admin/students, /api/admin/teachers, /api/admin/org-units,
// /api/admin/subjects, /api/admin/billing/status) via the X-Organization-Id
// header override — see applySuperadminOrgOverride — since those already
// return exactly the right shape and there's no reason to fork them. The
// three routes below are the genuinely new capabilities that don't exist
// anywhere else: terminating any single person's access to an org (not just
// students, which is all the admin-facing delete route ever supported),
// adding an admin immediately instead of through the request/approve queue,
// and overriding the billing plan directly, bypassing Razorpay entirely.
// ============================================================================

// Terminates one person's access to one org — any role, unlike DELETE
// /api/admin/students/:id which only ever handled students. Mirrors that
// route's own scoping discipline: only removes THIS org's membership and
// THIS org's data for them (a teacher's subject_teachers links here, a
// student's submissions to this org's problems), and only drops the global
// identity once it has zero memberships left anywhere.
app.delete('/api/superadmin/organizations/:orgId/members/:userId', authenticateToken, requireSuperadmin, async (req, res) => {
  const { orgId, userId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query(
      `SELECT u.id, u.email, m.role FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2
       WHERE u.id = $1`,
      [userId, orgId]
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This person is not a member of that organization' });
    }
    const { email, role } = target.rows[0];

    if (role === 'student') {
      await client.query(
        'DELETE FROM submissions WHERE user_id = $1 AND problem_id IN (SELECT id FROM problems WHERE organization_id = $2)',
        [userId, orgId]
      );
    } else if (role === 'teacher') {
      await client.query(
        'DELETE FROM subject_teachers WHERE user_id = $1 AND subject_id IN (SELECT id FROM subjects WHERE organization_id = $2)',
        [userId, orgId]
      );
    }
    await client.query('DELETE FROM memberships WHERE user_id = $1 AND organization_id = $2', [userId, orgId]);
    await client.query(
      'DELETE FROM users WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1)',
      [userId]
    );
    await client.query('COMMIT');
    res.status(200).json({ message: `${email} (${role}) was removed from this organization` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Superadmin terminate member error:', err);
    res.status(500).json({ error: 'Failed to remove this person' });
  } finally {
    client.release();
  }
});

// Adds (or promotes) an admin immediately — the superadmin is already
// looking at this org, so there's no reason to route through the
// request/approve queue an institution admin has to use (see
// addAdminToOrganization's own comment for the shared membership logic).
app.post('/api/superadmin/organizations/:orgId/admins', authenticateToken, requireSuperadmin, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = req.body.name != null ? String(req.body.name).trim() || null : null;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const client = await pool.connect();
  try {
    const orgRes = await client.query('SELECT name FROM organizations WHERE id = $1', [req.params.orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });

    await client.query('BEGIN');
    const addResult = await addAdminToOrganization(client, req.params.orgId, email, name);
    await client.query('COMMIT');

    await sendAddAdminEmail({ email, name, organizationName: orgRes.rows[0].name, ...addResult });
    res.status(200).json({ userId: addResult.userId, isNew: addResult.isNew });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Superadmin add admin error:', err);
    res.status(500).json({ error: 'Failed to add admin' });
  } finally {
    client.release();
  }
});

// Directly sets an org's plan/status, bypassing Razorpay entirely — for
// comps, manual invoicing outside Razorpay, or correcting a stuck
// subscription. Clears any pending_* checkout-in-progress fields, same as
// promoteSubscriptionToActive does on a real payment, so a stale pending
// checkout can't later "complete" over top of a manual override.
app.post('/api/superadmin/organizations/:orgId/billing/override', authenticateToken, requireSuperadmin, async (req, res) => {
  const planKey = String(req.body.planKey || '');
  const status = String(req.body.status || '');
  const billingCycle = req.body.billingCycle || null;
  const currentPeriodEnd = req.body.currentPeriodEnd ? new Date(req.body.currentPeriodEnd) : null;

  if (!PLAN_CATALOG[planKey]) return res.status(400).json({ error: 'Invalid plan' });
  if (!['free', 'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (billingCycle && !BILLING_CYCLES.includes(billingCycle)) return res.status(400).json({ error: 'Invalid billing cycle' });

  try {
    await ensureSubscriptionsSchema();
    const result = await pool.query(
      `INSERT INTO subscriptions (organization_id, plan_key, status, billing_cycle, current_period_end)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id) DO UPDATE SET
         plan_key = $2, status = $3, billing_cycle = $4, current_period_end = $5,
         pending_plan_key = NULL, pending_billing_cycle = NULL, pending_razorpay_subscription_id = NULL,
         updated_at = now()
       RETURNING *`,
      [req.params.orgId, planKey, status, billingCycle, currentPeriodEnd]
    );
    res.status(200).json({ subscription: result.rows[0] });
  } catch (err) {
    console.error('Superadmin billing override error:', err);
    res.status(500).json({ error: 'Failed to override billing' });
  }
});

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
const LOGIN_AUDIENCES = ['student', 'teacher', 'admin', 'superadmin'];

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  // Optional for backward compatibility with any caller that predates the
  // audience selector (there shouldn't be one left, but this isn't the
  // route to break on a missing field) — when omitted, every role is
  // accepted, same as before this existed.
  const audience = LOGIN_AUDIENCES.includes(req.body.audience) ? req.body.audience : null;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const userResult = await pool.query('SELECT id, password_hash, name, tos_accepted_at FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = userResult.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const memberships = await pool.query(
      `SELECT m.role, m.organization_id, m.org_unit_id, o.name AS organization_name, o.status AS organization_status
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1
       ORDER BY o.name ASC`,
      [user.id]
    );

    if (memberships.rows.length === 0) {
      // A platform-owner account legitimately has zero tenant memberships —
      // they're not staff at any one school. Mint a superadmin session
      // instead of bouncing them, but only for an allowlisted email AND
      // only when the caller actually selected Super Admin — same "the
      // selected tab is a real filter, not just a label" rule as every
      // other role below, see LOGIN_AUDIENCES' own comment there.
      if ((audience === null || audience === 'superadmin') && getSuperadminEmails().includes(email.toLowerCase())) {
        const token = jwt.sign({ userId: user.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRATION || '24h' });
        return res.status(200).json({
          message: 'Login successful',
          token,
          user: { id: user.id, email, role: 'superadmin', name: user.name },
        });
      }
      if (audience && audience !== 'superadmin' && getSuperadminEmails().includes(email.toLowerCase())) {
        return res.status(401).json({ error: 'Invalid email, password, or account type selected' });
      }
      return res.status(403).json({ error: 'No organization membership found. Contact your administrator.' });
    }

    // A terminated org (superadmin blacklist, see POST /api/superadmin/
    // organizations/:id/terminate) is excluded here entirely — nobody logs
    // into one until it's reinstated. Filtered per-membership, not per-user:
    // the same person can still log into any OTHER, non-terminated org they
    // belong to.
    let usableMemberships = memberships.rows.filter((m) => m.organization_status !== 'terminated');
    if (usableMemberships.length === 0) {
      return res.status(403).json({ error: "This institution's access has been suspended by the platform owner. Contact your administrator." });
    }

    // The login form's audience tabs (Student/Teacher/Admin/Super Admin)
    // used to be pure labeling — any tab plus a valid password logged you
    // into whatever your real role happened to be. That let a student's
    // own credentials silently succeed with "Teacher" selected, landing
    // them in the student area with no explanation. Now the tab is a real
    // filter: only memberships matching the selected role are eligible,
    // and picking the wrong one for a real account is a rejection, not a
    // silent redirect — same non-disclosure posture as "Invalid email or
    // password" above, so this never confirms which role an email actually
    // has.
    if (audience) {
      const roleMatched = usableMemberships.filter((m) => m.role === audience);
      if (roleMatched.length === 0) {
        return res.status(401).json({ error: 'Invalid email, password, or account type selected' });
      }
      usableMemberships = roleMatched;
    }

    if (usableMemberships.length === 1) {
      const m = usableMemberships[0];
      // Admin already accepted at signup — never gated. Teacher/student
      // accounts are created BY an admin, so this first login is their one
      // chance to collect it (see mintTosPendingToken's own comment).
      if (m.role !== 'admin' && !user.tos_accepted_at) {
        const tosPendingToken = mintTosPendingToken({ user_id: user.id, role: m.role, organization_id: m.organization_id, org_unit_id: m.org_unit_id });
        return res.status(200).json({
          requiresTosAcceptance: true,
          tosPendingToken,
        });
      }
      const token = mintSessionToken({ user_id: user.id, role: m.role, organization_id: m.organization_id, org_unit_id: m.org_unit_id });
      // Returned in the body, not set as a cookie â€” see authenticateToken for
      // why. The frontend stores this and attaches it as an Authorization
      // header on every request from here on.
      return res.status(200).json({
        message: 'Login successful',
        token,
        user: { id: user.id, email, role: m.role, name: user.name, organization_name: m.organization_name },
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
      organizations: usableMemberships.map((m) => ({
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
      `SELECT u.id AS user_id, u.email, u.name, u.tos_accepted_at, m.role, m.organization_id, m.org_unit_id,
              o.name AS organization_name, o.status AS organization_status
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.organization_id = $2`,
      [payload.userId, organizationId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not a member of that organization' });
    }
    // Re-checked here too, not just in the organization list POST /api/login
    // hands back — that list can be up to 10 minutes stale by the time this
    // fires (the preAuthToken's own lifetime).
    if (result.rows[0].organization_status === 'terminated') {
      return res.status(403).json({ error: "This institution's access has been suspended by the platform owner. Contact your administrator." });
    }

    const m = result.rows[0];
    // Same gate as the single-membership fast path in POST /api/login —
    // see mintTosPendingToken's own comment for why teacher/student is
    // checked here and admin never is.
    if (m.role !== 'admin' && !m.tos_accepted_at) {
      const tosPendingToken = mintTosPendingToken(m);
      return res.status(200).json({
        requiresTosAcceptance: true,
        tosPendingToken,
      });
    }
    const token = mintSessionToken(m);
    res.status(200).json({
      message: 'Login successful',
      token,
      user: { id: m.user_id, email: m.email, role: m.role, name: m.name, organization_name: m.organization_name },
    });
  } catch (error) {
    console.error('Select-organization error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Completes a teacher/student's first-login Terms of Service acceptance
// (see mintTosPendingToken/requiresTosAcceptance above): verifies the
// short-lived tos-pending token, records acceptance, then mints and
// returns the exact same real-session-token response either login
// completion route would have returned had acceptance not been needed —
// the frontend's post-login handling doesn't need to know which path it
// came through.
app.post('/api/login/accept-tos', async (req, res) => {
  const { tosPendingToken } = req.body;
  if (!tosPendingToken) return res.status(400).json({ error: 'tosPendingToken is required' });

  let payload;
  try {
    payload = jwt.verify(tosPendingToken, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Login session expired — please sign in again' });
  }
  if (payload.type !== 'tos-pending') {
    return res.status(401).json({ error: 'Invalid login session' });
  }

  try {
    const result = await pool.query(
      `UPDATE users SET tos_accepted_at = now() WHERE id = $1 RETURNING id, email, name`,
      [payload.userId]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Session no longer valid' });
    const user = result.rows[0];

    const orgRes = await pool.query('SELECT name FROM organizations WHERE id = $1', [payload.organizationId]);

    const token = mintSessionToken({
      user_id: payload.userId,
      role: payload.role,
      organization_id: payload.organizationId,
      org_unit_id: payload.orgUnitId,
    });
    res.status(200).json({
      message: 'Login successful',
      token,
      user: { id: user.id, email: user.email, role: payload.role, name: user.name, organization_name: orgRes.rows[0]?.name },
    });
  } catch (error) {
    console.error('Accept-ToS error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// 3b. SESSION: Who am I? â€” lets the frontend recover role/identity on refresh
// ============================================================================
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    // A superadmin session carries no organizationId/membership at all —
    // skip the org join entirely rather than have it (correctly) find zero
    // rows and bounce them as if their session were invalid.
    if (req.user.role === 'superadmin') {
      const userRes = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.user.userId]);
      if (userRes.rows.length === 0) return res.status(401).json({ error: 'Session no longer valid' });
      return res.status(200).json({ user: { id: userRes.rows[0].id, email: userRes.rows[0].email, role: 'superadmin', name: userRes.rows[0].name } });
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.name, m.role, m.org_unit_id, o.name AS organization_name
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

// Self-service display-name update — every OTHER path that sets
// users.name is someone ELSE naming this account (admin signup collects
// its own name; CSV import/create-student/create-teacher get it from the
// admin doing the importing). Superadmin is the one role with no such
// onboarding step at all — an allowlisted email can reach the platform
// with users.name still NULL and no admin-driven flow that would ever
// fill it in — so this is the one place that gap actually gets closed.
// Left open to any authenticated role rather than superadmin-only since
// there's nothing role-specific about "let me set my own display name."
app.put('/api/me', authenticateToken, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const result = await pool.query('UPDATE users SET name = $1 WHERE id = $2 RETURNING name', [name, req.user.userId]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Session no longer valid' });
    res.status(200).json({ name: result.rows[0].name });
  } catch (err) {
    console.error('Update own name error:', err);
    res.status(500).json({ error: 'Failed to update name' });
  }
});

// Every organization this user belongs to, with their role in each — the
// authenticated equivalent of the org-picker query POST /api/login already
// runs pre-auth for a multi-membership user (see the preAuthToken flow),
// reused here keyed on the verified session's own userId instead. Exists
// for the cross-institution student dashboard (GET /api/me/performance
// below): unlike every other /api/me/* route, this one deliberately does
// NOT scope by req.user.organizationId — the whole point is listing every
// org, not just the current session's one. Works for a superadmin session
// too (which has no organizationId of its own) since it just returns an
// empty list for them rather than erroring.
app.get('/api/me/organizations', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.organization_id, o.name AS organization_name, m.role, m.org_unit_id, m.roll_number
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1
       ORDER BY o.name ASC`,
      [req.user.userId]
    );
    res.status(200).json({ organizations: result.rows });
  } catch (err) {
    console.error('List my organizations error:', err);
    res.status(500).json({ error: 'Failed to load organizations' });
  }
});

// A student's own request to correct their roster info.
// Routed to their institution's admin queue. Sends an email notification to the
// organization's admin(s).
// Student-only: a teacher/admin's own details are already directly
// editable by their institution's admin, so this route isn't for them.
app.post('/api/me/profile-change-requests', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Student access required' });
  }
  const field = String(req.body.field || '').trim();
  const requestedValue = String(req.body.requestedValue || '').trim();
  const currentValue = req.body.currentValue != null ? String(req.body.currentValue).trim() || null : null;
  const reason = req.body.reason != null ? String(req.body.reason).trim() || null : null;
  if (!field) return res.status(400).json({ error: 'field is required' });
  if (!requestedValue) return res.status(400).json({ error: 'requestedValue is required' });

  try {
    const result = await pool.query(
      `INSERT INTO profile_change_requests (organization_id, user_id, field, current_value, requested_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, field, current_value, requested_value, reason, status, created_at`,
      [req.user.organizationId, req.user.userId, field, currentValue, requestedValue, reason]
    );

    // Look up the institution admin(s) and student details to notify the admin(s)
    const [adminsRes, studentRes] = await Promise.all([
      pool.query(
        `SELECT u.email, u.name, o.name AS organization_name
         FROM users u
         JOIN memberships m ON m.user_id = u.id
         JOIN organizations o ON o.id = m.organization_id
         WHERE m.organization_id = $1 AND m.role = 'admin'`,
        [req.user.organizationId]
      ),
      pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]),
    ]);

    const studentName = studentRes.rows[0]?.name || 'Student';
    const studentEmail = studentRes.rows[0]?.email || '';
    const orgName = adminsRes.rows[0]?.organization_name || 'your institution';

    for (const admin of adminsRes.rows) {
      if (admin.email) {
        const { error: mailErr } = await sendEmail({
          to: admin.email,
          subject: `HonorRoll — Student Info Change Request (${studentName})`,
          text: `Hello ${admin.name || 'Admin'},\n\nA student in ${orgName} has submitted a request query regarding an info change:\n\nStudent: ${studentName} <${studentEmail}>\nField: ${field}\nCurrent Value: ${currentValue || '(none)'}\nRequested Value: ${requestedValue}\nReason: ${reason || '(none)'}\n\nPlease review this request in your Admin Dashboard under Students.\n\n— HonorRoll`,
        });
        if (mailErr) console.error(`Failed to notify admin ${admin.email} of profile change request:`, mailErr);
      }
    }

    res.status(201).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Create profile change request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// A student's own history of requests, across every institution they've
// filed one from — same "not scoped to req.user.organizationId" posture as
// GET /api/me/organizations, since the point is the student's whole
// history, not just the current session's org.
app.get('/api/me/profile-change-requests', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Student access required' });
  }
  try {
    const result = await pool.query(
      `SELECT r.id, r.organization_id, o.name AS organization_name, r.field, r.current_value, r.requested_value,
              r.reason, r.status, r.review_note, r.reviewed_at, r.created_at
       FROM profile_change_requests r
       JOIN organizations o ON o.id = r.organization_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.userId]
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('List my profile change requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// Cross-institution performance summary — every organization this user is a
// STUDENT in (a role they're a teacher/admin of elsewhere doesn't belong on
// a "my results" view), each with a rolled-up assignment/exam percent for
// just that org. Reuses getAssignmentPerformance/getExamPerformance (built
// for the teacher dashboard) with a single-student `studentIds` array —
// less efficient than a true bulk query, but a student is realistically in
// a handful of orgs at most, so the per-org round trip is cheap in practice.
app.get('/api/me/performance', authenticateToken, async (req, res) => {
  try {
    const membershipsRes = await pool.query(
      `SELECT m.organization_id, o.name AS organization_name, m.org_unit_id
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.role = 'student'
       ORDER BY o.name ASC`,
      [req.user.userId]
    );

    const organizations = await Promise.all(membershipsRes.rows.map(async (m) => {
      const { problems, exams } = await getStudentScopedAssignmentsAndExams(m.organization_id, m.org_unit_id);
      const [{ byUser: aByUser }, { byUser: eByUser }, legacyRes] = await Promise.all([
        getAssignmentPerformance(problems, [req.user.userId]),
        getExamPerformance(exams, [req.user.userId]),
        pool.query('SELECT assignment_score_percent, exam_score_percent FROM legacy_scores WHERE organization_id = $1 AND user_id = $2', [m.organization_id, req.user.userId]),
      ]);
      const aMap = aByUser.get(req.user.userId) || new Map();
      const eMap = eByUser.get(req.user.userId) || new Map();
      const legacyAssignment = legacyRes.rows.map((r) => r.assignment_score_percent).filter((v) => v != null);
      const legacyExam = legacyRes.rows.map((r) => r.exam_score_percent).filter((v) => v != null);
      const avgAssignmentPercent = averagePercentWithExtra(aMap, legacyAssignment);
      const avgExamPercent = averagePercentWithExtra(eMap, legacyExam);
      const tags = await getPercentileAndGradeTags(m.organization_id, avgAssignmentPercent, avgExamPercent);
      return {
        organizationId: m.organization_id,
        organizationName: m.organization_name,
        assignmentsTotal: problems.length,
        assignmentsSubmitted: aMap.size,
        avgAssignmentPercent,
        examsTotal: exams.length,
        examsAttempted: eMap.size,
        avgExamPercent,
        ...tags,
      };
    }));

    res.status(200).json({ organizations });
  } catch (err) {
    console.error('My performance error:', err);
    res.status(500).json({ error: 'Failed to load performance' });
  }
});

// One organization's full breakdown for the caller's own student
// membership there — 404s if they aren't actually a student in that org
// (rather than leaking whether the org id even exists).
app.get('/api/me/performance/:organizationId', authenticateToken, async (req, res) => {
  try {
    const organizationId = Number(req.params.organizationId);
    const membershipRes = await pool.query(
      `SELECT m.org_unit_id, o.name AS organization_name
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.organization_id = $2 AND m.role = 'student'`,
      [req.user.userId, organizationId]
    );
    if (membershipRes.rows.length === 0) return res.status(404).json({ error: 'Not enrolled in this organization' });
    const { org_unit_id: orgUnitId, organization_name: organizationName } = membershipRes.rows[0];

    const { problems, exams } = await getStudentScopedAssignmentsAndExams(organizationId, orgUnitId);
    const [{ byUser: aByUser }, { byUser: eByUser }, legacyRes] = await Promise.all([
      getAssignmentPerformance(problems, [req.user.userId]),
      getExamPerformance(exams, [req.user.userId]),
      pool.query(
        'SELECT academic_year, assignment_score_percent, exam_score_percent, notes FROM legacy_scores WHERE organization_id = $1 AND user_id = $2 ORDER BY academic_year DESC',
        [organizationId, req.user.userId]
      ),
    ]);
    const aMap = aByUser.get(req.user.userId) || new Map();
    const eMap = eByUser.get(req.user.userId) || new Map();

    // Per-item percentile for the "Overall" graphs' percentile-trend view on
    // MyPerformance (see POST /api/problems/:id/result for the single-item
    // version this mirrors) — one query per type covering every
    // problem/exam at once, grouped in JS, rather than N population
    // queries for N items.
    const visibility = await getTagVisibility(organizationId);
    const percentileByProblem = new Map();
    const percentileByExam = new Map();
    if (visibility.show_percentile_tag) {
      const codeProblemIds = problems.filter((p) => p.submission_mode === 'code').map((p) => p.id);
      const scanProblemIds = problems.filter((p) => p.submission_mode === 'scan').map((p) => p.id);
      const byProblem = new Map();
      if (codeProblemIds.length > 0) {
        const bestRes = await pool.query(
          `SELECT DISTINCT ON (user_id, problem_id) user_id, problem_id, passed_count, total_count
           FROM submissions WHERE problem_id = ANY($1::int[])
           ORDER BY user_id, problem_id, (status = 'Accepted') DESC, passed_count DESC, created_at DESC`,
          [codeProblemIds]
        );
        for (const r of bestRes.rows) {
          if (r.total_count <= 0) continue;
          if (!byProblem.has(r.problem_id)) byProblem.set(r.problem_id, []);
          byProblem.get(r.problem_id).push({ userId: r.user_id, pct: (r.passed_count / r.total_count) * 100 });
        }
      }
      if (scanProblemIds.length > 0) {
        // Mirrors getAssignmentPerformance's own scan-mode branch — a scan
        // submission's percent comes from summed question marks, not a
        // passed/total test-case count.
        const scanRes = await pool.query(
          `SELECT ss.user_id, ss.problem_id, SUM(q.marks) AS max_marks, SUM(sa.marks_awarded) AS awarded,
                  BOOL_AND(sa.marks_awarded IS NOT NULL) AS fully_graded
           FROM scan_submissions ss
           JOIN scan_assignment_questions q ON q.problem_id = ss.problem_id
           LEFT JOIN scan_submission_answers sa ON sa.submission_id = ss.id AND sa.question_id = q.id
           WHERE ss.problem_id = ANY($1::int[])
           GROUP BY ss.user_id, ss.problem_id`,
          [scanProblemIds]
        );
        for (const r of scanRes.rows) {
          if (!r.fully_graded || !(Number(r.max_marks) > 0)) continue;
          if (!byProblem.has(r.problem_id)) byProblem.set(r.problem_id, []);
          byProblem.get(r.problem_id).push({ userId: r.user_id, pct: (Number(r.awarded) / Number(r.max_marks)) * 100 });
        }
      }
      for (const [problemId, rows] of byProblem) {
        const mine = rows.find((r) => r.userId === req.user.userId);
        if (!mine) continue;
        const tierFor = computePercentileTiers(rows.map((r) => r.pct));
        percentileByProblem.set(problemId, tierFor(mine.pct).percentile);
      }
      if (exams.length > 0) {
        const examIds = exams.map((e) => e.id);
        const attemptsRes = await pool.query(
          `SELECT a.exam_id, a.user_id, a.score, e.total_marks,
                  NOT EXISTS (
                    SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
                    WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
                  ) AND NOT EXISTS (
                    SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = a.id AND esa.marks_awarded IS NULL
                  ) AS fully_graded
           FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
           WHERE a.exam_id = ANY($1::int[]) AND a.status = 'submitted' AND e.total_marks > 0`,
          [examIds]
        );
        const byExam = new Map();
        for (const r of attemptsRes.rows) {
          if (!r.fully_graded) continue;
          if (!byExam.has(r.exam_id)) byExam.set(r.exam_id, []);
          byExam.get(r.exam_id).push({ userId: r.user_id, pct: (r.score / r.total_marks) * 100 });
        }
        for (const [examId, rows] of byExam) {
          const mine = rows.find((r) => r.userId === req.user.userId);
          if (!mine) continue;
          const tierFor = computePercentileTiers(rows.map((r) => r.pct));
          percentileByExam.set(examId, tierFor(mine.pct).percentile);
        }
      }
    }

    const [problemMetaRes, examMetaRes, scanRemarksRes, examRemarksRes] = await Promise.all([
      problems.length
        ? pool.query(
            `SELECT p.id, p.title, s.name AS subject_name FROM problems p
             LEFT JOIN subjects s ON s.id = p.subject_id WHERE p.id = ANY($1::int[])`,
            [problems.map((p) => p.id)]
          )
        : { rows: [] },
      exams.length
        ? pool.query(
            `SELECT e.id, e.title, s.name AS subject_name FROM exams e
             LEFT JOIN subjects s ON s.id = e.subject_id WHERE e.id = ANY($1::int[])`,
            [exams.map((e) => e.id)]
          )
        : { rows: [] },
      problems.length
        ? pool.query('SELECT problem_id, overall_remarks FROM scan_submissions WHERE user_id = $1 AND problem_id = ANY($2::int[])', [req.user.userId, problems.map((p) => p.id)])
        : { rows: [] },
      exams.length
        ? pool.query('SELECT exam_id, overall_remarks FROM exam_attempts WHERE user_id = $1 AND exam_id = ANY($2::int[])', [req.user.userId, exams.map((e) => e.id)])
        : { rows: [] },
    ]);
    const problemMetaById = new Map(problemMetaRes.rows.map((r) => [r.id, r]));
    const examMetaById = new Map(examMetaRes.rows.map((r) => [r.id, r]));
    const scanRemarksByProblem = new Map(scanRemarksRes.rows.map((r) => [r.problem_id, r.overall_remarks]));
    const examRemarksByExam = new Map(examRemarksRes.rows.map((r) => [r.exam_id, r.overall_remarks]));

    const assignments = problems.map((p) => {
      const meta = problemMetaById.get(p.id);
      const entry = aMap.get(p.id);
      return {
        problemId: p.id,
        title: meta?.title,
        subjectName: meta?.subject_name,
        status: entry?.status || 'not_submitted',
        percent: entry?.pct ?? null,
        percentile: percentileByProblem.has(p.id) ? percentileByProblem.get(p.id) : null,
        remarks: scanRemarksByProblem.get(p.id) || null,
      };
    });

    const examsOut = exams.map((e) => {
      const meta = examMetaById.get(e.id);
      const entry = eMap.get(e.id);
      return {
        examId: e.id,
        title: meta?.title,
        subjectName: meta?.subject_name,
        status: entry?.status || 'not_attempted',
        percent: entry?.pct ?? null,
        percentile: percentileByExam.has(e.id) ? percentileByExam.get(e.id) : null,
        remarks: examRemarksByExam.get(e.id) || null,
      };
    });

    const legacyAssignment = legacyRes.rows.map((r) => r.assignment_score_percent).filter((v) => v != null);
    const legacyExam = legacyRes.rows.map((r) => r.exam_score_percent).filter((v) => v != null);
    const avgAssignmentPercent = averagePercentWithExtra(aMap, legacyAssignment);
    const avgExamPercent = averagePercentWithExtra(eMap, legacyExam);
    const tags = await getPercentileAndGradeTags(organizationId, avgAssignmentPercent, avgExamPercent);

    res.status(200).json({
      organizationId,
      organizationName,
      assignments,
      exams: examsOut,
      historicalScores: legacyRes.rows.map((r) => ({
        academicYear: r.academic_year,
        assignmentScorePercent: r.assignment_score_percent,
        examScorePercent: r.exam_score_percent,
        notes: r.notes,
      })),
      avgAssignmentPercent,
      avgExamPercent,
      ...tags,
    });
  } catch (err) {
    console.error('My performance detail error:', err);
    res.status(500).json({ error: 'Failed to load performance' });
  }
});

// Stateless token, so there's nothing server-side to invalidate here — the
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

    const { error: emailError } = await sendEmail({
      to: email,
      subject: 'HonorRoll Password Reset',
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
      'SELECT id, title, difficulty, opens_at, closes_at, subject_id, submission_mode FROM problems WHERE organization_id = $1 ORDER BY id ASC',
      [req.user.organizationId]
    );

    const withStatus = result.rows.map((p) => ({ ...p, status: getProblemStatus(p) }));

    // Students never see an assignment before its opens_at; admins AND
    // teachers see everything (open, closed, and upcoming) so they can
    // manage the whole set — a teacher who just created an assignment
    // needs to see it immediately, same as an admin would.
    let visible = req.user.role === 'student'
      ? withStatus.filter((p) => p.status !== 'upcoming')
      : withStatus;

    // Subject visibility: a subject attached at "Department" reaches every
    // unit beneath it (e.g. every year), so this checks the student's own
    // unit AND all of its ancestors — not the unit alone. An item with no
    // subject at all (subject_id NULL) stays org-wide visible, same as
    // every problem behaved before this feature existed. Only applies to
    // students — teachers/admins manage the whole org's set regardless of
    // their own unit.
    if (req.user.role === 'student') {
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

      // scan_submissions is a separate table (a scan-mode assignment is
      // never in `submissions` above) — attached as its own field rather
      // than forced into `submission`'s code-judge shape (status/passed/
      // total), which a scanned answer sheet has no equivalent of.
      const scanRes = await pool.query(
        `SELECT problem_id FROM scan_submissions WHERE user_id = $1 AND problem_id = ANY($2::int[])`,
        [req.user.userId, problemIds]
      );
      const scanSubmittedIds = new Set(scanRes.rows.map((r) => r.problem_id));
      visible.forEach((p) => { p.scanSubmitted = scanSubmittedIds.has(p.id); });
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
    if (status === 'upcoming' && req.user.role === 'student') {
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
    const problemRes = await pool.query('SELECT submission_mode, closes_at FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    const isScan = problemRes.rows[0].submission_mode === 'scan';

    let myPercentage;
    let problemPercentages;
    let overallAvgByUser; // Map<userId, avgPercentage> across every problem of this SAME mode, own deadline passed

    if (isScan) {
      const mineRes = await pool.query(
        `SELECT SUM(q.marks) AS max_marks, SUM(sa.marks_awarded) AS awarded, BOOL_AND(sa.marks_awarded IS NOT NULL) AS fully_graded
         FROM scan_submissions ss
         JOIN scan_assignment_questions q ON q.problem_id = ss.problem_id
         LEFT JOIN scan_submission_answers sa ON sa.submission_id = ss.id AND sa.question_id = q.id
         WHERE ss.user_id = $1 AND ss.problem_id = $2
         GROUP BY ss.id`,
        [req.user.userId, problemId]
      );
      if (mineRes.rows.length === 0) return res.status(404).json({ error: 'No submission found for this assignment' });
      if (!mineRes.rows[0].fully_graded) return res.status(200).json({ status: 'pending', reason: 'grading' });

      if (problemRes.rows[0].closes_at && new Date(problemRes.rows[0].closes_at) > new Date()) {
        return res.status(200).json({ status: 'pending', reason: 'deadline' });
      }

      myPercentage = Number(mineRes.rows[0].max_marks) > 0 ? (Number(mineRes.rows[0].awarded) / Number(mineRes.rows[0].max_marks)) * 100 : 0;

      const allRes = await pool.query(
        `SELECT ss.user_id, SUM(q.marks) AS max_marks, SUM(sa.marks_awarded) AS awarded, BOOL_AND(sa.marks_awarded IS NOT NULL) AS fully_graded
         FROM scan_submissions ss
         JOIN scan_assignment_questions q ON q.problem_id = ss.problem_id
         LEFT JOIN scan_submission_answers sa ON sa.submission_id = ss.id AND sa.question_id = q.id
         WHERE ss.problem_id = $1
         GROUP BY ss.id`,
        [problemId]
      );
      problemPercentages = allRes.rows
        .filter((r) => r.fully_graded && Number(r.max_marks) > 0)
        .map((r) => (Number(r.awarded) / Number(r.max_marks)) * 100);

      const overallRes = await pool.query(
        `SELECT best.user_id, AVG(best.pct) AS avg_percentage FROM (
           SELECT ss.user_id, ss.problem_id, SUM(q.marks) AS max_marks, SUM(sa.marks_awarded) AS awarded,
                  BOOL_AND(sa.marks_awarded IS NOT NULL) AS fully_graded,
                  (SUM(sa.marks_awarded)::float / NULLIF(SUM(q.marks), 0) * 100) AS pct
           FROM scan_submissions ss
           JOIN scan_assignment_questions q ON q.problem_id = ss.problem_id
           JOIN problems p ON p.id = ss.problem_id
           LEFT JOIN scan_submission_answers sa ON sa.submission_id = ss.id AND sa.question_id = q.id
           WHERE p.organization_id = $1 AND (p.closes_at IS NULL OR p.closes_at <= now())
           GROUP BY ss.id, ss.user_id, ss.problem_id
         ) best
         WHERE best.fully_graded AND best.pct IS NOT NULL
         GROUP BY best.user_id`,
        [req.user.organizationId]
      );
      overallAvgByUser = new Map(overallRes.rows.map((r) => [r.user_id, Number(r.avg_percentage)]));
    } else {
      const bestRes = await pool.query(
        `SELECT passed_count, total_count FROM submissions
         WHERE user_id = $1 AND problem_id = $2
         ORDER BY (status = 'Accepted') DESC, passed_count DESC, created_at DESC LIMIT 1`,
        [req.user.userId, problemId]
      );
      if (bestRes.rows.length === 0) return res.status(404).json({ error: 'No submission found for this assignment' });

      if (problemRes.rows[0].closes_at && new Date(problemRes.rows[0].closes_at) > new Date()) {
        return res.status(200).json({ status: 'pending', reason: 'deadline' });
      }

      const best = bestRes.rows[0];
      myPercentage = best.total_count > 0 ? (best.passed_count / best.total_count) * 100 : 0;

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
      problemPercentages = allBestRes.rows
        .filter((r) => r.total_count > 0)
        .map((r) => (r.passed_count / r.total_count) * 100);

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
      overallAvgByUser = new Map(overallRes.rows.map((r) => [r.user_id, Number(r.avg_percentage)]));
    }

    const { tag: percentileTag, percentile } = computePercentileTiers(problemPercentages)(myPercentage);
    const overallPercentileFor = computePercentileTiers([...overallAvgByUser.values()]);
    const overallAssignmentsPercentileTag = overallAvgByUser.has(req.user.userId)
      ? overallPercentileFor(overallAvgByUser.get(req.user.userId)).tag
      : null;

    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [req.user.organizationId]);
    const gradeTag = gradeTagForPercentage(bandsRes.rows, myPercentage);

    const visibility = await getTagVisibility(req.user.organizationId);
    res.status(200).json({
      status: 'graded',
      percentileTag: visibility.show_percentile_tag ? percentileTag : undefined,
      percentile: visibility.show_percentile_tag ? percentile : undefined,
      populationSize: visibility.show_percentile_tag ? problemPercentages.length : undefined,
      overallAssignmentsPercentileTag: visibility.show_percentile_tag ? overallAssignmentsPercentileTag : undefined,
      gradeTag: visibility.show_grade_tag ? gradeTag : undefined,
    });
  } catch (err) {
    console.error('Assignment result error:', err);
    res.status(500).json({ error: 'Failed to load result' });
  }
});

// Per-question breakdown for the "per question" factor on MyPerformance's
// assignment graph. Only real for scan-mode assignments — a code submission
// stores just its aggregate passed_count/total_count, never a per-test-case
// result, so there's no genuine per-question data for those; this returns
// that summary instead of fabricating one.
app.get('/api/problems/:id/questions', authenticateToken, async (req, res) => {
  const problemId = req.params.id;
  try {
    const problemRes = await pool.query(
      'SELECT submission_mode, closes_at FROM problems WHERE id = $1 AND organization_id = $2',
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    const problem = problemRes.rows[0];
    if (problem.closes_at && new Date(problem.closes_at) > new Date()) {
      return res.status(200).json({ status: 'pending', reason: 'deadline' });
    }

    if (problem.submission_mode !== 'scan') {
      const bestRes = await pool.query(
        `SELECT passed_count, total_count FROM submissions
         WHERE user_id = $1 AND problem_id = $2
         ORDER BY (status = 'Accepted') DESC, passed_count DESC, created_at DESC LIMIT 1`,
        [req.user.userId, problemId]
      );
      if (bestRes.rows.length === 0) return res.status(404).json({ error: 'No submission found for this assignment' });
      return res.status(200).json({ status: 'graded', mode: 'code', passedCount: bestRes.rows[0].passed_count, totalCount: bestRes.rows[0].total_count });
    }

    const submissionRes = await pool.query(
      'SELECT id FROM scan_submissions WHERE user_id = $1 AND problem_id = $2 ORDER BY created_at DESC LIMIT 1',
      [req.user.userId, problemId]
    );
    if (submissionRes.rows.length === 0) return res.status(404).json({ error: 'No submission found for this assignment' });

    const questionsRes = await pool.query(
      `SELECT q.position, q.marks AS max_marks, a.marks_awarded
       FROM scan_assignment_questions q
       LEFT JOIN scan_submission_answers a ON a.question_id = q.id AND a.submission_id = $1
       WHERE q.problem_id = $2
       ORDER BY q.position ASC`,
      [submissionRes.rows[0].id, problemId]
    );
    res.status(200).json({
      status: 'graded',
      mode: 'scan',
      questions: questionsRes.rows.map((r, i) => ({
        label: `Q${r.position ?? i + 1}`,
        earned: r.marks_awarded != null ? Number(r.marks_awarded) : null,
        max: Number(r.max_marks),
      })),
    });
  } catch (err) {
    console.error('Assignment questions breakdown error:', err);
    res.status(500).json({ error: 'Failed to load question breakdown' });
  }
});

// Admin: upload a new problem with its starter code and test cases in one shot
app.post('/api/admin/problems', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { title, difficulty, description, starterCode = {}, testCases = [], opensAt = null, closesAt = null } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  // 'scan' assignments skip the code-judge machinery entirely (no starter
  // code, no test cases) — students upload a scanned PDF instead. See
  // ensureScanAssignmentColumns for the column definitions.
  const submissionMode = req.body.submissionMode === 'scan' ? 'scan' : 'code';
  const assignmentNo = submissionMode === 'scan' ? String(req.body.assignmentNo || '').trim() : null;
  // Scan-mode questions: what a student actually needs to answer, shown
  // before the camera opens (see GET /api/me/scan-context). Required same
  // as test cases are for code mode — a scan assignment with no questions
  // would just be a bare upload box with no idea what's being asked. Each
  // one can be mcq/short/long/coding/scan — see normalizeScanAssignmentQuestion.
  let questions = [];
  if (submissionMode === 'scan') {
    const rawQuestions = Array.isArray(req.body.questions) ? req.body.questions : [];
    try {
      questions = rawQuestions.map((q, i) => normalizeScanAssignmentQuestion(q, i));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (!title || !difficulty || !description) {
    return res.status(400).json({ error: 'Title, difficulty, and description are required' });
  }
  if (submissionMode === 'code' && (!Array.isArray(testCases) || testCases.length === 0)) {
    return res.status(400).json({ error: 'At least one test case is required' });
  }
  if (submissionMode === 'scan' && !assignmentNo) {
    return res.status(400).json({ error: 'Assignment number is required for scanned assignments' });
  }
  if (submissionMode === 'scan' && questions.length === 0) {
    return res.status(400).json({ error: 'At least one question is required for scanned assignments' });
  }
  if (await enforceSubjectAuthority(req, res, subjectId)) return;

  let timeLimitSeconds;
  try {
    timeLimitSeconds = normalizeTimeLimitSeconds(req.body.timeLimitSeconds);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let plagiarismThreshold;
  try {
    plagiarismThreshold = normalizePlagiarismThreshold(req.body.plagiarismThreshold);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const problemRes = await client.query(
      `INSERT INTO problems (title, difficulty, description, created_by, opens_at, closes_at, time_limit_seconds, organization_id, subject_id, submission_mode, assignment_no, plagiarism_threshold)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [title, difficulty, description, req.user.userId, opensAt, closesAt, timeLimitSeconds, req.user.organizationId, subjectId, submissionMode, assignmentNo, plagiarismThreshold]
    );
    const problemId = problemRes.rows[0].id;

    if (submissionMode === 'code') {
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
    } else {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        await client.query(
          `INSERT INTO scan_assignment_questions (problem_id, position, prompt, marks, type, options, correct_option_id, word_limit, starter_code, test_cases)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [problemId, i, q.prompt, q.marks, q.type,
            q.options ? JSON.stringify(q.options) : null, q.correctOptionId, q.wordLimit,
            q.starterCode ? JSON.stringify(q.starterCode) : null, q.testCases ? JSON.stringify(q.testCases) : null]
        );
      }
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
      'SELECT id, title, difficulty, description, opens_at, closes_at, subject_id, submission_mode, assignment_no, plagiarism_threshold FROM problems WHERE id = $1 AND organization_id = $2',
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    const problem = problemRes.rows[0];
    if (await enforceSubjectAuthority(req, res, problem.subject_id)) return;

    let starterCode = {};
    let testCases = [];
    let questions = [];
    if (problem.submission_mode === 'scan') {
      const questionsRes = await pool.query(
        `SELECT prompt, marks, type, options, correct_option_id, word_limit, starter_code, test_cases
         FROM scan_assignment_questions WHERE problem_id = $1 ORDER BY position ASC`,
        [problemId]
      );
      questions = questionsRes.rows.map((q) => ({
        prompt: q.prompt, marks: q.marks, type: q.type,
        options: q.options, correctOptionId: q.correct_option_id, wordLimit: q.word_limit,
        starterCode: q.starter_code, testCases: q.test_cases,
      }));
    } else {
      const codeRes = await pool.query(
        'SELECT language, code FROM starter_code WHERE problem_id = $1',
        [problemId]
      );
      codeRes.rows.forEach((row) => { starterCode[row.language] = row.code; });

      // Every test case, hidden ones included â€” unlike the student-facing
      // GET /api/problems/:id, which only returns visible samples.
      const testCasesRes = await pool.query(
        'SELECT input, expected_output, is_hidden FROM test_cases WHERE problem_id = $1 ORDER BY id ASC',
        [problemId]
      );
      testCases = testCasesRes.rows.map((tc) => ({
        input: tc.input,
        expectedOutput: tc.expected_output,
        isHidden: tc.is_hidden,
      }));
    }

    res.status(200).json({
      title: problem.title,
      difficulty: problem.difficulty,
      description: problem.description,
      starterCode,
      testCases,
      opensAt: problem.opens_at,
      closesAt: problem.closes_at,
      subjectId: problem.subject_id,
      submissionMode: problem.submission_mode,
      assignmentNo: problem.assignment_no,
      plagiarismThreshold: problem.plagiarism_threshold,
      questions,
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
  const assignmentNo = String(req.body.assignmentNo || '').trim() || null;

  if (!title || !difficulty || !description) {
    return res.status(400).json({ error: 'Title, difficulty, and description are required' });
  }

  let questions = [];
  try {
    const rawQuestions = Array.isArray(req.body.questions) ? req.body.questions : [];
    questions = rawQuestions.map((q, i) => normalizeScanAssignmentQuestion(q, i));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let plagiarismThreshold;
  try {
    plagiarismThreshold = normalizePlagiarismThreshold(req.body.plagiarismThreshold);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // submission_mode is fixed at creation (not part of the SET below) —
    // fetched here purely to decide which of test-cases-vs-questions this
    // update should validate/replace.
    const existing = await client.query('SELECT id, subject_id, submission_mode FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Problem not found' });
    }
    const submissionMode = existing.rows[0].submission_mode;
    if (submissionMode === 'code' && (!Array.isArray(testCases) || testCases.length === 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'At least one test case is required' });
    }
    if (submissionMode === 'scan' && questions.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'At least one question is required for scanned assignments' });
    }
    if (submissionMode === 'scan' && !assignmentNo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Assignment number is required for scanned assignments' });
    }
    // A teacher must be authorized on both the item's current subject and
    // whatever subject they're moving it to (a no-op check for admins).
    if (await enforceSubjectAuthority(req, res, existing.rows[0].subject_id)) { await client.query('ROLLBACK'); return; }
    if (subjectId !== existing.rows[0].subject_id && await enforceSubjectAuthority(req, res, subjectId)) { await client.query('ROLLBACK'); return; }

    await client.query(
      submissionMode === 'scan'
        ? `UPDATE problems SET title = $1, difficulty = $2, description = $3, opens_at = $4, closes_at = $5, subject_id = $6, assignment_no = $7, plagiarism_threshold = $8 WHERE id = $9`
        : `UPDATE problems SET title = $1, difficulty = $2, description = $3, opens_at = $4, closes_at = $5, subject_id = $6 WHERE id = $7`,
      submissionMode === 'scan'
        ? [title, difficulty, description, opensAt, closesAt, subjectId, assignmentNo, plagiarismThreshold, problemId]
        : [title, difficulty, description, opensAt, closesAt, subjectId, problemId]
    );

    if (submissionMode === 'scan') {
      // Full replace, same as starter_code/test_cases below — matches how
      // AssignmentForm sends its payload (the whole question set at once).
      await client.query('DELETE FROM scan_assignment_questions WHERE problem_id = $1', [problemId]);
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        await client.query(
          `INSERT INTO scan_assignment_questions (problem_id, position, prompt, marks, type, options, correct_option_id, word_limit, starter_code, test_cases)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [problemId, i, q.prompt, q.marks, q.type,
            q.options ? JSON.stringify(q.options) : null, q.correctOptionId, q.wordLimit,
            q.starterCode ? JSON.stringify(q.starterCode) : null, q.testCases ? JSON.stringify(q.testCases) : null]
        );
      }
      await client.query('COMMIT');
      return res.status(200).json({ message: 'Assignment updated successfully', problemId });
    }

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
// requireAdminOrTeacher + enforceSubjectAuthority, not requireAdmin — same
// bug and same fix as GET /api/admin/exams's own comment: this is reachable
// from AssignmentAttemptsPanel, rendered inside the teacher-only Assignments
// tab, but a teacher could never actually view it. Scoped to the problem's
// OWN subject_id (a teacher can only view attempts for assignments in
// subjects they're assigned to), matching every other problem route's
// posture.
app.get('/api/admin/problems/:id/attempts', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;

    const bestRes = await pool.query(
      `SELECT DISTINCT ON (s.user_id) s.user_id, u.email, u.name, s.status, s.passed_count, s.total_count, s.created_at
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
        name: r.name,
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
  const { title, description = null, totalTimeSeconds, webcamRequired = false, opensAt = null, closesAt = null, items = [], calculatorAllowed = false, calculatorType = null } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  const CALCULATOR_TYPES = ['basic', 'scientific', 'programmer', 'statistics', 'financial'];
  if (calculatorAllowed && !CALCULATOR_TYPES.includes(calculatorType)) {
    return res.status(400).json({ error: 'A valid calculator type is required when calculators are allowed' });
  }

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
      `INSERT INTO exams (title, description, total_marks, total_time_seconds, webcam_required, opens_at, closes_at, created_by, organization_id, subject_id, calculator_allowed, calculator_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [title.trim(), description, totalMarks, Math.round(totalTime), !!webcamRequired, opensAt, closesAt, req.user.userId, req.user.organizationId, subjectId, !!calculatorAllowed, calculatorAllowed ? calculatorType : null]
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
// requireAdminOrTeacher, not requireAdmin — every other verb on this same
// resource (create/get-one/update/delete, right below) already allows a
// teacher; this list route was the one inconsistent holdout, which meant a
// teacher could create/edit/delete an exam by ID but never actually SEE
// the list to find one. The query itself needs no role-based filtering —
// it's already org-wide, the same set of exams an admin and every teacher
// in this org share.
app.get('/api/admin/exams', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.id, e.title, e.total_marks, e.total_time_seconds, e.webcam_required,
             e.calculator_allowed, e.calculator_type,
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
      'SELECT id, title, description, total_marks, total_time_seconds, webcam_required, calculator_allowed, calculator_type, opens_at, closes_at, subject_id FROM exams WHERE id = $1 AND organization_id = $2',
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
  const { title, description = null, totalTimeSeconds, webcamRequired = false, opensAt = null, closesAt = null, items = [], calculatorAllowed = false, calculatorType = null } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  const CALCULATOR_TYPES = ['basic', 'scientific', 'programmer', 'statistics', 'financial'];
  if (calculatorAllowed && !CALCULATOR_TYPES.includes(calculatorType)) {
    return res.status(400).json({ error: 'A valid calculator type is required when calculators are allowed' });
  }

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
       webcam_required = $5, opens_at = $6, closes_at = $7, subject_id = $8,
       calculator_allowed = $9, calculator_type = $10 WHERE id = $11`,
      [title.trim(), description, totalMarks, Math.round(totalTime), !!webcamRequired, opensAt, closesAt, subjectId, !!calculatorAllowed, calculatorAllowed ? calculatorType : null, examId]
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
// CLONE — copies one exam (and its full item set) into one new exam per
// target subject, e.g. running the same test across several sections at
// once instead of rebuilding it by hand each time. Authorized twice: once
// for the source exam's own subject, once per target subject — a teacher
// can only clone FROM a subject they own, and only INTO subjects they own.
// opensAt/closesAt default to the source exam's own schedule but can be
// overridden per clone call (explicit null clears it).
// ============================================================================
app.post('/api/admin/exams/:id/clone', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectIds = Array.isArray(req.body.subjectIds) ? [...new Set(req.body.subjectIds.map(Number).filter(Number.isFinite))] : [];
  if (subjectIds.length === 0) {
    return res.status(400).json({ error: 'At least one target subject is required' });
  }

  try {
    const sourceRes = await pool.query('SELECT * FROM exams WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (sourceRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
    const source = sourceRes.rows[0];
    if (await enforceSubjectAuthority(req, res, source.subject_id)) return;

    for (const sid of subjectIds) {
      if (await enforceSubjectAuthority(req, res, sid)) return;
    }

    const itemsRes = await pool.query('SELECT * FROM exam_items WHERE exam_id = $1 ORDER BY position ASC', [req.params.id]);
    const items = itemsRes.rows;
    const opensAt = req.body.opensAt !== undefined ? req.body.opensAt : source.opens_at;
    const closesAt = req.body.closesAt !== undefined ? req.body.closesAt : source.closes_at;

    const client = await pool.connect();
    const createdIds = [];
    try {
      await client.query('BEGIN');
      for (const sid of subjectIds) {
        const newExamRes = await client.query(
          `INSERT INTO exams (title, description, total_marks, total_time_seconds, webcam_required, opens_at, closes_at, created_by, organization_id, subject_id, calculator_allowed, calculator_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [source.title, source.description, source.total_marks, source.total_time_seconds, source.webcam_required,
           opensAt, closesAt, req.user.userId, req.user.organizationId, sid, source.calculator_allowed, source.calculator_type]
        );
        const newExamId = newExamRes.rows[0].id;
        createdIds.push(newExamId);
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          await client.query(
            `INSERT INTO exam_items (exam_id, type, position, marks, time_limit_seconds, prompt, options, correct_option_id, word_limit, problem_id, starter_code, test_cases)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [newExamId, it.type, i, it.marks, it.time_limit_seconds, it.prompt,
             it.options ? JSON.stringify(it.options) : null, it.correct_option_id, it.word_limit, it.problem_id,
             it.starter_code ? JSON.stringify(it.starter_code) : null, it.test_cases ? JSON.stringify(it.test_cases) : null]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ message: `Cloned into ${createdIds.length} exam${createdIds.length === 1 ? '' : 's'}`, examIds: createdIds });
  } catch (err) {
    console.error('Clone exam error:', err);
    res.status(500).json({ error: 'Failed to clone exam' });
  }
});

// ============================================================================
// QUESTION BANK — reusable exam items, detached from any specific exam
// until ExamForm inserts a copy into one. Same shape/validation as an
// exam_items row (normalizeExamItem), same subject authorization gate as
// every other subject-scoped resource here.
// ============================================================================
app.get('/api/admin/question-bank', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectId = req.query.subjectId != null && req.query.subjectId !== '' ? Number(req.query.subjectId) : null;
  if (await enforceSubjectAuthority(req, res, subjectId)) return;
  try {
    const result = await pool.query(
      `SELECT id, subject_id, type, marks, time_limit_seconds, prompt, options, correct_option_id,
              word_limit, problem_id, starter_code, test_cases, created_at
       FROM question_bank_items
       WHERE organization_id = $1 AND ($2::int IS NULL OR subject_id = $2)
       ORDER BY created_at DESC`,
      [req.user.organizationId, subjectId]
    );
    res.status(200).json({ items: result.rows });
  } catch (err) {
    console.error('List question bank error:', err);
    res.status(500).json({ error: 'Failed to load question bank' });
  }
});

app.post('/api/admin/question-bank', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  if (await enforceSubjectAuthority(req, res, subjectId)) return;

  let item;
  try {
    item = normalizeExamItem(req.body, 0);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (item.type === 'coding' && item.problemId != null) {
    const existing = await pool.query('SELECT id FROM problems WHERE id = $1 AND organization_id = $2', [item.problemId, req.user.organizationId]);
    if (existing.rows.length === 0) return res.status(400).json({ error: 'Coding item references a missing assignment' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO question_bank_items (organization_id, subject_id, type, marks, time_limit_seconds, prompt, options, correct_option_id, word_limit, problem_id, starter_code, test_cases, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [req.user.organizationId, subjectId, item.type, item.marks, item.timeLimitSeconds, item.prompt,
       item.options ? JSON.stringify(item.options) : null, item.correctOptionId, item.wordLimit, item.problemId,
       item.starterCode ? JSON.stringify(item.starterCode) : null, item.testCases ? JSON.stringify(item.testCases) : null, req.user.userId]
    );
    res.status(201).json({ message: 'Saved to question bank', id: result.rows[0].id });
  } catch (err) {
    console.error('Create question bank item error:', err);
    res.status(500).json({ error: 'Failed to save to question bank' });
  }
});

app.delete('/api/admin/question-bank/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const existing = await pool.query('SELECT id, subject_id FROM question_bank_items WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Question bank item not found' });
    if (await enforceSubjectAuthority(req, res, existing.rows[0].subject_id)) return;

    await pool.query('DELETE FROM question_bank_items WHERE id = $1', [req.params.id]);
    res.status(200).json({ message: 'Deleted from question bank' });
  } catch (err) {
    console.error('Delete question bank item error:', err);
    res.status(500).json({ error: 'Failed to delete question bank item' });
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
    await invalidate(`tagvis:${req.user.organizationId}`);
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
    let visible = req.user.role === 'student'
      ? withStatus.filter((e) => e.status !== 'upcoming')
      : withStatus;

    if (req.user.role === 'student') {
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
      'SELECT id, title, description, total_marks, total_time_seconds, webcam_required, calculator_allowed, calculator_type, opens_at, closes_at FROM exams WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user.organizationId]
    );
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });

    const exam = examRes.rows[0];
    const status = getProblemStatus(exam);
    if (status === 'upcoming' && req.user.role === 'student') {
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
      exam: { id: exam.id, title: exam.title, totalMarks: exam.total_marks, totalTimeSeconds: exam.total_time_seconds, calculatorAllowed: exam.calculator_allowed, calculatorType: exam.calculator_type },
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

// Uploads the ONE compiled PDF covering every scan-type item's captured
// pages for this attempt — a separate route from POST /submit below
// (rather than folding the file into that one) because /submit is also
// what the pagehide/beforeunload keepalive beacon hits, and a beacon can't
// realistically carry a multi-page scan through an interactive camera
// flow. The frontend calls this first, while the attempt is still
// in_progress (right after the on-screen items are answered but before
// the real ending submit), then calls /submit as normal straight after.
app.post('/api/exams/:id/scan-submit', authenticateToken, scanUpload.single('file'), async (req, res) => {
  const examId = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'A PDF file is required' });
  if (!isB2Configured()) return res.status(503).json({ error: 'Scanned-assignment storage is not configured yet' });

  try {
    const attemptRes = await pool.query(
      `SELECT id FROM exam_attempts WHERE exam_id = $1 AND user_id = $2 AND status = 'in_progress'`,
      [examId, req.user.userId]
    );
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: 'No in-progress attempt found for this exam' });
    const attemptId = attemptRes.rows[0].id;

    const scanItemsRes = await pool.query(`SELECT id FROM exam_items WHERE exam_id = $1 AND type = 'scan'`, [examId]);
    if (scanItemsRes.rows.length === 0) return res.status(400).json({ error: 'This exam has no scanned items' });

    const objectKey = examScanObjectKey(req.user.organizationId, examId, attemptId);
    await uploadScanPdf(objectKey, req.file.buffer);
    await pool.query(
      `UPDATE exam_attempts SET scan_storage_key = $1, scan_status = 'pending' WHERE id = $2`,
      [objectKey, attemptId]
    );

    // Pre-create the placeholder rows now (ai_assessment/marks NULL) so
    // grading UI has something to show immediately, same as the /submit
    // route's own belt-and-braces insert for whoever skips scanning
    // entirely — ON CONFLICT DO NOTHING makes the two safe to overlap.
    for (const item of scanItemsRes.rows) {
      await pool.query(
        `INSERT INTO exam_scan_answers (attempt_id, item_id) VALUES ($1, $2) ON CONFLICT (attempt_id, item_id) DO NOTHING`,
        [attemptId, item.id]
      );
    }

    if (isOcrConfigured() && !examScanOcrInFlight.has(attemptId)) {
      examScanOcrInFlight.add(attemptId);
      ocrLimit(() => processOneExamScanAttempt(attemptId)).finally(() => examScanOcrInFlight.delete(attemptId));
    }

    res.status(201).json({ status: 'pending' });
  } catch (err) {
    console.error('Exam scan submit error:', err);
    res.status(500).json({ error: 'Failed to upload scanned pages' });
  }
});

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

    // Guarantees every scan-type item has an exam_scan_answers row (marks
    // NULL until a teacher grades it) even if the student never actually
    // scanned anything — see POST /api/exams/:id/scan-submit, called
    // separately (and earlier, while still in_progress) for the actual PDF
    // upload. ON CONFLICT DO NOTHING so a row that upload already created
    // (with its ai_assessment already set) is never clobbered here.
    const scanItems = itemsRes.rows.filter((it) => it.type === 'scan');
    for (const item of scanItems) {
      await pool.query(
        `INSERT INTO exam_scan_answers (attempt_id, item_id) VALUES ($1, $2) ON CONFLICT (attempt_id, item_id) DO NOTHING`,
        [attemptId, item.id]
      );
    }

    if (PROCTOR_END_REASONS.has(reason)) {
      const flagType = reason === 'violation_proctor_absence' ? 'face_absent' : 'phone_detected';
      await pool.query(
        'INSERT INTO exam_proctor_flags (attempt_id, severity, flag_type, detail) VALUES ($1, $2, $3, $4)',
        [attemptId, 'major', flagType, detail]
      );
    }

    res.status(200).json({ submitted: true });

    // Fire-and-forget, after the response — see runExamShortLongAiAssessment's
    // own comment for why this can't be awaited inline. Shares ocrLimit with
    // the scan pipeline's own Groq calls so a burst of exam submissions at
    // the end of a deadline window doesn't fan out unbounded concurrent
    // requests to the same rate-limited API.
    ocrLimit(() => runExamShortLongAiAssessment(attemptId, itemsRes.rows))
      .catch((err) => console.error('Background exam AI assessment error:', err));
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
              ) AND NOT EXISTS (
                SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = a.id AND esa.marks_awarded IS NULL
              ) AS fully_graded
       FROM exam_attempts a WHERE a.exam_id = $1 AND a.status = 'submitted'`,
      [examId]
    );
    const examPercentages = totalMarks > 0
      ? examAttemptsRes.rows.filter((a) => a.fully_graded).map((a) => (a.score / totalMarks) * 100)
      : [];
    const { tag: percentileTag, percentile } = computePercentileTiers(examPercentages)(myPercentage);

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
         AND NOT EXISTS (
           SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = a.id AND esa.marks_awarded IS NULL
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
      percentile: visibility.show_percentile_tag ? percentile : undefined,
      populationSize: visibility.show_percentile_tag ? examPercentages.length : undefined,
      overallExamsPercentileTag: visibility.show_percentile_tag ? overallExamsPercentileTag : undefined,
      gradeTag: visibility.show_grade_tag ? gradeTag : undefined,
    });
  } catch (err) {
    console.error('Exam result error:', err);
    res.status(500).json({ error: 'Failed to load result' });
  }
});

// Per-question breakdown for the "per question" factor on MyPerformance's
// exam graph — every exam has real per-item marks (exam_items.marks vs
// this attempt's own marks_awarded, whichever of exam_answers/
// exam_scan_answers holds this item), unlike assignments where only
// scan-mode ones do.
app.get('/api/exams/:id/questions', authenticateToken, async (req, res) => {
  const examId = req.params.id;
  try {
    const attemptRes = await pool.query('SELECT id, status FROM exam_attempts WHERE exam_id = $1 AND user_id = $2', [examId, req.user.userId]);
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: 'No attempt found for this exam' });
    if (attemptRes.rows[0].status !== 'submitted') return res.status(409).json({ error: 'This exam has not been finished yet' });
    const attemptId = attemptRes.rows[0].id;

    const examRes = await pool.query('SELECT closes_at FROM exams WHERE id = $1', [examId]);
    if (examRes.rows[0]?.closes_at && new Date(examRes.rows[0].closes_at) > new Date()) {
      return res.status(200).json({ status: 'pending', reason: 'deadline' });
    }
    if (!(await isAttemptFullyGraded(attemptId))) {
      return res.status(200).json({ status: 'pending', reason: 'grading' });
    }

    const itemsRes = await pool.query(
      `SELECT i.position, i.marks AS max_marks,
              COALESCE(ea.marks_awarded, esa.marks_awarded) AS marks_awarded
       FROM exam_items i
       LEFT JOIN exam_answers ea ON ea.item_id = i.id AND ea.attempt_id = $1
       LEFT JOIN exam_scan_answers esa ON esa.item_id = i.id AND esa.attempt_id = $1
       WHERE i.exam_id = $2
       ORDER BY i.position ASC`,
      [attemptId, examId]
    );
    res.status(200).json({
      status: 'graded',
      questions: itemsRes.rows.map((r, i) => ({
        label: `Q${r.position ?? i + 1}`,
        earned: r.marks_awarded != null ? Number(r.marks_awarded) : null,
        max: Number(r.max_marks),
      })),
    });
  } catch (err) {
    console.error('Exam questions breakdown error:', err);
    res.status(500).json({ error: 'Failed to load question breakdown' });
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

// Every attempt at one exam, with its flag counts, for the flag timeline
// viewer in the Exams panel's "Attempts" expander — reachable by any
// teacher there too (see GET /api/admin/exams's own comment: same
// "list route was the one inconsistent requireAdmin holdout" bug), so
// requireAdminOrTeacher here as well. The query itself is already scoped
// to one exam within the caller's own org, nothing admin-specific in it.
app.get('/api/admin/exams/:id/attempts', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const examRes = await pool.query('SELECT total_marks, subject_id FROM exams WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
    if (await enforceSubjectAuthority(req, res, examRes.rows[0].subject_id)) return;
    const totalMarks = examRes.rows[0].total_marks;

    const result = await pool.query(
      `SELECT a.id, a.status, a.score, a.end_reason, a.started_at, a.ended_at, u.email, u.name,
              COUNT(f.id) FILTER (WHERE f.severity = 'minor') AS minor_flag_count,
              COUNT(f.id) FILTER (WHERE f.severity = 'major') AS major_flag_count,
              NOT EXISTS (
                SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
                WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
              ) AND NOT EXISTS (
                SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = a.id AND esa.marks_awarded IS NULL
              ) AS fully_graded
       FROM exam_attempts a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN exam_proctor_flags f ON f.attempt_id = a.id
       WHERE a.exam_id = $1
       GROUP BY a.id, u.email, u.name
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

// requireAdminOrTeacher + enforceSubjectAuthority, not requireAdmin — same
// bug/fix as every other route in this exam-grading block: reachable from
// the teacher-only Exams attempts expander, but a teacher could never
// actually load it. Scoped to the exam's own subject_id.
app.get('/api/admin/exam-attempts/:attemptId/flags', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    // exam_proctor_flags has no organization_id of its own — scoped
    // transitively via attempt -> exam, checked here so one org's admin
    // can't read another's flag timeline by guessing an attempt id.
    const examRes = await pool.query(
      `SELECT e.subject_id FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND e.organization_id = $2`,
      [req.params.attemptId, req.user.organizationId]
    );
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Attempt not found' });
    if (await enforceSubjectAuthority(req, res, examRes.rows[0].subject_id)) return;

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
app.get('/api/admin/exam-attempts/:attemptId/answers', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const examRes = await pool.query(
      `SELECT e.subject_id FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND e.organization_id = $2`,
      [req.params.attemptId, req.user.organizationId]
    );
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Attempt not found' });
    if (await enforceSubjectAuthority(req, res, examRes.rows[0].subject_id)) return;

    const result = await pool.query(
      `SELECT ea.id AS answer_id, ei.id AS item_id, ei.type, ei.prompt, ei.marks, ei.options,
              ea.marks_awarded, ea.selected_option_id, ea.text_answer, ea.is_correct,
              ea.passed_count, ea.total_count, ea.code, ea.language, ea.remarks, ea.ai_assessment
       FROM exam_answers ea
       JOIN exam_items ei ON ei.id = ea.item_id
       JOIN exam_attempts a ON a.id = ea.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE ea.attempt_id = $1 AND e.organization_id = $2
       ORDER BY ei.position ASC`,
      [req.params.attemptId, req.user.organizationId]
    );

    // scan items live in a separate table (see exam_scan_answers' own
    // comment) — folded into the same response so the grading UI doesn't
    // need a second round trip. attemptScan is null for an attempt with no
    // scan-type items at all (the common case — most exams have none).
    const scanAnswersRes = await pool.query(
      `SELECT esa.id AS answer_id, ei.id AS item_id, ei.type, ei.prompt, ei.marks,
              esa.marks_awarded, esa.ai_assessment, esa.remarks
       FROM exam_scan_answers esa
       JOIN exam_items ei ON ei.id = esa.item_id
       JOIN exam_attempts a ON a.id = esa.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE esa.attempt_id = $1 AND e.organization_id = $2
       ORDER BY ei.position ASC`,
      [req.params.attemptId, req.user.organizationId]
    );

    let attemptScan = null;
    if (scanAnswersRes.rows.length > 0) {
      const attemptRes = await pool.query(
        `SELECT a.scan_storage_key, a.scan_status, a.scan_ocr_text, a.scan_ocr_pages, a.scan_ocr_error
         FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
         WHERE a.id = $1 AND e.organization_id = $2`,
        [req.params.attemptId, req.user.organizationId]
      );
      const row = attemptRes.rows[0];
      attemptScan = row && {
        status: row.scan_storage_key ? (row.scan_status || 'pending') : null,
        ocrText: row.scan_ocr_text,
        ocrPages: row.scan_ocr_pages,
        ocrError: row.scan_ocr_error,
        viewUrl: row.scan_storage_key && isB2Configured() ? await getScanPdfUrl(row.scan_storage_key) : null,
      };
    }

    const overallRemarksRes = await pool.query(
      `SELECT a.overall_remarks FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND e.organization_id = $2`,
      [req.params.attemptId, req.user.organizationId]
    );
    const overallRemarks = overallRemarksRes.rows[0] ? overallRemarksRes.rows[0].overall_remarks : null;

    res.status(200).json({ answers: result.rows, scanAnswers: scanAnswersRes.rows, attemptScan, overallRemarks });
  } catch (err) {
    console.error('List exam answers error:', err);
    res.status(500).json({ error: 'Failed to load answers' });
  }
});

// Admin: manually award marks and/or remarks for one answer. Marks stay
// restricted to short/long (mcq/coding stay auto-graded), but remarks can be
// left on any item type — both fields are independently optional (undefined
// means "don't touch"), same pattern as the assignment grading route.
app.put('/api/admin/exam-answers/:answerId/grade', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const answerRes = await pool.query(
      `SELECT ea.id, ea.attempt_id, ei.type, ei.marks, e.subject_id
       FROM exam_answers ea
       JOIN exam_items ei ON ei.id = ea.item_id
       JOIN exam_attempts a ON a.id = ea.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE ea.id = $1 AND e.organization_id = $2`,
      [req.params.answerId, req.user.organizationId]
    );
    if (answerRes.rows.length === 0) return res.status(404).json({ error: 'Answer not found' });
    if (await enforceSubjectAuthority(req, res, answerRes.rows[0].subject_id)) return;

    const answer = answerRes.rows[0];

    if (req.body.marksAwarded !== undefined) {
      if (answer.type !== 'short' && answer.type !== 'long') {
        return res.status(400).json({ error: 'Only short/long answers can be manually graded' });
      }
      const marksAwarded = Number(req.body.marksAwarded);
      if (!Number.isFinite(marksAwarded) || marksAwarded < 0 || marksAwarded > answer.marks) {
        return res.status(400).json({ error: `Marks must be between 0 and ${answer.marks}` });
      }
      await pool.query('UPDATE exam_answers SET marks_awarded = $1 WHERE id = $2', [Math.round(marksAwarded), answer.id]);
    }

    if (req.body.remarks !== undefined) {
      const remarks = String(req.body.remarks).trim() || null;
      await pool.query('UPDATE exam_answers SET remarks = $1 WHERE id = $2', [remarks, answer.id]);
    }

    const score = await recomputeExamAttemptScore(answer.attempt_id);
    const fullyGraded = await isAttemptFullyGraded(answer.attempt_id);
    res.status(200).json({ score, fullyGraded });
  } catch (err) {
    console.error('Grade exam answer error:', err);
    res.status(500).json({ error: 'Failed to save grade' });
  }
});

// Admin: manually award marks and/or remarks for one scan item's answer.
// Every row in exam_scan_answers is inherently a scan-type item by
// construction (see POST /api/exams/:id/submit / scan-submit), so there's
// no type check to make here the way the short/long route above needs one.
app.put('/api/admin/exam-scan-answers/:answerId/grade', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const answerRes = await pool.query(
      `SELECT esa.id, esa.attempt_id, ei.marks, e.subject_id
       FROM exam_scan_answers esa
       JOIN exam_items ei ON ei.id = esa.item_id
       JOIN exam_attempts a ON a.id = esa.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE esa.id = $1 AND e.organization_id = $2`,
      [req.params.answerId, req.user.organizationId]
    );
    if (answerRes.rows.length === 0) return res.status(404).json({ error: 'Answer not found' });
    if (await enforceSubjectAuthority(req, res, answerRes.rows[0].subject_id)) return;

    const answer = answerRes.rows[0];

    if (req.body.marksAwarded !== undefined) {
      const marksAwarded = Number(req.body.marksAwarded);
      if (!Number.isFinite(marksAwarded) || marksAwarded < 0 || marksAwarded > answer.marks) {
        return res.status(400).json({ error: `Marks must be between 0 and ${answer.marks}` });
      }
      await pool.query('UPDATE exam_scan_answers SET marks_awarded = $1 WHERE id = $2', [Math.round(marksAwarded), answer.id]);
    }

    if (req.body.remarks !== undefined) {
      const remarks = String(req.body.remarks).trim() || null;
      await pool.query('UPDATE exam_scan_answers SET remarks = $1 WHERE id = $2', [remarks, answer.id]);
    }

    const score = await recomputeExamAttemptScore(answer.attempt_id);
    const fullyGraded = await isAttemptFullyGraded(answer.attempt_id);
    res.status(200).json({ score, fullyGraded });
  } catch (err) {
    console.error('Grade exam scan answer error:', err);
    res.status(500).json({ error: 'Failed to save grade' });
  }
});

// Admin: set the overall remarks for an exam attempt (separate from any
// per-question remarks above).
app.put('/api/admin/exam-attempts/:attemptId/remarks', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const attemptRes = await pool.query(
      `SELECT a.id, e.subject_id FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND e.organization_id = $2`,
      [req.params.attemptId, req.user.organizationId]
    );
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: 'Attempt not found' });
    if (await enforceSubjectAuthority(req, res, attemptRes.rows[0].subject_id)) return;

    const overallRemarks = String(req.body.overallRemarks || '').trim() || null;
    await pool.query('UPDATE exam_attempts SET overall_remarks = $1 WHERE id = $2', [overallRemarks, req.params.attemptId]);
    res.status(200).json({ overallRemarks });
  } catch (err) {
    console.error('Set exam attempt remarks error:', err);
    res.status(500).json({ error: 'Failed to save remarks' });
  }
});

// Manually triggers OCR for one exam attempt's scanned pages right now,
// instead of waiting — mirrors POST /api/admin/scan-submissions/:id/process
// for assignments. Exams have no shared deadline sweep to wait on in the
// first place (see processOneExamScanAttempt's own comment), so this is
// really just for retrying an ocr_failed attempt.
app.post('/api/admin/exam-attempts/:attemptId/process-scan', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const attemptRes = await pool.query(
      `SELECT a.id, a.scan_storage_key, e.subject_id FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND e.organization_id = $2`,
      [req.params.attemptId, req.user.organizationId]
    );
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: 'Attempt not found' });
    if (await enforceSubjectAuthority(req, res, attemptRes.rows[0].subject_id)) return;
    if (!attemptRes.rows[0].scan_storage_key) return res.status(400).json({ error: 'No scanned pages were submitted for this attempt' });
    if (!isB2Configured()) return res.status(503).json({ error: 'Scanned-assignment storage is not configured yet' });
    if (!isOcrConfigured()) return res.status(503).json({ error: 'OCR is not configured yet' });

    const attemptId = attemptRes.rows[0].id;
    if (examScanOcrInFlight.has(attemptId)) return res.status(409).json({ error: 'Already processing' });

    examScanOcrInFlight.add(attemptId);
    ocrLimit(() => processOneExamScanAttempt(attemptId)).finally(() => examScanOcrInFlight.delete(attemptId));
    res.status(202).json({ status: 'processing' });
  } catch (err) {
    console.error('Manual exam scan OCR trigger error:', err);
    res.status(500).json({ error: 'Failed to start OCR' });
  }
});

// ============================================================================
// SCANNED ASSIGNMENTS — Phase 2. Client-side capture/bundling/upload only;
// no OCR/comparator processing happens yet (see ensureScanSubmissionsSchema
// etc. above — those tables exist, but the columns OCR would fill in stay
// NULL until a later phase runs the actual pipeline against 'pending' rows).
// ============================================================================

// Resolves everything the frontend needs to build the auto-filename
// (<student>_<class>_<roll>_<assignment>_<subject>.pdf) — kept server-side
// rather than reimplemented in the frontend, since org-tree path resolution
// (getOrgUnitLookup/resolveOrgUnitPath) and roll-number/subject lookups
// already exist here and nowhere on the client.
app.get('/api/me/scan-context', authenticateToken, async (req, res) => {
  const problemId = req.query.problemId;
  if (!problemId) return res.status(400).json({ error: 'problemId is required' });

  try {
    const problemRes = await pool.query(
      `SELECT p.assignment_no, p.submission_mode, s.name AS subject_name
       FROM problems p LEFT JOIN subjects s ON s.id = p.subject_id
       WHERE p.id = $1 AND p.organization_id = $2`,
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    if (problemRes.rows[0].submission_mode !== 'scan') {
      return res.status(400).json({ error: 'This assignment does not accept scanned submissions' });
    }

    const userRes = await pool.query(
      `SELECT u.name, m.org_unit_id, m.roll_number
       FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2
       WHERE u.id = $1`,
      [req.user.userId, req.user.organizationId]
    );
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Membership not found' });
    const { name, org_unit_id: orgUnitId, roll_number: rollNumber } = userRes.rows[0];

    const unitLookup = await getOrgUnitLookup(req.user.organizationId);
    const classPath = resolveOrgUnitPath(unitLookup, orgUnitId).map((p) => p.name).join(' ');

    // Shown to the student before the camera opens (see ScanCapture.jsx's
    // pre-scan questions screen) — they should know what's being asked
    // before they start scanning, not find out by re-reading a paper copy.
    // Also what actually drives the on-screen answer form for mcq/short/
    // long/coding items — same sanitization posture as exam_items' own
    // GET /api/exams/:id/start (hidden test cases and correct_option_id
    // never leave the server).
    const questionsRes = await pool.query(
      `SELECT id, prompt, marks, type, options, word_limit, starter_code, test_cases
       FROM scan_assignment_questions WHERE problem_id = $1 ORDER BY position ASC`,
      [problemId]
    );
    const questions = questionsRes.rows.map((q) => {
      const base = { id: q.id, type: q.type, marks: q.marks, prompt: q.prompt };
      if (q.type === 'mcq') return { ...base, options: q.options };
      if (q.type === 'short' || q.type === 'long') return { ...base, wordLimit: q.word_limit };
      if (q.type === 'coding') {
        const samples = Array.isArray(q.test_cases)
          ? q.test_cases.filter((tc) => !tc.isHidden).map((tc) => ({ input: tc.input, expected_output: tc.expectedOutput }))
          : [];
        return { ...base, starterCode: q.starter_code || {}, samples };
      }
      return base; // scan
    });

    res.status(200).json({
      studentName: name || null,
      classPath: classPath || null,
      rollNumber: rollNumber || null,
      assignmentNo: problemRes.rows[0].assignment_no,
      subjectName: problemRes.rows[0].subject_name || null,
      questions,
    });
  } catch (err) {
    console.error('Scan context error:', err);
    res.status(500).json({ error: 'Failed to load scan context' });
  }
});

// Accepts the client-bundled PDF, uploads it to B2, and records a 'pending'
// row — no OCR is triggered here. OCR is deliberately deferred until the
// assignment's own deadline passes (a later phase's sweep will pick up
// 'pending' rows on already-closed assignments), not run per-upload —
// since a student can resubmit freely up to the deadline (see the
// replace-on-resubmit logic below) and only the LAST submission before
// closes_at is ever graded, running OCR on every intermediate attempt
// would just burn through the OCR Space's free-tier compute on discarded
// work. Responds as soon as the upload completes; the frontend can poll
// GET /api/scan-submissions/:id/status, which for now will just always
// read back 'pending' — accurate given nothing progresses it yet.
// Grades every digital (mcq/short/long/coding) answer against a scan-mode
// assignment's questions, upserting one scan_submission_answers row per
// question — the scan-mode counterpart to finalizeExamAttempt, same
// mcq-exact/coding-partial-credit/short-long-manual split. scan-type
// questions are never touched here (see the OCR pipeline instead — every
// scan item in the assignment shares the ONE compiled PDF this route
// stores, not a per-item row this function would create).
async function finalizeScanSubmissionDigitalAnswers(submissionId, questions, answers) {
  const questionsById = new Map(questions.map((q) => [q.id, q]));

  for (const ans of answers || []) {
    const q = questionsById.get(Number(ans.questionId));
    if (!q || q.type === 'scan') continue;

    let row = {
      selected_option_id: null, text_answer: null, language: null, code: null,
      is_correct: null, passed_count: null, total_count: null, marks_awarded: null,
    };

    if (q.type === 'mcq') {
      const selected = ans.selectedOptionId != null ? String(ans.selectedOptionId) : null;
      const correct = selected != null && selected === q.correct_option_id;
      row.selected_option_id = selected;
      row.is_correct = correct;
      row.marks_awarded = correct ? q.marks : 0;
    } else if (q.type === 'short' || q.type === 'long') {
      row.text_answer = ans.textAnswer != null ? String(ans.textAnswer) : null;
    } else if (q.type === 'coding') {
      const language = ans.language || null;
      const code = ans.code != null ? String(ans.code) : '';
      let passedCount = 0;
      let totalCount = 0;
      try {
        const testCases = Array.isArray(q.test_cases)
          ? q.test_cases.map((tc) => ({ input: tc.input, expected_output: tc.expectedOutput }))
          : [];
        ({ passedCount, totalCount } = await gradeCodingAnswer(testCases, language, code));
      } catch (err) {
        console.error('Scan assignment coding answer grading error:', err);
      }
      row.language = language;
      row.code = code;
      row.passed_count = passedCount;
      row.total_count = totalCount;
      row.marks_awarded = totalCount > 0 ? Math.round((q.marks * passedCount) / totalCount) : 0;
    }

    await pool.query(
      `INSERT INTO scan_submission_answers (submission_id, question_id, selected_option_id, text_answer, language, code, is_correct, passed_count, total_count, marks_awarded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (submission_id, question_id) DO UPDATE SET
         selected_option_id = EXCLUDED.selected_option_id, text_answer = EXCLUDED.text_answer,
         language = EXCLUDED.language, code = EXCLUDED.code, is_correct = EXCLUDED.is_correct,
         passed_count = EXCLUDED.passed_count, total_count = EXCLUDED.total_count, marks_awarded = EXCLUDED.marks_awarded`,
      [submissionId, q.id, row.selected_option_id, row.text_answer, row.language, row.code,
        row.is_correct, row.passed_count, row.total_count, row.marks_awarded]
    );
  }
}

// Mirrors runExamShortLongAiAssessment (see near the exam submit route) for
// the scan-assignment side: same posture — assist-only, one Groq call per
// item, never touches marks_awarded, just a note a teacher sees next to the
// grade input in ScanReview. Needed because processOneScanSubmission's own
// AI-assessment call only ever covers type='scan' questions (see its own
// comment) — short/long questions submitted digitally alongside (or instead
// of) a scan never reach that function, and a scan-mode assignment with
// only short/long questions never reaches it at all (see the initialStatus
// comment below).
async function runScanShortLongAiAssessment(submissionId, questions) {
  if (!isGroqConfigured()) return;
  const shortLongQuestions = questions.filter((q) => q.type === 'short' || q.type === 'long');
  if (shortLongQuestions.length === 0) return;
  const questionsById = new Map(shortLongQuestions.map((q) => [q.id, q]));

  try {
    const answersRes = await pool.query(
      'SELECT id, question_id, text_answer FROM scan_submission_answers WHERE submission_id = $1 AND question_id = ANY($2::int[])',
      [submissionId, shortLongQuestions.map((q) => q.id)]
    );
    for (const row of answersRes.rows) {
      if (!row.text_answer || !row.text_answer.trim()) continue;
      const q = questionsById.get(row.question_id);
      if (!q) continue;
      const [assessment] = await assessAnswers([{ prompt: q.prompt, marks: q.marks }], row.text_answer, { isOcr: false });
      await pool.query('UPDATE scan_submission_answers SET ai_assessment = $1 WHERE id = $2', [assessment || null, row.id]);
    }
  } catch (err) {
    console.error(`Scan short/long AI assessment failed for submission ${submissionId}:`, err);
  }
}

app.post('/api/problems/:id/scan-submit', authenticateToken, scanUpload.single('file'), async (req, res) => {
  const problemId = req.params.id;
  if (!isB2Configured()) return res.status(503).json({ error: 'Scanned-assignment storage is not configured yet' });

  try {
    const problemRes = await pool.query(
      'SELECT submission_mode, opens_at, closes_at FROM problems WHERE id = $1 AND organization_id = $2',
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    if (problemRes.rows[0].submission_mode !== 'scan') {
      return res.status(400).json({ error: 'This assignment does not accept scanned submissions' });
    }
    const status = getProblemStatus(problemRes.rows[0]);
    if (status !== 'open' && req.user.role !== 'admin') {
      return res.status(403).json({ error: status === 'upcoming' ? 'This assignment is not open yet' : 'This assignment is closed' });
    }

    const questionsRes = await pool.query(
      'SELECT * FROM scan_assignment_questions WHERE problem_id = $1 ORDER BY position ASC',
      [problemId]
    );
    const questions = questionsRes.rows;
    const hasScanQuestions = questions.some((q) => q.type === 'scan');
    if (hasScanQuestions && !req.file) return res.status(400).json({ error: 'A PDF file is required' });

    let answers = [];
    if (req.body.answers) {
      try {
        answers = JSON.parse(req.body.answers);
        if (!Array.isArray(answers)) answers = [];
      } catch {
        return res.status(400).json({ error: 'Invalid answers payload' });
      }
    }

    // A student can resubmit as many times as they like before the
    // deadline — each new upload REPLACES the previous one outright (not
    // "keep both, use the latest"), since only the final submission is
    // ever meant to count. Delete the old row's storage object too, not
    // just the DB row, so repeated resubmission doesn't quietly accumulate
    // orphaned files in the bucket.
    const existing = await pool.query(
      'SELECT id, storage_key FROM scan_submissions WHERE problem_id = $1 AND user_id = $2',
      [problemId, req.user.userId]
    );
    if (existing.rows.length > 0) {
      const previous = existing.rows[0];
      await pool.query('DELETE FROM scan_submissions WHERE id = $1', [previous.id]);
      if (previous.storage_key) {
        try {
          await deleteScanPdf(previous.storage_key);
        } catch (err) {
          console.error('Failed to delete superseded scan PDF (continuing anyway):', err);
        }
      }
    }

    const filename = String(req.body.filename || 'scan.pdf').trim();
    // No scan-type questions at all -> nothing ever needs OCR, so this
    // starts (and stays) 'ocr_done' rather than 'pending' — otherwise the
    // deadline sweep would try to download/OCR a storage_key that was
    // never actually uploaded.
    const initialStatus = hasScanQuestions ? 'pending' : 'ocr_done';
    const insertRes = await pool.query(
      `INSERT INTO scan_submissions (problem_id, user_id, storage_key, original_filename, status)
       VALUES ($1, $2, '', $3, $4) RETURNING id`,
      [problemId, req.user.userId, filename, initialStatus]
    );
    const submissionId = insertRes.rows[0].id;

    if (req.file) {
      const objectKey = scanObjectKey(req.user.organizationId, problemId, submissionId);
      await uploadScanPdf(objectKey, req.file.buffer);
      await pool.query('UPDATE scan_submissions SET storage_key = $1 WHERE id = $2', [objectKey, submissionId]);
    }

    await finalizeScanSubmissionDigitalAnswers(submissionId, questions, answers);

    res.status(201).json({ submissionId, status: initialStatus });

    // Fire-and-forget, after the response — see runScanShortLongAiAssessment
    // for why this can't be awaited inline. Shares ocrLimit with the rest of
    // the scan/exam Groq calls so a burst of submissions doesn't fan out
    // unbounded concurrent requests to the same rate-limited API.
    ocrLimit(() => runScanShortLongAiAssessment(submissionId, questions))
      .catch((err) => console.error('Background scan AI assessment error:', err));

    // Fire-and-forget typed-answer plagiarism check — separate from the OCR
    // pipeline's runTextPlagiarismComparator, which only ever fires (via
    // processOneScanSubmission) once the assignment's deadline passes.
    runTypedTextPlagiarismComparator(submissionId, problemId, questions)
      .catch((err) => console.error('Background scan plagiarism check error:', err));
  } catch (err) {
    console.error('Scan submit error:', err);
    res.status(500).json({ error: 'Failed to upload scanned submission' });
  }
});

app.get('/api/scan-submissions/:id/status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ss.id, ss.status, ss.ocr_error, ss.created_at, ss.ocr_completed_at
       FROM scan_submissions ss JOIN problems p ON p.id = ss.problem_id
       WHERE ss.id = $1 AND p.organization_id = $2 AND ss.user_id = $3`,
      [req.params.id, req.user.organizationId, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Submission not found' });
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Scan submission status error:', err);
    res.status(500).json({ error: 'Failed to load submission status' });
  }
});

// A student's own submission for one scan-mode assignment — since a
// resubmission always replaces the previous one (see scan-submit above),
// there's at most one row to find. Returns null (not 404) when the student
// simply hasn't submitted yet, since "not submitted" is a normal, expected
// state for the caller to render around, not an error.
app.get('/api/me/scan-submission', authenticateToken, async (req, res) => {
  const problemId = req.query.problemId;
  if (!problemId) return res.status(400).json({ error: 'problemId is required' });

  try {
    const result = await pool.query(
      `SELECT ss.id, ss.status, ss.original_filename, ss.storage_key, ss.created_at, ss.ocr_error, ss.penalized, ss.overall_remarks
       FROM scan_submissions ss JOIN problems p ON p.id = ss.problem_id
       WHERE ss.problem_id = $1 AND p.organization_id = $2 AND ss.user_id = $3`,
      [problemId, req.user.organizationId, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(200).json({ submission: null });

    const row = result.rows[0];
    const viewUrl = row.storage_key && isB2Configured() ? await getScanPdfUrl(row.storage_key) : null;

    // Only shown once every question has actually been graded — a partial
    // grade-in-progress isn't a result yet. mcq/coding questions get their
    // marks_awarded set automatically at submit time (see
    // finalizeScanSubmissionDigitalAnswers); scan/short/long stay NULL
    // until a teacher enters something via PUT
    // /api/admin/scan-submissions/:id/grade.
    const answersRes = await pool.query(
      `SELECT q.prompt, q.marks AS max_marks, sa.marks_awarded, sa.remarks
       FROM scan_assignment_questions q
       LEFT JOIN scan_submission_answers sa ON sa.question_id = q.id AND sa.submission_id = $1
       WHERE q.problem_id = $2 ORDER BY q.position ASC`,
      [row.id, problemId]
    );
    const fullyGraded = answersRes.rows.length > 0 && answersRes.rows.every((a) => a.marks_awarded !== null);

    res.status(200).json({
      submission: {
        id: row.id,
        status: row.status,
        filename: row.original_filename,
        createdAt: row.created_at,
        ocrError: row.ocr_error,
        penalized: row.penalized,
        viewUrl,
        // A teacher's overall note is visible as soon as it exists, same
        // as any other courtesy feedback — not gated behind fullyGraded
        // the way the actual score/percentile-affecting grade is below.
        overallRemarks: row.overall_remarks,
        grade: fullyGraded ? {
          totalMarks: answersRes.rows.reduce((sum, a) => sum + a.max_marks, 0),
          awardedMarks: row.penalized ? 0 : answersRes.rows.reduce((sum, a) => sum + a.marks_awarded, 0),
          questions: answersRes.rows.map((a) => ({ prompt: a.prompt, maxMarks: a.max_marks, marksAwarded: row.penalized ? 0 : a.marks_awarded, remarks: a.remarks })),
        } : null,
      },
    });
  } catch (err) {
    console.error('Get own scan submission error:', err);
    res.status(500).json({ error: 'Failed to load your submission' });
  }
});

// Every student's scan submission for one assignment — admin-only, same
// gating as the code-judge equivalent (GET /api/admin/problems/:id/attempts)
// right above this, which is also requireAdmin-only rather than
// requireAdminOrTeacher; matched here for consistency rather than widening
// access unilaterally. At most one row per student (see the UNIQUE
// (problem_id, user_id) index), so this is already every student's FINAL
// submission, not a "best of many" pick the way code-judge attempts are.
app.get('/api/admin/problems/:id/scan-submissions', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;

    const totalMarksRes = await pool.query('SELECT COALESCE(SUM(marks), 0) AS total FROM scan_assignment_questions WHERE problem_id = $1', [req.params.id]);
    const totalMarks = Number(totalMarksRes.rows[0].total);

    const hasScanQuestionsRes = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM scan_assignment_questions WHERE problem_id = $1 AND type = 'scan') AS has_scan_questions`,
      [req.params.id]
    );
    const hasScanQuestions = hasScanQuestionsRes.rows[0].has_scan_questions;

    const result = await pool.query(
      `SELECT ss.id, ss.status, ss.original_filename, ss.storage_key, ss.created_at, ss.ocr_error, ss.penalized, ss.processing_started_at, u.email, u.name,
              (SELECT COALESCE(SUM(sa.marks_awarded), 0) FROM scan_submission_answers sa WHERE sa.submission_id = ss.id) AS awarded_marks,
              (SELECT COUNT(*) FROM scan_submission_answers sa WHERE sa.submission_id = ss.id AND sa.marks_awarded IS NOT NULL) AS graded_count,
              (SELECT COUNT(*) FROM scan_assignment_questions WHERE problem_id = ss.problem_id) AS question_count
       FROM scan_submissions ss JOIN users u ON u.id = ss.user_id
       WHERE ss.problem_id = $1
       ORDER BY u.email ASC`,
      [req.params.id]
    );

    const configured = isB2Configured();
    const submissions = await Promise.all(result.rows.map(async (row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      status: row.status,
      filename: row.original_filename,
      createdAt: row.created_at,
      ocrError: row.ocr_error,
      penalized: row.penalized,
      processingStartedAt: row.processing_started_at,
      totalMarks,
      awardedMarks: row.penalized ? 0 : Number(row.awarded_marks),
      fullyGraded: Number(row.graded_count) === Number(row.question_count) && Number(row.question_count) > 0,
      viewUrl: configured && row.storage_key ? await getScanPdfUrl(row.storage_key) : null,
    })));

    res.status(200).json({ submissions, hasScanQuestions });
  } catch (err) {
    console.error('List scan submissions error:', err);
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

// ============================================================================
// SCAN OCR PIPELINE — runs OCR + AI assessment + both comparators once a
// scan assignment's deadline passes, never per-upload. A resubmission
// before the deadline REPLACES the previous row outright (see
// POST /api/problems/:id/scan-submit), so running this on an intermediate
// upload would just be discarded work burning through the free OCR Space's
// compute budget for nothing — only the row that survives to the deadline
// is ever the final one.
// ============================================================================

// 5-word-shingle Jaccard similarity — standard, cheap near-duplicate-text
// technique, no ML needed. Threshold is per-org and teacher-configurable
// (organizations.scan_plagiarism_threshold) since "how similar is too
// similar" is a judgment call a teacher is better placed to make than a
// hardcoded constant — unlike the handwriting comparator below, which stays
// a fixed conservative constant because nobody would know how to
// meaningfully tune an abstract cosine-similarity number.
function textShingles(text, k = 5) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i <= words.length - k; i++) set.add(words.slice(i, i + k).join(' '));
  return set;
}
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const shingle of setA) if (setB.has(shingle)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// 8-token-shingle Jaccard similarity for coding submissions — same
// technique as textShingles above (jaccardSimilarity is shared), just
// tokenized for code instead of prose: comments stripped first (so a
// student who only adds/removes comments doesn't dodge detection), then
// split into identifiers/numbers/single-char operators rather than words.
// A larger k than the 5-word text shingle since code tokens run shorter
// and denser than prose — 8 keeps boilerplate (loop headers, print calls)
// from dominating the shingle set.
function codeShingles(code, k = 8) {
  const stripped = String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/#.*$/gm, ' ');
  const tokens = stripped.match(/[A-Za-z_]\w*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_]/g) || [];
  const set = new Set();
  for (let i = 0; i <= tokens.length - k; i++) set.add(tokens.slice(i, i + k).join(' '));
  return set;
}

// Runs after a submission judges as Accepted (see POST /api/problems/:id/
// submit) — comparing every retry against every other student's every
// retry would be noisy and quadratic, so this only ever compares final
// passing solutions, one per other student (their own most recent
// Accepted submission to this same problem). Fire-and-forget from the
// submit route: cheap in-memory set ops, no external calls, but never
// worth delaying the judge response over.
async function runCodePlagiarismComparator(submission) {
  try {
    const orgRes = await pool.query(
      'SELECT o.code_plagiarism_threshold FROM organizations o JOIN problems p ON p.organization_id = o.id WHERE p.id = $1',
      [submission.problem_id]
    );
    const threshold = orgRes.rows[0]?.code_plagiarism_threshold ?? 0.6;
    const mySet = codeShingles(submission.code);
    if (mySet.size === 0) return;

    const othersRes = await pool.query(
      `SELECT DISTINCT ON (user_id) id, user_id, code FROM submissions
       WHERE problem_id = $1 AND user_id != $2 AND status = 'Accepted'
       ORDER BY user_id, created_at DESC`,
      [submission.problem_id, submission.user_id]
    );
    for (const other of othersRes.rows) {
      const similarity = jaccardSimilarity(mySet, codeShingles(other.code));
      if (similarity < threshold) continue;
      const [a, b] = submission.id < other.id ? [submission.id, other.id] : [other.id, submission.id];
      await pool.query(
        `INSERT INTO submission_plagiarism_flags (problem_id, submission_a_id, submission_b_id, similarity_score)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (problem_id, submission_a_id, submission_b_id) DO NOTHING`,
        [submission.problem_id, a, b, similarity]
      );
    }
  } catch (err) {
    console.error('Code plagiarism comparator failed:', err);
  }
}

// handwriting_features -> a flat 21-dim vector (8 stroke-width bins + 12
// slant-angle bins + 1 ink-density scalar) for cosine similarity.
function flattenHandwritingFeatures(features) {
  if (!features) return null;
  return [...(features.stroke_width_hist || []), ...(features.slant_angle_hist || []), features.ink_density ?? 0];
}
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
// High and fixed on purpose — see the false-positive-risk note on
// ensureScanHandwritingFlagsSchema above; this never auto-penalizes, only
// ever surfaces for teacher review, so a conservative threshold keeps that
// review queue meaningful rather than flooded with coincidental matches.
const HANDWRITING_SIMILARITY_THRESHOLD = 0.9;

async function runTextPlagiarismComparator(client, submission) {
  const orgRes = await client.query(
    'SELECT p.plagiarism_threshold AS assignment_threshold, o.scan_plagiarism_threshold AS org_threshold FROM organizations o JOIN problems p ON p.organization_id = o.id WHERE p.id = $1',
    [submission.problem_id]
  );
  const threshold = orgRes.rows[0]?.assignment_threshold ?? orgRes.rows[0]?.org_threshold ?? 0.4;
  const mySet = textShingles(submission.ocr_text);
  if (mySet.size === 0) return;

  const othersRes = await client.query(
    `SELECT id, ocr_text FROM scan_submissions
     WHERE problem_id = $1 AND id != $2 AND status = 'ocr_done' AND ocr_text IS NOT NULL`,
    [submission.problem_id, submission.id]
  );
  for (const other of othersRes.rows) {
    const similarity = jaccardSimilarity(mySet, textShingles(other.ocr_text));
    if (similarity < threshold) continue;
    const [a, b] = submission.id < other.id ? [submission.id, other.id] : [other.id, submission.id];
    await client.query(
      `INSERT INTO scan_plagiarism_flags (problem_id, submission_a_id, submission_b_id, similarity_score, flag_type)
       VALUES ($1, $2, $3, $4, 'text_similarity')
       ON CONFLICT (problem_id, submission_a_id, submission_b_id, flag_type) WHERE question_id IS NULL DO NOTHING`,
      [submission.problem_id, a, b, similarity]
    );
  }
}

// Typed-answer counterpart to the comparator above — that one only ever
// compares scan_submissions.ocr_text (the compiled OCR blob for type='scan'
// questions), so type='short'/'long' answers submitted digitally never
// entered its comparison pool. Run per-question (unlike the OCR version's
// one-blob-per-submission) since each typed answer is already cleanly
// separated by question, unlike a jumbled OCR blob that may cover several
// questions at once. Called directly from the scan-submit route
// (fire-and-forget, see runScanShortLongAiAssessment above) rather than
// from processOneScanSubmission, since a typed-only submission (no scan
// questions) never reaches that function at all — see the initialStatus
// comment in POST /api/problems/:id/scan-submit.
async function runTypedTextPlagiarismComparator(submissionId, problemId, questions) {
  const shortLongQuestions = questions.filter((q) => q.type === 'short' || q.type === 'long');
  if (shortLongQuestions.length === 0) return;

  try {
    const orgRes = await pool.query(
      'SELECT p.plagiarism_threshold AS assignment_threshold, o.scan_plagiarism_threshold AS org_threshold FROM organizations o JOIN problems p ON p.organization_id = o.id WHERE p.id = $1',
      [problemId]
    );
    const threshold = orgRes.rows[0]?.assignment_threshold ?? orgRes.rows[0]?.org_threshold ?? 0.4;

    for (const q of shortLongQuestions) {
      const mineRes = await pool.query(
        'SELECT text_answer FROM scan_submission_answers WHERE submission_id = $1 AND question_id = $2',
        [submissionId, q.id]
      );
      const mySet = textShingles(mineRes.rows[0]?.text_answer);
      if (mySet.size === 0) continue;

      const othersRes = await pool.query(
        `SELECT submission_id, text_answer FROM scan_submission_answers
         WHERE question_id = $1 AND submission_id != $2 AND text_answer IS NOT NULL`,
        [q.id, submissionId]
      );
      for (const other of othersRes.rows) {
        const similarity = jaccardSimilarity(mySet, textShingles(other.text_answer));
        if (similarity < threshold) continue;
        const [a, b] = submissionId < other.submission_id ? [submissionId, other.submission_id] : [other.submission_id, submissionId];
        await pool.query(
          `INSERT INTO scan_plagiarism_flags (problem_id, submission_a_id, submission_b_id, question_id, similarity_score, flag_type)
           VALUES ($1, $2, $3, $4, $5, 'typed_text_similarity')
           ON CONFLICT (problem_id, submission_a_id, submission_b_id, flag_type, question_id) WHERE question_id IS NOT NULL DO NOTHING`,
          [problemId, a, b, q.id, similarity]
        );
      }
    }
  } catch (err) {
    console.error(`Typed-text plagiarism comparator failed for submission ${submissionId}:`, err);
  }
}

async function runHandwritingComparator(client, submission) {
  const myVector = flattenHandwritingFeatures(submission.handwriting_features);
  if (!myVector) return;

  // The org's ENTIRE submission history, not just this assignment — a
  // student's handwriting from a past assignment is valid reference
  // material for flagging a completely different one.
  const othersRes = await client.query(
    `SELECT ss.id, ss.handwriting_features FROM scan_submissions ss
     JOIN problems p ON p.id = ss.problem_id
     WHERE p.organization_id = (SELECT organization_id FROM problems WHERE id = $1)
       AND ss.id != $2 AND ss.status = 'ocr_done' AND ss.handwriting_features IS NOT NULL`,
    [submission.problem_id, submission.id]
  );
  for (const other of othersRes.rows) {
    const similarity = cosineSimilarity(myVector, flattenHandwritingFeatures(other.handwriting_features));
    if (similarity < HANDWRITING_SIMILARITY_THRESHOLD) continue;
    const [a, b] = submission.id < other.id ? [submission.id, other.id] : [other.id, submission.id];
    await client.query(
      `INSERT INTO scan_handwriting_flags (submission_a_id, submission_b_id, similarity_score)
       VALUES ($1, $2, $3) ON CONFLICT (submission_a_id, submission_b_id) DO NOTHING`,
      [a, b, similarity]
    );
  }
}

async function processOneScanSubmission(submissionId) {
  const client = await pool.connect();
  try {
    await client.query(`UPDATE scan_submissions SET status = 'processing', processing_started_at = now() WHERE id = $1`, [submissionId]);

    const subRes = await client.query('SELECT id, problem_id, storage_key FROM scan_submissions WHERE id = $1', [submissionId]);
    if (subRes.rows.length === 0) return;
    const submission = subRes.rows[0];

    if (!isB2Configured()) throw new Error('B2 storage is not configured');
    if (!isOcrConfigured()) throw new Error('OCR Space is not configured');

    const pdfBuffer = await downloadScanPdf(submission.storage_key);
    const { pages, handwriting_features: handwritingFeatures } = await runOcr(pdfBuffer);
    const ocrText = pages.map((p) => p.text).join('\n\n');

    // Only scan-type questions — mcq/short/long/coding ones are already
    // graded (or left for manual short/long grading) at submit time by
    // finalizeScanSubmissionDigitalAnswers, and OCR/AI-assessing them
    // would be nonsensical.
    const questionsRes = await client.query(
      `SELECT id, prompt, marks FROM scan_assignment_questions WHERE problem_id = $1 AND type = 'scan' ORDER BY position ASC`,
      [submission.problem_id]
    );
    const questions = questionsRes.rows;

    // Best-effort — an AI-assessment hiccup shouldn't block OCR text from
    // being saved and the submission from becoming teacher-gradable.
    const assessments = isGroqConfigured()
      ? await assessAnswers(questions.map((q) => ({ prompt: q.prompt, marks: q.marks })), ocrText)
      : questions.map(() => 'AI assessment unavailable (Groq not configured).');

    for (let i = 0; i < questions.length; i++) {
      await client.query(
        `INSERT INTO scan_submission_answers (submission_id, question_id, ai_assessment)
         VALUES ($1, $2, $3)
         ON CONFLICT (submission_id, question_id) DO UPDATE SET ai_assessment = EXCLUDED.ai_assessment`,
        [submissionId, questions[i].id, assessments[i] || null]
      );
    }

    await client.query(
      `UPDATE scan_submissions SET ocr_text = $1, ocr_pages = $2, handwriting_features = $3,
         status = 'ocr_done', ocr_completed_at = now(), ocr_error = NULL WHERE id = $4`,
      [ocrText, JSON.stringify(pages), handwritingFeatures ? JSON.stringify(handwritingFeatures) : null, submissionId]
    );

    const fullSubmission = { ...submission, ocr_text: ocrText, handwriting_features: handwritingFeatures };
    await runTextPlagiarismComparator(client, fullSubmission);
    await runHandwritingComparator(client, fullSubmission);
  } catch (err) {
    console.error(`Scan OCR pipeline failed for submission ${submissionId}:`, err);
    await client.query(
      `UPDATE scan_submissions SET status = 'ocr_failed', ocr_error = $1 WHERE id = $2`,
      [String(err.message || err).slice(0, 500), submissionId]
    ).catch(() => {});
  } finally {
    client.release();
  }
}

// Exam-side counterpart to processOneScanSubmission above — same shape,
// except there's no shared deadline sweep to wait on: each student's own
// submit is what ends their attempt, so this runs immediately from
// POST /api/exams/:id/submit rather than a periodic sweep. Doesn't run the
// cross-submission plagiarism/handwriting comparators scan_submissions
// gets — those compare many students against each other on the SAME
// assignment/deadline, a feature this exam-scan path deliberately doesn't
// take on; OCR + teacher grading is the whole scope here.
async function processOneExamScanAttempt(attemptId) {
  const client = await pool.connect();
  try {
    await client.query(`UPDATE exam_attempts SET scan_status = 'processing' WHERE id = $1`, [attemptId]);

    const attemptRes = await client.query('SELECT id, exam_id, scan_storage_key FROM exam_attempts WHERE id = $1', [attemptId]);
    if (attemptRes.rows.length === 0) return;
    const attempt = attemptRes.rows[0];

    if (!isB2Configured()) throw new Error('B2 storage is not configured');
    if (!isOcrConfigured()) throw new Error('OCR is not configured');

    const pdfBuffer = await downloadScanPdf(attempt.scan_storage_key);
    const { pages } = await runOcr(pdfBuffer);
    const ocrText = pages.map((p) => p.text).join('\n\n');

    const itemsRes = await client.query(
      `SELECT id, prompt, marks FROM exam_items WHERE exam_id = $1 AND type = 'scan' ORDER BY position ASC`,
      [attempt.exam_id]
    );
    const items = itemsRes.rows;

    // Best-effort — an AI-assessment hiccup shouldn't block OCR text from
    // being saved and the attempt from becoming teacher-gradable.
    const assessments = isGroqConfigured()
      ? await assessAnswers(items.map((it) => ({ prompt: it.prompt, marks: it.marks })), ocrText)
      : items.map(() => 'AI assessment unavailable (Groq not configured).');

    for (let i = 0; i < items.length; i++) {
      await client.query(
        `INSERT INTO exam_scan_answers (attempt_id, item_id, ai_assessment)
         VALUES ($1, $2, $3)
         ON CONFLICT (attempt_id, item_id) DO UPDATE SET ai_assessment = EXCLUDED.ai_assessment`,
        [attemptId, items[i].id, assessments[i] || null]
      );
    }

    await client.query(
      `UPDATE exam_attempts SET scan_ocr_text = $1, scan_ocr_pages = $2,
         scan_status = 'ocr_done', scan_ocr_completed_at = now(), scan_ocr_error = NULL WHERE id = $3`,
      [ocrText, JSON.stringify(pages), attemptId]
    );
  } catch (err) {
    console.error(`Exam scan OCR pipeline failed for attempt ${attemptId}:`, err);
    await client.query(
      `UPDATE exam_attempts SET scan_status = 'ocr_failed', scan_ocr_error = $1 WHERE id = $2`,
      [String(err.message || err).slice(0, 500), attemptId]
    ).catch(() => {});
  } finally {
    client.release();
  }
}

// Runs at most OCR_CONCURRENCY submissions at once, modest by default so a
// deadline shared by many students doesn't hammer the free OCR Space all at
// once — same pLimit pattern as sandboxLimit above, just a separate limiter
// since these are unrelated resource pools.
const ocrLimit = pLimit(Number(process.env.OCR_CONCURRENCY || 2));
const scanOcrInFlight = new Set();
const examScanOcrInFlight = new Set();

async function sweepScanSubmissions() {
  try {
    // Recover rows stuck in 'processing' from a crashed prior process — safe
    // because this sweep runs single-process; anything in 'processing' that
    // isn't in this process's own in-flight set right now can only be stale
    // (a live in-flight row is always tracked here, so it's never touched).
    await pool.query(
      `UPDATE scan_submissions SET status = 'pending' WHERE status = 'processing' AND id != ALL($1::int[])`,
      [[...scanOcrInFlight]]
    );

    const dueRes = await pool.query(
      `SELECT ss.id FROM scan_submissions ss JOIN problems p ON p.id = ss.problem_id
       WHERE ss.status = 'pending' AND p.closes_at IS NOT NULL AND p.closes_at <= now()`
    );
    for (const row of dueRes.rows) {
      if (scanOcrInFlight.has(row.id)) continue;
      scanOcrInFlight.add(row.id);
      ocrLimit(() => processOneScanSubmission(row.id)).finally(() => scanOcrInFlight.delete(row.id));
    }
  } catch (err) {
    console.error('Scan OCR sweep error:', err);
  }
}
const SCAN_OCR_SWEEP_INTERVAL_MS = 60 * 1000;
setInterval(sweepScanSubmissions, SCAN_OCR_SWEEP_INTERVAL_MS);
sweepScanSubmissions();

// ============================================================================
// "New assignment/exam available" notifications — fans a notification out to
// every student who can see the item the moment it actually becomes visible
// to them (respecting opens_at, same computed status getProblemStatus/the
// exam equivalent already use), not at creation time (a teacher may create
// something days before its opens_at, and students shouldn't hear about it
// before they can even see it). Same recipient rule as a subject-scoped
// note: students under the subject's org_unit and every descendant unit
// beneath it; an item with no subject (org-wide) reaches every student in
// the org, same as a subject-less note would.
// ============================================================================

// Shared by both notifiers below. subjectId null means org-wide (every
// student), mirroring how a subject-less note/notice would fan out.
// extraColumn is always one of the two hardcoded literals passed by the
// callers just below (never request input), so the interpolation here never
// touches anything a caller could inject.
async function notifyStudentsOfNewItem(organizationId, subjectId, type, title, extraColumn, extraId) {
  if (subjectId) {
    const subjectRes = await pool.query('SELECT org_unit_id FROM subjects WHERE id = $1 AND organization_id = $2', [subjectId, organizationId]);
    const orgUnitId = subjectRes.rows[0]?.org_unit_id;
    if (!orgUnitId) return;
    await pool.query(
      `WITH RECURSIVE descendant_units AS (
         SELECT id FROM org_units WHERE id = $1
         UNION
         SELECT ou.id FROM org_units ou JOIN descendant_units d ON ou.parent_unit_id = d.id
       )
       INSERT INTO notifications (organization_id, user_id, type, title, ${extraColumn})
       SELECT $2, m.user_id, $3, $4, $5
       FROM memberships m
       WHERE m.organization_id = $2 AND m.role = 'student' AND m.org_unit_id IN (SELECT id FROM descendant_units)`,
      [orgUnitId, organizationId, type, title, extraId]
    );
  } else {
    await pool.query(
      `INSERT INTO notifications (organization_id, user_id, type, title, ${extraColumn})
       SELECT $1, m.user_id, $2, $3, $4
       FROM memberships m WHERE m.organization_id = $1 AND m.role = 'student'`,
      [organizationId, type, title, extraId]
    );
  }
}

async function sweepAssignmentExamNotifications() {
  try {
    const dueProblems = await pool.query(
      `SELECT id, title, subject_id, organization_id FROM problems
       WHERE notified = false AND (opens_at IS NULL OR opens_at <= now())`
    );
    for (const p of dueProblems.rows) {
      try {
        await notifyStudentsOfNewItem(p.organization_id, p.subject_id, 'assignment', `New assignment: ${p.title}`, 'problem_id', p.id);
      } catch (err) {
        console.error(`Failed to notify students of new assignment ${p.id} (marking notified anyway):`, err);
      }
      await pool.query('UPDATE problems SET notified = true WHERE id = $1', [p.id]);
    }

    const dueExams = await pool.query(
      `SELECT id, title, subject_id, organization_id FROM exams
       WHERE notified = false AND (opens_at IS NULL OR opens_at <= now())`
    );
    for (const e of dueExams.rows) {
      try {
        await notifyStudentsOfNewItem(e.organization_id, e.subject_id, 'exam', `New exam: ${e.title}`, 'exam_id', e.id);
      } catch (err) {
        console.error(`Failed to notify students of new exam ${e.id} (marking notified anyway):`, err);
      }
      await pool.query('UPDATE exams SET notified = true WHERE id = $1', [e.id]);
    }
  } catch (err) {
    console.error('Assignment/exam notification sweep error:', err);
  }
}
const ASSIGNMENT_EXAM_NOTIFICATION_SWEEP_INTERVAL_MS = 60 * 1000;
// Unlike sweepScanSubmissions above (whose tables/columns have existed
// since long before this process started), notifications.problem_id/
// exam_id and exams.notified are brand new — starting this sweep
// immediately would race the async bootSchemaStep queue that creates them
// on a fresh boot. Wait for the schema to actually be in place first.
ensureNotificationsSchema().then(() => {
  setInterval(sweepAssignmentExamNotifications, ASSIGNMENT_EXAM_NOTIFICATION_SWEEP_INTERVAL_MS);
  sweepAssignmentExamNotifications();
});

// Full detail for one submission — OCR'd pages, each question with its AI
// assessment and current marks, and this submission's own flags (both
// types). Backs ScanReview.jsx. requireAdmin-only, same gating as every
// other scan-review route (see the note on the list route above).
app.get('/api/admin/scan-submissions/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const subRes = await pool.query(
      `SELECT ss.*, u.email, u.name, p.subject_id FROM scan_submissions ss
       JOIN users u ON u.id = ss.user_id
       JOIN problems p ON p.id = ss.problem_id
       WHERE ss.id = $1 AND p.organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (subRes.rows.length === 0) return res.status(404).json({ error: 'Submission not found' });
    if (await enforceSubjectAuthority(req, res, subRes.rows[0].subject_id)) return;
    const submission = subRes.rows[0];

    const answersRes = await pool.query(
      `SELECT q.id AS question_id, q.position, q.prompt, q.marks AS max_marks, q.type, q.options,
              sa.ai_assessment, sa.marks_awarded, sa.selected_option_id, sa.text_answer,
              sa.is_correct, sa.language, sa.code, sa.passed_count, sa.total_count, sa.remarks
       FROM scan_assignment_questions q
       LEFT JOIN scan_submission_answers sa ON sa.question_id = q.id AND sa.submission_id = $1
       WHERE q.problem_id = $2
       ORDER BY q.position ASC`,
      [submission.id, submission.problem_id]
    );

    const flagsRes = await pool.query(
      `SELECT id, submission_a_id, submission_b_id, similarity_score, status, question_id, flag_type AS type
       FROM scan_plagiarism_flags WHERE submission_a_id = $1 OR submission_b_id = $1
       UNION ALL
       SELECT id, submission_a_id, submission_b_id, similarity_score, status, NULL::integer AS question_id, 'handwriting' AS type
       FROM scan_handwriting_flags WHERE submission_a_id = $1 OR submission_b_id = $1`,
      [submission.id]
    );

    const configured = isB2Configured();
    res.status(200).json({
      id: submission.id,
      email: submission.email,
      name: submission.name,
      status: submission.status,
      ocrError: submission.ocr_error,
      penalized: submission.penalized,
      createdAt: submission.created_at,
      pages: submission.ocr_pages || [],
      viewUrl: configured && submission.storage_key ? await getScanPdfUrl(submission.storage_key) : null,
      overallRemarks: submission.overall_remarks,
      questions: answersRes.rows.map((r) => ({
        questionId: r.question_id,
        prompt: r.prompt,
        maxMarks: r.max_marks,
        type: r.type,
        options: r.options,
        aiAssessment: r.ai_assessment,
        marksAwarded: r.marks_awarded,
        selectedOptionId: r.selected_option_id,
        textAnswer: r.text_answer,
        isCorrect: r.is_correct,
        language: r.language,
        code: r.code,
        passedCount: r.passed_count,
        totalCount: r.total_count,
        remarks: r.remarks,
      })),
      flags: flagsRes.rows.map((f) => ({
        id: f.id,
        type: f.type,
        questionId: f.question_id,
        otherSubmissionId: f.submission_a_id === submission.id ? f.submission_b_id : f.submission_a_id,
        similarityScore: f.similarity_score,
        status: f.status,
      })),
    });
  } catch (err) {
    console.error('Scan submission detail error:', err);
    res.status(500).json({ error: 'Failed to load submission' });
  }
});

// Lets a teacher force one submission through OCR immediately instead of
// waiting for the assignment's deadline to pass (see sweepScanSubmissions
// below for why that's normally deferred — this is the deliberate escape
// hatch for testing/urgency, not a replacement for the sweep). Shares the
// sweep's own concurrency limiter and in-flight tracking so a manual
// trigger can't race the sweep into double-processing the same row, or get
// silently reset back to 'pending' by the sweep's stuck-row recovery.
app.post('/api/admin/scan-submissions/:id/process', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const subRes = await pool.query(
      `SELECT ss.id, ss.status, ss.problem_id, p.subject_id FROM scan_submissions ss JOIN problems p ON p.id = ss.problem_id
       WHERE ss.id = $1 AND p.organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (subRes.rows.length === 0) return res.status(404).json({ error: 'Submission not found' });
    if (await enforceSubjectAuthority(req, res, subRes.rows[0].subject_id)) return;
    if (!isB2Configured()) return res.status(503).json({ error: 'Scanned-assignment storage is not configured yet' });
    if (!isOcrConfigured()) return res.status(503).json({ error: 'OCR is not configured yet' });

    // No scan-type questions -> no PDF was ever uploaded (storage_key is
    // ''), so there's nothing for OCR to read; running it anyway just burns
    // a request on garbage input and leaves the row stuck 'ocr_failed'.
    const hasScanQuestionsRes = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM scan_assignment_questions WHERE problem_id = $1 AND type = 'scan') AS has_scan_questions`,
      [subRes.rows[0].problem_id]
    );
    if (!hasScanQuestionsRes.rows[0].has_scan_questions) {
      return res.status(400).json({ error: 'This assignment has no scanned questions — nothing to OCR.' });
    }

    const submissionId = subRes.rows[0].id;
    if (scanOcrInFlight.has(submissionId)) return res.status(409).json({ error: 'Already processing' });

    scanOcrInFlight.add(submissionId);
    ocrLimit(() => processOneScanSubmission(submissionId)).finally(() => scanOcrInFlight.delete(submissionId));
    res.status(202).json({ status: 'processing' });
  } catch (err) {
    console.error('Manual scan OCR trigger error:', err);
    res.status(500).json({ error: 'Failed to start OCR' });
  }
});

// Lets a teacher upload a PDF on a student's behalf — e.g. a paper answer
// sheet scanned on some other device/app, never touching ScanCapture.jsx's
// in-browser camera flow at all. Deliberately not gated on the assignment
// being 'open' the way the student-facing route is (this is exactly the
// escape hatch for late/offline submissions an admin is entering after the
// fact), and shares that route's exact replace-on-resubmit + storage-key
// logic: whatever the uploaded file's own name is, it's kept only as the
// display label (original_filename) — the actual object key always follows
// scanObjectKey()'s <org>/<problem>/<submissionId>.pdf convention, same as
// every other scan submission, never the incoming filename.
app.post('/api/admin/problems/:id/scan-submissions', authenticateToken, requireAdminOrTeacher, scanUpload.single('file'), async (req, res) => {
  const problemId = req.params.id;
  const studentEmail = String(req.body.email || '').trim().toLowerCase();
  if (!req.file) return res.status(400).json({ error: 'A PDF file is required' });
  if (!studentEmail) return res.status(400).json({ error: "Student's email is required" });
  if (!isB2Configured()) return res.status(503).json({ error: 'Scanned-assignment storage is not configured yet' });

  try {
    const problemRes = await pool.query(
      'SELECT submission_mode, subject_id FROM problems WHERE id = $1 AND organization_id = $2',
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;
    if (problemRes.rows[0].submission_mode !== 'scan') {
      return res.status(400).json({ error: 'This assignment does not accept scanned submissions' });
    }

    const studentRes = await pool.query(
      `SELECT id FROM users WHERE organization_id = $1 AND role = 'student' AND lower(email) = $2`,
      [req.user.organizationId, studentEmail]
    );
    if (studentRes.rows.length === 0) return res.status(404).json({ error: 'No student with that email in this organization' });
    const studentId = studentRes.rows[0].id;

    const existing = await pool.query(
      'SELECT id, storage_key FROM scan_submissions WHERE problem_id = $1 AND user_id = $2',
      [problemId, studentId]
    );
    if (existing.rows.length > 0) {
      const previous = existing.rows[0];
      await pool.query('DELETE FROM scan_submissions WHERE id = $1', [previous.id]);
      if (previous.storage_key) {
        try {
          await deleteScanPdf(previous.storage_key);
        } catch (err) {
          console.error('Failed to delete superseded scan PDF (continuing anyway):', err);
        }
      }
    }

    const filename = String(req.file.originalname || 'scan.pdf').trim();
    const insertRes = await pool.query(
      `INSERT INTO scan_submissions (problem_id, user_id, storage_key, original_filename, status)
       VALUES ($1, $2, '', $3, 'pending') RETURNING id`,
      [problemId, studentId, filename]
    );
    const submissionId = insertRes.rows[0].id;
    const objectKey = scanObjectKey(req.user.organizationId, problemId, submissionId);

    await uploadScanPdf(objectKey, req.file.buffer);
    await pool.query('UPDATE scan_submissions SET storage_key = $1 WHERE id = $2', [objectKey, submissionId]);

    // Unlike the student route, this doesn't wait for the assignment
    // deadline — an admin manually entering an offline submission wants it
    // graded now, not whenever (or if ever) the deadline sweep gets to it.
    if (isOcrConfigured() && !scanOcrInFlight.has(submissionId)) {
      scanOcrInFlight.add(submissionId);
      ocrLimit(() => processOneScanSubmission(submissionId)).finally(() => scanOcrInFlight.delete(submissionId));
    }

    res.status(201).json({ submissionId, status: 'pending' });
  } catch (err) {
    console.error('Admin scan upload error:', err);
    res.status(500).json({ error: 'Failed to upload scanned submission' });
  }
});

// Teacher-entered marks per question — the only thing that ever actually
// grades a scan submission (the AI assessment on each answer is an aid,
// never authoritative; see aiGrading.js). Ignored while penalized=true, so
// a confirmed plagiarism flag can't be silently undone by re-saving a grade
// — see PUT /api/admin/scan-flags/:type/:id for how that flag gets cleared.
app.put('/api/admin/scan-submissions/:id/grade', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { marks, overallRemarks } = req.body; // marks: [{ questionId, marksAwarded, remarks }, ...]
  if (!Array.isArray(marks)) return res.status(400).json({ error: 'marks array is required' });

  try {
    const subRes = await pool.query(
      `SELECT ss.id, ss.problem_id, p.subject_id FROM scan_submissions ss JOIN problems p ON p.id = ss.problem_id
       WHERE ss.id = $1 AND p.organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (subRes.rows.length === 0) return res.status(404).json({ error: 'Submission not found' });
    if (await enforceSubjectAuthority(req, res, subRes.rows[0].subject_id)) return;

    // Max marks per question — validated against below so a teacher can't
    // award more than a question is actually worth (previously unchecked
    // entirely; only the exam-side grading routes enforced this).
    const questionsRes = await pool.query(
      'SELECT id, marks FROM scan_assignment_questions WHERE problem_id = $1',
      [subRes.rows[0].problem_id]
    );
    const maxMarksById = new Map(questionsRes.rows.map((q) => [q.id, q.marks]));

    // marksAwarded/remarks are each independently optional per entry (a
    // remarks-only save on an mcq question, say, shouldn't require also
    // resending its already-correct auto-graded marks) — `undefined` means
    // "leave this field alone", which is why the actual writes below are
    // two separate conditional UPDATEs rather than one upsert that would
    // silently null out whichever field wasn't included this time.
    const updates = [];
    for (const entry of marks) {
      const questionId = Number(entry.questionId);
      if (!questionId) continue;
      if (!maxMarksById.has(questionId)) return res.status(400).json({ error: `Question ${questionId} does not belong to this assignment` });

      let marksAwarded;
      if (entry.marksAwarded === undefined) {
        marksAwarded = undefined;
      } else if (entry.marksAwarded === null || entry.marksAwarded === '') {
        marksAwarded = null;
      } else {
        marksAwarded = Number(entry.marksAwarded);
        if (Number.isNaN(marksAwarded)) continue;
        const maxMarks = maxMarksById.get(questionId);
        if (marksAwarded < 0 || marksAwarded > maxMarks) {
          return res.status(400).json({ error: `Marks for question ${questionId} must be between 0 and ${maxMarks}` });
        }
      }

      const remarks = entry.remarks !== undefined ? (String(entry.remarks).trim() || null) : undefined;
      if (marksAwarded === undefined && remarks === undefined) continue;
      updates.push({ questionId, marksAwarded, remarks });
    }

    for (const { questionId, marksAwarded, remarks } of updates) {
      await pool.query(
        `INSERT INTO scan_submission_answers (submission_id, question_id) VALUES ($1, $2)
         ON CONFLICT (submission_id, question_id) DO NOTHING`,
        [req.params.id, questionId]
      );
      if (marksAwarded !== undefined) {
        await pool.query(
          `UPDATE scan_submission_answers SET marks_awarded = $1 WHERE submission_id = $2 AND question_id = $3`,
          [marksAwarded, req.params.id, questionId]
        );
      }
      if (remarks !== undefined) {
        await pool.query(
          `UPDATE scan_submission_answers SET remarks = $1 WHERE submission_id = $2 AND question_id = $3`,
          [remarks, req.params.id, questionId]
        );
      }
    }

    if (overallRemarks !== undefined) {
      await pool.query('UPDATE scan_submissions SET overall_remarks = $1 WHERE id = $2', [String(overallRemarks).trim() || null, req.params.id]);
    }

    res.status(200).json({ message: 'Grade saved' });
  } catch (err) {
    console.error('Save scan grade error:', err);
    res.status(500).json({ error: 'Failed to save grade' });
  }
});

// Every open flag (both types) touching this assignment's submissions —
// backs a per-assignment review queue in ScanReview.jsx. Handwriting flags
// aren't problem-scoped in the schema (a match can span two different
// assignments), so this pulls in any flag where AT LEAST ONE side belongs
// to this assignment — a teacher reviewing this assignment's submissions
// should see that one of them matched something elsewhere too.
app.get('/api/admin/problems/:id/scan-flags', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });

    const plagiarismRes = await pool.query(
      `SELECT f.id, f.submission_a_id, f.submission_b_id, f.similarity_score, f.status, f.created_at,
              ua.email AS email_a, ub.email AS email_b
       FROM scan_plagiarism_flags f
       JOIN scan_submissions sa ON sa.id = f.submission_a_id JOIN users ua ON ua.id = sa.user_id
       JOIN scan_submissions sb ON sb.id = f.submission_b_id JOIN users ub ON ub.id = sb.user_id
       WHERE f.problem_id = $1 AND f.status = 'open'
       ORDER BY f.similarity_score DESC`,
      [req.params.id]
    );

    const handwritingRes = await pool.query(
      `SELECT f.id, f.submission_a_id, f.submission_b_id, f.similarity_score, f.status, f.created_at,
              ua.email AS email_a, ub.email AS email_b
       FROM scan_handwriting_flags f
       JOIN scan_submissions sa ON sa.id = f.submission_a_id JOIN users ua ON ua.id = sa.user_id
       JOIN scan_submissions sb ON sb.id = f.submission_b_id JOIN users ub ON ub.id = sb.user_id
       WHERE f.status = 'open' AND (sa.problem_id = $1 OR sb.problem_id = $1)
       ORDER BY f.similarity_score DESC`,
      [req.params.id]
    );

    const toFlag = (type) => (f) => ({
      id: f.id, type,
      submissionA: { id: f.submission_a_id, email: f.email_a },
      submissionB: { id: f.submission_b_id, email: f.email_b },
      similarityScore: f.similarity_score,
      createdAt: f.created_at,
    });

    res.status(200).json({
      flags: [...plagiarismRes.rows.map(toFlag('text_similarity')), ...handwritingRes.rows.map(toFlag('handwriting'))],
    });
  } catch (err) {
    console.error('List scan flags error:', err);
    res.status(500).json({ error: 'Failed to load flags' });
  }
});

// Confirm/dismiss one flag. Confirming a text_similarity or
// typed_text_similarity flag penalizes BOTH submissions in the pair (marks
// display as 0 while penalized=true, see the list/detail routes above) —
// handwriting flags never penalize anything regardless of status, confirmed
// or not (see the false-positive-risk note on ensureScanHandwritingFlagsSchema).
// requireAdminOrTeacher + enforceSubjectAuthority, not requireAdmin —
// reachable from ScanReview.jsx, a page a teacher can land on for their own
// scan-mode assignments (see that page's own ProtectedRoute entry in
// App.jsx). Both submissions being compared always belong to the same
// assignment (plagiarism/handwriting comparison is only ever within one
// assignment — see textShingles/jaccardSimilarity's own comments above),
// so either side's problem gives the same subject_id either way.
app.put('/api/admin/scan-flags/:type/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { type, id } = req.params;
  const { status } = req.body; // 'reviewed_confirmed' | 'reviewed_dismissed'
  if (!['reviewed_confirmed', 'reviewed_dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status must be reviewed_confirmed or reviewed_dismissed' });
  }
  const table = type === 'text_similarity' || type === 'typed_text_similarity' ? 'scan_plagiarism_flags' : type === 'handwriting' ? 'scan_handwriting_flags' : null;
  if (!table) return res.status(400).json({ error: 'Invalid flag type' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Org-scoped via a join through problems even for scan_handwriting_flags
    // (which has no problem_id of its own) — either side's submission's
    // problem is enough to prove org ownership of the flag.
    const flagRes = await client.query(
      `SELECT f.id, f.submission_a_id, f.submission_b_id, p.subject_id FROM ${table} f
       JOIN scan_submissions sa ON sa.id = f.submission_a_id
       JOIN problems p ON p.id = sa.problem_id
       WHERE f.id = $1 AND p.organization_id = $2`,
      [id, req.user.organizationId]
    );
    if (flagRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Flag not found' });
    }
    if (await enforceSubjectAuthority(req, res, flagRes.rows[0].subject_id)) { await client.query('ROLLBACK'); return; }
    const flag = flagRes.rows[0];

    await client.query(`UPDATE ${table} SET status = $1 WHERE id = $2`, [status, id]);

    if (table === 'scan_plagiarism_flags' && status === 'reviewed_confirmed') {
      await client.query(
        'UPDATE scan_submissions SET penalized = true WHERE id IN ($1, $2)',
        [flag.submission_a_id, flag.submission_b_id]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Flag updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update scan flag error:', err);
    res.status(500).json({ error: 'Failed to update flag' });
  } finally {
    client.release();
  }
});

// Per-org Jaccard-similarity cutoff for the text-plagiarism comparator —
// admin-only, same as every other org-wide setting (grade_bands,
// tag_visibility_settings).
app.get('/api/admin/settings/scan-plagiarism-threshold', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT scan_plagiarism_threshold FROM organizations WHERE id = $1', [req.user.organizationId]);
    res.status(200).json({ threshold: result.rows[0]?.scan_plagiarism_threshold ?? 0.4 });
  } catch (err) {
    console.error('Get plagiarism threshold error:', err);
    res.status(500).json({ error: 'Failed to load threshold' });
  }
});

app.put('/api/admin/settings/scan-plagiarism-threshold', authenticateToken, requireAdmin, async (req, res) => {
  const threshold = Number(req.body.threshold);
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    return res.status(400).json({ error: 'threshold must be a number between 0 and 1' });
  }
  try {
    await pool.query('UPDATE organizations SET scan_plagiarism_threshold = $1 WHERE id = $2', [threshold, req.user.organizationId]);
    res.status(200).json({ message: 'Threshold updated', threshold });
  } catch (err) {
    console.error('Update plagiarism threshold error:', err);
    res.status(500).json({ error: 'Failed to update threshold' });
  }
});

// Per-org Jaccard-similarity cutoff for the code-submission comparator —
// same admin-only settings pattern as the scan one above, separate column
// since code and prose similarity scores don't live on the same natural
// scale (code shares far more incidental boilerplate than prose does).
app.get('/api/admin/settings/code-plagiarism-threshold', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT code_plagiarism_threshold FROM organizations WHERE id = $1', [req.user.organizationId]);
    res.status(200).json({ threshold: result.rows[0]?.code_plagiarism_threshold ?? 0.6 });
  } catch (err) {
    console.error('Get code plagiarism threshold error:', err);
    res.status(500).json({ error: 'Failed to load threshold' });
  }
});

app.put('/api/admin/settings/code-plagiarism-threshold', authenticateToken, requireAdmin, async (req, res) => {
  const threshold = Number(req.body.threshold);
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    return res.status(400).json({ error: 'threshold must be a number between 0 and 1' });
  }
  try {
    await pool.query('UPDATE organizations SET code_plagiarism_threshold = $1 WHERE id = $2', [threshold, req.user.organizationId]);
    res.status(200).json({ message: 'Threshold updated', threshold });
  } catch (err) {
    console.error('Update code plagiarism threshold error:', err);
    res.status(500).json({ error: 'Failed to update threshold' });
  }
});

// Every open code-similarity flag for one assignment — backs a per-
// assignment review list in AssignmentsPanel, same shape as the scan-flags
// list above.
app.get('/api/admin/problems/:id/code-flags', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;

    const flagsRes = await pool.query(
      `SELECT f.id, f.submission_a_id, f.submission_b_id, f.similarity_score, f.status, f.created_at,
              ua.email AS email_a, ua.name AS name_a, ub.email AS email_b, ub.name AS name_b
       FROM submission_plagiarism_flags f
       JOIN submissions sa ON sa.id = f.submission_a_id JOIN users ua ON ua.id = sa.user_id
       JOIN submissions sb ON sb.id = f.submission_b_id JOIN users ub ON ub.id = sb.user_id
       WHERE f.problem_id = $1 AND f.status = 'open'
       ORDER BY f.similarity_score DESC`,
      [req.params.id]
    );

    res.status(200).json({
      flags: flagsRes.rows.map((f) => ({
        id: f.id,
        submissionA: { id: f.submission_a_id, name: f.name_a, email: f.email_a },
        submissionB: { id: f.submission_b_id, name: f.name_b, email: f.email_b },
        similarityScore: f.similarity_score,
        createdAt: f.created_at,
      })),
    });
  } catch (err) {
    console.error('List code flags error:', err);
    res.status(500).json({ error: 'Failed to load flags' });
  }
});

// Confirm/dismiss one code-similarity flag. Unlike the scan-plagiarism
// flow, confirming never auto-penalizes a submission's score — coding
// assignments grade purely off test-case pass/fail, and silently zeroing
// that would fight the judge's own authoritative result. Confirming is
// purely a record for the teacher (e.g. to act on outside the platform);
// dismissing just closes the flag.
app.put('/api/admin/code-flags/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { status } = req.body; // 'reviewed_confirmed' | 'reviewed_dismissed'
  if (!['reviewed_confirmed', 'reviewed_dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status must be reviewed_confirmed or reviewed_dismissed' });
  }
  try {
    const flagRes = await pool.query(
      `SELECT f.id, p.subject_id FROM submission_plagiarism_flags f
       JOIN problems p ON p.id = f.problem_id
       WHERE f.id = $1 AND p.organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (flagRes.rows.length === 0) return res.status(404).json({ error: 'Flag not found' });
    if (await enforceSubjectAuthority(req, res, flagRes.rows[0].subject_id)) return;

    await pool.query('UPDATE submission_plagiarism_flags SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.status(200).json({ message: 'Flag updated' });
  } catch (err) {
    console.error('Update code flag error:', err);
    res.status(500).json({ error: 'Failed to update flag' });
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

    const insertRes = await pool.query(
      `INSERT INTO submissions (user_id, problem_id, language, code, status, passed_count, total_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.userId, problemId, language, code, verdict, passedCount, testCases.length]
    );

    if (verdict === 'Accepted') {
      runCodePlagiarismComparator({ id: insertRes.rows[0].id, problem_id: Number(problemId), user_id: req.user.userId, code });
    }

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

// ============================================================================
// NOTES — teacher-posted subject media, six types (see ensureNotesSchema
// above for the visibility model and the full type list). Storage reuses
// the scan-PDF B2 helpers unchanged (uploadScanPdf/getScanPdfUrl/
// deleteScanPdf take an arbitrary object key + buffer + contentType and
// have no scan-specific logic in them) with notesObjectKey's own key prefix
// keeping the two features' objects apart in the bucket — only the four
// file-based types (pdf/image/video/audio) ever touch B2 at all; text and
// link notes are pure DB rows.
// ============================================================================
const NOTE_FILE_TYPES = new Set(['pdf', 'image', 'video', 'audio']);
const NOTE_TYPES = new Set(['pdf', 'image', 'video', 'audio', 'text', 'link']);
// Default extension when an uploaded file's own name has none (rare, but a
// mobile browser's camera/mic capture sometimes hands back an extension-
// less blob) — path.extname() on the original filename is tried first.
const NOTE_DEFAULT_EXT = { pdf: '.pdf', image: '.jpg', video: '.mp4', audio: '.mp3' };

// Shared by every route below that returns note rows — the four file types
// carry a presigned viewUrl (null if B2 isn't configured); text/link carry
// their payload directly (bodyText/externalUrl) and never touch B2 at all,
// so they always have a "view" regardless of whether storage is configured.
async function serializeNoteRow(row, b2Configured) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    title: row.title,
    type: row.type,
    createdAt: row.created_at,
    teacherName: row.teacher_name,
    bodyText: row.body_text,
    externalUrl: row.external_url,
    viewUrl: row.storage_key && b2Configured ? await getScanPdfUrl(row.storage_key) : null,
  };
}

// Subject dropdown shared by the teacher Uploads tab and the student Notes
// tab — same subject-visibility rules those roles already have elsewhere
// (getTeacherScope / getVisibleSubjectIds), just returned as a plain
// id+name list instead of folded into a bigger payload.
app.get('/api/notes/subjects', authenticateToken, async (req, res) => {
  try {
    let subjectIds;
    if (req.user.role === 'teacher') {
      subjectIds = (await getTeacherScope(req.user.userId, req.user.organizationId)).subjectIds;
    } else if (req.user.role === 'student') {
      subjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
    } else {
      return res.status(403).json({ error: 'Not available for this role' });
    }
    if (subjectIds.length === 0) return res.status(200).json({ subjects: [] });

    const result = await pool.query(
      `SELECT s.id, s.name, u.name AS org_unit_name FROM subjects s JOIN org_units u ON u.id = s.org_unit_id
       WHERE s.id = ANY($1::int[]) ORDER BY s.name ASC`,
      [subjectIds]
    );
    res.status(200).json({ subjects: result.rows });
  } catch (err) {
    console.error('List note subjects error:', err);
    res.status(500).json({ error: 'Failed to load subjects' });
  }
});

// A teacher's own Uploads panel — always scoped to their own uploads
// (teacher_id = caller), never a co-teacher's, since this is "my uploads,"
// not "my subject's uploads." subjectId/search are both optional filters;
// with neither, this is just everything they've ever uploaded, newest first.
app.get('/api/teacher/notes', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectId = req.query.subjectId ? Number(req.query.subjectId) : null;
  const search = String(req.query.search || '').trim();

  try {
    const params = [req.user.userId];
    let where = 'n.teacher_id = $1';
    if (subjectId) { params.push(subjectId); where += ` AND n.subject_id = $${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND n.title ILIKE $${params.length}`; }

    const result = await pool.query(
      `SELECT n.id, n.subject_id, s.name AS subject_name, n.title, n.type, n.storage_key, n.body_text, n.external_url, n.created_at
       FROM notes n JOIN subjects s ON s.id = n.subject_id
       WHERE ${where} ORDER BY n.created_at DESC`,
      params
    );
    const configured = isB2Configured();
    const notes = await Promise.all(result.rows.map((row) => serializeNoteRow(row, configured)));
    res.status(200).json({ notes });
  } catch (err) {
    console.error('List teacher notes error:', err);
    res.status(500).json({ error: 'Failed to load uploads' });
  }
});

app.post('/api/teacher/notes', authenticateToken, requireAdminOrTeacher, notesUpload.single('file'), async (req, res) => {
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  const title = String(req.body.title || '').trim();
  const type = String(req.body.type || '').trim();

  if (!subjectId) return res.status(400).json({ error: 'A subject is required' });
  if (!title) return res.status(400).json({ error: 'A title is required' });
  if (!NOTE_TYPES.has(type)) return res.status(400).json({ error: 'Invalid note type' });

  // Per-type payload validation — exactly one of {file, bodyText,
  // externalUrl} matters depending on type, matching notes_content_check's
  // own shape on the DB side.
  let bodyText = null;
  let externalUrl = null;
  if (NOTE_FILE_TYPES.has(type)) {
    if (!isB2Configured()) return res.status(503).json({ error: 'Notes storage is not configured yet' });
    if (!req.file) return res.status(400).json({ error: `A ${type} file is required` });
    const mimeOk = type === 'pdf' ? req.file.mimetype === 'application/pdf' : req.file.mimetype.startsWith(`${type}/`);
    if (!mimeOk) return res.status(400).json({ error: `That file doesn't look like a ${type}` });
  } else if (type === 'text') {
    bodyText = String(req.body.bodyText || '').trim();
    if (!bodyText) return res.status(400).json({ error: 'Note text is required' });
  } else if (type === 'link') {
    externalUrl = String(req.body.externalUrl || '').trim();
    let parsed;
    try {
      parsed = new URL(externalUrl);
    } catch {
      return res.status(400).json({ error: 'Enter a valid URL' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only http(s) links are allowed' });
    }
  }

  if (await enforceSubjectAuthority(req, res, subjectId)) return;

  try {
    // enforceSubjectAuthority already scopes a teacher's subject to their
    // own org via its own JOIN; this covers the admin bypass path, where
    // that check is a no-op — without it an admin request naming another
    // org's subject id would otherwise sail through to the insert below.
    const subject = await pool.query('SELECT id, name, org_unit_id FROM subjects WHERE id = $1 AND organization_id = $2', [subjectId, req.user.organizationId]);
    if (subject.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    // File-based types upload to B2 BEFORE the insert (notes_content_check
    // requires storage_key to already be non-empty on that first row — see
    // notesObjectKey's own comment for why there's no placeholder-row step
    // here the way scan_submissions has). Text/link never touch B2 at all.
    let storageKey = null;
    let originalFilename = null;
    if (req.file) {
      originalFilename = req.file.originalname;
      const ext = path.extname(req.file.originalname) || NOTE_DEFAULT_EXT[type] || '';
      storageKey = notesObjectKey(req.user.organizationId, subjectId, crypto.randomUUID(), ext);
      await uploadScanPdf(storageKey, req.file.buffer, req.file.mimetype);
    }

    const insertRes = await pool.query(
      `INSERT INTO notes (organization_id, subject_id, teacher_id, title, type, original_filename, storage_key, body_text, external_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
      [req.user.organizationId, subjectId, req.user.userId, title, type, originalFilename, storageKey, bodyText, externalUrl]
    );

    // Best-effort, same "continuing anyway" posture as the delete-on-B2
    // path below — a notification fan-out failing shouldn't fail the
    // upload the teacher is actively waiting on. Same descendant-units walk
    // getTeacherScope uses (a note on a Department-tier subject reaches
    // every Year beneath it, not just students in the subject's own exact
    // unit), just seeded from this one subject's org_unit_id instead of a
    // teacher's whole subject list.
    try {
      await pool.query(
        `WITH RECURSIVE descendant_units AS (
           SELECT id FROM org_units WHERE id = $1
           UNION
           SELECT ou.id FROM org_units ou JOIN descendant_units d ON ou.parent_unit_id = d.id
         )
         INSERT INTO notifications (organization_id, user_id, type, title, body, note_id)
         SELECT $2, m.user_id, 'note', $3, $4, $5
         FROM memberships m
         WHERE m.organization_id = $2 AND m.role = 'student' AND m.org_unit_id IN (SELECT id FROM descendant_units)`,
        [subject.rows[0].org_unit_id, req.user.organizationId, title, `New ${type} in ${subject.rows[0].name}`, insertRes.rows[0].id]
      );
    } catch (err) {
      console.error('Failed to notify students of new note (continuing anyway):', err);
    }

    res.status(201).json({ id: insertRes.rows[0].id, createdAt: insertRes.rows[0].created_at });
  } catch (err) {
    console.error('Upload note error:', err);
    res.status(500).json({ error: 'Failed to upload note' });
  }
});

app.delete('/api/teacher/notes/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const existing = await pool.query('SELECT storage_key FROM notes WHERE id = $1 AND teacher_id = $2', [req.params.id, req.user.userId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Note not found' });

    await pool.query('DELETE FROM notes WHERE id = $1', [req.params.id]);
    if (existing.rows[0].storage_key) {
      try {
        await deleteScanPdf(existing.rows[0].storage_key);
      } catch (err) {
        console.error('Failed to delete note PDF (continuing anyway):', err);
      }
    }
    res.status(200).json({ message: 'Note deleted' });
  } catch (err) {
    console.error('Delete note error:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// Student-facing Notes tab. subjectId picks one subject's notes
// (recent-first, per the ask); search narrows by title and — unlike
// subjectId — works across every subject visible to the student, so
// "search up a specific pdf" doesn't first require knowing which subject
// it lives under. At least one of the two is required so this can never
// turn into "dump every note in every subject I can see."
app.get('/api/notes', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Not available for this role' });

  const subjectId = req.query.subjectId ? Number(req.query.subjectId) : null;
  const search = String(req.query.search || '').trim();
  if (!subjectId && !search) return res.status(400).json({ error: 'A subject or search term is required' });

  try {
    const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
    if (subjectId && !visibleSubjectIds.includes(subjectId)) return res.status(404).json({ error: 'Subject not found' });
    if (visibleSubjectIds.length === 0) return res.status(200).json({ notes: [] });

    const scopeIds = subjectId ? [subjectId] : visibleSubjectIds;
    const params = [scopeIds];
    let where = 'n.subject_id = ANY($1::int[])';
    if (search) { params.push(`%${search}%`); where += ` AND n.title ILIKE $${params.length}`; }

    const result = await pool.query(
      `SELECT n.id, n.subject_id, s.name AS subject_name, n.title, n.type, n.storage_key, n.body_text, n.external_url, n.created_at, u.name AS teacher_name
       FROM notes n JOIN subjects s ON s.id = n.subject_id JOIN users u ON u.id = n.teacher_id
       WHERE ${where} ORDER BY n.created_at DESC`,
      params
    );
    const configured = isB2Configured();
    const notes = await Promise.all(result.rows.map((row) => serializeNoteRow(row, configured)));
    res.status(200).json({ notes });
  } catch (err) {
    console.error('List notes error:', err);
    res.status(500).json({ error: 'Failed to load notes' });
  }
});

// ============================================================================
// NOTICES — admin-posted, org-wide media (see ensureNoticesSchema above for
// the type list and visibility model). No subject, no per-poster scoping on
// the list route — unlike teacher notes' personal Uploads panel, every
// admin in the org manages the SAME shared list, and every member of the
// org (any role) reads it via the one GET route below.
// ============================================================================
const NOTICE_FILE_TYPES = new Set(['pdf', 'image']);
const NOTICE_TYPES = new Set(['pdf', 'image', 'text', 'link']);

async function serializeNoticeRow(row, b2Configured) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    createdAt: row.created_at,
    bodyText: row.body_text,
    externalUrl: row.external_url,
    viewUrl: row.storage_key && b2Configured ? await getScanPdfUrl(row.storage_key) : null,
  };
}

// Any authenticated org member reads this — students, teachers, and admins
// alike, per notices' own org-wide visibility (no subject/unit scoping to
// enforce, unlike GET /api/notes). search narrows by title, same ILIKE
// convention as every other search box in this feature.
app.get('/api/notices', authenticateToken, async (req, res) => {
  const search = String(req.query.search || '').trim();
  try {
    const params = [req.user.organizationId];
    let where = 'organization_id = $1';
    if (search) { params.push(`%${search}%`); where += ` AND title ILIKE $${params.length}`; }

    const result = await pool.query(
      `SELECT id, title, type, storage_key, body_text, external_url, created_at
       FROM notices WHERE ${where} ORDER BY created_at DESC LIMIT 100`,
      params
    );
    const configured = isB2Configured();
    const notices = await Promise.all(result.rows.map((row) => serializeNoticeRow(row, configured)));
    res.status(200).json({ notices });
  } catch (err) {
    console.error('List notices error:', err);
    res.status(500).json({ error: 'Failed to load notices' });
  }
});

app.post('/api/admin/notices', authenticateToken, requireAdmin, notesUpload.single('file'), async (req, res) => {
  const title = String(req.body.title || '').trim();
  const type = String(req.body.type || '').trim();
  if (!title) return res.status(400).json({ error: 'A title is required' });
  if (!NOTICE_TYPES.has(type)) return res.status(400).json({ error: 'Invalid notice type' });

  let bodyText = null;
  let externalUrl = null;
  if (NOTICE_FILE_TYPES.has(type)) {
    if (!isB2Configured()) return res.status(503).json({ error: 'Notice storage is not configured yet' });
    if (!req.file) return res.status(400).json({ error: `A ${type} file is required` });
    const mimeOk = type === 'pdf' ? req.file.mimetype === 'application/pdf' : req.file.mimetype.startsWith('image/');
    if (!mimeOk) return res.status(400).json({ error: `That file doesn't look like a ${type}` });
  } else if (type === 'text') {
    bodyText = String(req.body.bodyText || '').trim();
    if (!bodyText) return res.status(400).json({ error: 'Notice text is required' });
  } else if (type === 'link') {
    externalUrl = String(req.body.externalUrl || '').trim();
    let parsed;
    try {
      parsed = new URL(externalUrl);
    } catch {
      return res.status(400).json({ error: 'Enter a valid URL' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only http(s) links are allowed' });
    }
  }

  try {
    let storageKey = null;
    let originalFilename = null;
    if (req.file) {
      originalFilename = req.file.originalname;
      const ext = path.extname(req.file.originalname) || NOTE_DEFAULT_EXT[type] || '';
      storageKey = noticesObjectKey(req.user.organizationId, crypto.randomUUID(), ext);
      await uploadScanPdf(storageKey, req.file.buffer, req.file.mimetype);
    }

    const insertRes = await pool.query(
      `INSERT INTO notices (organization_id, admin_id, title, type, original_filename, storage_key, body_text, external_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
      [req.user.organizationId, req.user.userId, title, type, originalFilename, storageKey, bodyText, externalUrl]
    );

    // Best-effort, same posture as POST /api/teacher/notes' own fan-out —
    // every student AND teacher in the org (not admins; the poster's fellow
    // admins already see it directly in their own shared notices list, same
    // as the poster does, with no separate bell needed for that).
    try {
      await pool.query(
        `INSERT INTO notifications (organization_id, user_id, type, title, body, notice_id)
         SELECT $1, m.user_id, 'notice', $2, 'New notice posted', $3
         FROM memberships m WHERE m.organization_id = $1 AND m.role IN ('student', 'teacher')`,
        [req.user.organizationId, title, insertRes.rows[0].id]
      );
    } catch (err) {
      console.error('Failed to notify org of new notice (continuing anyway):', err);
    }

    res.status(201).json({ id: insertRes.rows[0].id, createdAt: insertRes.rows[0].created_at });
  } catch (err) {
    console.error('Post notice error:', err);
    res.status(500).json({ error: 'Failed to post notice' });
  }
});

// Not scoped to admin_id — any admin in the org can remove any notice, same
// "one shared list, jointly managed" posture GET /api/notices already has.
app.delete('/api/admin/notices/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const existing = await pool.query('SELECT storage_key FROM notices WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Notice not found' });

    await pool.query('DELETE FROM notices WHERE id = $1', [req.params.id]);
    if (existing.rows[0].storage_key) {
      try {
        await deleteScanPdf(existing.rows[0].storage_key);
      } catch (err) {
        console.error('Failed to delete notice file (continuing anyway):', err);
      }
    }
    res.status(200).json({ message: 'Notice deleted' });
  } catch (err) {
    console.error('Delete notice error:', err);
    res.status(500).json({ error: 'Failed to delete notice' });
  }
});

// Notification feed — two producers now (see ensureNotificationsSchema's
// own comment), so this is student-or-teacher rather than student-only:
// a teacher's note-upload notifications were always student-only, but
// notices fan out to teachers too. Capped at the 50 most recent so a
// long-inactive user's first load isn't unbounded.
app.get('/api/notifications', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student' && req.user.role !== 'teacher') return res.status(403).json({ error: 'Not available for this role' });
  try {
    const result = await pool.query(
      `SELECT id, type, title, body, note_id, notice_id, problem_id, exam_id, read_at, created_at FROM notifications
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.userId]
    );
    const notifications = result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      noteId: row.note_id,
      noticeId: row.notice_id,
      problemId: row.problem_id,
      examId: row.exam_id,
      read: row.read_at !== null,
      createdAt: row.created_at,
    }));
    res.status(200).json({ notifications });
  } catch (err) {
    console.error('List notifications error:', err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// Marks every one of the caller's currently-unread notifications as read in
// one shot — called when the notification dropdown is opened, rather than
// tracking each notification's read state individually from the frontend.
app.post('/api/notifications/mark-read', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student' && req.user.role !== 'teacher') return res.status(403).json({ error: 'Not available for this role' });
  try {
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.userId]);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Mark notifications read error:', err);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

// Backstop, not the primary error-handling path — every route above already
// wraps its own body in try/catch and answers its own res.status(500), so
// this exists for whatever slips past that: a synchronous throw in
// middleware, or (Express 5 specifically, unlike 4) an async route handler
// whose rejection was never caught locally, which Express 5 now forwards
// here automatically instead of silently hanging the request. Must be
// registered after every app.use/app.get/etc above — Express identifies
// error-handling middleware purely by arity (4 params), so this has to
// come last or later routes would shadow it. Never echoes err.message back
// to the client: an internal error string can carry query fragments or
// stack detail that's an information leak to hand an unauthenticated
// caller, so the response is always the same generic message regardless of
// what actually broke.
app.use((err, req, res, next) => {
  console.error('Unhandled error in request pipeline:', err);
  if (res.headersSent) return next(err);
  const isConnectivity = /ECONNREFUSED|ETIMEDOUT|Connection terminated|too many clients|connect ECONNRESET/i.test(err?.message || '');
  res.status(isConnectivity ? 503 : 500).json({
    error: isConnectivity ? 'Service is temporarily unavailable — please retry in a moment.' : 'Internal server error',
  });
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

// ============================================================================
// PERFORMANCE INDEXES — Postgres does NOT automatically index foreign-key
// columns (only primary keys get that for free), so every WHERE/JOIN on an
// FK column — which in a multi-tenant app means almost every query, since
// nearly everything filters by organization_id, problem_id, exam_id, or
// user_id — falls back to a sequential scan without one. Fine at today's
// data volume; a real bottleneck once any of these tables grow past a few
// thousand rows. Consolidated here (one pass, run once at boot) rather
// than folded into each table's own ensureXSchema function, since these
// are a deliberate performance pass over the whole schema, not part of any
// single feature's own migration — CREATE INDEX CONCURRENTLY isn't used
// because it can't run inside the implicit transaction each pool.query
// already is; on a table with real production data, run these by hand
// with CONCURRENTLY first instead of relying on this function to do it
// under load. Each statement is independent and individually caught, same
// posture as every other ensureXSchema function, so one racing against a
// table that isn't created yet on a cold first boot doesn't block the
// rest — CREATE INDEX IF NOT EXISTS just re-attempts and succeeds on the
// next restart.
async function ensurePerformanceIndexes() {
  const statements = [
    // organization_id — the single most common WHERE clause in this
    // codebase; every one of these tables is queried scoped to one org on
    // nearly every request.
    'CREATE INDEX IF NOT EXISTS problems_organization_id_idx ON problems(organization_id)',
    'CREATE INDEX IF NOT EXISTS exams_organization_id_idx ON exams(organization_id)',
    'CREATE INDEX IF NOT EXISTS subjects_organization_id_idx ON subjects(organization_id)',
    'CREATE INDEX IF NOT EXISTS org_units_organization_id_idx ON org_units(organization_id)',
    'CREATE INDEX IF NOT EXISTS grade_bands_organization_id_idx ON grade_bands(organization_id)',
    'CREATE INDEX IF NOT EXISTS profile_change_requests_organization_id_idx ON profile_change_requests(organization_id)',
    // Submission/attempt/grading tables — joined or filtered by
    // problem_id/exam_id/user_id on every performance rollup, every
    // gradebook view, every "did this student already submit" check.
    'CREATE INDEX IF NOT EXISTS submissions_problem_id_idx ON submissions(problem_id)',
    'CREATE INDEX IF NOT EXISTS submissions_user_id_idx ON submissions(user_id)',
    'CREATE INDEX IF NOT EXISTS exam_attempts_user_id_idx ON exam_attempts(user_id)',
    'CREATE INDEX IF NOT EXISTS exam_items_exam_id_idx ON exam_items(exam_id)',
    'CREATE INDEX IF NOT EXISTS exam_answers_item_id_idx ON exam_answers(item_id)',
    'CREATE INDEX IF NOT EXISTS test_cases_problem_id_idx ON test_cases(problem_id)',
    'CREATE INDEX IF NOT EXISTS starter_code_problem_id_idx ON starter_code(problem_id)',
    'CREATE INDEX IF NOT EXISTS problem_time_logs_problem_id_idx ON problem_time_logs(problem_id)',
    'CREATE INDEX IF NOT EXISTS subject_teachers_user_id_idx ON subject_teachers(user_id)',
    // Org-structure resolution — resolveOrgUnitPath and every roster/CSV
    // view walks unit -> level and unit -> parent constantly.
    'CREATE INDEX IF NOT EXISTS org_units_level_def_id_idx ON org_units(level_def_id)',
    'CREATE INDEX IF NOT EXISTS memberships_org_unit_id_idx ON memberships(org_unit_id)',
  ];
  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error(`Failed to create performance index (${sql}):`, err.message);
    }
  }
}
bootSchemaStep(ensurePerformanceIndexes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HonorRoll API running on http://localhost:${PORT}`);
});
