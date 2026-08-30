// The in-app SIEM's write path — a single append-only log of security-
// relevant events (auth, access-control denials, and admin/superadmin
// actions on accounts/roles/grades), read back by GET /api/superadmin/
// security-events (see routes/superadmin.js) and rendered in
// SuperadminDashboard's SecurityEventsPanel. See ensureSecurityEventsSchema
// in schema/index.js for the table itself.
//
// Deliberately fire-and-forget: logSecurityEvent never throws and its
// caller never awaits a rejection propagating out. An audit-log write is a
// side effect of the real action (a login, a delete, a grade change) —
// failing to record it (e.g. a fresh deploy where the boot-time schema
// migration hasn't finished yet) must never turn into a 500 on that real
// action, and a caller that forgets to `await` this must not produce an
// unhandled promise rejection either.
const { pool } = require('./db');
const { ensureSecurityEventsSchema, ensureLoginLocationsSchema } = require('../schema');

// req is optional (a couple of call sites — e.g. a scheduled sweep — have
// no request in flight) and, even when present, may have no req.user yet
// (a login attempt is itself the event, before authenticateToken ever
// runs). Every actor/org field below can therefore be given explicitly via
// opts, falling back to req.user only when the caller didn't say — `!==
// undefined` (not `??`) so an explicit `null` (e.g. "this login attempt
// matched no real user") is respected instead of falling back to req.user.
function logSecurityEvent(req, eventType, opts = {}) {
  const actorUserId = opts.actorUserId !== undefined ? opts.actorUserId : (req?.user?.userId ?? null);
  const actorRole = opts.actorRole !== undefined ? opts.actorRole : (req?.user?.role ?? null);
  const organizationId = opts.organizationId !== undefined ? opts.organizationId : (req?.user?.organizationId ?? null);
  const actorEmail = opts.actorEmail ?? null;
  const detail = opts.detail ?? null;
  // req.ip resolves through Express's own `trust proxy` setting (see
  // index.js) — the real client IP behind nginx, not nginx's own address.
  const ipAddress = req?.ip || req?.socket?.remoteAddress || null;
  const userAgent = req?.headers?.['user-agent'] || null;

  return pool.query(
    `INSERT INTO security_events
       (event_type, actor_user_id, actor_email, actor_role, organization_id, ip_address, user_agent, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [eventType, actorUserId, actorEmail, actorRole, organizationId, ipAddress, userAgent, detail ? JSON.stringify(detail) : null]
  ).catch((err) => console.error(`Failed to record security event "${eventType}":`, err));
}

// Number of bad-password login_failed events for the same account, within
// LOGIN_FAILURE_WINDOW_MINUTES, that trips the temporary account lockout
// in POST /api/login. Exported so that route and this sweep never drift on
// what "brute-forced" means.
const LOGIN_FAILURE_THRESHOLD = 5;
const LOGIN_FAILURE_WINDOW_MINUTES = 15;

// Counts only reason:'bad_password' failures for this exact email — a
// login_failed row can also mean "no such account", "wrong role tab
// selected", or "not a member of any organization" (see POST /api/login),
// none of which represent someone actually guessing at a real password, so
// none of those should ever count toward locking a real account out.
async function countRecentBadPasswordFailures(email) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM security_events
     WHERE event_type = 'login_failed' AND actor_email = $1 AND detail->>'reason' = 'bad_password'
       AND created_at > now() - ($2 || ' minutes')::interval`,
    [email, LOGIN_FAILURE_WINDOW_MINUTES]
  );
  return result.rows[0].count;
}

// ============================================================================
// RETENTION — the audit trail this table exists for is only as good as
// admins/superadmins actually looking at it; left completely unbounded, it
// grows forever for no benefit past the point anyone would realistically
// investigate an old incident. A daily sweep, same setInterval-after-the-
// table-exists shape as sweepScanSubmissions/sweepAssignmentExamNotifications
// in routes/scans.js — deliberately NOT an archival copy: SECURITY_EVENT_
// RETENTION_DAYS is the actual retention policy, and once a row ages past
// it, it's really gone, not moved somewhere colder.
// ============================================================================
const SECURITY_EVENT_RETENTION_DAYS = 90;
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function sweepOldSecurityEvents() {
  try {
    await pool.query(
      `DELETE FROM security_events WHERE created_at < now() - ($1 || ' days')::interval`,
      [SECURITY_EVENT_RETENTION_DAYS]
    );
  } catch (err) {
    console.error('Security event retention sweep error:', err);
  }
}

// Same retention window and cadence as security_events above — login_
// locations backs the superadmin login-map globe's "recent activity"
// view, not a permanent per-person location history, so it's pruned
// alongside it rather than growing forever.
async function sweepOldLoginLocations() {
  try {
    await pool.query(
      `DELETE FROM login_locations WHERE created_at < now() - ($1 || ' days')::interval`,
      [SECURITY_EVENT_RETENTION_DAYS]
    );
  } catch (err) {
    console.error('Login location retention sweep error:', err);
  }
}

Promise.all([ensureSecurityEventsSchema(), ensureLoginLocationsSchema()]).then(() => {
  setInterval(sweepOldSecurityEvents, RETENTION_SWEEP_INTERVAL_MS);
  setInterval(sweepOldLoginLocations, RETENTION_SWEEP_INTERVAL_MS);
  sweepOldSecurityEvents();
  sweepOldLoginLocations();
});

module.exports = {
  logSecurityEvent,
  countRecentBadPasswordFailures,
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_FAILURE_WINDOW_MINUTES,
};
