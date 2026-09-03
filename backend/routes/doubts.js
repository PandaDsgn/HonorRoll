// Doubts routes — a student's question addressed to a SUBJECT, not a
// teacher. See ensureDoubtsSchema in schema/index.js for the full model:
// by default every teacher of that subject can see and answer it
// (teacher_id NULL); a student can optionally narrow it to one specific
// teacher at ask-time, in which case only that teacher — never a
// co-teacher — can see and answer it. Broad on the asking side regardless:
// any student who can see the subject can browse every doubt in it, asker
// identity redacted unless it's their own, so they can check "has this
// already been answered" before posting a near-duplicate.
const express = require('express');
const router = express.Router();
const path = require('path');
const { pool } = require('../lib/db');
const { authenticateToken, requireAdminOrTeacher } = require('../lib/auth');
const { getVisibleSubjectIds, getTeacherScope } = require('../lib/performance');
const { notesUpload } = require('../lib/uploads');
const { isB2Configured, doubtsObjectKey, uploadScanPdf, getScanPdfUrl } = require('../storage');
const { createNotification } = require('../lib/notifications');

const ATTACHMENT_DEFAULT_EXT = { photo: '.jpg', video: '.mp4', document: '.pdf' };

// Simple word-overlap ranking for the "have I seen this before" duplicate
// check (GET /api/doubts/similar) — same shingle/set-overlap idea as
// lib/plagiarism.js's jaccardSimilarity, just over whole words instead of
// code tokens. Deliberately not a Postgres full-text/trigram search: this
// is the only place in the app that would need it, and pulling in an
// extension (pg_trgm) for one feature isn't worth the added boot-time
// dependency when a per-subject doubt board is realistically a few dozen
// to a few hundred rows — fetching them all and ranking in JS is plenty
// fast at that scale.
function tokenize(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}
function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Shared by every route that returns a doubt row to a student who isn't
// necessarily its asker — the identity redaction the whole feature's
// visibility model hinges on. `viewerIsOwnerOrTeacher` is computed by the
// caller (it depends on who's asking, not anything about the row itself).
async function serializeDoubtRow(row, viewerIsOwnerOrTeacher, b2Configured) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    teacherName: row.teacher_name,
    askerName: viewerIsOwnerOrTeacher ? (row.student_name || row.student_email) : null,
    isMine: !!row.is_mine,
    questionText: row.question_text,
    attachmentType: row.attachment_type,
    attachmentUrl: row.storage_key && b2Configured ? await getScanPdfUrl(row.storage_key) : null,
    status: row.status,
    createdAt: row.created_at,
  };
}

// Subject dropdown, shared by the student "ask/browse" flow and the
// teacher's own queue filter — same role-branch shape as GET
// /api/notes/subjects.
router.get('/api/doubts/subjects', authenticateToken, async (req, res) => {
  try {
    let subjectIds;
    if (req.user.role === 'teacher') {
      subjectIds = (await getTeacherScope(req.user.userId, req.user.organizationId)).subjectIds;
    } else if (req.user.role === 'student') {
      subjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
    } else {
      return res.status(403).json({ error: 'Not available for this role' });
    }
    if (subjectIds.length === 0) return res.status(200).json({ subjects: [] });

    const result = await pool.query(
      `SELECT s.id, s.name, u.name AS org_unit_name FROM subjects s JOIN org_units u ON u.id = s.org_unit_id
       WHERE s.id = ANY($1::int[]) ORDER BY s.name ASC`,
      [subjectIds]
    );
    res.status(200).json({ subjects: result.rows });
  } catch (err) {
    console.error('List doubt subjects error:', err);
    res.status(500).json({ error: 'Failed to load subjects' });
  }
});

// Teacher picker for the "ask a doubt" compose form — every teacher
// assigned to the chosen subject, in case a student wants to narrow the
// doubt to one specific teacher instead of leaving it open to all of them
// (the default — see POST /api/doubts below).
router.get('/api/doubts/subjects/:subjectId/teachers', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Not available for this role' });
  const subjectId = Number(req.params.subjectId);

  try {
    const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
    if (!visibleSubjectIds.includes(subjectId)) return res.status(404).json({ error: 'Subject not found' });

    const result = await pool.query(
      `SELECT u.id, u.name, u.email FROM subject_teachers st JOIN users u ON u.id = st.user_id
       WHERE st.subject_id = $1 ORDER BY u.name ASC NULLS LAST, u.email ASC`,
      [subjectId]
    );
    res.status(200).json({ teachers: result.rows });
  } catch (err) {
    console.error('List subject teachers error:', err);
    res.status(500).json({ error: 'Failed to load teachers' });
  }
});

