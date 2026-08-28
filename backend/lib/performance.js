// Gradebook/performance-math helper library — shared by problems,
// exams, gradebook, and performance routes simultaneously. Split out
// of index.js as part of breaking that monolith into modules. Pure
// relocation: nothing about any function's logic changed, only where
// it lives.
const { pool } = require('./db');
const { cached } = require('../cache');

/**
 * Computes an assignment's availability from its opens_at/closes_at columns.
 * Both are nullable — no opens_at means "no start gate", no closes_at means "never closes".
 *   - 'upcoming': before opens_at — hidden from students entirely
 *   - 'open':     within the window (or no window at all) — visible and submittable
 *   - 'closed':   after closes_at — still visible, but read-only for students
 */
function getProblemStatus(problem) {
  const now = new Date();
  if (problem.opens_at && now < new Date(problem.opens_at)) return 'upcoming';
  if (problem.closes_at && now > new Date(problem.closes_at)) return 'closed';
  return 'open';
}

// Every subject a student can see given their own org_unit — not just
// subjects attached directly to their unit, but any subject attached to an
// ANCESTOR of it too (a subject on "Computer Science", a Department-tier
// unit, reaches every Year beneath it). Tree depth is capped at ~8 tiers in
// practice, so this recursive walk is cheap. A student with no org_unit at
// all (orgUnitId null) can only see org-wide, subject-less items.
async function getVisibleSubjectIds(orgUnitId) {
  if (!orgUnitId) return [];
  const { rows } = await pool.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_unit_id FROM org_units WHERE id = $1
       UNION ALL
       SELECT ou.id, ou.parent_unit_id FROM org_units ou JOIN ancestors a ON ou.id = a.parent_unit_id
     )
     SELECT s.id FROM subjects s WHERE s.org_unit_id IN (SELECT id FROM ancestors)`,
    [orgUnitId]
  );
  return rows.map((r) => r.id);
}

// Fetches every org_unit + level label for an org once, so a whole list of
// students can each have their tier path (e.g. "North Campus / Computer
// Science / Year 1") resolved by walking an in-memory map instead of one
// recursive SQL query per row — matters once a roster has a few hundred
// students in it.
async function getOrgUnitLookup(organizationId) {
  const [levelsRes, unitsRes] = await Promise.all([
    pool.query('SELECT id, label FROM org_level_defs WHERE organization_id = $1', [organizationId]),
    pool.query('SELECT id, parent_unit_id, name, level_def_id FROM org_units WHERE organization_id = $1', [organizationId]),
  ]);
  const levelsById = new Map(levelsRes.rows.map((l) => [l.id, l.label]));
  const unitsById = new Map(unitsRes.rows.map((u) => [u.id, u]));
  return { levelsById, unitsById };
}

// Root-to-leaf breadcrumb for one unit — [{label:'Campus', name:'North
// Campus'}, {label:'Department', name:'Computer Science'}, ...]. Empty
// array for a student with no org_unit assigned at all.
function resolveOrgUnitPath({ levelsById, unitsById }, orgUnitId) {
  const parts = [];
  let current = orgUnitId ? unitsById.get(orgUnitId) : null;
  while (current) {
    parts.unshift({ label: levelsById.get(current.level_def_id) || null, name: current.name });
    current = current.parent_unit_id ? unitsById.get(current.parent_unit_id) : null;
  }
  return parts;
}

// ============================================================================
// Teacher dashboard helpers — every subject a teacher is assigned to, and
// every student "under" them (their subjects' own org_unit, and every unit
// beneath it), the same tier-cascades-down rule GET /api/teacher/non-
// submitters already uses, factored out here so the fuller teacher
// dashboard routes below can share it instead of re-deriving it. Mirrors
// getVisibleSubjectIds() above but walks the tree the other way: that one
// walks a student's unit UP toward subjects, this walks a teacher's
// subjects DOWN toward students.
// ============================================================================
async function getTeacherScope(userId, organizationId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE my_subjects AS (
       SELECT s.id AS subject_id, s.org_unit_id
       FROM subjects s
       JOIN subject_teachers st ON st.subject_id = s.id
       WHERE st.user_id = $1 AND s.organization_id = $2
     ),
     descendant_units AS (
       SELECT id FROM org_units WHERE id IN (SELECT org_unit_id FROM my_subjects)
       UNION
       SELECT ou.id FROM org_units ou JOIN descendant_units d ON ou.parent_unit_id = d.id
     )
     SELECT
       COALESCE((SELECT array_agg(DISTINCT subject_id) FROM my_subjects), '{}') AS subject_ids,
       COALESCE((SELECT array_agg(id) FROM descendant_units), '{}') AS unit_ids`,
    [userId, organizationId]
  );
  return { subjectIds: rows[0].subject_ids, unitIds: rows[0].unit_ids };
}

