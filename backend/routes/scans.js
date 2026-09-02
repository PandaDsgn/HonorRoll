// Scan/OCR pipeline — everything scan-related: student scan-context/
// scan-submit/scan-submission-status, admin scan-submission review/
// grading, scan-flags, code-flags, plagiarism settings, and the
// actual OCR + plagiarism/handwriting comparator processing pipeline
// itself. Split out of index.js as part of breaking that monolith
// into modules. Pure relocation. Mounted with no prefix in index.js
// — every path below is the exact full path it always was.
const express = require('express');
const router = express.Router();
const { pool } = require('../lib/db');
const { authenticateToken, requireAdmin, requireAdminOrTeacher, enforceSubjectAuthority } = require('../lib/auth');
const { getOrgUnitLookup, resolveOrgUnitPath, getProblemStatus } = require('../lib/performance');
const { gradeCodingAnswer } = require('../lib/examGrading');
const { jaccardSimilarity, runCodePlagiarismComparator } = require('../lib/plagiarism');
const { ocrLimit } = require('../lib/examScanPipeline');
const { scanUpload } = require('../lib/uploads');
const { logSecurityEvent } = require('../lib/securityEvents');
const {
  isB2Configured, scanObjectKey, uploadScanPdf, deleteScanPdf, getScanPdfUrl, downloadScanPdf,
} = require('../storage');
const { createNotificationsBulk } = require('../lib/notifications');
const { isOcrConfigured, runOcr } = require('../ocrClient');
const { isGroqConfigured, assessAnswers } = require('../aiGrading');
const { ensureScanSubmissionsSchema, ensureNotificationsSchema } = require('../schema');

// SCANNED ASSIGNMENTS — Phase 2. Client-side capture/bundling/upload only;
// no OCR/comparator processing happens yet (see ensureScanSubmissionsSchema
// etc. above — those tables exist, but the columns OCR would fill in stay
// NULL until a later phase runs the actual pipeline against 'pending' rows).
// ============================================================================

