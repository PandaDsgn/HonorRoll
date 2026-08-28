// Exam-answer grading helpers — used by BOTH the exams domain (exam
// submit/regrade routes) and the scan pipeline's digital-answer
// finalize step (gradeCodingAnswer specifically), so this is a
// shared module rather than living in routes/exams.js alone. Split
// out of index.js as part of breaking that monolith into modules.
// Pure relocation.
const { pool } = require('./db');
const { executeInSandbox, normalizeOutput } = require('./sandbox');
const { isGroqConfigured, assessAnswers } = require('../aiGrading');

// Resolves the FULL (including hidden) test-case list for a coding exam
// item, regardless of whether it's "reuse" mode (problem_id set — pull from
// the problems/test_cases tables like the assignment judge does) or
// "custom" mode (problem_id NULL — the item authored its own test_cases
// JSONB inline). Callers that only care about grading don't need to know
// which source they came from. If the linked problem was since deleted
// (exam_items.problem_id -> NULL via its existing ON DELETE SET NULL) or a
// custom item somehow has none, returns an empty list rather than throwing,
// so one dangling item can't fail an entire submit.
async function getExamItemTestCases(item) {
  if (item.problem_id) {
    const res = await pool.query(
      'SELECT input, expected_output FROM test_cases WHERE problem_id = $1',
      [item.problem_id]
    );
    return res.rows;
  }
  if (Array.isArray(item.test_cases)) {
    return item.test_cases.map((tc) => ({ input: tc.input, expected_output: tc.expectedOutput }));
  }
  return [];
}

// Runs EVERY test case (unlike /api/problems/:id/submit, which stops at the
// first failure) so the item can be awarded proportional partial credit
// instead of one binary pass/fail verdict.
async function gradeCodingAnswer(testCases, language, code) {
  if (!testCases || testCases.length === 0 || !language || !code) return { passedCount: 0, totalCount: 0 };

  let passedCount = 0;
  for (const tc of testCases) {
    const result = await executeInSandbox(language, code, tc.input);
    if (result.success && normalizeOutput(result.output) === normalizeOutput(tc.expected_output)) {
      passedCount += 1;
    }
  }
  return { passedCount, totalCount: testCases.length };
}

// Grades every answer in `answers` against `examItems`, upserts one row per
// item into exam_answers, and returns the summed auto-graded score. Shared
// by the real submit route and the "reopened a stale in-progress attempt"
// path in /start, so grading logic never forks between the two callers.
// mcq is graded exactly (full marks or zero); coding gets proportional
// partial credit; short/long are stored raw with marks_awarded left NULL —
// grading those is a manual-review feature that doesn't exist yet. scan
// items never appear in `answers` at all (they're answered on paper, not
// through the on-screen form) — POST /api/exams/:id/submit handles those
// separately via the compiled PDF and exam_scan_answers, not here.
async function finalizeExamAttempt(attemptId, examItems, answers) {
  const itemsById = new Map(examItems.map((it) => [it.id, it]));
  let score = 0;

  for (const ans of answers || []) {
    const item = itemsById.get(Number(ans.itemId));
    if (!item || item.type === 'scan') continue; // ignore ids that don't belong to this exam, and scan items (see above)

    let row = {
      selected_option_id: null, text_answer: null, language: null, code: null,
      is_correct: null, passed_count: null, total_count: null, marks_awarded: null,
    };

    if (item.type === 'mcq') {
      const selected = ans.selectedOptionId != null ? String(ans.selectedOptionId) : null;
      const correct = selected != null && selected === item.correct_option_id;
      row.selected_option_id = selected;
      row.is_correct = correct;
      row.marks_awarded = correct ? item.marks : 0;
      score += row.marks_awarded;
    } else if (item.type === 'short' || item.type === 'long') {
      row.text_answer = ans.textAnswer != null ? String(ans.textAnswer) : null;
      // marks_awarded stays NULL — ungraded, doesn't contribute to score
    } else if (item.type === 'coding') {
      const language = ans.language || null;
      const code = ans.code != null ? String(ans.code) : '';
      let passedCount = 0;
      let totalCount = 0;
      try {
        const testCases = await getExamItemTestCases(item);
        ({ passedCount, totalCount } = await gradeCodingAnswer(testCases, language, code));
      } catch (err) {
        console.error('Coding answer grading error:', err);
      }
      const marksAwarded = totalCount > 0 ? Math.round((item.marks * passedCount) / totalCount) : 0;
      row.language = language;
      row.code = code;
      row.passed_count = passedCount;
      row.total_count = totalCount;
      row.marks_awarded = marksAwarded;
      score += marksAwarded;
    }

    await pool.query(
      `INSERT INTO exam_answers (attempt_id, item_id, selected_option_id, text_answer, language, code, is_correct, passed_count, total_count, marks_awarded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (attempt_id, item_id) DO UPDATE SET
         selected_option_id = EXCLUDED.selected_option_id, text_answer = EXCLUDED.text_answer,
         language = EXCLUDED.language, code = EXCLUDED.code, is_correct = EXCLUDED.is_correct,
         passed_count = EXCLUDED.passed_count, total_count = EXCLUDED.total_count, marks_awarded = EXCLUDED.marks_awarded`,
      [attemptId, item.id, row.selected_option_id, row.text_answer, row.language, row.code,
        row.is_correct, row.passed_count, row.total_count, row.marks_awarded]
    );
  }

  return score;
}

