// Exam routes — admin builder (create/list/edit/delete/clone,
// question bank) and the student-facing exam-taking flow
// (browse/start/scan-submit/submit/result/questions/proctor-flag)
// plus admin grading (attempts/flags/answers/scan-answers/remarks/
// process-scan). Split out of index.js as part of breaking that
// monolith into modules. Pure relocation. Mounted with no prefix in
// index.js — every path below is the exact full path it always was.
//
// Grade-bands and tag-visibility routes sit in the middle of this
// range in the original file but are genuinely a different domain
// (admin settings, not exams) — they stay in index.js for now.
const express = require('express');
const router = express.Router();
const { pool } = require('../lib/db');
const { authenticateToken, requireAdminOrTeacher, requireAdmin, enforceSubjectAuthority } = require('../lib/auth');
const {
  getProblemStatus, getVisibleSubjectIds, computePercentileTiers, gradeTagForPercentage, getTagVisibility,
} = require('../lib/performance');
const { normalizeExamItem } = require('../lib/examItems');
const {
  finalizeExamAttempt, runExamShortLongAiAssessment, recomputeExamAttemptScore, isAttemptFullyGraded,
} = require('../lib/examGrading');
const { ocrLimit, examScanOcrInFlight, processOneExamScanAttempt } = require('../lib/examScanPipeline');
const { isB2Configured, examScanObjectKey, uploadScanPdf, getScanPdfUrl, deleteScanPdf } = require('../storage');
const { scanUpload } = require('../lib/uploads');
const { logSecurityEvent } = require('../lib/securityEvents');



// ============================================================================
// EXAMS (ADMIN) â€” foundation for exam mode: create/list/edit/delete exams,
// each holding an ordered mix of mcq/short/long/coding items. This block
// only covers the admin builder; the student-facing exam-taking flow
// (lockdown, webcam proctoring, grading) is separate follow-up work.
// ============================================================================

// Create an exam with its full set of items in one transaction.
router.post('/api/admin/exams', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { title, description = null, totalTimeSeconds, webcamRequired = false, opensAt = null, closesAt = null, items = [], calculatorAllowed = false, calculatorType = null } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  const CALCULATOR_TYPES = ['basic', 'scientific', 'programmer', 'statistics', 'financial'];
  if (calculatorAllowed && !CALCULATOR_TYPES.includes(calculatorType)) {
    return res.status(400).json({ error: 'A valid calculator type is required when calculators are allowed' });
  }

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (await enforceSubjectAuthority(req, res, subjectId)) return;
  const totalTime = Number(totalTimeSeconds);
  if (!Number.isFinite(totalTime) || totalTime <= 0) {
    return res.status(400).json({ error: 'Total exam time must be a positive number of seconds' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'An exam needs at least one item' });
  }

  let normalizedItems;
  try {
    normalizedItems = items.map((item, i) => normalizeExamItem(item, i));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Coding items reference an existing assignment's problem_id â€” verified up
  // front so a typo'd/deleted id fails with a clear message instead of
  // tripping the FK constraint mid-transaction.
  const codingProblemIds = [...new Set(normalizedItems.filter((i) => i.type === 'coding' && i.problemId != null).map((i) => i.problemId))];
  if (codingProblemIds.length > 0) {
    // Scoped to the caller's own org — otherwise an admin could reference
    // (and thereby leak samples/starter code from) another org's assignment.
    const existing = await pool.query('SELECT id FROM problems WHERE id = ANY($1::int[]) AND organization_id = $2', [codingProblemIds, req.user.organizationId]);
    const existingIds = new Set(existing.rows.map((r) => r.id));
    const missing = codingProblemIds.find((id) => !existingIds.has(id));
    if (missing !== undefined) {
      return res.status(400).json({ error: `Coding item references a missing assignment (id ${missing})` });
    }
  }

  const totalMarks = normalizedItems.reduce((sum, i) => sum + i.marks, 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const examRes = await client.query(
      `INSERT INTO exams (title, description, total_marks, total_time_seconds, webcam_required, opens_at, closes_at, created_by, organization_id, subject_id, calculator_allowed, calculator_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [title.trim(), description, totalMarks, Math.round(totalTime), !!webcamRequired, opensAt, closesAt, req.user.userId, req.user.organizationId, subjectId, !!calculatorAllowed, calculatorAllowed ? calculatorType : null]
    );
    const examId = examRes.rows[0].id;

    for (let i = 0; i < normalizedItems.length; i++) {
      const item = normalizedItems[i];
      await client.query(
        `INSERT INTO exam_items (exam_id, type, position, marks, time_limit_seconds, prompt, options, correct_option_id, word_limit, problem_id, starter_code, test_cases)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [examId, item.type, i, item.marks, item.timeLimitSeconds, item.prompt,
         item.options ? JSON.stringify(item.options) : null, item.correctOptionId, item.wordLimit, item.problemId,
         item.starterCode ? JSON.stringify(item.starterCode) : null, item.testCases ? JSON.stringify(item.testCases) : null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Exam created successfully', examId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Exam create error:', error);
    res.status(500).json({ error: 'Failed to create exam' });
  } finally {
    client.release();
  }
});

// List exams for the admin table â€” item_count only, not the full items
// (those load on-demand when actually editing one).
// requireAdminOrTeacher, not requireAdmin — every other verb on this same
// resource (create/get-one/update/delete, right below) already allows a
// teacher; this list route was the one inconsistent holdout, which meant a
// teacher could create/edit/delete an exam by ID but never actually SEE
// the list to find one. The query itself needs no role-based filtering —
// it's already org-wide, the same set of exams an admin and every teacher
// in this org share.
router.get('/api/admin/exams', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.id, e.title, e.total_marks, e.total_time_seconds, e.webcam_required,
             e.calculator_allowed, e.calculator_type,
             e.opens_at, e.closes_at, COUNT(ei.id)::int AS item_count
      FROM exams e
      LEFT JOIN exam_items ei ON ei.exam_id = e.id
      WHERE e.organization_id = $1
      GROUP BY e.id
      ORDER BY e.created_at DESC
    `, [req.user.organizationId]);
    const exams = result.rows.map((e) => ({ ...e, status: getProblemStatus(e) }));
    res.status(200).json({ exams });
  } catch (err) {
    console.error('List exams error:', err);
    res.status(500).json({ error: 'Failed to load exams' });
  }
});

// Full detail for one exam, items included â€” used by ExamForm to pre-fill
// edit mode (including each MCQ's correct answer, unlike whatever the
// eventual student-facing fetch will return).
router.get('/api/admin/exams/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const examId = req.params.id;
  try {
    const examRes = await pool.query(
      'SELECT id, title, description, total_marks, total_time_seconds, webcam_required, calculator_allowed, calculator_type, opens_at, closes_at, subject_id FROM exams WHERE id = $1 AND organization_id = $2',
      [examId, req.user.organizationId]
    );
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
    if (await enforceSubjectAuthority(req, res, examRes.rows[0].subject_id)) return;

    const itemsRes = await pool.query(
      `SELECT id, type, position, marks, time_limit_seconds, prompt, options, correct_option_id, word_limit, problem_id, starter_code, test_cases
       FROM exam_items WHERE exam_id = $1 ORDER BY position ASC`,
      [examId]
    );

    res.status(200).json({ ...examRes.rows[0], items: itemsRes.rows });
  } catch (err) {
    console.error('Fetch full exam error:', err);
    res.status(500).json({ error: 'Failed to load exam details' });
  }
});

// Full update â€” same "replace the whole item set" approach as assignment
// editing, matching how ExamForm will send its payload (everything at once).
router.put('/api/admin/exams/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const examId = req.params.id;
  const { title, description = null, totalTimeSeconds, webcamRequired = false, opensAt = null, closesAt = null, items = [], calculatorAllowed = false, calculatorType = null } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  const CALCULATOR_TYPES = ['basic', 'scientific', 'programmer', 'statistics', 'financial'];
  if (calculatorAllowed && !CALCULATOR_TYPES.includes(calculatorType)) {
    return res.status(400).json({ error: 'A valid calculator type is required when calculators are allowed' });
  }

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  const totalTime = Number(totalTimeSeconds);
  if (!Number.isFinite(totalTime) || totalTime <= 0) {
    return res.status(400).json({ error: 'Total exam time must be a positive number of seconds' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'An exam needs at least one item' });
  }

  let normalizedItems;
  try {
    normalizedItems = items.map((item, i) => normalizeExamItem(item, i));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const codingProblemIds = [...new Set(normalizedItems.filter((i) => i.type === 'coding' && i.problemId != null).map((i) => i.problemId))];
  if (codingProblemIds.length > 0) {
    const existingProblems = await pool.query('SELECT id FROM problems WHERE id = ANY($1::int[]) AND organization_id = $2', [codingProblemIds, req.user.organizationId]);
    const existingIds = new Set(existingProblems.rows.map((r) => r.id));
    const missing = codingProblemIds.find((id) => !existingIds.has(id));
    if (missing !== undefined) {
      return res.status(400).json({ error: `Coding item references a missing assignment (id ${missing})` });
    }
  }

  const totalMarks = normalizedItems.reduce((sum, i) => sum + i.marks, 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id, subject_id FROM exams WHERE id = $1 AND organization_id = $2', [examId, req.user.organizationId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Exam not found' });
    }
    if (await enforceSubjectAuthority(req, res, existing.rows[0].subject_id)) { await client.query('ROLLBACK'); return; }
    if (subjectId !== existing.rows[0].subject_id && await enforceSubjectAuthority(req, res, subjectId)) { await client.query('ROLLBACK'); return; }

    await client.query(
      `UPDATE exams SET title = $1, description = $2, total_marks = $3, total_time_seconds = $4,
       webcam_required = $5, opens_at = $6, closes_at = $7, subject_id = $8,
       calculator_allowed = $9, calculator_type = $10 WHERE id = $11`,
      [title.trim(), description, totalMarks, Math.round(totalTime), !!webcamRequired, opensAt, closesAt, subjectId, !!calculatorAllowed, calculatorAllowed ? calculatorType : null, examId]
    );

    await client.query('DELETE FROM exam_items WHERE exam_id = $1', [examId]);
    for (let i = 0; i < normalizedItems.length; i++) {
      const item = normalizedItems[i];
      await client.query(
        `INSERT INTO exam_items (exam_id, type, position, marks, time_limit_seconds, prompt, options, correct_option_id, word_limit, problem_id, starter_code, test_cases)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [examId, item.type, i, item.marks, item.timeLimitSeconds, item.prompt,
         item.options ? JSON.stringify(item.options) : null, item.correctOptionId, item.wordLimit, item.problemId,
         item.starterCode ? JSON.stringify(item.starterCode) : null, item.testCases ? JSON.stringify(item.testCases) : null]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Exam updated successfully', examId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Exam update error:', error);
    res.status(500).json({ error: 'Failed to update exam' });
  } finally {
    client.release();
  }
});