// The public per-subject board — every doubt asked in this subject,
// regardless of which teacher it went to, so a student can browse (or
// search) for one that already covers theirs. Student-only: a teacher only
// ever sees their OWN queue (GET /api/teacher/doubts below), never this
// broader cross-teacher view — see this feature's own visibility comment
// in schema/index.js.
router.get('/api/doubts', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Not available for this role' });

  const subjectId = Number(req.query.subjectId);
  const search = String(req.query.search || '').trim();
  if (!subjectId) return res.status(400).json({ error: 'A subject is required' });

  try {
    const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
    if (!visibleSubjectIds.includes(subjectId)) return res.status(404).json({ error: 'Subject not found' });

    const params = [subjectId, req.user.userId];
    let where = 'd.subject_id = $1';
    if (search) { params.push(`%${search}%`); where += ` AND d.question_text ILIKE $${params.length}`; }

    const result = await pool.query(
      `SELECT d.id, d.subject_id, s.name AS subject_name, d.question_text, d.attachment_type, d.storage_key,
              d.status, d.created_at, d.student_id, teacher.name AS teacher_name,
              student.name AS student_name, student.email AS student_email,
              (d.student_id = $2) AS is_mine
       FROM doubts d
       JOIN subjects s ON s.id = d.subject_id
       LEFT JOIN users teacher ON teacher.id = d.teacher_id
       JOIN users student ON student.id = d.student_id
       WHERE ${where}
       ORDER BY d.created_at DESC`,
      params
    );
    const configured = isB2Configured();
    const doubts = await Promise.all(result.rows.map((row) => serializeDoubtRow(row, row.is_mine, configured)));
    res.status(200).json({ doubts });
  } catch (err) {
    console.error('List doubts error:', err);
    res.status(500).json({ error: 'Failed to load doubts' });
  }
});

// "Have I seen this before" — ranks every doubt already asked in this
// subject against the student's in-progress draft question text, top
// matches first. Called from the compose form before the actual POST, not
// a hard gate: the student can always post anyway (see the frontend's own
// "post anyway" step) — this only ever surfaces candidates, it never
// blocks anything server-side.
router.get('/api/doubts/similar', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Not available for this role' });

  const subjectId = Number(req.query.subjectId);
  const q = String(req.query.q || '').trim();
  if (!subjectId || !q) return res.status(200).json({ doubts: [] });

  try {
    const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
    if (!visibleSubjectIds.includes(subjectId)) return res.status(404).json({ error: 'Subject not found' });

    const result = await pool.query(
      `SELECT d.id, d.question_text, d.status, d.created_at,
              (SELECT r.body_text FROM doubt_replies r WHERE r.doubt_id = d.id AND r.author_role = 'teacher' ORDER BY r.created_at ASC LIMIT 1) AS first_teacher_reply
       FROM doubts d WHERE d.subject_id = $1`,
      [subjectId]
    );

    const queryTokens = tokenize(q);
    const ranked = result.rows
      .map((row) => ({ row, score: jaccardSimilarity(queryTokens, tokenize(row.question_text)) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ row }) => ({
        id: row.id,
        questionText: row.question_text,
        status: row.status,
        firstTeacherReply: row.first_teacher_reply,
        createdAt: row.created_at,
      }));

    res.status(200).json({ doubts: ranked });
  } catch (err) {
    console.error('Similar doubts error:', err);
    res.status(500).json({ error: 'Failed to search doubts' });
  }
});

// A student's own "my doubts" tracker — every doubt they've personally
// asked, any subject, own identity never redacted since it's all theirs.
router.get('/api/doubts/mine', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Not available for this role' });

  try {
    const result = await pool.query(
      `SELECT d.id, d.subject_id, s.name AS subject_name, d.question_text, d.attachment_type, d.storage_key,
              d.status, d.created_at, teacher.name AS teacher_name
       FROM doubts d JOIN subjects s ON s.id = d.subject_id LEFT JOIN users teacher ON teacher.id = d.teacher_id
       WHERE d.student_id = $1 ORDER BY d.created_at DESC`,
      [req.user.userId]
    );
    const configured = isB2Configured();
    const doubts = await Promise.all(result.rows.map(async (row) => ({
      id: row.id,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      teacherName: row.teacher_name,
      questionText: row.question_text,
      attachmentType: row.attachment_type,
      attachmentUrl: row.storage_key && configured ? await getScanPdfUrl(row.storage_key) : null,
      status: row.status,
      createdAt: row.created_at,
    })));
    res.status(200).json({ doubts });
  } catch (err) {
    console.error('List my doubts error:', err);
    res.status(500).json({ error: 'Failed to load your doubts' });
  }
});

