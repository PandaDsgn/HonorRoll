// Exam/scan-assignment item validation — pure, side-effect-free
// functions shared by BOTH the problems domain (scan-mode assignment
// questions) and the exams domain (exam builder items, question
// bank) — genuinely cross-cutting, so it gets its own small module
// rather than living in either route file. Split out of index.js as
// part of breaking that monolith into modules. Pure relocation.
// Validates the optional per-assignment time limit sent from AssignmentForm.
// '', null, and undefined all mean "no limit" and normalize to null; any
// other value must be a positive whole number of seconds. Shared by the
// create and update routes so the rule can't drift between the two. Throws
// on anything invalid — callers turn that straight into a 400.
function normalizeTimeLimitSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Time limit must be a positive number of seconds, or left blank for no limit');
  }
  return Math.round(n);
}

const EXAM_ITEM_TYPES = new Set(['mcq', 'short', 'long', 'coding', 'scan']);

// Validates + normalizes one item from the exam builder's payload, returning
// a clean object ready to insert. Throws a message naming the offending item
// (1-indexed, matching what the admin sees on screen), which the route
// handlers turn straight into a 400 — so a bad MCQ buried in item #7 doesn't
// just come back as a generic "bad request".
function normalizeExamItem(raw, index) {
  const label = `Item ${index + 1}`;
  if (!raw || !EXAM_ITEM_TYPES.has(raw.type)) {
    throw new Error(`${label}: type must be one of mcq, short, long, coding, scan`);
  }

  const marks = Number(raw.marks);
  if (!Number.isFinite(marks) || marks <= 0) {
    throw new Error(`${label}: marks must be a positive number`);
  }

  let timeLimitSeconds;
  try {
    timeLimitSeconds = normalizeTimeLimitSeconds(raw.timeLimitSeconds);
  } catch {
    throw new Error(`${label}: time limit must be a positive number of seconds, or left blank`);
  }

  const base = { type: raw.type, marks: Math.round(marks), timeLimitSeconds };

  if (raw.type === 'mcq') {
    const prompt = String(raw.prompt || '').trim();
    if (!prompt) throw new Error(`${label}: question text is required`);

    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    const options = rawOptions
      .filter((o) => o && String(o.text || '').trim())
      .map((o, i) => ({ id: o.id != null ? String(o.id) : String(i), text: String(o.text).trim() }));
    if (options.length < 2) throw new Error(`${label}: MCQ needs at least 2 options`);

    const correctOptionId = raw.correctOptionId != null ? String(raw.correctOptionId) : null;
    if (!correctOptionId || !options.some((o) => o.id === correctOptionId)) {
      throw new Error(`${label}: select which option is correct`);
    }

    return { ...base, prompt, options, correctOptionId, wordLimit: null, problemId: null, starterCode: null, testCases: null };
  }

  if (raw.type === 'short' || raw.type === 'long') {
    const prompt = String(raw.prompt || '').trim();
    if (!prompt) throw new Error(`${label}: question text is required`);

    let wordLimit = null;
    if (raw.wordLimit !== null && raw.wordLimit !== undefined && raw.wordLimit !== '') {
      wordLimit = Number(raw.wordLimit);
      if (!Number.isFinite(wordLimit) || wordLimit <= 0) {
        throw new Error(`${label}: word limit must be a positive number, or left blank`);
      }
      wordLimit = Math.round(wordLimit);
    }

    return { ...base, prompt, options: null, correctOptionId: null, wordLimit, problemId: null, starterCode: null, testCases: null };
  }

  if (raw.type === 'scan') {
    const prompt = String(raw.prompt || '').trim();
    if (!prompt) throw new Error(`${label}: question text is required`);
    return { ...base, prompt, options: null, correctOptionId: null, wordLimit: null, problemId: null, starterCode: null, testCases: null };
  }

  // coding — either "reuse" (problemId points at an existing assignment,
  // its problems/test_cases/starter_code rows are used as-is) or "custom"
  // (authored inline here: its own prompt/starterCode/testCases, no
  // problemId). Reuse mode is signaled by a problemId being present at all;
  // custom mode is everything else, mirroring AssignmentForm's own
  // cleanCases-then-require-at-least-one-case validation.
  if (raw.problemId !== null && raw.problemId !== undefined && raw.problemId !== '') {
    const problemId = Number(raw.problemId);
    if (!Number.isFinite(problemId)) {
      throw new Error(`${label}: pick an existing coding assignment`);
    }
    return {
      ...base,
      prompt: raw.prompt ? String(raw.prompt).trim() : null,
      options: null, correctOptionId: null, wordLimit: null,
      problemId, starterCode: null, testCases: null,
    };
  }

  const prompt = String(raw.prompt || '').trim();
  if (!prompt) throw new Error(`${label}: question text is required`);

  const rawStarterCode = raw.starterCode && typeof raw.starterCode === 'object' ? raw.starterCode : {};
  const starterCode = Object.fromEntries(
    Object.entries(rawStarterCode)
      .filter(([lang, code]) => ['python', 'c', 'cpp', 'java'].includes(lang) && String(code || '').trim())
      .map(([lang, code]) => [lang, String(code)])
  );

  const rawTestCases = Array.isArray(raw.testCases) ? raw.testCases : [];
  const testCases = rawTestCases
    .filter((tc) => tc && String(tc.expectedOutput || '').trim())
    .map((tc) => ({ input: String(tc.input || ''), expectedOutput: String(tc.expectedOutput), isHidden: !!tc.isHidden }));
  if (testCases.length === 0) {
    throw new Error(`${label}: pick an existing assignment, or add at least one test case with an expected output`);
  }

  return {
    ...base, prompt, options: null, correctOptionId: null, wordLimit: null,
    problemId: null, starterCode, testCases,
  };
}

// Scan-mode assignments reuse normalizeExamItem's validation wholesale
// (same mcq/short/long/coding/scan shape as exam_items) but never allow
// coding's "reuse an existing assignment" mode — nesting one assignment
// inside another has no clear meaning, and scan_assignment_questions has
// no problem_id column to hold that reference even if it did. Also drops
// timeLimitSeconds, which scan assignments don't have a per-question slot
// for (only the whole assignment's own time_limit_seconds applies).
function normalizeScanAssignmentQuestion(raw, index) {
  const item = normalizeExamItem(raw, index);
  if (item.type === 'coding' && item.problemId != null) {
    throw new Error(`Item ${index + 1}: coding questions in assignments must be written inline, not reused from an existing assignment`);
  }
  return item;
}

module.exports = {
  normalizeTimeLimitSeconds, EXAM_ITEM_TYPES, normalizeExamItem, normalizeScanAssignmentQuestion,
};
