// Problem bank routes — LeetCode-style assignments: list/get/result/
// questions, admin CRUD, test cases, attempts, submit, time-log.
// Split out of index.js as part of breaking that monolith into
// modules. Pure relocation. Mounted with no prefix in index.js —
// every path below is the exact full path it always was.
//
// NOT everything problems-related lives here: the scan-submission
// routes (POST /api/problems/:id/scan-submit, the admin scan review
// routes, scan-flags, code-flags) stay in index.js for now — they're
// tightly coupled to the scan/OCR pipeline, not this domain, and
// move together with routes/scans.js instead.
const express = require('express');
const router = express.Router();
const { pool } = require('../lib/db');
const { authenticateToken, requireAdminOrTeacher, requireAdmin, enforceSubjectAuthority } = require('../lib/auth');
const { getProblemStatus, getVisibleSubjectIds, computePercentileTiers, gradeTagForPercentage, getTagVisibility } = require('../lib/performance');
const { LANGUAGE_CONFIG, executeInSandbox, normalizeOutput } = require('../lib/sandbox');
const { runCodePlagiarismComparator } = require('../lib/plagiarism');
const { normalizeTimeLimitSeconds, normalizeScanAssignmentQuestion } = require('../lib/examItems');

// Problems-only (never used by exams, unlike normalizeTimeLimitSeconds) —
// stays local rather than in lib/examItems.js.
function normalizePlagiarismThreshold(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error('Plagiarism threshold must be a number between 0 and 1, or left blank to use the organization default');
  }
  return n;
}



// ============================================================================
// 7. PROBLEMS â€” LeetCode-style problem bank, browsing, and graded submissions
// ============================================================================

