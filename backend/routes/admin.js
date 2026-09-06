// The admin dashboard catch-all — structure (create-student/teacher,
// teacher CRUD, org-levels/units, subjects, students, CSV import),
// grading (gradebook, leaderboard, teacher-scoped students, legacy-
// scores), profile-change-requests, admin/superadmin requests,
// add-admin-requests, grade-bands, tag-visibility, org logo. Split
// out of index.js as part of breaking that monolith into modules.
// Pure relocation. Mounted with no prefix in index.js — every path
// below is the exact full path it always was.
const express = require('express');
const router = express.Router();
const { parse: parseCsv } = require('csv-parse/sync');
const { pool } = require('../lib/db');
const {
  authenticateToken, requireAdmin, requireAdminOrTeacher, getSuperadminEmails, enforceSubjectAuthority,
} = require('../lib/auth');
const {
  getOrgUnitLookup, resolveOrgUnitPath, getTeacherScope, getTeacherScopedStudents,
  getAssignmentPerformance, getExamPerformance, averagePercent, getSubjectScopedAssignmentsAndExams,
  getStudentsForSubject, getTotalScores, getVisibleSubjectIds, computePercentileTiers, getTagVisibility,
} = require('../lib/performance');
const { checkStudentCap } = require('../lib/billing');
const { findOrCreateGlobalUser, sendStudentWelcomeEmail } = require('../lib/misc');
const { logSecurityEvent } = require('../lib/securityEvents');
const { isB2Configured, orgLogoObjectKey, uploadScanPdf, getScanPdfUrl } = require('../storage');
const { avatarUpload, csvUpload } = require('../lib/uploads');
const { sendEmail } = require('../mailer');
const { cached, invalidate } = require('../cache');


// Bootstraps (or validates) an org's tier shape directly from a roster
// file/form's own column headers — no separate "build your structure
// first" step. tierLabels is the ordered list of non-name/email column
// headers (left to right = top tier to bottom tier), exactly matching the
// shape the user described: "Campus -> Department -> Year -> credentials".
//
// First use for an org with zero org_level_defs: creates them from
// tierLabels, in order. Every later call just needs the same COLUMN COUNT
// — the org's own tier labels win from then on (a slightly reworded header
// shouldn't fracture the tree), so this only ever compares lengths, never
// label text, once levels already exist.
async function ensureLevelsForTierLabels(organizationId, tierLabels) {
  const existing = await pool.query(
    'SELECT id, tier_index, label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC',
    [organizationId]
  );
  if (existing.rows.length > 0) {
    if (existing.rows.length !== tierLabels.length) {
      const have = existing.rows.map((l) => l.label).join(', ');
      return { error: true, reason: `Your organization structure has ${existing.rows.length} tier(s) (${have}) but this file has ${tierLabels.length} — the columns before Name/Email must match in count` };
    }
    return { levels: existing.rows };
  }
  if (tierLabels.length === 0) return { levels: [] };

  const inserted = [];
  for (let i = 0; i < tierLabels.length; i++) {
    const r = await pool.query(
      'INSERT INTO org_level_defs (organization_id, tier_index, label) VALUES ($1, $2, $3) RETURNING id, tier_index, label',
      [organizationId, i, tierLabels[i]]
    );
    inserted.push(r.rows[0]);
  }
  return { levels: inserted };
}

// Walks tierValues (same order as `levels`) root-to-leaf, finding or
// CREATING each org_unit along the way — a roster upload is now the
// primary way an org's tree gets populated at all, not just a consumer of
// one built by hand first. Case-insensitive, trimmed match against an
// existing unit's name before creating a new one, so re-uploading the same
// roster (or a form filled out by many students in the same class) doesn't
// fragment into duplicates over a stray space or capitalization.
async function resolveOrCreateOrgUnit(organizationId, levels, tierValues) {
  let parentUnitId = null;
  let resolvedUnitId = null;
  const created = [];
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const value = String(tierValues[i] ?? '').trim();
    if (!value) return { error: true, reason: `Missing value for "${level.label}"` };

    const existing = parentUnitId === null
      ? await pool.query(
          'SELECT id FROM org_units WHERE organization_id = $1 AND level_def_id = $2 AND name ILIKE $3 AND parent_unit_id IS NULL',
          [organizationId, level.id, value]
        )
      : await pool.query(
          'SELECT id FROM org_units WHERE organization_id = $1 AND level_def_id = $2 AND name ILIKE $3 AND parent_unit_id = $4',
          [organizationId, level.id, value, parentUnitId]
        );

    if (existing.rows.length > 0) {
      resolvedUnitId = existing.rows[0].id;
    } else {
      const inserted = await pool.query(
        'INSERT INTO org_units (organization_id, level_def_id, parent_unit_id, name) VALUES ($1, $2, $3, $4) RETURNING id',
        [organizationId, level.id, parentUnitId, value]
      );
      resolvedUnitId = inserted.rows[0].id;
      created.push(`${level.label}: ${value}`);
    }
    parentUnitId = resolvedUnitId;
  }
  return { orgUnitId: resolvedUnitId, created };
}

// Given a header row (or, for the webhook, the POSTed field names), splits
// out which columns are Name/Email/Roll and returns the rest in their
// original left-to-right order — that order IS the tier chain, top to
// bottom. Roll is optional (most rosters won't have it) — a header without
// it just leaves rollKey null and every caller already treats a missing
// identity column as "nothing to write," same as Name always has.
function splitTierAndIdentityColumns(headerKeys) {
  let nameKey = null;
  let emailKey = null;
  let rollKey = null;
  const tierKeys = [];
  for (const key of headerKeys) {
    const normalized = key.trim().toLowerCase();
    if (normalized === 'name' && nameKey === null) nameKey = key;
    else if (normalized === 'email' && emailKey === null) emailKey = key;
    else if ((normalized === 'roll' || normalized === 'roll number' || normalized === 'roll no') && rollKey === null) rollKey = key;
    else tierKeys.push(key);
  }
  return { nameKey, emailKey, rollKey, tierKeys };
}


