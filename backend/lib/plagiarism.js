// Code-plagiarism detection for coding-assignment submissions — the
// one piece of the larger plagiarism toolkit that's problems-domain
// rather than scan/OCR-domain, so it gets its own small module.
// jaccardSimilarity itself is genuinely shared with the text/
// handwriting comparators that stay in index.js for now (they move
// with the rest of the scan pipeline in a later pass) — duplicated
// here rather than partially extracted, since it's a tiny, pure,
// side-effect-free function with no sane way to half-share it.
const { pool } = require('./db');

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const shingle of setA) if (setB.has(shingle)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// 8-token-shingle Jaccard similarity for coding submissions — same
// technique as textShingles above (jaccardSimilarity is shared), just
// tokenized for code instead of prose: comments stripped first (so a
// student who only adds/removes comments doesn't dodge detection), then
// split into identifiers/numbers/single-char operators rather than words.
// A larger k than the 5-word text shingle since code tokens run shorter
// and denser than prose — 8 keeps boilerplate (loop headers, print calls)
// from dominating the shingle set.
function codeShingles(code, k = 8) {
  const stripped = String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/#.*$/gm, ' ');
  const tokens = stripped.match(/[A-Za-z_]\w*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_]/g) || [];
  const set = new Set();
  for (let i = 0; i <= tokens.length - k; i++) set.add(tokens.slice(i, i + k).join(' '));
  return set;
}

// Runs after a submission judges as Accepted (see POST /api/problems/:id/
// submit) — comparing every retry against every other student's every
// retry would be noisy and quadratic, so this only ever compares final
// passing solutions, one per other student (their own most recent
// Accepted submission to this same problem). Fire-and-forget from the
// submit route: cheap in-memory set ops, no external calls, but never
// worth delaying the judge response over.
async function runCodePlagiarismComparator(submission) {
  try {
    const orgRes = await pool.query(
      'SELECT o.code_plagiarism_threshold FROM organizations o JOIN problems p ON p.organization_id = o.id WHERE p.id = $1',
      [submission.problem_id]
    );
    const threshold = orgRes.rows[0]?.code_plagiarism_threshold ?? 0.6;
    const mySet = codeShingles(submission.code);
    if (mySet.size === 0) return;

    const othersRes = await pool.query(
      `SELECT DISTINCT ON (user_id) id, user_id, code FROM submissions
       WHERE problem_id = $1 AND user_id != $2 AND status = 'Accepted'
       ORDER BY user_id, created_at DESC`,
      [submission.problem_id, submission.user_id]
    );
    for (const other of othersRes.rows) {
      const similarity = jaccardSimilarity(mySet, codeShingles(other.code));
      if (similarity < threshold) continue;
      const [a, b] = submission.id < other.id ? [submission.id, other.id] : [other.id, submission.id];
      await pool.query(
        `INSERT INTO submission_plagiarism_flags (problem_id, submission_a_id, submission_b_id, similarity_score)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (problem_id, submission_a_id, submission_b_id) DO NOTHING`,
        [submission.problem_id, a, b, similarity]
      );
    }
  } catch (err) {
    console.error('Code plagiarism comparator failed:', err);
  }
}

module.exports = { runCodePlagiarismComparator, jaccardSimilarity };