// Resolves everything the frontend needs to build the auto-filename
// (<student>_<class>_<roll>_<assignment>_<subject>.pdf) — kept server-side
// rather than reimplemented in the frontend, since org-tree path resolution
// (getOrgUnitLookup/resolveOrgUnitPath) and roll-number/subject lookups
// already exist here and nowhere on the client.
router.get('/api/me/scan-context', authenticateToken, async (req, res) => {
  const problemId = req.query.problemId;
  if (!problemId) return res.status(400).json({ error: 'problemId is required' });

  try {
    const problemRes = await pool.query(
      `SELECT p.assignment_no, p.submission_mode, s.name AS subject_name
       FROM problems p LEFT JOIN subjects s ON s.id = p.subject_id
       WHERE p.id = $1 AND p.organization_id = $2`,
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    if (problemRes.rows[0].submission_mode !== 'scan') {
      return res.status(400).json({ error: 'This assignment does not accept scanned submissions' });
    }

    const userRes = await pool.query(
      `SELECT u.name, m.org_unit_id, m.roll_number
       FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2
       WHERE u.id = $1`,
      [req.user.userId, req.user.organizationId]
    );
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Membership not found' });
    const { name, org_unit_id: orgUnitId, roll_number: rollNumber } = userRes.rows[0];

    const unitLookup = await getOrgUnitLookup(req.user.organizationId);
    const classPath = resolveOrgUnitPath(unitLookup, orgUnitId).map((p) => p.name).join(' ');

    // Shown to the student before the camera opens (see ScanCapture.jsx's
    // pre-scan questions screen) — they should know what's being asked
    // before they start scanning, not find out by re-reading a paper copy.
    // Also what actually drives the on-screen answer form for mcq/short/
    // long/coding items — same sanitization posture as exam_items' own
    // GET /api/exams/:id/start (hidden test cases and correct_option_id
    // never leave the server).
    const questionsRes = await pool.query(
      `SELECT id, prompt, marks, type, options, word_limit, starter_code, test_cases
       FROM scan_assignment_questions WHERE problem_id = $1 ORDER BY position ASC`,
      [problemId]
    );
    const questions = questionsRes.rows.map((q) => {
      const base = { id: q.id, type: q.type, marks: q.marks, prompt: q.prompt };
      if (q.type === 'mcq') return { ...base, options: q.options };
      if (q.type === 'short' || q.type === 'long') return { ...base, wordLimit: q.word_limit };
      if (q.type === 'coding') {
        const samples = Array.isArray(q.test_cases)
          ? q.test_cases.filter((tc) => !tc.isHidden).map((tc) => ({ input: tc.input, expected_output: tc.expectedOutput }))
          : [];
        return { ...base, starterCode: q.starter_code || {}, samples };
      }
      return base; // scan
    });

    res.status(200).json({
      studentName: name || null,
      classPath: classPath || null,
      rollNumber: rollNumber || null,
      assignmentNo: problemRes.rows[0].assignment_no,
      subjectName: problemRes.rows[0].subject_name || null,
      questions,
    });
  } catch (err) {
    console.error('Scan context error:', err);
    res.status(500).json({ error: 'Failed to load scan context' });
  }
});

// Accepts the client-bundled PDF, uploads it to B2, and records a 'pending'
// row — no OCR is triggered here. OCR is deliberately deferred until the
// assignment's own deadline passes (a later phase's sweep will pick up
// 'pending' rows on already-closed assignments), not run per-upload —
// since a student can resubmit freely up to the deadline (see the
// replace-on-resubmit logic below) and only the LAST submission before
// closes_at is ever graded, running OCR on every intermediate attempt
// would just burn through the OCR Space's free-tier compute on discarded
// work. Responds as soon as the upload completes; the frontend can poll
// GET /api/scan-submissions/:id/status, which for now will just always
// read back 'pending' — accurate given nothing progresses it yet.
// Grades every digital (mcq/short/long/coding) answer against a scan-mode
// assignment's questions, upserting one scan_submission_answers row per
// question — the scan-mode counterpart to finalizeExamAttempt, same
// mcq-exact/coding-partial-credit/short-long-manual split. scan-type
// questions are never touched here (see the OCR pipeline instead — every
// scan item in the assignment shares the ONE compiled PDF this route
// stores, not a per-item row this function would create).
async function finalizeScanSubmissionDigitalAnswers(submissionId, questions, answers) {
  const questionsById = new Map(questions.map((q) => [q.id, q]));

  for (const ans of answers || []) {
    const q = questionsById.get(Number(ans.questionId));
    if (!q || q.type === 'scan') continue;

    let row = {
      selected_option_id: null, text_answer: null, language: null, code: null,
      is_correct: null, passed_count: null, total_count: null, marks_awarded: null,
    };

    if (q.type === 'mcq') {
      const selected = ans.selectedOptionId != null ? String(ans.selectedOptionId) : null;
      const correct = selected != null && selected === q.correct_option_id;
      row.selected_option_id = selected;
      row.is_correct = correct;
      row.marks_awarded = correct ? q.marks : 0;
    } else if (q.type === 'short' || q.type === 'long') {
      row.text_answer = ans.textAnswer != null ? String(ans.textAnswer) : null;
    } else if (q.type === 'coding') {
      const language = ans.language || null;
      const code = ans.code != null ? String(ans.code) : '';
      let passedCount = 0;
      let totalCount = 0;
      try {
        const testCases = Array.isArray(q.test_cases)
          ? q.test_cases.map((tc) => ({ input: tc.input, expected_output: tc.expectedOutput }))
          : [];
        ({ passedCount, totalCount } = await gradeCodingAnswer(testCases, language, code));
      } catch (err) {
        console.error('Scan assignment coding answer grading error:', err);
      }
      row.language = language;
      row.code = code;
      row.passed_count = passedCount;
      row.total_count = totalCount;
      row.marks_awarded = totalCount > 0 ? Math.round((q.marks * passedCount) / totalCount) : 0;
    }

    await pool.query(
      `INSERT INTO scan_submission_answers (submission_id, question_id, selected_option_id, text_answer, language, code, is_correct, passed_count, total_count, marks_awarded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (submission_id, question_id) DO UPDATE SET
         selected_option_id = EXCLUDED.selected_option_id, text_answer = EXCLUDED.text_answer,
         language = EXCLUDED.language, code = EXCLUDED.code, is_correct = EXCLUDED.is_correct,
         passed_count = EXCLUDED.passed_count, total_count = EXCLUDED.total_count, marks_awarded = EXCLUDED.marks_awarded`,
      [submissionId, q.id, row.selected_option_id, row.text_answer, row.language, row.code,
        row.is_correct, row.passed_count, row.total_count, row.marks_awarded]
    );
  }
}

// Mirrors runExamShortLongAiAssessment (see near the exam submit route) for
// the scan-assignment side: same posture — assist-only, one Groq call per
// item, never touches marks_awarded, just a note a teacher sees next to the
// grade input in ScanReview. Needed because processOneScanSubmission's own
// AI-assessment call only ever covers type='scan' questions (see its own
// comment) — short/long questions submitted digitally alongside (or instead
// of) a scan never reach that function, and a scan-mode assignment with
// only short/long questions never reaches it at all (see the initialStatus
// comment below).
async function runScanShortLongAiAssessment(submissionId, questions) {
  if (!isGroqConfigured()) return;
  const shortLongQuestions = questions.filter((q) => q.type === 'short' || q.type === 'long');
  if (shortLongQuestions.length === 0) return;
  const questionsById = new Map(shortLongQuestions.map((q) => [q.id, q]));

  try {
    const answersRes = await pool.query(
      'SELECT id, question_id, text_answer FROM scan_submission_answers WHERE submission_id = $1 AND question_id = ANY($2::int[])',
      [submissionId, shortLongQuestions.map((q) => q.id)]
    );
    for (const row of answersRes.rows) {
      if (!row.text_answer || !row.text_answer.trim()) continue;
      const q = questionsById.get(row.question_id);
      if (!q) continue;
      const [assessment] = await assessAnswers([{ prompt: q.prompt, marks: q.marks }], row.text_answer, { isOcr: false });
      await pool.query('UPDATE scan_submission_answers SET ai_assessment = $1 WHERE id = $2', [assessment || null, row.id]);
    }
  } catch (err) {
    console.error(`Scan short/long AI assessment failed for submission ${submissionId}:`, err);
  }
}

router.post('/api/problems/:id/scan-submit', authenticateToken, scanUpload.single('file'), async (req, res) => {
  const problemId = req.params.id;
  if (!isB2Configured()) return res.status(503).json({ error: 'Scanned-assignment storage is not configured yet' });

  try {
    const problemRes = await pool.query(
      'SELECT submission_mode, opens_at, closes_at FROM problems WHERE id = $1 AND organization_id = $2',
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    if (problemRes.rows[0].submission_mode !== 'scan') {
      return res.status(400).json({ error: 'This assignment does not accept scanned submissions' });
    }
    const status = getProblemStatus(problemRes.rows[0]);
    if (status !== 'open' && req.user.role !== 'admin') {
      return res.status(403).json({ error: status === 'upcoming' ? 'This assignment is not open yet' : 'This assignment is closed' });
    }

    const questionsRes = await pool.query(
      'SELECT * FROM scan_assignment_questions WHERE problem_id = $1 ORDER BY position ASC',
      [problemId]
    );
    const questions = questionsRes.rows;
    const hasScanQuestions = questions.some((q) => q.type === 'scan');
    if (hasScanQuestions && !req.file) return res.status(400).json({ error: 'A PDF file is required' });

    let answers = [];
    if (req.body.answers) {
      try {
        answers = JSON.parse(req.body.answers);
        if (!Array.isArray(answers)) answers = [];
      } catch {
        return res.status(400).json({ error: 'Invalid answers payload' });
      }
    }

    // A student can resubmit as many times as they like before the
    // deadline — each new upload REPLACES the previous one outright (not
    // "keep both, use the latest"), since only the final submission is
    // ever meant to count. Delete the old row's storage object too, not
    // just the DB row, so repeated resubmission doesn't quietly accumulate
    // orphaned files in the bucket.
    const existing = await pool.query(
      'SELECT id, storage_key FROM scan_submissions WHERE problem_id = $1 AND user_id = $2',
      [problemId, req.user.userId]
    );
    if (existing.rows.length > 0) {
      const previous = existing.rows[0];
      await pool.query('DELETE FROM scan_submissions WHERE id = $1', [previous.id]);
      if (previous.storage_key) {
        try {
          await deleteScanPdf(previous.storage_key);
        } catch (err) {
          console.error('Failed to delete superseded scan PDF (continuing anyway):', err);
        }
      }
    }

    const filename = String(req.body.filename || 'scan.pdf').trim();
    // No scan-type questions at all -> nothing ever needs OCR, so this
    // starts (and stays) 'ocr_done' rather than 'pending' — otherwise the
    // deadline sweep would try to download/OCR a storage_key that was
    // never actually uploaded.
    const initialStatus = hasScanQuestions ? 'pending' : 'ocr_done';
    const insertRes = await pool.query(
      `INSERT INTO scan_submissions (problem_id, user_id, storage_key, original_filename, status)
       VALUES ($1, $2, '', $3, $4) RETURNING id`,
      [problemId, req.user.userId, filename, initialStatus]
    );
    const submissionId = insertRes.rows[0].id;

    if (req.file) {
      const objectKey = scanObjectKey(req.user.organizationId, problemId, submissionId);
      await uploadScanPdf(objectKey, req.file.buffer);
      await pool.query('UPDATE scan_submissions SET storage_key = $1 WHERE id = $2', [objectKey, submissionId]);
    }

    await finalizeScanSubmissionDigitalAnswers(submissionId, questions, answers);

    res.status(201).json({ submissionId, status: initialStatus });

    // Fire-and-forget, after the response — see runScanShortLongAiAssessment
    // for why this can't be awaited inline. Shares ocrLimit with the rest of
    // the scan/exam Groq calls so a burst of submissions doesn't fan out
    // unbounded concurrent requests to the same rate-limited API.
    ocrLimit(() => runScanShortLongAiAssessment(submissionId, questions))
      .catch((err) => console.error('Background scan AI assessment error:', err));

    // Fire-and-forget typed-answer plagiarism check — separate from the OCR
    // pipeline's runTextPlagiarismComparator, which only ever fires (via
    // processOneScanSubmission) once the assignment's deadline passes.
    runTypedTextPlagiarismComparator(submissionId, problemId, questions)
      .catch((err) => console.error('Background scan plagiarism check error:', err));
  } catch (err) {
    console.error('Scan submit error:', err);
    res.status(500).json({ error: 'Failed to upload scanned submission' });
  }
});

router.get('/api/scan-submissions/:id/status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ss.id, ss.status, ss.ocr_error, ss.created_at, ss.ocr_completed_at
       FROM scan_submissions ss JOIN problems p ON p.id = ss.problem_id
       WHERE ss.id = $1 AND p.organization_id = $2 AND ss.user_id = $3`,
      [req.params.id, req.user.organizationId, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Submission not found' });
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Scan submission status error:', err);
    res.status(500).json({ error: 'Failed to load submission status' });
  }
});

// A student's own submission for one scan-mode assignment — since a
// resubmission always replaces the previous one (see scan-submit above),
// there's at most one row to find. Returns null (not 404) when the student
// simply hasn't submitted yet, since "not submitted" is a normal, expected
// state for the caller to render around, not an error.
router.get('/api/me/scan-submission', authenticateToken, async (req, res) => {
  const problemId = req.query.problemId;
  if (!problemId) return res.status(400).json({ error: 'problemId is required' });

  try {
    const result = await pool.query(
      `SELECT ss.id, ss.status, ss.original_filename, ss.storage_key, ss.created_at, ss.ocr_error, ss.penalized, ss.overall_remarks
       FROM scan_submissions ss JOIN problems p ON p.id = ss.problem_id
       WHERE ss.problem_id = $1 AND p.organization_id = $2 AND ss.user_id = $3`,
      [problemId, req.user.organizationId, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(200).json({ submission: null });

    const row = result.rows[0];
    const viewUrl = row.storage_key && isB2Configured() ? await getScanPdfUrl(row.storage_key) : null;

    // Only shown once every question has actually been graded — a partial
    // grade-in-progress isn't a result yet. mcq/coding questions get their
    // marks_awarded set automatically at submit time (see
    // finalizeScanSubmissionDigitalAnswers); scan/short/long stay NULL
    // until a teacher enters something via PUT
    // /api/admin/scan-submissions/:id/grade.
    const answersRes = await pool.query(
      `SELECT q.prompt, q.marks AS max_marks, sa.marks_awarded, sa.remarks
       FROM scan_assignment_questions q
       LEFT JOIN scan_submission_answers sa ON sa.question_id = q.id AND sa.submission_id = $1
       WHERE q.problem_id = $2 ORDER BY q.position ASC`,
      [row.id, problemId]
    );
    const fullyGraded = answersRes.rows.length > 0 && answersRes.rows.every((a) => a.marks_awarded !== null);

    res.status(200).json({
      submission: {
        id: row.id,
        status: row.status,
        filename: row.original_filename,
        createdAt: row.created_at,
        ocrError: row.ocr_error,
        penalized: row.penalized,
        viewUrl,
        // A teacher's overall note is visible as soon as it exists, same
        // as any other courtesy feedback — not gated behind fullyGraded
        // the way the actual score/percentile-affecting grade is below.
        overallRemarks: row.overall_remarks,
        grade: fullyGraded ? {
          totalMarks: answersRes.rows.reduce((sum, a) => sum + a.max_marks, 0),
          awardedMarks: row.penalized ? 0 : answersRes.rows.reduce((sum, a) => sum + a.marks_awarded, 0),
          questions: answersRes.rows.map((a) => ({ prompt: a.prompt, maxMarks: a.max_marks, marksAwarded: row.penalized ? 0 : a.marks_awarded, remarks: a.remarks })),
        } : null,
      },
    });
  } catch (err) {
    console.error('Get own scan submission error:', err);
    res.status(500).json({ error: 'Failed to load your submission' });
  }
});

// Every student's scan submission for one assignment — admin-only, same
// gating as the code-judge equivalent (GET /api/admin/problems/:id/attempts)
// right above this, which is also requireAdmin-only rather than
// requireAdminOrTeacher; matched here for consistency rather than widening
// access unilaterally. At most one row per student (see the UNIQUE
// (problem_id, user_id) index), so this is already every student's FINAL
// submission, not a "best of many" pick the way code-judge attempts are.
router.get('/api/admin/problems/:id/scan-submissions', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;

    const totalMarksRes = await pool.query('SELECT COALESCE(SUM(marks), 0) AS total FROM scan_assignment_questions WHERE problem_id = $1', [req.params.id]);
    const totalMarks = Number(totalMarksRes.rows[0].total);

    const hasScanQuestionsRes = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM scan_assignment_questions WHERE problem_id = $1 AND type = 'scan') AS has_scan_questions`,
      [req.params.id]
    );
    const hasScanQuestions = hasScanQuestionsRes.rows[0].has_scan_questions;

    const result = await pool.query(
      `SELECT ss.id, ss.status, ss.original_filename, ss.storage_key, ss.created_at, ss.ocr_error, ss.penalized, ss.processing_started_at, u.email, u.name,
              (SELECT COALESCE(SUM(sa.marks_awarded), 0) FROM scan_submission_answers sa WHERE sa.submission_id = ss.id) AS awarded_marks,
              (SELECT COUNT(*) FROM scan_submission_answers sa WHERE sa.submission_id = ss.id AND sa.marks_awarded IS NOT NULL) AS graded_count,
              (SELECT COUNT(*) FROM scan_assignment_questions WHERE problem_id = ss.problem_id) AS question_count
       FROM scan_submissions ss JOIN users u ON u.id = ss.user_id
       WHERE ss.problem_id = $1
       ORDER BY u.email ASC`,
      [req.params.id]
    );

    const configured = isB2Configured();
    const submissions = await Promise.all(result.rows.map(async (row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      status: row.status,
      filename: row.original_filename,
      createdAt: row.created_at,
      ocrError: row.ocr_error,
      penalized: row.penalized,
      processingStartedAt: row.processing_started_at,
      totalMarks,
      awardedMarks: row.penalized ? 0 : Number(row.awarded_marks),
      fullyGraded: Number(row.graded_count) === Number(row.question_count) && Number(row.question_count) > 0,
      viewUrl: configured && row.storage_key ? await getScanPdfUrl(row.storage_key) : null,
    })));

    res.status(200).json({ submissions, hasScanQuestions });
  } catch (err) {
    console.error('List scan submissions error:', err);
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

// ============================================================================
// SCAN OCR PIPELINE — runs OCR + AI assessment + both comparators once a
// scan assignment's deadline passes, never per-upload. A resubmission
// before the deadline REPLACES the previous row outright (see
// POST /api/problems/:id/scan-submit), so running this on an intermediate
// upload would just be discarded work burning through the free OCR Space's
// compute budget for nothing — only the row that survives to the deadline
// is ever the final one.
// ============================================================================

// 5-word-shingle Jaccard similarity — standard, cheap near-duplicate-text
// technique, no ML needed. Threshold is per-org and teacher-configurable
// (organizations.scan_plagiarism_threshold) since "how similar is too
// similar" is a judgment call a teacher is better placed to make than a
// hardcoded constant — unlike the handwriting comparator below, which stays
// a fixed conservative constant because nobody would know how to
// meaningfully tune an abstract cosine-similarity number.
function textShingles(text, k = 5) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i <= words.length - k; i++) set.add(words.slice(i, i + k).join(' '));
  return set;
}
// jaccardSimilarity itself comes from ../lib/plagiarism (shared with the
// code-plagiarism comparator) rather than being redefined here.


