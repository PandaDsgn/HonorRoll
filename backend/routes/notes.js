// Teacher-posted subject notes routes — split out of index.js as part
// of breaking that monolith into modules. Pure relocation. Mounted
// with no prefix in index.js — every path below is the exact full
// path it always was.
const express = require('express');
const router = express.Router();
const { pool } = require('../lib/db');
const { authenticateToken, requireAdminOrTeacher } = require('../lib/auth');
const { getVisibleSubjectIds, getTeacherScope } = require('../lib/performance');
const { notesUpload } = require('../lib/uploads');
const { isB2Configured, notesObjectKey, uploadScanPdf, deleteScanPdf, getScanPdfUrl } = require('../storage');

// ============================================================================
// NOTES — teacher-posted subject media, six types (see ensureNotesSchema
// above for the visibility model and the full type list). Storage reuses
// the scan-PDF B2 helpers unchanged (uploadScanPdf/getScanPdfUrl/
// deleteScanPdf take an arbitrary object key + buffer + contentType and
// have no scan-specific logic in them) with notesObjectKey's own key prefix
// keeping the two features' objects apart in the bucket — only the four
// file-based types (pdf/image/video/audio) ever touch B2 at all; text and
// link notes are pure DB rows.
// ============================================================================
const NOTE_FILE_TYPES = new Set(['pdf', 'image', 'video', 'audio']);
const NOTE_TYPES = new Set(['pdf', 'image', 'video', 'audio', 'text', 'link']);
// Default extension when an uploaded file's own name has none (rare, but a
// mobile browser's camera/mic capture sometimes hands back an extension-
// less blob) — path.extname() on the original filename is tried first.
const NOTE_DEFAULT_EXT = { pdf: '.pdf', image: '.jpg', video: '.mp4', audio: '.mp3' };

// Shared by every route below that returns note rows — the four file types
// carry a presigned viewUrl (null if B2 isn't configured); text/link carry
// their payload directly (bodyText/externalUrl) and never touch B2 at all,
// so they always have a "view" regardless of whether storage is configured.
async function serializeNoteRow(row, b2Configured) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    title: row.title,
    type: row.type,
    createdAt: row.created_at,
    teacherName: row.teacher_name,
    bodyText: row.body_text,
    externalUrl: row.external_url,
    viewUrl: row.storage_key && b2Configured ? await getScanPdfUrl(row.storage_key) : null,
  };
}

// Subject dropdown shared by the teacher Uploads tab and the student Notes
// tab — same subject-visibility rules those roles already have elsewhere
// (getTeacherScope / getVisibleSubjectIds), just returned as a plain
// id+name list instead of folded into a bigger payload.
router.get('/api/notes/subjects', authenticateToken, async (req, res) => {
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
    console.error('List note subjects error:', err);
    res.status(500).json({ error: 'Failed to load subjects' });
  }
});

// A teacher's own Uploads panel — always scoped to their own uploads
// (teacher_id = caller), never a co-teacher's, since this is "my uploads,"
// not "my subject's uploads." subjectId/search are both optional filters;
// with neither, this is just everything they've ever uploaded, newest first.
router.get('/api/teacher/notes', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectId = req.query.subjectId ? Number(req.query.subjectId) : null;
  const search = String(req.query.search || '').trim();

  try {
    const params = [req.user.userId];
    let where = 'n.teacher_id = $1';
    if (subjectId) { params.push(subjectId); where += ` AND n.subject_id = $${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND n.title ILIKE $${params.length}`; }

    const result = await pool.query(
      `SELECT n.id, n.subject_id, s.name AS subject_name, n.title, n.type, n.storage_key, n.body_text, n.external_url, n.created_at
       FROM notes n JOIN subjects s ON s.id = n.subject_id
       WHERE ${where} ORDER BY n.created_at DESC`,
      params
    );
    const configured = isB2Configured();
    const notes = await Promise.all(result.rows.map((row) => serializeNoteRow(row, configured)));
    res.status(200).json({ notes });
  } catch (err) {
    console.error('List teacher notes error:', err);
    res.status(500).json({ error: 'Failed to load uploads' });
  }
});