// A teacher's own queue — every doubt addressed specifically to them, PLUS
// every unaddressed (teacher_id IS NULL) doubt in a subject they teach —
// never a doubt that was narrowed to a co-teacher instead. Real student
// identity always visible (the redaction rule is a student-board thing
// only — see this feature's own comment in schema/index.js).
// requireAdminOrTeacher (not teacher-only) matches GET /api/teacher/notes'
// own posture: an admin hitting this just gets their own (typically empty)
// result, scoped by their own teaching subjects either way.
router.get('/api/teacher/doubts', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectId = req.query.subjectId ? Number(req.query.subjectId) : null;
  const status = req.query.status ? String(req.query.status) : null;

  try {
    const mySubjectIds = (await getTeacherScope(req.user.userId, req.user.organizationId)).subjectIds;

    const params = [req.user.userId, mySubjectIds];
    let where = '(d.teacher_id = $1 OR (d.teacher_id IS NULL AND d.subject_id = ANY($2::int[])))';
    if (subjectId) { params.push(subjectId); where += ` AND d.subject_id = $${params.length}`; }
    if (status) { params.push(status); where += ` AND d.status = $${params.length}`; }

    const result = await pool.query(
      `SELECT d.id, d.subject_id, s.name AS subject_name, d.question_text, d.attachment_type, d.storage_key,
              d.status, d.created_at, d.teacher_id, student.name AS student_name, student.email AS student_email
       FROM doubts d JOIN subjects s ON s.id = d.subject_id JOIN users student ON student.id = d.student_id
       WHERE ${where}
       ORDER BY (d.status = 'open') DESC, d.created_at DESC`,
      params
    );
    const configured = isB2Configured();
    const doubts = await Promise.all(result.rows.map(async (row) => ({
      id: row.id,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      studentName: row.student_name || row.student_email,
      addressedToMe: row.teacher_id === req.user.userId,
      questionText: row.question_text,
      attachmentType: row.attachment_type,
      attachmentUrl: row.storage_key && configured ? await getScanPdfUrl(row.storage_key) : null,
      status: row.status,
      createdAt: row.created_at,
    })));
    res.status(200).json({ doubts });
  } catch (err) {
    console.error('List teacher doubts error:', err);
    res.status(500).json({ error: 'Failed to load doubts' });
  }
});

// Shared by GET /api/doubts/:id and POST /api/doubts/:id/replies — a
// teacher may act on a doubt if it's addressed specifically to them, OR if
// it's unaddressed (open to the whole subject) and they teach that
// subject. Neither route needs to distinguish which case applied, only
// whether one of them did.
async function teacherCanAccessDoubt(teacherUserId, doubtTeacherId, subjectId) {
  if (doubtTeacherId === teacherUserId) return true;
  if (doubtTeacherId !== null) return false;
  const check = await pool.query('SELECT 1 FROM subject_teachers WHERE subject_id = $1 AND user_id = $2', [subjectId, teacherUserId]);
  return check.rows.length > 0;
}