async function getTeacherScopedStudents(organizationId, unitIds) {
  if (unitIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.created_at, m.org_unit_id
     FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $1 AND m.role = 'student'
     WHERE m.org_unit_id = ANY($2::int[])
     ORDER BY u.email ASC`,
    [organizationId, unitIds]
  );
  return rows;
}

// Per-student, per-problem status/percent for a given set of assignments —
// code-mode (auto-judged test cases) and scan-mode (teacher-awarded marks,
// possibly mixed item types — see scan_assignment_questions' own comment)
// are scored on different raw scales, so both are normalized to a 0-100
// percent before being handed back, letting callers treat them uniformly.
// status is 'not_submitted' (no row at all — the default when a problem id
// is simply absent from a student's map), 'pending_grading' (submitted but
// not fully marked yet), or 'graded' (percent is final).
//
// Takes the already-resolved `problems` list ([{id, submission_mode}, ...])
// rather than resolving it itself — callers scope "which assignments count"
// very differently (a teacher's own subject_teachers link vs. a student's
// getVisibleSubjectIds visibility), so that resolution query belongs to the
// caller, not this shared scoring logic.
async function getAssignmentPerformance(problems, studentIds) {
  const codeIds = problems.filter((p) => p.submission_mode === 'code').map((p) => p.id);
  const scanIds = problems.filter((p) => p.submission_mode === 'scan').map((p) => p.id);

  const byUser = new Map(studentIds.map((id) => [id, new Map()]));

  if (codeIds.length && studentIds.length) {
    const r = await pool.query(
      `SELECT DISTINCT ON (s.user_id, s.problem_id) s.user_id, s.problem_id, s.passed_count, s.total_count
       FROM submissions s
       WHERE s.problem_id = ANY($1::int[]) AND s.user_id = ANY($2::uuid[])
       ORDER BY s.user_id, s.problem_id, (s.status = 'Accepted') DESC, s.passed_count DESC, s.created_at DESC`,
      [codeIds, studentIds]
    );
    r.rows.forEach((row) => {
      const pct = row.total_count > 0 ? (row.passed_count / row.total_count) * 100 : null;
      byUser.get(row.user_id)?.set(row.problem_id, { status: 'graded', pct });
    });
  }

  if (scanIds.length && studentIds.length) {
    const r = await pool.query(
      `SELECT ss.user_id, ss.problem_id,
              SUM(q.marks) AS max_marks,
              SUM(sa.marks_awarded) AS awarded,
              BOOL_AND(sa.marks_awarded IS NOT NULL) AS fully_graded
       FROM scan_submissions ss
       JOIN scan_assignment_questions q ON q.problem_id = ss.problem_id
       LEFT JOIN scan_submission_answers sa ON sa.submission_id = ss.id AND sa.question_id = q.id
       WHERE ss.problem_id = ANY($1::int[]) AND ss.user_id = ANY($2::uuid[])
       GROUP BY ss.user_id, ss.problem_id`,
      [scanIds, studentIds]
    );
    r.rows.forEach((row) => {
      const fullyGraded = row.fully_graded === true;
      const maxMarks = Number(row.max_marks);
      const pct = fullyGraded && maxMarks > 0 ? (Number(row.awarded) / maxMarks) * 100 : null;
      byUser.get(row.user_id)?.set(row.problem_id, { status: fullyGraded ? 'graded' : 'pending_grading', pct });
    });
  }

  return { problems, byUser };
}

// Same shape as getAssignmentPerformance above, for exams. Exams already
// normalize mixed item types into one score/total_marks pair (see
// recomputeExamAttemptScore), so there's no code/scan split to handle here
// — just the submitted + fully-graded gate every other exam-result route
// already uses (see GET /api/exams/:id/result). Takes an already-resolved
// `exams` list ([{id, total_marks}, ...]) for the same reason
// getAssignmentPerformance takes a resolved `problems` list.
async function getExamPerformance(exams, studentIds) {
  const examIds = exams.map((e) => e.id);

  const byUser = new Map(studentIds.map((id) => [id, new Map()]));

  if (examIds.length && studentIds.length) {
    const r = await pool.query(
      `SELECT a.user_id, a.exam_id, a.status, a.score, e.total_marks,
              NOT EXISTS (
                SELECT 1 FROM exam_answers ea JOIN exam_items ei ON ei.id = ea.item_id
                WHERE ea.attempt_id = a.id AND ei.type IN ('short', 'long') AND ea.marks_awarded IS NULL
              ) AND NOT EXISTS (
                SELECT 1 FROM exam_scan_answers esa WHERE esa.attempt_id = a.id AND esa.marks_awarded IS NULL
              ) AS fully_graded
       FROM exam_attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.exam_id = ANY($1::int[]) AND a.user_id = ANY($2::uuid[])`,
      [examIds, studentIds]
    );
    r.rows.forEach((row) => {
      let status;
      let pct = null;
      if (row.status !== 'submitted') {
        status = 'in_progress';
      } else if (!row.fully_graded) {
        status = 'pending_grading';
      } else {
        status = 'graded';
        pct = row.total_marks > 0 ? (row.score / row.total_marks) * 100 : null;
      }
      byUser.get(row.user_id)?.set(row.exam_id, { status, pct });
    });
  }

  return { exams, byUser };
}

function averagePercent(entries) {
  const pcts = [...entries.values()].filter((v) => v.pct != null).map((v) => v.pct);
  return pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
}

// Resolves "which assignments/exams count" for the teacher dashboard: every
// problem/exam attached to one of the teacher's own subjects, regardless of
// opens_at/closes_at (a teacher managing their own class should see
// everything they've set, upcoming included — unlike the student-facing
// resolver below, which excludes upcoming items a student could never have
// acted on yet).
async function getSubjectScopedAssignmentsAndExams(organizationId, subjectIds) {
  if (subjectIds.length === 0) return { problems: [], exams: [] };
  const [problemsRes, examsRes] = await Promise.all([
    pool.query('SELECT id, submission_mode FROM problems WHERE organization_id = $1 AND subject_id = ANY($2::int[])', [organizationId, subjectIds]),
    pool.query('SELECT id, total_marks FROM exams WHERE organization_id = $1 AND subject_id = ANY($2::int[])', [organizationId, subjectIds]),
  ]);
  return { problems: problemsRes.rows, exams: examsRes.rows };
}

// Every student "under" a single subject — same cascade-down rule as
// getTeacherScope's descendant_units CTE, just seeded from one subject's
// org_unit instead of a teacher's whole assigned set. Shared by the
// gradebook and class-leaderboard routes below.
async function getStudentsForSubject(organizationId, subjectId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE descendant_units AS (
       SELECT org_unit_id AS id FROM subjects WHERE id = $1 AND organization_id = $2
       UNION
       SELECT ou.id FROM org_units ou JOIN descendant_units d ON ou.parent_unit_id = d.id
     )
     SELECT u.id, u.email, u.name
     FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2 AND m.role = 'student'
     WHERE m.org_unit_id IN (SELECT id FROM descendant_units)
     ORDER BY u.email ASC`,
    [subjectId, organizationId]
  );
  return rows;
}

