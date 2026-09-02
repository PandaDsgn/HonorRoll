// Shared notification-creation helpers — every INSERT INTO notifications
// across the app (notes, notices, assignment/exam sweeps, doubts) used to
// be a raw pool.query() duplicated at each call site, with no real-time
// push at all (NotificationBell.jsx just polled every 30s). Centralizing
// the insert here means a push over lib/realtime.js's sendToUser can never
// be forgotten at a new call site the way a copy-pasted raw INSERT could.
//
// The push payload is deliberately just a bare signal, not the full
// notification row — the client already has GET /api/notifications as the
// single source of truth for the actual shape of a notification; pushing
// a second, hand-serialized copy of that shape over the socket would just
// be a second place for the two to quietly drift apart. Getting the signal
// is enough for the bell to refetch.
const { pool } = require('./db');
const { sendToUser } = require('./realtime');

// Single recipient — used wherever the recipient list already has to be
// resolved one-by-one anyway (e.g. doubts.js fanning out to a specific set
// of teachers or a specific student).
async function createNotification({ organizationId, userId, type, title, body = null, noteId = null, noticeId = null, problemId = null, examId = null, doubtId = null }) {
  const result = await pool.query(
    `INSERT INTO notifications (organization_id, user_id, type, title, body, note_id, notice_id, problem_id, exam_id, doubt_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, created_at`,
    [organizationId, userId, type, title, body, noteId, noticeId, problemId, examId, doubtId]
  );
  sendToUser(userId, 'notification', {});
  return result.rows[0];
}

// Bulk fan-out to however many recipients a single SELECT resolves to
// (every student under a subject's org unit tree, every student+teacher in
// an org, ...) — one INSERT ... SELECT, same as every existing fan-out
// already did, just wrapped so the real-time push happens automatically
// afterward instead of being reinvented (or forgotten) at each call site.
//
// selectSql must be a full, standalone query (a WITH RECURSIVE CTE is
// fine — Postgres allows one inside a derived-table subquery) that selects
// exactly one column: the recipient's user_id. extraColumn is always one
// of the fixed notifications columns (note_id/notice_id/problem_id/
// exam_id/doubt_id) supplied by the caller as a literal, never request
// input, same safe-interpolation posture routes/scans.js's own
// notifyStudentsOfNewItem already used before this helper existed.
async function createNotificationsBulk({ selectSql, selectParams = [], organizationId, type, title, body = null, extraColumn, extraId }) {
  const n = selectParams.length;
  const result = await pool.query(
    `INSERT INTO notifications (organization_id, user_id, type, title, body, ${extraColumn})
     SELECT $${n + 1}, recipient.user_id, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}
     FROM (${selectSql}) recipient
     RETURNING user_id`,
    [...selectParams, organizationId, type, title, body, extraId]
  );
  for (const row of result.rows) sendToUser(row.user_id, 'notification', {});
  return result.rowCount;
}

module.exports = { createNotification, createNotificationsBulk };
