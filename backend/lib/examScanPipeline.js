// Exam-scan OCR pipeline — split out of index.js as part of breaking
// that monolith into modules. ocrLimit is the SHARED concurrency cap
// used by both this pipeline and the problem-scan pipeline (still in
// index.js, to be extracted alongside processOneScanSubmission when
// routes/scans.js is built) — canonical home for it is here so both
// sides share the exact same limiter instance rather than each
// getting their own separate concurrency budget.
const pLimit = require('p-limit');
const { pool } = require('./db');
const { isB2Configured, downloadScanPdf } = require('../storage');
const { isOcrConfigured, runOcr } = require('../ocrClient');
const { isGroqConfigured, assessAnswers } = require('../aiGrading');


// Exam-side counterpart to processOneScanSubmission above — same shape,
// except there's no shared deadline sweep to wait on: each student's own
// submit is what ends their attempt, so this runs immediately from
// POST /api/exams/:id/submit rather than a periodic sweep. Doesn't run the
// cross-submission plagiarism/handwriting comparators scan_submissions
// gets — those compare many students against each other on the SAME
// assignment/deadline, a feature this exam-scan path deliberately doesn't
// take on; OCR + teacher grading is the whole scope here.
async function processOneExamScanAttempt(attemptId) {
  const client = await pool.connect();
  try {
    await client.query(`UPDATE exam_attempts SET scan_status = 'processing' WHERE id = $1`, [attemptId]);

    const attemptRes = await client.query('SELECT id, exam_id, scan_storage_key FROM exam_attempts WHERE id = $1', [attemptId]);
    if (attemptRes.rows.length === 0) return;
    const attempt = attemptRes.rows[0];

    if (!isB2Configured()) throw new Error('B2 storage is not configured');
    if (!isOcrConfigured()) throw new Error('OCR is not configured');

    const { buffer: pdfBuffer } = await downloadScanPdf(attempt.scan_storage_key);
    const { pages } = await runOcr(pdfBuffer);
    const ocrText = pages.map((p) => p.text).join('\n\n');

    const itemsRes = await client.query(
      `SELECT id, prompt, marks FROM exam_items WHERE exam_id = $1 AND type = 'scan' ORDER BY position ASC`,
      [attempt.exam_id]
    );
    const items = itemsRes.rows;

    // Best-effort — an AI-assessment hiccup shouldn't block OCR text from
    // being saved and the attempt from becoming teacher-gradable.
    const assessments = isGroqConfigured()
      ? await assessAnswers(items.map((it) => ({ prompt: it.prompt, marks: it.marks })), ocrText)
      : items.map(() => 'AI assessment unavailable (Groq not configured).');

    for (let i = 0; i < items.length; i++) {
      await client.query(
        `INSERT INTO exam_scan_answers (attempt_id, item_id, ai_assessment)
         VALUES ($1, $2, $3)
         ON CONFLICT (attempt_id, item_id) DO UPDATE SET ai_assessment = EXCLUDED.ai_assessment`,
        [attemptId, items[i].id, assessments[i] || null]
      );
    }

    await client.query(
      `UPDATE exam_attempts SET scan_ocr_text = $1, scan_ocr_pages = $2,
         scan_status = 'ocr_done', scan_ocr_completed_at = now(), scan_ocr_error = NULL WHERE id = $3`,
      [ocrText, JSON.stringify(pages), attemptId]
    );
  } catch (err) {
    console.error(`Exam scan OCR pipeline failed for attempt ${attemptId}:`, err);
    await client.query(
      `UPDATE exam_attempts SET scan_status = 'ocr_failed', scan_ocr_error = $1 WHERE id = $2`,
      [String(err.message || err).slice(0, 500), attemptId]
    ).catch(() => {});
  } finally {
    client.release();
  }
}

// Runs at most OCR_CONCURRENCY submissions at once, modest by default so a
// deadline shared by many students doesn't hammer the free OCR Space all at
// once — same pLimit pattern as sandboxLimit above, just a separate limiter
// since these are unrelated resource pools.
const ocrLimit = pLimit(Number(process.env.OCR_CONCURRENCY || 2));

const examScanOcrInFlight = new Set();

module.exports = { ocrLimit, examScanOcrInFlight, processOneExamScanAttempt };
