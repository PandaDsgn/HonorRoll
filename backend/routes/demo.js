// The self-serve "Try the demo" entry point — no credentials, no signup,
// just a fresh isolated sandbox org for whoever clicks the button on the
// home page. See lib/demo.js for provisioning/cleanup; this route only
// wires that into a real session token, the same shape POST /api/login
// hands back so the frontend's existing login() flow needs no special
// case for a demo session beyond the extra isDemo/demoExpiresAt fields.
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { provisionDemoOrg, DEMO_DURATION_MS, DEMO_ROLES } = require('../lib/demo');

router.post('/api/demo/start', async (req, res) => {
  // Superadmin is platform staff, not a role any organization has — never
  // a valid demo choice. Anything else invalid (typo, missing) falls back
  // to student rather than rejecting outright, since this is a public,
  // no-signup entry point where a confusing 400 serves nobody.
  const role = DEMO_ROLES.includes(req.body?.role) ? req.body.role : 'student';
  try {
    const demo = await provisionDemoOrg();
    const { userId, email } = demo.users[role];
    // Deliberately NOT mintSessionToken (lib/auth.js) — that helper signs
    // for the app's normal JWT_EXPIRATION (default 24h), which would let
    // the token itself outlive the demo org it points at by hours. A demo
    // session's token needs to die with the org, not after it.
    const token = jwt.sign(
      { userId, role, organizationId: demo.organizationId, orgUnitId: null },
      process.env.JWT_SECRET,
      { expiresIn: Math.floor(DEMO_DURATION_MS / 1000) }
    );
    res.status(200).json({
      message: 'Demo session started',
      token,
      user: {
        id: userId,
        email,
        role,
        name: `Demo ${role[0].toUpperCase()}${role.slice(1)}`,
        organization_name: 'Demo Organization',
        is_demo: true,
        demo_expires_at: demo.expiresAt,
      },
    });
  } catch (err) {
    console.error('Failed to start demo session:', err);
    res.status(500).json({ error: 'Could not start a demo session right now. Please try again.' });
  }
});

module.exports = router;
