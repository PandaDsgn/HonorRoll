// Small provisioning helpers shared across many domains (create-student,
// create-teacher, CSV import, the Google Form webhook, and superadmin's
// addAdminToOrganization) — split out of index.js as part of breaking
// that monolith into modules. Pure relocation.
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { sendEmail } = require('../mailer');

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

module.exports = {
  FRONTEND_URL, generateRandomPassword, findOrCreateGlobalUser, sendStudentWelcomeEmail,
};