// Assist-only AI suggestion for short/long items, same posture as the scan-
// grading pipeline's assessAnswers call: never touches marks_awarded, purely
// a note a teacher sees next to the grade input in GradingForm. Deliberately
// NOT awaited inline in POST /api/exams/:id/submit (see the call site) —
// each item is its own Groq call, and blocking a student's submit response
// on that would add real latency/failure risk to every exam finish. One
// assessAnswers call per item rather than one batched call for all of them:
// unlike the OCR pipeline (one text blob that may cover several questions,
// needing the model to disentangle which answer belongs to which prompt),
// each short/long item already has its own cleanly separated text_answer —
// batching would just reintroduce an ambiguity that doesn't exist here.
async function runExamShortLongAiAssessment(attemptId, examItems) {
  if (!isGroqConfigured()) return;
  const shortLongItems = examItems.filter((it) => it.type === 'short' || it.type === 'long');
  if (shortLongItems.length === 0) return;
  const itemsById = new Map(shortLongItems.map((it) => [it.id, it]));

  try {
    const answersRes = await pool.query(
      'SELECT id, item_id, text_answer FROM exam_answers WHERE attempt_id = $1 AND item_id = ANY($2::int[])',
      [attemptId, shortLongItems.map((it) => it.id)]
    );
    for (const row of answersRes.rows) {
      if (!row.text_answer || !row.text_answer.trim()) continue;
      const item = itemsById.get(row.item_id);
      if (!item) continue;
      const [assessment] = await assessAnswers([{ prompt: item.prompt, marks: item.marks }], row.text_answer, { isOcr: false });
      await pool.query('UPDATE exam_answers SET ai_assessment = $1 WHERE id = $2', [assessment || null, row.id]);
    }
  } catch (err) {
    console.error(`Exam short/long AI assessment failed for attempt ${attemptId}:`, err);
  }
}

// Recomputes and saves an attempt's total score from scratch — marks_awarded
// summed across BOTH exam_answers (mcq/coding auto-graded, short/long once
// manually graded) and exam_scan_answers (scan items, always manually
// graded). Called after any manual grade so a teacher grading a scan item
// doesn't leave the attempt's score stale by only ever having summed
// exam_answers, the way a single-table SUM would.
async function recomputeExamAttemptScore(attemptId) {
  const res = await pool.query(
    `SELECT
       COALESCE((SELECT SUM(marks_awarded) FROM exam_answers WHERE attempt_id = $1), 0) +
       COALESCE((SELECT SUM(marks_awarded) FROM exam_scan_answers WHERE attempt_id = $1), 0) AS score`,
    [attemptId]
  );
  const score = res.rows[0].score;
  await pool.query('UPDATE exam_attempts SET score = $1 WHERE id = $2', [score, attemptId]);
  return score;
}

// An attempt is "fully graded" once every short/long answer AND every scan
// item has a non-NULL marks_awarded — mcq and coding are always auto-graded
// at submit time, so an exam with none of those manually-graded types is
// fully graded the instant it's submitted, no admin action ever needed.
// Used to gate percentage/grade/percentile tags, which are meaningless
// while any item is still ungraded.
async function isAttemptFullyGraded(attemptId) {
  const res = await pool.query(
    `SELECT NOT EXISTS (
       SELECT 1 FROM exam_answers ea
       JOIN exam_items ei ON ei.id = ea.item_id
       WHERE ea.attempt_id = $1 AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
     ) AND NOT EXISTS (
       SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = $1 AND esa.marks_awarded IS NULL
     ) AS fully_graded`,
    [attemptId]
  );
  return res.rows[0].fully_graded;
}

module.exports = {
  getExamItemTestCases, gradeCodingAnswer, finalizeExamAttempt,
  runExamShortLongAiAssessment, recomputeExamAttemptScore, isAttemptFullyGraded,
};