// handwriting_features -> a flat 21-dim vector (8 stroke-width bins + 12
// slant-angle bins + 1 ink-density scalar) for cosine similarity.
function flattenHandwritingFeatures(features) {
  if (!features) return null;
  return [...(features.stroke_width_hist || []), ...(features.slant_angle_hist || []), features.ink_density ?? 0];
}
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
// High and fixed on purpose — see the false-positive-risk note on
// ensureScanHandwritingFlagsSchema above; this never auto-penalizes, only
// ever surfaces for teacher review, so a conservative threshold keeps that
// review queue meaningful rather than flooded with coincidental matches.
const HANDWRITING_SIMILARITY_THRESHOLD = 0.9;

async function runTextPlagiarismComparator(client, submission) {
  const orgRes = await client.query(
    'SELECT p.plagiarism_threshold AS assignment_threshold, o.scan_plagiarism_threshold AS org_threshold FROM organizations o JOIN problems p ON p.organization_id = o.id WHERE p.id = $1',
    [submission.problem_id]
  );
  const threshold = orgRes.rows[0]?.assignment_threshold ?? orgRes.rows[0]?.org_threshold ?? 0.4;
  const mySet = textShingles(submission.ocr_text);
  if (mySet.size === 0) return;

  const othersRes = await client.query(
    `SELECT id, ocr_text FROM scan_submissions
     WHERE problem_id = $1 AND id != $2 AND status = 'ocr_done' AND ocr_text IS NOT NULL`,
    [submission.problem_id, submission.id]
  );
  for (const other of othersRes.rows) {
    const similarity = jaccardSimilarity(mySet, textShingles(other.ocr_text));
    if (similarity < threshold) continue;
    const [a, b] = submission.id < other.id ? [submission.id, other.id] : [other.id, submission.id];
    await client.query(
      `INSERT INTO scan_plagiarism_flags (problem_id, submission_a_id, submission_b_id, similarity_score, flag_type)
       VALUES ($1, $2, $3, $4, 'text_similarity')
       ON CONFLICT (problem_id, submission_a_id, submission_b_id, flag_type) WHERE question_id IS NULL DO NOTHING`,
      [submission.problem_id, a, b, similarity]
    );
  }
}