router.post('/api/teacher/notes', authenticateToken, requireAdminOrTeacher, notesUpload.single('file'), async (req, res) => {
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  const title = String(req.body.title || '').trim();
  const type = String(req.body.type || '').trim();

  if (!subjectId) return res.status(400).json({ error: 'A subject is required' });
  if (!title) return res.status(400).json({ error: 'A title is required' });
  if (!NOTE_TYPES.has(type)) return res.status(400).json({ error: 'Invalid note type' });

  // Per-type payload validation — exactly one of {file, bodyText,
  // externalUrl} matters depending on type, matching notes_content_check's
  // own shape on the DB side.
  let bodyText = null;
  let externalUrl = null;
  if (NOTE_FILE_TYPES.has(type)) {
    if (!isB2Configured()) return res.status(503).json({ error: 'Notes storage is not configured yet' });
    if (!req.file) return res.status(400).json({ error: `A ${type} file is required` });
    const mimeOk = type === 'pdf' ? req.file.mimetype === 'application/pdf' : req.file.mimetype.startsWith(`${type}/`);
    if (!mimeOk) return res.status(400).json({ error: `That file doesn't look like a ${type}` });
  } else if (type === 'text') {
    bodyText = String(req.body.bodyText || '').trim();
    if (!bodyText) return res.status(400).json({ error: 'Note text is required' });
  } else if (type === 'link') {
    externalUrl = String(req.body.externalUrl || '').trim();
    let parsed;
    try {
      parsed = new URL(externalUrl);
    } catch {
      return res.status(400).json({ error: 'Enter a valid URL' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only http(s) links are allowed' });
    }
  }

  if (await enforceSubjectAuthority(req, res, subjectId)) return;

  try {
    // enforceSubjectAuthority already scopes a teacher's subject to their
    // own org via its own JOIN; this covers the admin bypass path, where
    // that check is a no-op — without it an admin request naming another
    // org's subject id would otherwise sail through to the insert below.
    const subject = await pool.query('SELECT id, name, org_unit_id FROM subjects WHERE id = $1 AND organization_id = $2', [subjectId, req.user.organizationId]);
    if (subject.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });

    // File-based types upload to B2 BEFORE the insert (notes_content_check
    // requires storage_key to already be non-empty on that first row — see
    // notesObjectKey's own comment for why there's no placeholder-row step
    // here the way scan_submissions has). Text/link never touch B2 at all.
    let storageKey = null;
    let originalFilename = null;
    if (req.file) {
      originalFilename = req.file.originalname;
      const ext = path.extname(req.file.originalname) || NOTE_DEFAULT_EXT[type] || '';
      storageKey = notesObjectKey(req.user.organizationId, subjectId, crypto.randomUUID(), ext);
      await uploadScanPdf(storageKey, req.file.buffer, req.file.mimetype);
    }

    const insertRes = await pool.query(
      `INSERT INTO notes (organization_id, subject_id, teacher_id, title, type, original_filename, storage_key, body_text, external_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
      [req.user.organizationId, subjectId, req.user.userId, title, type, originalFilename, storageKey, bodyText, externalUrl]
    );

    // Best-effort, same "continuing anyway" posture as the delete-on-B2
    // path below — a notification fan-out failing shouldn't fail the
    // upload the teacher is actively waiting on. Same descendant-units walk
    // getTeacherScope uses (a note on a Department-tier subject reaches
    // every Year beneath it, not just students in the subject's own exact
    // unit), just seeded from this one subject's org_unit_id instead of a
    // teacher's whole subject list.
    try {
      await pool.query(
        `WITH RECURSIVE descendant_units AS (
           SELECT id FROM org_units WHERE id = $1
           UNION
           SELECT ou.id FROM org_units ou JOIN descendant_units d ON ou.parent_unit_id = d.id
         )
         INSERT INTO notifications (organization_id, user_id, type, title, body, note_id)
         SELECT $2, m.user_id, 'note', $3, $4, $5
         FROM memberships m
         WHERE m.organization_id = $2 AND m.role = 'student' AND m.org_unit_id IN (SELECT id FROM descendant_units)`,
        [subject.rows[0].org_unit_id, req.user.organizationId, title, `New ${type} in ${subject.rows[0].name}`, insertRes.rows[0].id]
      );
    } catch (err) {
      console.error('Failed to notify students of new note (continuing anyway):', err);
    }

    res.status(201).json({ id: insertRes.rows[0].id, createdAt: insertRes.rows[0].created_at });
  } catch (err) {
    console.error('Upload note error:', err);
    res.status(500).json({ error: 'Failed to upload note' });
  }
});

router.delete('/api/teacher/notes/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const existing = await pool.query('SELECT storage_key FROM notes WHERE id = $1 AND teacher_id = $2', [req.params.id, req.user.userId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Note not found' });

    await pool.query('DELETE FROM notes WHERE id = $1', [req.params.id]);
    if (existing.rows[0].storage_key) {
      try {
        await deleteScanPdf(existing.rows[0].storage_key);
      } catch (err) {
        console.error('Failed to delete note PDF (continuing anyway):', err);
      }
    }
    res.status(200).json({ message: 'Note deleted' });
  } catch (err) {
    console.error('Delete note error:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// Student-facing Notes tab. subjectId picks one subject's notes
// (recent-first, per the ask); search narrows by title and — unlike
// subjectId — works across every subject visible to the student, so
// "search up a specific pdf" doesn't first require knowing which subject
// it lives under. At least one of the two is required so this can never
// turn into "dump every note in every subject I can see."
router.get('/api/notes', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Not available for this role' });

  const subjectId = req.query.subjectId ? Number(req.query.subjectId) : null;
  const search = String(req.query.search || '').trim();
  if (!subjectId && !search) return res.status(400).json({ error: 'A subject or search term is required' });

  try {
    const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
    if (subjectId && !visibleSubjectIds.includes(subjectId)) return res.status(404).json({ error: 'Subject not found' });
    if (visibleSubjectIds.length === 0) return res.status(200).json({ notes: [] });

    const scopeIds = subjectId ? [subjectId] : visibleSubjectIds;
    const params = [scopeIds];
    let where = 'n.subject_id = ANY($1::int[])';
    if (search) { params.push(`%${search}%`); where += ` AND n.title ILIKE $${params.length}`; }

    const result = await pool.query(
      `SELECT n.id, n.subject_id, s.name AS subject_name, n.title, n.type, n.storage_key, n.body_text, n.external_url, n.created_at, u.name AS teacher_name
       FROM notes n JOIN subjects s ON s.id = n.subject_id JOIN users u ON u.id = n.teacher_id
       WHERE ${where} ORDER BY n.created_at DESC`,
      params
    );
    const configured = isB2Configured();
    const notes = await Promise.all(result.rows.map((row) => serializeNoteRow(row, configured)));
    res.status(200).json({ notes });
  } catch (err) {
    console.error('List notes error:', err);
    res.status(500).json({ error: 'Failed to load notes' });
  }
});

module.exports = router;
