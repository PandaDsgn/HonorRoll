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
const { sendEmail } = require('../mailer');

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

module.exports = router;