// Typed-answer counterpart to the comparator above — that one only ever
// compares scan_submissions.ocr_text (the compiled OCR blob for type='scan'
// questions), so type='short'/'long' answers submitted digitally never
// entered its comparison pool. Run per-question (unlike the OCR version's
// one-blob-per-submission) since each typed answer is already cleanly
// separated by question, unlike a jumbled OCR blob that may cover several
// questions at once. Called directly from the scan-submit route
// (fire-and-forget, see runScanShortLongAiAssessment above) rather than
// from processOneScanSubmission, since a typed-only submission (no scan
// questions) never reaches that function at all — see the initialStatus
// comment in POST /api/problems/:id/scan-submit.
async function runTypedTextPlagiarismComparator(submissionId, problemId, questions) {
  const shortLongQuestions = questions.filter((q) => q.type === 'short' || q.type === 'long');
  if (shortLongQuestions.length === 0) return;

  try {
    const orgRes = await pool.query(
      'SELECT p.plagiarism_threshold AS assignment_threshold, o.scan_plagiarism_threshold AS org_threshold FROM organizations o JOIN problems p ON p.organization_id = o.id WHERE p.id = $1',
      [problemId]
    );
    const threshold = orgRes.rows[0]?.assignment_threshold ?? orgRes.rows[0]?.org_threshold ?? 0.4;

    for (const q of shortLongQuestions) {
      const mineRes = await pool.query(
        'SELECT text_answer FROM scan_submission_answers WHERE submission_id = $1 AND question_id = $2',
        [submissionId, q.id]
      );
      const mySet = textShingles(mineRes.rows[0]?.text_answer);
      if (mySet.size === 0) continue;

      const othersRes = await pool.query(
        `SELECT submission_id, text_answer FROM scan_submission_answers
         WHERE question_id = $1 AND submission_id != $2 AND text_answer IS NOT NULL`,
        [q.id, submissionId]
      );
      for (const other of othersRes.rows) {
        const similarity = jaccardSimilarity(mySet, textShingles(other.text_answer));
        if (similarity < threshold) continue;
        const [a, b] = submissionId < other.submission_id ? [submissionId, other.submission_id] : [other.submission_id, submissionId];
        await pool.query(
          `INSERT INTO scan_plagiarism_flags (problem_id, submission_a_id, submission_b_id, question_id, similarity_score, flag_type)
           VALUES ($1, $2, $3, $4, $5, 'typed_text_similarity')
           ON CONFLICT (problem_id, submission_a_id, submission_b_id, flag_type, question_id) WHERE question_id IS NOT NULL DO NOTHING`,
          [problemId, a, b, q.id, similarity]
        );
      }
    }
  } catch (err) {
    console.error(`Typed-text plagiarism comparator failed for submission ${submissionId}:`, err);
  }
}

async function runHandwritingComparator(client, submission) {
  const myVector = flattenHandwritingFeatures(submission.handwriting_features);
  if (!myVector) return;

  // The org's ENTIRE submission history, not just this assignment — a
  // student's handwriting from a past assignment is valid reference
  // material for flagging a completely different one.
  const othersRes = await client.query(
    `SELECT ss.id, ss.handwriting_features FROM scan_submissions ss
     JOIN problems p ON p.id = ss.problem_id
     WHERE p.organization_id = (SELECT organization_id FROM problems WHERE id = $1)
       AND ss.id != $2 AND ss.status = 'ocr_done' AND ss.handwriting_features IS NOT NULL`,
    [submission.problem_id, submission.id]
  );
  for (const other of othersRes.rows) {
    const similarity = cosineSimilarity(myVector, flattenHandwritingFeatures(other.handwriting_features));
    if (similarity < HANDWRITING_SIMILARITY_THRESHOLD) continue;
    const [a, b] = submission.id < other.id ? [submission.id, other.id] : [other.id, submission.id];
    await client.query(
      `INSERT INTO scan_handwriting_flags (submission_a_id, submission_b_id, similarity_score)
       VALUES ($1, $2, $3) ON CONFLICT (submission_a_id, submission_b_id) DO NOTHING`,
      [a, b, similarity]
    );
  }
}

async function processOneScanSubmission(submissionId) {
  const client = await pool.connect();
  try {
    await client.query(`UPDATE scan_submissions SET status = 'processing', processing_started_at = now() WHERE id = $1`, [submissionId]);

    const subRes = await client.query('SELECT id, problem_id, storage_key FROM scan_submissions WHERE id = $1', [submissionId]);
    if (subRes.rows.length === 0) return;
    const submission = subRes.rows[0];

    if (!isB2Configured()) throw new Error('B2 storage is not configured');
    if (!isOcrConfigured()) throw new Error('OCR Space is not configured');

    const { buffer: pdfBuffer } = await downloadScanPdf(submission.storage_key);
    const { pages, handwriting_features: handwritingFeatures } = await runOcr(pdfBuffer);
    const ocrText = pages.map((p) => p.text).join('\n\n');

    // Only scan-type questions — mcq/short/long/coding ones are already
    // graded (or left for manual short/long grading) at submit time by
    // finalizeScanSubmissionDigitalAnswers, and OCR/AI-assessing them
    // would be nonsensical.
    const questionsRes = await client.query(
      `SELECT id, prompt, marks FROM scan_assignment_questions WHERE problem_id = $1 AND type = 'scan' ORDER BY position ASC`,
      [submission.problem_id]
    );
    const questions = questionsRes.rows;

    // Best-effort — an AI-assessment hiccup shouldn't block OCR text from
    // being saved and the submission from becoming teacher-gradable.
    const assessments = isGroqConfigured()
      ? await assessAnswers(questions.map((q) => ({ prompt: q.prompt, marks: q.marks })), ocrText)
      : questions.map(() => 'AI assessment unavailable (Groq not configured).');

    for (let i = 0; i < questions.length; i++) {
      await client.query(
        `INSERT INTO scan_submission_answers (submission_id, question_id, ai_assessment)
         VALUES ($1, $2, $3)
         ON CONFLICT (submission_id, question_id) DO UPDATE SET ai_assessment = EXCLUDED.ai_assessment`,
        [submissionId, questions[i].id, assessments[i] || null]
      );
    }

    await client.query(
      `UPDATE scan_submissions SET ocr_text = $1, ocr_pages = $2, handwriting_features = $3,
         status = 'ocr_done', ocr_completed_at = now(), ocr_error = NULL WHERE id = $4`,
      [ocrText, JSON.stringify(pages), handwritingFeatures ? JSON.stringify(handwritingFeatures) : null, submissionId]
    );

    const fullSubmission = { ...submission, ocr_text: ocrText, handwriting_features: handwritingFeatures };
    await runTextPlagiarismComparator(client, fullSubmission);
    await runHandwritingComparator(client, fullSubmission);
  } catch (err) {
    console.error(`Scan OCR pipeline failed for submission ${submissionId}:`, err);
    await client.query(
      `UPDATE scan_submissions SET status = 'ocr_failed', ocr_error = $1 WHERE id = $2`,
      [String(err.message || err).slice(0, 500), submissionId]
    ).catch(() => {});
  } finally {
    client.release();
  }
}
const scanOcrInFlight = new Set();

