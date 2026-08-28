// Authenticated-user self-service routes ("/api/me/*") — profile,
// org membership list, photos, ID cards, start-institution,
// profile-change-requests, own performance — split out of index.js
// as part of breaking that monolith into modules. Pure relocation.
// Mounted with no prefix in index.js — every path below is the exact
// full path it always was. Two /api/me/* routes (scan-context,
// scan-submission) are NOT here — they live with the rest of the
// scan/OCR pipeline in routes/scans.js instead, since they're tightly
// coupled to that pipeline's own helpers, not this domain's.
const express = require('express');
const router = express.Router();
const { pool } = require('../lib/db');
const { authenticateToken, applySuperadminOrgOverride } = require('../lib/auth');
const { avatarUpload } = require('../lib/uploads');
const { createOrganizationWithDefaults } = require('../lib/org');
const {
  getAssignmentPerformance, getExamPerformance, averagePercentWithExtra,
  getPercentileAndGradeTags, getStudentScopedAssignmentsAndExams,
} = require('../lib/performance');
const {
  isB2Configured, avatarObjectKey, uploadScanPdf, deleteScanPdf, getScanPdfUrl, downloadScanPdf,
} = require('../storage');
const { sendEmail } = require('../mailer');

// ============================================================================
// 3b. SESSION: Who am I? â€” lets the frontend recover role/identity on refresh
// ============================================================================
router.get('/api/me', authenticateToken, async (req, res) => {
  try {
    // A superadmin session carries no organizationId/membership at all —
    // skip the org join entirely rather than have it (correctly) find zero
    // rows and bounce them as if their session were invalid.
    if (req.user.role === 'superadmin') {
      const userRes = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.user.userId]);
      if (userRes.rows.length === 0) return res.status(401).json({ error: 'Session no longer valid' });
      return res.status(200).json({ user: { id: userRes.rows[0].id, email: userRes.rows[0].email, role: 'superadmin', name: userRes.rows[0].name } });
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.name, m.role, m.org_unit_id, o.name AS organization_name
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2
       JOIN organizations o ON o.id = m.organization_id
       WHERE u.id = $1`,
      [req.user.userId, req.user.organizationId]
    );
    if (result.rows.length === 0) {
      // Token is still valid but the membership behind it is gone (e.g.
      // admin removed them from this org, or the account itself is gone)
      return res.status(401).json({ error: 'Session no longer valid' });
    }
    res.status(200).json({ user: result.rows[0] });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Self-service display-name update — every OTHER path that sets
// users.name is someone ELSE naming this account (admin signup collects
// its own name; CSV import/create-student/create-teacher get it from the
// admin doing the importing). Superadmin is the one role with no such
// onboarding step at all — an allowlisted email can reach the platform
// with users.name still NULL and no admin-driven flow that would ever
// fill it in — so this is the one place that gap actually gets closed.
// Left open to any authenticated role rather than superadmin-only since
// there's nothing role-specific about "let me set my own display name."
router.put('/api/me', authenticateToken, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const result = await pool.query('UPDATE users SET name = $1 WHERE id = $2 RETURNING name', [name, req.user.userId]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Session no longer valid' });
    res.status(200).json({ name: result.rows[0].name });
  } catch (err) {
    console.error('Update own name error:', err);
    res.status(500).json({ error: 'Failed to update name' });
  }
});

// Every organization this user belongs to, with their role in each — the
// authenticated equivalent of the org-picker query POST /api/login already
// runs pre-auth for a multi-membership user (see the preAuthToken flow),
// reused here keyed on the verified session's own userId instead. Exists
// for the cross-institution student dashboard (GET /api/me/performance
// below): unlike every other /api/me/* route, this one deliberately does
// NOT scope by req.user.organizationId — the whole point is listing every
// org, not just the current session's one. Works for a superadmin session
// too (which has no organizationId of its own) since it just returns an
// empty list for them rather than erroring.
router.get('/api/me/organizations', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.organization_id, o.name AS organization_name, m.role, m.org_unit_id, m.roll_number
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1
       ORDER BY o.name ASC`,
      [req.user.userId]
    );
    res.status(200).json({ organizations: result.rows });
  } catch (err) {
    console.error('List my organizations error:', err);
    res.status(500).json({ error: 'Failed to load organizations' });
  }
});

