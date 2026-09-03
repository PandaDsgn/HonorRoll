// Encrypted chat routes — a private 1:1 channel between a student and a
// teacher of a subject they're enrolled in. See ensureChatMessagesSchema /
// ensureE2eeKeysSchema in schema/index.js for the full model: this server
// stores public keys, password-wrapped private key blobs, and message
// ciphertext, but never a private key in the clear or message plaintext —
// every encrypt/decrypt happens in the browser (frontend/src/lib/e2ee.js).
const express = require('express');
const router = express.Router();
const { pool } = require('../lib/db');
const { authenticateToken, requireAdmin } = require('../lib/auth');
const { getVisibleSubjectIds, getTeacherScope } = require('../lib/performance');
const { sendToUser } = require('../lib/realtime');
const { createNotification, createNotificationsBulk } = require('../lib/notifications');
const { notesUpload } = require('../lib/uploads');
const { isB2Configured, chatObjectKey, uploadScanPdf, downloadScanPdf } = require('../storage');

const MESSAGE_TYPES = new Set(['text', 'photo', 'video', 'voice', 'document']);

// Mirrors routes/doubts.js's teacherCanAccessDoubt in spirit — the same
// subject_teachers-based relationship decides who's allowed to message
// whom, just checked in both directions here (a doubt has one clear
// asker/answerer; a chat contact list is symmetric). `me` is req.user
// (userId/role/organizationId/orgUnitId); otherUserId is a UUID string.
async function canChat(me, otherUserId) {
  const otherRes = await pool.query(
    'SELECT role, org_unit_id FROM memberships WHERE user_id = $1 AND organization_id = $2',
    [otherUserId, me.organizationId]
  );
  if (otherRes.rows.length === 0) return false;
  const other = otherRes.rows[0];

  if (me.role === 'student' && other.role === 'teacher') {
    const visibleSubjectIds = await getVisibleSubjectIds(me.orgUnitId);
    if (visibleSubjectIds.length === 0) return false;
    const check = await pool.query(
      'SELECT 1 FROM subject_teachers WHERE subject_id = ANY($1::int[]) AND user_id = $2',
      [visibleSubjectIds, otherUserId]
    );
    return check.rows.length > 0;
  }
  if (me.role === 'teacher' && other.role === 'student') {
    const { unitIds } = await getTeacherScope(me.userId, me.organizationId);
    return unitIds.includes(other.org_unit_id);
  }
  return false;
}

// Contact list — every teacher of a subject the caller (a student) can
// see, or every student in a subject the caller (a teacher) teaches.
// Each contact's public key rides along so the client can derive a shared
// secret with them immediately, without a second round trip per contact.
router.get('/api/chat/contacts', authenticateToken, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'student') {
      const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
      result = visibleSubjectIds.length === 0 ? { rows: [] } : await pool.query(
        `SELECT DISTINCT u.id, u.name, u.email, k.public_key_jwk
         FROM subject_teachers st JOIN users u ON u.id = st.user_id
         LEFT JOIN user_e2ee_keys k ON k.user_id = u.id
         WHERE st.subject_id = ANY($1::int[])
         ORDER BY u.name ASC NULLS LAST, u.email ASC`,
        [visibleSubjectIds]
      );
    } else if (req.user.role === 'teacher') {
      const { unitIds } = await getTeacherScope(req.user.userId, req.user.organizationId);
      result = unitIds.length === 0 ? { rows: [] } : await pool.query(
        `SELECT DISTINCT u.id, u.name, u.email, k.public_key_jwk
         FROM users u JOIN memberships m ON m.user_id = u.id
         LEFT JOIN user_e2ee_keys k ON k.user_id = u.id
         WHERE m.organization_id = $1 AND m.role = 'student' AND m.org_unit_id = ANY($2::int[])
         ORDER BY u.name ASC NULLS LAST, u.email ASC`,
        [req.user.organizationId, unitIds]
      );
    } else {
      return res.status(403).json({ error: 'Not available for this role' });
    }

    res.status(200).json({
      contacts: result.rows.map((r) => ({ id: r.id, name: r.name || r.email, email: r.email, publicKeyJwk: r.public_key_jwk })),
    });
  } catch (err) {
    console.error('List chat contacts error:', err);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

// Own key blob — fetched right after login so the client can unwrap its
// private key (or find out it needs to generate one for the first time).
router.get('/api/chat/keys/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT public_key_jwk, wrapped_private_key, wrap_salt, wrap_iv FROM user_e2ee_keys WHERE user_id = $1',
      [req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No keys set up yet' });
    const row = result.rows[0];
    res.status(200).json({
      publicKeyJwk: row.public_key_jwk,
      wrappedPrivateKey: row.wrapped_private_key,
      wrapSalt: row.wrap_salt,
      wrapIv: row.wrap_iv,
    });
  } catch (err) {
    console.error('Get own chat keys error:', err);
    res.status(500).json({ error: 'Failed to load keys' });
  }
});