// ============================================================================
// 1. ADMIN ENDPOINT: Create a single student manually
// ============================================================================
router.post('/api/admin/create-student', authenticateToken, requireAdmin, async (req, res) => {
  const { email, name } = req.body;
  const orgUnitId = req.body.orgUnitId != null ? Number(req.body.orgUnitId) : null;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const client = await pool.connect();
  try {
    const orgRes = await client.query('SELECT status, name FROM organizations WHERE id = $1', [req.user.organizationId]);
    if (orgRes.rows[0]?.status !== 'approved') {
      return res.status(403).json({ error: 'Your organization is still pending approval — you cannot add students yet' });
    }

    const cap = await checkStudentCap(req.user.organizationId, 1);
    if (!cap.ok) {
      return res.status(403).json({
        error: `Your ${cap.planLabel} plan (${cap.cap} students) is full — remove a student or upgrade your plan to add more.`,
        planKey: cap.planKey, cap: cap.cap, current: cap.current,
      });
    }

    if (orgUnitId !== null) {
      const unitCheck = await client.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
      if (unitCheck.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    }

    await client.query('BEGIN');

    const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);

    const memberRes = await client.query(
      `INSERT INTO memberships (user_id, organization_id, role, org_unit_id) VALUES ($1, $2, 'student', $3)
       ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
      [userId, req.user.organizationId, orgUnitId]
    );
    if (memberRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This email is already a member of your organization' });
    }

    await client.query('COMMIT');

    // Best-effort, after the transaction is already committed — an email
    // hiccup here shouldn't turn an otherwise-successful account creation
    // into a 500 (matches the CSV import / Google Form webhook posture).
    if (isNew) {
      await sendStudentWelcomeEmail(email, name, orgRes.rows[0].name, temporaryPassword);
    }

    logSecurityEvent(req, 'student_created', { detail: { studentUserId: userId, email, isNewAccount: isNew } });
    const student = { id: userId, email, name: name || null, role: 'student' };
    if (isNew) {
      res.status(201).json({ message: 'Student account created successfully — credentials emailed to them', student, temporaryPassword });
    } else {
      res.status(201).json({
        message: 'This email already had a HonorRoll account elsewhere — added to your organization. They sign in with their existing password.',
        student,
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Admin create-student error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Mirrors create-student above — same global-identity find-or-create logic,
// just a different membership role. A teacher's actual authority (which
// subjects they can touch) comes from subject_teachers, assigned
// separately via POST /api/admin/subjects/:id/teachers below; orgUnitId
// here is optional and purely informational (org-chart placement), not an
// authority boundary for teachers.
router.post('/api/admin/create-teacher', authenticateToken, requireAdmin, async (req, res) => {
  const { email, name } = req.body;
  const orgUnitId = req.body.orgUnitId != null ? Number(req.body.orgUnitId) : null;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const client = await pool.connect();
  try {
    const orgRes = await client.query('SELECT status FROM organizations WHERE id = $1', [req.user.organizationId]);
    if (orgRes.rows[0]?.status !== 'approved') {
      return res.status(403).json({ error: 'Your organization is still pending approval — you cannot add teachers yet' });
    }

    if (orgUnitId !== null) {
      const unitCheck = await client.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
      if (unitCheck.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    }

    await client.query('BEGIN');

    const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);

    const memberRes = await client.query(
      `INSERT INTO memberships (user_id, organization_id, role, org_unit_id) VALUES ($1, $2, 'teacher', $3)
       ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
      [userId, req.user.organizationId, orgUnitId]
    );
    if (memberRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This email is already a member of your organization' });
    }

    await client.query('COMMIT');

    logSecurityEvent(req, 'teacher_created', { detail: { teacherUserId: userId, email, isNewAccount: isNew } });
    const teacher = { id: userId, email, name: name || null, role: 'teacher' };
    if (isNew) {
      res.status(201).json({ message: 'Teacher account created successfully', teacher, temporaryPassword });
    } else {
      res.status(201).json({
        message: 'This email already had a HonorRoll account elsewhere — added to your organization. They sign in with their existing password.',
        teacher,
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Admin create-teacher error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.get('/api/admin/teachers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, m.org_unit_id
       FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE m.organization_id = $1 AND m.role = 'teacher'
       ORDER BY u.email ASC`,
      [req.user.organizationId]
    );
    res.status(200).json({ teachers: result.rows });
  } catch (err) {
    console.error('List teachers error:', err);
    res.status(500).json({ error: 'Failed to load teachers' });
  }
});

// Mirrors PUT /api/admin/students/:id — name and org_unit_id only, no
// roll_number (student-only) and no email (same reasoning as the student
// route's own comment: users.email is the global-identity key shared
// across every organization that email belongs to, so it's never editable
// from inside one org's roster view). A teacher's own org_unit_id also
// newly matters beyond being informational: POST /api/admin/subjects/:id/
// teachers now only allows assigning a teacher whose org_unit_id matches
// the subject's own unit, so this is how an admin corrects a teacher's
// unit after the fact if it was left unset or wrong at creation time.
router.put('/api/admin/teachers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const teacherId = req.params.id;
  const name = req.body.name !== undefined ? (String(req.body.name || '').trim() || null) : undefined;
  const orgUnitId = req.body.orgUnitId !== undefined
    ? (req.body.orgUnitId === null || req.body.orgUnitId === '' ? null : Number(req.body.orgUnitId))
    : undefined;

  try {
    // Scoped to role='teacher' on purpose, same reasoning as the student
    // route — never lets this touch an admin/student account even if a
    // stale/tampered id is passed in. 404, not 403, on a miss so this can't
    // be used to probe which ids exist in another organization.
    const membershipRes = await pool.query(
      `SELECT m.id FROM memberships m WHERE m.user_id = $1 AND m.organization_id = $2 AND m.role = 'teacher'`,
      [teacherId, req.user.organizationId]
    );
    if (membershipRes.rows.length === 0) return res.status(404).json({ error: 'Teacher not found' });

    if (orgUnitId !== undefined && orgUnitId !== null) {
      const unitCheck = await pool.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
      if (unitCheck.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    }

    if (name !== undefined) {
      await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name, teacherId]);
    }
    if (orgUnitId !== undefined) {
      // Same "explicitly sent null clears it" vs "not sent at all leaves it
      // alone" distinction as the student route — orgUnitId is the only
      // field here that can be legitimately cleared back to null.
      await pool.query('UPDATE memberships SET org_unit_id = $1 WHERE user_id = $2 AND organization_id = $3', [orgUnitId, teacherId, req.user.organizationId]);
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.name, m.org_unit_id FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE u.id = $1 AND m.organization_id = $2`,
      [teacherId, req.user.organizationId]
    );
    logSecurityEvent(req, 'teacher_updated', { detail: { teacherUserId: teacherId, fields: { name: name !== undefined, orgUnitId: orgUnitId !== undefined } } });
    res.status(200).json({ teacher: result.rows[0] });
  } catch (err) {
    console.error('Update teacher error:', err);
    res.status(500).json({ error: 'Failed to update teacher' });
  }
});

// Teacher counterpart to the student CSV template/import pair below —
// same header-defines-structure contract (any column besides Name/Email is
// a tier, left to right), reusing splitTierAndIdentityColumns/
// ensureLevelsForTierLabels/resolveOrCreateOrgUnit exactly as-is. No
// student-cap check here — teacher seats aren't billed.
router.get('/api/admin/teachers/csv-template', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const levels = await pool.query(
      'SELECT label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC',
      [req.user.organizationId]
    );
    const headers = levels.rows.length > 0
      ? [...levels.rows.map((l) => l.label), 'Name', 'Email']
      : ['Campus', 'Department', 'Name', 'Email'];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="teacher-import-template.csv"');
    res.status(200).send(`${headers.join(',')}\n`);
  } catch (err) {
    console.error('Teacher CSV template error:', err);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

router.post('/api/admin/teachers/csv-import', authenticateToken, requireAdmin, csvUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });

  const orgRes = await pool.query('SELECT status FROM organizations WHERE id = $1', [req.user.organizationId]);
  if (orgRes.rows[0]?.status !== 'approved') {
    return res.status(403).json({ error: 'Your organization is still pending approval — you cannot import teachers yet' });
  }

  let rows;
  try {
    rows = parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not parse CSV file — check it is valid CSV with a header row' });
  }
  if (rows.length === 0) {
    return res.status(400).json({ error: 'CSV has no data rows' });
  }

  const { emailKey, nameKey, rollKey, tierKeys } = splitTierAndIdentityColumns(Object.keys(rows[0]));
  if (!emailKey) {
    return res.status(400).json({ error: 'CSV must have an Email column' });
  }

  const levelsResult = await ensureLevelsForTierLabels(req.user.organizationId, tierKeys);
  if (levelsResult.error) {
    return res.status(400).json({ error: levelsResult.reason });
  }
  const levels = levelsResult.levels;

  // Unlike student import, temp passwords are returned in the response
  // rather than emailed — matching the single create-teacher route, which
  // has never sent a welcome email and instead relies on the admin relaying
  // the password shown on screen.
  const results = { created: 0, existingAdded: 0, skipped: 0, unitsCreated: [], newAccounts: [], errors: [] };
  const seenCreatedUnits = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const email = String(row[emailKey] || '').trim();
    const name = nameKey ? String(row[nameKey] || '').trim() : '';
    const rollNumber = rollKey ? String(row[rollKey] || '').trim() || null : null;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.errors.push({ row: rowNum, email, reason: email ? 'Malformed email' : 'Missing email' });
      continue;
    }

    let orgUnitId = null;
    if (levels.length > 0) {
      const resolution = await resolveOrCreateOrgUnit(req.user.organizationId, levels, tierKeys.map((k) => row[k]));
      if (resolution.error) {
        results.errors.push({ row: rowNum, email, reason: resolution.reason });
        continue;
      }
      orgUnitId = resolution.orgUnitId;
      resolution.created.forEach((c) => seenCreatedUnits.add(c));
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);
      const memberRes = await client.query(
        `INSERT INTO memberships (user_id, organization_id, role, org_unit_id, roll_number) VALUES ($1, $2, 'teacher', $3, $4)
         ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
        [userId, req.user.organizationId, orgUnitId, rollNumber]
      );
      await client.query('COMMIT');

      if (memberRes.rows.length === 0) {
        results.skipped++;
      } else if (isNew) {
        results.created++;
        results.newAccounts.push({ email, name, temporaryPassword });
      } else {
        results.existingAdded++;
      }
    } catch (err) {
      await client.query('ROLLBACK');
      results.errors.push({ row: rowNum, email, reason: 'Database error creating this row' });
    } finally {
      client.release();
    }
  }

  results.unitsCreated = [...seenCreatedUnits];
  logSecurityEvent(req, 'teacher_bulk_import', { detail: { created: results.created, existingAdded: results.existingAdded, errors: results.errors.length } });
  res.status(200).json(results);
});

// ============================================================================
// CSV BULK IMPORT — the manual/roster-file counterpart to the Google Form
// webhook, and the first bulk-provisioning path built (Google Form gets
// upgraded to reuse the same resolution logic right below this section).
// ============================================================================

// Generates a template header row. If the org already has tiers (from an
// earlier upload, or the manual structure builder), it's exactly those
// labels, in order, plus Name/Email — built live from org_level_defs, no
// storage needed. If the org has no structure yet, this is just an
// illustrative starting example — the columns you actually upload with are
// what defines the tiers, nothing needs to be pre-built first.
router.get('/api/admin/students/csv-template', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const levels = await pool.query(
      'SELECT label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC',
      [req.user.organizationId]
    );
    const headers = levels.rows.length > 0
      ? [...levels.rows.map((l) => l.label), 'Name', 'Email']
      : ['Campus', 'Department', 'Year', 'Name', 'Email'];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="student-import-template.csv"');
    res.status(200).send(`${headers.join(',')}\n`);
  } catch (err) {
    console.error('CSV template error:', err);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

router.post('/api/admin/students/csv-import', authenticateToken, requireAdmin, csvUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });

  const orgRes = await pool.query('SELECT status, name FROM organizations WHERE id = $1', [req.user.organizationId]);
  if (orgRes.rows[0]?.status !== 'approved') {
    return res.status(403).json({ error: 'Your organization is still pending approval — you cannot import students yet' });
  }

  let rows;
  try {
    rows = parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not parse CSV file — check it is valid CSV with a header row' });
  }
  if (rows.length === 0) {
    return res.status(400).json({ error: 'CSV has no data rows' });
  }

  // The header row itself defines the structure — every column that isn't
  // Name/Email, left to right, is one tier (Campus -> Department -> Year,
  // exactly the shape described when this was designed: no separate
  // "build your structure first" step required before a roster can be
  // uploaded at all).
  const { emailKey, nameKey, rollKey, tierKeys } = splitTierAndIdentityColumns(Object.keys(rows[0]));
  if (!emailKey) {
    return res.status(400).json({ error: 'CSV must have an Email column' });
  }

  const levelsResult = await ensureLevelsForTierLabels(req.user.organizationId, tierKeys);
  if (levelsResult.error) {
    return res.status(400).json({ error: levelsResult.reason });
  }
  const levels = levelsResult.levels;

  // Checked once before the loop, not per-row — the cap doesn't change
  // mid-file. `consumed` tracks headroom used so far; only rows that
  // actually add a NEW member to this org (created or existingAdded) count
  // against it — a row that turns out to already be a member of this org
  // (`skipped`) doesn't consume any of the org's remaining headroom.
  const capBefore = await checkStudentCap(req.user.organizationId, 0);
  let consumed = 0;

  const results = { created: 0, existingAdded: 0, skipped: 0, unitsCreated: [], errors: [] };
  const newAccounts = []; // { email, name, temporaryPassword } — emailed after the loop
  const seenCreatedUnits = new Set();

  // One transaction per ROW, not one for the whole file — a bad row further
  // down shouldn't roll back rows already successfully committed above it.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // +1 for 0-index, +1 for the header row itself
    const email = String(row[emailKey] || '').trim();
    const name = nameKey ? String(row[nameKey] || '').trim() : '';
    const rollNumber = rollKey ? String(row[rollKey] || '').trim() || null : null;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.errors.push({ row: rowNum, email, reason: email ? 'Malformed email' : 'Missing email' });
      continue;
    }

    if (consumed >= capBefore.remaining) {
      results.errors.push({ row: rowNum, email, reason: `Plan cap reached — ${capBefore.planLabel} plan is full (${capBefore.cap} students), row not processed` });
      continue;
    }

    let orgUnitId = null;
    if (levels.length > 0) {
      const resolution = await resolveOrCreateOrgUnit(req.user.organizationId, levels, tierKeys.map((k) => row[k]));
      if (resolution.error) {
        results.errors.push({ row: rowNum, email, reason: resolution.reason });
        continue;
      }
      orgUnitId = resolution.orgUnitId;
      resolution.created.forEach((c) => seenCreatedUnits.add(c));
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);
      const memberRes = await client.query(
        `INSERT INTO memberships (user_id, organization_id, role, org_unit_id, roll_number) VALUES ($1, $2, 'student', $3, $4)
         ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
        [userId, req.user.organizationId, orgUnitId, rollNumber]
      );
      await client.query('COMMIT');

      if (memberRes.rows.length === 0) {
        results.skipped++;
      } else if (isNew) {
        results.created++;
        consumed++;
        newAccounts.push({ email, name, temporaryPassword });
      } else {
        results.existingAdded++;
        consumed++;
      }
    } catch (err) {
      await client.query('ROLLBACK');
      results.errors.push({ row: rowNum, email, reason: 'Database error creating this row' });
    } finally {
      client.release();
    }
  }

  // Best-effort, after everything's committed — one bad Resend send
  // shouldn't stop the rest of the batch from going out.
  await Promise.allSettled(newAccounts.map((a) => sendStudentWelcomeEmail(a.email, a.name, orgRes.rows[0].name, a.temporaryPassword)));

  results.unitsCreated = [...seenCreatedUnits];
  logSecurityEvent(req, 'student_bulk_import', { detail: { created: results.created, existingAdded: results.existingAdded, errors: results.errors.length } });
  res.status(200).json(results);
});

