// Login/session lifecycle routes — split out of index.js as part of
// breaking that monolith into modules. Pure relocation: nothing about
// any route's behavior changed, only where it lives. Mounted with no
// prefix in index.js — every path below is the exact full path it
// always was.
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const {
  authenticateToken, mintSessionToken, mintTosPendingToken, getSuperadminEmails,
} = require('../lib/auth');
const {
  logSecurityEvent, countRecentBadPasswordFailures, LOGIN_FAILURE_THRESHOLD, LOGIN_FAILURE_WINDOW_MINUTES,
} = require('../lib/securityEvents');
const { recordLoginLocation } = require('../lib/geoip');
const { sendEmail } = require('../mailer');

// Best-effort — a failed alert email must never turn an otherwise-correct
// lockout into a 500, same posture as sendStudentWelcomeEmail (lib/misc.js).
// Deliberately doesn't name which organization/role this account belongs
// to: at the point this fires, the request has only proven someone knows
// this email exists and is guessing its password, not who they actually
// are, so the email sticks to what's true regardless — this account, this
// many failed attempts, this window.
async function sendLockoutAlertEmail(email, name) {
  const { error } = await sendEmail({
    to: email,
    subject: 'HonorRoll: repeated failed login attempts on your account',
    text: `Hello ${name || 'there'},\n\nWe noticed ${LOGIN_FAILURE_THRESHOLD} failed login attempts on your HonorRoll account within the last ${LOGIN_FAILURE_WINDOW_MINUTES} minutes, so we've temporarily locked it as a precaution.\n\nIf this was you, just wait ${LOGIN_FAILURE_WINDOW_MINUTES} minutes and try again with the correct password, or use "Forgot password" to reset it.\n\nIf this wasn't you, someone may be trying to guess your password — we'd recommend resetting it once the lock clears.\n\n— HonorRoll`,
  });
  if (error) console.error(`Lockout alert email failed to send to ${email}:`, error);
}

// Shared 6-digit-code machinery behind BOTH step-up flows below: lockout
// recovery (isLocked branch) and new-device verification (isDeviceTrusted
// branch). Numeric and short-lived on purpose: it's read off an email and
// typed back in by a human, not a long token pasted from a link. Only the
// HASH ever leaves hashOtp — embedded in the pending-step's own JWT
// (lockoutOtpToken / deviceOtpToken) and compared against on verify, same
// "never store/carry the raw secret" posture as reset_token/token_expiry's
// own hashing in POST /api/forgot-password.
const OTP_EXPIRY = '10m';
function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

async function sendLockoutOtpEmail(email, name, otp) {
  const { error } = await sendEmail({
    to: email,
    subject: 'HonorRoll: verification code to unlock your account',
    text: `Hello ${name || 'there'},\n\nYour HonorRoll account is temporarily locked after repeated failed login attempts, but you just entered the correct password — enter this code to lift the lock and finish signing in:\n\n${otp}\n\nThis code expires in ${OTP_EXPIRY.replace('m', ' minutes')}. If you didn't just try to log in, ignore this email; the lock will clear on its own once the cooldown passes.\n\n— HonorRoll`,
  });
  if (error) console.error(`Lockout OTP email failed to send to ${email}:`, error);
}

// Sent the first time a login succeeds from a browser/device this account
// has never completed verification on before (see isDeviceTrusted below).
// userAgent is informational only — it's shown so a real recipient has
// enough context to recognize ("oh, that's my new laptop") or get
// suspicious ("I don't own an Android phone"), never used as any part of
// the actual trust decision itself.
async function sendDeviceVerificationEmail(email, name, otp, userAgent) {
  const { error } = await sendEmail({
    to: email,
    subject: 'HonorRoll: verify this new device',
    text: `Hello ${name || 'there'},\n\nSomeone just signed in to your HonorRoll account from a device/browser we haven't seen before${userAgent ? ` (${userAgent})` : ''}. If this was you, enter this code to continue:\n\n${otp}\n\nThis code expires in ${OTP_EXPIRY.replace('m', ' minutes')}. If this wasn't you, don't enter it — and consider resetting your password.\n\n— HonorRoll`,
  });
  if (error) console.error(`Device verification email failed to send to ${email}:`, error);
}