// First-time setup, or a re-wrap of the SAME underlying private key with a
// new wrapping key (e.g. after an in-app password change, if one is ever
// added — see schema/index.js's own comment on why a password RESET
// specifically can't do this). The server only ever sees ciphertext here
// too — publicKeyJwk is the one field that was never secret to begin with.
router.put('/api/chat/keys/me', authenticateToken, async (req, res) => {
  const { publicKeyJwk, wrappedPrivateKey, wrapSalt, wrapIv } = req.body;
  if (!publicKeyJwk || !wrappedPrivateKey || !wrapSalt || !wrapIv) {
    return res.status(400).json({ error: 'publicKeyJwk, wrappedPrivateKey, wrapSalt, and wrapIv are all required' });
  }
  try {
    await pool.query(
      `INSERT INTO user_e2ee_keys (user_id, public_key_jwk, wrapped_private_key, wrap_salt, wrap_iv)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         public_key_jwk = $2, wrapped_private_key = $3, wrap_salt = $4, wrap_iv = $5`,
      [req.user.userId, publicKeyJwk, wrappedPrivateKey, wrapSalt, wrapIv]
    );
    res.status(200).json({ message: 'Keys saved' });
  } catch (err) {
    console.error('Save chat keys error:', err);
    res.status(500).json({ error: 'Failed to save keys' });
  }
});

// Someone else's PUBLIC key only, contact-gated — the contacts list above
// already inlines this for every contact, but this exists standalone for
// a client that already has a contact's id cached and just needs a fresh
// key (e.g. they set one up moments ago).
router.get('/api/chat/keys/:userId', authenticateToken, async (req, res) => {
  try {
    if (!(await canChat(req.user, req.params.userId))) return res.status(403).json({ error: 'Not a chat contact' });
    const result = await pool.query('SELECT public_key_jwk FROM user_e2ee_keys WHERE user_id = $1', [req.params.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: "That person hasn't set up secure chat yet" });
    res.status(200).json({ publicKeyJwk: result.rows[0].public_key_jwk });
  } catch (err) {
    console.error('Get contact chat key error:', err);
    res.status(500).json({ error: 'Failed to load key' });
  }
});