// Admin-only — includes the org's Google Form webhook secret, so this
// can't live in GET /api/me (which students also call).
router.get('/api/admin/organization', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT name, webhook_secret, default_org_unit_id, logo_object_key FROM organizations WHERE id = $1', [req.user.organizationId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    const logoObjectKey = result.rows[0].logo_object_key;
    res.status(200).json({
      name: result.rows[0].name,
      webhookSecret: result.rows[0].webhook_secret,
      defaultOrgUnitId: result.rows[0].default_org_unit_id,
      logoUrl: logoObjectKey ? await getScanPdfUrl(logoObjectKey, 900).catch(() => null) : null,
    });
  } catch (err) {
    console.error('Get organization error:', err);
    res.status(500).json({ error: 'Failed to load organization' });
  }
});

// Uploads/replaces the caller's own org's logo — shown on every ID card
// issued under it (see GET /api/me/id-card/:organizationId). Overwrites the
// same object key each time (see orgLogoObjectKey's own comment) rather
// than keeping old versions around.
router.post('/api/admin/organization/logo', authenticateToken, requireAdmin, avatarUpload.single('logo'), async (req, res) => {
  if (!isB2Configured()) return res.status(503).json({ error: 'Logo storage is not configured yet' });
  if (!req.file) return res.status(400).json({ error: 'A logo image is required' });
  try {
    const ext = path.extname(req.file.originalname || '') || '.png';
    const storageKey = orgLogoObjectKey(req.user.organizationId, ext);
    await uploadScanPdf(storageKey, req.file.buffer, req.file.mimetype);
    await pool.query('UPDATE organizations SET logo_object_key = $1 WHERE id = $2', [storageKey, req.user.organizationId]);
    res.status(200).json({ logoUrl: await getScanPdfUrl(storageKey, 900) });
  } catch (err) {
    console.error('Upload organization logo error:', err);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

// The webhook's fallback placement for a bare {name,email}-only form
// submission — one with no other questions to derive a tier chain from.
router.put('/api/admin/organization/default-unit', authenticateToken, requireAdmin, async (req, res) => {
  const orgUnitId = req.body.orgUnitId != null ? Number(req.body.orgUnitId) : null;
  try {
    if (orgUnitId !== null) {
      const unit = await pool.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
      if (unit.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    }
    await pool.query('UPDATE organizations SET default_org_unit_id = $1 WHERE id = $2', [orgUnitId, req.user.organizationId]);
    res.status(200).json({ message: 'Default unit updated' });
  } catch (err) {
    console.error('Update default unit error:', err);
    res.status(500).json({ error: 'Failed to update default unit' });
  }
});


// ============================================================================
// ORG STRUCTURE: the tier shape (org_level_defs) and the actual tree nodes
// built against it (org_units). A big college might define 7-8 tiers
// (Campus -> Department -> Year); a small tuition center just 2 — the tree
// depth is however many rows exist in org_level_defs for that org, nothing
// hardcoded. Structural edits (add/reorder/delete a tier) are locked the
// instant any org_units row exists anywhere in the org — inserting a tier
// into a half-populated tree has no sane semantics, and structure design
// happens once, before real students exist under it. Renaming a label
// stays allowed at any time since it's purely cosmetic.
// ============================================================================
router.get('/api/admin/org-levels', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, tier_index, label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC',
      [req.user.organizationId]
    );
    res.status(200).json({ levels: result.rows });
  } catch (err) {
    console.error('List org levels error:', err);
    res.status(500).json({ error: 'Failed to load organization structure' });
  }
});

router.post('/api/admin/org-levels', authenticateToken, requireAdmin, async (req, res) => {
  const label = String(req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Level label is required' });

  try {
    const unitsExist = await pool.query('SELECT 1 FROM org_units WHERE organization_id = $1 LIMIT 1', [req.user.organizationId]);
    if (unitsExist.rows.length > 0) {
      return res.status(409).json({ error: 'Cannot add a level once units exist — the structure is locked' });
    }

    const maxTier = await pool.query('SELECT COALESCE(MAX(tier_index), -1) AS max_tier FROM org_level_defs WHERE organization_id = $1', [req.user.organizationId]);
    const nextTier = Number(maxTier.rows[0].max_tier) + 1;

    const result = await pool.query(
      'INSERT INTO org_level_defs (organization_id, tier_index, label) VALUES ($1, $2, $3) RETURNING id, tier_index, label',
      [req.user.organizationId, nextTier, label]
    );
    await invalidate(`orgunits:${req.user.organizationId}`);
    res.status(201).json({ level: result.rows[0] });
  } catch (err) {
    console.error('Create org level error:', err);
    res.status(500).json({ error: 'Failed to add level' });
  }
});

router.put('/api/admin/org-levels/:id', authenticateToken, requireAdmin, async (req, res) => {
  const label = String(req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Level label is required' });

  try {
    const result = await pool.query(
      'UPDATE org_level_defs SET label = $1 WHERE id = $2 AND organization_id = $3 RETURNING id, tier_index, label',
      [label, req.params.id, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Level not found' });
    await invalidate(`orgunits:${req.user.organizationId}`);
    res.status(200).json({ level: result.rows[0] });
  } catch (err) {
    console.error('Rename org level error:', err);
    res.status(500).json({ error: 'Failed to rename level' });
  }
});

router.delete('/api/admin/org-levels/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const level = await pool.query('SELECT tier_index FROM org_level_defs WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (level.rows.length === 0) return res.status(404).json({ error: 'Level not found' });

    const unitsExist = await pool.query('SELECT 1 FROM org_units WHERE organization_id = $1 LIMIT 1', [req.user.organizationId]);
    if (unitsExist.rows.length > 0) {
      return res.status(409).json({ error: 'Cannot remove a level once units exist — the structure is locked' });
    }

    const maxTier = await pool.query('SELECT MAX(tier_index) AS max_tier FROM org_level_defs WHERE organization_id = $1', [req.user.organizationId]);
    if (Number(level.rows[0].tier_index) !== Number(maxTier.rows[0].max_tier)) {
      return res.status(400).json({ error: 'Only the deepest level can be removed' });
    }

    await pool.query('DELETE FROM org_level_defs WHERE id = $1', [req.params.id]);
    await invalidate(`orgunits:${req.user.organizationId}`);
    res.status(200).json({ message: 'Level removed' });
  } catch (err) {
    console.error('Delete org level error:', err);
    res.status(500).json({ error: 'Failed to remove level' });
  }
});

// Flat fetch — {levels, units} — the client builds the parent/child tree
// itself via a simple adjacency map. Realistic scale here is hundreds of
// nodes across at most ~8 tiers, never large enough to need pagination or
// a lazy per-node fetch.
// Cached: the org structure tree is read on nearly every admin/teacher
// page (student lists, subject pickers, CSV import templates, ...) but
// only ever written by an admin deliberately editing it — the write routes
// below (org-levels and org-units create/update/delete) all invalidate
// this same key, so a structure edit is visible immediately rather than
// waiting out the TTL; the TTL itself is just a backstop.
router.get('/api/admin/org-units', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const data = await cached(`orgunits:${req.user.organizationId}`, 120, async () => {
      const [levels, units] = await Promise.all([
        pool.query('SELECT id, tier_index, label FROM org_level_defs WHERE organization_id = $1 ORDER BY tier_index ASC', [req.user.organizationId]),
        pool.query('SELECT id, level_def_id, parent_unit_id, name FROM org_units WHERE organization_id = $1 ORDER BY id ASC', [req.user.organizationId]),
      ]);
      return { levels: levels.rows, units: units.rows };
    });
    res.status(200).json(data);
  } catch (err) {
    console.error('List org units error:', err);
    res.status(500).json({ error: 'Failed to load organization structure' });
  }
});

router.post('/api/admin/org-units', authenticateToken, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const levelDefId = Number(req.body.levelDefId);
  const parentUnitId = req.body.parentUnitId != null ? Number(req.body.parentUnitId) : null;
  if (!name) return res.status(400).json({ error: 'Unit name is required' });
  if (!Number.isFinite(levelDefId)) return res.status(400).json({ error: 'levelDefId is required' });

  try {
    const level = await pool.query('SELECT tier_index FROM org_level_defs WHERE id = $1 AND organization_id = $2', [levelDefId, req.user.organizationId]);
    if (level.rows.length === 0) return res.status(404).json({ error: 'Level not found' });
    const tierIndex = level.rows[0].tier_index;

    if (tierIndex === 0) {
      if (parentUnitId !== null) return res.status(400).json({ error: 'A root-tier unit cannot have a parent' });
    } else {
      if (parentUnitId === null) return res.status(400).json({ error: 'A parent unit is required for this level' });
      const parent = await pool.query(
        `SELECT u.id FROM org_units u JOIN org_level_defs l ON l.id = u.level_def_id
         WHERE u.id = $1 AND u.organization_id = $2 AND l.tier_index = $3`,
        [parentUnitId, req.user.organizationId, tierIndex - 1]
      );
      if (parent.rows.length === 0) return res.status(400).json({ error: 'Parent unit must belong to the tier directly above this one' });
    }

    const result = await pool.query(
      'INSERT INTO org_units (organization_id, level_def_id, parent_unit_id, name) VALUES ($1, $2, $3, $4) RETURNING id, level_def_id, parent_unit_id, name',
      [req.user.organizationId, levelDefId, parentUnitId, name]
    );
    await invalidate(`orgunits:${req.user.organizationId}`);
    res.status(201).json({ unit: result.rows[0] });
  } catch (err) {
    console.error('Create org unit error:', err);
    res.status(500).json({ error: 'Failed to add unit' });
  }
});