// Delete an exam â€” exam_items cascade automatically (ON DELETE CASCADE).
// The referenced `problems` rows for any coding items are untouched, since
// those are owned by the Assignments side, not the exam.
router.delete('/api/admin/exams/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const existing = await pool.query('SELECT id, subject_id FROM exams WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
    if (await enforceSubjectAuthority(req, res, existing.rows[0].subject_id)) return;

    const result = await pool.query('DELETE FROM exams WHERE id = $1 RETURNING id, title', [req.params.id]);
    res.status(200).json({ message: `"${result.rows[0].title}" was deleted` });
  } catch (err) {
    console.error('Delete exam error:', err);
    res.status(500).json({ error: 'Failed to delete exam' });
  }
});

// ============================================================================
// CLONE — copies one exam (and its full item set) into one new exam per
// target subject, e.g. running the same test across several sections at
// once instead of rebuilding it by hand each time. Authorized twice: once
// for the source exam's own subject, once per target subject — a teacher
// can only clone FROM a subject they own, and only INTO subjects they own.
// opensAt/closesAt default to the source exam's own schedule but can be
// overridden per clone call (explicit null clears it).
// ============================================================================
router.post('/api/admin/exams/:id/clone', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectIds = Array.isArray(req.body.subjectIds) ? [...new Set(req.body.subjectIds.map(Number).filter(Number.isFinite))] : [];
  if (subjectIds.length === 0) {
    return res.status(400).json({ error: 'At least one target subject is required' });
  }

  try {
    const sourceRes = await pool.query('SELECT * FROM exams WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (sourceRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
    const source = sourceRes.rows[0];
    if (await enforceSubjectAuthority(req, res, source.subject_id)) return;

    for (const sid of subjectIds) {
      if (await enforceSubjectAuthority(req, res, sid)) return;
    }

    const itemsRes = await pool.query('SELECT * FROM exam_items WHERE exam_id = $1 ORDER BY position ASC', [req.params.id]);
    const items = itemsRes.rows;
    const opensAt = req.body.opensAt !== undefined ? req.body.opensAt : source.opens_at;
    const closesAt = req.body.closesAt !== undefined ? req.body.closesAt : source.closes_at;

    const client = await pool.connect();
    const createdIds = [];
    try {
      await client.query('BEGIN');
      for (const sid of subjectIds) {
        const newExamRes = await client.query(
          `INSERT INTO exams (title, description, total_marks, total_time_seconds, webcam_required, opens_at, closes_at, created_by, organization_id, subject_id, calculator_allowed, calculator_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [source.title, source.description, source.total_marks, source.total_time_seconds, source.webcam_required,
           opensAt, closesAt, req.user.userId, req.user.organizationId, sid, source.calculator_allowed, source.calculator_type]
        );
        const newExamId = newExamRes.rows[0].id;
        createdIds.push(newExamId);
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          await client.query(
            `INSERT INTO exam_items (exam_id, type, position, marks, time_limit_seconds, prompt, options, correct_option_id, word_limit, problem_id, starter_code, test_cases)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [newExamId, it.type, i, it.marks, it.time_limit_seconds, it.prompt,
             it.options ? JSON.stringify(it.options) : null, it.correct_option_id, it.word_limit, it.problem_id,
             it.starter_code ? JSON.stringify(it.starter_code) : null, it.test_cases ? JSON.stringify(it.test_cases) : null]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ message: `Cloned into ${createdIds.length} exam${createdIds.length === 1 ? '' : 's'}`, examIds: createdIds });
  } catch (err) {
    console.error('Clone exam error:', err);
    res.status(500).json({ error: 'Failed to clone exam' });
  }
});

// ============================================================================
// QUESTION BANK — reusable exam items, detached from any specific exam
// until ExamForm inserts a copy into one. Same shape/validation as an
// exam_items row (normalizeExamItem), same subject authorization gate as
// every other subject-scoped resource here.
// ============================================================================
router.get('/api/admin/question-bank', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectId = req.query.subjectId != null && req.query.subjectId !== '' ? Number(req.query.subjectId) : null;
  if (await enforceSubjectAuthority(req, res, subjectId)) return;
  try {
    const result = await pool.query(
      `SELECT id, subject_id, type, marks, time_limit_seconds, prompt, options, correct_option_id,
              word_limit, problem_id, starter_code, test_cases, created_at
       FROM question_bank_items
       WHERE organization_id = $1 AND ($2::int IS NULL OR subject_id = $2)
       ORDER BY created_at DESC`,
      [req.user.organizationId, subjectId]
    );
    res.status(200).json({ items: result.rows });
  } catch (err) {
    console.error('List question bank error:', err);
    res.status(500).json({ error: 'Failed to load question bank' });
  }
});

