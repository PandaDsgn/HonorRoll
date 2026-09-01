require('dotenv').config();
const dns = require('dns');
// Render's network doesn't support outbound IPv6, but Node 18+ resolves
// hostnames with both A/AAAA records (like smtp.gmail.com) IPv6-first by
// default — that mismatch is what caused ENETUNREACH connecting to Gmail.
// Forcing IPv4-first here fixes it without touching the nodemailer config.
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const { pool, bootSchemaStep } = require('./lib/db');
// Triggers every ensureXSchema()'s own bootSchemaStep call as a require()
// side effect — deliberately required here, at a known point, rather than
// relying on it being incidentally triggered by whichever route file
// happens to require('../schema') first. Nothing in this file calls any
// individual schema function directly anymore (every route that needs one
// imports it from './schema' itself), so only the module reference is
// needed, not a destructured import.
require('./schema');

const app = express();
// Without this, req.ip (what rateLimiter.js keys every limit on, and what
// lib/geoip.js's login-map geolocation resolves) is always the DIRECT TCP
// peer — which, once this sits behind ANY reverse proxy, is the proxy's
// own address on every single request, for every user. That collapses
// every visitor into one shared rate-limit bucket (one busy legitimate
// user can lock everyone else out, and an attacker gets the SAME
// 10-attempts-per-15-min budget as the entire rest of the platform
// combined instead of their own) and makes every login's geolocation
// resolve to wherever the proxy happens to run, not the actual visitor.
//
// A fixed hop count (e.g. `1`, matching the docker-compose nginx setup's
// single-proxy topology) breaks the moment the real topology has a
// DIFFERENT number of hops — which is exactly what happened on Render:
// its own edge/internal routing adds more than one hop, so `trust proxy:
// 1` was reading an address still one hop short of the real client — a
// private Render-internal address (10.x.x.x), not the visitor's public
// IP. `'loopback, linklocal, uniquelocal'` fixes this for ANY number of
// private-network hops in front of the app: it walks the X-Forwarded-For
// chain from the app backwards, trusting each entry only while it's a
// loopback/link-local/RFC1918-private address (which every hop of Render's
// own infrastructure genuinely is), and stops — using that address as
// req.ip — at the first entry that ISN'T, which is the real public client.
// A spoofed X-Forwarded-For from an actual attacker can't forge its way
// into this trust boundary either: their own IP is never in a private
// range, so it can never masquerade as one of the trusted internal hops.
// Harmless with no proxy in front too (e.g. hitting this directly on
// localhost in dev) — nothing there is a private-range hop to trust past,
// so req.ip just falls back to the direct connection either way.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
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
// Besides the two fixed origins, also allow the Vite dev server when it's
// reached from another device on the same private network (e.g. a phone
// testing mobile layout against a laptop's `npm run dev -- --host`) — an
// origin header can only ever reflect where the requesting page is actually
// served from, so a private-network address here can't be spoofed by an
// unrelated public site, it just widens local dev testing without loosening
// anything for the real deployed origins.
const LAN_DEV_ORIGIN_RE = /^http:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}):5173$/;
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === 'http://localhost:5173' || origin === 'https://pandadsgn.github.io' || LAN_DEV_ORIGIN_RE.test(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

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
app.use('/api/login', authLimiter);
app.use('/api/organizations/signup', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/reset-password', authLimiter);
app.use('/api/contact', authLimiter);
app.use(globalLimiter);
connectRedisAndUpgradeStores();

// Every route lives in its own module under routes/ — each mounted with no
// path prefix (app.use(router), not app.use('/some/prefix', router)) since
// every route inside already defines its own exact full path.
app.use(require('./routes/playground'));
app.use(require('./routes/assistant'));
app.use(require('./routes/notes'));
app.use(require('./routes/notices'));
app.use(require('./routes/notifications'));
app.use(require('./routes/auth'));
app.use(require('./routes/organizations'));
app.use(require('./routes/me'));
app.use(require('./routes/billing'));
app.use(require('./routes/superadmin'));
app.use(require('./routes/problems'));
app.use(require('./routes/exams'));
app.use(require('./routes/scans'));
app.use(require('./routes/admin'));

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
// Without this, ANY single uncaught error anywhere — not just in the sandbox
// — kills the entire Node process and takes every student's session down
// with it, possibly mid-deadline. Logging and staying alive is far safer
// than the default "crash the whole server" behavior for this kind of app.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stayed alive):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server stayed alive):', err);
});

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
// require.main === module is only true when this file is run directly
// (`node index.js`) — a test file `require()`ing this module to get `app`
// for supertest must NOT also bind a real port, both because it'd collide
// with an already-running dev server on the same PORT and because Jest
// would hang afterward waiting for that open listener to close.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`HonorRoll API running on http://localhost:${PORT}`);
  });
}

module.exports = app;