router.put('/api/admin/org-units/:id', authenticateToken, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Unit name is required' });

  try {
    const result = await pool.query(
      'UPDATE org_units SET name = $1 WHERE id = $2 AND organization_id = $3 RETURNING id, level_def_id, parent_unit_id, name',
      [name, req.params.id, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    await invalidate(`orgunits:${req.user.organizationId}`);
    res.status(200).json({ unit: result.rows[0] });
  } catch (err) {
    console.error('Rename org unit error:', err);
    res.status(500).json({ error: 'Failed to rename unit' });
  }
});

router.delete('/api/admin/org-units/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const unit = await pool.query('SELECT id FROM org_units WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (unit.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });

    const children = await pool.query('SELECT 1 FROM org_units WHERE parent_unit_id = $1 LIMIT 1', [req.params.id]);
    if (children.rows.length > 0) {
      return res.status(409).json({ error: 'Cannot remove a unit that still has child units' });
    }
    const members = await pool.query('SELECT 1 FROM memberships WHERE org_unit_id = $1 LIMIT 1', [req.params.id]);
    if (members.rows.length > 0) {
      return res.status(409).json({ error: 'Cannot remove a unit that still has people assigned to it' });
    }
    const subjects = await pool.query('SELECT 1 FROM subjects WHERE org_unit_id = $1 LIMIT 1', [req.params.id]);
    if (subjects.rows.length > 0) {
      return res.status(409).json({ error: 'Cannot remove a unit that still has subjects attached to it' });
    }

    await pool.query('DELETE FROM org_units WHERE id = $1', [req.params.id]);
    await invalidate(`orgunits:${req.user.organizationId}`);
    res.status(200).json({ message: 'Unit removed' });
  } catch (err) {
    console.error('Delete org unit error:', err);
    res.status(500).json({ error: 'Failed to remove unit' });
  }
});

// End-of-year promotion: bulk-moves students from one unit to another —
// deliberately just a plain org_unit_id reassignment on their membership
// row, nothing more. Every score a student has (submissions, exam_attempts,
// legacy_scores) keys off user_id, never org_unit, so there is nothing to
// migrate or recompute here — their whole history is automatically intact
// under the new unit the instant this UPDATE commits. `studentIds`
// (optional) lets an admin hold specific students back instead of
// promoting the whole unit at once; omitted, every student currently in
// fromUnit gets moved.
router.post('/api/admin/org-units/:fromUnitId/promote', authenticateToken, requireAdmin, async (req, res) => {
  const toUnitId = Number(req.body.toUnitId);
  if (!toUnitId) return res.status(400).json({ error: 'toUnitId is required' });
  if (toUnitId === Number(req.params.fromUnitId)) return res.status(400).json({ error: 'From and to units must be different' });

  try {
    const [fromRes, toRes] = await Promise.all([
      pool.query('SELECT id FROM org_units WHERE id = $1 AND organization_id = $2', [req.params.fromUnitId, req.user.organizationId]),
      pool.query('SELECT id, name FROM org_units WHERE id = $1 AND organization_id = $2', [toUnitId, req.user.organizationId]),
    ]);
    if (fromRes.rows.length === 0) return res.status(404).json({ error: 'Source unit not found' });
    if (toRes.rows.length === 0) return res.status(404).json({ error: 'Destination unit not found' });

    const studentIds = Array.isArray(req.body.studentIds) && req.body.studentIds.length > 0
      ? req.body.studentIds
      : null;

    const result = await pool.query(
      `UPDATE memberships SET org_unit_id = $1
       WHERE organization_id = $2 AND org_unit_id = $3 AND role = 'student'
         AND ($4::uuid[] IS NULL OR user_id = ANY($4::uuid[]))
       RETURNING user_id`,
      [toUnitId, req.user.organizationId, req.params.fromUnitId, studentIds]
    );

    res.status(200).json({ promoted: result.rows.length, toUnitName: toRes.rows[0].name });
  } catch (err) {
    console.error('Promote students error:', err);
    res.status(500).json({ error: 'Failed to promote students' });
  }
});