router.post('/api/admin/question-bank', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  if (await enforceSubjectAuthority(req, res, subjectId)) return;

  let item;
  try {
    item = normalizeExamItem(req.body, 0);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (item.type === 'coding' && item.problemId != null) {
    const existing = await pool.query('SELECT id FROM problems WHERE id = $1 AND organization_id = $2', [item.problemId, req.user.organizationId]);
    if (existing.rows.length === 0) return res.status(400).json({ error: 'Coding item references a missing assignment' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO question_bank_items (organization_id, subject_id, type, marks, time_limit_seconds, prompt, options, correct_option_id, word_limit, problem_id, starter_code, test_cases, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [req.user.organizationId, subjectId, item.type, item.marks, item.timeLimitSeconds, item.prompt,
       item.options ? JSON.stringify(item.options) : null, item.correctOptionId, item.wordLimit, item.problemId,
       item.starterCode ? JSON.stringify(item.starterCode) : null, item.testCases ? JSON.stringify(item.testCases) : null, req.user.userId]
    );
    res.status(201).json({ message: 'Saved to question bank', id: result.rows[0].id });
  } catch (err) {
    console.error('Create question bank item error:', err);
    res.status(500).json({ error: 'Failed to save to question bank' });
  }
});

router.delete('/api/admin/question-bank/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const existing = await pool.query('SELECT id, subject_id FROM question_bank_items WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Question bank item not found' });
    if (await enforceSubjectAuthority(req, res, existing.rows[0].subject_id)) return;

    await pool.query('DELETE FROM question_bank_items WHERE id = $1', [req.params.id]);
    res.status(200).json({ message: 'Deleted from question bank' });
  } catch (err) {
    console.error('Delete question bank item error:', err);
    res.status(500).json({ error: 'Failed to delete question bank item' });
  }
});

// ============================================================================
// EXAMS (STUDENT) — the actual exam-taking flow: browse, start, submit.
// One attempt ever per (exam, student), enforced by the UNIQUE(exam_id,
// user_id) constraint on exam_attempts (not just app logic), so a race
// between two tabs/requests can't produce two attempts.
// ============================================================================