async function sweepScanSubmissions() {
  try {
    // Recover rows stuck in 'processing' from a crashed prior process — safe
    // because this sweep runs single-process; anything in 'processing' that
    // isn't in this process's own in-flight set right now can only be stale
    // (a live in-flight row is always tracked here, so it's never touched).
    await pool.query(
      `UPDATE scan_submissions SET status = 'pending' WHERE status = 'processing' AND id != ALL($1::int[])`,
      [[...scanOcrInFlight]]
    );

    const dueRes = await pool.query(
      `SELECT ss.id FROM scan_submissions ss JOIN problems p ON p.id = ss.problem_id
       WHERE ss.status = 'pending' AND p.closes_at IS NOT NULL AND p.closes_at <= now()`
    );
    for (const row of dueRes.rows) {
      if (scanOcrInFlight.has(row.id)) continue;
      scanOcrInFlight.add(row.id);
      ocrLimit(() => processOneScanSubmission(row.id)).finally(() => scanOcrInFlight.delete(row.id));
    }
  } catch (err) {
    console.error('Scan OCR sweep error:', err);
  }
}
const SCAN_OCR_SWEEP_INTERVAL_MS = 60 * 1000;
// Same reasoning as sweepAssignmentExamNotifications' own fix further
// down: on an already-migrated database (every real deploy so far) this
// resolves immediately since scan_submissions already exists, so nothing
// observable changes. On a genuinely fresh/empty database (a first boot,
// or a disaster-recovery restore) firing immediately here used to race
// the async bootSchemaStep queue that creates scan_submissions, causing a
// startup error and, worse, lock contention against the schema
// migrations still in flight.
ensureScanSubmissionsSchema().then(() => {
  setInterval(sweepScanSubmissions, SCAN_OCR_SWEEP_INTERVAL_MS);
  sweepScanSubmissions();
});

// ============================================================================
// "New assignment/exam available" notifications — fans a notification out to
// every student who can see the item the moment it actually becomes visible
// to them (respecting opens_at, same computed status getProblemStatus/the
// exam equivalent already use), not at creation time (a teacher may create
// something days before its opens_at, and students shouldn't hear about it
// before they can even see it). Same recipient rule as a subject-scoped
// note: students under the subject's org_unit and every descendant unit
// beneath it; an item with no subject (org-wide) reaches every student in
// the org, same as a subject-less note would.
// ============================================================================

// Shared by both notifiers below. subjectId null means org-wide (every
// student), mirroring how a subject-less note/notice would fan out.
// extraColumn is always one of the two hardcoded literals passed by the
// callers just below (never request input), so the interpolation here never
// touches anything a caller could inject.
async function notifyStudentsOfNewItem(organizationId, subjectId, type, title, extraColumn, extraId) {
  if (subjectId) {
    const subjectRes = await pool.query('SELECT org_unit_id FROM subjects WHERE id = $1 AND organization_id = $2', [subjectId, organizationId]);
    const orgUnitId = subjectRes.rows[0]?.org_unit_id;
    if (!orgUnitId) return;
    await createNotificationsBulk({
      selectSql: `WITH RECURSIVE descendant_units AS (
         SELECT id FROM org_units WHERE id = $1
         UNION
         SELECT ou.id FROM org_units ou JOIN descendant_units d ON ou.parent_unit_id = d.id
       )
       SELECT m.user_id FROM memberships m
       WHERE m.organization_id = $2 AND m.role = 'student' AND m.org_unit_id IN (SELECT id FROM descendant_units)`,
      selectParams: [orgUnitId, organizationId],
      organizationId, type, title, extraColumn, extraId,
    });
  } else {
    await createNotificationsBulk({
      selectSql: `SELECT m.user_id FROM memberships m WHERE m.organization_id = $1 AND m.role = 'student'`,
      selectParams: [organizationId],
      organizationId, type, title, extraColumn, extraId,
    });
  }
}

async function sweepAssignmentExamNotifications() {
  try {
    const dueProblems = await pool.query(
      `SELECT id, title, subject_id, organization_id FROM problems
       WHERE notified = false AND (opens_at IS NULL OR opens_at <= now())`
    );
    for (const p of dueProblems.rows) {
      try {
        await notifyStudentsOfNewItem(p.organization_id, p.subject_id, 'assignment', `New assignment: ${p.title}`, 'problem_id', p.id);
      } catch (err) {
        console.error(`Failed to notify students of new assignment ${p.id} (marking notified anyway):`, err);
      }
      await pool.query('UPDATE problems SET notified = true WHERE id = $1', [p.id]);
    }

    const dueExams = await pool.query(
      `SELECT id, title, subject_id, organization_id FROM exams
       WHERE notified = false AND (opens_at IS NULL OR opens_at <= now())`
    );
    for (const e of dueExams.rows) {
      try {
        await notifyStudentsOfNewItem(e.organization_id, e.subject_id, 'exam', `New exam: ${e.title}`, 'exam_id', e.id);
      } catch (err) {
        console.error(`Failed to notify students of new exam ${e.id} (marking notified anyway):`, err);
      }
      await pool.query('UPDATE exams SET notified = true WHERE id = $1', [e.id]);
    }
  } catch (err) {
    console.error('Assignment/exam notification sweep error:', err);
  }
}
const ASSIGNMENT_EXAM_NOTIFICATION_SWEEP_INTERVAL_MS = 60 * 1000;
// Unlike sweepScanSubmissions above (whose tables/columns have existed
// since long before this process started), notifications.problem_id/
// exam_id and exams.notified are brand new — starting this sweep
// immediately would race the async bootSchemaStep queue that creates them
// on a fresh boot. Wait for the schema to actually be in place first.
ensureNotificationsSchema().then(() => {
  setInterval(sweepAssignmentExamNotifications, ASSIGNMENT_EXAM_NOTIFICATION_SWEEP_INTERVAL_MS);
  sweepAssignmentExamNotifications();
});

