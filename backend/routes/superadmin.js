// Superadmin (platform-owner) routes — organization lifecycle,
// escalated requests, contact messages, add-admin requests, billing
// overrides. Split out of index.js as part of breaking that monolith
// into modules. Pure relocation: nothing about any route's behavior
// changed, only where it lives. Mounted with no prefix in index.js —
// every path below is the exact full path it always was.
//
// NOT everything superadmin-related lives here: /api/admin/profile-
// change-requests, /api/admin/requests, /api/contact, and
// /api/admin/add-admin-requests are genuinely interleaved ADMIN
// routes (not superadmin) that happened to sit between these in the
// original file — they stay in index.js for now, to move together
// with the rest of the admin-dashboard domain.
const express = require('express');
const router = express.Router();
const archiver = require('archiver');
const { pool } = require('../lib/db');
const { authenticateToken, requireSuperadmin, applySuperadminOrgOverride, mintSessionToken } = require('../lib/auth');
const { PLAN_CATALOG, BILLING_CYCLES } = require('../lib/billing');
const { findOrCreateGlobalUser } = require('../lib/misc');
const { logSecurityEvent } = require('../lib/securityEvents');
const { sendEmail } = require('../mailer');

// ============================================================================
// SUPERADMIN — platform-owner visibility across every organization. Built
// as impersonation rather than a parallel set of cross-org query routes:
// picking an org mints a completely ordinary admin session token for it
// (via the exact same mintSessionToken() every real admin login uses), so
// the entire existing AdminDashboard/StudentsPanel/BillingPanel/etc. UI and
// every backend route work unmodified — there is no second code path to
// keep in sync as the app grows. The superadmin's own user id is reused
// directly as the "admin" in that session; it needs no real membership row
// in the target org because nothing downstream checks for one — every
// admin-gated route trusts the JWT's role/organizationId claims alone.
// ============================================================================
router.get('/api/superadmin/organizations', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        o.id, o.name, o.status, o.created_at,
        COALESCE(sub.plan_key, 'free') AS plan_key,
        COALESCE(sub.status, 'free') AS billing_status,
        (SELECT COUNT(*)::int FROM memberships m WHERE m.organization_id = o.id AND m.role = 'student') AS student_count,
        (SELECT COUNT(*)::int FROM memberships m WHERE m.organization_id = o.id AND m.role = 'teacher') AS teacher_count,
        (SELECT COALESCE(json_agg(json_build_object('user_id', u.id, 'name', u.name, 'email', u.email) ORDER BY u.name), '[]'::json)
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = o.id AND m.role = 'admin') AS admins
      FROM organizations o
      LEFT JOIN subscriptions sub ON sub.organization_id = o.id
      ORDER BY o.created_at DESC
    `);
    const organizations = result.rows;

    // Platform-wide totals — computed here in JS from the same rows rather
    // than a second query, since every input is already in `organizations`.
    // Deliberately not a database-level aggregate: this whole route is
    // "everything a superadmin needs on one screen" (see this route's own
    // comment further down about not building a parallel per-org UI), and
    // that includes the top-line numbers, not just the row-by-row table.
    const summary = {
      totalOrganizations: organizations.length,
      totalStudents: organizations.reduce((sum, o) => sum + o.student_count, 0),
      totalTeachers: organizations.reduce((sum, o) => sum + o.teacher_count, 0),
      planBreakdown: organizations.reduce((acc, o) => { acc[o.plan_key] = (acc[o.plan_key] || 0) + 1; return acc; }, {}),
      billingStatusBreakdown: organizations.reduce((acc, o) => { acc[o.billing_status] = (acc[o.billing_status] || 0) + 1; return acc; }, {}),
    };

    res.status(200).json({ organizations, summary });
  } catch (err) {
    console.error('Superadmin list organizations error:', err);
    res.status(500).json({ error: 'Failed to load organizations' });
  }
});

// Superadmin lifecycle control over an organization's status — the
// dashboard-accessible counterpart to the curl-only /api/platform/
// organizations/:id/approve|reject routes above, plus two states those
// never had: reverting an approved org back to 'pending' ("unapprove"),
// and 'terminated' — a full blacklist that also blocks login for every
// existing member (see the org-status check in POST /api/login), not just
// new roster growth the way pending/rejected do. Each route just sets the
// target status outright regardless of the org's current one, since a
// superadmin has standing authority to move any org to any state (e.g.
// reinstating a terminated org also goes through /approve).
async function setOrganizationStatus(orgId, status, actorEmail) {
  const result = await pool.query(
    `UPDATE organizations SET status = $1, approved_at = now(), approved_by = $2 WHERE id = $3 RETURNING id, name, status`,
    [status, actorEmail, orgId]
  );
  return result.rows[0] || null;
}

function makeSetOrgStatusRoute(status, actionLabel) {
  return async (req, res) => {
    try {
      const actorRes = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.userId]);
      const org = await setOrganizationStatus(req.params.id, status, actorRes.rows[0]?.email || 'superadmin');
      if (!org) return res.status(404).json({ error: 'Organization not found' });
      logSecurityEvent(req, 'org_status_changed', { organizationId: org.id, detail: { organizationName: org.name, newStatus: status, action: actionLabel } });
      res.status(200).json({ organization: org });
    } catch (err) {
      console.error(`Superadmin ${actionLabel} organization error:`, err);
      res.status(500).json({ error: `Failed to ${actionLabel} organization` });
    }
  };
}

router.post('/api/superadmin/organizations/:id/approve', authenticateToken, requireSuperadmin, makeSetOrgStatusRoute('approved', 'approve'));
router.post('/api/superadmin/organizations/:id/unapprove', authenticateToken, requireSuperadmin, makeSetOrgStatusRoute('pending', 'unapprove'));
router.post('/api/superadmin/organizations/:id/reject', authenticateToken, requireSuperadmin, makeSetOrgStatusRoute('rejected', 'reject'));
router.post('/api/superadmin/organizations/:id/terminate', authenticateToken, requireSuperadmin, makeSetOrgStatusRoute('terminated', 'terminate'));

// ============================================================================
// PERMANENT DELETION — irreversible. Everything below exists to back one
// guarantee: the institution's admin(s) always have a full copy of their
// data in hand before any of it is destroyed, and if that copy can't be
// delivered (Gmail unconfigured, send failure, no recipient), nothing gets
// deleted at all. See DELETE /api/superadmin/organizations/:id further down
// for how these three pieces (export, zip, delete) are actually sequenced.
// ============================================================================

// Tables with their own organization_id column — the direct slice of "this
// institution's data". Everything else that belongs to the org (test cases,
// submissions, exam attempts, ...) is reached transitively through these,
// via problem_id/exam_id/subject_id — see exportOrganizationData below.
const DIRECT_ORG_TABLES = [
  'memberships', 'org_level_defs', 'org_units', 'subjects', 'problems', 'exams',
  'grade_bands', 'tag_visibility_settings', 'profile_change_requests',
  'admin_requests', 'legacy_scores', 'subscriptions',
];

// Read-only snapshot of every row this organization owns, shaped as
// { tableName: rows[] } — one JSON file per table once zipped. Deliberately
// never touches users.password_hash: `roster` is a name/email/role view
// joined from memberships instead of a raw users dump, since users is a
// global identity that may still have accounts elsewhere.
async function exportOrganizationData(orgId) {
  const data = {};
  data.organization = (await pool.query('SELECT * FROM organizations WHERE id = $1', [orgId])).rows;

  for (const table of DIRECT_ORG_TABLES) {
    data[table] = (await pool.query(`SELECT * FROM ${table} WHERE organization_id = $1`, [orgId])).rows;
  }

  data.roster = (await pool.query(
    `SELECT u.id AS user_id, u.email, u.name, m.role, m.org_unit_id, m.roll_number, m.created_at AS member_since
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1`,
    [orgId]
  )).rows;

  const subjectIds = data.subjects.map((s) => s.id);
  data.subject_teachers = subjectIds.length
    ? (await pool.query('SELECT * FROM subject_teachers WHERE subject_id = ANY($1)', [subjectIds])).rows
    : [];

  const problemIds = data.problems.map((p) => p.id);
  if (problemIds.length) {
    data.test_cases = (await pool.query('SELECT * FROM test_cases WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.starter_code = (await pool.query('SELECT * FROM starter_code WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.problem_time_logs = (await pool.query('SELECT * FROM problem_time_logs WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.submissions = (await pool.query('SELECT * FROM submissions WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.scan_assignment_questions = (await pool.query('SELECT * FROM scan_assignment_questions WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.scan_submissions = (await pool.query('SELECT * FROM scan_submissions WHERE problem_id = ANY($1)', [problemIds])).rows;
    data.scan_plagiarism_flags = (await pool.query('SELECT * FROM scan_plagiarism_flags WHERE problem_id = ANY($1)', [problemIds])).rows;
  } else {
    data.test_cases = []; data.starter_code = []; data.problem_time_logs = [];
    data.submissions = []; data.scan_assignment_questions = []; data.scan_submissions = [];
    data.scan_plagiarism_flags = [];
  }

  const scanSubmissionIds = data.scan_submissions.map((s) => s.id);
  if (scanSubmissionIds.length) {
    data.scan_submission_answers = (await pool.query('SELECT * FROM scan_submission_answers WHERE submission_id = ANY($1)', [scanSubmissionIds])).rows;
    data.scan_handwriting_flags = (await pool.query(
      'SELECT * FROM scan_handwriting_flags WHERE submission_a_id = ANY($1) OR submission_b_id = ANY($1)', [scanSubmissionIds]
    )).rows;
  } else {
    data.scan_submission_answers = []; data.scan_handwriting_flags = [];
  }

  const examIds = data.exams.map((e) => e.id);
  if (examIds.length) {
    data.exam_items = (await pool.query('SELECT * FROM exam_items WHERE exam_id = ANY($1)', [examIds])).rows;
    data.exam_attempts = (await pool.query('SELECT * FROM exam_attempts WHERE exam_id = ANY($1)', [examIds])).rows;
  } else {
    data.exam_items = []; data.exam_attempts = [];
  }

  const attemptIds = data.exam_attempts.map((a) => a.id);
  if (attemptIds.length) {
    data.exam_answers = (await pool.query('SELECT * FROM exam_answers WHERE attempt_id = ANY($1)', [attemptIds])).rows;
    data.exam_proctor_flags = (await pool.query('SELECT * FROM exam_proctor_flags WHERE attempt_id = ANY($1)', [attemptIds])).rows;
    data.exam_scan_answers = (await pool.query('SELECT * FROM exam_scan_answers WHERE attempt_id = ANY($1)', [attemptIds])).rows;
  } else {
    data.exam_answers = []; data.exam_proctor_flags = []; data.exam_scan_answers = [];
  }

  return data;
}

// One JSON file per table, zipped in memory — small enough for any one
// institution's data that streaming to disk first isn't worth the extra
// moving part.
function buildZipBuffer(data) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const [table, rows] of Object.entries(data)) {
      archive.append(JSON.stringify(rows, null, 2), { name: `${table}.json` });
    }
    archive.finalize();
  });
}

// The actual destructive part — only ever called after the export above has
// already been emailed out successfully (see the route below). Explicit,
// ordered DELETEs rather than relying on cascade: several org-scoped tables
// (exams, problems, grade_bands, tag_visibility_settings) use ON DELETE NO
// ACTION on organization_id, not CASCADE, so a bare `DELETE FROM
// organizations` would fail outright with a foreign-key violation. org_units
// deletes as one whole-subtree statement despite its self-referential
// parent_unit_id RESTRICT — Postgres checks RESTRICT/NO ACTION constraints
// at the end of the statement, against what's left standing, not per row
// against rows that are about to disappear in the same statement — so
// deleting every row for this org in one DELETE is safe as long as subjects
// (which RESTRICTs org_units) goes first, and org_level_defs (RESTRICTed by
// org_units) goes after. Everything else CASCADEs from organizations.id and
// needs no explicit statement of its own.
async function deleteOrganizationData(client, orgId) {
  // Legacy, unused-since-the-memberships-cutover column (see
  // ensureMembershipsSchema's own comment) — NO ACTION on organizations.id,
  // so it has to be cleared, not left dangling, before the org row can go.
  await client.query('UPDATE users SET organization_id = NULL WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM exams WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM problems WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM subjects WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM org_units WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM org_level_defs WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM grade_bands WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM tag_visibility_settings WHERE organization_id = $1', [orgId]);
  await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);
}

