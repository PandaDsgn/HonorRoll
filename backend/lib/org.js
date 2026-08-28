// Org-creation helper, shared by the signup route AND the
// self-serve start-institution route — a clean, standalone piece
// pulled out separately from the rest of the org-lifecycle helpers
// (setOrganizationStatus, deleteOrganizationData, etc.), which stay
// in routes/superadmin.js since they're tightly interleaved with
// live superadmin route code there, not genuinely shared.
const crypto = require('crypto');

// Shared by POST /api/organizations/signup (brand-new identity + new org)
// and POST /api/me/start-institution (an already-authenticated identity
// founding a SECOND org) — both just need "a fresh approved org with the
// same starter defaults every org gets"; they differ only in how the admin
// identity behind it comes to exist, not in what the org itself needs.
// extra.emailDomain/verificationTokenHash/verificationTokenExpiry are only
// ever supplied by the signup route (its own email-verification flow) —
// left null for start-institution, which has no separate email to verify.
async function createOrganizationWithDefaults(client, name, extra = {}) {
  const webhookSecret = crypto.randomBytes(16).toString('hex');
  const orgRes = await client.query(
    `INSERT INTO organizations (name, webhook_secret, status, email_domain, verification_token_hash, verification_token_expiry)
     VALUES ($1, $2, 'approved', $3, $4, $5) RETURNING id, name`,
    [name, webhookSecret, extra.emailDomain || null, extra.verificationTokenHash || null, extra.verificationTokenExpiry || null]
  );
  const org = orgRes.rows[0];

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

  return org;
}

module.exports = { createOrganizationWithDefaults };