// Full detail for one submission — OCR'd pages, each question with its AI
// assessment and current marks, and this submission's own flags (both
// types). Backs ScanReview.jsx. requireAdmin-only, same gating as every
// other scan-review route (see the note on the list route above).
router.get('/api/admin/scan-submissions/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const subRes = await pool.query(
      `SELECT ss.*, u.email, u.name, p.subject_id FROM scan_submissions ss
       JOIN users u ON u.id = ss.user_id
       JOIN problems p ON p.id = ss.problem_id
       WHERE ss.id = $1 AND p.organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (subRes.rows.length === 0) return res.status(404).json({ error: 'Submission not found' });
    if (await enforceSubjectAuthority(req, res, subRes.rows[0].subject_id)) return;
    const submission = subRes.rows[0];

    const answersRes = await pool.query(
      `SELECT q.id AS question_id, q.position, q.prompt, q.marks AS max_marks, q.type, q.options,
              sa.ai_assessment, sa.marks_awarded, sa.selected_option_id, sa.text_answer,
              sa.is_correct, sa.language, sa.code, sa.passed_count, sa.total_count, sa.remarks
       FROM scan_assignment_questions q
       LEFT JOIN scan_submission_answers sa ON sa.question_id = q.id AND sa.submission_id = $1
       WHERE q.problem_id = $2
       ORDER BY q.position ASC`,
      [submission.id, submission.problem_id]
    );

    const flagsRes = await pool.query(
      `SELECT id, submission_a_id, submission_b_id, similarity_score, status, question_id, flag_type AS type
       FROM scan_plagiarism_flags WHERE submission_a_id = $1 OR submission_b_id = $1
       UNION ALL
       SELECT id, submission_a_id, submission_b_id, similarity_score, status, NULL::integer AS question_id, 'handwriting' AS type
       FROM scan_handwriting_flags WHERE submission_a_id = $1 OR submission_b_id = $1`,
      [submission.id]
    );

    const configured = isB2Configured();
    res.status(200).json({
      id: submission.id,
      email: submission.email,
      name: submission.name,
      status: submission.status,
      ocrError: submission.ocr_error,
      penalized: submission.penalized,
      createdAt: submission.created_at,
      pages: submission.ocr_pages || [],
      viewUrl: configured && submission.storage_key ? await getScanPdfUrl(submission.storage_key) : null,
      overallRemarks: submission.overall_remarks,
      questions: answersRes.rows.map((r) => ({
        questionId: r.question_id,
        prompt: r.prompt,
        maxMarks: r.max_marks,
        type: r.type,
        options: r.options,
        aiAssessment: r.ai_assessment,
        marksAwarded: r.marks_awarded,
        selectedOptionId: r.selected_option_id,
        textAnswer: r.text_answer,
        isCorrect: r.is_correct,
        language: r.language,
        code: r.code,
        passedCount: r.passed_count,
        totalCount: r.total_count,
        remarks: r.remarks,
      })),
      flags: flagsRes.rows.map((f) => ({
        id: f.id,
        type: f.type,
        questionId: f.question_id,
        otherSubmissionId: f.submission_a_id === submission.id ? f.submission_b_id : f.submission_a_id,
        similarityScore: f.similarity_score,
        status: f.status,
      })),
    });
  } catch (err) {
    console.error('Scan submission detail error:', err);
    res.status(500).json({ error: 'Failed to load submission' });
  }
});

// Lets a teacher force one submission through OCR immediately instead of
// waiting for the assignment's deadline to pass (see sweepScanSubmissions
// below for why that's normally deferred — this is the deliberate escape
// hatch for testing/urgency, not a replacement for the sweep). Shares the
// sweep's own concurrency limiter and in-flight tracking so a manual
// trigger can't race the sweep into double-processing the same row, or get
// silently reset back to 'pending' by the sweep's stuck-row recovery.
router.post('/api/admin/scan-submissions/:id/process', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const subRes = await pool.query(
      `SELECT ss.id, ss.status, ss.problem_id, p.subject_id FROM scan_submissions ss JOIN problems p ON p.id = ss.problem_id
       WHERE ss.id = $1 AND p.organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (subRes.rows.length === 0) return res.status(404).json({ error: 'Submission not found' });
    if (await enforceSubjectAuthority(req, res, subRes.rows[0].subject_id)) return;
    if (!isB2Configured()) return res.status(503).json({ error: 'Scanned-assignment storage is not configured yet' });
    if (!isOcrConfigured()) return res.status(503).json({ error: 'OCR is not configured yet' });

    // No scan-type questions -> no PDF was ever uploaded (storage_key is
    // ''), so there's nothing for OCR to read; running it anyway just burns
    // a request on garbage input and leaves the row stuck 'ocr_failed'.
    const hasScanQuestionsRes = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM scan_assignment_questions WHERE problem_id = $1 AND type = 'scan') AS has_scan_questions`,
      [subRes.rows[0].problem_id]
    );
    if (!hasScanQuestionsRes.rows[0].has_scan_questions) {
      return res.status(400).json({ error: 'This assignment has no scanned questions — nothing to OCR.' });
    }

    const submissionId = subRes.rows[0].id;
    if (scanOcrInFlight.has(submissionId)) return res.status(409).json({ error: 'Already processing' });

    scanOcrInFlight.add(submissionId);
    ocrLimit(() => processOneScanSubmission(submissionId)).finally(() => scanOcrInFlight.delete(submissionId));
    res.status(202).json({ status: 'processing' });
  } catch (err) {
    console.error('Manual scan OCR trigger error:', err);
    res.status(500).json({ error: 'Failed to start OCR' });
  }
});

// Lets a teacher upload a PDF on a student's behalf — e.g. a paper answer
// sheet scanned on some other device/app, never touching ScanCapture.jsx's
// in-browser camera flow at all. Deliberately not gated on the assignment
// being 'open' the way the student-facing route is (this is exactly the
// escape hatch for late/offline submissions an admin is entering after the
// fact), and shares that route's exact replace-on-resubmit + storage-key
// logic: whatever the uploaded file's own name is, it's kept only as the
// display label (original_filename) — the actual object key always follows
// scanObjectKey()'s <org>/<problem>/<submissionId>.pdf convention, same as
// every other scan submission, never the incoming filename.
router.post('/api/admin/problems/:id/scan-submissions', authenticateToken, requireAdminOrTeacher, scanUpload.single('file'), async (req, res) => {
  const problemId = req.params.id;
  const studentEmail = String(req.body.email || '').trim().toLowerCase();
  if (!req.file) return res.status(400).json({ error: 'A PDF file is required' });
  if (!studentEmail) return res.status(400).json({ error: "Student's email is required" });
  if (!isB2Configured()) return res.status(503).json({ error: 'Scanned-assignment storage is not configured yet' });

  try {
    const problemRes = await pool.query(
      'SELECT submission_mode, subject_id FROM problems WHERE id = $1 AND organization_id = $2',
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;
    if (problemRes.rows[0].submission_mode !== 'scan') {
      return res.status(400).json({ error: 'This assignment does not accept scanned submissions' });
    }

    const studentRes = await pool.query(
      `SELECT id FROM users WHERE organization_id = $1 AND role = 'student' AND lower(email) = $2`,
      [req.user.organizationId, studentEmail]
    );
    if (studentRes.rows.length === 0) return res.status(404).json({ error: 'No student with that email in this organization' });
    const studentId = studentRes.rows[0].id;

    const existing = await pool.query(
      'SELECT id, storage_key FROM scan_submissions WHERE problem_id = $1 AND user_id = $2',
      [problemId, studentId]
    );
    if (existing.rows.length > 0) {
      const previous = existing.rows[0];
      await pool.query('DELETE FROM scan_submissions WHERE id = $1', [previous.id]);
      if (previous.storage_key) {
        try {
          await deleteScanPdf(previous.storage_key);
        } catch (err) {
          console.error('Failed to delete superseded scan PDF (continuing anyway):', err);
        }
      }
    }

    const filename = String(req.file.originalname || 'scan.pdf').trim();
    const insertRes = await pool.query(
      `INSERT INTO scan_submissions (problem_id, user_id, storage_key, original_filename, status)
       VALUES ($1, $2, '', $3, 'pending') RETURNING id`,
      [problemId, studentId, filename]
    );
    const submissionId = insertRes.rows[0].id;
    const objectKey = scanObjectKey(req.user.organizationId, problemId, submissionId);

    await uploadScanPdf(objectKey, req.file.buffer);
    await pool.query('UPDATE scan_submissions SET storage_key = $1 WHERE id = $2', [objectKey, submissionId]);

    // Unlike the student route, this doesn't wait for the assignment
    // deadline — an admin manually entering an offline submission wants it
    // graded now, not whenever (or if ever) the deadline sweep gets to it.
    if (isOcrConfigured() && !scanOcrInFlight.has(submissionId)) {
      scanOcrInFlight.add(submissionId);
      ocrLimit(() => processOneScanSubmission(submissionId)).finally(() => scanOcrInFlight.delete(submissionId));
    }

    res.status(201).json({ submissionId, status: 'pending' });
  } catch (err) {
    console.error('Admin scan upload error:', err);
    res.status(500).json({ error: 'Failed to upload scanned submission' });
  }
});

// Teacher-entered marks per question — the only thing that ever actually
// grades a scan submission (the AI assessment on each answer is an aid,
// never authoritative; see aiGrading.js). Ignored while penalized=true, so
// a confirmed plagiarism flag can't be silently undone by re-saving a grade
// — see PUT /api/admin/scan-flags/:type/:id for how that flag gets cleared.
router.put('/api/admin/scan-submissions/:id/grade', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { marks, overallRemarks } = req.body; // marks: [{ questionId, marksAwarded, remarks }, ...]
  if (!Array.isArray(marks)) return res.status(400).json({ error: 'marks array is required' });

  try {
    const subRes = await pool.query(
      `SELECT ss.id, ss.problem_id, p.subject_id FROM scan_submissions ss JOIN problems p ON p.id = ss.problem_id
       WHERE ss.id = $1 AND p.organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (subRes.rows.length === 0) return res.status(404).json({ error: 'Submission not found' });
    if (await enforceSubjectAuthority(req, res, subRes.rows[0].subject_id)) return;

    // Max marks per question — validated against below so a teacher can't
    // award more than a question is actually worth (previously unchecked
    // entirely; only the exam-side grading routes enforced this).
    const questionsRes = await pool.query(
      'SELECT id, marks FROM scan_assignment_questions WHERE problem_id = $1',
      [subRes.rows[0].problem_id]
    );
    const maxMarksById = new Map(questionsRes.rows.map((q) => [q.id, q.marks]));

    // marksAwarded/remarks are each independently optional per entry (a
    // remarks-only save on an mcq question, say, shouldn't require also
    // resending its already-correct auto-graded marks) — `undefined` means
    // "leave this field alone", which is why the actual writes below are
    // two separate conditional UPDATEs rather than one upsert that would
    // silently null out whichever field wasn't included this time.
    const updates = [];
    for (const entry of marks) {
      const questionId = Number(entry.questionId);
      if (!questionId) continue;
      if (!maxMarksById.has(questionId)) return res.status(400).json({ error: `Question ${questionId} does not belong to this assignment` });

      let marksAwarded;
      if (entry.marksAwarded === undefined) {
        marksAwarded = undefined;
      } else if (entry.marksAwarded === null || entry.marksAwarded === '') {
        marksAwarded = null;
      } else {
        marksAwarded = Number(entry.marksAwarded);
        if (Number.isNaN(marksAwarded)) continue;
        const maxMarks = maxMarksById.get(questionId);
        if (marksAwarded < 0 || marksAwarded > maxMarks) {
          return res.status(400).json({ error: `Marks for question ${questionId} must be between 0 and ${maxMarks}` });
        }
      }

      const remarks = entry.remarks !== undefined ? (String(entry.remarks).trim() || null) : undefined;
      if (marksAwarded === undefined && remarks === undefined) continue;
      updates.push({ questionId, marksAwarded, remarks });
    }

    for (const { questionId, marksAwarded, remarks } of updates) {
      await pool.query(
        `INSERT INTO scan_submission_answers (submission_id, question_id) VALUES ($1, $2)
         ON CONFLICT (submission_id, question_id) DO NOTHING`,
        [req.params.id, questionId]
      );
      if (marksAwarded !== undefined) {
        await pool.query(
          `UPDATE scan_submission_answers SET marks_awarded = $1 WHERE submission_id = $2 AND question_id = $3`,
          [marksAwarded, req.params.id, questionId]
        );
      }
      if (remarks !== undefined) {
        await pool.query(
          `UPDATE scan_submission_answers SET remarks = $1 WHERE submission_id = $2 AND question_id = $3`,
          [remarks, req.params.id, questionId]
        );
      }
    }

    if (overallRemarks !== undefined) {
      await pool.query('UPDATE scan_submissions SET overall_remarks = $1 WHERE id = $2', [String(overallRemarks).trim() || null, req.params.id]);
    }

    if (updates.some((u) => u.marksAwarded !== undefined)) {
      logSecurityEvent(req, 'grade_overridden', { detail: { kind: 'scan_submission', submissionId: req.params.id, questionsGraded: updates.filter((u) => u.marksAwarded !== undefined).length } });
    }

    res.status(200).json({ message: 'Grade saved' });
  } catch (err) {
    console.error('Save scan grade error:', err);
    res.status(500).json({ error: 'Failed to save grade' });
  }
});