// Full thread detail — the one route both a browsing (non-owner) student
// and an eligible teacher share, with different redaction depending on
// which. A student who is neither the asker nor viewing a subject they can
// see gets 404; a teacher who isn't eligible (see teacherCanAccessDoubt
// above) gets 403 (they're not missing context the way a 404 implies —
// they just aren't allowed here, same "403 not 404" reasoning as
// enforceSubjectAuthority's own comment).
router.get('/api/doubts/:id', authenticateToken, async (req, res) => {
  const doubtId = Number(req.params.id);

  try {
    const doubtRes = await pool.query(
      `SELECT d.*, s.name AS subject_name, teacher.name AS teacher_name,
              student.name AS student_name, student.email AS student_email
       FROM doubts d
       JOIN subjects s ON s.id = d.subject_id
       LEFT JOIN users teacher ON teacher.id = d.teacher_id
       JOIN users student ON student.id = d.student_id
       WHERE d.id = $1`,
      [doubtId]
    );
    if (doubtRes.rows.length === 0) return res.status(404).json({ error: 'Doubt not found' });
    const row = doubtRes.rows[0];

    let viewerIsOwnerOrTeacher;
    if (req.user.role === 'student') {
      const isOwner = row.student_id === req.user.userId;
      if (!isOwner) {
        const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
        if (!visibleSubjectIds.includes(row.subject_id)) return res.status(404).json({ error: 'Doubt not found' });
      }
      viewerIsOwnerOrTeacher = isOwner;
    } else if (req.user.role === 'teacher') {
      if (!(await teacherCanAccessDoubt(req.user.userId, row.teacher_id, row.subject_id))) {
        return res.status(403).json({ error: 'Not your doubt to view' });
      }
      viewerIsOwnerOrTeacher = true;
    } else {
      return res.status(403).json({ error: 'Not available for this role' });
    }

    const repliesRes = await pool.query(
      `SELECT r.id, r.author_role, r.body_text, r.created_at, u.name AS author_name, u.email AS author_email
       FROM doubt_replies r JOIN users u ON u.id = r.author_id
       WHERE r.doubt_id = $1 ORDER BY r.created_at ASC`,
      [doubtId]
    );
    const replies = repliesRes.rows.map((r) => ({
      id: r.id,
      authorRole: r.author_role,
      // A reply's author is only ever the doubt's own teacher or its own
      // asker (see POST /api/doubts/:id/replies) — same redaction rule as
      // the doubt itself: real name for the teacher (never sensitive),
      // "Anonymous" for the student unless the viewer IS that student.
      authorName: r.author_role === 'teacher' ? (r.author_name || r.author_email) : (viewerIsOwnerOrTeacher ? (r.author_name || r.author_email) : 'Anonymous'),
      bodyText: r.body_text,
      createdAt: r.created_at,
    }));

    const configured = isB2Configured();
    const doubt = await serializeDoubtRow({ ...row, is_mine: row.student_id === req.user.userId }, viewerIsOwnerOrTeacher, configured);
    res.status(200).json({ doubt, replies });
  } catch (err) {
    console.error('Get doubt error:', err);
    res.status(500).json({ error: 'Failed to load doubt' });
  }
});