// ============================================================================
// SUBJECTS: attached to whatever org_unit tier an admin picks (not fixed to
// one depth) — see getVisibleSubjectIds() further down for how a subject on
// a Department-tier unit reaches every Year beneath it. Creating/renaming/
// deleting a subject and assigning its teachers is admin-only; a teacher's
// authority is to USE a subject they're assigned to (create/edit problems
// and exams under it), enforced by enforceSubjectAuthority() above.
// ============================================================================
// Admins see every subject in the org; teachers only see the subjects
// they're actually linked to via subject_teachers — this powers the
// subject-picker on the assignment/exam forms, which is the one place a
// teacher legitimately needs read access to (a subset of) this list.
router.get('/api/admin/subjects', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.org_unit_id, s.name, u.name AS org_unit_name,
              COALESCE(json_agg(json_build_object('id', t.id, 'email', t.email, 'name', t.name)) FILTER (WHERE t.id IS NOT NULL), '[]') AS teachers
       FROM subjects s
       JOIN org_units u ON u.id = s.org_unit_id
       LEFT JOIN subject_teachers st ON st.subject_id = s.id
       LEFT JOIN users t ON t.id = st.user_id
       WHERE s.organization_id = $1
         AND ($2::text != 'teacher' OR EXISTS (SELECT 1 FROM subject_teachers mine WHERE mine.subject_id = s.id AND mine.user_id = $3))
       GROUP BY s.id, s.org_unit_id, s.name, u.name
       ORDER BY s.name ASC`,
      [req.user.organizationId, req.user.role, req.user.userId]
    );
    res.status(200).json({ subjects: result.rows });
  } catch (err) {
    console.error('List subjects error:', err);
    res.status(500).json({ error: 'Failed to load subjects' });
  }
});

router.post('/api/admin/subjects', authenticateToken, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const orgUnitId = Number(req.body.orgUnitId);
  if (!name) return res.status(400).json({ error: 'Subject name is required' });
  if (!Number.isFinite(orgUnitId)) return res.status(400).json({ error: 'orgUnitId is required' });

  try {
    const unit = await pool.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
    if (unit.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });

    const result = await pool.query(
      'INSERT INTO subjects (organization_id, org_unit_id, name) VALUES ($1, $2, $3) RETURNING id, org_unit_id, name',
      [req.user.organizationId, orgUnitId, name]
    );
    res.status(201).json({ subject: result.rows[0] });
  } catch (err) {
    console.error('Create subject error:', err);
    res.status(500).json({ error: 'Failed to create subject' });
  }
});

router.put('/api/admin/subjects/:id', authenticateToken, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Subject name is required' });

  try {
    const result = await pool.query(
      'UPDATE subjects SET name = $1 WHERE id = $2 AND organization_id = $3 RETURNING id, org_unit_id, name',
      [name, req.params.id, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });
    res.status(200).json({ subject: result.rows[0] });
  } catch (err) {
    console.error('Rename subject error:', err);
    res.status(500).json({ error: 'Failed to rename subject' });
  }
});

router.delete('/api/admin/subjects/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const subject = await pool.query('SELECT id FROM subjects WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (subject.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    const problems = await pool.query('SELECT 1 FROM problems WHERE subject_id = $1 LIMIT 1', [req.params.id]);
    if (problems.rows.length > 0) return res.status(409).json({ error: 'Cannot remove a subject that still has assignments attached to it' });
    const exams = await pool.query('SELECT 1 FROM exams WHERE subject_id = $1 LIMIT 1', [req.params.id]);
    if (exams.rows.length > 0) return res.status(409).json({ error: 'Cannot remove a subject that still has exams attached to it' });

    await pool.query('DELETE FROM subjects WHERE id = $1', [req.params.id]);
    res.status(200).json({ message: 'Subject removed' });
  } catch (err) {
    console.error('Delete subject error:', err);
    res.status(500).json({ error: 'Failed to remove subject' });
  }
});

// Takes userId, not email — a subject's own unit is now the actual
// eligibility boundary for who can be assigned to it (an admin picks from
// GET /api/admin/teachers pre-filtered to teachers whose own org_unit_id
// matches this subject's, in SubjectsPanel.jsx), so the free-text "type an
// email and hope they exist" flow is gone: the frontend only ever offers
// teachers that already pass this check, and the check itself is
// re-enforced here so a direct API call can't bypass it either.
router.post('/api/admin/subjects/:id/teachers', authenticateToken, requireAdmin, async (req, res) => {
  const userId = String(req.body.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'A teacher must be selected' });

  try {
    const subject = await pool.query('SELECT id, org_unit_id FROM subjects WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (subject.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    const teacher = await pool.query(
      `SELECT u.id, m.org_unit_id FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE u.id = $1 AND m.organization_id = $2 AND m.role = 'teacher'`,
      [userId, req.user.organizationId]
    );
    if (teacher.rows.length === 0) return res.status(404).json({ error: 'Teacher not found in your organization' });
    if (teacher.rows[0].org_unit_id !== subject.rows[0].org_unit_id) {
      return res.status(400).json({ error: "This teacher isn't part of the subject's unit" });
    }

    await pool.query(
      'INSERT INTO subject_teachers (subject_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, teacher.rows[0].id]
    );
    res.status(201).json({ message: 'Teacher assigned to subject' });
  } catch (err) {
    console.error('Assign subject teacher error:', err);
    res.status(500).json({ error: 'Failed to assign teacher' });
  }
});

router.delete('/api/admin/subjects/:id/teachers/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const subject = await pool.query('SELECT id FROM subjects WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (subject.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    await pool.query('DELETE FROM subject_teachers WHERE subject_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    res.status(200).json({ message: 'Teacher removed from subject' });
  } catch (err) {
    console.error('Remove subject teacher error:', err);
    res.status(500).json({ error: 'Failed to remove teacher' });
  }
});

// ============================================================================
// 1b. ADMIN: List every student with their total assignment/exam score —
// deliberately just the two headline numbers (see getTotalScores), not the
// attempt-count/time-on-task/efficiency-score detail this route used to
// return. An admin managing a roster doesn't need per-attempt forensics;
// that level of detail is still available lower down for one student at a
// time (GET /api/admin/students/:studentId/problems/:problemId/submissions)
// for the rare case it's actually needed.
// ============================================================================
router.get('/api/admin/students', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const membershipsRes = await pool.query(
      `SELECT u.id, u.email, u.name, u.created_at, m.org_unit_id
       FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $1 AND m.role = 'student'
       ORDER BY u.email ASC`,
      [req.user.organizationId]
    );
    const roster = membershipsRes.rows;
    const studentIds = roster.map((s) => s.id);

    const [unitLookup, totals] = await Promise.all([
      getOrgUnitLookup(req.user.organizationId),
      getTotalScores(req.user.organizationId, studentIds),
    ]);

    const students = roster.map((s) => {
      const t = totals.get(s.id) || { totalAssignmentPercent: null, totalExamPercent: null };
      return {
        id: s.id,
        email: s.email,
        name: s.name,
        created_at: s.created_at,
        org_unit_id: s.org_unit_id,
        unit_path: resolveOrgUnitPath(unitLookup, s.org_unit_id),
        totalAssignmentPercent: t.totalAssignmentPercent,
        totalExamPercent: t.totalExamPercent,
      };
    });

    res.status(200).json({ students });
  } catch (error) {
    console.error('List students error:', error);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

// ============================================================================
// GRADEBOOK - full per-student x per-item score matrix for one subject
// (not just the rollup averages /api/teacher/students returns), plus a
// class-average row. Admin can view any subject in their org; a teacher is
// gated to their own assigned subjects via enforceSubjectAuthority, the
// same check every other subject-scoped exam/assignment route already uses.
// ============================================================================
router.get('/api/admin/gradebook', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectId = req.query.subjectId != null ? Number(req.query.subjectId) : null;
  if (!subjectId || !Number.isFinite(subjectId)) {
    return res.status(400).json({ error: 'subjectId is required' });
  }
  if (await enforceSubjectAuthority(req, res, subjectId)) return;

  try {
    const subjectRes = await pool.query('SELECT id, name FROM subjects WHERE id = $1 AND organization_id = $2', [subjectId, req.user.organizationId]);
    if (subjectRes.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    const [students, problemsRes, examsRes] = await Promise.all([
      getStudentsForSubject(req.user.organizationId, subjectId),
      pool.query('SELECT id, title, submission_mode FROM problems WHERE organization_id = $1 AND subject_id = $2 ORDER BY created_at ASC', [req.user.organizationId, subjectId]),
      pool.query('SELECT id, title, total_marks FROM exams WHERE organization_id = $1 AND subject_id = $2 ORDER BY created_at ASC', [req.user.organizationId, subjectId]),
    ]);
    const problems = problemsRes.rows;
    const exams = examsRes.rows;
    const studentIds = students.map((s) => s.id);

    const [{ byUser: assignmentByUser }, { byUser: examByUser }] = await Promise.all([
      getAssignmentPerformance(problems, studentIds),
      getExamPerformance(exams, studentIds),
    ]);

    const rows = students.map((s) => {
      const aMap = assignmentByUser.get(s.id) || new Map();
      const eMap = examByUser.get(s.id) || new Map();
      return {
        id: s.id,
        name: s.name,
        email: s.email,
        assignments: Object.fromEntries(problems.map((p) => [p.id, aMap.get(p.id) || { status: 'not_submitted', pct: null }])),
        exams: Object.fromEntries(exams.map((e) => [e.id, eMap.get(e.id) || { status: 'not_submitted', pct: null }])),
        avgAssignmentPercent: averagePercent(aMap),
        avgExamPercent: averagePercent(eMap),
      };
    });

    // Class-average row — mean of graded percentages per column, ignoring
    // students who haven't been graded on that item yet (same convention
    // averagePercent already uses for a single student's row).
    const classAvgFor = (getPct) => {
      const vals = rows.map(getPct).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const classAverages = {
      assignments: Object.fromEntries(problems.map((p) => [p.id, classAvgFor((r) => r.assignments[p.id].pct)])),
      exams: Object.fromEntries(exams.map((e) => [e.id, classAvgFor((r) => r.exams[e.id].pct)])),
      overallAssignment: classAvgFor((r) => r.avgAssignmentPercent),
      overallExam: classAvgFor((r) => r.avgExamPercent),
    };

    res.status(200).json({
      subject: subjectRes.rows[0],
      assignments: problems.map((p) => ({ id: p.id, title: p.title })),
      exams: exams.map((e) => ({ id: e.id, title: e.title })),
      students: rows,
      classAverages,
    });
  } catch (err) {
    console.error('Gradebook error:', err);
    res.status(500).json({ error: 'Failed to load gradebook' });
  }
});

// ============================================================================
// LEADERBOARD - ranked class view for one exam or one assignment, using the
// same mid-rank percentile math as the student-facing gauge
// (computePercentileTiers, see GET /api/me/performance*) rather than
// reinventing it. type is 'exam' | 'assignment'; itemId is that item's own
// id. Authorization derives the subject from the item itself (not a query
// param) so a teacher can't probe an item's subject by guessing.
// ============================================================================
router.get('/api/admin/leaderboard', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const type = req.query.type;
  const itemId = req.query.itemId != null ? Number(req.query.itemId) : null;
  if (!['exam', 'assignment'].includes(type) || !itemId || !Number.isFinite(itemId)) {
    return res.status(400).json({ error: 'type ("exam" or "assignment") and itemId are required' });
  }

  try {
    const table = type === 'exam' ? 'exams' : 'problems';
    const itemRes = await pool.query(`SELECT id, title, subject_id FROM ${table} WHERE id = $1 AND organization_id = $2`, [itemId, req.user.organizationId]);
    if (itemRes.rows.length === 0) {
      return res.status(404).json({ error: type === 'exam' ? 'Exam not found' : 'Assignment not found' });
    }
    const item = itemRes.rows[0];
    if (await enforceSubjectAuthority(req, res, item.subject_id)) return;

    // Org-wide items (subject_id null) only ever reach here as an admin —
    // enforceSubjectAuthority already 400s a teacher on a null subjectId —
    // so the population is every student in the org rather than one
    // subject's cascade-down set.
    const students = item.subject_id
      ? await getStudentsForSubject(req.user.organizationId, item.subject_id)
      : (await pool.query(
          `SELECT u.id, u.email, u.name FROM users u
           JOIN memberships m ON m.user_id = u.id AND m.organization_id = $1 AND m.role = 'student'
           ORDER BY u.email ASC`,
          [req.user.organizationId]
        )).rows;
    const studentIds = students.map((s) => s.id);

    let byUser;
    if (type === 'exam') {
      const examRow = await pool.query('SELECT id, total_marks FROM exams WHERE id = $1', [itemId]);
      ({ byUser } = await getExamPerformance(examRow.rows, studentIds));
    } else {
      const probRow = await pool.query('SELECT id, submission_mode FROM problems WHERE id = $1', [itemId]);
      ({ byUser } = await getAssignmentPerformance(probRow.rows, studentIds));
    }

    const graded = [];
    const ungraded = [];
    students.forEach((s) => {
      const entry = byUser.get(s.id)?.get(itemId);
      if (entry && entry.pct != null) graded.push({ id: s.id, name: s.name, email: s.email, pct: entry.pct });
      else ungraded.push({ id: s.id, name: s.name, email: s.email, status: entry?.status || 'not_submitted' });
    });

    const tierFor = computePercentileTiers(graded.map((g) => g.pct));
    const ranked = graded
      .map((g) => ({ ...g, ...tierFor(g.pct) }))
      .sort((a, b) => b.pct - a.pct)
      .map((g, i) => ({ ...g, rank: i + 1 }));

    res.status(200).json({
      item: { id: item.id, title: item.title, type },
      ranked,
      ungraded,
      classAverage: ranked.length ? ranked.reduce((sum, g) => sum + g.pct, 0) / ranked.length : null,
    });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// ============================================================================
// TEACHER DASHBOARD - every student "under" the teacher (their subjects'
// org units and everything beneath them, see getTeacherScope above), with
// performance rolled up ONLY from assignments/exams attached to the
// teacher's own subjects - not an org-wide report, deliberately narrower
// than /api/admin/students. Teacher-only, same posture as non-submitters
// above: admins already have their own fuller student views.
// ============================================================================
router.get('/api/teacher/students', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  try {
    const { subjectIds, unitIds } = await getTeacherScope(req.user.userId, req.user.organizationId);
    const students = await getTeacherScopedStudents(req.user.organizationId, unitIds);
    const studentIds = students.map((s) => s.id);

    const { problems, exams } = await getSubjectScopedAssignmentsAndExams(req.user.organizationId, subjectIds);
    const [{ byUser: assignmentByUser }, { byUser: examByUser }] = await Promise.all([
      getAssignmentPerformance(problems, studentIds),
      getExamPerformance(exams, studentIds),
    ]);

    const unitLookup = await getOrgUnitLookup(req.user.organizationId);

    const result = students.map((s) => {
      const aMap = assignmentByUser.get(s.id) || new Map();
      const eMap = examByUser.get(s.id) || new Map();
      return {
        id: s.id,
        email: s.email,
        name: s.name,
        created_at: s.created_at,
        unit_path: resolveOrgUnitPath(unitLookup, s.org_unit_id),
        assignmentsTotal: problems.length,
        assignmentsSubmitted: aMap.size,
        avgAssignmentPercent: averagePercent(aMap),
        examsTotal: exams.length,
        examsAttempted: eMap.size,
        avgExamPercent: averagePercent(eMap),
      };
    });

    res.status(200).json({ students: result, subjectCount: subjectIds.length });
  } catch (err) {
    console.error('Teacher students list error:', err);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

// Teacher: one student's full breakdown, scoped the same way as the list
// above - 404s (rather than 403) if the student exists but falls outside
// this teacher's own subjects/units, so a teacher can't fish for arbitrary
// student ids by trying them one at a time.
router.get('/api/teacher/students/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  try {
    const { subjectIds, unitIds } = await getTeacherScope(req.user.userId, req.user.organizationId);
    if (unitIds.length === 0) return res.status(404).json({ error: 'Student not found' });

    const studentRes = await pool.query(
      `SELECT u.id, u.email, u.name, u.created_at, m.org_unit_id
       FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $1 AND m.role = 'student'
       WHERE u.id = $2 AND m.org_unit_id = ANY($3::int[])`,
      [req.user.organizationId, req.params.id, unitIds]
    );
    if (studentRes.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const student = studentRes.rows[0];

    const classmates = await getTeacherScopedStudents(req.user.organizationId, unitIds);
    const studentIds = classmates.map((s) => s.id);

    const { problems, exams } = await getSubjectScopedAssignmentsAndExams(req.user.organizationId, subjectIds);
    const [{ byUser: assignmentByUser }, { byUser: examByUser }] = await Promise.all([
      getAssignmentPerformance(problems, studentIds),
      getExamPerformance(exams, studentIds),
    ]);

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
        ? pool.query('SELECT problem_id, overall_remarks FROM scan_submissions WHERE user_id = $1 AND problem_id = ANY($2::int[])', [student.id, problems.map((p) => p.id)])
        : { rows: [] },
      exams.length
        ? pool.query('SELECT exam_id, overall_remarks FROM exam_attempts WHERE user_id = $1 AND exam_id = ANY($2::int[])', [student.id, exams.map((e) => e.id)])
        : { rows: [] },
    ]);
    const problemMetaById = new Map(problemMetaRes.rows.map((r) => [r.id, r]));
    const examMetaById = new Map(examMetaRes.rows.map((r) => [r.id, r]));
    const scanRemarksByProblem = new Map(scanRemarksRes.rows.map((r) => [r.problem_id, r.overall_remarks]));
    const examRemarksByExam = new Map(examRemarksRes.rows.map((r) => [r.exam_id, r.overall_remarks]));

    const myAssignments = assignmentByUser.get(student.id) || new Map();
    const myExams = examByUser.get(student.id) || new Map();

    const assignments = problems.map((p) => {
      const meta = problemMetaById.get(p.id);
      const entry = myAssignments.get(p.id);
      return {
        problemId: p.id,
        title: meta?.title,
        subjectName: meta?.subject_name,
        status: entry?.status || 'not_submitted',
        percent: entry?.pct ?? null,
        remarks: scanRemarksByProblem.get(p.id) || null,
      };
    });

    const examsOut = exams.map((e) => {
      const meta = examMetaById.get(e.id);
      const entry = myExams.get(e.id);
      return {
        examId: e.id,
        title: meta?.title,
        subjectName: meta?.subject_name,
        status: entry?.status || 'not_attempted',
        percent: entry?.pct ?? null,
        remarks: examRemarksByExam.get(e.id) || null,
      };
    });

    // Percentile against this teacher's own class only (not org-wide) - a
    // student's standing among peers actually taking the same subjects,
    // rather than being diluted by every other department/year in the
    // institution the way the admin-side percentile is.
    const classmateAssignmentAvgs = [];
    const classmateExamAvgs = [];
    studentIds.forEach((sid) => {
      const aAvg = averagePercent(assignmentByUser.get(sid) || new Map());
      if (aAvg != null) classmateAssignmentAvgs.push(aAvg);
      const eAvg = averagePercent(examByUser.get(sid) || new Map());
      if (eAvg != null) classmateExamAvgs.push(eAvg);
    });
    const myAvgAssignment = averagePercent(myAssignments);
    const myAvgExam = averagePercent(myExams);
    const assignmentPercentileTag = myAvgAssignment != null && classmateAssignmentAvgs.length > 1
      ? computePercentileTiers(classmateAssignmentAvgs)(myAvgAssignment).tag
      : null;
    const examPercentileTag = myAvgExam != null && classmateExamAvgs.length > 1
      ? computePercentileTiers(classmateExamAvgs)(myAvgExam).tag
      : null;

    const unitLookup = await getOrgUnitLookup(req.user.organizationId);

    res.status(200).json({
      student: { id: student.id, email: student.email, name: student.name, created_at: student.created_at },
      unitPath: resolveOrgUnitPath(unitLookup, student.org_unit_id),
      assignments,
      exams: examsOut,
      avgAssignmentPercent: myAvgAssignment,
      avgExamPercent: myAvgExam,
      assignmentPercentileTag,
      examPercentileTag,
    });
  } catch (err) {
    console.error('Teacher student detail error:', err);
    res.status(500).json({ error: 'Failed to load student' });
  }
});

// ============================================================================
// 1c. ADMIN: Per-student breakdown â€” every problem attempted and its result
// ============================================================================
// Just identity + the two total scores (see getTotalScores) — no
// percentile tags, no per-assignment attempt history. An admin managing a
// roster needs "how is this student doing overall," not attempt-by-attempt
// forensics; that level of detail still exists per-subject in the teacher
// dashboard's own student detail view (GET /api/teacher/students/:id) for
// whichever teacher actually owns that subject.
router.get('/api/admin/students/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const studentRes = await pool.query(
      `SELECT u.id, u.email, u.name, u.created_at, m.org_unit_id, m.roll_number FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2 AND m.role = 'student'
       WHERE u.id = $1`,
      [req.params.id, req.user.organizationId]
    );
    if (studentRes.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const unitPath = resolveOrgUnitPath(await getOrgUnitLookup(req.user.organizationId), studentRes.rows[0].org_unit_id);

    const totals = await getTotalScores(req.user.organizationId, [req.params.id]);
    const t = totals.get(req.params.id) || { totalAssignmentPercent: null, totalExamPercent: null };

    res.status(200).json({
      student: studentRes.rows[0],
      unitPath,
      totalAssignmentPercent: t.totalAssignmentPercent,
      totalExamPercent: t.totalExamPercent,
    });
  } catch (error) {
    console.error('Student detail error:', error);
    res.status(500).json({ error: 'Failed to load student detail' });
  }
});

// ============================================================================
// LEGACY SCORES — CSV import of pre-platform score history, for
// institutions onboarding after already having a track record. Unlike the
// student roster CSV import above, this never creates accounts or org
// units — every row must match an EXISTING student in this org by email
// (they're expected to already exist, e.g. from that same roster import),
// and just attaches a score to them. See getTotalScores for how these rows
// get blended into "total score" everywhere it's shown.
// ============================================================================
router.get('/api/admin/legacy-scores/csv-template', authenticateToken, requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="legacy-scores-template.csv"');
  res.status(200).send('Email,AcademicYear,AssignmentScorePercent,ExamScorePercent,Notes\n');
});

router.post('/api/admin/legacy-scores/import', authenticateToken, requireAdmin, csvUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });

  let rows;
  try {
    rows = parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not parse CSV file — check it is valid CSV with a header row' });
  }
  if (rows.length === 0) return res.status(400).json({ error: 'CSV has no data rows' });

  const headerKeys = Object.keys(rows[0]);
  const findKey = (name) => headerKeys.find((k) => k.trim().toLowerCase() === name);
  const emailKey = findKey('email');
  const yearKey = findKey('academicyear');
  const assignmentKey = findKey('assignmentscorepercent');
  const examKey = findKey('examscorepercent');
  const notesKey = findKey('notes');
  if (!emailKey || !yearKey) {
    return res.status(400).json({ error: 'CSV must have Email and AcademicYear columns' });
  }

  // A percent cell can be blank (this school might only have exam records
  // for an old year, not assignment records, or vice versa) — blank parses
  // to null, not 0, so a missing score never drags the blended average down.
  const parsePercent = (raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return { value: null };
    const n = Number(trimmed);
    if (Number.isNaN(n) || n < 0 || n > 100) return { error: true };
    return { value: n };
  };

  const results = { imported: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const email = String(row[emailKey] || '').trim();
    const academicYear = String(row[yearKey] || '').trim();

    if (!email) { results.errors.push({ row: rowNum, email, reason: 'Missing email' }); continue; }
    if (!academicYear) { results.errors.push({ row: rowNum, email, reason: 'Missing academic year' }); continue; }

    const assignmentParsed = parsePercent(row[assignmentKey]);
    const examParsed = parsePercent(row[examKey]);
    if (assignmentParsed.error || examParsed.error) {
      results.errors.push({ row: rowNum, email, reason: 'Score percent must be a number between 0 and 100 (or blank)' });
      continue;
    }
    if (assignmentParsed.value == null && examParsed.value == null) {
      results.errors.push({ row: rowNum, email, reason: 'Row has neither an assignment score nor an exam score' });
      continue;
    }

    const studentRes = await pool.query(
      `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE u.email = $1 AND m.organization_id = $2 AND m.role = 'student'`,
      [email, req.user.organizationId]
    );
    if (studentRes.rows.length === 0) {
      results.errors.push({ row: rowNum, email, reason: 'No student with this email in your organization' });
      continue;
    }

    await pool.query(
      `INSERT INTO legacy_scores (organization_id, user_id, academic_year, assignment_score_percent, exam_score_percent, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, user_id, academic_year)
       DO UPDATE SET assignment_score_percent = $4, exam_score_percent = $5, notes = $6`,
      [req.user.organizationId, studentRes.rows[0].id, academicYear, assignmentParsed.value, examParsed.value, notesKey ? (String(row[notesKey] || '').trim() || null) : null]
    );
    results.imported++;
  }

  res.status(200).json(results);
});

// ============================================================================
// 1c-2. ADMIN ONLY: Edit a student's own details — name, class/unit
// placement, roll number. Deliberately requireAdmin, not
// requireAdminOrTeacher — a teacher's authority is scoped to grading
// within their assigned subjects, not to changing a student's identity/
// roster placement. Email is NOT editable here: `users.email` is the
// global-identity key shared across every organization that email belongs
// to (see findOrCreateGlobalUser), so changing it here would rename that
// person's login everywhere, not just within this org — a materially
// different, riskier operation than fixing a name/class typo, and not
// something this route takes on.
// ============================================================================
router.put('/api/admin/students/:id', authenticateToken, requireAdmin, async (req, res) => {
  const studentId = req.params.id;
  const name = req.body.name !== undefined ? (String(req.body.name || '').trim() || null) : undefined;
  const orgUnitId = req.body.orgUnitId !== undefined
    ? (req.body.orgUnitId === null || req.body.orgUnitId === '' ? null : Number(req.body.orgUnitId))
    : undefined;
  const rollNumber = req.body.rollNumber !== undefined ? (String(req.body.rollNumber || '').trim() || null) : undefined;

  try {
    // Scoped to role='student' on purpose, same reasoning as the delete
    // route right below — never lets this touch an admin/teacher account
    // even if a stale/tampered id is passed in. 404, not 403, on a miss so
    // this can't be used to probe which ids exist in another organization.
    const membershipRes = await pool.query(
      `SELECT m.id FROM memberships m WHERE m.user_id = $1 AND m.organization_id = $2 AND m.role = 'student'`,
      [studentId, req.user.organizationId]
    );
    if (membershipRes.rows.length === 0) return res.status(404).json({ error: 'Student not found' });

    if (orgUnitId !== undefined && orgUnitId !== null) {
      const unitCheck = await pool.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2', [orgUnitId, req.user.organizationId]);
      if (unitCheck.rows.length === 0) return res.status(404).json({ error: 'Unit not found' });
    }

    if (name !== undefined) {
      await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name, studentId]);
    }
    if (orgUnitId !== undefined || rollNumber !== undefined) {
      // Distinguishes "field not sent at all" (leave unchanged) from
      // "field explicitly sent as null" (clear it, e.g. moving a student
      // back to no unit) via the two boolean flags — a plain COALESCE
      // against the existing value can't tell those apart, since both
      // look identical (a NULL parameter) from SQL's point of view.
      await pool.query(
        `UPDATE memberships SET
           org_unit_id = CASE WHEN $3::boolean THEN $1 ELSE org_unit_id END,
           roll_number = CASE WHEN $4::boolean THEN $2 ELSE roll_number END
         WHERE user_id = $5 AND organization_id = $6`,
        [orgUnitId ?? null, rollNumber ?? null, orgUnitId !== undefined, rollNumber !== undefined, studentId, req.user.organizationId]
      );
    }

    const updated = await pool.query(
      `SELECT u.id, u.email, u.name, m.org_unit_id, m.roll_number FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2
       WHERE u.id = $1`,
      [studentId, req.user.organizationId]
    );
    logSecurityEvent(req, 'student_updated', {
      detail: { studentUserId: studentId, fields: { name: name !== undefined, orgUnitId: orgUnitId !== undefined, rollNumber: rollNumber !== undefined } },
    });
    res.status(200).json({ message: 'Student updated', student: updated.rows[0] });
  } catch (err) {
    console.error('Update student error:', err);
    res.status(500).json({ error: 'Failed to update student' });
  }
});

// ============================================================================
// 1d. ADMIN: Remove a student from the platform
// ============================================================================
// Scoped to role = 'student' in the WHERE clause on purpose â€” even if an admin's
// id is passed in here (typo, stale UI, whatever), this 404s instead of touching
// another admin account. There's no route that lets one admin delete another.
router.delete('/api/admin/students/:id', authenticateToken, requireAdmin, async (req, res) => {
  const studentId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const target = await client.query(
      `SELECT u.id, u.email FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2 AND m.role = 'student'
       WHERE u.id = $1`,
      [studentId, req.user.organizationId]
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Student not found' });
    }

    // Scoped to THIS org's own data only — a global identity can belong to
    // more than one organization now (e.g. a student who's also enrolled
    // elsewhere), so an unscoped delete here would wipe their submissions,
    // or even their whole account, in an org they aren't even being
    // removed from.
    await client.query(
      'DELETE FROM submissions WHERE user_id = $1 AND problem_id IN (SELECT id FROM problems WHERE organization_id = $2)',
      [studentId, req.user.organizationId]
    );
    await client.query('DELETE FROM memberships WHERE user_id = $1 AND organization_id = $2', [studentId, req.user.organizationId]);
    // Only drops the global identity itself once it has no memberships left
    // anywhere — otherwise this leaves a harmless, inert users row behind.
    await client.query(
      'DELETE FROM users WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1)',
      [studentId]
    );

    await client.query('COMMIT');
    logSecurityEvent(req, 'student_removed', { detail: { studentUserId: studentId, email: target.rows[0].email } });
    res.status(200).json({ message: `${target.rows[0].email} was removed from the platform` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete student error:', error);
    res.status(500).json({ error: 'Failed to remove student' });
  } finally {
    client.release();
  }
});

// ============================================================================
// 2. WEBHOOK ENDPOINT: Automated Onboarding from Google Forms
// (left unauthenticated â€” Google Forms/Zapier can't carry a session cookie)
// ============================================================================
// Public/unauthenticated by necessity — Google Forms can't send a Bearer
// token — so the org has to be identified some other way. :webhookSecret is
// a random per-org token (not the guessable sequential organizations.id)
// shown to each admin in their dashboard, so each school points their own
// Google Form's webhook at their own URL.
router.post('/api/webhook/google-form/:webhookSecret', async (req, res) => {
  // Every field the form POSTs that isn't Name/Email is a tier, left to
  // right in whatever order the form sends them — same contract as CSV
  // import, so an admin building a Google Form question-by-question
  // (Campus -> Department -> Year -> Name -> Email) gets the exact same
  // auto-built structure a CSV upload would.
  const { emailKey, nameKey, rollKey, tierKeys } = splitTierAndIdentityColumns(Object.keys(req.body || {}));
  const email = emailKey ? String(req.body[emailKey] || '').trim() : '';
  const name = nameKey ? String(req.body[nameKey] || '').trim() : '';
  const rollNumber = rollKey ? String(req.body[rollKey] || '').trim() || null : null;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  const client = await pool.connect();
  try {
    const orgRes = await client.query('SELECT id, status, name, default_org_unit_id FROM organizations WHERE webhook_secret = $1', [req.params.webhookSecret]);
    if (orgRes.rows.length === 0) {
      return res.status(404).json({ error: 'Unknown webhook' });
    }
    const organizationId = orgRes.rows[0].id;
    if (orgRes.rows[0].status !== 'approved') {
      // Never 500 here — Google Forms/Zapier can't surface a failure to
      // anyone, so a still-pending org just gets a clean, silent no-op.
      return res.status(200).send('Organization pending approval, no account created');
    }

    const cap = await checkStudentCap(organizationId, 1);
    if (!cap.ok) {
      return res.status(200).send(`Skipped: ${cap.planLabel} plan is full (${cap.cap} students)`);
    }

    // A bare {name,email}-only form (no other questions) falls back to
    // whatever default_org_unit_id the admin configured. A form WITH other
    // questions auto-builds/extends the org's structure from them, exactly
    // like CSV import — no separate "build your structure first" step.
    let orgUnitId = orgRes.rows[0].default_org_unit_id;
    if (tierKeys.length > 0) {
      const levelsResult = await ensureLevelsForTierLabels(organizationId, tierKeys);
      if (levelsResult.error) {
        return res.status(200).send(`Skipped: ${levelsResult.reason}`);
      }
      const resolution = await resolveOrCreateOrgUnit(organizationId, levelsResult.levels, tierKeys.map((k) => req.body[k]));
      if (resolution.error) {
        return res.status(200).send(`Skipped: ${resolution.reason}`);
      }
      orgUnitId = resolution.orgUnitId;
    }

    await client.query('BEGIN');
    const { userId, isNew, temporaryPassword } = await findOrCreateGlobalUser(client, email, name);

    // ON CONFLICT DO NOTHING means a repeat form submission for someone
    // who's already a member of this org is silently skipped — but a
    // brand-new temporaryPassword above was only ever generated for a
    // brand-new identity, so we must only email it out when BOTH the
    // identity and the membership were newly created this call, or the
    // student gets a password that doesn't match what's actually stored.
    const memberRes = await client.query(
      `INSERT INTO memberships (user_id, organization_id, role, org_unit_id, roll_number) VALUES ($1, $2, 'student', $3, $4)
       ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING id`,
      [userId, organizationId, orgUnitId, rollNumber]
    );
    await client.query('COMMIT');

    if (memberRes.rows.length === 0) {
      console.log(`Skipped onboarding email for ${email} - already a member of this organization`);
      return res.status(200).send('Already a member, no email sent');
    }
    if (!isNew) {
      console.log(`Added existing account ${email} to organization ${organizationId} - no email sent`);
      return res.status(200).send('Existing account added, no email sent');
    }

    // Best-effort, not fatal — the account/membership are already
    // committed above; Google Forms can't surface a failure to anyone, so
    // an email hiccup here shouldn't turn an otherwise-successful signup
    // into a 500 (matches the same best-effort treatment CSV import gives
    // its own credentials emails).
    await sendStudentWelcomeEmail(email, name, orgRes.rows[0].name, temporaryPassword);

    console.log(`Automated Onboarding Complete for: ${email}`);
    res.status(200).send('Success');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Webhook error:', error);
    res.status(500).send('Error processing webhook');
  } finally {
    client.release();
  }
});



// ============================================================================
// ADMIN: PROFILE CHANGE REQUESTS
// Student roster correction requests for this organization.
// ============================================================================
router.get('/api/admin/profile-change-requests', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const statusParam = req.query.status;
    const allowed = ['pending', 'escalated', 'approved', 'rejected'];
    const status = allowed.includes(statusParam) ? statusParam : 'pending';
    const params = [req.user.organizationId];
    let where = 'WHERE r.organization_id = $1';
    if (statusParam !== 'all') {
      params.push(status);
      where += ' AND r.status = $2';
    }
    const result = await pool.query(
      `SELECT r.id, r.field, r.current_value, r.requested_value, r.reason, r.status,
              r.review_note, r.reviewed_at, r.created_at, r.escalated_at, r.escalation_note,
              u.id AS student_id, u.email AS student_email, u.name AS student_name,
              m.roll_number
       FROM profile_change_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN memberships m ON m.user_id = u.id AND m.organization_id = r.organization_id
       ${where}
       ORDER BY r.created_at DESC`,
      params
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('Admin list profile change requests error:', err);
    res.status(500).json({ error: 'Failed to load profile change requests' });
  }
});

router.post('/api/admin/profile-change-requests/:id/review', authenticateToken, requireAdmin, async (req, res) => {
  const action = req.body.action || req.body.status;
  if (!['approved', 'rejected', 'escalated'].includes(action)) {
    return res.status(400).json({ error: "action must be 'approved', 'rejected', or 'escalated'" });
  }
  const note = req.body.note != null ? String(req.body.note).trim() || null : null;

  try {
    const reqRes = await pool.query(
      `SELECT r.*, u.name AS student_name, u.email AS student_email, o.name AS organization_name
       FROM profile_change_requests r
       JOIN users u ON u.id = r.user_id
       JOIN organizations o ON o.id = r.organization_id
       WHERE r.id = $1 AND r.organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = reqRes.rows[0];
    if (request.status !== 'pending') {
      return res.status(409).json({ error: 'This request was already reviewed or escalated' });
    }

    if (action === 'approved') {
      const normalizedField = request.field.trim().toLowerCase().replace(/\s+/g, '_');
      if (normalizedField === 'name') {
        await pool.query('UPDATE users SET name = $1 WHERE id = $2', [request.requested_value, request.user_id]);
      } else if (normalizedField === 'roll_number' || normalizedField === 'rollnumber') {
        await pool.query(
          'UPDATE memberships SET roll_number = $1 WHERE user_id = $2 AND organization_id = $3',
          [request.requested_value, request.user_id, request.organization_id]
        );
      }

      const result = await pool.query(
        `UPDATE profile_change_requests
         SET status = 'approved', reviewed_by = $1, reviewed_at = now(), review_note = $2
         WHERE id = $3 RETURNING id, status, review_note, reviewed_at`,
        [req.user.userId, note, req.params.id]
      );

      // Best-effort notification to student
      const { error: mailErr } = await sendEmail({
        to: request.student_email,
        subject: 'HonorRoll — Info Change Request Approved',
        text: `Hello ${request.student_name || 'Student'},\n\nYour request to change "${request.field}" to "${request.requested_value}" has been approved by your administrator.${note ? `\n\nNote: ${note}` : ''}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Student info change approval email error:', mailErr);

      return res.status(200).json({ request: result.rows[0] });
    }

    if (action === 'rejected') {
      const result = await pool.query(
        `UPDATE profile_change_requests
         SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), review_note = $2
         WHERE id = $3 RETURNING id, status, review_note, reviewed_at`,
        [req.user.userId, note, req.params.id]
      );

      // Best-effort notification to student
      const { error: mailErr } = await sendEmail({
        to: request.student_email,
        subject: 'HonorRoll — Info Change Request Update',
        text: `Hello ${request.student_name || 'Student'},\n\nYour request to change "${request.field}" was reviewed and rejected by your administrator.${note ? `\n\nReason: ${note}` : ''}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Student info change rejection email error:', mailErr);

      return res.status(200).json({ request: result.rows[0] });
    }

    if (action === 'escalated') {
      const result = await pool.query(
        `UPDATE profile_change_requests
         SET status = 'escalated', escalated_by = $1, escalated_at = now(), escalation_note = $2
         WHERE id = $3 RETURNING id, status, escalation_note, escalated_at`,
        [req.user.userId, note, req.params.id]
      );

      // Superadmin only receives emails from admins — notify superadmin of escalated request
      const adminUserRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]);
      const adminName = adminUserRes.rows[0]?.name || 'Administrator';
      const adminEmail = adminUserRes.rows[0]?.email || 'admin';
      const superadminTarget = getSuperadminEmails()[0] || 'honorroll.admin@gmail.com';

      const { error: mailErr } = await sendEmail({
        to: superadminTarget,
        subject: `Escalated Student Info Change Request — ${request.organization_name}`,
        text: `An administrator has escalated a student info change request to the superadmin queue:\n\nAdministrator: ${adminName} <${adminEmail}>\nOrganization: ${request.organization_name}\n\nStudent: ${request.student_name || 'Student'} <${request.student_email}>\nField: ${request.field}\nCurrent Value: ${request.current_value || '(none)'}\nRequested Value: ${request.requested_value}\nStudent Reason: ${request.reason || '(none)'}\n\nAdmin Escalation Note:\n${note || '(none)'}\n\n— HonorRoll`,
      });
      if (mailErr) console.error('Escalation email to superadmin error:', mailErr);

      return res.status(200).json({ request: result.rows[0] });
    }
  } catch (err) {
    console.error('Admin review profile change request error:', err);
    res.status(500).json({ error: 'Failed to review request' });
  }
});