// Every open flag (both types) touching this assignment's submissions —
// backs a per-assignment review queue in ScanReview.jsx. Handwriting flags
// aren't problem-scoped in the schema (a match can span two different
// assignments), so this pulls in any flag where AT LEAST ONE side belongs
// to this assignment — a teacher reviewing this assignment's submissions
// should see that one of them matched something elsewhere too.
router.get('/api/admin/problems/:id/scan-flags', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });

    const plagiarismRes = await pool.query(
      `SELECT f.id, f.submission_a_id, f.submission_b_id, f.similarity_score, f.status, f.created_at,
              ua.email AS email_a, ub.email AS email_b
       FROM scan_plagiarism_flags f
       JOIN scan_submissions sa ON sa.id = f.submission_a_id JOIN users ua ON ua.id = sa.user_id
       JOIN scan_submissions sb ON sb.id = f.submission_b_id JOIN users ub ON ub.id = sb.user_id
       WHERE f.problem_id = $1 AND f.status = 'open'
       ORDER BY f.similarity_score DESC`,
      [req.params.id]
    );

    const handwritingRes = await pool.query(
      `SELECT f.id, f.submission_a_id, f.submission_b_id, f.similarity_score, f.status, f.created_at,
              ua.email AS email_a, ub.email AS email_b
       FROM scan_handwriting_flags f
       JOIN scan_submissions sa ON sa.id = f.submission_a_id JOIN users ua ON ua.id = sa.user_id
       JOIN scan_submissions sb ON sb.id = f.submission_b_id JOIN users ub ON ub.id = sb.user_id
       WHERE f.status = 'open' AND (sa.problem_id = $1 OR sb.problem_id = $1)
       ORDER BY f.similarity_score DESC`,
      [req.params.id]
    );

    const toFlag = (type) => (f) => ({
      id: f.id, type,
      submissionA: { id: f.submission_a_id, email: f.email_a },
      submissionB: { id: f.submission_b_id, email: f.email_b },
      similarityScore: f.similarity_score,
      createdAt: f.created_at,
    });

    res.status(200).json({
      flags: [...plagiarismRes.rows.map(toFlag('text_similarity')), ...handwritingRes.rows.map(toFlag('handwriting'))],
    });
  } catch (err) {
    console.error('List scan flags error:', err);
    res.status(500).json({ error: 'Failed to load flags' });
  }
});