// Resolves "which assignments/exams count" for one student in one org, for
// the cross-institution performance dashboard (GET /api/me/performance*
// below) — the same subject-visibility rule GET /api/problems already
// applies (subject_id NULL, or attached to the student's own unit or an
// ancestor of it, via getVisibleSubjectIds), plus excluding anything still
// 'upcoming' since a student could never have acted on those yet.
async function getStudentScopedAssignmentsAndExams(organizationId, orgUnitId) {
  const visibleSubjectIds = await getVisibleSubjectIds(orgUnitId);
  const [problemsRes, examsRes] = await Promise.all([
    pool.query(
      `SELECT id, submission_mode FROM problems
       WHERE organization_id = $1 AND (subject_id IS NULL OR subject_id = ANY($2::int[]))
         AND (opens_at IS NULL OR opens_at <= now())`,
      [organizationId, visibleSubjectIds]
    ),
    pool.query(
      `SELECT id, total_marks FROM exams
       WHERE organization_id = $1 AND (subject_id IS NULL OR subject_id = ANY($2::int[]))
         AND (opens_at IS NULL OR opens_at <= now())`,
      [organizationId, visibleSubjectIds]
    ),
  ]);
  return { problems: problemsRes.rows, exams: examsRes.rows };
}

// Same average-of-percents averagePercent already does, plus an extra flat
// array of percents blended in — used everywhere a live per-item Map
// (assignment/exam performance) needs to be combined with imported
// legacy_scores rows, which aren't tied to any real problem/exam id so
// they can't live in that Map in the first place.
function averagePercentWithExtra(entries, extra) {
  const pcts = [...entries.values()].filter((v) => v.pct != null).map((v) => v.pct);
  extra.forEach((v) => { if (v != null) pcts.push(Number(v)); });
  return pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
}