// Resend cooldown, shared by both OTP flows' own resend routes: the very
// first resend (the 2nd time a code has been sent overall, counting the
// automatic one) is instant — covers "the email is just slow to arrive."
// From the 2nd resend onward, this many seconds have to pass since the
// last send, so a runaway click (or a script) can't be used to flood
// Gmail send calls or the inbox. sendCount/lastSentAt travel inside each
// flow's own JWT, same "the token carries the pending-step's own state"
// shape as otpHash — no separate DB bookkeeping needed for this either.
const RESEND_COOLDOWN_SECONDS = 60;

// Same env-var read used elsewhere in index.js for the same purpose
// (every email that needs to link back into the app) — trivial enough
// to re-derive here rather than add a cross-module dependency for one
// constant.
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';


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

// Resolves memberships/audience/tos-pending/session-minting for a user
// whose password (and, if applicable, lockout and new-device checks) has
// ALREADY been verified — extracted so both the direct path in
// POST /api/login below and the post-OTP path in POST /api/login/
// verify-device-otp can reach the exact same "now actually log them in"
// logic without duplicating it. Every branch here still does its own
// res.status(...).json(...) (unchanged from when this lived inline), so
// callers just `return completeLoginForUser(...)`.
async function completeLoginForUser(req, res, user, email, audience) {
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
      logSecurityEvent(req, 'login_success', { actorUserId: user.id, actorEmail: email, actorRole: 'superadmin', organizationId: null });
      recordLoginLocation(user.id, null, 'superadmin', req.ip);
      return res.status(200).json({
        message: 'Login successful',
        token,
        user: { id: user.id, email, role: 'superadmin', name: user.name },
      });
    }
    if (audience && audience !== 'superadmin' && getSuperadminEmails().includes(email.toLowerCase())) {
      logSecurityEvent(req, 'login_failed', { actorUserId: user.id, actorEmail: email, detail: { reason: 'role_mismatch', audience } });
      return res.status(401).json({ error: 'Invalid email, password, or account type selected' });
    }
    logSecurityEvent(req, 'login_failed', { actorUserId: user.id, actorEmail: email, detail: { reason: 'no_membership' } });
    return res.status(403).json({ error: 'No organization membership found. Contact your administrator.' });
  }

  // A terminated org (superadmin blacklist, see POST /api/superadmin/
  // organizations/:id/terminate) is excluded here entirely — nobody logs
  // into one until it's reinstated. Filtered per-membership, not per-user:
  // the same person can still log into any OTHER, non-terminated org they
  // belong to.
  let usableMemberships = memberships.rows.filter((m) => m.organization_status !== 'terminated');
  if (usableMemberships.length === 0) {
    logSecurityEvent(req, 'login_blocked', {
      actorUserId: user.id, actorEmail: email,
      organizationId: memberships.rows[0]?.organization_id ?? null,
      detail: { reason: 'organization_terminated' },
    });
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
      logSecurityEvent(req, 'login_failed', { actorUserId: user.id, actorEmail: email, detail: { reason: 'role_mismatch', audience } });
      return res.status(401).json({ error: 'Invalid email, password, or account type selected' });
    }
    usableMemberships = roleMatched;
  }

  if (usableMemberships.length === 1) {
    const m = usableMemberships[0];
    // Credential check (and role/org-suspension gating above) already
    // succeeded by this point regardless of which branch below fires —
    // logged once here rather than in both, so a tos-pending completion
    // is never double-counted as two separate logins.
    logSecurityEvent(req, 'login_success', { actorUserId: user.id, actorEmail: email, actorRole: m.role, organizationId: m.organization_id });
    recordLoginLocation(user.id, m.organization_id, m.role, req.ip);
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
    // Returned in the body, not set as a cookie — see authenticateToken for
    // why. The frontend stores this and attaches it as an Authorization
    // header on every request from here on.
    return res.status(200).json({
      message: 'Login successful',
      token,
      user: { id: user.id, email, role: m.role, name: user.name, organization_name: m.organization_name },
    });
  }

  // More than one organization — don't hand out a usable session token
  // yet. This pre-auth token only ever proves "this email's password was
  // already verified a moment ago"; it carries no role/org, and
  // authenticateToken explicitly refuses to accept it on any real route.
  const preAuthToken = jwt.sign({ type: 'preauth', userId: user.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  return res.status(200).json({
    requiresOrgSelection: true,
    preAuthToken,
    organizations: usableMemberships.map((m) => ({
      organizationId: m.organization_id,
      organizationName: m.organization_name,
      role: m.role,
    })),
  });
}

// Checks + slides forward a device's trust window in one round trip: a
// device with a valid (not-yet-expired) trusted_devices row gets its
// trusted_until pushed another 30 days out from THIS use (see that
// table's own comment in schema/index.js for why this is a sliding, not
// fixed, window), and the check passes. No matching row (never verified
// on this device before, or a past trust that's since aged out) fails the
// check — the caller then steps up to an emailed OTP instead. A request
// with no deviceId at all (an older client, or a direct API caller) is
// treated as trusted rather than perpetually blocked — see the call site.
async function isDeviceTrusted(userId, deviceId) {
  const result = await pool.query(
    `UPDATE trusted_devices SET trusted_until = now() + interval '30 days', last_used_at = now()
     WHERE user_id = $1 AND device_id = $2 AND trusted_until > now()
     RETURNING id`,
    [userId, deviceId]
  );
  return result.rows.length > 0;
}

router.post('/api/login', async (req, res) => {
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
    const userResult = await pool.query('SELECT id, password_hash, name, tos_accepted_at, failed_login_lockout_until FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      logSecurityEvent(req, 'login_failed', { actorEmail: email, detail: { reason: 'no_such_account' } });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = userResult.rows[0];

    // `> now()` (not a separate is-locked flag) means an expired lock is
    // simply ignored here, no sweep needed to "unlock" anything — see the
    // column's own comment in schema/index.js. Checked before branching on
    // the password so both lockout branches below can reuse the same
    // single bcrypt.compare call instead of running it twice.
    const isLocked = Boolean(user.failed_login_lockout_until) && new Date(user.failed_login_lockout_until) > new Date();
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (isLocked) {
      if (!isMatch) {
        // Still rejects every wrong-password attempt outright, same as
        // before this existed — only a CORRECT password during an active
        // lockout gets the OTP step-up below, never a guess.
        const minutesLeft = Math.ceil((new Date(user.failed_login_lockout_until) - new Date()) / 60000);
        logSecurityEvent(req, 'login_blocked', { actorUserId: user.id, actorEmail: email, detail: { reason: 'account_locked' } });
        return res.status(423).json({ error: `Too many failed login attempts — try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.` });
      }

      // Correct password, but the account is still mid-lockout — instead
      // of granting a session outright (which would make the lockout
      // pointless the moment an attacker also gets the password right) or
      // just blocking it (which would strand the real owner for the full
      // cooldown even once they've proven they know the password), step up
      // to an emailed OTP: only POST /api/login/verify-lockout-otp below
      // can actually clear the lock from here, and only whoever controls
      // this account's inbox can complete that.
      const otp = generateOtp();
      const lockoutOtpToken = jwt.sign(
        { type: 'lockout-otp', userId: user.id, otpHash: hashOtp(otp), sendCount: 1, lastSentAt: Date.now() },
        process.env.JWT_SECRET,
        { expiresIn: OTP_EXPIRY }
      );
      await sendLockoutOtpEmail(email, user.name, otp);
      logSecurityEvent(req, 'lockout_otp_sent', { actorUserId: user.id, actorEmail: email, detail: { sendCount: 1 } });
      return res.status(200).json({ requiresLockoutOtp: true, lockoutOtpToken });
    }

    if (!isMatch) {
      // Awaited (unlike every other logSecurityEvent call in this file) —
      // the threshold count right below has to see THIS failure already
      // committed, or a fire-and-forget insert racing that very query
      // would undercount by one and let the lockout trigger a request
      // late (or, under different timing, not durably at exactly the
      // Nth attempt every time).
      await logSecurityEvent(req, 'login_failed', { actorUserId: user.id, actorEmail: email, detail: { reason: 'bad_password' } });

      // Only fires on the attempt that actually CROSSES the threshold —
      // once locked, every further attempt is rejected above before ever
      // reaching bcrypt.compare, so this count can never climb past it and
      // re-trigger a second alert email/lock-renewal mid-lockout.
      const recentFailures = await countRecentBadPasswordFailures(email);
      if (recentFailures === LOGIN_FAILURE_THRESHOLD) {
        await pool.query(
          `UPDATE users SET failed_login_lockout_until = now() + ($1 || ' minutes')::interval WHERE id = $2`,
          [LOGIN_FAILURE_WINDOW_MINUTES, user.id]
        );
        logSecurityEvent(req, 'account_locked', {
          actorUserId: user.id, actorEmail: email,
          detail: { threshold: LOGIN_FAILURE_THRESHOLD, windowMinutes: LOGIN_FAILURE_WINDOW_MINUTES },
        });
        sendLockoutAlertEmail(email, user.name);
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // New-device step-up — checked once password+lockout have both
    // cleared, before any membership/role resolution (device trust is
    // per-account, not per-org, so it only needs checking once here, not
    // again inside completeLoginForUser or POST /api/login/select-
    // organization). deviceId is generated once by the frontend and
    // persisted in localStorage (see frontend/src/lib/deviceId.js) — a
    // request with none at all (an older client, or a direct API caller)
    // is treated as trusted rather than being permanently unable to pass
    // a check it has no way to satisfy.
    const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
    if (deviceId && !(await isDeviceTrusted(user.id, deviceId))) {
      const otp = generateOtp();
      const deviceOtpToken = jwt.sign(
        { type: 'device-otp', userId: user.id, deviceId, audience, otpHash: hashOtp(otp), sendCount: 1, lastSentAt: Date.now() },
        process.env.JWT_SECRET,
        { expiresIn: OTP_EXPIRY }
      );
      await sendDeviceVerificationEmail(email, user.name, otp, req.headers['user-agent']);
      logSecurityEvent(req, 'new_device_detected', { actorUserId: user.id, actorEmail: email });
      return res.status(200).json({ requiresDeviceVerification: true, deviceOtpToken });
    }

    return completeLoginForUser(req, res, user, email, audience);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Completes the OTP step-up above: verifies the emailed code against the
// hash embedded in lockoutOtpToken (never stored server-side — same
// "the token itself carries the pending-step state" shape as
// tosPendingToken) and, if it matches, lifts the lockout. Deliberately
// does NOT also mint a session token here — this route's only job is
// clearing the lock; the frontend re-submits the original POST /api/login
// once this succeeds, which now proceeds normally since isLocked is
// false. Keeps this route from having to re-derive/duplicate the
// audience-filtering, tos-pending, and multi-org-selection branches
// POST /api/login above already owns.
router.post('/api/login/verify-lockout-otp', async (req, res) => {
  const { lockoutOtpToken, otp } = req.body;
  if (!lockoutOtpToken || !otp) {
    return res.status(400).json({ error: 'lockoutOtpToken and otp are required' });
  }

  let payload;
  try {
    payload = jwt.verify(lockoutOtpToken, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Verification code expired — please log in again to request a new one' });
  }
  if (payload.type !== 'lockout-otp') {
    return res.status(401).json({ error: 'Invalid verification session' });
  }

  if (hashOtp(String(otp).trim()) !== payload.otpHash) {
    logSecurityEvent(req, 'lockout_otp_failed', { actorUserId: payload.userId });
    return res.status(401).json({ error: 'Incorrect code' });
  }

  try {
    await pool.query('UPDATE users SET failed_login_lockout_until = NULL WHERE id = $1', [payload.userId]);
    logSecurityEvent(req, 'lockout_cleared', { actorUserId: payload.userId, detail: { via: 'otp' } });
    res.status(200).json({ message: 'Verified — your account is unlocked. Please log in again.' });
  } catch (error) {
    console.error('Verify lockout OTP error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Re-sends the OTP above (e.g. the first email is slow, went to spam, or
// never arrived) — mints and mails a brand-new code rather than replaying
// the original, so a resend also refreshes the 10-minute expiry. Takes
// only the existing lockoutOtpToken as proof of "you already passed the
// correct-password gate in POST /api/login" — no password re-check here.
router.post('/api/login/resend-lockout-otp', async (req, res) => {
  const { lockoutOtpToken } = req.body;
  if (!lockoutOtpToken) {
    return res.status(400).json({ error: 'lockoutOtpToken is required' });
  }

  let payload;
  try {
    payload = jwt.verify(lockoutOtpToken, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Verification session expired — please log in again' });
  }
  if (payload.type !== 'lockout-otp') {
    return res.status(401).json({ error: 'Invalid verification session' });
  }

  // sendCount defaults to 1 for a token minted before this field existed —
  // treated as "already sent once," so an old in-flight token falls
  // straight into the cooldown-gated branch rather than getting a second
  // free resend it wasn't meant to have.
  const priorSendCount = payload.sendCount || 1;
  if (priorSendCount >= 2) {
    const secondsSinceLastSend = (Date.now() - (payload.lastSentAt || 0)) / 1000;
    if (secondsSinceLastSend < RESEND_COOLDOWN_SECONDS) {
      const secondsLeft = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLastSend);
      return res.status(429).json({
        error: `Please wait ${secondsLeft} second${secondsLeft === 1 ? '' : 's'} before requesting another code.`,
        retryAfterSeconds: secondsLeft,
      });
    }
  }

  try {
    const userRes = await pool.query('SELECT id, email, name, failed_login_lockout_until FROM users WHERE id = $1', [payload.userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const user = userRes.rows[0];

    // The lock may have already been cleared (naturally expired, or lifted
    // by a verify that happened in another tab) since this token was
    // minted — resending a code for an account that isn't actually locked
    // anymore would be confusing at best, so this just tells the client to
    // go back through POST /api/login instead.
    if (!user.failed_login_lockout_until || new Date(user.failed_login_lockout_until) <= new Date()) {
      return res.status(409).json({ error: 'This account is no longer locked — please log in again.' });
    }

    const newSendCount = priorSendCount + 1;
    const otp = generateOtp();
    const newLockoutOtpToken = jwt.sign(
      { type: 'lockout-otp', userId: user.id, otpHash: hashOtp(otp), sendCount: newSendCount, lastSentAt: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: OTP_EXPIRY }
    );
    await sendLockoutOtpEmail(user.email, user.name, otp);
    logSecurityEvent(req, 'lockout_otp_sent', { actorUserId: user.id, actorEmail: user.email, detail: { resend: true, sendCount: newSendCount } });
    res.status(200).json({ lockoutOtpToken: newLockoutOtpToken });
  } catch (error) {
    console.error('Resend lockout OTP error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Completes the new-device step-up above: verifies the emailed code
// against the hash embedded in deviceOtpToken, then — UNLIKE verify-
// lockout-otp — actually finishes the login itself via
// completeLoginForUser, rather than telling the client to retry
// POST /api/login. That difference is deliberate: if trustDevice wasn't
// checked, a replayed POST /api/login would just find the device still
// untrusted and issue ANOTHER deviceOtpToken, looping forever. Trusting
// the device (if requested) happens first so completeLoginForUser's own
// login_success/recordLoginLocation calls reflect a session that's
// already fully resolved either way.
router.post('/api/login/verify-device-otp', async (req, res) => {
  const { deviceOtpToken, otp, trustDevice } = req.body;
  if (!deviceOtpToken || !otp) {
    return res.status(400).json({ error: 'deviceOtpToken and otp are required' });
  }

  let payload;
  try {
    payload = jwt.verify(deviceOtpToken, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Verification code expired — please log in again to request a new one' });
  }
  if (payload.type !== 'device-otp') {
    return res.status(401).json({ error: 'Invalid verification session' });
  }

  if (hashOtp(String(otp).trim()) !== payload.otpHash) {
    logSecurityEvent(req, 'new_device_otp_failed', { actorUserId: payload.userId });
    return res.status(401).json({ error: 'Incorrect code' });
  }

  try {
    const userRes = await pool.query('SELECT id, email, name, tos_accepted_at FROM users WHERE id = $1', [payload.userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const user = userRes.rows[0];

    if (trustDevice) {
      await pool.query(
        `INSERT INTO trusted_devices (user_id, device_id, trusted_until, user_agent, ip_address)
         VALUES ($1, $2, now() + interval '30 days', $3, $4)
         ON CONFLICT (user_id, device_id) DO UPDATE SET
           trusted_until = now() + interval '30 days', last_used_at = now(), user_agent = $3, ip_address = $4`,
        [user.id, payload.deviceId, req.headers['user-agent'] || null, req.ip]
      );
      logSecurityEvent(req, 'device_trusted', { actorUserId: user.id, actorEmail: user.email });
    }
    logSecurityEvent(req, 'new_device_verified', { actorUserId: user.id, actorEmail: user.email, detail: { trusted: Boolean(trustDevice) } });

    return completeLoginForUser(req, res, user, user.email, payload.audience);
  } catch (error) {
    console.error('Verify device OTP error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mirrors resend-lockout-otp above exactly — same instant-first-resend,
// 60-second-cooldown-after-that shape — just for the new-device flow's
// own token type. No "is this still needed" recheck the way that route's
// lockout-expiry check has: a device's trust status can't change out from
// under an in-flight verification the way a time-based lockout can, so
// there's nothing to re-validate here beyond the token and cooldown.
router.post('/api/login/resend-device-otp', async (req, res) => {
  const { deviceOtpToken } = req.body;
  if (!deviceOtpToken) {
    return res.status(400).json({ error: 'deviceOtpToken is required' });
  }

  let payload;
  try {
    payload = jwt.verify(deviceOtpToken, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Verification session expired — please log in again' });
  }
  if (payload.type !== 'device-otp') {
    return res.status(401).json({ error: 'Invalid verification session' });
  }

  const priorSendCount = payload.sendCount || 1;
  if (priorSendCount >= 2) {
    const secondsSinceLastSend = (Date.now() - (payload.lastSentAt || 0)) / 1000;
    if (secondsSinceLastSend < RESEND_COOLDOWN_SECONDS) {
      const secondsLeft = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLastSend);
      return res.status(429).json({
        error: `Please wait ${secondsLeft} second${secondsLeft === 1 ? '' : 's'} before requesting another code.`,
        retryAfterSeconds: secondsLeft,
      });
    }
  }

  try {
    const userRes = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [payload.userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const user = userRes.rows[0];

    const newSendCount = priorSendCount + 1;
    const otp = generateOtp();
    const newDeviceOtpToken = jwt.sign(
      { type: 'device-otp', userId: user.id, deviceId: payload.deviceId, audience: payload.audience, otpHash: hashOtp(otp), sendCount: newSendCount, lastSentAt: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: OTP_EXPIRY }
    );
    await sendDeviceVerificationEmail(user.email, user.name, otp, req.headers['user-agent']);
    logSecurityEvent(req, 'new_device_detected', { actorUserId: user.id, actorEmail: user.email, detail: { resend: true, sendCount: newSendCount } });
    res.status(200).json({ deviceOtpToken: newDeviceOtpToken });
  } catch (error) {
    console.error('Resend device OTP error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Completes a multi-membership login: verifies the pre-auth token, then
// re-derives role/org from the DB for the token's own userId â€” never from
// anything the client sent standalone, so a tampered organizationId in the
// request body can't grant a role/org the caller doesn't actually hold.
router.post('/api/login/select-organization', async (req, res) => {
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
      logSecurityEvent(req, 'login_blocked', {
        actorUserId: payload.userId, actorEmail: result.rows[0].email, organizationId: result.rows[0].organization_id,
        detail: { reason: 'organization_terminated' },
      });
      return res.status(403).json({ error: "This institution's access has been suspended by the platform owner. Contact your administrator." });
    }

    const m = result.rows[0];
    logSecurityEvent(req, 'login_success', { actorUserId: m.user_id, actorEmail: m.email, actorRole: m.role, organizationId: m.organization_id });
    recordLoginLocation(m.user_id, m.organization_id, m.role, req.ip);
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
router.post('/api/login/accept-tos', async (req, res) => {
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

// Stateless token, so there's nothing server-side to invalidate here — the
// frontend just discards the token from localStorage. This route stays
// mainly so AuthContext has a consistent place to call, and so a future
// token-blacklist (if ever needed) has a natural home.
router.post('/api/logout', authenticateToken, (req, res) => {
  logSecurityEvent(req, 'logout');
  res.status(200).json({ message: 'Logged out' });
});

// ============================================================================
// 4. FORGOT PASSWORD: Generate token and send email
// ============================================================================
router.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(200).json({ message: 'If that email exists, a reset link was sent.' });
    }
    logSecurityEvent(req, 'password_reset_requested', { actorUserId: userResult.rows[0].id, actorEmail: email });

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
router.post('/api/reset-password', async (req, res) => {
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
      logSecurityEvent(req, 'password_reset_failed', { detail: { reason: 'invalid_or_expired_token' } });
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const email = result.rows[0].email;
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, token_expiry = NULL WHERE email = $2',
      [hashedPassword, email]
    );
    logSecurityEvent(req, 'password_reset_completed', { actorUserId: result.rows[0].id, actorEmail: email });

    res.status(200).json({ message: 'Password reset successful. You can now log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