// Full thread with one contact, oldest first. Opening it marks every
// incoming message in it as read — same "read on open, not per-message"
// posture GET /api/doubts/:id and the notification bell both already use.
// A non-text row carries hasAttachment instead of inline ciphertext (the
// encrypted bytes live in B2, not this table — see POST below); the
// client fetches the actual bytes via GET .../:messageId/attachment below
// and decrypts what comes back the same way it would inline ciphertext,
// just one extra hop. That's a SEPARATE authenticated route through this
// same origin, deliberately not a presigned B2 URL handed to the client
// to fetch directly — B2 sends no CORS headers on these objects, so a
// browser-side fetch() reading the response body cross-origin would
// simply never work (a plain <img>/<video> src tag doesn't need CORS to
// render, but JS reading the bytes back out to decrypt them does; see
// storage.js's own comment on the identical constraint for the ID-card
// image-export proxy).
router.get('/api/chat/:otherUserId/messages', authenticateToken, async (req, res) => {
  const otherUserId = req.params.otherUserId;
  try {
    if (!(await canChat(req.user, otherUserId))) return res.status(403).json({ error: 'Not a chat contact' });

    // reported_by_me — whether THIS caller (specifically, not just anyone)
    // already reported a given message, so the client can keep showing
    // "Reported" after a refresh instead of that state living only in
    // React state for the current tab's lifetime.
    const result = await pool.query(
      `SELECT cm.id, cm.sender_id, cm.message_type, cm.ciphertext, cm.iv, cm.storage_key, cm.read_at, cm.edited_at, cm.created_at,
              (cmr.id IS NOT NULL) AS reported_by_me
       FROM chat_messages cm
       LEFT JOIN chat_message_reports cmr ON cmr.message_id = cm.id AND cmr.reporter_id = $3
       WHERE (cm.sender_id = $1 AND cm.recipient_id = $2) OR (cm.sender_id = $2 AND cm.recipient_id = $1)
       ORDER BY cm.created_at ASC`,
      [req.user.userId, otherUserId, req.user.userId]
    );
    const readUpdateRes = await pool.query(
      'UPDATE chat_messages SET read_at = now() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL RETURNING id',
      [req.user.userId, otherUserId]
    );
    // Newly marked read — push the sender (otherUserId, from THEIR
    // perspective the "from" side of this push) so their own open thread,
    // if they have it open, silently refreshes and shows these as Seen.
    // Same event/listener every other chat push already reuses; no new
    // event type needed.
    if (readUpdateRes.rowCount > 0) sendToUser(otherUserId, 'chat-message', { fromUserId: req.user.userId });

    const messages = result.rows.map((r) => ({
      id: r.id,
      fromMe: r.sender_id === req.user.userId,
      messageType: r.message_type,
      ciphertext: r.ciphertext,
      iv: r.iv,
      hasAttachment: !!r.storage_key,
      readAt: r.read_at,
      editedAt: r.edited_at,
      reportedByMe: r.reported_by_me,
      createdAt: r.created_at,
    }));
    res.status(200).json({ messages });
  } catch (err) {
    console.error('Get chat thread error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// The actual encrypted attachment bytes, proxied through this same origin
// (see the comment on GET .../messages above for why this can't just be
// a presigned B2 URL handed to the client). Still just ciphertext to
// anyone who isn't a party to this specific message — same thread-
// membership check as edit/report above.
router.get('/api/chat/:otherUserId/messages/:messageId/attachment', authenticateToken, async (req, res) => {
  const { otherUserId, messageId } = req.params;
  try {
    const msgRes = await pool.query(
      'SELECT sender_id, recipient_id, storage_key FROM chat_messages WHERE id = $1',
      [messageId]
    );
    const message = msgRes.rows.length > 0 ? msgRes.rows[0] : null;
    const belongsToThread = message && (
      (message.sender_id === req.user.userId && message.recipient_id === otherUserId)
      || (message.sender_id === otherUserId && message.recipient_id === req.user.userId)
    );
    if (!belongsToThread || !message.storage_key) return res.status(404).json({ error: 'Attachment not found' });
    if (!isB2Configured()) return res.status(503).json({ error: 'Attachment storage is not configured yet' });

    const { buffer } = await downloadScanPdf(message.storage_key);
    // Always octet-stream, never the real content type — this server has
    // no way to know it anyway (see POST above: the upload itself is
    // already ciphertext by the time it arrives here), and there's
    // nothing to leak about an opaque blob's shape either way.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.status(200).send(buffer);
  } catch (err) {
    console.error('Get chat attachment error:', err);
    res.status(500).json({ error: 'Failed to load attachment' });
  }
});

// Send a message — either JSON-carried ciphertext+iv (a text message) or,
// for everything else, an ALREADY-ENCRYPTED file (the sender's browser
// encrypted the raw file bytes client-side before this request was ever
// made — see frontend/src/lib/e2ee.js's encryptBytes) riding along as
// multipart form data. Either way this route never sees plaintext of any
// kind, text or file. The notification created below deliberately never
// echoes any message content, generic or otherwise — only who it's from,
// since notifications.body is stored in the clear and a leaked snippet
// there would defeat the whole point of encrypting chat_messages (and now
// chat attachments) in the first place.
router.post('/api/chat/:otherUserId/messages', authenticateToken, notesUpload.single('file'), async (req, res) => {
  const otherUserId = req.params.otherUserId;
  const messageType = String(req.body.messageType || 'text');
  const iv = req.body.iv;
  const ciphertext = req.body.ciphertext || null;

  if (!MESSAGE_TYPES.has(messageType)) return res.status(400).json({ error: 'Invalid message type' });
  if (!iv) return res.status(400).json({ error: 'iv is required' });
  if (messageType === 'text' && !ciphertext) return res.status(400).json({ error: 'ciphertext is required for a text message' });
  if (messageType !== 'text' && !req.file) return res.status(400).json({ error: 'A file is required for this message type' });

  try {
    if (!(await canChat(req.user, otherUserId))) return res.status(403).json({ error: 'Not a chat contact' });

    let storageKey = null;
    if (req.file) {
      if (!isB2Configured()) return res.status(503).json({ error: 'Attachment storage is not configured yet' });
      // req.file.buffer is already ciphertext by the time it reaches here
      // (encrypted client-side pre-upload) — 'application/octet-stream'
      // rather than the real mimetype since this server has no way to
      // know (or verify) what the real file type is, only the sender's
      // own device does.
      storageKey = chatObjectKey(req.user.organizationId, req.user.userId, crypto.randomUUID());
      await uploadScanPdf(storageKey, req.file.buffer, 'application/octet-stream');
    }

    const insertRes = await pool.query(
      `INSERT INTO chat_messages (organization_id, sender_id, recipient_id, message_type, ciphertext, iv, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
      [req.user.organizationId, req.user.userId, otherUserId, messageType, ciphertext, iv, storageKey]
    );

    sendToUser(otherUserId, 'chat-message', { fromUserId: req.user.userId });

    try {
      const senderRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]);
      const senderName = senderRes.rows[0]?.name || senderRes.rows[0]?.email || 'Someone';
      await createNotification({
        organizationId: req.user.organizationId,
        userId: otherUserId,
        type: 'chat',
        title: 'New message',
        body: `From ${senderName}`,
      });
    } catch (err) {
      console.error('Failed to notify of new chat message (continuing anyway):', err);
    }

    res.status(201).json({ id: insertRes.rows[0].id, createdAt: insertRes.rows[0].created_at });
  } catch (err) {
    console.error('Send chat message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

const EDIT_WINDOW_MS = 15 * 60 * 1000;

// A sender correcting a typo/mistake in their own text message, within 15
// minutes of sending it — same re-encrypt-and-replace shape as sending
// one in the first place, just an UPDATE instead of an INSERT. Text only,
// same reasoning as reporting being text-only: re-encrypting and
// re-uploading a file for an "edit" is real extra complexity for a case
// nobody's actually asked for.
router.put('/api/chat/:otherUserId/messages/:messageId', authenticateToken, async (req, res) => {
  const { otherUserId, messageId } = req.params;
  const ciphertext = req.body.ciphertext;
  const iv = req.body.iv;
  if (!ciphertext || !iv) return res.status(400).json({ error: 'ciphertext and iv are required' });

  try {
    const msgRes = await pool.query(
      'SELECT id, sender_id, recipient_id, message_type, created_at FROM chat_messages WHERE id = $1',
      [messageId]
    );
    const message = msgRes.rows.length > 0 ? msgRes.rows[0] : null;
    const belongsToThread = message && (
      (message.sender_id === req.user.userId && message.recipient_id === otherUserId)
      || (message.sender_id === otherUserId && message.recipient_id === req.user.userId)
    );
    if (!belongsToThread) return res.status(404).json({ error: 'Message not found in this conversation' });
    if (message.sender_id !== req.user.userId) {
      return res.status(403).json({ error: 'Only the sender of a message can edit it' });
    }
    if (message.message_type !== 'text') {
      return res.status(400).json({ error: 'Only text messages can be edited' });
    }
    if (Date.now() - new Date(message.created_at).getTime() > EDIT_WINDOW_MS) {
      return res.status(400).json({ error: 'The edit window for this message has expired' });
    }

    const updateRes = await pool.query(
      'UPDATE chat_messages SET ciphertext = $1, iv = $2, edited_at = now() WHERE id = $3 RETURNING edited_at',
      [ciphertext, iv, messageId]
    );
    // Same reused event/listener as everywhere else in this file — the
    // recipient's open thread, if it's this one, silently reloads and
    // shows the edited content.
    sendToUser(otherUserId, 'chat-message', { fromUserId: req.user.userId });

    res.status(200).json({ editedAt: updateRes.rows[0].edited_at });
  } catch (err) {
    console.error('Edit chat message error:', err);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// A recipient flagging one specific message — the only safety mechanism
// this feature can have given chat_messages.ciphertext is genuinely
// opaque to this server (see the file-level comment above). The
// plaintext submitted here is whatever the reporter's own browser
// already decrypted and displayed — this route never decrypts anything
// itself, it just accepts what the client hands it. Text messages only
// for now: reporting an attachment would need decrypting and re-storing
// the file in the clear somewhere reviewable, out of scope here.
router.post('/api/chat/:otherUserId/messages/:messageId/report', authenticateToken, async (req, res) => {
  const { otherUserId, messageId } = req.params;
  const plaintextContent = String(req.body.plaintextContent || '').trim();
  const note = req.body.note ? String(req.body.note).trim() : null;
  if (!plaintextContent) return res.status(400).json({ error: 'plaintextContent is required' });

  try {
    const msgRes = await pool.query(
      'SELECT id, sender_id, recipient_id, message_type, organization_id FROM chat_messages WHERE id = $1',
      [messageId]
    );
    // otherUserId is the caller's chat PARTNER (same convention as every
    // sibling route above), not necessarily this message's sender — the
    // caller could be either party in the thread. Belongs-to-this-thread
    // just means {sender, recipient} === {me, otherUserId} in some order;
    // which one of those two is actually allowed to report is the
    // separate recipient-only check right below.
    const message = msgRes.rows.length > 0 ? msgRes.rows[0] : null;
    const belongsToThread = message && (
      (message.sender_id === req.user.userId && message.recipient_id === otherUserId)
      || (message.sender_id === otherUserId && message.recipient_id === req.user.userId)
    );
    if (!belongsToThread) return res.status(404).json({ error: 'Message not found in this conversation' });
    if (message.recipient_id !== req.user.userId) {
      return res.status(403).json({ error: 'Only the recipient of a message can report it' });
    }
    if (message.message_type !== 'text') {
      return res.status(400).json({ error: 'Only text messages can be reported' });
    }

    let reportId;
    try {
      const insertRes = await pool.query(
        `INSERT INTO chat_message_reports (message_id, organization_id, reporter_id, reported_user_id, plaintext_content, reporter_note)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [message.id, message.organization_id, req.user.userId, message.sender_id, plaintextContent, note]
      );
      reportId = insertRes.rows[0].id;
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: "You've already reported this message" });
      throw err;
    }

    try {
      const [reporterRes, reportedRes] = await Promise.all([
        pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]),
        pool.query('SELECT name, email FROM users WHERE id = $1', [otherUserId]),
      ]);
      const reporterName = reporterRes.rows[0]?.name || reporterRes.rows[0]?.email || 'Someone';
      const reportedName = reportedRes.rows[0]?.name || reportedRes.rows[0]?.email || 'someone';
      await createNotificationsBulk({
        selectSql: "SELECT user_id FROM memberships WHERE organization_id = $1 AND role = 'admin'",
        selectParams: [message.organization_id],
        organizationId: message.organization_id,
        type: 'chat_report',
        title: 'New chat report',
        body: `${reporterName} reported a message from ${reportedName}`,
        extraColumn: 'chat_report_id',
        extraId: reportId,
      });
    } catch (err) {
      console.error('Failed to notify admins of chat report (continuing anyway):', err);
    }

    res.status(201).json({ id: reportId });
  } catch (err) {
    console.error('Report chat message error:', err);
    res.status(500).json({ error: 'Failed to report message' });
  }
});