// Every student in the org, with their own visibility-scoped total
// assignment/exam percentage — computed exactly the same way one student's
// own GET /api/me/performance/:organizationId computes their own number
// (getStudentScopedAssignmentsAndExams above, blended with their own
// legacy_scores rows the same way that route does), so a student's
// percentile rank is always apples-to-apples with the individual number
// shown right next to it. Two students in the same org_unit necessarily
// share the same visible subjects (getVisibleSubjectIds depends only on
// org_unit_id), so grouping by unit lets every member of a group share one
// resolved problems/exams list instead of resolving it once per student.
async function getStudentScopedTotalsForOrg(organizationId) {
  const [studentsRes, legacyRes] = await Promise.all([
    pool.query(
      `SELECT u.id, m.org_unit_id FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE m.organization_id = $1 AND m.role = 'student'`,
      [organizationId]
    ),
    pool.query('SELECT user_id, assignment_score_percent, exam_score_percent FROM legacy_scores WHERE organization_id = $1', [organizationId]),
  ]);

  const legacyByUser = new Map();
  legacyRes.rows.forEach((row) => {
    if (!legacyByUser.has(row.user_id)) legacyByUser.set(row.user_id, { assignment: [], exam: [] });
    const bucket = legacyByUser.get(row.user_id);
    if (row.assignment_score_percent != null) bucket.assignment.push(row.assignment_score_percent);
    if (row.exam_score_percent != null) bucket.exam.push(row.exam_score_percent);
  });

  const byUnit = new Map();
  studentsRes.rows.forEach((s) => {
    const key = s.org_unit_id ?? -1;
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push(s.id);
  });

  const totals = new Map();
  for (const [key, studentIds] of byUnit) {
    const orgUnitId = key === -1 ? null : key;
    const { problems, exams } = await getStudentScopedAssignmentsAndExams(organizationId, orgUnitId);
    const [{ byUser: aByUser }, { byUser: eByUser }] = await Promise.all([
      getAssignmentPerformance(problems, studentIds),
      getExamPerformance(exams, studentIds),
    ]);
    studentIds.forEach((id) => {
      const legacy = legacyByUser.get(id) || { assignment: [], exam: [] };
      totals.set(id, {
        avgAssignmentPercent: averagePercentWithExtra(aByUser.get(id) || new Map(), legacy.assignment),
        avgExamPercent: averagePercentWithExtra(eByUser.get(id) || new Map(), legacy.exam),
      });
    });
  }
  return totals;
}