// List exams available to the caller, with their own attempt (if any)
// left-joined in so the UI can show "Not started" / "Completed" without a
// second round-trip per exam. Mirrors GET /api/problems: students never see
// an 'upcoming' exam, admins see everything.
router.get('/api/exams', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.title, e.description, e.total_marks, e.total_time_seconds,
              e.opens_at, e.closes_at, e.subject_id, a.status AS attempt_status
       FROM exams e
       LEFT JOIN exam_attempts a ON a.exam_id = e.id AND a.user_id = $1
       WHERE e.organization_id = $2
       ORDER BY e.opens_at NULLS LAST, e.created_at DESC`,
      [req.user.userId, req.user.organizationId]
    );

    const withStatus = result.rows.map((e) => ({ ...e, status: getProblemStatus(e) }));
    let visible = req.user.role === 'student'
      ? withStatus.filter((e) => e.status !== 'upcoming')
      : withStatus;

    if (req.user.role === 'student') {
      const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
      visible = visible.filter((e) => e.subject_id == null || visibleSubjectIds.includes(e.subject_id));
    }

    res.status(200).json({ exams: visible });
  } catch (err) {
    console.error('List exams error:', err);
    res.status(500).json({ error: 'Failed to load exams' });
  }
});

// Pre-start metadata only — item content (prompts/options/correct answers)
// is never exposed here, just a bare summary. Full items are handed to the
// client exactly once, in the response of POST /start.
router.get('/api/exams/:id', authenticateToken, async (req, res) => {
  try {
    const examRes = await pool.query(
      'SELECT id, title, description, total_marks, total_time_seconds, webcam_required, calculator_allowed, calculator_type, opens_at, closes_at FROM exams WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user.organizationId]
    );
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });

    const exam = examRes.rows[0];
    const status = getProblemStatus(exam);
    if (status === 'upcoming' && req.user.role === 'student') {
      return res.status(403).json({ error: 'This exam is not open yet' });
    }

    const itemsRes = await pool.query(
      'SELECT type, marks, position FROM exam_items WHERE exam_id = $1 ORDER BY position ASC',
      [req.params.id]
    );

    const attemptRes = await pool.query(
      'SELECT status FROM exam_attempts WHERE exam_id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );

    res.status(200).json({
      exam: { ...exam, status },
      itemsSummary: itemsRes.rows,
      attemptStatus: attemptRes.rows[0]?.status ?? null,
    });
  } catch (err) {
    console.error('Fetch exam error:', err);
    res.status(500).json({ error: 'Failed to load exam' });
  }
});

// Starts a timed attempt. 409s if one already exists for this student —
// either it's still in_progress (forcibly ended right here as
// 'reopened_stale', since re-entering after leaving is exactly the
// lockdown escape hatch this feature exists to close) or already submitted.
router.post('/api/exams/:id/start', authenticateToken, async (req, res) => {
  const examId = req.params.id;
  try {
    const examRes = await pool.query('SELECT * FROM exams WHERE id = $1 AND organization_id = $2', [examId, req.user.organizationId]);
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });

    const exam = examRes.rows[0];
    const status = getProblemStatus(exam);
    if (status !== 'open' && req.user.role !== 'admin') {
      return res.status(403).json({
        error: status === 'upcoming' ? 'This exam is not open yet' : 'This exam is closed',
      });
    }

    const itemsRes = await pool.query(
      'SELECT * FROM exam_items WHERE exam_id = $1 ORDER BY position ASC',
      [examId]
    );
    const items = itemsRes.rows;

    const deadlineCandidates = [Date.now() + exam.total_time_seconds * 1000];
    if (exam.closes_at) deadlineCandidates.push(new Date(exam.closes_at).getTime());
    const deadlineAt = new Date(Math.min(...deadlineCandidates));

    let attempt;
    try {
      const insertRes = await pool.query(
        'INSERT INTO exam_attempts (exam_id, user_id, deadline_at) VALUES ($1, $2, $3) RETURNING *',
        [examId, req.user.userId, deadlineAt]
      );
      attempt = insertRes.rows[0];
    } catch (err) {
      if (err.code !== '23505') throw err; // not a unique-violation — a real error

      const existingRes = await pool.query(
        'SELECT * FROM exam_attempts WHERE exam_id = $1 AND user_id = $2',
        [examId, req.user.userId]
      );
      const existing = existingRes.rows[0];
      if (existing.status === 'in_progress') {
        const score = await finalizeExamAttempt(existing.id, items, []);
        await pool.query(
          `UPDATE exam_attempts SET status = 'submitted', ended_at = now(), end_reason = 'reopened_stale', score = $1 WHERE id = $2`,
          [score, existing.id]
        );
        return res.status(409).json({ error: 'This exam was already started and has ended — it cannot be restarted.' });
      }
      return res.status(409).json({ error: 'You have already completed this exam.' });
    }

    // Hidden test cases and correct_option_id never leave the server — build
    // a sanitized item list, joining starter code + visible samples for
    // coding items exactly like GET /api/problems/:id does, so the frontend
    // never needs a second privileged fetch mid-exam.
    const codingProblemIds = items.filter((it) => it.type === 'coding' && it.problem_id).map((it) => it.problem_id);
    const starterByProblem = {};
    const samplesByProblem = {};
    const descriptionByProblem = {};
    if (codingProblemIds.length > 0) {
      const starterRes = await pool.query(
        'SELECT problem_id, language, code FROM starter_code WHERE problem_id = ANY($1::int[])',
        [codingProblemIds]
      );
      starterRes.rows.forEach((row) => {
        starterByProblem[row.problem_id] = starterByProblem[row.problem_id] || {};
        starterByProblem[row.problem_id][row.language] = row.code;
      });
      const sampleRes = await pool.query(
        'SELECT problem_id, input, expected_output FROM test_cases WHERE problem_id = ANY($1::int[]) AND is_hidden = false ORDER BY id ASC',
        [codingProblemIds]
      );
      sampleRes.rows.forEach((row) => {
        samplesByProblem[row.problem_id] = samplesByProblem[row.problem_id] || [];
        samplesByProblem[row.problem_id].push({ input: row.input, expected_output: row.expected_output });
      });
      // A "reuse" coding item never collects its own prompt in the exam
      // builder (ExamForm only shows the assignment picker for it) — the
      // question text students see has to be the linked assignment's own
      // description, same as Sandbox.jsx shows for a normal assignment.
      const descRes = await pool.query(
        'SELECT id, description FROM problems WHERE id = ANY($1::int[])',
        [codingProblemIds]
      );
      descRes.rows.forEach((row) => { descriptionByProblem[row.id] = row.description; });
    }

    const sanitizedItems = items.map((it) => {
      const base = { id: it.id, type: it.type, marks: it.marks, prompt: it.prompt };
      if (it.type === 'mcq') return { ...base, options: it.options };
      if (it.type === 'short' || it.type === 'long') return { ...base, wordLimit: it.word_limit };
      if (it.type === 'coding') {
        if (it.problem_id) {
          return {
            ...base,
            prompt: it.prompt || descriptionByProblem[it.problem_id] || null,
            starterCode: starterByProblem[it.problem_id] || {},
            samples: samplesByProblem[it.problem_id] || [],
          };
        }
        // Custom-authored item — everything already lives inline on the
        // item itself, no join needed. Hidden cases are filtered out here,
        // same as the reuse path filters them out at the SQL level above.
        const customSamples = Array.isArray(it.test_cases)
          ? it.test_cases.filter((tc) => !tc.isHidden).map((tc) => ({ input: tc.input, expected_output: tc.expectedOutput }))
          : [];
        return { ...base, starterCode: it.starter_code || {}, samples: customSamples };
      }
      return base;
    });

    res.status(201).json({
      attemptId: attempt.id,
      deadlineAt: attempt.deadline_at,
      exam: { id: exam.id, title: exam.title, totalMarks: exam.total_marks, totalTimeSeconds: exam.total_time_seconds, calculatorAllowed: exam.calculator_allowed, calculatorType: exam.calculator_type },
      items: sanitizedItems,
    });
  } catch (err) {
    console.error('Start exam error:', err);
    res.status(500).json({ error: 'Failed to start exam' });
  }
});

// Ends the caller's attempt — the single endpoint behind the manual Submit
// button, every lockdown violation, time-up, AND the pagehide/beforeunload
// keepalive beacon (see useExamLockdown.js), all funneling through one
// `reason`. The UPDATE ... WHERE status = 'in_progress' claim is atomic, so
// a violation firing at the same moment as the unload beacon (or a student
// double-clicking Submit) can't double-grade — the loser just gets back
// `alreadyEnded: true` instead of an error.
const EXAM_END_REASONS = new Set([
  'manual', 'time_up', 'violation_visibility', 'violation_blur',
  'violation_fullscreen_exit', 'violation_unload',
  'violation_proctor_absence', 'violation_proctor_phone',
]);
// The two ML-proctoring reasons additionally get an exam_proctor_flags row
// (in the same shape minor flags use) so the admin timeline shows the exact
// event that ended the exam, not just the bare end_reason string.
const PROCTOR_END_REASONS = new Set(['violation_proctor_absence', 'violation_proctor_phone']);

// Uploads the ONE compiled PDF covering every scan-type item's captured
// pages for this attempt — a separate route from POST /submit below
// (rather than folding the file into that one) because /submit is also
// what the pagehide/beforeunload keepalive beacon hits, and a beacon can't
// realistically carry a multi-page scan through an interactive camera
// flow. The frontend calls this first, while the attempt is still
// in_progress (right after the on-screen items are answered but before
// the real ending submit), then calls /submit as normal straight after.
router.post('/api/exams/:id/scan-submit', authenticateToken, scanUpload.single('file'), async (req, res) => {
  const examId = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'A PDF file is required' });
  if (!isB2Configured()) return res.status(503).json({ error: 'Scanned-assignment storage is not configured yet' });

  try {
    const attemptRes = await pool.query(
      `SELECT id FROM exam_attempts WHERE exam_id = $1 AND user_id = $2 AND status = 'in_progress'`,
      [examId, req.user.userId]
    );
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: 'No in-progress attempt found for this exam' });
    const attemptId = attemptRes.rows[0].id;

    const scanItemsRes = await pool.query(`SELECT id FROM exam_items WHERE exam_id = $1 AND type = 'scan'`, [examId]);
    if (scanItemsRes.rows.length === 0) return res.status(400).json({ error: 'This exam has no scanned items' });

    const objectKey = examScanObjectKey(req.user.organizationId, examId, attemptId);
    await uploadScanPdf(objectKey, req.file.buffer);
    await pool.query(
      `UPDATE exam_attempts SET scan_storage_key = $1, scan_status = 'pending' WHERE id = $2`,
      [objectKey, attemptId]
    );

    // Pre-create the placeholder rows now (ai_assessment/marks NULL) so
    // grading UI has something to show immediately, same as the /submit
    // route's own belt-and-braces insert for whoever skips scanning
    // entirely — ON CONFLICT DO NOTHING makes the two safe to overlap.
    for (const item of scanItemsRes.rows) {
      await pool.query(
        `INSERT INTO exam_scan_answers (attempt_id, item_id) VALUES ($1, $2) ON CONFLICT (attempt_id, item_id) DO NOTHING`,
        [attemptId, item.id]
      );
    }

    if (isOcrConfigured() && !examScanOcrInFlight.has(attemptId)) {
      examScanOcrInFlight.add(attemptId);
      ocrLimit(() => processOneExamScanAttempt(attemptId)).finally(() => examScanOcrInFlight.delete(attemptId));
    }

    res.status(201).json({ status: 'pending' });
  } catch (err) {
    console.error('Exam scan submit error:', err);
    res.status(500).json({ error: 'Failed to upload scanned pages' });
  }
});

router.post('/api/exams/:id/submit', authenticateToken, async (req, res) => {
  const examId = req.params.id;
  const { reason, answers = [], detail = null } = req.body;
  if (!EXAM_END_REASONS.has(reason)) {
    return res.status(400).json({ error: 'Invalid submit reason' });
  }

  try {
    const claimRes = await pool.query(
      `UPDATE exam_attempts SET status = 'submitted', ended_at = now(), end_reason = $1
       WHERE exam_id = $2 AND user_id = $3 AND status = 'in_progress' RETURNING id`,
      [reason, examId, req.user.userId]
    );
    if (claimRes.rows.length === 0) {
      return res.status(200).json({ alreadyEnded: true });
    }

    const attemptId = claimRes.rows[0].id;
    const itemsRes = await pool.query('SELECT * FROM exam_items WHERE exam_id = $1', [examId]);
    const score = await finalizeExamAttempt(attemptId, itemsRes.rows, answers);
    await pool.query('UPDATE exam_attempts SET score = $1 WHERE id = $2', [score, attemptId]);

    // Guarantees every scan-type item has an exam_scan_answers row (marks
    // NULL until a teacher grades it) even if the student never actually
    // scanned anything — see POST /api/exams/:id/scan-submit, called
    // separately (and earlier, while still in_progress) for the actual PDF
    // upload. ON CONFLICT DO NOTHING so a row that upload already created
    // (with its ai_assessment already set) is never clobbered here.
    const scanItems = itemsRes.rows.filter((it) => it.type === 'scan');
    for (const item of scanItems) {
      await pool.query(
        `INSERT INTO exam_scan_answers (attempt_id, item_id) VALUES ($1, $2) ON CONFLICT (attempt_id, item_id) DO NOTHING`,
        [attemptId, item.id]
      );
    }

    if (PROCTOR_END_REASONS.has(reason)) {
      const flagType = reason === 'violation_proctor_absence' ? 'face_absent' : 'phone_detected';
      await pool.query(
        'INSERT INTO exam_proctor_flags (attempt_id, severity, flag_type, detail) VALUES ($1, $2, $3, $4)',
        [attemptId, 'major', flagType, detail]
      );
    }

    res.status(200).json({ submitted: true });

    // Fire-and-forget, after the response — see runExamShortLongAiAssessment's
    // own comment for why this can't be awaited inline. Shares ocrLimit with
    // the scan pipeline's own Groq calls so a burst of exam submissions at
    // the end of a deadline window doesn't fan out unbounded concurrent
    // requests to the same rate-limited API.
    ocrLimit(() => runExamShortLongAiAssessment(attemptId, itemsRes.rows))
      .catch((err) => console.error('Background exam AI assessment error:', err));
  } catch (err) {
    console.error('Submit exam error:', err);
    res.status(500).json({ error: 'Failed to submit exam' });
  }
});

// Student's own result for one exam — whichever of the two tags are
// currently switched on platform-wide (see tag_visibility_settings), both
// per-exam and overall. Raw score is never returned here regardless of the
// toggle — that stays teacher-only, unconditionally.
router.get('/api/exams/:id/result', authenticateToken, async (req, res) => {
  const examId = req.params.id;
  try {
    const attemptRes = await pool.query(
      'SELECT id, status, score FROM exam_attempts WHERE exam_id = $1 AND user_id = $2',
      [examId, req.user.userId]
    );
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: 'No attempt found for this exam' });

    const attempt = attemptRes.rows[0];
    if (attempt.status !== 'submitted') {
      return res.status(409).json({ error: 'This exam has not been finished yet' });
    }

    const examRes = await pool.query('SELECT total_marks, closes_at FROM exams WHERE id = $1', [examId]);
    const exam = examRes.rows[0];

    // Deadline gate: don't reveal rankings while other students might
    // still be mid-exam — an early finisher shouldn't see a percentile
    // computed from a tiny, still-growing population. No closes_at means
    // no deadline to wait for at all.
    if (exam.closes_at && new Date(exam.closes_at) > new Date()) {
      return res.status(200).json({ status: 'pending', reason: 'deadline' });
    }

    const fullyGraded = await isAttemptFullyGraded(attempt.id);
    if (!fullyGraded) {
      return res.status(200).json({ status: 'pending', reason: 'grading' });
    }

    const totalMarks = exam.total_marks;
    const myPercentage = totalMarks > 0 ? (attempt.score / totalMarks) * 100 : 0;

    // Per-exam percentile, among this exam's own fully-graded population.
    // No extra deadline filter needed here — we only ever reach this line
    // once this exam's own closes_at has already passed.
    const examAttemptsRes = await pool.query(
      `SELECT a.score,
              NOT EXISTS (
                SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
                WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
              ) AND NOT EXISTS (
                SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = a.id AND esa.marks_awarded IS NULL
              ) AS fully_graded
       FROM exam_attempts a WHERE a.exam_id = $1 AND a.status = 'submitted'`,
      [examId]
    );
    const examPercentages = totalMarks > 0
      ? examAttemptsRes.rows.filter((a) => a.fully_graded).map((a) => (a.score / totalMarks) * 100)
      : [];
    const { tag: percentileTag, percentile } = computePercentileTiers(examPercentages)(myPercentage);

    // Overall (exams) percentile: every student's average % across their
    // own fully-graded exams, but only counting exams whose OWN deadline
    // has passed — otherwise a still-open exam elsewhere would already be
    // skewing everyone's "overall" before it's actually concluded.
    const overallRes = await pool.query(
      `SELECT a.user_id, AVG(a.score::float / e.total_marks * 100) AS avg_percentage
       FROM exam_attempts a
       JOIN exams e ON e.id = a.exam_id
       WHERE a.status = 'submitted' AND e.total_marks > 0 AND e.organization_id = $1
         AND (e.closes_at IS NULL OR e.closes_at <= now())
         AND NOT EXISTS (
           SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
           WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = a.id AND esa.marks_awarded IS NULL
         )
       GROUP BY a.user_id`,
      [req.user.organizationId]
    );
    const overallPercentileFor = computePercentileTiers(overallRes.rows.map((r) => Number(r.avg_percentage)));
    const myOverall = overallRes.rows.find((r) => r.user_id === req.user.userId);
    const overallExamsPercentileTag = myOverall ? overallPercentileFor(Number(myOverall.avg_percentage)).tag : null;

    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [req.user.organizationId]);
    const gradeTag = gradeTagForPercentage(bandsRes.rows, myPercentage);

    const visibility = await getTagVisibility(req.user.organizationId);
    res.status(200).json({
      status: 'graded',
      percentileTag: visibility.show_percentile_tag ? percentileTag : undefined,
      percentile: visibility.show_percentile_tag ? percentile : undefined,
      populationSize: visibility.show_percentile_tag ? examPercentages.length : undefined,
      overallExamsPercentileTag: visibility.show_percentile_tag ? overallExamsPercentileTag : undefined,
      gradeTag: visibility.show_grade_tag ? gradeTag : undefined,
    });
  } catch (err) {
    console.error('Exam result error:', err);
    res.status(500).json({ error: 'Failed to load result' });
  }
});

// Per-question breakdown for the "per question" factor on MyPerformance's
// exam graph — every exam has real per-item marks (exam_items.marks vs
// this attempt's own marks_awarded, whichever of exam_answers/
// exam_scan_answers holds this item), unlike assignments where only
// scan-mode ones do.
router.get('/api/exams/:id/questions', authenticateToken, async (req, res) => {
  const examId = req.params.id;
  try {
    const attemptRes = await pool.query('SELECT id, status FROM exam_attempts WHERE exam_id = $1 AND user_id = $2', [examId, req.user.userId]);
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: 'No attempt found for this exam' });
    if (attemptRes.rows[0].status !== 'submitted') return res.status(409).json({ error: 'This exam has not been finished yet' });
    const attemptId = attemptRes.rows[0].id;

    const examRes = await pool.query('SELECT closes_at FROM exams WHERE id = $1', [examId]);
    if (examRes.rows[0]?.closes_at && new Date(examRes.rows[0].closes_at) > new Date()) {
      return res.status(200).json({ status: 'pending', reason: 'deadline' });
    }
    if (!(await isAttemptFullyGraded(attemptId))) {
      return res.status(200).json({ status: 'pending', reason: 'grading' });
    }

    const itemsRes = await pool.query(
      `SELECT i.position, i.marks AS max_marks,
              COALESCE(ea.marks_awarded, esa.marks_awarded) AS marks_awarded
       FROM exam_items i
       LEFT JOIN exam_answers ea ON ea.item_id = i.id AND ea.attempt_id = $1
       LEFT JOIN exam_scan_answers esa ON esa.item_id = i.id AND esa.attempt_id = $1
       WHERE i.exam_id = $2
       ORDER BY i.position ASC`,
      [attemptId, examId]
    );
    res.status(200).json({
      status: 'graded',
      questions: itemsRes.rows.map((r, i) => ({
        label: `Q${r.position ?? i + 1}`,
        earned: r.marks_awarded != null ? Number(r.marks_awarded) : null,
        max: Number(r.max_marks),
      })),
    });
  } catch (err) {
    console.error('Exam questions breakdown error:', err);
    res.status(500).json({ error: 'Failed to load question breakdown' });
  }
});

const PROCTOR_FLAG_SEVERITIES = new Set(['minor', 'major']);

// Logs a non-ending ML-proctoring observation (head turned, gaze away —
// things that are ambiguous on their own and shouldn't interrupt the
// exam). Major, exam-ending flags don't come through here — they go
// through POST /submit with a violation_proctor_* reason instead, which
// both ends the attempt and logs the flag in one atomic step. Silently
// no-ops if the caller has no in_progress attempt for this exam (harmless:
// either they already finished, or a stray flag arrived after the fact).
router.post('/api/exams/:id/proctor-flag', authenticateToken, async (req, res) => {
  const { severity, flagType, detail = null } = req.body;
  if (!PROCTOR_FLAG_SEVERITIES.has(severity) || !flagType) {
    return res.status(400).json({ error: 'Invalid proctor flag' });
  }

  try {
    const attemptRes = await pool.query(
      `SELECT id FROM exam_attempts WHERE exam_id = $1 AND user_id = $2 AND status = 'in_progress'`,
      [req.params.id, req.user.userId]
    );
    if (attemptRes.rows.length === 0) {
      return res.status(200).json({ logged: false });
    }

    await pool.query(
      'INSERT INTO exam_proctor_flags (attempt_id, severity, flag_type, detail) VALUES ($1, $2, $3, $4)',
      [attemptRes.rows[0].id, severity, String(flagType), detail]
    );
    res.status(200).json({ logged: true });
  } catch (err) {
    console.error('Log proctor flag error:', err);
    res.status(500).json({ error: 'Failed to log proctor flag' });
  }
});

// Every attempt at one exam, with its flag counts, for the flag timeline
// viewer in the Exams panel's "Attempts" expander — reachable by any
// teacher there too (see GET /api/admin/exams's own comment: same
// "list route was the one inconsistent requireAdmin holdout" bug), so
// requireAdminOrTeacher here as well. The query itself is already scoped
// to one exam within the caller's own org, nothing admin-specific in it.
router.get('/api/admin/exams/:id/attempts', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const examRes = await pool.query('SELECT total_marks, subject_id FROM exams WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
    if (await enforceSubjectAuthority(req, res, examRes.rows[0].subject_id)) return;
    const totalMarks = examRes.rows[0].total_marks;

    const result = await pool.query(
      `SELECT a.id, a.status, a.score, a.end_reason, a.started_at, a.ended_at, u.email, u.name,
              COUNT(f.id) FILTER (WHERE f.severity = 'minor') AS minor_flag_count,
              COUNT(f.id) FILTER (WHERE f.severity = 'major') AS major_flag_count,
              NOT EXISTS (
                SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
                WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
              ) AND NOT EXISTS (
                SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = a.id AND esa.marks_awarded IS NULL
              ) AS fully_graded
       FROM exam_attempts a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN exam_proctor_flags f ON f.attempt_id = a.id
       WHERE a.exam_id = $1
       GROUP BY a.id, u.email, u.name
       ORDER BY a.started_at DESC`,
      [req.params.id]
    );

    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [req.user.organizationId]);
    const bands = bandsRes.rows;

    // Percentile is relative to this exam's own fully-graded population —
    // an attempt not yet fully graded isn't in the ranking pool at all
    // (its own percentage isn't final yet either).
    const gradedPercentages = totalMarks > 0
      ? result.rows.filter((a) => a.status === 'submitted' && a.fully_graded).map((a) => (a.score / totalMarks) * 100)
      : [];
    const percentileFor = computePercentileTiers(gradedPercentages);

    const attempts = result.rows.map((a) => {
      const eligible = a.status === 'submitted' && a.fully_graded && totalMarks > 0;
      const percentage = eligible ? (a.score / totalMarks) * 100 : null;
      const { tag: percentileTag } = eligible ? percentileFor(percentage) : { tag: null };
      return {
        ...a,
        percentage,
        gradeTag: eligible ? gradeTagForPercentage(bands, percentage) : null,
        percentileTag,
      };
    });

    res.status(200).json({ attempts });
  } catch (err) {
    console.error('List exam attempts error:', err);
    res.status(500).json({ error: 'Failed to load attempts' });
  }
});

// requireAdminOrTeacher + enforceSubjectAuthority, not requireAdmin — same
// bug/fix as every other route in this exam-grading block: reachable from
// the teacher-only Exams attempts expander, but a teacher could never
// actually load it. Scoped to the exam's own subject_id.
router.get('/api/admin/exam-attempts/:attemptId/flags', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    // exam_proctor_flags has no organization_id of its own — scoped
    // transitively via attempt -> exam, checked here so one org's admin
    // can't read another's flag timeline by guessing an attempt id.
    const examRes = await pool.query(
      `SELECT e.subject_id FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND e.organization_id = $2`,
      [req.params.attemptId, req.user.organizationId]
    );
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Attempt not found' });
    if (await enforceSubjectAuthority(req, res, examRes.rows[0].subject_id)) return;

    const result = await pool.query(
      `SELECT f.severity, f.flag_type, f.detail, f.created_at
       FROM exam_proctor_flags f
       JOIN exam_attempts a ON a.id = f.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE f.attempt_id = $1 AND e.organization_id = $2
       ORDER BY f.created_at ASC`,
      [req.params.attemptId, req.user.organizationId]
    );
    res.status(200).json({ flags: result.rows });
  } catch (err) {
    console.error('List proctor flags error:', err);
    res.status(500).json({ error: 'Failed to load flags' });
  }
});

// Admin: every answer in one attempt, joined with its item's prompt/marks —
// powers the grading UI (short/long) and doubles as a full answer review
// for every item type, not just the ones needing manual grading.
router.get('/api/admin/exam-attempts/:attemptId/answers', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const examRes = await pool.query(
      `SELECT e.subject_id FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND e.organization_id = $2`,
      [req.params.attemptId, req.user.organizationId]
    );
    if (examRes.rows.length === 0) return res.status(404).json({ error: 'Attempt not found' });
    if (await enforceSubjectAuthority(req, res, examRes.rows[0].subject_id)) return;

    const result = await pool.query(
      `SELECT ea.id AS answer_id, ei.id AS item_id, ei.type, ei.prompt, ei.marks, ei.options,
              ea.marks_awarded, ea.selected_option_id, ea.text_answer, ea.is_correct,
              ea.passed_count, ea.total_count, ea.code, ea.language, ea.remarks, ea.ai_assessment
       FROM exam_answers ea
       JOIN exam_items ei ON ei.id = ea.item_id
       JOIN exam_attempts a ON a.id = ea.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE ea.attempt_id = $1 AND e.organization_id = $2
       ORDER BY ei.position ASC`,
      [req.params.attemptId, req.user.organizationId]
    );

    // scan items live in a separate table (see exam_scan_answers' own
    // comment) — folded into the same response so the grading UI doesn't
    // need a second round trip. attemptScan is null for an attempt with no
    // scan-type items at all (the common case — most exams have none).
    const scanAnswersRes = await pool.query(
      `SELECT esa.id AS answer_id, ei.id AS item_id, ei.type, ei.prompt, ei.marks,
              esa.marks_awarded, esa.ai_assessment, esa.remarks
       FROM exam_scan_answers esa
       JOIN exam_items ei ON ei.id = esa.item_id
       JOIN exam_attempts a ON a.id = esa.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE esa.attempt_id = $1 AND e.organization_id = $2
       ORDER BY ei.position ASC`,
      [req.params.attemptId, req.user.organizationId]
    );

    let attemptScan = null;
    if (scanAnswersRes.rows.length > 0) {
      const attemptRes = await pool.query(
        `SELECT a.scan_storage_key, a.scan_status, a.scan_ocr_text, a.scan_ocr_pages, a.scan_ocr_error
         FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
         WHERE a.id = $1 AND e.organization_id = $2`,
        [req.params.attemptId, req.user.organizationId]
      );
      const row = attemptRes.rows[0];
      attemptScan = row && {
        status: row.scan_storage_key ? (row.scan_status || 'pending') : null,
        ocrText: row.scan_ocr_text,
        ocrPages: row.scan_ocr_pages,
        ocrError: row.scan_ocr_error,
        viewUrl: row.scan_storage_key && isB2Configured() ? await getScanPdfUrl(row.scan_storage_key) : null,
      };
    }

    const overallRemarksRes = await pool.query(
      `SELECT a.overall_remarks FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND e.organization_id = $2`,
      [req.params.attemptId, req.user.organizationId]
    );
    const overallRemarks = overallRemarksRes.rows[0] ? overallRemarksRes.rows[0].overall_remarks : null;

    res.status(200).json({ answers: result.rows, scanAnswers: scanAnswersRes.rows, attemptScan, overallRemarks });
  } catch (err) {
    console.error('List exam answers error:', err);
    res.status(500).json({ error: 'Failed to load answers' });
  }
});

// Admin: manually award marks and/or remarks for one answer. Marks stay
// restricted to short/long (mcq/coding stay auto-graded), but remarks can be
// left on any item type — both fields are independently optional (undefined
// means "don't touch"), same pattern as the assignment grading route.
router.put('/api/admin/exam-answers/:answerId/grade', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const answerRes = await pool.query(
      `SELECT ea.id, ea.attempt_id, ei.type, ei.marks, e.subject_id
       FROM exam_answers ea
       JOIN exam_items ei ON ei.id = ea.item_id
       JOIN exam_attempts a ON a.id = ea.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE ea.id = $1 AND e.organization_id = $2`,
      [req.params.answerId, req.user.organizationId]
    );
    if (answerRes.rows.length === 0) return res.status(404).json({ error: 'Answer not found' });
    if (await enforceSubjectAuthority(req, res, answerRes.rows[0].subject_id)) return;

    const answer = answerRes.rows[0];

    if (req.body.marksAwarded !== undefined) {
      if (answer.type !== 'short' && answer.type !== 'long') {
        return res.status(400).json({ error: 'Only short/long answers can be manually graded' });
      }
      const marksAwarded = Number(req.body.marksAwarded);
      if (!Number.isFinite(marksAwarded) || marksAwarded < 0 || marksAwarded > answer.marks) {
        return res.status(400).json({ error: `Marks must be between 0 and ${answer.marks}` });
      }
      await pool.query('UPDATE exam_answers SET marks_awarded = $1 WHERE id = $2', [Math.round(marksAwarded), answer.id]);
      logSecurityEvent(req, 'grade_overridden', { detail: { kind: 'exam_answer', answerId: answer.id, attemptId: answer.attempt_id, marksAwarded: Math.round(marksAwarded) } });
    }

    if (req.body.remarks !== undefined) {
      const remarks = String(req.body.remarks).trim() || null;
      await pool.query('UPDATE exam_answers SET remarks = $1 WHERE id = $2', [remarks, answer.id]);
    }

    const score = await recomputeExamAttemptScore(answer.attempt_id);
    const fullyGraded = await isAttemptFullyGraded(answer.attempt_id);
    res.status(200).json({ score, fullyGraded });
  } catch (err) {
    console.error('Grade exam answer error:', err);
    res.status(500).json({ error: 'Failed to save grade' });
  }
});

// Admin: manually award marks and/or remarks for one scan item's answer.
// Every row in exam_scan_answers is inherently a scan-type item by
// construction (see POST /api/exams/:id/submit / scan-submit), so there's
// no type check to make here the way the short/long route above needs one.
router.put('/api/admin/exam-scan-answers/:answerId/grade', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const answerRes = await pool.query(
      `SELECT esa.id, esa.attempt_id, ei.marks, e.subject_id
       FROM exam_scan_answers esa
       JOIN exam_items ei ON ei.id = esa.item_id
       JOIN exam_attempts a ON a.id = esa.attempt_id
       JOIN exams e ON e.id = a.exam_id
       WHERE esa.id = $1 AND e.organization_id = $2`,
      [req.params.answerId, req.user.organizationId]
    );
    if (answerRes.rows.length === 0) return res.status(404).json({ error: 'Answer not found' });
    if (await enforceSubjectAuthority(req, res, answerRes.rows[0].subject_id)) return;

    const answer = answerRes.rows[0];

    if (req.body.marksAwarded !== undefined) {
      const marksAwarded = Number(req.body.marksAwarded);
      if (!Number.isFinite(marksAwarded) || marksAwarded < 0 || marksAwarded > answer.marks) {
        return res.status(400).json({ error: `Marks must be between 0 and ${answer.marks}` });
      }
      await pool.query('UPDATE exam_scan_answers SET marks_awarded = $1 WHERE id = $2', [Math.round(marksAwarded), answer.id]);
      logSecurityEvent(req, 'grade_overridden', { detail: { kind: 'exam_scan_answer', answerId: answer.id, attemptId: answer.attempt_id, marksAwarded: Math.round(marksAwarded) } });
    }

    if (req.body.remarks !== undefined) {
      const remarks = String(req.body.remarks).trim() || null;
      await pool.query('UPDATE exam_scan_answers SET remarks = $1 WHERE id = $2', [remarks, answer.id]);
    }

    const score = await recomputeExamAttemptScore(answer.attempt_id);
    const fullyGraded = await isAttemptFullyGraded(answer.attempt_id);
    res.status(200).json({ score, fullyGraded });
  } catch (err) {
    console.error('Grade exam scan answer error:', err);
    res.status(500).json({ error: 'Failed to save grade' });
  }
});

// Admin: set the overall remarks for an exam attempt (separate from any
// per-question remarks above).
router.put('/api/admin/exam-attempts/:attemptId/remarks', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const attemptRes = await pool.query(
      `SELECT a.id, e.subject_id FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND e.organization_id = $2`,
      [req.params.attemptId, req.user.organizationId]
    );
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: 'Attempt not found' });
    if (await enforceSubjectAuthority(req, res, attemptRes.rows[0].subject_id)) return;

    const overallRemarks = String(req.body.overallRemarks || '').trim() || null;
    await pool.query('UPDATE exam_attempts SET overall_remarks = $1 WHERE id = $2', [overallRemarks, req.params.attemptId]);
    res.status(200).json({ overallRemarks });
  } catch (err) {
    console.error('Set exam attempt remarks error:', err);
    res.status(500).json({ error: 'Failed to save remarks' });
  }
});

// Manually triggers OCR for one exam attempt's scanned pages right now,
// instead of waiting — mirrors POST /api/admin/scan-submissions/:id/process
// for assignments. Exams have no shared deadline sweep to wait on in the
// first place (see processOneExamScanAttempt's own comment), so this is
// really just for retrying an ocr_failed attempt.
router.post('/api/admin/exam-attempts/:attemptId/process-scan', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const attemptRes = await pool.query(
      `SELECT a.id, a.scan_storage_key, e.subject_id FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND e.organization_id = $2`,
      [req.params.attemptId, req.user.organizationId]
    );
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: 'Attempt not found' });
    if (await enforceSubjectAuthority(req, res, attemptRes.rows[0].subject_id)) return;
    if (!attemptRes.rows[0].scan_storage_key) return res.status(400).json({ error: 'No scanned pages were submitted for this attempt' });
    if (!isB2Configured()) return res.status(503).json({ error: 'Scanned-assignment storage is not configured yet' });
    if (!isOcrConfigured()) return res.status(503).json({ error: 'OCR is not configured yet' });

    const attemptId = attemptRes.rows[0].id;
    if (examScanOcrInFlight.has(attemptId)) return res.status(409).json({ error: 'Already processing' });

    examScanOcrInFlight.add(attemptId);
    ocrLimit(() => processOneExamScanAttempt(attemptId)).finally(() => examScanOcrInFlight.delete(attemptId));
    res.status(202).json({ status: 'processing' });
  } catch (err) {
    console.error('Manual exam scan OCR trigger error:', err);
    res.status(500).json({ error: 'Failed to start OCR' });
  }
});

module.exports = router;