// An institution admin's own message to the platform owner — no student
// record required, unlike the profile-change-request escalation path above.
router.post('/api/admin/requests', authenticateToken, requireAdmin, async (req, res) => {
  const subject = String(req.body.subject || '').trim();
  const message = String(req.body.message || '').trim();
  if (!subject) return res.status(400).json({ error: 'subject is required' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const result = await pool.query(
      `INSERT INTO admin_requests (organization_id, admin_user_id, subject, message)
       VALUES ($1, $2, $3, $4) RETURNING id, subject, message, status, created_at`,
      [req.user.organizationId, req.user.userId, subject, message]
    );

    const [adminRes, orgRes] = await Promise.all([
      pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]),
      pool.query('SELECT name FROM organizations WHERE id = $1', [req.user.organizationId]),
    ]);
    const adminName = adminRes.rows[0]?.name || 'Administrator';
    const adminEmail = adminRes.rows[0]?.email || '';
    const orgName = orgRes.rows[0]?.name || 'Unknown organization';
    const superadminTarget = getSuperadminEmails()[0] || 'honorroll.admin@gmail.com';

    const { error: mailErr } = await sendEmail({
      to: superadminTarget,
      subject: `Admin Request — ${orgName}: ${subject}`,
      text: `${adminName} <${adminEmail}> from ${orgName} sent a request:\n\nSubject: ${subject}\n\n${message}\n\n— HonorRoll`,
    });
    if (mailErr) console.error('Admin request notification email error:', mailErr);

    res.status(201).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Create admin request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// An admin's own history of requests to the platform owner.
router.get('/api/admin/requests', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, subject, message, status, response_note, resolved_at, created_at
       FROM admin_requests WHERE organization_id = $1 ORDER BY created_at DESC`,
      [req.user.organizationId]
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('List admin requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});


// Public — the /contact page's submit target. No auth at all, unlike every
// other request/message route in this file: a prospective institution
// filling this out has no account yet. Rate-limited like every other
// public unauthenticated endpoint (see authLimiter's app.use registration
// near the top of this file) so it can't be used as an open spam relay.
router.post('/api/contact', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const mobile = String(req.body.mobile || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const message = String(req.body.message || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!mobile) return res.status(400).json({ error: 'Mobile number is required' });
  if (!email) return res.status(400).json({ error: 'Email is required' });
  if (!message) return res.status(400).json({ error: 'Message is required' });
  // Same "won't stop a typo, will stop garbage" bar as every other
  // free-text field in this app — no email deliverability is ever
  // verified beyond this shape check.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });

  try {
    const result = await pool.query(
      `INSERT INTO contact_messages (name, mobile, email, message) VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [name, mobile, email, message]
    );

    const superadminTarget = getSuperadminEmails()[0] || 'honorroll.admin@gmail.com';
    const { error: mailErr } = await sendEmail({
      to: superadminTarget,
      subject: `HonorRoll — New contact message from ${name}`,
      text: `${name} <${email}> (${mobile}) sent a message via the public contact form:\n\n${message}\n\n— HonorRoll`,
    });
    if (mailErr) console.error('Contact message notification email error:', mailErr);

    res.status(201).json({ message: 'Thanks — we\'ll be in touch soon.', id: result.rows[0].id });
  } catch (err) {
    console.error('Create contact message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});


// An admin's structured request to have someone else added as a co-admin
// of their own org — see ensureAddAdminRequestsSchema's own comment for why
// this needs its own table instead of the free-form admin_requests above.
router.post('/api/admin/add-admin-requests', authenticateToken, requireAdmin, async (req, res) => {
  const newAdminName = req.body.name != null ? String(req.body.name).trim() || null : null;
  const newAdminEmail = String(req.body.email || '').trim().toLowerCase();
  if (!newAdminEmail) return res.status(400).json({ error: 'email is required' });

  try {
    const result = await pool.query(
      `INSERT INTO add_admin_requests (organization_id, requested_by, new_admin_name, new_admin_email)
       VALUES ($1, $2, $3, $4) RETURNING id, new_admin_name, new_admin_email, status, created_at`,
      [req.user.organizationId, req.user.userId, newAdminName, newAdminEmail]
    );

    const [requesterRes, orgRes] = await Promise.all([
      pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]),
      pool.query('SELECT name FROM organizations WHERE id = $1', [req.user.organizationId]),
    ]);
    const requesterName = requesterRes.rows[0]?.name || 'An administrator';
    const requesterEmail = requesterRes.rows[0]?.email || '';
    const orgName = orgRes.rows[0]?.name || 'Unknown organization';
    const superadminTarget = getSuperadminEmails()[0] || 'honorroll.admin@gmail.com';

    const { error: mailErr } = await sendEmail({
      to: superadminTarget,
      subject: `Add-admin request — ${orgName}`,
      text: `${requesterName} <${requesterEmail}> from ${orgName} asked to have another admin added:\n\nName: ${newAdminName || '(not given)'}\nEmail: ${newAdminEmail}\n\n— HonorRoll`,
    });
    if (mailErr) console.error('Add-admin request notification email error:', mailErr);

    res.status(201).json({ request: result.rows[0] });
  } catch (err) {
    console.error('Create add-admin request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

router.get('/api/admin/add-admin-requests', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, new_admin_name, new_admin_email, status, review_note, reviewed_at, created_at
       FROM add_admin_requests WHERE organization_id = $1 ORDER BY created_at DESC`,
      [req.user.organizationId]
    );
    res.status(200).json({ requests: result.rows });
  } catch (err) {
    console.error('List add-admin requests error:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// ============================================================================
// GRADE BANDS — the global (not per-exam) configurable scale behind the
// individual exam score tag, e.g. "90-100 -> Excellent". Admin-only, in
// both who can edit it and who ever sees the resulting tag.
// ============================================================================
router.get('/api/admin/grade-bands', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, label, min_percent FROM grade_bands WHERE organization_id = $1 ORDER BY min_percent DESC', [req.user.organizationId]);
    res.status(200).json({ gradeBands: result.rows });
  } catch (err) {
    console.error('List grade bands error:', err);
    res.status(500).json({ error: 'Failed to load grade bands' });
  }
});

function validateGradeBandBody(body) {
  const label = String(body.label || '').trim();
  if (!label) throw new Error('Label is required');
  const minPercent = Number(body.minPercent);
  if (!Number.isFinite(minPercent) || minPercent < 0 || minPercent > 100) {
    throw new Error('Minimum percent must be between 0 and 100');
  }
  return { label, minPercent };
}

router.post('/api/admin/grade-bands', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { label, minPercent } = validateGradeBandBody(req.body);
    const result = await pool.query(
      'INSERT INTO grade_bands (label, min_percent, organization_id) VALUES ($1, $2, $3) RETURNING id, label, min_percent',
      [label, minPercent, req.user.organizationId]
    );
    res.status(201).json({ gradeBand: result.rows[0] });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create grade band' });
  }
});

router.put('/api/admin/grade-bands/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { label, minPercent } = validateGradeBandBody(req.body);
    const result = await pool.query(
      'UPDATE grade_bands SET label = $1, min_percent = $2 WHERE id = $3 AND organization_id = $4 RETURNING id, label, min_percent',
      [label, minPercent, req.params.id, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Grade band not found' });
    res.status(200).json({ gradeBand: result.rows[0] });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to update grade band' });
  }
});

router.delete('/api/admin/grade-bands/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM grade_bands WHERE id = $1 AND organization_id = $2 RETURNING id', [req.params.id, req.user.organizationId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Grade band not found' });
    res.status(200).json({ message: 'Grade band deleted' });
  } catch (err) {
    console.error('Delete grade band error:', err);
    res.status(500).json({ error: 'Failed to delete grade band' });
  }
});

// Per-organization switch for which of the two tags students ever see of
// their own results — teachers/admins always see both regardless of this
// setting; it only gates the student-facing /result routes (exams and assignments).
router.get('/api/admin/tag-visibility', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const settings = await getTagVisibility(req.user.organizationId);
    res.status(200).json({
      showPercentileTag: settings.show_percentile_tag,
      showGradeTag: settings.show_grade_tag,
    });
  } catch (err) {
    console.error('Get tag visibility error:', err);
    res.status(500).json({ error: 'Failed to load tag visibility settings' });
  }
});

router.put('/api/admin/tag-visibility', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE tag_visibility_settings SET show_percentile_tag = $1, show_grade_tag = $2 WHERE organization_id = $3
       RETURNING show_percentile_tag, show_grade_tag`,
      [!!req.body.showPercentileTag, !!req.body.showGradeTag, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tag visibility settings not found' });
    await invalidate(`tagvis:${req.user.organizationId}`);
    res.status(200).json({
      showPercentileTag: result.rows[0].show_percentile_tag,
      showGradeTag: result.rows[0].show_grade_tag,
    });
  } catch (err) {
    console.error('Update tag visibility error:', err);
    res.status(500).json({ error: 'Failed to update tag visibility settings' });
  }
});

module.exports = router;
