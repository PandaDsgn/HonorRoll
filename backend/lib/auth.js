// Auth middleware + session-token minting — split out of index.js as part
// of breaking that monolith into modules. Pure relocation: nothing about
// any function's behavior changed, only where it lives.
const jwt = require('jsonwebtoken');
const { pool } = require('./db');
const { logSecurityEvent } = require('./securityEvents');

/**
 * Verifies the JWT cookie set at login and attaches { userId, role } to req.user.
 * Every route that touches the Docker sandbox or student data should sit behind this —
 * previously nothing did, which meant /api/execute/* was callable by anyone, logged in or not.
 */
function authenticateToken(req, res, next) {
  // Authorization header, not a cookie — deliberately. Frontend (github.io)
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
    logSecurityEvent(req, 'access_denied', { detail: { requiredRole: 'admin', path: req.originalUrl, method: req.method } });
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
    logSecurityEvent(req, 'access_denied', { detail: { requiredRole: 'admin_or_teacher', path: req.originalUrl, method: req.method } });
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
    logSecurityEvent(req, 'access_denied', { detail: { requiredRole: 'superadmin', path: req.originalUrl, method: req.method } });
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

module.exports = {
  authenticateToken,
  applySuperadminOrgOverride,
  requireAdmin,
  requireAdminOrTeacher,
  getSuperadminEmails,
  requireSuperadmin,
  enforceSubjectAuthority,
  requirePlatformSecret,
  DENYLISTED_EMAIL_DOMAINS,
  mintSessionToken,
  mintTosPendingToken,
};
