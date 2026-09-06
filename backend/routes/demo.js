// The self-serve "Try the demo" entry point — no credentials, no signup,
// just a fresh isolated sandbox org for whoever clicks the button on the
// home page. See lib/demo.js for provisioning/cleanup; this route only
// wires that into a real session token, the same shape POST /api/login
// hands back so the frontend's existing login() flow needs no special
// case for a demo session beyond the extra isDemo/demoExpiresAt fields.
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../lib/db');
const { authenticateToken } = require('../lib/auth');
const { provisionDemoOrg, DEMO_DURATION_MS, DEMO_ROLES } = require('../lib/demo');

// Shared by both routes below — a token that expires exactly `expiresAt`
// (not the app's normal 24h JWT_EXPIRATION, via mintSessionToken in lib/
// auth.js) so a demo session's token can never outlive the org it points
// at, whether that's a fresh 30-minute grant or whatever's left of one
// already in progress (switch-role must not reset the clock).
function issueDemoSession({ userId, email, role, organizationId, orgUnitId, expiresAt }) {
  const remainingSeconds = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const token = jwt.sign(
    { userId, role, organizationId, orgUnitId: orgUnitId ?? null },
    process.env.JWT_SECRET,
    { expiresIn: remainingSeconds }
  );
  return {
    token,
    user: {
      id: userId,
      email,
      role,
      name: `Demo ${role[0].toUpperCase()}${role.slice(1)}`,
      organization_name: 'Demo Organization',
      is_demo: true,
      demo_expires_at: expiresAt,
    },
  };
}

router.post('/api/demo/start', async (req, res) => {
  // Superadmin is platform staff, not a role any organization has — never
  // a valid demo choice. Anything else invalid (typo, missing) falls back
  // to student rather than rejecting outright, since this is a public,
  // no-signup entry point where a confusing 400 serves nobody.
  const role = DEMO_ROLES.includes(req.body?.role) ? req.body.role : 'student';
  try {
    const demo = await provisionDemoOrg();
    const { userId, email, orgUnitId } = demo.users[role];
    res.status(200).json({
      message: 'Demo session started',
      ...issueDemoSession({ userId, email, role, organizationId: demo.organizationId, orgUnitId, expiresAt: demo.expiresAt }),
    });
  } catch (err) {
    console.error('Failed to start demo session:', err);
    res.status(500).json({ error: 'Could not start a demo session right now. Please try again.' });
  }
});

// Switches which of the SAME demo org's 3 seeded identities the caller is
// signed in as — not a new demo, the same one, same expiry clock, same
// data. That's the whole point: a change one role makes (a teacher posting
// an assignment, say) is immediately visible after switching to student,
// because it was always the same organization_id underneath. Gated on the
// caller's own org actually being a demo org so this can never become a
// way to "become" another real person at a real institution.
router.post('/api/demo/switch-role', authenticateToken, async (req, res) => {
  const role = req.body?.role;
  if (!DEMO_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  try {
    const orgRes = await pool.query(
      'SELECT is_demo, demo_expires_at FROM organizations WHERE id = $1',
      [req.user.organizationId]
    );
    const org = orgRes.rows[0];
    if (!org?.is_demo) {
      return res.status(403).json({ error: 'Not a demo session' });
    }
    if (new Date(org.demo_expires_at) <= new Date()) {
      return res.status(410).json({ error: 'This demo session has expired' });
    }

    const memberRes = await pool.query(
      `SELECT u.id, u.email, m.org_unit_id FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 AND m.role = $2`,
      [req.user.organizationId, role]
    );
    if (memberRes.rows.length === 0) {
      return res.status(404).json({ error: 'That role is not available in this demo' });
    }

    res.status(200).json(issueDemoSession({
      userId: memberRes.rows[0].id,
      email: memberRes.rows[0].email,
      role,
      organizationId: req.user.organizationId,
      orgUnitId: memberRes.rows[0].org_unit_id,
      expiresAt: org.demo_expires_at,
    }));
  } catch (err) {
    console.error('Failed to switch demo role:', err);
    res.status(500).json({ error: 'Could not switch role right now.' });
  }
});

module.exports = router;