// Admin-facing review queue — org-scoped (a superadmin viewing an org via
// the usual X-Organization-Id override reads/writes the same rows any
// real admin of that org would, no separate route needed; see
// applySuperadminOrgOverride in lib/auth.js).
router.get('/api/admin/chat-reports', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.plaintext_content, r.reporter_note, r.status, r.created_at,
              reporter.name AS reporter_name, reporter.email AS reporter_email,
              reported.name AS reported_name, reported.email AS reported_email
       FROM chat_message_reports r
       JOIN users reporter ON reporter.id = r.reporter_id
       JOIN users reported ON reported.id = r.reported_user_id
       WHERE r.organization_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.organizationId]
    );
    res.status(200).json({
      reports: result.rows.map((r) => ({
        id: r.id,
        plaintextContent: r.plaintext_content,
        reporterNote: r.reporter_note,
        status: r.status,
        createdAt: r.created_at,
        reporterName: r.reporter_name || r.reporter_email,
        reportedName: r.reported_name || r.reported_email,
      })),
    });
  } catch (err) {
    console.error('List chat reports error:', err);
    res.status(500).json({ error: 'Failed to load chat reports' });
  }
});

router.put('/api/admin/chat-reports/:id', authenticateToken, requireAdmin, async (req, res) => {
  const status = String(req.body.status || '');
  if (!['open', 'reviewed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const result = await pool.query(
      'UPDATE chat_message_reports SET status = $1 WHERE id = $2 AND organization_id = $3 RETURNING id',
      [status, req.params.id, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
    res.status(200).json({ message: 'Report updated' });
  } catch (err) {
    console.error('Update chat report error:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

module.exports = router;
