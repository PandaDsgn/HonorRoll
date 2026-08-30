import { useState, useEffect } from 'react';
import axios from 'axios';
import { API } from '../../config';

// ============================================================================
// GRADEBOOK — full per-student x per-item score matrix for one subject (see
// GET /api/admin/gradebook), with a class-average footer row. Works for both
// admin (any subject in the org) and teacher (their own subjects only) —
// the subject picker itself is already scoped correctly by
// GET /api/admin/subjects, same list ExamForm's subject dropdown uses.
// ============================================================================
export default function GradebookPanel() {
  const [subjects, setSubjects] = useState(null);
  const [subjectId, setSubjectId] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [leaderboardItem, setLeaderboardItem] = useState(null); // { type, itemId, title } | null

  useEffect(() => {
    axios.get(`${API}/api/admin/subjects`, { withCredentials: true })
      .then((res) => {
        setSubjects(res.data.subjects);
        if (res.data.subjects.length > 0) setSubjectId(String(res.data.subjects[0].id));
      })
      .catch(() => setError('Failed to load subjects.'));
  }, []);

  useEffect(() => {
    if (!subjectId) { setData(null); return; }
    setData(null);
    setError('');
    axios.get(`${API}/api/admin/gradebook`, { params: { subjectId }, withCredentials: true })
      .then((res) => setData(res.data))
      .catch(() => setError('Failed to load gradebook.'));
  }, [subjectId]);

  const fmtPct = (v) => (v == null ? '—' : `${Math.round(v)}%`);

  const downloadCsv = () => {
    if (!data) return;
    const headers = ['Student', 'Email', ...data.assignments.map((a) => a.title), ...data.exams.map((e) => e.title), 'Avg Assignment %', 'Avg Exam %'];
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = data.students.map((s) => [
      s.name || '',
      s.email,
      ...data.assignments.map((a) => (s.assignments[a.id]?.pct != null ? Math.round(s.assignments[a.id].pct) : '')),
      ...data.exams.map((e) => (s.exams[e.id]?.pct != null ? Math.round(s.exams[e.id].pct) : '')),
      s.avgAssignmentPercent != null ? Math.round(s.avgAssignmentPercent) : '',
      s.avgExamPercent != null ? Math.round(s.avgExamPercent) : '',
    ]);
    const classAvgRow = [
      'Class average', '',
      ...data.assignments.map((a) => (data.classAverages.assignments[a.id] != null ? Math.round(data.classAverages.assignments[a.id]) : '')),
      ...data.exams.map((e) => (data.classAverages.exams[e.id] != null ? Math.round(data.classAverages.exams[e.id]) : '')),
      data.classAverages.overallAssignment != null ? Math.round(data.classAverages.overallAssignment) : '',
      data.classAverages.overallExam != null ? Math.round(data.classAverages.overallExam) : '',
    ];
    const csv = [headers, ...rows, classAvgRow].map((r) => r.map(escape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gradebook-${data.subject.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Gradebook</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {subjects && subjects.length > 0 && (
            <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>{s.name} — {s.org_unit_name}</option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={downloadCsv} disabled={!data || data.students.length === 0}>
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>}
      {!error && subjects && subjects.length === 0 && (
        <p className="sb-loading">No subjects available yet — ask an admin to set one up under Structure → Subjects.</p>
      )}
      {!error && subjects && subjects.length > 0 && !data && <p className="sb-loading">Loading gradebook…</p>}
      {!error && data && data.students.length > 0 && (data.assignments.length > 0 || data.exams.length > 0) && (
        <p className="auth-sub" style={{ margin: '0 0 10px' }}>Click a column header to see that item's ranked leaderboard.</p>
      )}

      {leaderboardItem && (
        <LeaderboardModal
          type={leaderboardItem.type}
          itemId={leaderboardItem.itemId}
          title={leaderboardItem.title}
          onClose={() => setLeaderboardItem(null)}
        />
      )}

      {data && (
        data.students.length === 0 ? (
          <p className="sb-loading">No students found under this subject yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Student</th>
                  {data.assignments.map((a) => (
                    <th key={`a-${a.id}`}>
                      <button type="button" className="admin-th-sortable" style={{ background: 'none', border: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: 0 }} onClick={() => setLeaderboardItem({ type: 'assignment', itemId: a.id, title: a.title })} title="View leaderboard">
                        {a.title}
                      </button>
                    </th>
                  ))}
                  {data.exams.map((e) => (
                    <th key={`e-${e.id}`}>
                      <button type="button" className="admin-th-sortable" style={{ background: 'none', border: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: 0 }} onClick={() => setLeaderboardItem({ type: 'exam', itemId: e.id, title: e.title })} title="View leaderboard">
                        {e.title}
                      </button>
                    </th>
                  ))}
                  <th>Avg Assignment</th>
                  <th>Avg Exam</th>
                </tr>
              </thead>
              <tbody>
                {data.students.map((s) => (
                  <tr key={s.id}>
                    <td className="admin-cell-strong">
                      {s.name || s.email}
                      {s.name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{s.email}</div>}
                    </td>
                    {data.assignments.map((a) => {
                      const cell = s.assignments[a.id];
                      return (
                        <td key={`a-${a.id}`}>
                          {cell.status === 'not_submitted' ? '—' : cell.status === 'pending_grading' ? <span className="chip chip-medium"><span className="dot" />grading</span> : fmtPct(cell.pct)}
                        </td>
                      );
                    })}
                    {data.exams.map((e) => {
                      const cell = s.exams[e.id];
                      return (
                        <td key={`e-${e.id}`}>
                          {cell.status === 'not_submitted' ? '—' : cell.status === 'in_progress' ? <span className="chip chip-medium"><span className="dot" />in progress</span> : cell.status === 'pending_grading' ? <span className="chip chip-medium"><span className="dot" />grading</span> : fmtPct(cell.pct)}
                        </td>
                      );
                    })}
                    <td>{fmtPct(s.avgAssignmentPercent)}</td>
                    <td>{fmtPct(s.avgExamPercent)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 600 }}>
                  <td>Class average</td>
                  {data.assignments.map((a) => <td key={`a-${a.id}`}>{fmtPct(data.classAverages.assignments[a.id])}</td>)}
                  {data.exams.map((e) => <td key={`e-${e.id}`}>{fmtPct(data.classAverages.exams[e.id])}</td>)}
                  <td>{fmtPct(data.classAverages.overallAssignment)}</td>
                  <td>{fmtPct(data.classAverages.overallExam)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// Ranked class view for one exam/assignment (GET /api/admin/leaderboard),
// opened by clicking a Gradebook column header. Simple fixed-overlay dialog
// — there's no shared Modal component elsewhere in this codebase yet, so
// this stays self-contained rather than introducing one for a single use.
function LeaderboardModal({ type, itemId, title, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    setError('');
    axios.get(`${API}/api/admin/leaderboard`, { params: { type, itemId }, withCredentials: true })
      .then((res) => setData(res.data))
      .catch(() => setError('Failed to load leaderboard.'));
  }, [type, itemId]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={onClose}
    >
      <div
        className="panel"
        style={{ maxWidth: 520, width: '100%', maxHeight: '80vh', overflowY: 'auto', padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>{title}</h3>
            <p className="auth-sub" style={{ margin: '2px 0 0' }}>Leaderboard</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>

        {error && <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>}
        {!error && !data && <p className="sb-loading">Loading…</p>}

        {data && (
          data.ranked.length === 0 ? (
            <p className="sb-loading">No graded scores yet.</p>
          ) : (
            <>
              <p className="auth-sub" style={{ margin: '0 0 12px' }}>
                Class average: {data.classAverage != null ? `${Math.round(data.classAverage)}%` : '—'} across {data.ranked.length} graded student{data.ranked.length === 1 ? '' : 's'}
                {data.ungraded.length > 0 && ` (${data.ungraded.length} not yet graded/submitted)`}
              </p>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Student</th>
                    <th>Score</th>
                    <th>Percentile</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ranked.map((r) => (
                    <tr key={r.id}>
                      <td>{r.rank}</td>
                      <td className="admin-cell-strong">{r.name || r.email}</td>
                      <td>{Math.round(r.pct)}%</td>
                      <td>{r.tag ? <span className="chip chip-neutral"><span className="dot" />{r.tag}</span> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        )}
      </div>
    </div>
  );
}
