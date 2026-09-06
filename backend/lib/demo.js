// Backs the "Try the demo" flow: a brand-new, fully isolated organization
// per visitor, seeded with a small amount of realistic content, torn down
// automatically once its timer runs out. Isolated (not one shared org) so
// two visitors trying the demo at once never see each other's changes —
// see createOrganizationWithDefaults's own comment for why every org
// (demo or real) already gets grade_bands/tag_visibility_settings/
// subscriptions for free.
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('./db');
const { createOrganizationWithDefaults } = require('./org');
// The superadmin "delete institution" route's own teardown helper — it
// already knows the correct order for the handful of organization_id FKs
// that don't cascade (users, problems, exams, grade_bands) plus the
// subjects -> org_units -> org_level_defs RESTRICT chain, which a naive
// `DELETE FROM organizations` alone can't handle. Reused as-is rather than
// reinventing the same ordering here.
const { deleteOrganizationData } = require('../routes/superadmin');

const DEMO_DURATION_MS = 30 * 60 * 1000;
// A demo org is deleted the moment its timer expires, so the password
// hash is never actually needed to log back in — still real bcrypt output
// (not a placeholder string) so nothing downstream that assumes a valid
// hash shape breaks.
const DEMO_PASSWORD_PLACEHOLDER = crypto.randomBytes(24).toString('hex');

// One identity per role that actually matters to a visitor (admin,
// teacher, student — never superadmin, that's platform-staff-only and has
// no organization to demo), all in the same org so an admin's Students/
// Teachers lists show real people instead of just themselves. Two sample
// assignments (one already has a starter solution + test cases, matching
// what a real assignment looks like) and one short exam, shared by every
// role — enough to click around Assignments/Exams/Students without
// landing on an empty dashboard, without simulating the whole platform.
const DEMO_ROLES = [
  { role: 'admin', name: 'Demo Admin' },
  { role: 'teacher', name: 'Demo Teacher' },
  { role: 'student', name: 'Demo Student' },
];

async function provisionDemoOrg() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const org = await createOrganizationWithDefaults(client, `Demo — ${new Date().toISOString().slice(0, 19)}`);
    const expiresAt = new Date(Date.now() + DEMO_DURATION_MS);
    await client.query('UPDATE organizations SET is_demo = true, demo_expires_at = $1 WHERE id = $2', [expiresAt, org.id]);

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD_PLACEHOLDER, 10);
    // { admin: { userId, email }, teacher: {...}, student: {...} }
    const users = {};
    for (const { role, name } of DEMO_ROLES) {
      const email = `demo-${role}-${crypto.randomUUID()}@honorroll.demo`;
      const userRes = await client.query(
        `INSERT INTO users (email, password_hash, name, tos_accepted_at)
         VALUES ($1, $2, $3, now()) RETURNING id`,
        [email, passwordHash, name]
      );
      const userId = userRes.rows[0].id;
      await client.query(
        'INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, $3)',
        [userId, org.id, role]
      );
      users[role] = { userId, email };
    }
    const adminId = users.admin.userId;

    const problemRes = await client.query(
      `INSERT INTO problems (title, description, difficulty, organization_id, created_by, submission_mode)
       VALUES ($1, $2, 'medium', $3, $4, 'code') RETURNING id`,
      ['Longest Common Prefix', 'Write a function that returns the longest common prefix string amongst an array of strings. Return an empty string if there is none.', org.id, adminId]
    );
    const problemId = problemRes.rows[0].id;
    await client.query(
      `INSERT INTO test_cases (problem_id, input, expected_output, is_hidden) VALUES
        ($1, $2, $3, false), ($1, $4, $5, true)`,
      [problemId, 'flower\nflow\nflight', 'fl', 'dog\nracecar\ncar', '']
    );
    await client.query(
      `INSERT INTO starter_code (problem_id, language, code) VALUES ($1, 'python', $2)`,
      [problemId, 'def longest_common_prefix(words):\n    pass\n']
    );

    await client.query(
      `INSERT INTO problems (title, description, difficulty, organization_id, created_by, submission_mode)
       VALUES ($1, $2, 'easy', $3, $4, 'code')`,
      ['Two Sum', 'Given an array of integers and a target, return the indices of the two numbers that add up to the target.', org.id, adminId]
    );

    const examRes = await client.query(
      `INSERT INTO exams (title, description, total_marks, total_time_seconds, organization_id, created_by)
       VALUES ($1, $2, 10, 900, $3, $4) RETURNING id`,
      ['Data Structures Quiz', 'A short timed quiz covering arrays, trees, and time complexity.', org.id, adminId]
    );
    await client.query(
      `INSERT INTO exam_items (exam_id, type, position, marks, prompt, options, correct_option_id) VALUES
        ($1, 'mcq', 0, 5, 'What is the time complexity of binary search on a sorted array of n elements?',
         $2, 'b')`,
      [examRes.rows[0].id, JSON.stringify([
        { id: 'a', text: 'O(n)' },
        { id: 'b', text: 'O(log n)' },
        { id: 'c', text: 'O(n log n)' },
        { id: 'd', text: 'O(1)' },
      ])]
    );
    await client.query(
      `INSERT INTO exam_items (exam_id, type, position, marks, prompt, word_limit) VALUES
        ($1, 'short', 1, 5, 'In one or two sentences, explain why a hash map lookup is faster than scanning an array.', 300)`,
      [examRes.rows[0].id]
    );

    await client.query('COMMIT');
    return { organizationId: org.id, users, expiresAt };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function sweepExpiredDemoOrgs() {
  const { rows } = await pool.query('SELECT id FROM organizations WHERE is_demo = true AND demo_expires_at < now()');
  for (const { id } of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // deleteOrganizationData cascades the membership row but deliberately
      // leaves the global users row itself intact — a real person can
      // belong to several organizations, so deleting one org must never
      // delete their identity. A demo identity has nothing left to belong
      // to once this org is gone (provisionDemoOrg never adds it anywhere
      // else), so without this it'd sit in `users` forever, one orphaned
      // row per demo session ever started.
      const memberRes = await client.query('SELECT user_id FROM memberships WHERE organization_id = $1', [id]);
      const userIds = memberRes.rows.map((r) => r.user_id);
      await deleteOrganizationData(client, id);
      if (userIds.length > 0) {
        await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`Failed to clean up expired demo org ${id}:`, err);
    } finally {
      client.release();
    }
  }
}

// ponytail: a plain setInterval, not a real job queue — this process is
// already a long-lived Express server (not serverless), so an in-process
// timer is the whole mechanism; move to a proper scheduler only if this
// ever runs across multiple instances and double-sweeps become a problem.
function startDemoCleanupSweep() {
  sweepExpiredDemoOrgs().catch((err) => console.error('Initial demo cleanup sweep failed:', err));
  setInterval(() => {
    sweepExpiredDemoOrgs().catch((err) => console.error('Demo cleanup sweep failed:', err));
  }, 5 * 60 * 1000);
}

module.exports = {
  DEMO_DURATION_MS,
  DEMO_ROLES: DEMO_ROLES.map((r) => r.role),
  provisionDemoOrg,
  sweepExpiredDemoOrgs,
  startDemoCleanupSweep,
};