// Percentile/grade tags for one student's own avgAssignmentPercent/
// avgExamPercent within one org — gated by that org's own tag_visibility_
// settings (the same admin-configured show_percentile_tag/show_grade_tag
// flags every other percentile/grade tag in this app already respects, not
// a new per-teacher setting). Population comes from getStudentScopedTotalsForOrg
// so it's apples-to-apples with how the student's own number was computed.
async function getPercentileAndGradeTags(organizationId, myAvgAssignment, myAvgExam) {
  const result = { assignmentPercentileTag: null, examPercentileTag: null, assignmentGradeTag: null, examGradeTag: null };
  const visibility = await getTagVisibility(organizationId);
  if (!visibility.show_percentile_tag && !visibility.show_grade_tag) return result;

  if (visibility.show_percentile_tag) {
    const populationTotals = await getStudentScopedTotalsForOrg(organizationId);
    const assignmentPop = [...populationTotals.values()].map((t) => t.avgAssignmentPercent).filter((v) => v != null);
    const examPop = [...populationTotals.values()].map((t) => t.avgExamPercent).filter((v) => v != null);
    if (myAvgAssignment != null && assignmentPop.length > 1) result.assignmentPercentileTag = computePercentileTiers(assignmentPop)(myAvgAssignment).tag;
    if (myAvgExam != null && examPop.length > 1) result.examPercentileTag = computePercentileTiers(examPop)(myAvgExam).tag;
  }
  if (visibility.show_grade_tag) {
    const bandsRes = await pool.query('SELECT label, min_percent FROM grade_bands WHERE organization_id = $1', [organizationId]);
    if (myAvgAssignment != null) result.assignmentGradeTag = gradeTagForPercentage(bandsRes.rows, myAvgAssignment);
    if (myAvgExam != null) result.examGradeTag = gradeTagForPercentage(bandsRes.rows, myAvgExam);
  }
  return result;
}

// Resolves EVERY problem/exam in the org, no subject filter — the admin
// dashboard's "total score" is deliberately org-wide across every subject,
// unlike the teacher dashboard (subject_teachers-scoped) or the student
// dashboard (visibility-scoped) resolvers above.
async function getOrgWideAssignmentsAndExams(organizationId) {
  const [problemsRes, examsRes] = await Promise.all([
    pool.query('SELECT id, submission_mode FROM problems WHERE organization_id = $1', [organizationId]),
    pool.query('SELECT id, total_marks FROM exams WHERE organization_id = $1', [organizationId]),
  ]);
  return { problems: problemsRes.rows, exams: examsRes.rows };
}

// Each student's total assignment/exam score for the (simplified) admin
// dashboard — blends live platform data (getAssignmentPerformance/
// getExamPerformance, org-wide across every subject) with any imported
// legacy_scores rows for years before this platform was in use. Each
// legacy row's assignment_score_percent/exam_score_percent counts as one
// more data point in the same average a live graded assignment/exam would,
// rather than being shown as a separate number — "total score" means the
// student's whole history, not just what happened on this platform.
// Promoting a student to a new org_unit (see POST /api/admin/org-units/
// :fromUnitId/promote) never has to touch anything here: submissions,
// exam_attempts, and legacy_scores all key off user_id, not org_unit.
async function getTotalScores(organizationId, studentIds) {
  const { problems, exams } = await getOrgWideAssignmentsAndExams(organizationId);
  const [{ byUser: assignmentByUser }, { byUser: examByUser }, legacyRes] = await Promise.all([
    getAssignmentPerformance(problems, studentIds),
    getExamPerformance(exams, studentIds),
    studentIds.length
      ? pool.query('SELECT user_id, assignment_score_percent, exam_score_percent FROM legacy_scores WHERE organization_id = $1 AND user_id = ANY($2::uuid[])', [organizationId, studentIds])
      : { rows: [] },
  ]);

  const legacyByUser = new Map(studentIds.map((id) => [id, []]));
  legacyRes.rows.forEach((row) => legacyByUser.get(row.user_id)?.push(row));

  const totals = new Map();
  studentIds.forEach((id) => {
    const aPcts = [...(assignmentByUser.get(id) || new Map()).values()].filter((v) => v.pct != null).map((v) => v.pct);
    const ePcts = [...(examByUser.get(id) || new Map()).values()].filter((v) => v.pct != null).map((v) => v.pct);
    (legacyByUser.get(id) || []).forEach((row) => {
      if (row.assignment_score_percent != null) aPcts.push(Number(row.assignment_score_percent));
      if (row.exam_score_percent != null) ePcts.push(Number(row.exam_score_percent));
    });
    totals.set(id, {
      totalAssignmentPercent: aPcts.length ? aPcts.reduce((a, b) => a + b, 0) / aPcts.length : null,
      totalExamPercent: ePcts.length ? ePcts.reduce((a, b) => a + b, 0) / ePcts.length : null,
    });
  });
  return totals;
}