// Ask a new doubt — student only, multipart (an optional photo/video rides
// alongside the required question text). teacherId is OPTIONAL: leave it
// out and every teacher of this subject can see and answer the doubt
// (the default); name one and only that teacher can, PROVIDED they
// actually teach this subject (subject_teachers) — otherwise a student
// could route a doubt to any teacher in the org, not just one who teaches
// this subject.
router.post('/api/doubts', authenticateToken, notesUpload.single('file'), async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Not available for this role' });

  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  const teacherId = String(req.body.teacherId || '').trim() || null;
  const questionText = String(req.body.questionText || '').trim();

  if (!subjectId) return res.status(400).json({ error: 'A subject is required' });
  if (!questionText) return res.status(400).json({ error: 'A question is required' });

  let attachmentType = 'none';
  if (req.file) {
    if (req.file.mimetype.startsWith('image/')) attachmentType = 'photo';
    else if (req.file.mimetype.startsWith('video/')) attachmentType = 'video';
    else if (req.file.mimetype === 'application/pdf') attachmentType = 'document';
    else return res.status(400).json({ error: 'Attachments must be a photo, a video, or a PDF' });
    if (!isB2Configured()) return res.status(503).json({ error: 'Attachment storage is not configured yet' });
  }

  try {
    const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
    if (!visibleSubjectIds.includes(subjectId)) return res.status(404).json({ error: 'Subject not found' });

    const subjectRes = await pool.query('SELECT name FROM subjects WHERE id = $1', [subjectId]);
    const subjectName = subjectRes.rows[0].name;

    if (teacherId) {
      const teacherCheck = await pool.query(
        'SELECT 1 FROM subject_teachers WHERE subject_id = $1 AND user_id = $2',
        [subjectId, teacherId]
      );
      if (teacherCheck.rows.length === 0) return res.status(400).json({ error: "That teacher doesn't teach this subject" });
    }

    let storageKey = null;
    let originalFilename = null;
    if (req.file) {
      originalFilename = req.file.originalname;
      const ext = path.extname(req.file.originalname) || ATTACHMENT_DEFAULT_EXT[attachmentType] || '';
      storageKey = doubtsObjectKey(req.user.organizationId, subjectId, crypto.randomUUID(), ext);
      await uploadScanPdf(storageKey, req.file.buffer, req.file.mimetype);
    }

    const insertRes = await pool.query(
      `INSERT INTO doubts (organization_id, subject_id, student_id, teacher_id, question_text, attachment_type, original_filename, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
      [req.user.organizationId, subjectId, req.user.userId, teacherId, questionText, attachmentType, originalFilename, storageKey]
    );
    const doubtId = insertRes.rows[0].id;

    // Every teacher of this subject gets a heads-up, addressed or not — if
    // it was narrowed to one teacher, the rest can't open it themselves
    // (see teacherCanAccessDoubt above), but "a doubt came in for this
    // subject" is still useful for them to know at a glance. A named
    // teacherId is itself always one of subjectTeachers (checked above), so
    // no separate insert for them is needed either way.
    try {
      const subjectTeachers = await pool.query('SELECT user_id FROM subject_teachers WHERE subject_id = $1', [subjectId]);
      const title = `New doubt in ${subjectName}`;
      const body = questionText.slice(0, 200);
      await Promise.all(subjectTeachers.rows.map((t) => createNotification({
        organizationId: req.user.organizationId, userId: t.user_id, type: 'doubt', title, body, doubtId,
      })));
    } catch (err) {
      console.error('Failed to notify teachers of new doubt (continuing anyway):', err);
    }

    res.status(201).json({ id: doubtId, createdAt: insertRes.rows[0].created_at });
  } catch (err) {
    console.error('Post doubt error:', err);
    res.status(500).json({ error: 'Failed to post doubt' });
  }
});

// Reply to a doubt — either the doubt's own asker or an eligible teacher
// (see teacherCanAccessDoubt above), nobody else, same ownership rule GET
// /api/doubts/:id enforces for viewing. A teacher reply marks the doubt
// 'answered'; a student follow-up reopens it to 'open' — the assumption
// being a follow-up means the answer didn't fully resolve it, so it should
// resurface in the open queue rather than sit answered-but-not-really.
router.post('/api/doubts/:id/replies', authenticateToken, async (req, res) => {
  const doubtId = Number(req.params.id);
  const bodyText = String(req.body.bodyText || '').trim();
  if (!bodyText) return res.status(400).json({ error: 'A reply is required' });

  try {
    const doubtRes = await pool.query('SELECT student_id, teacher_id, subject_id FROM doubts WHERE id = $1', [doubtId]);
    if (doubtRes.rows.length === 0) return res.status(404).json({ error: 'Doubt not found' });
    const doubt = doubtRes.rows[0];

    let authorRole;
    let notifyUserIds;
    if (req.user.role === 'student' && doubt.student_id === req.user.userId) {
      authorRole = 'student';
      // Addressed doubt -> just that one teacher. Unaddressed -> every
      // teacher of the subject, same fan-out as the original post's own
      // notification (a single NULL teacher_id has nobody to notify on
      // its own).
      if (doubt.teacher_id) {
        notifyUserIds = [doubt.teacher_id];
      } else {
        const subjectTeachers = await pool.query('SELECT user_id FROM subject_teachers WHERE subject_id = $1', [doubt.subject_id]);
        notifyUserIds = subjectTeachers.rows.map((t) => t.user_id);
      }
    } else if (req.user.role === 'teacher' && await teacherCanAccessDoubt(req.user.userId, doubt.teacher_id, doubt.subject_id)) {
      authorRole = 'teacher';
      notifyUserIds = [doubt.student_id];
    } else {
      return res.status(403).json({ error: 'Not your doubt to reply to' });
    }

    await pool.query(
      'INSERT INTO doubt_replies (doubt_id, author_id, author_role, body_text) VALUES ($1, $2, $3, $4)',
      [doubtId, req.user.userId, authorRole, bodyText]
    );
    await pool.query('UPDATE doubts SET status = $1 WHERE id = $2', [authorRole === 'teacher' ? 'answered' : 'open', doubtId]);

    try {
      const title = authorRole === 'teacher' ? 'Your doubt got a reply' : 'A student followed up on their doubt';
      const body = bodyText.slice(0, 200);
      await Promise.all(notifyUserIds.map((userId) => createNotification({
        organizationId: req.user.organizationId, userId, type: 'doubt', title, body, doubtId,
      })));
    } catch (err) {
      console.error('Failed to notify of doubt reply (continuing anyway):', err);
    }

    res.status(201).json({ message: 'Reply posted' });
  } catch (err) {
    console.error('Reply to doubt error:', err);
    res.status(500).json({ error: 'Failed to post reply' });
  }
});

module.exports = router;
