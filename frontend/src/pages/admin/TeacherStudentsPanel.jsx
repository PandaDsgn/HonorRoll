import { useState, useEffect, useMemo, Fragment } from 'react';
import axios from 'axios';
import PercentBar from '../../components/PercentBar';
import { PERF_STATUS_LABELS, PERF_STATUS_CLASS } from '../../lib/performanceStatus';
import { API } from '../../config';

const TEACHER_STUDENT_SORT_COLUMNS = [
  { key: 'name', label: 'Student', numeric: false },
  { key: 'assignmentsSubmitted', label: 'Assignments submitted', numeric: true },
  { key: 'avgAssignmentPercent', label: 'Assignment score', numeric: true },
  { key: 'examsAttempted', label: 'Exams attempted', numeric: true },
  { key: 'avgExamPercent', label: 'Exam score', numeric: true },
];

// ============================================================================
// TEACHER STUDENTS PANEL — every student under the subjects this teacher is
// assigned to (see GET /api/teacher/students), with a rolled-up assignment/
// exam performance percentage per student, computed only from that
// teacher's own subjects (not an org-wide figure). Row click drills into
// TeacherStudentDetailPanel below. Sortable columns + a "no submissions
// yet" filter stand in for what used to be a separate Non-submitters tab —
// sorting Assignments/Exams submitted ascending surfaces the exact same
// people, without a whole extra tab + route for it.
// ============================================================================
export function TeacherStudentsPanel({ onSelectStudent }) {
  const [students, setStudents] = useState(null);
  const [subjectCount, setSubjectCount] = useState(0);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [onlyNonSubmitters, setOnlyNonSubmitters] = useState(false);

  useEffect(() => {
    axios.get(`${API}/api/teacher/students`, { withCredentials: true })
      .then((res) => { setStudents(res.data.students); setSubjectCount(res.data.subjectCount); })
      .catch(() => setError('Failed to load students.'));
  }, []);

  const handleSort = (col) => {
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir(col.numeric ? 'desc' : 'asc');
    }
  };

  const visibleStudents = useMemo(() => {
    if (!students) return null;
    const filtered = onlyNonSubmitters
      ? students.filter((s) => s.assignmentsSubmitted === 0 && s.examsAttempted === 0)
      : students;
    const dir = sortDir === 'asc' ? 1 : -1;
    const col = TEACHER_STUDENT_SORT_COLUMNS.find((c) => c.key === sortKey);
    return [...filtered].sort((a, b) => {
      if (!col?.numeric) {
        const av = a.name || a.email;
        const bv = b.name || b.email;
        return dir * String(av || '').localeCompare(String(bv || ''));
      }
      return dir * ((a[sortKey] ?? -1) - (b[sortKey] ?? -1));
    });
  }, [students, sortKey, sortDir, onlyNonSubmitters]);

  if (error) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!students) return <p className="sb-loading">Loading…</p>;

  return (
    <div className="panel" style={{ padding: 20 }}>
      <h3 style={{ margin: '0 0 4px' }}>My students</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Everyone under the subjects you're assigned to, with their performance on your own assignments and exams.
      </p>
      {subjectCount === 0 ? (
        <p className="sb-loading">You aren't assigned to any subjects yet — ask an admin to add you under Structure → Subjects.</p>
      ) : students.length === 0 ? (
        <p className="sb-loading">No students found under your subjects yet.</p>
      ) : (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13.5 }}>
            <input type="checkbox" checked={onlyNonSubmitters} onChange={(e) => setOnlyNonSubmitters(e.target.checked)} />
            Show only students with zero submissions and zero exam attempts
          </label>
          {visibleStudents.length === 0 ? (
            <p className="sb-loading">Nobody matches — every student in your classes has submitted something.</p>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    {TEACHER_STUDENT_SORT_COLUMNS.map((col, i) => (
                      <Fragment key={col.key}>
                        <th
                          className="admin-th-sortable"
                          aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                          onClick={() => handleSort(col)}
                        >
                          {col.label}
                          <span className="admin-th-sort-arrow">{sortKey === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                        </th>
                        {i === 0 && <th>Unit</th>}
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleStudents.map((s) => (
                    <tr key={s.id} onClick={() => onSelectStudent(s.id)} style={{ cursor: 'pointer' }}>
                      <td className="admin-cell-strong">
                        {s.name || s.email}
                        {s.name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{s.email}</div>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)', fontSize: '12.5px' }}>
                        {s.unit_path?.length ? s.unit_path.map((p) => p.name).join(' / ') : '—'}
                      </td>
                      <td>{s.assignmentsSubmitted}/{s.assignmentsTotal}</td>
                      <td style={{ minWidth: 170 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <PercentBar percent={s.avgAssignmentPercent} />
                          <span style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                            {s.avgAssignmentPercent != null ? `${s.avgAssignmentPercent.toFixed(0)}%` : '—'}
                          </span>
                        </div>
                      </td>
                      <td>{s.examsAttempted}/{s.examsTotal}</td>
                      <td style={{ minWidth: 170 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <PercentBar percent={s.avgExamPercent} />
                          <span style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                            {s.avgExamPercent != null ? `${s.avgExamPercent.toFixed(0)}%` : '—'}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================================
// TEACHER STUDENT DETAIL PANEL — one student's assignments/exams, scoped to
// the teacher's own subjects only (see GET /api/teacher/students/:id).
// ============================================================================
export function TeacherStudentDetailPanel({ studentId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get(`${API}/api/teacher/students/${studentId}`, { withCredentials: true })
      .then((res) => setData(res.data))
      .catch(() => setError('Failed to load student details.'));
  }, [studentId]);

  if (error) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!data) return <p className="sb-loading">Loading student…</p>;

  return (
    <div>
      <div className="admin-toolbar" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn-ghost" onClick={onBack}>&larr; Back to my students</button>
      </div>

      <div className="panel" style={{ padding: '24px', marginBottom: '24px' }}>
        <h2 style={{ margin: 0 }}>{data.student.name || data.student.email}</h2>
        {data.student.name && <p className="auth-sub" style={{ margin: '4px 0 0' }}>{data.student.email}</p>}
        {data.unitPath?.length > 0 && (
          <p style={{ margin: '10px 0 0', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {data.unitPath.map((p, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {i > 0 && <span style={{ color: 'var(--text-dim)' }}>/</span>}
                <span className="chip chip-easy" title={p.label}><span className="dot" />{p.name}</span>
              </span>
            ))}
          </p>
        )}
        <div style={{ display: 'flex', gap: 24, marginTop: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200 }}>
            <div className="field-group-label" style={{ marginBottom: 6 }}>Assignments (your subjects)</div>
            <PercentBar percent={data.avgAssignmentPercent} />
            <p className="auth-sub" style={{ margin: '6px 0 0' }}>
              {data.avgAssignmentPercent != null ? `${data.avgAssignmentPercent.toFixed(1)}% average` : 'No graded assignments yet'}
              {data.assignmentPercentileTag && ` — ${data.assignmentPercentileTag} among your students`}
            </p>
          </div>
          <div style={{ minWidth: 200 }}>
            <div className="field-group-label" style={{ marginBottom: 6 }}>Exams (your subjects)</div>
            <PercentBar percent={data.avgExamPercent} />
            <p className="auth-sub" style={{ margin: '6px 0 0' }}>
              {data.avgExamPercent != null ? `${data.avgExamPercent.toFixed(1)}% average` : 'No graded exams yet'}
              {data.examPercentileTag && ` — ${data.examPercentileTag} among your students`}
            </p>
          </div>
        </div>
      </div>

      <h3 style={{ marginBottom: 16 }}>Assignments</h3>
      {data.assignments.length === 0 ? (
        <p className="sb-loading" style={{ marginBottom: 24 }}>You have no assignments under your subjects yet.</p>
      ) : (
        <div className="submission-history" style={{ marginBottom: 24 }}>
          {data.assignments.map((a) => (
            <div className="submission-card" key={a.problemId}>
              <div className="submission-card-head">
                <span>{a.title}{a.subjectName && <span className="auth-sub"> — {a.subjectName}</span>}</span>
                <span className={`chip ${PERF_STATUS_CLASS[a.status]}`}><span className="dot" />{PERF_STATUS_LABELS[a.status]}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <PercentBar percent={a.percent} />
                {a.percent != null && <span className="auth-sub">{a.percent.toFixed(1)}%</span>}
              </div>
              {a.remarks && <p className="auth-sub" style={{ margin: '8px 0 0' }}>Remarks: {a.remarks}</p>}
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginBottom: 16 }}>Exams</h3>
      {data.exams.length === 0 ? (
        <p className="sb-loading">You have no exams under your subjects yet.</p>
      ) : (
        <div className="submission-history">
          {data.exams.map((e) => (
            <div className="submission-card" key={e.examId}>
              <div className="submission-card-head">
                <span>{e.title}{e.subjectName && <span className="auth-sub"> — {e.subjectName}</span>}</span>
                <span className={`chip ${PERF_STATUS_CLASS[e.status]}`}><span className="dot" />{PERF_STATUS_LABELS[e.status]}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <PercentBar percent={e.percent} />
                {e.percent != null && <span className="auth-sub">{e.percent.toFixed(1)}%</span>}
              </div>
              {e.remarks && <p className="auth-sub" style={{ margin: '8px 0 0' }}>Remarks: {e.remarks}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