// Picks the highest band a percentage qualifies for, e.g. a 95% with the
// seeded default bands -> "Excellent". `bands` need not be pre-sorted.
// Returns null if no band's min_percent is low enough to match (e.g. every
// band was deleted, or the lowest remaining band's floor is above the score).
function gradeTagForPercentage(bands, pct) {
  const sorted = [...bands].sort((a, b) => Number(b.min_percent) - Number(a.min_percent));
  const match = sorted.find((b) => pct >= Number(b.min_percent));
  return match ? match.label : null;
}

// Standard mid-rank percentile: ties split the credit rather than one
// arbitrarily outranking the other. Returns a lookup function rather than
// a single value since callers need to place many students against the
// same population (once, not once per student). 5 fixed quintile tiers —
// only the grade bands above were asked to be admin-configurable.
function computePercentileTiers(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.length;
  const tierFor = (percentile) => {
    if (percentile >= 80) return 'Very Strong';
    if (percentile >= 60) return 'Strong';
    if (percentile >= 40) return 'Average';
    if (percentile >= 20) return 'Weak';
    return 'Very Weak';
  };
  return (value) => {
    if (total === 0) return { percentile: null, tag: null };
    let below = 0;
    let equal = 0;
    for (const v of sorted) {
      if (v < value) below += 1;
      else if (v === value) equal += 1;
    }
    const percentile = ((below + 0.5 * equal) / total) * 100;
    return { percentile, tag: tierFor(percentile) };
  };
}

// Per-organization on/off pair gating what students (not teachers — admin
// views never call this) get to see of their own tags. Cached: this is
// called from nearly every performance/result route in the app (a student
// loading their dashboard alone can trigger it several times over), and
// it's written by exactly one place — an admin flipping the toggle on the
// settings panel — so a 60s TTL trades a bounded, rare staleness window
// (an admin's own toggle takes up to a minute to show up elsewhere) for
// cutting a DB round trip off a very hot path.
async function getTagVisibility(organizationId) {
  return cached(`tagvis:${organizationId}`, 60, async () => {
    const res = await pool.query('SELECT show_percentile_tag, show_grade_tag FROM tag_visibility_settings WHERE organization_id = $1', [organizationId]);
    return res.rows[0] || { show_percentile_tag: true, show_grade_tag: false };
  });
}

module.exports = {
  getProblemStatus, getVisibleSubjectIds, getOrgUnitLookup, resolveOrgUnitPath,
  getTeacherScope, getTeacherScopedStudents, getAssignmentPerformance, getExamPerformance,
  averagePercent, getSubjectScopedAssignmentsAndExams, getStudentsForSubject,
  getStudentScopedAssignmentsAndExams, averagePercentWithExtra, getStudentScopedTotalsForOrg,
  getPercentileAndGradeTags, getOrgWideAssignmentsAndExams, getTotalScores,
  gradeTagForPercentage, computePercentileTiers, getTagVisibility,
};
