// Organization self-serve signup/verify + platform-owner
// approve/reject routes — split out of index.js as part of breaking
// that monolith into modules. Pure relocation. Mounted with no
// prefix in index.js — every path below is the exact full path it
// always was.
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { DENYLISTED_EMAIL_DOMAINS, requirePlatformSecret } = require('../lib/auth');
const { createOrganizationWithDefaults } = require('../lib/org');
const { sendEmail } = require('../mailer');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

router.post('/api/organizations/signup', async (req, res) => {
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

    const org = await createOrganizationWithDefaults(client, organizationName.trim(), {
      emailDomain,
      verificationTokenHash,
      verificationTokenExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

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
router.get('/api/organizations/verify', async (req, res) => {
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
router.get('/api/platform/organizations', requirePlatformSecret, async (req, res) => {
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

router.post('/api/platform/organizations/:id/approve', requirePlatformSecret, async (req, res) => {
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

router.post('/api/platform/organizations/:id/reject', requirePlatformSecret, async (req, res) => {
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

module.exports = router;
