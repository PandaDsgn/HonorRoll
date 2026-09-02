// Admin-posted org-wide notice routes — split out of index.js as part
// of breaking that monolith into modules. Pure relocation. Mounted
// with no prefix in index.js — every path below is the exact full
// path it always was.
const express = require('express');
const router = express.Router();
const { pool } = require('../lib/db');
const { authenticateToken, requireAdmin } = require('../lib/auth');
const { notesUpload } = require('../lib/uploads');
const { isB2Configured, noticesObjectKey, uploadScanPdf, deleteScanPdf, getScanPdfUrl } = require('../storage');
const { createNotificationsBulk } = require('../lib/notifications');


// ============================================================================
// NOTICES — admin-posted, org-wide media (see ensureNoticesSchema above for
// the type list and visibility model). No subject, no per-poster scoping on
// the list route — unlike teacher notes' personal Uploads panel, every
// admin in the org manages the SAME shared list, and every member of the
// org (any role) reads it via the one GET route below.
// ============================================================================
const NOTICE_FILE_TYPES = new Set(['pdf', 'image']);
const NOTICE_TYPES = new Set(['pdf', 'image', 'text', 'link']);

async function serializeNoticeRow(row, b2Configured) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    createdAt: row.created_at,
    bodyText: row.body_text,
    externalUrl: row.external_url,
    viewUrl: row.storage_key && b2Configured ? await getScanPdfUrl(row.storage_key) : null,
  };
}

// Any authenticated org member reads this — students, teachers, and admins
// alike, per notices' own org-wide visibility (no subject/unit scoping to
// enforce, unlike GET /api/notes). search narrows by title, same ILIKE
// convention as every other search box in this feature.
router.get('/api/notices', authenticateToken, async (req, res) => {
  const search = String(req.query.search || '').trim();
  try {
    const params = [req.user.organizationId];
    let where = 'organization_id = $1';
    if (search) { params.push(`%${search}%`); where += ` AND title ILIKE $${params.length}`; }

    const result = await pool.query(
      `SELECT id, title, type, storage_key, body_text, external_url, created_at
       FROM notices WHERE ${where} ORDER BY created_at DESC LIMIT 100`,
      params
    );
    const configured = isB2Configured();
    const notices = await Promise.all(result.rows.map((row) => serializeNoticeRow(row, configured)));
    res.status(200).json({ notices });
  } catch (err) {
    console.error('List notices error:', err);
    res.status(500).json({ error: 'Failed to load notices' });
  }
});

router.post('/api/admin/notices', authenticateToken, requireAdmin, notesUpload.single('file'), async (req, res) => {
  const title = String(req.body.title || '').trim();
  const type = String(req.body.type || '').trim();
  if (!title) return res.status(400).json({ error: 'A title is required' });
  if (!NOTICE_TYPES.has(type)) return res.status(400).json({ error: 'Invalid notice type' });

  let bodyText = null;
  let externalUrl = null;
  if (NOTICE_FILE_TYPES.has(type)) {
    if (!isB2Configured()) return res.status(503).json({ error: 'Notice storage is not configured yet' });
    if (!req.file) return res.status(400).json({ error: `A ${type} file is required` });
    const mimeOk = type === 'pdf' ? req.file.mimetype === 'application/pdf' : req.file.mimetype.startsWith('image/');
    if (!mimeOk) return res.status(400).json({ error: `That file doesn't look like a ${type}` });
  } else if (type === 'text') {
    bodyText = String(req.body.bodyText || '').trim();
    if (!bodyText) return res.status(400).json({ error: 'Notice text is required' });
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

  try {
    let storageKey = null;
    let originalFilename = null;
    if (req.file) {
      originalFilename = req.file.originalname;
      const ext = path.extname(req.file.originalname) || NOTE_DEFAULT_EXT[type] || '';
      storageKey = noticesObjectKey(req.user.organizationId, crypto.randomUUID(), ext);
      await uploadScanPdf(storageKey, req.file.buffer, req.file.mimetype);
    }

    const insertRes = await pool.query(
      `INSERT INTO notices (organization_id, admin_id, title, type, original_filename, storage_key, body_text, external_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
      [req.user.organizationId, req.user.userId, title, type, originalFilename, storageKey, bodyText, externalUrl]
    );

    // Best-effort, same posture as POST /api/teacher/notes' own fan-out —
    // every student AND teacher in the org (not admins; the poster's fellow
    // admins already see it directly in their own shared notices list, same
    // as the poster does, with no separate bell needed for that).
    try {
      await createNotificationsBulk({
        selectSql: `SELECT m.user_id FROM memberships m WHERE m.organization_id = $1 AND m.role IN ('student', 'teacher')`,
        selectParams: [req.user.organizationId],
        organizationId: req.user.organizationId,
        type: 'notice',
        title,
        body: 'New notice posted',
        extraColumn: 'notice_id',
        extraId: insertRes.rows[0].id,
      });
    } catch (err) {
      console.error('Failed to notify org of new notice (continuing anyway):', err);
    }

    res.status(201).json({ id: insertRes.rows[0].id, createdAt: insertRes.rows[0].created_at });
  } catch (err) {
    console.error('Post notice error:', err);
    res.status(500).json({ error: 'Failed to post notice' });
  }
});

// Not scoped to admin_id — any admin in the org can remove any notice, same
// "one shared list, jointly managed" posture GET /api/notices already has.
router.delete('/api/admin/notices/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const existing = await pool.query('SELECT storage_key FROM notices WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Notice not found' });

    await pool.query('DELETE FROM notices WHERE id = $1', [req.params.id]);
    if (existing.rows[0].storage_key) {
      try {
        await deleteScanPdf(existing.rows[0].storage_key);
      } catch (err) {
        console.error('Failed to delete notice file (continuing anyway):', err);
      }
    }
    res.status(200).json({ message: 'Notice deleted' });
  } catch (err) {
    console.error('Delete notice error:', err);
    res.status(500).json({ error: 'Failed to delete notice' });
  }
});

module.exports = router;
