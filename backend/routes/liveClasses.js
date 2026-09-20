// Live classes — a teacher broadcasts their own camera to a subject's
// students over a self-hosted mediasoup SFU (see media-server/index.js —
// a fully separate process/deploy, since WebRTC's own UDP media traffic
// can't reach a Render-hosted container the way this file's own HTTP
// routes can). Broadcast-style: only the session's own teacher ever gets
// a token allowing it to produce video — see the join route's own
// comment. Phase A only — no recording yet (see ensureLiveSessionsSchema's
// own comment in schema/index.js for what's deliberately left out of this
// pass).
//
// The trust boundary with media-server is the session JWT this app
// already signs everywhere else — no separate secret to provision or
// rotate for this one integration. A "join" token carries {sessionId,
// userId, canProduceVideo, canProduceAudio}; the internal "force-close"
// call below carries {type: 'close-session', sessionId} instead, so the
// two can never be used in place of each other even though both are
// verified with the same JWT_SECRET.
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../lib/db');
const { authenticateToken, requireAdminOrTeacher, enforceSubjectAuthority } = require('../lib/auth');
const { getVisibleSubjectIds, getTeacherScope, getStudentsForSubject } = require('../lib/performance');
const { createNotificationsBulk } = require('../lib/notifications');
const { sendToUser } = require('../lib/realtime');

function isMediaServerConfigured() {
  return !!process.env.MEDIA_SERVER_WS_URL;
}

// Server-to-server only, never called by a browser — tells media-server to
// force-close a session's Router immediately (see POST .../end below) so
// lingering student connections actually drop rather than waiting for
// their own socket to notice the teacher's producer vanished. Best-effort:
// media-server not being reachable shouldn't block the class from ending
// on this app's own side, same "continuing anyway" posture every other
// non-critical side effect in this route file already has.
async function closeMediaServerSession(sessionId) {
  const closeToken = jwt.sign({ type: 'close-session', sessionId: String(sessionId) }, process.env.JWT_SECRET, { expiresIn: '1m' });
  // wss:// -> https://, ws:// -> http:// (order matters: matching wss://
  // first, or the plain ws:// pattern would also match the "ws" prefix of
  // "wss" and leave a stray trailing "s" — e.g. "httpss://"), then strip
  // the /ws signaling path to get media-server's own HTTP base.
  const internalUrl = process.env.MEDIA_SERVER_WS_URL
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/ws$/, '');
  await fetch(`${internalUrl}/internal/sessions/${sessionId}/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${closeToken}` },
  });
}

// Subject picker for the "start a class" flow — same role-aware shape as
// GET /api/doubts/subjects and GET /api/notes/subjects (each a similarly
// small, independently-duplicated handler rather than a shared one; this
// follows the same existing convention).
router.get('/api/live-sessions/subjects', authenticateToken, async (req, res) => {
  try {
    // Admin gets every subject in the org, not just ones they're
    // personally assigned to — matches enforceSubjectAuthority's own
    // blanket admin bypass on the start-a-class route below, rather than
    // narrowing them to subject_teachers the way getTeacherScope would.
    if (req.user.role === 'admin') {
      const result = await pool.query(
        `SELECT s.id, s.name, u.name AS org_unit_name FROM subjects s JOIN org_units u ON u.id = s.org_unit_id
         WHERE s.organization_id = $1 ORDER BY s.name ASC`,
        [req.user.organizationId]
      );
      return res.status(200).json({ subjects: result.rows });
    }

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
    console.error('List live-session subjects error:', err);
    res.status(500).json({ error: 'Failed to load subjects' });
  }
});