router.delete('/api/superadmin/organizations/:id', authenticateToken, requireSuperadmin, async (req, res) => {
  const orgId = req.params.id;
  try {
    const orgRes = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    const org = orgRes.rows[0];

    const data = await exportOrganizationData(orgId);
    const zipBuffer = await buildZipBuffer(data);

    // Every admin of this org gets the archive. If it somehow has none,
    // falls back to the superadmin performing the deletion, so the archive
    // is never just silently dropped for lack of a mailbox to put it in.
    const adminRes = await pool.query(
      `SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 AND m.role = 'admin' AND u.email IS NOT NULL`,
      [orgId]
    );
    let recipients = adminRes.rows.map((r) => r.email).filter(Boolean);
    if (recipients.length === 0) {
      const actorRes = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.userId]);
      if (actorRes.rows[0]?.email) recipients = [actorRes.rows[0].email];
    }
    if (recipients.length === 0) {
      return res.status(500).json({ error: 'No recipient found for the data archive — deletion aborted' });
    }

    const zipFilename = `${org.name.replace(/[^a-z0-9]+/gi, '_')}_data_export.zip`;
    // The one hard rule this whole route exists to enforce: deletion only
    // proceeds once every recipient has actually received the archive. Any
    // send failure (Gmail unconfigured, API error, etc.) aborts before a
    // single row is touched.
    const sendResults = await Promise.all(recipients.map((to) => sendEmail({
      to,
      subject: `HonorRoll — ${org.name} data export (institution deleted)`,
      text: `Attached is a full export of ${org.name}'s data on HonorRoll, taken immediately before permanent deletion by the platform owner.\n\nThis institution's account, roster, assignments, exams, and all related records have now been permanently removed from HonorRoll and cannot be recovered — this archive is the only remaining copy.\n\n— HonorRoll`,
      attachments: [{ filename: zipFilename, content: zipBuffer, contentType: 'application/zip' }],
    })));
    const failed = sendResults.find((r) => r.error);
    if (failed) {
      console.error('Organization data export email failed, aborting deletion:', failed.error);
      return res.status(502).json({ error: 'Failed to email the data export — deletion aborted, nothing was deleted' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await deleteOrganizationData(client, orgId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    logSecurityEvent(req, 'org_deleted', { organizationId: orgId, detail: { organizationName: org.name } });
    res.status(200).json({ message: `${org.name} and all its data have been permanently deleted. A full export was emailed to ${recipients.join(', ')}.` });
  } catch (err) {
    console.error('Superadmin delete organization error:', err);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
});

// Global user search across every organization — lets a superadmin jump
// straight to "which org(s) is this person in" instead of impersonating
// into each org one at a time to look. Read-only by design: it never
// exposes a way to edit anyone directly at this scope, only to see where
// they are — actually altering a student's details still goes through the
// exact same admin-side StudentDetailPanel edit flow every real admin
// uses, reached by impersonating into the right org first (see POST
// /api/superadmin/organizations/:id/impersonate right below).
router.get('/api/superadmin/users', authenticateToken, requireSuperadmin, async (req, res) => {
  const search = String(req.query.search || '').trim();
  if (search.length < 2) return res.status(200).json({ users: [] });
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.name,
              COALESCE((
                SELECT json_agg(json_build_object('organizationId', m.organization_id, 'organizationName', o.name, 'role', m.role) ORDER BY o.name)
                FROM memberships m JOIN organizations o ON o.id = m.organization_id
                WHERE m.user_id = u.id
              ), '[]') AS memberships
       FROM users u
       WHERE (u.email ILIKE $1 OR u.name ILIKE $1)
         AND EXISTS (SELECT 1 FROM memberships m2 WHERE m2.user_id = u.id)
       ORDER BY u.email ASC
       LIMIT 50`,
      [`%${search}%`]
    );
    res.status(200).json({ users: result.rows });
  } catch (err) {
    console.error('Superadmin user search error:', err);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// Student profile-correction requests escalated by institution admins to superadmin.
// Defaults to escalated queue (?status=escalated); pass ?status=all to view full history.
router.get('/api/superadmin/profile-change-requests', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const statusParam = req.query.status;
    const allowed = ['escalated', 'pending', 'approved', 'rejected'];
    const status = allowed.includes(statusParam) ? statusParam : 'escalated';
    const params = [];
    let where = '';
    if (statusParam !== 'all') {
      params.push(status);
      where = 'WHERE r.status = $1';
    }
    const result = await pool.query(
      `SELECT r.id, r.field, r.current_value, r.requested_value, r.reason, r.status, r.review_note, r.reviewed_at, r.created_at,
              r.escalated_at, r.escalation_note,
              u.id AS student_id, u.email AS student_email, u.name AS student_name,
              o.id AS organization_id, o.name AS organization_name,
              esc.name AS escalated_by_name, esc.email AS escalated_by_email
       FROM profile_change_requests r
       JOIN users u ON u.id = r.user_id
       JOIN organizations o ON o.id = r.organization_id
       LEFT JOIN users esc ON esc.id = r.escalated_by
       ${where}
       ORDER BY COALESCE(r.escalated_at, r.created_at) DESC`,
      params
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('Superadmin list profile change requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// Superadmin review for escalated requests. On approval, 'name' or 'roll_number' are auto-applied to the DB.
router.post('/api/superadmin/profile-change-requests/:id/review', authenticateToken, requireSuperadmin, async (req, res) => {
  const status = req.body.status === 'approved' || req.body.status === 'rejected' ? req.body.status : null;
  if (!status) return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;

  try {
    const reqRes = await pool.query(
      `SELECT r.*, u.name AS student_name, u.email AS student_email, o.name AS organization_name
       FROM profile_change_requests r
       JOIN users u ON u.id = r.user_id
       JOIN organizations o ON o.id = r.organization_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = reqRes.rows[0];
    if (request.status === 'approved' || request.status === 'rejected') {
      return res.status(409).json({ error: 'This request was already reviewed' });
    }

    if (status === 'approved') {
      const normalizedField = request.field.trim().toLowerCase().replace(/\s+/g, '_');
      if (normalizedField === 'name') {
        await pool.query('UPDATE users SET name = $1 WHERE id = $2', [request.requested_value, request.user_id]);
      } else if (normalizedField === 'roll_number' || normalizedField === 'rollnumber') {
        await pool.query(
          'UPDATE memberships SET roll_number = $1 WHERE user_id = $2 AND organization_id = $3',
          [request.requested_value, request.user_id, request.organization_id]
        );
      }
    }

    const result = await pool.query(
      `UPDATE profile_change_requests SET status = $1, reviewed_by = $2, reviewed_at = now(), review_note = $3
       WHERE id = $4 RETURNING id, status, review_note, reviewed_at`,
      [status, req.user.userId, note, req.params.id]
    );

    // Notify student of outcome
    const { error: mailErr } = await sendEmail({
      to: request.student_email,
      subject: `HonorRoll — Info Change Request ${status === 'approved' ? 'Approved' : 'Update'}`,
      text: `Hello ${request.student_name || 'Student'},\n\nYour request to change "${request.field}" to "${request.requested_value}" has been ${status === 'approved' ? 'approved' : 'rejected'}.${note ? `\n\nNote: ${note}` : ''}\n\n— HonorRoll`,
    });
    if (mailErr) console.error('Superadmin review notification email error:', mailErr);

    res.status(200).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Review profile change request error:', err);
    res.status(500).json({ error: 'Failed to review request' });
  }
});

// Every admin-originated request across the platform. Defaults to the open
// queue (?status=open); pass ?status=all for full history.
router.get('/api/superadmin/requests', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const statusParam = req.query.status;
    const status = statusParam === 'resolved' ? 'resolved' : 'open';
    const params = [];
    let where = '';
    if (statusParam !== 'all') {
      params.push(status);
      where = 'WHERE r.status = $1';
    }
    const result = await pool.query(
      `SELECT r.id, r.subject, r.message, r.status, r.response_note, r.resolved_at, r.created_at,
              u.name AS admin_name, u.email AS admin_email,
              o.id AS organization_id, o.name AS organization_name
       FROM admin_requests r
       JOIN users u ON u.id = r.admin_user_id
       JOIN organizations o ON o.id = r.organization_id
       ${where}
       ORDER BY r.created_at DESC`,
      params
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('Superadmin list admin requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// Marks an admin request resolved, with an optional note the admin sees back.
router.post('/api/superadmin/requests/:id/resolve', authenticateToken, requireSuperadmin, async (req, res) => {
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;
  try {
    const reqRes = await pool.query(
      `SELECT r.*, u.name AS admin_name, u.email AS admin_email
       FROM admin_requests r JOIN users u ON u.id = r.admin_user_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = reqRes.rows[0];
    if (request.status === 'resolved') return res.status(409).json({ error: 'This request was already resolved' });

    const result = await pool.query(
      `UPDATE admin_requests SET status = 'resolved', resolved_by = $1, resolved_at = now(), response_note = $2
       WHERE id = $3 RETURNING id, status, response_note, resolved_at`,
      [req.user.userId, note, req.params.id]
    );

    if (request.admin_email) {
      const { error: mailErr } = await sendEmail({
        to: request.admin_email,
        subject: `HonorRoll — Your request "${request.subject}" was resolved`,
        text: `Hello ${request.admin_name || 'Administrator'},\n\nYour request "${request.subject}" has been marked resolved.${note ? `\n\nResponse: ${note}` : ''}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Admin request resolution email error:', mailErr);
    }

    res.status(200).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Resolve admin request error:', err);
    res.status(500).json({ error: 'Failed to resolve request' });
  }
});

router.get('/api/superadmin/contact-messages', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const statusParam = req.query.status;
    const status = statusParam === 'resolved' ? 'resolved' : 'open';
    const params = [];
    let where = '';
    if (statusParam !== 'all') {
      params.push(status);
      where = 'WHERE status = $1';
    }
    const result = await pool.query(
      `SELECT id, name, mobile, email, message, status, response_note, resolved_at, created_at
       FROM contact_messages ${where} ORDER BY created_at DESC`,
      params
    );
    res.status(200).json({ messages: result.rows });
  } catch (err) {
    console.error('Superadmin list contact messages error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

router.post('/api/superadmin/contact-messages/:id/resolve', authenticateToken, requireSuperadmin, async (req, res) => {
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;
  try {
    const msgRes = await pool.query('SELECT * FROM contact_messages WHERE id = $1', [req.params.id]);
    if (msgRes.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
    if (msgRes.rows[0].status === 'resolved') return res.status(409).json({ error: 'This message was already resolved' });

    const result = await pool.query(
      `UPDATE contact_messages SET status = 'resolved', resolved_by = $1, resolved_at = now(), response_note = $2
       WHERE id = $3 RETURNING id, status, response_note, resolved_at`,
      [req.user.userId, note, req.params.id]
    );
    res.status(200).json({ message: result.rows[0] });
  } catch (err) {
    console.error('Resolve contact message error:', err);
    res.status(500).json({ error: 'Failed to resolve message' });
  }
});

router.get('/api/superadmin/add-admin-requests', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const statusParam = req.query.status;
    const status = statusParam === 'pending' ? 'pending' : null;
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = 'WHERE r.status = $1';
    }
    const result = await pool.query(
      `SELECT r.id, r.new_admin_name, r.new_admin_email, r.status, r.review_note, r.reviewed_at, r.created_at,
              u.name AS requested_by_name, u.email AS requested_by_email,
              o.id AS organization_id, o.name AS organization_name
       FROM add_admin_requests r
       JOIN users u ON u.id = r.requested_by
       JOIN organizations o ON o.id = r.organization_id
       ${where}
       ORDER BY r.created_at DESC`,
      params
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('Superadmin list add-admin requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// Shared by the add-admin-request approve route below and by
// SuperadminOrgDetail's direct "add admin" action — both end at the same
// place (a real admin membership in one org), just reached through a
// different door. Reuses findOrCreateGlobalUser, same as every other "add
// this email to my org" path (admin create-student/create-teacher, CSV
// import). If the email already has a membership in this org (e.g. an
// existing teacher), upgrades it to admin rather than silently no-op'ing on
// the (user_id, organization_id) unique constraint. Pure DB work, no email —
// caller owns the transaction and sends the welcome/notification email
// itself only after a successful commit (see sendAddAdminEmail below).
async function addAdminToOrganization(client, orgId, email, name) {
  const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);
  const upsertRes = await client.query(
    `INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (user_id, organization_id) DO UPDATE SET role = 'admin'
     RETURNING (xmax = 0) AS was_insert`,
    [userId, orgId]
  );
  return { userId, isNew, temporaryPassword, wasNewMembership: upsertRes.rows[0].was_insert };
}

// Best-effort, called after addAdminToOrganization's transaction has
// committed — never the reverse, so a mid-transaction failure can't leave
// someone holding credentials for a membership that got rolled back.
async function sendAddAdminEmail({ email, name, organizationName, isNew, wasNewMembership, temporaryPassword }) {
  if (isNew) {
    const { error: mailErr } = await sendEmail({
      to: email,
      subject: 'Your HonorRoll Account Credentials',
      text: `Hello ${name || 'Administrator'},\n\n${organizationName} has set up your HonorRoll admin account.\n\nYour temporary password is: ${temporaryPassword}\n\nLogin via ${FRONTEND_URL}\n\nPlease log in and change your password after logging in.`,
    });
    if (mailErr) console.error('New admin welcome email error:', mailErr);
  } else if (wasNewMembership) {
    const { error: mailErr } = await sendEmail({
      to: email,
      subject: `You've been added as an admin of ${organizationName}`,
      text: `Hello ${name || 'there'},\n\nYou've been added as an administrator of ${organizationName} on HonorRoll. Sign in with your existing HonorRoll password at ${FRONTEND_URL}.\n\n— HonorRoll`,
    });
    if (mailErr) console.error('Existing-user new-admin notification email error:', mailErr);
  }
}

router.post('/api/superadmin/add-admin-requests/:id/approve', authenticateToken, requireSuperadmin, async (req, res) => {
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;
  const client = await pool.connect();
  try {
    const reqRes = await client.query(
      `SELECT r.*, o.name AS organization_name, u.email AS requested_by_email, u.name AS requested_by_name
       FROM add_admin_requests r
       JOIN organizations o ON o.id = r.organization_id
       JOIN users u ON u.id = r.requested_by
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = reqRes.rows[0];
    if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already reviewed' });

    await client.query('BEGIN');
    const addResult = await addAdminToOrganization(client, request.organization_id, request.new_admin_email, request.new_admin_name);

    const result = await client.query(
      `UPDATE add_admin_requests SET status = 'approved', reviewed_by = $1, reviewed_at = now(), review_note = $2
       WHERE id = $3 RETURNING id, status, review_note, reviewed_at`,
      [req.user.userId, note, req.params.id]
    );
    await client.query('COMMIT');
    logSecurityEvent(req, 'admin_granted', {
      organizationId: request.organization_id,
      detail: { targetUserId: addResult.userId, email: request.new_admin_email, via: 'add_admin_request' },
    });

    await sendAddAdminEmail({
      email: request.new_admin_email, name: request.new_admin_name, organizationName: request.organization_name, ...addResult,
    });
    if (request.requested_by_email) {
      const { error: mailErr } = await sendEmail({
        to: request.requested_by_email,
        subject: `Your add-admin request was approved`,
        text: `Hello ${request.requested_by_name || 'Administrator'},\n\nYour request to add ${request.new_admin_name || request.new_admin_email} (${request.new_admin_email}) as an admin of ${request.organization_name} has been approved.${note ? `\n\nNote: ${note}` : ''}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Add-admin requester notification email error:', mailErr);
    }

    res.status(200).json({ request: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Approve add-admin request error:', err);
    res.status(500).json({ error: 'Failed to approve request' });
  } finally {
    client.release();
  }
});

router.post('/api/superadmin/add-admin-requests/:id/reject', authenticateToken, requireSuperadmin, async (req, res) => {
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;
  try {
    const reqRes = await pool.query(
      `SELECT r.*, o.name AS organization_name, u.email AS requested_by_email, u.name AS requested_by_name
       FROM add_admin_requests r
       JOIN organizations o ON o.id = r.organization_id
       JOIN users u ON u.id = r.requested_by
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = reqRes.rows[0];
    if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already reviewed' });

    const result = await pool.query(
      `UPDATE add_admin_requests SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), review_note = $2
       WHERE id = $3 RETURNING id, status, review_note, reviewed_at`,
      [req.user.userId, note, req.params.id]
    );

    if (request.requested_by_email) {
      const { error: mailErr } = await sendEmail({
        to: request.requested_by_email,
        subject: `Your add-admin request was declined`,
        text: `Hello ${request.requested_by_name || 'Administrator'},\n\nYour request to add ${request.new_admin_name || request.new_admin_email} (${request.new_admin_email}) as an admin of ${request.organization_name} was declined.${note ? `\n\nReason: ${note}` : ''}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Add-admin requester rejection email error:', mailErr);
    }

    res.status(200).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Reject add-admin request error:', err);
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

// Single-org lookup — the refresh/direct-link fallback for
// SuperadminOrgDetail: the normal path already has the org's name from the
// row that was clicked (passed via router state), so this only actually
// gets hit on a hard reload where that state is gone.
router.get('/api/superadmin/organizations/:id', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const orgRes = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [req.params.id]);
    if (orgRes.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    res.status(200).json({ organization: orgRes.rows[0] });
  } catch (err) {
    console.error('Superadmin get organization error:', err);
    res.status(500).json({ error: 'Failed to load organization' });
  }
});

// ============================================================================
// SUPERADMIN ORG DETAIL — the dedicated page (not a trip through the
// institution's own AdminDashboard) for a superadmin to see and directly
// manage one institution: its admins, structure, billing, and roster.
// Listing endpoints deliberately just reuse the existing admin-scoped GET
// routes (/api/admin/students, /api/admin/teachers, /api/admin/org-units,
// /api/admin/subjects, /api/admin/billing/status) via the X-Organization-Id
// header override — see applySuperadminOrgOverride — since those already
// return exactly the right shape and there's no reason to fork them. The
// three routes below are the genuinely new capabilities that don't exist
// anywhere else: terminating any single person's access to an org (not just
// students, which is all the admin-facing delete route ever supported),
// adding an admin immediately instead of through the request/approve queue,
// and overriding the billing plan directly, bypassing Razorpay entirely.
// ============================================================================

// Terminates one person's access to one org — any role, unlike DELETE
// /api/admin/students/:id which only ever handled students. Mirrors that
// route's own scoping discipline: only removes THIS org's membership and
// THIS org's data for them (a teacher's subject_teachers links here, a
// student's submissions to this org's problems), and only drops the global
// identity once it has zero memberships left anywhere.
router.delete('/api/superadmin/organizations/:orgId/members/:userId', authenticateToken, requireSuperadmin, async (req, res) => {
  const { orgId, userId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query(
      `SELECT u.id, u.email, m.role FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2
       WHERE u.id = $1`,
      [userId, orgId]
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This person is not a member of that organization' });
    }
    const { email, role } = target.rows[0];

    if (role === 'student') {
      await client.query(
        'DELETE FROM submissions WHERE user_id = $1 AND problem_id IN (SELECT id FROM problems WHERE organization_id = $2)',
        [userId, orgId]
      );
    } else if (role === 'teacher') {
      await client.query(
        'DELETE FROM subject_teachers WHERE user_id = $1 AND subject_id IN (SELECT id FROM subjects WHERE organization_id = $2)',
        [userId, orgId]
      );
    }
    await client.query('DELETE FROM memberships WHERE user_id = $1 AND organization_id = $2', [userId, orgId]);
    await client.query(
      'DELETE FROM users WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1)',
      [userId]
    );
    await client.query('COMMIT');
    logSecurityEvent(req, 'member_removed', { organizationId: orgId, detail: { targetUserId: userId, email, role } });
    res.status(200).json({ message: `${email} (${role}) was removed from this organization` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Superadmin terminate member error:', err);
    res.status(500).json({ error: 'Failed to remove this person' });
  } finally {
    client.release();
  }
});

// Adds (or promotes) an admin immediately — the superadmin is already
// looking at this org, so there's no reason to route through the
// request/approve queue an institution admin has to use (see
// addAdminToOrganization's own comment for the shared membership logic).
router.post('/api/superadmin/organizations/:orgId/admins', authenticateToken, requireSuperadmin, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = req.body.name != null ? String(req.body.name).trim() || null : null;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const client = await pool.connect();
  try {
    const orgRes = await client.query('SELECT name FROM organizations WHERE id = $1', [req.params.orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });

    await client.query('BEGIN');
    const addResult = await addAdminToOrganization(client, req.params.orgId, email, name);
    await client.query('COMMIT');
    logSecurityEvent(req, 'admin_granted', {
      organizationId: req.params.orgId,
      detail: { targetUserId: addResult.userId, email, via: 'direct' },
    });

    await sendAddAdminEmail({ email, name, organizationName: orgRes.rows[0].name, ...addResult });
    res.status(200).json({ userId: addResult.userId, isNew: addResult.isNew });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Superadmin add admin error:', err);
    res.status(500).json({ error: 'Failed to add admin' });
  } finally {
    client.release();
  }
});

// Directly sets an org's plan/status, bypassing Razorpay entirely — for
// comps, manual invoicing outside Razorpay, or correcting a stuck
// subscription. Clears any pending_* checkout-in-progress fields, same as
// promoteSubscriptionToActive does on a real payment, so a stale pending
// checkout can't later "complete" over top of a manual override.
router.post('/api/superadmin/organizations/:orgId/billing/override', authenticateToken, requireSuperadmin, async (req, res) => {
  const planKey = String(req.body.planKey || '');
  const status = String(req.body.status || '');
  const billingCycle = req.body.billingCycle || null;
  const currentPeriodEnd = req.body.currentPeriodEnd ? new Date(req.body.currentPeriodEnd) : null;

  if (!PLAN_CATALOG[planKey]) return res.status(400).json({ error: 'Invalid plan' });
  if (!['free', 'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (billingCycle && !BILLING_CYCLES.includes(billingCycle)) return res.status(400).json({ error: 'Invalid billing cycle' });

  try {
    await ensureSubscriptionsSchema();
    const result = await pool.query(
      `INSERT INTO subscriptions (organization_id, plan_key, status, billing_cycle, current_period_end)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id) DO UPDATE SET
         plan_key = $2, status = $3, billing_cycle = $4, current_period_end = $5,
         pending_plan_key = NULL, pending_billing_cycle = NULL, pending_razorpay_subscription_id = NULL,
         updated_at = now()
       RETURNING *`,
      [req.params.orgId, planKey, status, billingCycle, currentPeriodEnd]
    );
    logSecurityEvent(req, 'billing_overridden', { organizationId: req.params.orgId, detail: { planKey, status, billingCycle } });
    res.status(200).json({ subscription: result.rows[0] });
  } catch (err) {
    console.error('Superadmin billing override error:', err);
    res.status(500).json({ error: 'Failed to override billing' });
  }
});

// ============================================================================
// SECURITY EVENTS — read side of the in-app SIEM (see lib/securityEvents.js
// for the write side and schema/index.js's ensureSecurityEventsSchema for
// the table). Superadmin-only: this is a platform-wide audit trail across
// every organization, not a per-org admin feature. Filters are all
// optional and combine with AND; `eventTypes` is returned alongside the
// rows so the frontend's filter dropdown always lists every type that's
// ever actually been logged, not just whatever happens to be on the
// current filtered/paginated page.
// ============================================================================
router.get('/api/superadmin/security-events', authenticateToken, requireSuperadmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const conditions = [];
  const params = [];

  if (req.query.eventType) {
    params.push(req.query.eventType);
    conditions.push(`event_type = $${params.length}`);
  }
  if (req.query.organizationId) {
    params.push(Number(req.query.organizationId));
    conditions.push(`organization_id = $${params.length}`);
  }
  if (req.query.actorEmail) {
    params.push(`%${req.query.actorEmail}%`);
    conditions.push(`actor_email ILIKE $${params.length}`);
  }
  if (req.query.from) {
    params.push(new Date(req.query.from));
    conditions.push(`created_at >= $${params.length}`);
  }
  if (req.query.to) {
    params.push(new Date(req.query.to));
    conditions.push(`created_at <= $${params.length}`);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    params.push(limit);
    const result = await pool.query(
      `SELECT se.id, se.event_type, se.actor_user_id, se.actor_email, se.actor_role,
              se.organization_id, o.name AS organization_name, se.ip_address, se.user_agent,
              se.detail, se.created_at
       FROM security_events se
       LEFT JOIN organizations o ON o.id = se.organization_id
       ${whereClause}
       ORDER BY se.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    const eventTypesRes = await pool.query('SELECT DISTINCT event_type FROM security_events ORDER BY event_type');
    res.status(200).json({
      events: result.rows,
      eventTypes: eventTypesRes.rows.map((r) => r.event_type),
      limit,
    });
  } catch (err) {
    console.error('Superadmin list security events error:', err);
    res.status(500).json({ error: 'Failed to load security events' });
  }
});

// ============================================================================
// LOGIN MAP — feeds the superadmin dashboard's globe: where every person
// (and every institution as a whole) logs in from. "General" is that
// person's/institution's single most-frequent (country, city) across
// their own login_locations history (see that table's own comment in
// schema/index.js — bounded by the same 90-day retention as security_
// events, so this is "recent normal," not "all-time"); "last" is simply
// their most recent login. isAnomaly is true exactly when those two
// differ — the frontend only needs to actually SHOW the last-login pin
// instead of the general one when this is true (see this feature's own
// design conversation for why: showing "last" every single time would
// bury the one signal — an unusual location — under everyone's ordinary
// day-to-day noise).
// ============================================================================
router.get('/api/superadmin/login-map', authenticateToken, requireSuperadmin, async (req, res) => {
  try {
    const peopleRes = await pool.query(`
      WITH ranked_general AS (
        SELECT user_id, organization_id, role, country, country_code, city, lat, lon,
               COUNT(*) AS cnt,
               ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC, MAX(created_at) DESC) AS rn
        FROM login_locations
        WHERE lat IS NOT NULL
        GROUP BY user_id, organization_id, role, country, country_code, city, lat, lon
      ),
      general AS (
        SELECT * FROM ranked_general WHERE rn = 1
      ),
      ranked_last AS (
        SELECT ll.*, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
        FROM login_locations ll
        WHERE lat IS NOT NULL
      ),
      last_login AS (
        SELECT * FROM ranked_last WHERE rn = 1
      )
      SELECT
        u.id AS user_id, u.email, u.name,
        last_login.role, last_login.organization_id, o.name AS organization_name,
        general.country AS general_country, general.city AS general_city,
        general.lat AS general_lat, general.lon AS general_lon,
        last_login.country AS last_country, last_login.city AS last_city,
        last_login.lat AS last_lat, last_login.lon AS last_lon, last_login.created_at AS last_login_at
      FROM last_login
      JOIN users u ON u.id = last_login.user_id
      JOIN general ON general.user_id = last_login.user_id
      LEFT JOIN organizations o ON o.id = last_login.organization_id
    `);

    const people = peopleRes.rows.map((r) => {
      const generalLocation = { country: r.general_country, city: r.general_city, lat: r.general_lat, lon: r.general_lon };
      const lastLocation = { country: r.last_country, city: r.last_city, lat: r.last_lat, lon: r.last_lon };
      const isAnomaly = r.general_city !== r.last_city || r.general_country !== r.last_country;
      return {
        userId: r.user_id, email: r.email, name: r.name,
        role: r.role, organizationId: r.organization_id, organizationName: r.organization_name,
        generalLocation, lastLocation, isAnomaly,
        displayLocation: isAnomaly ? lastLocation : generalLocation,
        lastLoginAt: r.last_login_at,
      };
    });

    const orgRes = await pool.query(`
      WITH org_general AS (
        SELECT organization_id, country, city, lat, lon, COUNT(*) AS cnt,
               ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY COUNT(*) DESC) AS rn
        FROM login_locations
        WHERE lat IS NOT NULL AND organization_id IS NOT NULL
        GROUP BY organization_id, country, city, lat, lon
      ),
      org_last AS (
        SELECT DISTINCT ON (organization_id) organization_id, country, city, lat, lon, created_at
        FROM login_locations
        WHERE lat IS NOT NULL AND organization_id IS NOT NULL
        ORDER BY organization_id, created_at DESC
      )
      SELECT o.id AS organization_id, o.name AS organization_name,
             g.country AS general_country, g.city AS general_city, g.lat AS general_lat, g.lon AS general_lon,
             l.country AS last_country, l.city AS last_city, l.lat AS last_lat, l.lon AS last_lon, l.created_at AS last_login_at
      FROM organizations o
      JOIN org_general g ON g.organization_id = o.id AND g.rn = 1
      LEFT JOIN org_last l ON l.organization_id = o.id
    `);

    const institutions = orgRes.rows.map((r) => {
      const generalLocation = { country: r.general_country, city: r.general_city, lat: r.general_lat, lon: r.general_lon };
      const lastLocation = { country: r.last_country, city: r.last_city, lat: r.last_lat, lon: r.last_lon };
      const isAnomaly = r.last_city != null && (r.general_city !== r.last_city || r.general_country !== r.last_country);
      return {
        organizationId: r.organization_id, organizationName: r.organization_name,
        generalLocation, lastLocation, isAnomaly,
        displayLocation: isAnomaly ? lastLocation : generalLocation,
        lastLoginAt: r.last_login_at,
      };
    });

    res.status(200).json({ people, institutions });
  } catch (err) {
    console.error('Superadmin login-map error:', err);
    res.status(500).json({ error: 'Failed to load login map' });
  }
});

module.exports = router;
