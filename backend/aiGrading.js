// AI-assisted correctness assessment for scanned handwritten answers — a
// grading AID, never a grader. Given a question and the OCR'd text of a
// student's answer, it says what looks correct/incorrect; a teacher always
// decides the actual marks (see PUT /api/admin/scan-submissions/:id/grade).
// This is a genuinely different job than OCR (reading handwriting) or the
// text-plagiarism comparator (comparing two submissions to each other) —
// it needs real language understanding of arbitrary question/answer pairs,
// which is why it's the one piece of this pipeline that isn't self-hosted.
//
// Uses Groq's OpenAI-compatible chat completions endpoint (fast inference,
// free tier — not to be confused with xAI's Grok, a different product/
// company despite the near-identical name) — plain HTTPS fetch, no SDK,
// same posture as mailer.js's Gmail call.
//
// Same lazy-config posture as storage.js/mailer.js/ocrClient.js: no request
// attempted until GROQ_API_KEY exists, so an unconfigured deploy degrades
// (submissions still get OCR'd and are still teacher-gradable, just without
// the AI assessment column filled in) instead of crashing at boot.
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

function isGroqConfigured() {
  return !!process.env.GROQ_API_KEY;
}

function buildPrompt(questions, ocrText) {
  const questionList = questions.map((q, i) => `${i + 1}. (${q.marks} marks) ${q.prompt}`).join('\n');
  return `You are assisting a teacher in grading a student's handwritten assignment. The student's answers were read by OCR (handwriting recognition) and may contain misread words or garbled spelling — be lenient about that, judge the underlying meaning, not exact spelling.

Questions:
${questionList}

OCR'd text of the student's full answer sheet (may cover multiple questions in any order, and may not clearly separate them):
"""
${ocrText || '(no text was recognized)'}
"""

For EACH question above, assess whether the student's answer (if you can identify one) is correct, incorrect, or partially correct. If you cannot find an answer to a question at all in the text, say so.

Respond with ONLY a JSON object shaped exactly like:
{"assessments": [{"questionNumber": 1, "verdict": "correct" | "incorrect" | "partial" | "not_found", "note": "one short sentence explaining why"}]}`;
}

// Never throws for a malformed/unparseable model response — an AI-
// assessment hiccup shouldn't block a submission from reaching ocr_done;
// the OCR text itself is still there for a teacher to grade manually.
// Only throws for actual configuration/API failures, which the caller
// (the deadline sweep) already wraps in a per-submission try/catch.
async function assessAnswers(questions, ocrText) {
  if (!isGroqConfigured()) throw new Error('Groq is not configured (GROQ_API_KEY missing)');
  if (questions.length === 0) return [];

  const fallback = questions.map(() => 'AI assessment unavailable.');
  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: buildPrompt(questions, ocrText) }],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Groq API returned ${res.status}: ${body}`);
    }
    const data = await res.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    const assessments = Array.isArray(parsed?.assessments) ? parsed.assessments : null;
    if (!assessments) return fallback;

    const byNumber = new Map(assessments.map((item) => [Number(item.questionNumber), item]));
    return questions.map((_, i) => {
      const item = byNumber.get(i + 1);
      if (!item || !item.verdict) return 'AI assessment unavailable.';
      return `${item.verdict} — ${item.note || ''}`.trim();
    });
  } catch (err) {
    console.error('Groq assessment failed:', err);
    return fallback;
  }
}

module.exports = { isGroqConfigured, assessAnswers };
