// Notification feed routes — split out of index.js as part of
// breaking that monolith into modules. Pure relocation. Mounted with
// no prefix in index.js — every path below is the exact full path it
// always was.
const express = require('express');
const router = express.Router();
const { pool } = require('../lib/db');
const { authenticateToken } = require('../lib/auth');


// Notification feed — two producers now (see ensureNotificationsSchema's
// own comment), so this is student-or-teacher rather than student-only:
// a teacher's note-upload notifications were always student-only, but
// notices fan out to teachers too. Capped at the 50 most recent so a
// long-inactive user's first load isn't unbounded.
router.get('/api/notifications', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student' && req.user.role !== 'teacher') return res.status(403).json({ error: 'Not available for this role' });
  try {
    const result = await pool.query(
      `SELECT id, type, title, body, note_id, notice_id, problem_id, exam_id, read_at, created_at FROM notifications
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.userId]
    );
    const notifications = result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      noteId: row.note_id,
      noticeId: row.notice_id,
      problemId: row.problem_id,
      examId: row.exam_id,
      read: row.read_at !== null,
      createdAt: row.created_at,
    }));
    res.status(200).json({ notifications });
  } catch (err) {
    console.error('List notifications error:', err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// Marks every one of the caller's currently-unread notifications as read in
// one shot — called when the notification dropdown is opened, rather than
// tracking each notification's read state individually from the frontend.
router.post('/api/notifications/mark-read', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student' && req.user.role !== 'teacher') return res.status(403).json({ error: 'Not available for this role' });
  try {
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.userId]);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Mark notifications read error:', err);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

module.exports = router;