// ---------------------------------------------------------------------------
// ID CARDS — profile photos + per-institution card data.
// ---------------------------------------------------------------------------

const MAX_USER_PHOTOS = 5;

// A user's own photo library (capped at MAX_USER_PHOTOS — see the count
// check in the POST route below) — reusable across every institution's ID
// card, not uploaded once per org.
router.get('/api/me/photos', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, storage_key, original_filename, created_at FROM user_photos WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.userId]
    );
    const photos = await Promise.all(result.rows.map(async (row) => ({
      id: row.id,
      originalFilename: row.original_filename,
      createdAt: row.created_at,
      url: await getScanPdfUrl(row.storage_key, 900),
    })));
    res.status(200).json({ photos });
  } catch (err) {
    console.error('List my photos error:', err);
    res.status(500).json({ error: 'Failed to load photos' });
  }
});

// Inserts a placeholder row first to get an id, THEN uploads under a key
// that embeds that id (avatarObjectKey needs photoId) — same "row before
// object key" ordering scanObjectKey's own callers use, unlike
// notesObjectKey which keys on a fresh random UUID instead because it has
// no such row-first step available (see storage.js's own comment on that).
router.post('/api/me/photos', authenticateToken, avatarUpload.single('photo'), async (req, res) => {
  if (!isB2Configured()) return res.status(503).json({ error: 'Photo storage is not configured yet' });
  if (!req.file) return res.status(400).json({ error: 'A photo is required' });
  try {
    const countRes = await pool.query('SELECT COUNT(*)::int AS count FROM user_photos WHERE user_id = $1', [req.user.userId]);
    if (countRes.rows[0].count >= MAX_USER_PHOTOS) {
      return res.status(400).json({ error: `You can only keep up to ${MAX_USER_PHOTOS} photos — delete one first` });
    }

    const insertRes = await pool.query(
      `INSERT INTO user_photos (user_id, storage_key, original_filename) VALUES ($1, '', $2) RETURNING id`,
      [req.user.userId, req.file.originalname || null]
    );
    const photoId = insertRes.rows[0].id;
    const ext = path.extname(req.file.originalname || '') || '.jpg';
    const storageKey = avatarObjectKey(req.user.userId, photoId, ext);
    await uploadScanPdf(storageKey, req.file.buffer, req.file.mimetype);
    await pool.query('UPDATE user_photos SET storage_key = $1 WHERE id = $2', [storageKey, photoId]);

    res.status(201).json({ id: photoId, url: await getScanPdfUrl(storageKey, 900) });
  } catch (err) {
    console.error('Upload photo error:', err);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

router.delete('/api/me/photos/:photoId', authenticateToken, async (req, res) => {
  const photoId = Number(req.params.photoId);
  if (!Number.isInteger(photoId)) return res.status(400).json({ error: 'Invalid photo id' });
  try {
    const ownRes = await pool.query('SELECT storage_key FROM user_photos WHERE id = $1 AND user_id = $2', [photoId, req.user.userId]);
    if (ownRes.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });

    await pool.query('DELETE FROM user_photos WHERE id = $1', [photoId]);
    if (isB2Configured()) {
      try {
        await deleteScanPdf(ownRes.rows[0].storage_key);
      } catch (err) {
        // The DB row is already gone — a dangling object in the bucket is a
        // storage-quota nit, not a correctness problem, so this isn't worth
        // failing the whole delete over.
        console.error('Failed to delete photo from storage (row already removed):', err);
      }
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Delete photo error:', err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// Picks which of the user's photos backs ONE institution's card — a
// per-membership choice, not global (see ensureMembershipActivePhotoColumn
// above). photoId: null clears it back to "no photo".
router.put('/api/me/organizations/:organizationId/photo', authenticateToken, async (req, res) => {
  const organizationId = Number(req.params.organizationId);
  const photoId = req.body.photoId === null || req.body.photoId === undefined ? null : Number(req.body.photoId);
  if (!Number.isInteger(organizationId)) return res.status(400).json({ error: 'Invalid organization id' });
  if (photoId !== null && !Number.isInteger(photoId)) return res.status(400).json({ error: 'Invalid photo id' });
  try {
    if (photoId !== null) {
      const photoRes = await pool.query('SELECT id FROM user_photos WHERE id = $1 AND user_id = $2', [photoId, req.user.userId]);
      if (photoRes.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
    }
    const result = await pool.query(
      'UPDATE memberships SET active_photo_id = $1 WHERE user_id = $2 AND organization_id = $3 RETURNING id',
      [photoId, req.user.userId, organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "You aren't a member of that institution" });
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Set membership photo error:', err);
    res.status(500).json({ error: 'Failed to update card photo' });
  }
});

// Lets an already-authenticated user (e.g. a teacher wanting to start
// their own private coaching institute) found a NEW org and become its
// admin, without going back through the logged-out signup form. Same
// access-code gate as POST /api/organizations/signup above (this doesn't
// loosen who's allowed to create an org — same platform-owner secret,
// same 403 message — it just moves the button inside the app), but skips
// that route's identity-creation and email-verification steps entirely
// since the caller is already a known, authenticated identity.
router.post('/api/me/start-institution', authenticateToken, async (req, res) => {
  const { organizationName, accessCode } = req.body;
  if (!organizationName || !String(organizationName).trim()) {
    return res.status(400).json({ error: 'Organization name is required' });
  }
  if (!process.env.PLATFORM_OWNER_SECRET || accessCode !== process.env.PLATFORM_OWNER_SECRET) {
    return res.status(403).json({ error: "Invalid or missing access code. If you don't have one, the highest authority at your institution must contact honorroll.admin@gmail.com to request one." });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const org = await createOrganizationWithDefaults(client, organizationName.trim());
    await client.query(
      `INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'admin')`,
      [req.user.userId, org.id]
    );
    await client.query('COMMIT');

    // Mints a session scoped to the new org right away — same shape as
    // POST /api/login/select-organization's own token — so the caller can
    // act as admin there immediately instead of needing a separate
    // re-login step just to pick up the new membership.
    const token = jwt.sign(
      { userId: req.user.userId, role: 'admin', organizationId: org.id, orgUnitId: null },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRATION || '24h' }
    );

    res.status(201).json({
      message: `"${org.name}" created — you're now its admin.`,
      token,
      organizationId: org.id,
      organizationName: org.name,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Start institution error:', err);
    res.status(500).json({ error: 'Failed to create organization' });
  } finally {
    client.release();
  }
});

// Everything needed to render one institution's ID card in one call — name/
// role/org details plus presigned URLs for the photo and org logo (both
// optional; a card just renders with blank slots for whichever is unset).
// Ownership check is against the membership row itself (user_id = caller),
// NOT the current session's organizationId — same posture as GET
// /api/me/organizations above: a multi-org user can view every card they
// hold without re-authenticating into each one first.
router.get('/api/me/id-card/:organizationId', authenticateToken, async (req, res) => {
  const organizationId = Number(req.params.organizationId);
  if (!Number.isInteger(organizationId)) return res.status(400).json({ error: 'Invalid organization id' });
  try {
    const result = await pool.query(
      `SELECT m.role, m.roll_number, m.created_at AS issued_at,
              o.name AS organization_name, o.logo_object_key,
              ou.name AS org_unit_name,
              u.name AS user_name, u.email,
              up.id AS photo_id, up.storage_key AS photo_storage_key
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
       JOIN users u ON u.id = m.user_id
       LEFT JOIN org_units ou ON ou.id = m.org_unit_id
       LEFT JOIN user_photos up ON up.id = m.active_photo_id
       WHERE m.user_id = $1 AND m.organization_id = $2`,
      [req.user.userId, organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "You aren't a member of that institution" });
    const row = result.rows[0];

    const [photoUrl, logoUrl] = await Promise.all([
      row.photo_storage_key ? getScanPdfUrl(row.photo_storage_key, 900).catch(() => null) : null,
      row.logo_object_key ? getScanPdfUrl(row.logo_object_key, 900).catch(() => null) : null,
    ]);

    res.status(200).json({
      name: row.user_name || row.email,
      email: row.email,
      role: row.role,
      organizationName: row.organization_name,
      orgUnitName: row.org_unit_name,
      cardId: row.roll_number || `HR-${String(req.user.userId).slice(0, 8).toUpperCase()}`,
      issuedAt: row.issued_at,
      photoId: row.photo_id,
      photoUrl,
      logoUrl,
    });
  } catch (err) {
    console.error('Get ID card error:', err);
    res.status(500).json({ error: 'Failed to load ID card' });
  }
});

// Streams the photo or logo bytes through our own origin instead of the
// presigned B2 URL the JSON route above returns — B2 sends no CORS headers
// on these objects (confirmed: a plain GET succeeds but carries no
// Access-Control-Allow-Origin), so a plain <img src> displays them fine,
// but html2canvas's "Download PNG" needs to read pixels back out of the
// canvas afterward, which the browser blocks for a cross-origin image with
// no CORS grant. Our own /api origin already sends the right header (see
// the cors() setup above), so IdCard.jsx's export path fetches through
// here instead, just for the moment it builds the PNG.
router.get('/api/me/id-card/:organizationId/:kind', authenticateToken, async (req, res) => {
  const organizationId = Number(req.params.organizationId);
  const kind = req.params.kind;
  if (!Number.isInteger(organizationId) || !['photo', 'logo'].includes(kind)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  try {
    let storageKey;
    if (kind === 'photo') {
      const result = await pool.query(
        `SELECT up.storage_key FROM memberships m
         JOIN user_photos up ON up.id = m.active_photo_id
         WHERE m.user_id = $1 AND m.organization_id = $2`,
        [req.user.userId, organizationId]
      );
      storageKey = result.rows[0]?.storage_key;
    } else {
      const result = await pool.query(
        `SELECT o.logo_object_key FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
         WHERE m.user_id = $1 AND m.organization_id = $2`,
        [req.user.userId, organizationId]
      );
      storageKey = result.rows[0]?.logo_object_key;
    }
    if (!storageKey) return res.status(404).json({ error: 'Not found' });

    const { buffer, contentType } = await downloadScanPdf(storageKey);
    res.setHeader('Content-Type', contentType || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(buffer);
  } catch (err) {
    console.error('Get ID card asset error:', err);
    res.status(500).json({ error: 'Failed to load image' });
  }
});

// A student's own request to correct their roster info.
// Routed to their institution's admin queue. Sends an email notification to the
// organization's admin(s).
// Student-only: a teacher/admin's own details are already directly
// editable by their institution's admin, so this route isn't for them.
router.post('/api/me/profile-change-requests', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Student access required' });
  }
  const field = String(req.body.field || '').trim();
  const requestedValue = String(req.body.requestedValue || '').trim();
  const currentValue = req.body.currentValue != null ? String(req.body.currentValue).trim() || null : null;
  const reason = req.body.reason != null ? String(req.body.reason).trim() || null : null;
  if (!field) return res.status(400).json({ error: 'field is required' });
  if (!requestedValue) return res.status(400).json({ error: 'requestedValue is required' });

  try {
    const result = await pool.query(
      `INSERT INTO profile_change_requests (organization_id, user_id, field, current_value, requested_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, field, current_value, requested_value, reason, status, created_at`,
      [req.user.organizationId, req.user.userId, field, currentValue, requestedValue, reason]
    );

    // Look up the institution admin(s) and student details to notify the admin(s)
    const [adminsRes, studentRes] = await Promise.all([
      pool.query(
        `SELECT u.email, u.name, o.name AS organization_name
         FROM users u
         JOIN memberships m ON m.user_id = u.id
         JOIN organizations o ON o.id = m.organization_id
         WHERE m.organization_id = $1 AND m.role = 'admin'`,
        [req.user.organizationId]
      ),
      pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]),
    ]);

    const studentName = studentRes.rows[0]?.name || 'Student';
    const studentEmail = studentRes.rows[0]?.email || '';
    const orgName = adminsRes.rows[0]?.organization_name || 'your institution';

    for (const admin of adminsRes.rows) {
      if (admin.email) {
        const { error: mailErr } = await sendEmail({
          to: admin.email,
          subject: `HonorRoll — Student Info Change Request (${studentName})`,
          text: `Hello ${admin.name || 'Admin'},\n\nA student in ${orgName} has submitted a request query regarding an info change:\n\nStudent: ${studentName} <${studentEmail}>\nField: ${field}\nCurrent Value: ${currentValue || '(none)'}\nRequested Value: ${requestedValue}\nReason: ${reason || '(none)'}\n\nPlease review this request in your Admin Dashboard under Students.\n\n— HonorRoll`,
        });
        if (mailErr) console.error(`Failed to notify admin ${admin.email} of profile change request:`, mailErr);
      }
    }

    res.status(201).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Create profile change request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// A student's own history of requests, across every institution they've
// filed one from — same "not scoped to req.user.organizationId" posture as
// GET /api/me/organizations, since the point is the student's whole
// history, not just the current session's org.
router.get('/api/me/profile-change-requests', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Student access required' });
  }
  try {
    const result = await pool.query(
      `SELECT r.id, r.organization_id, o.name AS organization_name, r.field, r.current_value, r.requested_value,
              r.reason, r.status, r.review_note, r.reviewed_at, r.created_at
       FROM profile_change_requests r
       JOIN organizations o ON o.id = r.organization_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.userId]
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('List my profile change requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// Cross-institution performance summary — every organization this user is a
// STUDENT in (a role they're a teacher/admin of elsewhere doesn't belong on
// a "my results" view), each with a rolled-up assignment/exam percent for
// just that org. Reuses getAssignmentPerformance/getExamPerformance (built
// for the teacher dashboard) with a single-student `studentIds` array —
// less efficient than a true bulk query, but a student is realistically in
// a handful of orgs at most, so the per-org round trip is cheap in practice.
router.get('/api/me/performance', authenticateToken, async (req, res) => {
  try {
    const membershipsRes = await pool.query(
      `SELECT m.organization_id, o.name AS organization_name, m.org_unit_id
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.role = 'student'
       ORDER BY o.name ASC`,
      [req.user.userId]
    );

    const organizations = await Promise.all(membershipsRes.rows.map(async (m) => {
      const { problems, exams } = await getStudentScopedAssignmentsAndExams(m.organization_id, m.org_unit_id);
      const [{ byUser: aByUser }, { byUser: eByUser }, legacyRes] = await Promise.all([
        getAssignmentPerformance(problems, [req.user.userId]),
        getExamPerformance(exams, [req.user.userId]),
        pool.query('SELECT assignment_score_percent, exam_score_percent FROM legacy_scores WHERE organization_id = $1 AND user_id = $2', [m.organization_id, req.user.userId]),
      ]);
      const aMap = aByUser.get(req.user.userId) || new Map();
      const eMap = eByUser.get(req.user.userId) || new Map();
      const legacyAssignment = legacyRes.rows.map((r) => r.assignment_score_percent).filter((v) => v != null);
      const legacyExam = legacyRes.rows.map((r) => r.exam_score_percent).filter((v) => v != null);
      const avgAssignmentPercent = averagePercentWithExtra(aMap, legacyAssignment);
      const avgExamPercent = averagePercentWithExtra(eMap, legacyExam);
      const tags = await getPercentileAndGradeTags(m.organization_id, avgAssignmentPercent, avgExamPercent);
      return {
        organizationId: m.organization_id,
        organizationName: m.organization_name,
        assignmentsTotal: problems.length,
        assignmentsSubmitted: aMap.size,
        avgAssignmentPercent,
        examsTotal: exams.length,
        examsAttempted: eMap.size,
        avgExamPercent,
        ...tags,
      };
    }));

    res.status(200).json({ organizations });
  } catch (err) {
    console.error('My performance error:', err);
    res.status(500).json({ error: 'Failed to load performance' });
  }
});

// One organization's full breakdown for the caller's own student
// membership there — 404s if they aren't actually a student in that org
// (rather than leaking whether the org id even exists).
router.get('/api/me/performance/:organizationId', authenticateToken, async (req, res) => {
  try {
    const organizationId = Number(req.params.organizationId);
    const membershipRes = await pool.query(
      `SELECT m.org_unit_id, o.name AS organization_name
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.organization_id = $2 AND m.role = 'student'`,
      [req.user.userId, organizationId]
    );
    if (membershipRes.rows.length === 0) return res.status(404).json({ error: 'Not enrolled in this organization' });
    const { org_unit_id: orgUnitId, organization_name: organizationName } = membershipRes.rows[0];

    const { problems, exams } = await getStudentScopedAssignmentsAndExams(organizationId, orgUnitId);
    const [{ byUser: aByUser }, { byUser: eByUser }, legacyRes] = await Promise.all([
      getAssignmentPerformance(problems, [req.user.userId]),
      getExamPerformance(exams, [req.user.userId]),
      pool.query(
        'SELECT academic_year, assignment_score_percent, exam_score_percent, notes FROM legacy_scores WHERE organization_id = $1 AND user_id = $2 ORDER BY academic_year DESC',
        [organizationId, req.user.userId]
      ),
    ]);
    const aMap = aByUser.get(req.user.userId) || new Map();
    const eMap = eByUser.get(req.user.userId) || new Map();

    // Per-item percentile for the "Overall" graphs' percentile-trend view on
    // MyPerformance (see POST /api/problems/:id/result for the single-item
    // version this mirrors) — one query per type covering every
    // problem/exam at once, grouped in JS, rather than N population
    // queries for N items.
    const visibility = await getTagVisibility(organizationId);
    const percentileByProblem = new Map();
    const percentileByExam = new Map();
    if (visibility.show_percentile_tag) {
      const codeProblemIds = problems.filter((p) => p.submission_mode === 'code').map((p) => p.id);
      const scanProblemIds = problems.filter((p) => p.submission_mode === 'scan').map((p) => p.id);
      const byProblem = new Map();
      if (codeProblemIds.length > 0) {
        const bestRes = await pool.query(
          `SELECT DISTINCT ON (user_id, problem_id) user_id, problem_id, passed_count, total_count
           FROM submissions WHERE problem_id = ANY($1::int[])
           ORDER BY user_id, problem_id, (status = 'Accepted') DESC, passed_count DESC, created_at DESC`,
          [codeProblemIds]
        );
        for (const r of bestRes.rows) {
          if (r.total_count <= 0) continue;
          if (!byProblem.has(r.problem_id)) byProblem.set(r.problem_id, []);
          byProblem.get(r.problem_id).push({ userId: r.user_id, pct: (r.passed_count / r.total_count) * 100 });
        }
      }
      if (scanProblemIds.length > 0) {
        // Mirrors getAssignmentPerformance's own scan-mode branch — a scan
        // submission's percent comes from summed question marks, not a
        // passed/total test-case count.
        const scanRes = await pool.query(
          `SELECT ss.user_id, ss.problem_id, SUM(q.marks) AS max_marks, SUM(sa.marks_awarded) AS awarded,
                  BOOL_AND(sa.marks_awarded IS NOT NULL) AS fully_graded
           FROM scan_submissions ss
           JOIN scan_assignment_questions q ON q.problem_id = ss.problem_id
           LEFT JOIN scan_submission_answers sa ON sa.submission_id = ss.id AND sa.question_id = q.id
           WHERE ss.problem_id = ANY($1::int[])
           GROUP BY ss.user_id, ss.problem_id`,
          [scanProblemIds]
        );
        for (const r of scanRes.rows) {
          if (!r.fully_graded || !(Number(r.max_marks) > 0)) continue;
          if (!byProblem.has(r.problem_id)) byProblem.set(r.problem_id, []);
          byProblem.get(r.problem_id).push({ userId: r.user_id, pct: (Number(r.awarded) / Number(r.max_marks)) * 100 });
        }
      }
      for (const [problemId, rows] of byProblem) {
        const mine = rows.find((r) => r.userId === req.user.userId);
        if (!mine) continue;
        const tierFor = computePercentileTiers(rows.map((r) => r.pct));
        percentileByProblem.set(problemId, tierFor(mine.pct).percentile);
      }
      if (exams.length > 0) {
        const examIds = exams.map((e) => e.id);
        const attemptsRes = await pool.query(
          `SELECT a.exam_id, a.user_id, a.score, e.total_marks,
                  NOT EXISTS (
                    SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
                    WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
                  ) AND NOT EXISTS (
                    SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = a.id AND esa.marks_awarded IS NULL
                  ) AS fully_graded
           FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
           WHERE a.exam_id = ANY($1::int[]) AND a.status = 'submitted' AND e.total_marks > 0`,
          [examIds]
        );
        const byExam = new Map();
        for (const r of attemptsRes.rows) {
          if (!r.fully_graded) continue;
          if (!byExam.has(r.exam_id)) byExam.set(r.exam_id, []);
          byExam.get(r.exam_id).push({ userId: r.user_id, pct: (r.score / r.total_marks) * 100 });
        }
        for (const [examId, rows] of byExam) {
          const mine = rows.find((r) => r.userId === req.user.userId);
          if (!mine) continue;
          const tierFor = computePercentileTiers(rows.map((r) => r.pct));
          percentileByExam.set(examId, tierFor(mine.pct).percentile);
        }
      }
    }

    const [problemMetaRes, examMetaRes, scanRemarksRes, examRemarksRes] = await Promise.all([
      problems.length
        ? pool.query(
            `SELECT p.id, p.title, s.name AS subject_name FROM problems p
             LEFT JOIN subjects s ON s.id = p.subject_id WHERE p.id = ANY($1::int[])`,
            [problems.map((p) => p.id)]
          )
        : { rows: [] },
      exams.length
        ? pool.query(
            `SELECT e.id, e.title, s.name AS subject_name FROM exams e
             LEFT JOIN subjects s ON s.id = e.subject_id WHERE e.id = ANY($1::int[])`,
            [exams.map((e) => e.id)]
          )
        : { rows: [] },
      problems.length
        ? pool.query('SELECT problem_id, overall_remarks FROM scan_submissions WHERE user_id = $1 AND problem_id = ANY($2::int[])', [req.user.userId, problems.map((p) => p.id)])
        : { rows: [] },
      exams.length
        ? pool.query('SELECT exam_id, overall_remarks FROM exam_attempts WHERE user_id = $1 AND exam_id = ANY($2::int[])', [req.user.userId, exams.map((e) => e.id)])
        : { rows: [] },
    ]);
    const problemMetaById = new Map(problemMetaRes.rows.map((r) => [r.id, r]));
    const examMetaById = new Map(examMetaRes.rows.map((r) => [r.id, r]));
    const scanRemarksByProblem = new Map(scanRemarksRes.rows.map((r) => [r.problem_id, r.overall_remarks]));
    const examRemarksByExam = new Map(examRemarksRes.rows.map((r) => [r.exam_id, r.overall_remarks]));

    const assignments = problems.map((p) => {
      const meta = problemMetaById.get(p.id);
      const entry = aMap.get(p.id);
      return {
        problemId: p.id,
        title: meta?.title,
        subjectName: meta?.subject_name,
        status: entry?.status || 'not_submitted',
        percent: entry?.pct ?? null,
        percentile: percentileByProblem.has(p.id) ? percentileByProblem.get(p.id) : null,
        remarks: scanRemarksByProblem.get(p.id) || null,
      };
    });

    const examsOut = exams.map((e) => {
      const meta = examMetaById.get(e.id);
      const entry = eMap.get(e.id);
      return {
        examId: e.id,
        title: meta?.title,
        subjectName: meta?.subject_name,
        status: entry?.status || 'not_attempted',
        percent: entry?.pct ?? null,
        percentile: percentileByExam.has(e.id) ? percentileByExam.get(e.id) : null,
        remarks: examRemarksByExam.get(e.id) || null,
      };
    });

    const legacyAssignment = legacyRes.rows.map((r) => r.assignment_score_percent).filter((v) => v != null);
    const legacyExam = legacyRes.rows.map((r) => r.exam_score_percent).filter((v) => v != null);
    const avgAssignmentPercent = averagePercentWithExtra(aMap, legacyAssignment);
    const avgExamPercent = averagePercentWithExtra(eMap, legacyExam);
    const tags = await getPercentileAndGradeTags(organizationId, avgAssignmentPercent, avgExamPercent);

    res.status(200).json({
      organizationId,
      organizationName,
      assignments,
      exams: examsOut,
      historicalScores: legacyRes.rows.map((r) => ({
        academicYear: r.academic_year,
        assignmentScorePercent: r.assignment_score_percent,
        examScorePercent: r.exam_score_percent,
        notes: r.notes,
      })),
      avgAssignmentPercent,
      avgExamPercent,
      ...tags,
    });
  } catch (err) {
    console.error('My performance detail error:', err);
    res.status(500).json({ error: 'Failed to load performance' });
  }
});

module.exports = router;