// Confirm/dismiss one flag. Confirming a text_similarity or
// typed_text_similarity flag penalizes BOTH submissions in the pair (marks
// display as 0 while penalized=true, see the list/detail routes above) —
// handwriting flags never penalize anything regardless of status, confirmed
// or not (see the false-positive-risk note on ensureScanHandwritingFlagsSchema).
// requireAdminOrTeacher + enforceSubjectAuthority, not requireAdmin —
// reachable from ScanReview.jsx, a page a teacher can land on for their own
// scan-mode assignments (see that page's own ProtectedRoute entry in
// App.jsx). Both submissions being compared always belong to the same
// assignment (plagiarism/handwriting comparison is only ever within one
// assignment — see textShingles/jaccardSimilarity's own comments above),
// so either side's problem gives the same subject_id either way.
router.put('/api/admin/scan-flags/:type/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { type, id } = req.params;
  const { status } = req.body; // 'reviewed_confirmed' | 'reviewed_dismissed'
  if (!['reviewed_confirmed', 'reviewed_dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status must be reviewed_confirmed or reviewed_dismissed' });
  }
  const table = type === 'text_similarity' || type === 'typed_text_similarity' ? 'scan_plagiarism_flags' : type === 'handwriting' ? 'scan_handwriting_flags' : null;
  if (!table) return res.status(400).json({ error: 'Invalid flag type' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Org-scoped via a join through problems even for scan_handwriting_flags
    // (which has no problem_id of its own) — either side's submission's
    // problem is enough to prove org ownership of the flag.
    const flagRes = await client.query(
      `SELECT f.id, f.submission_a_id, f.submission_b_id, p.subject_id FROM ${table} f
       JOIN scan_submissions sa ON sa.id = f.submission_a_id
       JOIN problems p ON p.id = sa.problem_id
       WHERE f.id = $1 AND p.organization_id = $2`,
      [id, req.user.organizationId]
    );
    if (flagRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Flag not found' });
    }
    if (await enforceSubjectAuthority(req, res, flagRes.rows[0].subject_id)) { await client.query('ROLLBACK'); return; }
    const flag = flagRes.rows[0];

    await client.query(`UPDATE ${table} SET status = $1 WHERE id = $2`, [status, id]);

    if (table === 'scan_plagiarism_flags' && status === 'reviewed_confirmed') {
      await client.query(
        'UPDATE scan_submissions SET penalized = true WHERE id IN ($1, $2)',
        [flag.submission_a_id, flag.submission_b_id]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Flag updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update scan flag error:', err);
    res.status(500).json({ error: 'Failed to update flag' });
  } finally {
    client.release();
  }
});

// Per-org Jaccard-similarity cutoff for the text-plagiarism comparator —
// admin-only, same as every other org-wide setting (grade_bands,
// tag_visibility_settings).
router.get('/api/admin/settings/scan-plagiarism-threshold', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT scan_plagiarism_threshold FROM organizations WHERE id = $1', [req.user.organizationId]);
    res.status(200).json({ threshold: result.rows[0]?.scan_plagiarism_threshold ?? 0.4 });
  } catch (err) {
    console.error('Get plagiarism threshold error:', err);
    res.status(500).json({ error: 'Failed to load threshold' });
  }
});

router.put('/api/admin/settings/scan-plagiarism-threshold', authenticateToken, requireAdmin, async (req, res) => {
  const threshold = Number(req.body.threshold);
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    return res.status(400).json({ error: 'threshold must be a number between 0 and 1' });
  }
  try {
    await pool.query('UPDATE organizations SET scan_plagiarism_threshold = $1 WHERE id = $2', [threshold, req.user.organizationId]);
    res.status(200).json({ message: 'Threshold updated', threshold });
  } catch (err) {
    console.error('Update plagiarism threshold error:', err);
    res.status(500).json({ error: 'Failed to update threshold' });
  }
});

// Per-org Jaccard-similarity cutoff for the code-submission comparator —
// same admin-only settings pattern as the scan one above, separate column
// since code and prose similarity scores don't live on the same natural
// scale (code shares far more incidental boilerplate than prose does).
router.get('/api/admin/settings/code-plagiarism-threshold', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT code_plagiarism_threshold FROM organizations WHERE id = $1', [req.user.organizationId]);
    res.status(200).json({ threshold: result.rows[0]?.code_plagiarism_threshold ?? 0.6 });
  } catch (err) {
    console.error('Get code plagiarism threshold error:', err);
    res.status(500).json({ error: 'Failed to load threshold' });
  }
});

router.put('/api/admin/settings/code-plagiarism-threshold', authenticateToken, requireAdmin, async (req, res) => {
  const threshold = Number(req.body.threshold);
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    return res.status(400).json({ error: 'threshold must be a number between 0 and 1' });
  }
  try {
    await pool.query('UPDATE organizations SET code_plagiarism_threshold = $1 WHERE id = $2', [threshold, req.user.organizationId]);
    res.status(200).json({ message: 'Threshold updated', threshold });
  } catch (err) {
    console.error('Update code plagiarism threshold error:', err);
    res.status(500).json({ error: 'Failed to update threshold' });
  }
});

// Every open code-similarity flag for one assignment — backs a per-
// assignment review list in AssignmentsPanel, same shape as the scan-flags
// list above.
router.get('/api/admin/problems/:id/code-flags', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;

    const flagsRes = await pool.query(
      `SELECT f.id, f.submission_a_id, f.submission_b_id, f.similarity_score, f.status, f.created_at,
              ua.email AS email_a, ua.name AS name_a, ub.email AS email_b, ub.name AS name_b
       FROM submission_plagiarism_flags f
       JOIN submissions sa ON sa.id = f.submission_a_id JOIN users ua ON ua.id = sa.user_id
       JOIN submissions sb ON sb.id = f.submission_b_id JOIN users ub ON ub.id = sb.user_id
       WHERE f.problem_id = $1 AND f.status = 'open'
       ORDER BY f.similarity_score DESC`,
      [req.params.id]
    );

    res.status(200).json({
      flags: flagsRes.rows.map((f) => ({
        id: f.id,
        submissionA: { id: f.submission_a_id, name: f.name_a, email: f.email_a },
        submissionB: { id: f.submission_b_id, name: f.name_b, email: f.email_b },
        similarityScore: f.similarity_score,
        createdAt: f.created_at,
      })),
    });
  } catch (err) {
    console.error('List code flags error:', err);
    res.status(500).json({ error: 'Failed to load flags' });
  }
});

// Confirm/dismiss one code-similarity flag. Unlike the scan-plagiarism
// flow, confirming never auto-penalizes a submission's score — coding
// assignments grade purely off test-case pass/fail, and silently zeroing
// that would fight the judge's own authoritative result. Confirming is
// purely a record for the teacher (e.g. to act on outside the platform);
// dismissing just closes the flag.
router.put('/api/admin/code-flags/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { status } = req.body; // 'reviewed_confirmed' | 'reviewed_dismissed'
  if (!['reviewed_confirmed', 'reviewed_dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status must be reviewed_confirmed or reviewed_dismissed' });
  }
  try {
    const flagRes = await pool.query(
      `SELECT f.id, p.subject_id FROM submission_plagiarism_flags f
       JOIN problems p ON p.id = f.problem_id
       WHERE f.id = $1 AND p.organization_id = $2`,
      [req.params.id, req.user.organizationId]
    );
    if (flagRes.rows.length === 0) return res.status(404).json({ error: 'Flag not found' });
    if (await enforceSubjectAuthority(req, res, flagRes.rows[0].subject_id)) return;

    await pool.query('UPDATE submission_plagiarism_flags SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.status(200).json({ message: 'Flag updated' });
  } catch (err) {
    console.error('Update code flag error:', err);
    res.status(500).json({ error: 'Failed to update flag' });
  }
});


module.exports = router;