// Start a class — same admin-bypass/teacher-must-be-assigned authority
// check notes.js's own upload route already uses (enforceSubjectAuthority:
// an admin can start a class for any subject in their org; a teacher only
// for a subject they're actually assigned to via subject_teachers — this
// already covers a single-teacher org's own admin too, same as it already
// does for posting notes, with no separate check needed here).
router.post('/api/teacher/live-sessions', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  if (!subjectId) return res.status(400).json({ error: 'A subject is required' });
  if (!isMediaServerConfigured()) return res.status(503).json({ error: 'Live classes are not configured yet' });

  if (await enforceSubjectAuthority(req, res, subjectId)) return;

  try {
    // enforceSubjectAuthority's own admin-bypass is a no-op on org
    // scoping — re-fetched here scoped to organization_id so an admin
    // naming another org's subject id can't sail through, same guard
    // notes.js's own upload route applies right after that same check.
    const subjectRes = await pool.query('SELECT id, name FROM subjects WHERE id = $1 AND organization_id = $2', [subjectId, req.user.organizationId]);
    if (subjectRes.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });
    const subject = subjectRes.rows[0];

    // No room to create up front — media-server creates its mediasoup
    // Router lazily, the moment the first participant's WebSocket
    // connects (see media-server/index.js's getOrCreateSession), keyed
    // off this row's own id. Nothing about an active call needs to
    // survive a media-server restart, so there's no vendor room object to
    // persist here the way Daily needed.
    const insertRes = await pool.query(
      `INSERT INTO live_sessions (organization_id, subject_id, teacher_id)
       VALUES ($1, $2, $3) RETURNING id, started_at`,
      [req.user.organizationId, subjectId, req.user.userId]
    );
    const sessionId = insertRes.rows[0].id;

    try {
      // Persistent bell entry (createNotificationsBulk's own generic
      // 'notification' push, see lib/notifications.js) plus a richer,
      // ephemeral push for an immediate "join now" banner — two separate
      // recipient resolutions (same underlying student set either way)
      // because they serve different UI: a bell badge that survives a
      // refresh vs. a live banner that only matters while the class is
      // actually still going.
      await createNotificationsBulk({
        selectSql: `SELECT m.user_id FROM memberships m
           JOIN subjects s ON s.organization_id = m.organization_id
           WHERE s.id = $1 AND m.role = 'student'
           AND m.org_unit_id IN (
             WITH RECURSIVE descendant_units AS (
               SELECT org_unit_id AS id FROM subjects WHERE id = $1
               UNION
               SELECT ou.id FROM org_units ou JOIN descendant_units d ON ou.parent_unit_id = d.id
             )
             SELECT id FROM descendant_units
           )`,
        selectParams: [subjectId],
        organizationId: req.user.organizationId,
        type: 'live-session',
        title: `Live class started in ${subject.name}`,
        body: null,
        extraColumn: 'live_session_id',
        extraId: sessionId,
      });
    } catch (err) {
      console.error('Failed to notify students of live class (continuing anyway):', err);
    }

    try {
      const students = await getStudentsForSubject(req.user.organizationId, subjectId);
      const teacherRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]);
      const teacherName = teacherRes.rows[0]?.name || teacherRes.rows[0]?.email || 'Your teacher';
      for (const student of students) {
        sendToUser(student.id, 'live-class-started', { sessionId, subjectId, subjectName: subject.name, teacherName });
      }
    } catch (err) {
      console.error('Failed to push live-class-started (continuing anyway):', err);
    }

    res.status(201).json({ id: sessionId, startedAt: insertRes.rows[0].started_at });
  } catch (err) {
    console.error('Start live session error:', err);
    res.status(500).json({ error: 'Failed to start the live class' });
  }
});

// End a class — only the teacher who started it, or an admin, same
// ownership shape doubts.js's teacherCanAccessDoubt uses elsewhere.
router.post('/api/teacher/live-sessions/:id/end', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const sessionRes = await pool.query(
      'SELECT id, subject_id, teacher_id FROM live_sessions WHERE id = $1 AND organization_id = $2 AND status = $3',
      [req.params.id, req.user.organizationId, 'live']
    );
    if (sessionRes.rows.length === 0) return res.status(404).json({ error: 'No live class found' });
    const session = sessionRes.rows[0];
    if (req.user.role !== 'admin' && session.teacher_id !== req.user.userId) {
      return res.status(403).json({ error: 'Only the teacher who started this class can end it' });
    }

    await pool.query("UPDATE live_sessions SET status = 'ended', ended_at = now() WHERE id = $1", [session.id]);

    if (isMediaServerConfigured()) {
      try {
        await closeMediaServerSession(session.id);
      } catch (err) {
        console.error('Failed to force-close media-server session (continuing anyway):', err);
      }
    }

    try {
      const students = await getStudentsForSubject(req.user.organizationId, session.subject_id);
      for (const student of students) sendToUser(student.id, 'live-class-ended', { sessionId: session.id });
    } catch (err) {
      console.error('Failed to push live-class-ended (continuing anyway):', err);
    }

    res.status(200).json({ message: 'Class ended' });
  } catch (err) {
    console.error('End live session error:', err);
    res.status(500).json({ error: 'Failed to end the live class' });
  }
});

