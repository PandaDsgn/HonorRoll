// Encrypted chat routes — a private 1:1 channel between a student and a
// teacher of a subject they're enrolled in. See ensureChatMessagesSchema /
// ensureE2eeKeysSchema in schema/index.js for the full model: this server
// stores public keys, password-wrapped private key blobs, and message
// ciphertext, but never a private key in the clear or message plaintext —
// every encrypt/decrypt happens in the browser (frontend/src/lib/e2ee.js).
const express = require('express');
const router = express.Router();
const { pool } = require('../lib/db');
const { authenticateToken } = require('../lib/auth');
const { getVisibleSubjectIds, getTeacherScope } = require('../lib/performance');
const { sendToUser } = require('../lib/realtime');
const { createNotification } = require('../lib/notifications');
const { notesUpload } = require('../lib/uploads');
const { isB2Configured, chatObjectKey, uploadScanPdf, getScanPdfUrl } = require('../storage');

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
// A non-text row carries a presigned attachmentUrl (the encrypted bytes
// live in B2, not this table — see POST below) instead of inline
// ciphertext; the client fetches that URL itself and decrypts what comes
// back the same way it would inline ciphertext, just one extra hop.
router.get('/api/chat/:otherUserId/messages', authenticateToken, async (req, res) => {
  const otherUserId = req.params.otherUserId;
  try {
    if (!(await canChat(req.user, otherUserId))) return res.status(403).json({ error: 'Not a chat contact' });

    const result = await pool.query(
      `SELECT id, sender_id, message_type, ciphertext, iv, storage_key, created_at FROM chat_messages
       WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY created_at ASC`,
      [req.user.userId, otherUserId]
    );
    await pool.query(
      'UPDATE chat_messages SET read_at = now() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL',
      [req.user.userId, otherUserId]
    );

    const configured = isB2Configured();
    const messages = await Promise.all(result.rows.map(async (r) => ({
      id: r.id,
      fromMe: r.sender_id === req.user.userId,
      messageType: r.message_type,
      ciphertext: r.ciphertext,
      iv: r.iv,
      attachmentUrl: r.storage_key && configured ? await getScanPdfUrl(r.storage_key) : null,
      createdAt: r.created_at,
    })));
    res.status(200).json({ messages });
  } catch (err) {
    console.error('Get chat thread error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
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

module.exports = router;