// List all problems (for a problem-list / index page)
router.get('/api/problems', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, difficulty, opens_at, closes_at, subject_id, submission_mode FROM problems WHERE organization_id = $1 ORDER BY id ASC',
      [req.user.organizationId]
    );

    const withStatus = result.rows.map((p) => ({ ...p, status: getProblemStatus(p) }));

    // Students never see an assignment before its opens_at; admins AND
    // teachers see everything (open, closed, and upcoming) so they can
    // manage the whole set — a teacher who just created an assignment
    // needs to see it immediately, same as an admin would.
    let visible = req.user.role === 'student'
      ? withStatus.filter((p) => p.status !== 'upcoming')
      : withStatus;

    // Subject visibility: a subject attached at "Department" reaches every
    // unit beneath it (e.g. every year), so this checks the student's own
    // unit AND all of its ancestors — not the unit alone. An item with no
    // subject at all (subject_id NULL) stays org-wide visible, same as
    // every problem behaved before this feature existed. Only applies to
    // students — teachers/admins manage the whole org's set regardless of
    // their own unit.
    if (req.user.role === 'student') {
      const visibleSubjectIds = await getVisibleSubjectIds(req.user.orgUnitId);
      visible = visible.filter((p) => p.subject_id == null || visibleSubjectIds.includes(p.subject_id));
    }

    // Attach each student's own BEST submission per problem (most test cases
    // passed, with an Accepted verdict breaking ties) so the list can render
    // a pending / partial / accepted indicator without a second round-trip
    // per card. "Best" rather than "latest" so a student's progress doesn't
    // regress in the UI just because they re-ran a weaker attempt afterward.
    if (visible.length > 0) {
      const problemIds = visible.map((p) => p.id);
      const bestRes = await pool.query(
        `SELECT DISTINCT ON (problem_id) problem_id, status, passed_count, total_count, created_at
         FROM submissions
         WHERE user_id = $1 AND problem_id = ANY($2::int[])
         ORDER BY problem_id, (status = 'Accepted') DESC, passed_count DESC, created_at DESC`,
        [req.user.userId, problemIds]
      );
      const bestByProblem = {};
      bestRes.rows.forEach((row) => { bestByProblem[row.problem_id] = row; });

      visible.forEach((p) => {
        const best = bestByProblem[p.id];
        p.submission = best
          ? { status: best.status, passed: best.passed_count, total: best.total_count }
          : null;
      });

      // scan_submissions is a separate table (a scan-mode assignment is
      // never in `submissions` above) — attached as its own field rather
      // than forced into `submission`'s code-judge shape (status/passed/
      // total), which a scanned answer sheet has no equivalent of.
      const scanRes = await pool.query(
        `SELECT problem_id FROM scan_submissions WHERE user_id = $1 AND problem_id = ANY($2::int[])`,
        [req.user.userId, problemIds]
      );
      const scanSubmittedIds = new Set(scanRes.rows.map((r) => r.problem_id));
      visible.forEach((p) => { p.scanSubmitted = scanSubmittedIds.has(p.id); });
    }

    res.status(200).json({ problems: visible });
  } catch (err) {
    console.error('List problems error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetch a specific problem, its starter code, and its visible sample test cases
router.get('/api/problems/:id', authenticateToken, async (req, res) => {
  try {
    const problemId = req.params.id;

    const problemRes = await pool.query('SELECT * FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });

    const status = getProblemStatus(problemRes.rows[0]);
    if (status === 'upcoming' && req.user.role === 'student') {
      return res.status(403).json({ error: 'This assignment is not open yet' });
    }

    const codeRes = await pool.query(
      'SELECT language, code FROM starter_code WHERE problem_id = $1',
      [problemId]
    );
    const starterCode = {};
    codeRes.rows.forEach((row) => {
      starterCode[row.language] = row.code;
    });

    // Hidden test cases never leave the server â€” only samples are shown, LeetCode-style
    const sampleRes = await pool.query(
      'SELECT input, expected_output FROM test_cases WHERE problem_id = $1 AND is_hidden = false ORDER BY id ASC',
      [problemId]
    );

    // How much time this student has already logged on this specific
    // assignment (see problem_time_logs / POST /api/problems/:id/time-log).
    // Sent back so the frontend timer can seed itself with the real running
    // total instead of starting over at 0 every time the page is opened.
    const timeRes = await pool.query(
      'SELECT total_seconds FROM problem_time_logs WHERE user_id = $1 AND problem_id = $2',
      [req.user.userId, problemId]
    );
    const timeSpentSeconds = timeRes.rows[0]?.total_seconds ?? 0;

    res.json({
      problem: { ...problemRes.rows[0], status },
      starterCode,
      samples: sampleRes.rows,
      timeSpentSeconds,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Student's own result for one assignment — mirrors GET /api/exams/:id/result:
// whichever of percentile/grade tag are currently switched on platform-wide,
// gated on the assignment's own deadline having passed (assignments have no
// manual-grading step, so there's no separate "still being graded" state —
// every submission is auto-judged the instant it's made).
router.get('/api/problems/:id/result', authenticateToken, async (req, res) => {
  const problemId = req.params.id;
  try {
    const problemRes = await pool.query('SELECT submission_mode, closes_at FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    const isScan = problemRes.rows[0].submission_mode === 'scan';

    let myPercentage;
    let problemPercentages;
    let overallAvgByUser; // Map<userId, avgPercentage> across every problem of this SAME mode, own deadline passed

    if (isScan) {
      const mineRes = await pool.query(
        `SELECT SUM(q.marks) AS max_marks, SUM(sa.marks_awarded) AS awarded, BOOL_AND(sa.marks_awarded IS NOT NULL) AS fully_graded
         FROM scan_submissions ss
         JOIN scan_assignment_questions q ON q.problem_id = ss.problem_id
         LEFT JOIN scan_submission_answers sa ON sa.submission_id = ss.id AND sa.question_id = q.id
         WHERE ss.user_id = $1 AND ss.problem_id = $2
         GROUP BY ss.id`,
        [req.user.userId, problemId]
      );
      if (mineRes.rows.length === 0) return res.status(404).json({ error: 'No submission found for this assignment' });
      if (!mineRes.rows[0].fully_graded) return res.status(200).json({ status: 'pending', reason: 'grading' });

      if (problemRes.rows[0].closes_at && new Date(problemRes.rows[0].closes_at) > new Date()) {
        return res.status(200).json({ status: 'pending', reason: 'deadline' });
      }

      myPercentage = Number(mineRes.rows[0].max_marks) > 0 ? (Number(mineRes.rows[0].awarded) / Number(mineRes.rows[0].max_marks)) * 100 : 0;

      const allRes = await pool.query(
        `SELECT ss.user_id, SUM(q.marks) AS max_marks, SUM(sa.marks_awarded) AS awarded, BOOL_AND(sa.marks_awarded IS NOT NULL) AS fully_graded
         FROM scan_submissions ss
         JOIN scan_assignment_questions q ON q.problem_id = ss.problem_id
         LEFT JOIN scan_submission_answers sa ON sa.submission_id = ss.id AND sa.question_id = q.id
         WHERE ss.problem_id = $1
         GROUP BY ss.id`,
        [problemId]
      );
      problemPercentages = allRes.rows
        .filter((r) => r.fully_graded && Number(r.max_marks) > 0)
        .map((r) => (Number(r.awarded) / Number(r.max_marks)) * 100);

      const overallRes = await pool.query(
        `SELECT best.user_id, AVG(best.pct) AS avg_percentage FROM (
           SELECT ss.user_id, ss.problem_id, SUM(q.marks) AS max_marks, SUM(sa.marks_awarded) AS awarded,
                  BOOL_AND(sa.marks_awarded IS NOT NULL) AS fully_graded,
                  (SUM(sa.marks_awarded)::float / NULLIF(SUM(q.marks), 0) * 100) AS pct
           FROM scan_submissions ss
           JOIN scan_assignment_questions q ON q.problem_id = ss.problem_id
           JOIN problems p ON p.id = ss.problem_id
           LEFT JOIN scan_submission_answers sa ON sa.submission_id = ss.id AND sa.question_id = q.id
           WHERE p.organization_id = $1 AND (p.closes_at IS NULL OR p.closes_at <= now())
           GROUP BY ss.id, ss.user_id, ss.problem_id
         ) best
         WHERE best.fully_graded AND best.pct IS NOT NULL
         GROUP BY best.user_id`,
        [req.user.organizationId]
      );
      overallAvgByUser = new Map(overallRes.rows.map((r) => [r.user_id, Number(r.avg_percentage)]));
    } else {
      const bestRes = await pool.query(
        `SELECT passed_count, total_count FROM submissions
         WHERE user_id = $1 AND problem_id = $2
         ORDER BY (status = 'Accepted') DESC, passed_count DESC, created_at DESC LIMIT 1`,
        [req.user.userId, problemId]
      );
      if (bestRes.rows.length === 0) return res.status(404).json({ error: 'No submission found for this assignment' });

      if (problemRes.rows[0].closes_at && new Date(problemRes.rows[0].closes_at) > new Date()) {
        return res.status(200).json({ status: 'pending', reason: 'deadline' });
      }

      const best = bestRes.rows[0];
      myPercentage = best.total_count > 0 ? (best.passed_count / best.total_count) * 100 : 0;

      // Per-assignment percentile, among every student's best submission for
      // this problem. No deadline filter needed on the population itself —
      // we only ever reach this line once this problem's own closes_at has
      // already passed.
      const allBestRes = await pool.query(
        `SELECT DISTINCT ON (user_id) user_id, passed_count, total_count
         FROM submissions WHERE problem_id = $1
         ORDER BY user_id, (status = 'Accepted') DESC, passed_count DESC, created_at DESC`,
        [problemId]
      );
      problemPercentages = allBestRes.rows
        .filter((r) => r.total_count > 0)
        .map((r) => (r.passed_count / r.total_count) * 100);

      // Overall (assignments) percentile: every student's average best-submission
      // % across every problem they've submitted to, only counting problems
      // whose own deadline has already passed — same fairness rule as exams'
      // "overall" so a still-open assignment elsewhere can't skew it early.
      const overallRes = await pool.query(
        `SELECT best.user_id, AVG(best.passed_count::float / best.total_count * 100) AS avg_percentage
         FROM (
           SELECT DISTINCT ON (s.user_id, s.problem_id) s.user_id, s.problem_id, s.passed_count, s.total_count
           FROM submissions s
           JOIN problems p ON p.id = s.problem_id
           WHERE p.organization_id = $1 AND (p.closes_at IS NULL OR p.closes_at <= now())
           ORDER BY s.user_id, s.problem_id, (s.status = 'Accepted') DESC, s.passed_count DESC, s.created_at DESC
         ) best
         WHERE best.total_count > 0
         GROUP BY best.user_id`,
        [req.user.organizationId]
      );
      overallAvgByUser = new Map(overallRes.rows.map((r) => [r.user_id, Number(r.avg_percentage)]));
    }

    const { tag: percentileTag, percentile } = computePercentileTiers(problemPercentages)(myPercentage);
    const overallPercentileFor = computePercentileTiers([...overallAvgByUser.values()]);
    const overallAssignmentsPercentileTag = overallAvgByUser.has(req.user.userId)
      ? overallPercentileFor(overallAvgByUser.get(req.user.userId)).tag
      : null;

    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [req.user.organizationId]);
    const gradeTag = gradeTagForPercentage(bandsRes.rows, myPercentage);

    const visibility = await getTagVisibility(req.user.organizationId);
    res.status(200).json({
      status: 'graded',
      percentileTag: visibility.show_percentile_tag ? percentileTag : undefined,
      percentile: visibility.show_percentile_tag ? percentile : undefined,
      populationSize: visibility.show_percentile_tag ? problemPercentages.length : undefined,
      overallAssignmentsPercentileTag: visibility.show_percentile_tag ? overallAssignmentsPercentileTag : undefined,
      gradeTag: visibility.show_grade_tag ? gradeTag : undefined,
    });
  } catch (err) {
    console.error('Assignment result error:', err);
    res.status(500).json({ error: 'Failed to load result' });
  }
});

// Per-question breakdown for the "per question" factor on MyPerformance's
// assignment graph. Only real for scan-mode assignments — a code submission
// stores just its aggregate passed_count/total_count, never a per-test-case
// result, so there's no genuine per-question data for those; this returns
// that summary instead of fabricating one.
router.get('/api/problems/:id/questions', authenticateToken, async (req, res) => {
  const problemId = req.params.id;
  try {
    const problemRes = await pool.query(
      'SELECT submission_mode, closes_at FROM problems WHERE id = $1 AND organization_id = $2',
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    const problem = problemRes.rows[0];
    if (problem.closes_at && new Date(problem.closes_at) > new Date()) {
      return res.status(200).json({ status: 'pending', reason: 'deadline' });
    }

    if (problem.submission_mode !== 'scan') {
      const bestRes = await pool.query(
        `SELECT passed_count, total_count FROM submissions
         WHERE user_id = $1 AND problem_id = $2
         ORDER BY (status = 'Accepted') DESC, passed_count DESC, created_at DESC LIMIT 1`,
        [req.user.userId, problemId]
      );
      if (bestRes.rows.length === 0) return res.status(404).json({ error: 'No submission found for this assignment' });
      return res.status(200).json({ status: 'graded', mode: 'code', passedCount: bestRes.rows[0].passed_count, totalCount: bestRes.rows[0].total_count });
    }

    const submissionRes = await pool.query(
      'SELECT id FROM scan_submissions WHERE user_id = $1 AND problem_id = $2 ORDER BY created_at DESC LIMIT 1',
      [req.user.userId, problemId]
    );
    if (submissionRes.rows.length === 0) return res.status(404).json({ error: 'No submission found for this assignment' });

    const questionsRes = await pool.query(
      `SELECT q.position, q.marks AS max_marks, a.marks_awarded
       FROM scan_assignment_questions q
       LEFT JOIN scan_submission_answers a ON a.question_id = q.id AND a.submission_id = $1
       WHERE q.problem_id = $2
       ORDER BY q.position ASC`,
      [submissionRes.rows[0].id, problemId]
    );
    res.status(200).json({
      status: 'graded',
      mode: 'scan',
      questions: questionsRes.rows.map((r, i) => ({
        label: `Q${r.position ?? i + 1}`,
        earned: r.marks_awarded != null ? Number(r.marks_awarded) : null,
        max: Number(r.max_marks),
      })),
    });
  } catch (err) {
    console.error('Assignment questions breakdown error:', err);
    res.status(500).json({ error: 'Failed to load question breakdown' });
  }
});

// Admin: upload a new problem with its starter code and test cases in one shot
router.post('/api/admin/problems', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const { title, difficulty, description, starterCode = {}, testCases = [], opensAt = null, closesAt = null } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  // 'scan' assignments skip the code-judge machinery entirely (no starter
  // code, no test cases) — students upload a scanned PDF instead. See
  // ensureScanAssignmentColumns for the column definitions.
  const submissionMode = req.body.submissionMode === 'scan' ? 'scan' : 'code';
  const assignmentNo = submissionMode === 'scan' ? String(req.body.assignmentNo || '').trim() : null;
  // Scan-mode questions: what a student actually needs to answer, shown
  // before the camera opens (see GET /api/me/scan-context). Required same
  // as test cases are for code mode — a scan assignment with no questions
  // would just be a bare upload box with no idea what's being asked. Each
  // one can be mcq/short/long/coding/scan — see normalizeScanAssignmentQuestion.
  let questions = [];
  if (submissionMode === 'scan') {
    const rawQuestions = Array.isArray(req.body.questions) ? req.body.questions : [];
    try {
      questions = rawQuestions.map((q, i) => normalizeScanAssignmentQuestion(q, i));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (!title || !difficulty || !description) {
    return res.status(400).json({ error: 'Title, difficulty, and description are required' });
  }
  if (submissionMode === 'code' && (!Array.isArray(testCases) || testCases.length === 0)) {
    return res.status(400).json({ error: 'At least one test case is required' });
  }
  if (submissionMode === 'scan' && !assignmentNo) {
    return res.status(400).json({ error: 'Assignment number is required for scanned assignments' });
  }
  if (submissionMode === 'scan' && questions.length === 0) {
    return res.status(400).json({ error: 'At least one question is required for scanned assignments' });
  }
  if (await enforceSubjectAuthority(req, res, subjectId)) return;

  let timeLimitSeconds;
  try {
    timeLimitSeconds = normalizeTimeLimitSeconds(req.body.timeLimitSeconds);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let plagiarismThreshold;
  try {
    plagiarismThreshold = normalizePlagiarismThreshold(req.body.plagiarismThreshold);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const problemRes = await client.query(
      `INSERT INTO problems (title, difficulty, description, created_by, opens_at, closes_at, time_limit_seconds, organization_id, subject_id, submission_mode, assignment_no, plagiarism_threshold)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [title, difficulty, description, req.user.userId, opensAt, closesAt, timeLimitSeconds, req.user.organizationId, subjectId, submissionMode, assignmentNo, plagiarismThreshold]
    );
    const problemId = problemRes.rows[0].id;

    if (submissionMode === 'code') {
      for (const [language, code] of Object.entries(starterCode)) {
        await client.query(
          `INSERT INTO starter_code (problem_id, language, code) VALUES ($1, $2, $3)`,
          [problemId, language, code]
        );
      }

      for (const testCase of testCases) {
        if (!testCase.expectedOutput) continue;
        await client.query(
          `INSERT INTO test_cases (problem_id, input, expected_output, is_hidden)
           VALUES ($1, $2, $3, $4)`,
          [problemId, testCase.input || '', testCase.expectedOutput, testCase.isHidden !== false]
        );
      }
    } else {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        await client.query(
          `INSERT INTO scan_assignment_questions (problem_id, position, prompt, marks, type, options, correct_option_id, word_limit, starter_code, test_cases)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [problemId, i, q.prompt, q.marks, q.type,
            q.options ? JSON.stringify(q.options) : null, q.correctOptionId, q.wordLimit,
            q.starterCode ? JSON.stringify(q.starterCode) : null, q.testCases ? JSON.stringify(q.testCases) : null]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Problem created successfully', problemId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Problem upload error:', error);
    res.status(500).json({ error: 'Failed to create problem' });
  } finally {
    client.release();
  }
});

// ============================================================================
// 7a-1. ADMIN: Fetch one assignment's full editable details (incl. hidden
// test cases) â€” used by AdminDashboard's "Edit" button to pre-fill the form.
// ============================================================================
router.get('/api/admin/problems/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const problemId = req.params.id;
  try {
    const problemRes = await pool.query(
      'SELECT id, title, difficulty, description, opens_at, closes_at, subject_id, submission_mode, assignment_no, plagiarism_threshold FROM problems WHERE id = $1 AND organization_id = $2',
      [problemId, req.user.organizationId]
    );
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    const problem = problemRes.rows[0];
    if (await enforceSubjectAuthority(req, res, problem.subject_id)) return;

    let starterCode = {};
    let testCases = [];
    let questions = [];
    if (problem.submission_mode === 'scan') {
      const questionsRes = await pool.query(
        `SELECT prompt, marks, type, options, correct_option_id, word_limit, starter_code, test_cases
         FROM scan_assignment_questions WHERE problem_id = $1 ORDER BY position ASC`,
        [problemId]
      );
      questions = questionsRes.rows.map((q) => ({
        prompt: q.prompt, marks: q.marks, type: q.type,
        options: q.options, correctOptionId: q.correct_option_id, wordLimit: q.word_limit,
        starterCode: q.starter_code, testCases: q.test_cases,
      }));
    } else {
      const codeRes = await pool.query(
        'SELECT language, code FROM starter_code WHERE problem_id = $1',
        [problemId]
      );
      codeRes.rows.forEach((row) => { starterCode[row.language] = row.code; });

      // Every test case, hidden ones included â€” unlike the student-facing
      // GET /api/problems/:id, which only returns visible samples.
      const testCasesRes = await pool.query(
        'SELECT input, expected_output, is_hidden FROM test_cases WHERE problem_id = $1 ORDER BY id ASC',
        [problemId]
      );
      testCases = testCasesRes.rows.map((tc) => ({
        input: tc.input,
        expectedOutput: tc.expected_output,
        isHidden: tc.is_hidden,
      }));
    }

    res.status(200).json({
      title: problem.title,
      difficulty: problem.difficulty,
      description: problem.description,
      starterCode,
      testCases,
      opensAt: problem.opens_at,
      closesAt: problem.closes_at,
      subjectId: problem.subject_id,
      submissionMode: problem.submission_mode,
      assignmentNo: problem.assignment_no,
      plagiarismThreshold: problem.plagiarism_threshold,
      questions,
    });
  } catch (err) {
    console.error('Fetch full problem error:', err);
    res.status(500).json({ error: 'Failed to load assignment details' });
  }
});

// ============================================================================
// 7a-2. ADMIN: Full update of an assignment â€” title, difficulty, description,
// starter code, and the complete set of test cases (full replace). Used by
// AssignmentForm's edit-mode submit.
// ============================================================================
router.put('/api/admin/problems/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const problemId = req.params.id;
  const { title, difficulty, description, starterCode = {}, testCases = [], opensAt = null, closesAt = null } = req.body;
  const subjectId = req.body.subjectId != null ? Number(req.body.subjectId) : null;
  const assignmentNo = String(req.body.assignmentNo || '').trim() || null;

  if (!title || !difficulty || !description) {
    return res.status(400).json({ error: 'Title, difficulty, and description are required' });
  }

  let questions = [];
  try {
    const rawQuestions = Array.isArray(req.body.questions) ? req.body.questions : [];
    questions = rawQuestions.map((q, i) => normalizeScanAssignmentQuestion(q, i));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let plagiarismThreshold;
  try {
    plagiarismThreshold = normalizePlagiarismThreshold(req.body.plagiarismThreshold);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // submission_mode is fixed at creation (not part of the SET below) —
    // fetched here purely to decide which of test-cases-vs-questions this
    // update should validate/replace.
    const existing = await client.query('SELECT id, subject_id, submission_mode FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Problem not found' });
    }
    const submissionMode = existing.rows[0].submission_mode;
    if (submissionMode === 'code' && (!Array.isArray(testCases) || testCases.length === 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'At least one test case is required' });
    }
    if (submissionMode === 'scan' && questions.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'At least one question is required for scanned assignments' });
    }
    if (submissionMode === 'scan' && !assignmentNo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Assignment number is required for scanned assignments' });
    }
    // A teacher must be authorized on both the item's current subject and
    // whatever subject they're moving it to (a no-op check for admins).
    if (await enforceSubjectAuthority(req, res, existing.rows[0].subject_id)) { await client.query('ROLLBACK'); return; }
    if (subjectId !== existing.rows[0].subject_id && await enforceSubjectAuthority(req, res, subjectId)) { await client.query('ROLLBACK'); return; }

    await client.query(
      submissionMode === 'scan'
        ? `UPDATE problems SET title = $1, difficulty = $2, description = $3, opens_at = $4, closes_at = $5, subject_id = $6, assignment_no = $7, plagiarism_threshold = $8 WHERE id = $9`
        : `UPDATE problems SET title = $1, difficulty = $2, description = $3, opens_at = $4, closes_at = $5, subject_id = $6 WHERE id = $7`,
      submissionMode === 'scan'
        ? [title, difficulty, description, opensAt, closesAt, subjectId, assignmentNo, plagiarismThreshold, problemId]
        : [title, difficulty, description, opensAt, closesAt, subjectId, problemId]
    );

    if (submissionMode === 'scan') {
      // Full replace, same as starter_code/test_cases below — matches how
      // AssignmentForm sends its payload (the whole question set at once).
      await client.query('DELETE FROM scan_assignment_questions WHERE problem_id = $1', [problemId]);
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        await client.query(
          `INSERT INTO scan_assignment_questions (problem_id, position, prompt, marks, type, options, correct_option_id, word_limit, starter_code, test_cases)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [problemId, i, q.prompt, q.marks, q.type,
            q.options ? JSON.stringify(q.options) : null, q.correctOptionId, q.wordLimit,
            q.starterCode ? JSON.stringify(q.starterCode) : null, q.testCases ? JSON.stringify(q.testCases) : null]
        );
      }
      await client.query('COMMIT');
      return res.status(200).json({ message: 'Assignment updated successfully', problemId });
    }

    // Starter code and test cases are fully replaced rather than diffed â€”
    // matches how AssignmentForm sends its payload (the whole set at once).
    await client.query('DELETE FROM starter_code WHERE problem_id = $1', [problemId]);
    for (const [language, code] of Object.entries(starterCode)) {
      if (!code) continue;
      await client.query(
        `INSERT INTO starter_code (problem_id, language, code) VALUES ($1, $2, $3)`,
        [problemId, language, code]
      );
    }

    await client.query('DELETE FROM test_cases WHERE problem_id = $1', [problemId]);
    for (const testCase of testCases) {
      if (!testCase.expectedOutput) continue;
      await client.query(
        `INSERT INTO test_cases (problem_id, input, expected_output, is_hidden) VALUES ($1, $2, $3, $4)`,
        [problemId, testCase.input || '', testCase.expectedOutput, testCase.isHidden !== false]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Assignment updated successfully', problemId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Problem update error:', error);
    res.status(500).json({ error: 'Failed to update assignment' });
  } finally {
    client.release();
  }
});

// ============================================================================
// 7b. ADMIN: Open/close an assignment's time slot
// ============================================================================
// Only touches the field(s) actually present in the body, so you can e.g. close
// an assignment right now without clobbering a previously-scheduled opens_at.
router.patch('/api/admin/problems/:id/window', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const problemId = req.params.id;
  const hasOpensAt = Object.prototype.hasOwnProperty.call(req.body, 'opensAt');
  const hasClosesAt = Object.prototype.hasOwnProperty.call(req.body, 'closesAt');

  if (!hasOpensAt && !hasClosesAt) {
    return res.status(400).json({ error: 'Provide opensAt and/or closesAt (send null to clear one)' });
  }

  try {
    const current = await pool.query('SELECT opens_at, closes_at, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    if (await enforceSubjectAuthority(req, res, current.rows[0].subject_id)) return;

    const nextOpensAt = hasOpensAt ? req.body.opensAt : current.rows[0].opens_at;
    const nextClosesAt = hasClosesAt ? req.body.closesAt : current.rows[0].closes_at;

    const result = await pool.query(
      `UPDATE problems SET opens_at = $1, closes_at = $2 WHERE id = $3
       RETURNING id, title, opens_at, closes_at`,
      [nextOpensAt, nextClosesAt, problemId]
    );

    const problem = result.rows[0];
    res.status(200).json({ message: 'Assignment window updated', problem: { ...problem, status: getProblemStatus(problem) } });
  } catch (err) {
    console.error('Update assignment window error:', err);
    res.status(500).json({ error: 'Failed to update assignment window' });
  }
});

// ============================================================================
// 7c. ADMIN: Test case management for an existing assignment
// ============================================================================

// List every test case for a problem, hidden ones included (admin-only view)
router.get('/api/admin/problems/:id/test-cases', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;

    const result = await pool.query(
      'SELECT id, input, expected_output, is_hidden FROM test_cases WHERE problem_id = $1 ORDER BY id ASC',
      [req.params.id]
    );
    res.status(200).json({ testCases: result.rows });
  } catch (err) {
    console.error('List test cases error:', err);
    res.status(500).json({ error: 'Failed to load test cases' });
  }
});

// Add one or more test cases to an existing problem
router.post('/api/admin/problems/:id/test-cases', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const problemId = req.params.id;
  const { testCases } = req.body;

  if (!Array.isArray(testCases) || testCases.length === 0) {
    return res.status(400).json({ error: 'At least one test case is required' });
  }

  try {
    const problemRes = await pool.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;

    const inserted = [];
    for (const tc of testCases) {
      if (!tc.expectedOutput) continue;
      const result = await pool.query(
        `INSERT INTO test_cases (problem_id, input, expected_output, is_hidden)
         VALUES ($1, $2, $3, $4) RETURNING id, input, expected_output, is_hidden`,
        [problemId, tc.input || '', tc.expectedOutput, tc.isHidden !== false]
      );
      inserted.push(result.rows[0]);
    }

    res.status(201).json({ message: `${inserted.length} test case(s) added`, testCases: inserted });
  } catch (err) {
    console.error('Add test cases error:', err);
    res.status(500).json({ error: 'Failed to add test cases' });
  }
});

// Remove a single test case by its own id
router.delete('/api/admin/test-cases/:testCaseId', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    // Join back to problems for the org check — test_cases itself has no
    // organization_id, it's scoped transitively via the problem it belongs to.
    const owner = await pool.query(
      `SELECT p.subject_id FROM test_cases tc JOIN problems p ON p.id = tc.problem_id
       WHERE tc.id = $1 AND p.organization_id = $2`,
      [req.params.testCaseId, req.user.organizationId]
    );
    if (owner.rows.length === 0) return res.status(404).json({ error: 'Test case not found' });
    if (await enforceSubjectAuthority(req, res, owner.rows[0].subject_id)) return;

    const result = await pool.query('DELETE FROM test_cases WHERE id = $1 RETURNING id', [req.params.testCaseId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Test case not found' });
    res.status(200).json({ message: 'Test case deleted' });
  } catch (err) {
    console.error('Delete test case error:', err);
    res.status(500).json({ error: 'Failed to delete test case' });
  }
});

// ============================================================================
// 7d. ADMIN: Delete an assignment entirely
// ============================================================================
// This is a hard delete â€” it also wipes that problem's starter code, test cases,
// and every student submission tied to it, so grade history for it goes with it.
// If you'd rather keep submission history around, consider closing the time
// slot instead (closesAt in the past) rather than deleting.
router.delete('/api/admin/problems/:id', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  const problemId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const problemRes = await client.query('SELECT id, title, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Problem not found' });
    }
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) { await client.query('ROLLBACK'); return; }

    await client.query('DELETE FROM submissions WHERE problem_id = $1', [problemId]);
    await client.query('DELETE FROM test_cases WHERE problem_id = $1', [problemId]);
    await client.query('DELETE FROM starter_code WHERE problem_id = $1', [problemId]);
    await client.query('DELETE FROM problems WHERE id = $1', [problemId]);

    await client.query('COMMIT');
    res.status(200).json({ message: `"${problemRes.rows[0].title}" and all related data were deleted` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete assignment error:', err);
    res.status(500).json({ error: 'Failed to delete assignment' });
  } finally {
    client.release();
  }
});

// Admin: every student's best submission for one assignment, with
// percentage/grade tag/percentile tag — mirrors GET /api/admin/exams/:id/attempts.
// Population for the percentile is every student's best submission for
// this problem, live (not deadline-filtered) — same as the exam version,
// teachers see current standings regardless of whether the deadline has
// passed; the deadline gate only affects the student-facing /result route.
// requireAdminOrTeacher + enforceSubjectAuthority, not requireAdmin — same
// bug and same fix as GET /api/admin/exams's own comment: this is reachable
// from AssignmentAttemptsPanel, rendered inside the teacher-only Assignments
// tab, but a teacher could never actually view it. Scoped to the problem's
// OWN subject_id (a teacher can only view attempts for assignments in
// subjects they're assigned to), matching every other problem route's
// posture.
router.get('/api/admin/problems/:id/attempts', authenticateToken, requireAdminOrTeacher, async (req, res) => {
  try {
    const problemRes = await pool.query('SELECT id, subject_id FROM problems WHERE id = $1 AND organization_id = $2', [req.params.id, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    if (await enforceSubjectAuthority(req, res, problemRes.rows[0].subject_id)) return;

    const bestRes = await pool.query(
      `SELECT DISTINCT ON (s.user_id) s.user_id, u.email, u.name, s.status, s.passed_count, s.total_count, s.created_at
       FROM submissions s
       JOIN users u ON u.id = s.user_id
       WHERE s.problem_id = $1
       ORDER BY s.user_id, (s.status = 'Accepted') DESC, s.passed_count DESC, s.created_at DESC`,
      [req.params.id]
    );

    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [req.user.organizationId]);
    const bands = bandsRes.rows;

    const percentages = bestRes.rows.filter((r) => r.total_count > 0).map((r) => (r.passed_count / r.total_count) * 100);
    const percentileFor = computePercentileTiers(percentages);

    const attempts = bestRes.rows.map((r) => {
      const percentage = r.total_count > 0 ? (r.passed_count / r.total_count) * 100 : null;
      return {
        email: r.email,
        name: r.name,
        status: r.status,
        passedCount: r.passed_count,
        totalCount: r.total_count,
        lastSubmittedAt: r.created_at,
        percentage,
        gradeTag: percentage != null ? gradeTagForPercentage(bands, percentage) : null,
        percentileTag: percentage != null ? percentileFor(percentage).tag : null,
      };
    });

    res.status(200).json({ attempts });
  } catch (err) {
    console.error('List assignment attempts error:', err);
    res.status(500).json({ error: 'Failed to load attempts' });
  }
});

router.post('/api/problems/:id/submit', authenticateToken, async (req, res) => {
  const problemId = req.params.id;
  const { language, code } = req.body;

  if (!language || !code) {
    return res.status(400).json({ error: 'Language and code are required' });
  }
  if (!LANGUAGE_CONFIG[language]) {
    return res.status(400).json({ error: 'Unsupported language' });
  }

  try {
    const problemRes = await pool.query('SELECT opens_at, closes_at FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });

    const status = getProblemStatus(problemRes.rows[0]);
    if (status !== 'open' && req.user.role !== 'admin') {
      return res.status(403).json({
        error: status === 'upcoming' ? 'This assignment is not open yet' : 'This assignment is closed',
      });
    }

    const testCasesRes = await pool.query(
      'SELECT id, input, expected_output, is_hidden FROM test_cases WHERE problem_id = $1 ORDER BY id ASC',
      [problemId]
    );
    const testCases = testCasesRes.rows;

    if (testCases.length === 0) {
      return res.status(404).json({ error: 'No test cases found for this problem' });
    }

    let passedCount = 0;
    let verdict = 'Accepted';
    let failedCase = null;

    // Run sequentially and stop at the first failure â€” mirrors how most judges behave on Submit
    for (const testCase of testCases) {
      const result = await executeInSandbox(language, code, testCase.input);

      if (!result.success) {
        verdict = result.timedOut ? 'Time Limit Exceeded' : 'Runtime Error';
        failedCase = { ...testCase, actualOutput: null, errorMessage: result.error };
        break;
      }

      if (normalizeOutput(result.output) === normalizeOutput(testCase.expected_output)) {
        passedCount += 1;
      } else {
        verdict = 'Wrong Answer';
        failedCase = { ...testCase, actualOutput: result.output };
        break;
      }
    }

    const insertRes = await pool.query(
      `INSERT INTO submissions (user_id, problem_id, language, code, status, passed_count, total_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.userId, problemId, language, code, verdict, passedCount, testCases.length]
    );

    if (verdict === 'Accepted') {
      runCodePlagiarismComparator({ id: insertRes.rows[0].id, problem_id: Number(problemId), user_id: req.user.userId, code });
    }

    const response = { verdict, passed: passedCount, total: testCases.length };

    if (failedCase) {
      // Only reveal the actual input/output if the failing case was a visible sample â€”
      // hidden cases stay hidden even on failure, same as a real judge
      response.failedCase = failedCase.is_hidden
        ? { hidden: true }
        : {
            input: failedCase.input,
            expectedOutput: failedCase.expected_output,
            actualOutput: failedCase.actualOutput,
            error: failedCase.errorMessage || null,
          };
    }

    res.status(200).json(response);
  } catch (err) {
    console.error('Submission error:', err);
    res.status(500).json({ error: 'Failed to grade submission' });
  }
});

// Accumulates real time-on-task for one (student, problem) pair. The
// frontend calls this repeatedly with small deltas — on heartbeat, on the
// tab going background, and on the page actually closing — rather than once
// with a total, so a crashed tab or a closed laptop lid never loses more
// than one heartbeat interval's worth of time. Deliberately NOT gated on the
// assignment's open/closed window: time still counts if a student revisits
// a closed assignment, and repeat visits keep adding to the same total.
router.post('/api/problems/:id/time-log', authenticateToken, async (req, res) => {
  const problemId = req.params.id;
  const seconds = Number(req.body?.seconds);

  // Nothing to record (0, negative, missing, or NaN) isn't an error — the
  // tab may have been hidden the whole interval. Just acknowledge it.
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return res.status(200).json({ ok: true });
  }

  // Clamp each individual delta so a stale/suspended tab waking up (or a
  // tampered client) can't inflate a student's tracked time in one call —
  // this is well above the heartbeat interval the frontend actually uses.
  const clamped = Math.min(Math.round(seconds), 300);

  try {
    const problemRes = await pool.query('SELECT id FROM problems WHERE id = $1 AND organization_id = $2', [problemId, req.user.organizationId]);
    if (problemRes.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });

    await pool.query(
      `INSERT INTO problem_time_logs (user_id, problem_id, total_seconds)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, problem_id)
       DO UPDATE SET total_seconds = problem_time_logs.total_seconds + EXCLUDED.total_seconds,
                     updated_at = now()`,
      [req.user.userId, problemId, clamped]
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Time log error:', err);
    res.status(500).json({ error: 'Failed to log time' });
  }
});

module.exports = router;