// "Is a class live right now for this subject" — polled by a student's
// subject page on mount so they don't have to have been connected at the
// exact moment the realtime push fired to still discover a class in
// progress.
router.get('/api/live-sessions/:subjectId/current', authenticateToken, async (req, res) => {
  const subjectId = Number(req.params.subjectId);
  try {
    if (req.user.role === 'student') {
      const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
      if (!visibleSubjectIds.includes(subjectId)) return res.status(404).json({ error: 'Subject not found' });
    }
    const result = await pool.query(
      `SELECT ls.id, ls.started_at, u.name AS teacher_name, u.email AS teacher_email
       FROM live_sessions ls JOIN users u ON u.id = ls.teacher_id
       WHERE ls.subject_id = $1 AND ls.organization_id = $2 AND ls.status = 'live'`,
      [subjectId, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(200).json({ session: null });
    const row = result.rows[0];
    res.status(200).json({ session: { id: row.id, startedAt: row.started_at, teacherName: row.teacher_name || row.teacher_email } });
  } catch (err) {
    console.error('Get current live session error:', err);
    res.status(500).json({ error: 'Failed to check for a live class' });
  }
});

// Mints a media-server join token scoped to this specific viewer —
// re-checked on every call rather than trusting a stored session id
// alone, same "never trust a stored id alone" posture doubts.js's GET
// /api/doubts/:id already uses. The session's own starting teacher gets
// canProduceVideo: true; anyone else who can legitimately see this
// subject (another teacher assigned to it, an admin, or a student who can
// see it) only gets canProduceAudio — media-server's own produce handler
// is what actually enforces this (see media-server/index.js), not
// anything client-side.
router.get('/api/live-sessions/:id/join', authenticateToken, async (req, res) => {
  try {
    const sessionRes = await pool.query(
      `SELECT id, subject_id, teacher_id FROM live_sessions
       WHERE id = $1 AND organization_id = $2 AND status = 'live'`,
      [req.params.id, req.user.organizationId]
    );
    if (sessionRes.rows.length === 0) return res.status(404).json({ error: 'No live class found' });
    const session = sessionRes.rows[0];

    const isOwner = req.user.userId === session.teacher_id;
    if (!isOwner) {
      if (req.user.role === 'student') {
        const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
        if (!visibleSubjectIds.includes(session.subject_id)) return res.status(403).json({ error: 'Not your class to join' });
      } else if (req.user.role === 'teacher' || req.user.role === 'admin') {
        if (await enforceSubjectAuthority(req, res, session.subject_id)) return;
      } else {
        return res.status(403).json({ error: 'Not available for this role' });
      }
    }

    // Checked last, not first — an unauthorized caller should still get
    // 403, not a 503 that leaks "well, at least the service would be
    // reachable" ahead of finding out they can't use it anyway.
    if (!isMediaServerConfigured()) return res.status(503).json({ error: 'Live classes are not configured yet' });

    const token = jwt.sign(
      { sessionId: String(session.id), userId: req.user.userId, canProduceVideo: isOwner, canProduceAudio: true },
      process.env.JWT_SECRET,
      { expiresIn: '4h' }
    );

    res.status(200).json({ token, mediaServerWsUrl: process.env.MEDIA_SERVER_WS_URL, isOwner });
  } catch (err) {
    console.error('Join live session error:', err);
    res.status(500).json({ error: 'Failed to join the live class' });
  }
});

module.exports = router;
