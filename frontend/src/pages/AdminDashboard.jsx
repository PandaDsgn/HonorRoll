import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher from '../components/SpaceSwitcher';
import AssignmentForm from '../components/AssignmentForm';
import ExamForm from '../components/ExamForm';
import OrgStructureBuilder from '../components/OrgStructureBuilder';
import SubjectsPanel from '../components/SubjectsPanel';
import TeacherUploadsPanel from '../components/TeacherUploadsPanel';
import AdminNoticesPanel from '../components/AdminNoticesPanel';
import BillingPanel from '../components/BillingPanel';
import PercentBar from '../components/PercentBar';
import { PERF_STATUS_LABELS, PERF_STATUS_CLASS } from '../lib/performanceStatus';
import { API } from '../config';
import '../admin.css';
const DIFFICULTY_CLASS = { Easy: 'chip-easy', Medium: 'chip-medium', Hard: 'chip-hard' };
const STATUS_CLASS = { open: 'chip-easy', upcoming: 'chip-medium', closed: 'chip-hard' };

// timeZoneName is spelled out (not just dateStyle/timeStyle) so a browser
// whose effective timezone silently isn't the viewer's own (a stale
// DevTools Sensors override, a misconfigured OS) shows up as visibly wrong
// ("... UTC") instead of a quietly-mis-converted number that looks plausible.
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// Turns accumulated time-on-task seconds into a compact "2h 14m" / "45m" /
// "30s" string for the students table.
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const { logout, user } = useAuth();
  const [tab, setTab] = useState('students');
  const [selectedStudentId, setSelectedStudentId] = useState(null);
  const [selectedMyStudentId, setSelectedMyStudentId] = useState(null);

  // 'students' (StudentsPanel/StudentDetailPanel below) hits admin-only
  // routes — a teacher landing here on the default tab would just see a
  // 403. Bounce them to their own scoped tab once `user` has loaded.
  useEffect(() => {
    if (user?.role === 'teacher' && tab === 'students') setTab('my-students');
  }, [user?.role, tab]);

  // Bumped whenever OrgStructureBuilder changes units/levels, so the
  // sibling panels below it (which each keep their own unit-picker copy)
  // know to refetch instead of showing a newly-added unit only after a
  // full page reload.
  const [unitsVersion, setUnitsVersion] = useState(0);

  const handleLogout = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="admin" />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button type="button" className="btn btn-ghost" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <div>
            <h1 className="problems-title" style={{ marginBottom: 4 }}>
              {user?.role === 'teacher' ? 'Teacher Dashboard' : 'Admin Dashboard'}
            </h1>
            {user?.name && <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-h)' }}>{user.name}</div>}
            {user?.organization_name && <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 2 }}>{user.organization_name}</div>}
          </div>
          <div className="segmented" role="tablist" aria-label="Admin section">
            {user?.role === 'admin' && (
              <button type="button" role="tab" aria-pressed={tab === 'students'} className={tab === 'students' ? 'active' : ''} onClick={() => { setTab('students'); setSelectedStudentId(null); }}>
                Students
              </button>
            )}
            {user?.role === 'teacher' && (
              <button type="button" role="tab" aria-pressed={tab === 'my-students'} className={tab === 'my-students' ? 'active' : ''} onClick={() => { setTab('my-students'); setSelectedMyStudentId(null); }}>
                My Students
              </button>
            )}
            {user?.role === 'teacher' && (
              <button type="button" role="tab" aria-pressed={tab === 'assignments'} className={tab === 'assignments' ? 'active' : ''} onClick={() => setTab('assignments')}>
                Assignments
              </button>
            )}
            <button type="button" role="tab" aria-pressed={tab === 'exams'} className={tab === 'exams' ? 'active' : ''} onClick={() => setTab('exams')}>
              Exams
            </button>
            <button type="button" role="tab" aria-pressed={tab === 'gradebook'} className={tab === 'gradebook' ? 'active' : ''} onClick={() => setTab('gradebook')}>
              Gradebook
            </button>
            {user?.role === 'teacher' && (
              <button type="button" role="tab" aria-pressed={tab === 'uploads'} className={tab === 'uploads' ? 'active' : ''} onClick={() => setTab('uploads')}>
                Uploads
              </button>
            )}
            {user?.role === 'admin' && (
              <button type="button" role="tab" aria-pressed={tab === 'notices'} className={tab === 'notices' ? 'active' : ''} onClick={() => setTab('notices')}>
                Notices
              </button>
            )}
            {user?.role === 'admin' && (
              <button type="button" role="tab" aria-pressed={tab === 'grade-scale'} className={tab === 'grade-scale' ? 'active' : ''} onClick={() => setTab('grade-scale')}>
                Grading
              </button>
            )}
            {user?.role === 'admin' && (
              <button type="button" role="tab" aria-pressed={tab === 'structure'} className={tab === 'structure' ? 'active' : ''} onClick={() => setTab('structure')}>
                Structure
              </button>
            )}
            {user?.role === 'admin' && (
              <button type="button" role="tab" aria-pressed={tab === 'billing'} className={tab === 'billing' ? 'active' : ''} onClick={() => setTab('billing')}>
                Billing
              </button>
            )}
            {user?.role === 'admin' && (
              <button type="button" role="tab" aria-pressed={tab === 'contact-superadmin'} className={tab === 'contact-superadmin' ? 'active' : ''} onClick={() => setTab('contact-superadmin')}>
                Contact Superadmin
              </button>
            )}
          </div>
        </div>

        {tab === 'students' ? (
          user?.role === 'admin' ? (
            selectedStudentId ? (
              <StudentDetailPanel studentId={selectedStudentId} onBack={() => setSelectedStudentId(null)} />
            ) : (
              <StudentsPanel onSelectStudent={setSelectedStudentId} />
            )
          ) : null
        ) : tab === 'my-students' ? (
          user?.role === 'teacher' ? (
            selectedMyStudentId ? (
              <TeacherStudentDetailPanel studentId={selectedMyStudentId} onBack={() => setSelectedMyStudentId(null)} />
            ) : (
              <TeacherStudentsPanel onSelectStudent={setSelectedMyStudentId} />
            )
          ) : null
        ) : tab === 'assignments' ? (
          user?.role === 'teacher' ? <AssignmentsPanel /> : null
        ) : tab === 'exams' ? (
          <ExamsPanel />
        ) : tab === 'gradebook' ? (
          <GradebookPanel />
        ) : tab === 'uploads' ? (
          user?.role === 'teacher' ? <TeacherUploadsPanel /> : null
        ) : tab === 'notices' ? (
          user?.role === 'admin' ? <AdminNoticesPanel /> : null
        ) : tab === 'structure' ? (
          user?.role === 'admin' ? (
            <>
              <OrgStructureBuilder onChange={() => setUnitsVersion((v) => v + 1)} />
              <SubjectsPanel refreshSignal={unitsVersion} />
              <TeachersPanel refreshSignal={unitsVersion} />
              <PromoteStudentsPanel refreshSignal={unitsVersion} />
            </>
          ) : null
        ) : tab === 'billing' ? (
          user?.role === 'admin' ? <BillingPanel /> : null
        ) : tab === 'contact-superadmin' ? (
          user?.role === 'admin' ? (
            <>
              <RequestAddAdminPanel />
              <AdminRequestsPanel />
            </>
          ) : null
        ) : tab === 'grade-scale' ? (
          // Every panel here is an org-wide policy call (which tags students
          // see, the grade-band cutoffs, the plagiarism-similarity
          // threshold), same posture as Structure/Billing above — not
          // something a teacher sets, and their own backend routes are all
          // requireAdmin, so rendering this for a teacher was always going
          // to 403. The tab button itself is admin-only for the same reason
          // (see the segmented control above); this check is just the
          // belt-and-braces backstop.
          user?.role === 'admin' ? (
            <>
              <IntegrationsPanel />
              <TagVisibilityPanel />
              <GradeBandsPanel />
              <ScanPlagiarismThresholdPanel />
              <CodePlagiarismThresholdPanel />
            </>
          ) : null
        ) : null}
      </section>
    </div>
  );
}

// ============================================================================
// GRADEBOOK — full per-student x per-item score matrix for one subject (see
// GET /api/admin/gradebook), with a class-average footer row. Works for both
// admin (any subject in the org) and teacher (their own subjects only) —
// the subject picker itself is already scoped correctly by
// GET /api/admin/subjects, same list ExamForm's subject dropdown uses.
// ============================================================================
function GradebookPanel() {
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
function TeacherStudentsPanel({ onSelectStudent }) {
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
function TeacherStudentDetailPanel({ studentId, onBack }) {
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

// ============================================================================
// STUDENT DETAIL PANEL — identity + the two total scores only (see
// GET /api/admin/students/:id's own comment on why the attempt-by-attempt
// history and percentile tags were dropped).
// ============================================================================
function StudentDetailPanel({ studentId, onBack }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  // Admin-only edit — teachers never see this toggle at all (requireAdmin
  // on the backend route enforces the same boundary, this is just the UI
  // side of it). Pre-filled from `data` once it loads, so the fields
  // aren't editable before the real values are known.
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editUnitId, setEditUnitId] = useState('');
  const [editRoll, setEditRoll] = useState('');
  const [units, setUnits] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    const fetchStudent = async () => {
      try {
        const res = await axios.get(`${API}/api/admin/students/${studentId}`, { withCredentials: true });
        setData(res.data);
      } catch {
        setError('Failed to load student details.');
      }
    };
    fetchStudent();
  }, [studentId]);

  // Separate from the mount-effect fetch above (rather than a single
  // useCallback shared by both) — feeding a hoisted, dependency-tracked
  // callback back into a useEffect's own dependency array is exactly the
  // shape react-hooks/set-state-in-effect flags as a potential cascading-
  // render risk. This copy is only ever called imperatively from an event
  // handler (after a save), never from an effect, so that rule doesn't apply.
  const refetchStudent = async () => {
    try {
      const res = await axios.get(`${API}/api/admin/students/${studentId}`, { withCredentials: true });
      setData(res.data);
    } catch {
      setError('Failed to load student details.');
    }
  };

  useEffect(() => {
    if (user?.role !== 'admin') return;
    axios.get(`${API}/api/admin/org-units`, { withCredentials: true })
      .then((res) => setUnits(res.data.units.map((u) => ({ ...u, level: res.data.levels.find((l) => l.id === u.level_def_id) }))))
      .catch(() => {});
  }, [user]);

  const startEditing = () => {
    setEditName(data.student.name || '');
    setEditUnitId(data.student.org_unit_id != null ? String(data.student.org_unit_id) : '');
    setEditRoll(data.student.roll_number || '');
    setSaveError('');
    setEditing(true);
  };

  const saveEdits = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await axios.put(`${API}/api/admin/students/${studentId}`, {
        name: editName.trim() || null,
        orgUnitId: editUnitId || null,
        rollNumber: editRoll.trim() || null,
      }, { withCredentials: true });
      setEditing(false);
      await refetchStudent();
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Failed to save changes.');
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!data) return <p className="sb-loading">Loading student history…</p>;

  return (
    <div>
      <div className="admin-toolbar" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn-ghost" onClick={onBack}>&larr; Back to all students</button>
      </div>

      <div className="panel" style={{ padding: '24px', marginBottom: '24px' }}>
        {editing ? (
          <div style={{ maxWidth: 420 }}>
            <div className="field" style={{ marginBottom: 10 }}>
              <label htmlFor="edit-student-name">Name</label>
              <input id="edit-student-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label htmlFor="edit-student-unit">Unit</label>
              <select id="edit-student-unit" value={editUnitId} onChange={(e) => setEditUnitId(e.target.value)}>
                <option value="">No unit</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.level?.label})</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 12 }}>
              <label htmlFor="edit-student-roll">Roll number</label>
              <input id="edit-student-roll" value={editRoll} onChange={(e) => setEditRoll(e.target.value)} />
            </div>
            {saveError && <div className="alert" style={{ marginBottom: 12 }}><span className="alert-icon">!</span><span>{saveError}</span></div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={saveEdits}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <h2 style={{ margin: 0 }}>{data.student.name || data.student.email}</h2>
                {data.student.name && <p className="auth-sub" style={{ margin: '4px 0 0' }}>{data.student.email}</p>}
              </div>
              {user?.role === 'admin' && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={startEditing}>Edit</button>
              )}
            </div>
            <p className="auth-sub" style={{ margin: '8px 0 0' }}>Joined {formatDate(data.student.created_at)}</p>
            {data.student.roll_number && (
              <p className="auth-sub" style={{ margin: '4px 0 0' }}>Roll number: {data.student.roll_number}</p>
            )}
            {data.unitPath?.length > 0 ? (
              <p style={{ margin: '10px 0 0', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {data.unitPath.map((p, i) => (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {i > 0 && <span style={{ color: 'var(--text-dim)' }}>/</span>}
                    <span className="chip chip-easy" title={p.label}><span className="dot" />{p.name}</span>
                  </span>
                ))}
              </p>
            ) : (
              <p className="auth-sub" style={{ margin: '6px 0 0' }}>Not assigned to a unit in your organization structure.</p>
            )}
          </>
        )}
      </div>

      <div className="panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200 }}>
            <div className="field-group-label" style={{ marginBottom: 6 }}>Total assignment score</div>
            <PercentBar percent={data.totalAssignmentPercent} />
            <p className="auth-sub" style={{ margin: '6px 0 0' }}>
              {data.totalAssignmentPercent != null ? `${data.totalAssignmentPercent.toFixed(1)}%` : 'No graded assignments yet'}
            </p>
          </div>
          <div style={{ minWidth: 200 }}>
            <div className="field-group-label" style={{ marginBottom: 6 }}>Total exam score</div>
            <PercentBar percent={data.totalExamPercent} />
            <p className="auth-sub" style={{ margin: '6px 0 0' }}>
              {data.totalExamPercent != null ? `${data.totalExamPercent.toFixed(1)}%` : 'No graded exams yet'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// STUDENTS PANEL
// ============================================================================
// Sortable columns on the students table — deliberately just the two
// headline scores plus name (see GET /api/admin/students' own comment on
// why the old attempt-count/time-on-task/efficiency-score columns were
// dropped). `numeric: false` (email) sorts alphabetically and defaults to
// ascending; the two score columns default to descending on first click.
const STUDENT_SORT_COLUMNS = [
  { key: 'email', label: 'Student', numeric: false },
  { key: 'totalAssignmentPercent', label: 'Assignment score', numeric: true },
  { key: 'totalExamPercent', label: 'Exam score', numeric: true },
];

function StudentsPanel({ onSelectStudent }) {
  const [students, setStudents] = useState(null);
  const [error, setError] = useState('');
  const [confirmingId, setConfirmingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [sortKey, setSortKey] = useState('email');
  const [sortDir, setSortDir] = useState('asc');

  // Manual "add one student" — the counterpart to the Google Form webhook
  // for institutions that don't use one, or just want to add a stray
  // account. orgUnitId is optional (nullable on the backend) so this still
  // works for an org that hasn't built out its structure yet.
  const [units, setUnits] = useState([]);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newUnitId, setNewUnitId] = useState('');
  const [addResult, setAddResult] = useState('');
  const [addError, setAddError] = useState('');
  const [adding, setAdding] = useState(false);

  // Plan/cap status — refetched after anything that adds students, so the
  // "you're at your limit" banner and disabled controls stay accurate
  // without a full page reload.
  const [billing, setBilling] = useState(null);
  const fetchBilling = useCallback(() => {
    axios.get(`${API}/api/admin/billing/status`, { withCredentials: true })
      .then((res) => setBilling(res.data))
      .catch(() => {});
  }, []);
  useEffect(() => { fetchBilling(); }, [fetchBilling]);
  const atCap = billing && billing.currentStudentCount >= billing.studentCap;

  useEffect(() => {
    axios.get(`${API}/api/admin/org-units`, { withCredentials: true })
      .then((res) => setUnits(res.data.units.map((u) => ({ ...u, level: res.data.levels.find((l) => l.id === u.level_def_id) }))))
      .catch(() => {});
  }, []);

  const addStudent = async (e) => {
    e.preventDefault();
    setAddError('');
    setAddResult('');
    setAdding(true);
    try {
      const res = await axios.post(`${API}/api/admin/create-student`, {
        email: newEmail.trim(),
        name: newName.trim() || null,
        orgUnitId: newUnitId || null,
      }, { withCredentials: true });
      setAddResult(res.data.temporaryPassword
        ? `Created. Temporary password: ${res.data.temporaryPassword}`
        : res.data.message);
      setNewName('');
      setNewEmail('');
      setNewUnitId('');
      fetchStudents();
      fetchBilling();
    } catch (err) {
      setAddError(err.response?.data?.error || 'Failed to add student.');
    } finally {
      setAdding(false);
    }
  };

  // Bulk roster upload — the manual/CSV counterpart to the Google Form
  // webhook. Column headers must match the org's tier labels exactly (the
  // template download guarantees that), so results.errors can name exactly
  // which row/reason failed without the admin having to guess.
  const [csvFile, setCsvFile] = useState(null);
  const [csvResult, setCsvResult] = useState(null);
  const [csvError, setCsvError] = useState('');
  const [csvImporting, setCsvImporting] = useState(false);

  // A plain <a href> wouldn't carry the Authorization header (axios attaches
  // that only to requests it issues itself, not raw browser navigation), so
  // the template has to be fetched as a blob and downloaded client-side.
  const downloadCsvTemplate = async () => {
    try {
      const res = await axios.get(`${API}/api/admin/students/csv-template`, { withCredentials: true, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'student-import-template.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setCsvError('Failed to download template.');
    }
  };

  const importCsv = async () => {
    if (!csvFile) return;
    setCsvError('');
    setCsvResult(null);
    setCsvImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', csvFile);
      const res = await axios.post(`${API}/api/admin/students/csv-import`, formData, { withCredentials: true });
      setCsvResult(res.data);
      setCsvFile(null);
      fetchStudents();
      fetchBilling();
    } catch (err) {
      setCsvError(err.response?.data?.error || 'Failed to import CSV.');
    } finally {
      setCsvImporting(false);
    }
  };

  const fetchStudents = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/admin/students`, { withCredentials: true });
      setStudents(res.data.students);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load students.');
    }
  }, []);

  useEffect(() => { fetchStudents(); }, [fetchStudents]);

  const handleRemove = async (id) => {
    setBusyId(id);
    try {
      await axios.delete(`${API}/api/admin/students/${id}`, { withCredentials: true });
      setStudents((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError('Failed to remove student.');
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  };

  const handleSort = (col) => {
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir(col.numeric ? 'desc' : 'asc');
    }
  };

  const sortedStudents = useMemo(() => {
    if (!students) return null;
    const dir = sortDir === 'asc' ? 1 : -1;
    const col = STUDENT_SORT_COLUMNS.find((c) => c.key === sortKey);
    return [...students].sort((a, b) => {
      if (!col?.numeric) {
        return dir * String(a[sortKey] || '').localeCompare(String(b[sortKey] || ''));
      }
      const av = col.isDate ? (a[sortKey] ? new Date(a[sortKey]).getTime() : 0) : (a[sortKey] ?? 0);
      const bv = col.isDate ? (b[sortKey] ? new Date(b[sortKey]).getTime() : 0) : (b[sortKey] ?? 0);
      return dir * (av - bv);
    });
  }, [students, sortKey, sortDir]);

  if (error) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;

  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
        <div className="field-group-label" style={{ marginBottom: 10 }}>Add a student manually</div>
        {atCap && (
          <div className="alert" style={{ marginBottom: 12 }}>
            <span className="alert-icon">!</span>
            <span>
              You've reached your {billing.effectivePlanKey} plan's {billing.studentCap}-student limit — remove a
              student or upgrade in the Billing tab to add more.
            </span>
          </div>
        )}
        {addError && <div className="alert" style={{ marginBottom: 12 }}><span className="alert-icon">!</span><span>{addError}</span></div>}
        {addResult && <div className="alert alert-success" style={{ marginBottom: 12 }}><span className="alert-icon">✓</span><span>{addResult}</span></div>}
        <form className="testcase-row" style={{ maxWidth: 560, marginBottom: 0 }} onSubmit={addStudent}>
          <input type="text" placeholder="Full name (optional)" value={newName} onChange={(e) => setNewName(e.target.value)} disabled={atCap} />
          <input type="email" placeholder="student@school.edu" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required disabled={atCap} />
          <select value={newUnitId} onChange={(e) => setNewUnitId(e.target.value)} style={{ minWidth: 180 }} disabled={atCap}>
            <option value="">No unit (optional)</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>{u.name} ({u.level?.label})</option>
            ))}
          </select>
          <button type="submit" className="btn btn-primary btn-sm" disabled={adding || !newEmail.trim() || atCap}>
            {adding ? 'Adding…' : 'Add student'}
          </button>
        </form>
      </div>

      <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
        <div className="field-group-label" style={{ marginBottom: 10 }}>Bulk import from CSV</div>
        <p className="auth-sub" style={{ margin: '0 0 10px' }}>
          Upload a CSV where every column except Name/Email is a tier of your structure — e.g. Campus, Department, Year — in that
          left-to-right order. The structure builds itself from your columns; nothing needs to be set up first.
        </p>
        {atCap && (
          <div className="alert" style={{ marginBottom: 12 }}>
            <span className="alert-icon">!</span>
            <span>
              You've reached your {billing.effectivePlanKey} plan's {billing.studentCap}-student limit — remove students
              or upgrade in the Billing tab before importing more.
            </span>
          </div>
        )}
        {csvError && <div className="alert" style={{ marginBottom: 12 }}><span className="alert-icon">!</span><span>{csvError}</span></div>}
        {csvResult && (
          <div className={csvResult.errors.length ? 'alert' : 'alert alert-success'} style={{ marginBottom: 12, flexDirection: 'column', alignItems: 'stretch' }}>
            <span>
              {csvResult.created} created, {csvResult.existingAdded} existing account(s) added, {csvResult.skipped} already members
              {csvResult.errors.length > 0 && `, ${csvResult.errors.length} row(s) failed`}
            </span>
            {csvResult.errors.some((e) => e.reason.startsWith('Plan cap reached')) && (
              <span style={{ marginTop: 6, fontSize: 12.5 }}>
                Some rows couldn't be imported because your plan is full — remove students or upgrade to import the rest.
              </span>
            )}
            {csvResult.unitsCreated?.length > 0 && (
              <span style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text-dim)' }}>
                New units created: {csvResult.unitsCreated.join(', ')}
              </span>
            )}
            {csvResult.errors.length > 0 && (
              <table className="admin-table" style={{ marginTop: 10 }}>
                <thead><tr><th>Row</th><th>Email</th><th>Reason</th></tr></thead>
                <tbody>
                  {csvResult.errors.map((e, i) => (
                    <tr key={i}><td>{e.row}</td><td>{e.email}</td><td>{e.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        <div className="testcase-row" style={{ maxWidth: 560, marginBottom: 0 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={downloadCsvTemplate}>
            Download template
          </button>
          <input type="file" accept=".csv" onChange={(e) => setCsvFile(e.target.files?.[0] || null)} disabled={atCap} />
          <button type="button" className="btn btn-primary btn-sm" disabled={!csvFile || csvImporting || atCap} onClick={importCsv}>
            {csvImporting ? 'Importing…' : 'Upload'}
          </button>
        </div>
      </div>

      <AdminProfileChangeRequestsPanel />
      <LegacyScoresPanel onImported={fetchStudents} />

      {!students && <p className="sb-loading">Loading students…</p>}
      {students && students.length === 0 && <p className="sb-loading">No students yet.</p>}

      {students && students.length > 0 && (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                {STUDENT_SORT_COLUMNS.map((col, i) => (
                  <Fragment key={col.key}>
                    <th
                      className="admin-th-sortable"
                      title={col.title}
                      aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      onClick={() => handleSort(col)}
                    >
                      {col.label}
                      <span className="admin-th-sort-arrow">
                        {sortKey === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </span>
                    </th>
                    {i === 0 && <th title="Where this student sits in your organization structure">Unit</th>}
                  </Fragment>
                ))}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sortedStudents.map((s) => (
                <tr key={s.id}>
                  <td>
                    <button type="button" className="auth-link admin-cell-strong" style={{ fontSize: '14px' }} onClick={() => onSelectStudent(s.id)}>
                      {s.name || s.email}
                    </button>
                    {s.name && <div style={{ color: 'var(--text-dim)', fontSize: '12px' }}>{s.email}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)', fontSize: '12.5px' }}>
                    {s.unit_path?.length ? s.unit_path.map((p) => p.name).join(' / ') : '—'}
                  </td>
                  <td style={{ minWidth: 170 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <PercentBar percent={s.totalAssignmentPercent} />
                      <span style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                        {s.totalAssignmentPercent != null ? `${s.totalAssignmentPercent.toFixed(0)}%` : '—'}
                      </span>
                    </div>
                  </td>
                  <td style={{ minWidth: 170 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <PercentBar percent={s.totalExamPercent} />
                      <span style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                        {s.totalExamPercent != null ? `${s.totalExamPercent.toFixed(0)}%` : '—'}
                      </span>
                    </div>
                  </td>
                  <td className="admin-cell-actions">
                    {confirmingId === s.id ? (
                      <span className="confirm-row">
                        <button type="button" className="btn btn-danger btn-sm" disabled={busyId === s.id} onClick={() => handleRemove(s.id)}>
                          {busyId === s.id ? 'Removing…' : 'Confirm'}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(s.id)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// LEGACY SCORES PANEL — CSV import of pre-platform score history, for
// institutions onboarding after already having a track record. Every row
// must match an existing student in this org by email (see POST
// /api/admin/legacy-scores/import) — this never creates accounts, unlike
// the roster CSV import above it. onImported refetches StudentsPanel's own
// list so the newly-blended totals show up without a manual reload.
// ============================================================================
function LegacyScoresPanel({ onImported }) {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);

  const downloadTemplate = async () => {
    try {
      const res = await axios.get(`${API}/api/admin/legacy-scores/csv-template`, { withCredentials: true, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'legacy-scores-template.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Failed to download template.');
    }
  };

  const importFile = async () => {
    if (!file) return;
    setError('');
    setResult(null);
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await axios.post(`${API}/api/admin/legacy-scores/import`, formData, { withCredentials: true });
      setResult(res.data);
      setFile(null);
      onImported?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to import CSV.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
      <div className="field-group-label" style={{ marginBottom: 10 }}>Import previous years' scores</div>
      <p className="auth-sub" style={{ margin: '0 0 10px' }}>
        For institutions just getting started here — upload a CSV of scores from before this platform was in use
        (columns: Email, AcademicYear, AssignmentScorePercent, ExamScorePercent, Notes). Each row must match an
        existing student's email in your organization; re-uploading the same student + year overwrites that row.
        These scores are blended into "total score" alongside everything they do on the platform going forward.
      </p>
      {error && <div className="alert" style={{ marginBottom: 12 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {result && (
        <div className={result.errors.length ? 'alert' : 'alert alert-success'} style={{ marginBottom: 12, flexDirection: 'column', alignItems: 'stretch' }}>
          <span>{result.imported} row(s) imported{result.errors.length > 0 && `, ${result.errors.length} row(s) failed`}</span>
          {result.errors.length > 0 && (
            <table className="admin-table" style={{ marginTop: 10 }}>
              <thead><tr><th>Row</th><th>Email</th><th>Reason</th></tr></thead>
              <tbody>
                {result.errors.map((e, i) => (
                  <tr key={i}><td>{e.row}</td><td>{e.email}</td><td>{e.reason}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className="testcase-row" style={{ maxWidth: 560, marginBottom: 0 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={downloadTemplate}>Download template</button>
        <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <button type="button" className="btn btn-primary btn-sm" disabled={!file || importing} onClick={importFile}>
          {importing ? 'Importing…' : 'Upload'}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// ASSIGNMENTS PANEL
// ============================================================================
function AssignmentsPanel() {
  const [problems, setProblems] = useState(null);
  const [error, setError] = useState('');
  const [formMode, setFormMode] = useState(null); // 'create' | 'loading' | problem_object | null
  const [confirmingId, setConfirmingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [editingWindowId, setEditingWindowId] = useState(null);
  const [windowDraft, setWindowDraft] = useState({ opensAt: '', closesAt: '' });
  const [expandedAttemptsProblemId, setExpandedAttemptsProblemId] = useState(null);
  const [plagiarismProblem, setPlagiarismProblem] = useState(null);

  const fetchProblems = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/problems`, { withCredentials: true });
      setProblems(res.data.problems);
    } catch (err) {
      setError('Failed to load assignments.');
    }
  }, []);

  useEffect(() => { fetchProblems(); }, [fetchProblems]);

  const handleSubmitForm = async (payload) => {
    if (formMode === 'create') {
      await axios.post(`${API}/api/admin/problems`, payload, { withCredentials: true });
    } else {
      await axios.put(`${API}/api/admin/problems/${formMode.id}`, payload, { withCredentials: true });
    }
    setFormMode(null);
    fetchProblems();
  };

  const startFullEdit = async (p) => {
    setFormMode('loading');
    setError('');
    try {
      const res = await axios.get(`${API}/api/admin/problems/${p.id}`, { withCredentials: true });
      setFormMode({ ...res.data, id: p.id });
    } catch (err) {
      setError('Failed to fetch full assignment details for editing.');
      setFormMode(null);
    }
  };

  const handleDelete = async (id) => {
    setBusyId(id);
    try {
      await axios.delete(`${API}/api/admin/problems/${id}`, { withCredentials: true });
      setProblems((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError('Failed to delete assignment.');
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  };

  const startEditWindow = (p) => {
    setEditingWindowId(p.id);
    setWindowDraft({ opensAt: toDatetimeLocal(p.opens_at), closesAt: toDatetimeLocal(p.closes_at) });
  };

  const saveWindow = async (id) => {
    setBusyId(id);
    try {
      const toIso = (v) => (v ? new Date(v).toISOString() : null);
      const res = await axios.patch(`${API}/api/admin/problems/${id}/window`, { opensAt: toIso(windowDraft.opensAt), closesAt: toIso(windowDraft.closesAt) }, { withCredentials: true });
      setProblems((prev) => prev.map((p) => (p.id === id ? { ...p, ...res.data.problem } : p)));
      setEditingWindowId(null);
    } catch (err) {
      setError('Failed to update deadline.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="admin-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setFormMode(formMode ? null : 'create')}>
          {formMode && formMode !== 'loading' ? 'Close form' : '+ New assignment'}
        </button>
      </div>

      {formMode === 'loading' && <p className="sb-loading" style={{marginBottom: '20px'}}>Loading editor data...</p>}

      {formMode && formMode !== 'loading' && (
        <AssignmentForm
          initialData={formMode === 'create' ? null : formMode}
          onSubmit={handleSubmitForm}
          onCancel={() => setFormMode(null)}
        />
      )}

      {error && <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>}

      {!problems && !error && <p className="sb-loading">Loading assignments…</p>}
      {problems && problems.length === 0 && <p className="sb-loading">No assignments yet.</p>}

      {problems && problems.length > 0 && (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Difficulty</th>
                <th>Status</th>
                <th>Opens</th>
                <th>Deadline</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {problems.map((p) => (
                <Fragment key={p.id}>
                  <tr>
                    <td className="admin-cell-strong">{p.title}</td>
                    <td><span className={`chip ${DIFFICULTY_CLASS[p.difficulty] || 'chip-medium'}`}><span className="dot" />{p.difficulty}</span></td>
                    <td><span className={`chip ${STATUS_CLASS[p.status] || 'chip-medium'}`}><span className="dot" />{p.status}</span></td>

                    {editingWindowId === p.id ? (
                      <>
                        <td><input type="datetime-local" value={windowDraft.opensAt} onChange={(e) => setWindowDraft((d) => ({ ...d, opensAt: e.target.value }))} /></td>
                        <td><input type="datetime-local" value={windowDraft.closesAt} onChange={(e) => setWindowDraft((d) => ({ ...d, closesAt: e.target.value }))} /></td>
                        <td className="admin-cell-actions">
                          <button type="button" className="btn btn-primary btn-sm" disabled={busyId === p.id} onClick={() => saveWindow(p.id)}>Save</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingWindowId(null)}>Cancel</button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{formatDate(p.opens_at)}</td>
                        <td>{formatDate(p.closes_at)}</td>
                        <td className="admin-cell-actions">
                          {confirmingId === p.id ? (
                            <span className="confirm-row">
                              <button type="button" className="btn btn-danger btn-sm" disabled={busyId === p.id} onClick={() => handleDelete(p.id)}>Confirm delete</button>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(null)}>Cancel</button>
                            </span>
                          ) : (
                            <>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpandedAttemptsProblemId(expandedAttemptsProblemId === p.id ? null : p.id)}>
                                {expandedAttemptsProblemId === p.id ? 'Hide' : (p.submission_mode === 'scan' ? 'Submissions' : 'Attempts')}
                              </button>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startFullEdit(p)}>Edit</button>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startEditWindow(p)}>Deadline</button>
                              {p.submission_mode !== 'scan' && (
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPlagiarismProblem(p)}>Plagiarism</button>
                              )}
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(p.id)}>Delete</button>
                            </>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                  {expandedAttemptsProblemId === p.id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                        {p.submission_mode === 'scan'
                          ? <ScanSubmissionsPanel problemId={p.id} />
                          : <AssignmentAttemptsPanel problemId={p.id} />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {plagiarismProblem && (
        <CodePlagiarismModal
          problemId={plagiarismProblem.id}
          problemTitle={plagiarismProblem.title}
          onClose={() => setPlagiarismProblem(null)}
        />
      )}
    </div>
  );
}

// Open code-similarity flags for one coding assignment (GET /api/admin/
// problems/:id/code-flags), with confirm/dismiss actions. Same self-
// contained fixed-overlay treatment as the other admin modals.
function CodePlagiarismModal({ problemId, problemTitle, onClose }) {
  const [flags, setFlags] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const fetchFlags = useCallback(() => {
    axios.get(`${API}/api/admin/problems/${problemId}/code-flags`, { withCredentials: true })
      .then((res) => setFlags(res.data.flags))
      .catch(() => setError('Failed to load flags.'));
  }, [problemId]);

  useEffect(() => { fetchFlags(); }, [fetchFlags]);

  const review = async (flagId, status) => {
    setBusyId(flagId);
    try {
      await axios.put(`${API}/api/admin/code-flags/${flagId}`, { status }, { withCredentials: true });
      setFlags((prev) => prev.filter((f) => f.id !== flagId));
    } catch {
      setError('Failed to update flag.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={onClose}>
      <div className="panel" style={{ maxWidth: 560, width: '100%', maxHeight: '80vh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Plagiarism flags</h3>
            <p className="auth-sub" style={{ margin: '2px 0 0' }}>{problemTitle}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>

        {error && <div className="alert" style={{ marginBottom: 10 }}><span className="alert-icon">!</span><span>{error}</span></div>}
        {!flags ? (
          <p className="sb-loading">Loading…</p>
        ) : flags.length === 0 ? (
          <p className="sb-loading">No open flags — no Accepted solutions have matched above the similarity threshold.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {flags.map((f) => (
              <div key={f.id} className="submission-card">
                <div className="submission-card-head">
                  <span>
                    {f.submissionA.name || f.submissionA.email} &harr; {f.submissionB.name || f.submissionB.email}
                  </span>
                  <span className="chip chip-hard"><span className="dot" />{Math.round(f.similarityScore * 100)}% similar</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === f.id} onClick={() => review(f.id, 'reviewed_dismissed')}>Dismiss</button>
                  <button type="button" className="btn btn-danger btn-sm" disabled={busyId === f.id} onClick={() => review(f.id, 'reviewed_confirmed')}>Confirm</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Every student's best submission for one assignment, with %/grade tag/
// percentile tag — mirrors ExamAttemptsPanel, fetched only on expand.
function AssignmentAttemptsPanel({ problemId }) {
  const [attempts, setAttempts] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    axios.get(`${API}/api/admin/problems/${problemId}/attempts`, { withCredentials: true })
      .then((res) => { if (!cancelled) setAttempts(res.data.attempts); })
      .catch(() => { if (!cancelled) setError('Failed to load attempts.'); });
    return () => { cancelled = true; };
  }, [problemId]);

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!attempts) return <p className="sb-loading" style={{ margin: '16px 0' }}>Loading attempts…</p>;
  if (attempts.length === 0) return <p className="sb-loading" style={{ margin: '16px 0' }}>No submissions yet.</p>;

  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>Student</th>
          <th>Best result</th>
          <th>Grade</th>
          <th>Percentile</th>
          <th>Last submitted</th>
        </tr>
      </thead>
      <tbody>
        {attempts.map((a) => (
          <tr key={a.email}>
            <td className="admin-cell-strong">
              {a.name || a.email}
              {a.name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{a.email}</div>}
            </td>
            <td>
              <span className={`chip ${a.status === 'Accepted' ? 'chip-easy' : 'chip-medium'}`}>
                <span className="dot" />{a.status} ({a.passedCount}/{a.totalCount})
              </span>
              {a.percentage != null && <span className="auth-sub" style={{ marginLeft: 6 }}>({Math.round(a.percentage)}%)</span>}
            </td>
            <td>{a.gradeTag ? <span className="chip chip-neutral"><span className="dot" />{a.gradeTag}</span> : '—'}</td>
            <td>{a.percentileTag ? <span className="chip chip-neutral"><span className="dot" />{a.percentileTag}</span> : '—'}</td>
            <td>{formatDate(a.lastSubmittedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SCAN_STATUS_LABELS = { pending: 'Pending', processing: 'Processing', ocr_done: 'Complete', ocr_failed: 'Failed' };
function formatScanStatus(status) {
  return SCAN_STATUS_LABELS[status] || status;
}

// OCR isn't instrumented with real per-page progress (processOneScanSubmission
// runs start-to-finish in one call, no incremental status updates), so this
// is an honest elapsed-time estimate against OCR_SPACE_ID's ~60s GPU budget
// (see ocr-space/app.py's @spaces.GPU(duration=60)), not a lie about exact
// completion — capped short of 100% so it never claims "done" while the row
// is still genuinely 'processing'. Ticks every second via its own timer
// rather than polling the server, since only the ring needs to animate —
// the surrounding table re-fetches on its own schedule when it matters
// (status actually changing). Color runs red (just started) to green
// (about to finish); the "Processing" label next to it stays plain text
// deliberately, so pace context comes from the ring, not from re-coloring
// words on every render.
const OCR_EXPECTED_MS = 60_000;
function ScanProgressRing({ processingStartedAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const startedMs = processingStartedAt ? new Date(processingStartedAt).getTime() : now;
  const elapsedMs = Math.max(0, now - startedMs);
  const pct = Math.min(95, (elapsedMs / OCR_EXPECTED_MS) * 100);
  const hue = (pct / 100) * 120; // 0 = red, 120 = green
  const radius = 8;
  const circumference = 2 * Math.PI * radius;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <svg width="20" height="20" viewBox="0 0 20 20" style={{ flexShrink: 0 }} aria-hidden="true">
        <circle cx="10" cy="10" r={radius} fill="none" stroke="var(--border-strong)" strokeWidth="3" />
        <circle
          cx="10" cy="10" r={radius} fill="none"
          stroke={`hsl(${hue}, 75%, 50%)`}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          transform="rotate(-90 10 10)"
          style={{ transition: 'stroke-dashoffset 0.8s linear, stroke 0.8s linear' }}
        />
      </svg>
      <span>Processing</span>
    </span>
  );
}

// Lazily fetches one submission's full detail and renders the plain
// recognized text — a quick "what did OCR actually read" check, separate
// from ScanReview's full grading view. Concatenates pages in order rather
// than showing per-page confidence scores (ScanReview already covers that
// detail); a teacher opening this just wants to read the text. Message
// differs by status rather than always assuming OCR already ran — with the
// deadline-gated sweep, "pending"/"processing" are the normal state for a
// while, not a failure, so it shouldn't look like the same "nothing found"
// outcome as an ocr_done row with empty pages.
function ScanExtractedText({ submissionId }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    axios.get(`${API}/api/admin/scan-submissions/${submissionId}`, { withCredentials: true })
      .then((res) => { if (!cancelled) setDetail(res.data); })
      .catch(() => { if (!cancelled) setError('Failed to load extracted text.'); });
    return () => { cancelled = true; };
  }, [submissionId]);

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!detail) return <p className="sb-loading" style={{ margin: '12px 0' }}>Loading extracted text…</p>;

  if (detail.status === 'pending') {
    return <p className="auth-sub" style={{ margin: '12px 0' }}>OCR hasn't run yet — it starts automatically once the assignment's deadline passes, or use "Run OCR now" to process it immediately.</p>;
  }
  if (detail.status === 'processing') {
    return <p className="auth-sub" style={{ margin: '12px 0' }}>OCR is running now — this can take a minute or two.</p>;
  }
  if (detail.status === 'ocr_failed') {
    return <p className="auth-sub" style={{ margin: '12px 0' }}>OCR failed{detail.ocrError ? `: ${detail.ocrError}` : '.'} Please refer to the scanned pdf, or try "Run OCR now" again.</p>;
  }

  const combinedText = (detail.pages || []).map((p) => p.text || '').join('\n\n').trim();
  if (!combinedText) {
    return (
      <p className="auth-sub" style={{ margin: '12px 0' }}>
        {detail.viewUrl ? 'No text recognised. Please refer to the scanned pdf.' : 'This assignment has no scanned questions — nothing to OCR.'}
      </p>
    );
  }

  return (
    <pre style={{ whiteSpace: 'pre-wrap', margin: '12px 0', fontFamily: 'var(--font-sans)' }}>{combinedText}</pre>
  );
}

// Lets a teacher upload a PDF on a student's behalf (e.g. a paper answer
// sheet scanned elsewhere, never touching the in-browser camera capture
// flow) instead of waiting for the student to submit themselves. Whatever
// the picked file is named is irrelevant to how it's stored server-side —
// see the backend route's own comment — this form doesn't expose or let
// the admin choose a filename at all, only which student it's for.
function AdminScanUploadForm({ problemId, onUploaded }) {
  const [email, setEmail] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !file) return;
    setBusy(true);
    setMessage('');
    try {
      const formData = new FormData();
      formData.append('email', email.trim());
      formData.append('file', file);
      await axios.post(`${API}/api/admin/problems/${problemId}/scan-submissions`, formData, { withCredentials: true });
      setMessage('Uploaded — OCR starting now.');
      setEmail('');
      setFile(null);
      e.target.reset();
      onUploaded();
    } catch (err) {
      setMessage(err.response?.data?.error || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
      <input
        type="email"
        placeholder="Student's email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-h)' }}
      />
      <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files[0] || null)} required />
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
        {busy && <span className="spinner" />}
        {busy ? 'Uploading…' : 'Upload PDF for student'}
      </button>
      {message && <span className="auth-sub">{message}</span>}
    </form>
  );
}

// Every student's scan submission for one scan-mode assignment — at most
// one row per student (a resubmission replaces the previous one outright,
// see POST /api/problems/:id/scan-submit), so unlike AssignmentAttemptsPanel
// above there's no "best of several" to pick, just each student's final
// upload.
function ScanSubmissionsPanel({ problemId }) {
  const navigate = useNavigate();
  const [submissions, setSubmissions] = useState(null);
  const [hasScanQuestions, setHasScanQuestions] = useState(false);
  const [error, setError] = useState('');
  const [expandedTextId, setExpandedTextId] = useState(null);
  const [processingId, setProcessingId] = useState(null);

  const fetchSubmissions = useCallback(() => {
    axios.get(`${API}/api/admin/problems/${problemId}/scan-submissions`, { withCredentials: true })
      .then((res) => { setSubmissions(res.data.submissions); setHasScanQuestions(res.data.hasScanQuestions); })
      .catch(() => setError('Failed to load submissions.'));
  }, [problemId]);

  useEffect(() => { fetchSubmissions(); }, [fetchSubmissions]);

  // While anything's still 'processing', poll for completion — otherwise
  // the ring above stays stuck showing "Processing" until some unrelated
  // action (mount, an upload, "Run OCR now") happens to refetch the table.
  useEffect(() => {
    if (!submissions?.some((s) => s.status === 'processing')) return undefined;
    const timer = setInterval(fetchSubmissions, 3000);
    return () => clearInterval(timer);
  }, [submissions, fetchSubmissions]);

  const runOcrNow = async (submissionId) => {
    setProcessingId(submissionId);
    try {
      await axios.post(`${API}/api/admin/scan-submissions/${submissionId}/process`, {}, { withCredentials: true });
      fetchSubmissions();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start OCR.');
    } finally {
      setProcessingId(null);
    }
  };

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!submissions) return <p className="sb-loading" style={{ margin: '16px 0' }}>Loading submissions…</p>;

  return (
    <>
      <AdminScanUploadForm problemId={problemId} onUploaded={fetchSubmissions} />
      {submissions.length === 0 ? (
        <p className="sb-loading" style={{ margin: '16px 0' }}>No submissions yet.</p>
      ) : (
        <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Student</th>
              {hasScanQuestions && <th>Status</th>}
              <th>Marks</th>
              <th>Submitted</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {submissions.map((s) => (
              <Fragment key={s.id}>
                <tr>
                  <td className="admin-cell-strong">
                    {s.name || s.email}
                    {s.name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{s.email}</div>}
                  </td>
                  {hasScanQuestions && (
                    <td>
                      {s.status === 'processing' ? (
                        <ScanProgressRing processingStartedAt={s.processingStartedAt} />
                      ) : (
                        <span className={`chip ${s.status === 'ocr_done' ? 'chip-easy' : s.status === 'ocr_failed' ? 'chip-hard' : 'chip-medium'}`}>
                          <span className="dot" />{formatScanStatus(s.status)}
                        </span>
                      )}
                    </td>
                  )}
                  <td>
                    {s.fullyGraded ? `${s.awardedMarks}/${s.totalMarks}` : `—/${s.totalMarks}`}
                    {s.penalized && <span className="chip chip-hard" style={{ marginLeft: 6 }}>penalized</span>}
                  </td>
                  <td>{formatDate(s.createdAt)}</td>
                  <td className="admin-cell-actions">
                    {s.viewUrl && <a className="btn btn-ghost btn-sm" href={s.viewUrl} target="_blank" rel="noreferrer">View PDF</a>}
                    {hasScanQuestions && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpandedTextId(expandedTextId === s.id ? null : s.id)}>
                        {expandedTextId === s.id ? 'Hide text' : 'View text'}
                      </button>
                    )}
                    {hasScanQuestions && s.status !== 'processing' && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={processingId === s.id} onClick={() => runOcrNow(s.id)}>
                        {processingId === s.id && <span className="spinner" />}
                        {s.status === 'ocr_done' ? 'Run OCR again' : 'Run OCR now'}
                      </button>
                    )}
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`/admin/scan-submissions/${s.id}`)}>Grade</button>
                  </td>
                </tr>
                {expandedTextId === s.id && (
                  <tr>
                    <td colSpan={hasScanQuestions ? 5 : 4} style={{ background: 'var(--surface-2)' }}>
                      <ScanExtractedText submissionId={s.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

// ============================================================================
// EXAMS PANEL — same list/create/edit/delete shape as AssignmentsPanel, just
// pointed at the exam routes and ExamForm instead.
// ============================================================================
const END_REASON_LABEL = {
  manual: 'Submitted',
  time_up: 'Time ran out',
  violation_visibility: 'Switched tabs',
  violation_blur: 'Window lost focus',
  violation_fullscreen_exit: 'Exited fullscreen',
  violation_unload: 'Closed/reloaded page',
  reopened_stale: 'Never finished, re-opened',
  violation_proctor_absence: 'No face in camera',
  violation_proctor_phone: 'Phone detected',
};

// One student's flag timeline for one attempt — fetched on demand only
// when its row is expanded, since most attempts will have zero flags.
function ProctorFlagTimeline({ attemptId }) {
  const [flags, setFlags] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    axios.get(`${API}/api/admin/exam-attempts/${attemptId}/flags`, { withCredentials: true })
      .then((res) => { if (!cancelled) setFlags(res.data.flags); })
      .catch(() => { if (!cancelled) setError('Failed to load flags.'); });
    return () => { cancelled = true; };
  }, [attemptId]);

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!flags) return <p className="sb-loading" style={{ margin: '12px 0' }}>Loading flags…</p>;
  if (flags.length === 0) return <p className="sb-loading" style={{ margin: '12px 0' }}>No flags recorded for this attempt.</p>;

  return (
    <div className="submission-history">
      {flags.map((f, idx) => (
        <div className="submission-card" key={idx}>
          <div className="submission-card-head">
            <span>{f.flag_type} &middot; {formatDate(f.created_at)}</span>
            <span className={`chip ${f.severity === 'major' ? 'chip-hard' : 'chip-medium'}`}>
              <span className="dot" />
              {f.severity}
            </span>
          </div>
          {f.detail && <p style={{ margin: '6px 0 0', fontSize: '13px', color: 'var(--text-dim)' }}>{f.detail}</p>}
        </div>
      ))}
    </div>
  );
}

// Every attempt at one exam, with flag counts — fetched only once the
// admin expands that exam's "Attempts" row, same lazy-on-demand pattern
// SubmissionHistory already uses for per-student code history.
// One attempt's answers, editable where manual grading applies (short/long
// only — mcq/coding stay auto-graded). Fetched fresh on every expand so a
// re-open always shows the latest marks, not a stale cache from before a
// save. `onGraded` lets the parent re-fetch the attempts list so the
// score/%/tags columns update immediately after a save, not on next reload.
function GradingForm({ attemptId, onGraded }) {
  const [answers, setAnswers] = useState(null);
  const [scanAnswers, setScanAnswers] = useState([]);
  const [attemptScan, setAttemptScan] = useState(null);
  const [overallRemarks, setOverallRemarks] = useState('');
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({}); // answerId -> in-progress marks input value
  const [remarksDrafts, setRemarksDrafts] = useState({}); // answerId -> in-progress remarks value
  const [savingId, setSavingId] = useState(null);
  const [savingRemarksId, setSavingRemarksId] = useState(null);
  const [savingOverall, setSavingOverall] = useState(false);
  const [processingScan, setProcessingScan] = useState(false);

  const load = useCallback(() => {
    axios.get(`${API}/api/admin/exam-attempts/${attemptId}/answers`, { withCredentials: true })
      .then((res) => {
        setAnswers(res.data.answers);
        setScanAnswers(res.data.scanAnswers || []);
        setAttemptScan(res.data.attemptScan || null);
        setOverallRemarks(res.data.overallRemarks || '');
        setRemarksDrafts(Object.fromEntries(
          [...res.data.answers, ...(res.data.scanAnswers || [])].map((a) => [a.answer_id, a.remarks || ''])
        ));
      })
      .catch(() => setError('Failed to load answers.'));
  }, [attemptId]);

  useEffect(() => { load(); }, [load]);

  const gradable = (answers || []).filter((a) => a.type === 'short' || a.type === 'long');
  const autoGraded = (answers || []).filter((a) => a.type === 'mcq' || a.type === 'coding');

  // Shared by both the short/long route and the scan-answer route — same
  // shape response ({ score, fullyGraded }), just a different URL per kind.
  const saveGrade = async (kind, answerId) => {
    setSavingId(answerId);
    try {
      const url = kind === 'scan'
        ? `${API}/api/admin/exam-scan-answers/${answerId}/grade`
        : `${API}/api/admin/exam-answers/${answerId}/grade`;
      await axios.put(url, { marksAwarded: Number(drafts[answerId]) }, { withCredentials: true });
      load();
      onGraded();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save grade.');
    } finally {
      setSavingId(null);
    }
  };

  // Remarks are settable on any item type, independent of the marks-only
  // routes above — same URL split by kind, just a different body field.
  const saveRemarks = async (kind, answerId) => {
    setSavingRemarksId(answerId);
    try {
      const url = kind === 'scan'
        ? `${API}/api/admin/exam-scan-answers/${answerId}/grade`
        : `${API}/api/admin/exam-answers/${answerId}/grade`;
      await axios.put(url, { remarks: remarksDrafts[answerId] ?? '' }, { withCredentials: true });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save remarks.');
    } finally {
      setSavingRemarksId(null);
    }
  };

  const saveOverallRemarks = async () => {
    setSavingOverall(true);
    try {
      await axios.put(`${API}/api/admin/exam-attempts/${attemptId}/remarks`, { overallRemarks }, { withCredentials: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save overall remarks.');
    } finally {
      setSavingOverall(false);
    }
  };

  const processScanNow = async () => {
    setProcessingScan(true);
    setError('');
    try {
      await axios.post(`${API}/api/admin/exam-attempts/${attemptId}/process-scan`, {}, { withCredentials: true });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start OCR.');
    } finally {
      setProcessingScan(false);
    }
  };

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!answers) return <p className="sb-loading" style={{ margin: '12px 0' }}>Loading answers…</p>;

  const gradeInput = (kind, a) => (
    <div className="testcase-row" style={{ marginTop: '10px' }}>
      <input
        type="number"
        min="0"
        max={a.marks}
        placeholder={a.marks_awarded != null ? String(a.marks_awarded) : 'marks'}
        value={drafts[a.answer_id] ?? (a.marks_awarded != null ? String(a.marks_awarded) : '')}
        onChange={(e) => setDrafts((prev) => ({ ...prev, [a.answer_id]: e.target.value }))}
        style={{ maxWidth: '100px' }}
      />
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={savingId === a.answer_id || drafts[a.answer_id] === undefined || drafts[a.answer_id] === ''}
        onClick={() => saveGrade(kind, a.answer_id)}
      >
        {savingId === a.answer_id && <span className="spinner" />}
        {a.marks_awarded != null ? 'Update' : 'Save'}
      </button>
      {a.marks_awarded != null && <span className="chip chip-easy"><span className="dot" />Graded</span>}
    </div>
  );

  // Remarks are addable to every item type, independent of whether marks
  // are manually gradable here — a separate save action from gradeInput
  // above so a teacher can leave feedback without also touching the score.
  const remarksField = (kind, a) => (
    <div style={{ marginTop: '10px' }}>
      <textarea
        rows={2}
        style={{ width: '100%', resize: 'vertical' }}
        placeholder="Remarks for this answer…"
        value={remarksDrafts[a.answer_id] ?? ''}
        onChange={(e) => setRemarksDrafts((prev) => ({ ...prev, [a.answer_id]: e.target.value }))}
      />
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ marginTop: 6 }}
        disabled={savingRemarksId === a.answer_id}
        onClick={() => saveRemarks(kind, a.answer_id)}
      >
        {savingRemarksId === a.answer_id && <span className="spinner" />}
        Save remarks
      </button>
    </div>
  );

  return (
    <div className="submission-history">
      {autoGraded.map((a) => (
        <div className="submission-card" key={a.answer_id}>
          <div className="submission-card-head">
            <span>{a.prompt}</span>
            <span className="chip chip-neutral"><span className="dot" />{a.marks_awarded ?? 0}/{a.marks} marks (auto-graded)</span>
          </div>
          {a.type === 'mcq' && (
            <p className="auth-sub" style={{ margin: '8px 0' }}>
              Selected: {a.options?.find((o) => o.id === a.selected_option_id)?.text || '(no answer given)'}
              {' — '}
              <span className={a.is_correct ? 'chip chip-easy' : 'chip chip-hard'} style={{ display: 'inline-flex' }}>
                <span className="dot" />{a.is_correct ? 'Correct' : 'Incorrect'}
              </span>
            </p>
          )}
          {a.type === 'coding' && (
            <>
              <p className="auth-sub" style={{ margin: '8px 0 4px' }}>{a.language || 'No language selected'} — {a.passed_count ?? 0}/{a.total_count ?? 0} sample cases passed</p>
              <pre className="submission-code">{a.code || '(no code submitted)'}</pre>
            </>
          )}
          {remarksField('short-long', a)}
        </div>
      ))}

      {gradable.map((a) => (
        <div className="submission-card" key={a.answer_id}>
          <div className="submission-card-head">
            <span>{a.prompt}</span>
            <span className="chip chip-neutral"><span className="dot" />{a.marks} marks</span>
          </div>
          <pre className="submission-code">{a.text_answer || '(no answer given)'}</pre>
          {a.ai_assessment && <p className="auth-sub" style={{ margin: '8px 0' }}>AI assessment (aid only): {a.ai_assessment}</p>}
          {gradeInput('short-long', a)}
          {remarksField('short-long', a)}
        </div>
      ))}

      {scanAnswers.length > 0 && (
        <div className="submission-card">
          <div className="submission-card-head">
            <span>Scanned answers</span>
            {attemptScan?.status && (
              <span className={`chip ${attemptScan.status === 'ocr_done' ? 'chip-easy' : attemptScan.status === 'ocr_failed' ? 'chip-hard' : 'chip-medium'}`}>
                <span className="dot" />{formatScanStatus(attemptScan.status)}
              </span>
            )}
          </div>
          {!attemptScan?.status && (
            <p className="auth-sub" style={{ margin: '8px 0' }}>The student didn't submit any scanned pages for this attempt.</p>
          )}
          {attemptScan?.status && (
            <>
              <div className="scan-capture-actions" style={{ margin: '10px 0' }}>
                {attemptScan.viewUrl && (
                  <a className="btn btn-ghost btn-sm" href={attemptScan.viewUrl} target="_blank" rel="noreferrer">View scanned PDF</a>
                )}
                {(attemptScan.status === 'pending' || attemptScan.status === 'ocr_failed') && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={processingScan} onClick={processScanNow}>
                    {processingScan && <span className="spinner" />}
                    Run OCR now
                  </button>
                )}
              </div>
              {attemptScan.status === 'ocr_failed' && (
                <p className="auth-sub" style={{ color: 'var(--danger)' }}>OCR failed{attemptScan.ocrError ? `: ${attemptScan.ocrError}` : '.'}</p>
              )}
              {Array.isArray(attemptScan.ocrPages) && attemptScan.ocrPages.length > 0 ? (
                attemptScan.ocrPages.map((p) => (
                  <div key={p.page} className="panel" style={{ padding: 14, marginTop: 10 }}>
                    <p className="auth-sub" style={{ margin: '0 0 6px' }}>Page {p.page} — confidence {Math.round((p.confidence || 0) * 100)}%</p>
                    <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'var(--font-sans)' }}>{p.text || '(no text recognized)'}</pre>
                  </div>
                ))
              ) : attemptScan.status === 'pending' && (
                <p className="auth-sub" style={{ margin: '10px 0 0' }}>OCR hasn't run yet — use "Run OCR now" above.</p>
              )}
            </>
          )}
        </div>
      )}

      {scanAnswers.map((a) => (
        <div className="submission-card" key={`scan-${a.answer_id}`}>
          <div className="submission-card-head">
            <span>{a.prompt}</span>
            <span className="chip chip-neutral"><span className="dot" />{a.marks} marks</span>
          </div>
          {a.ai_assessment && <p className="auth-sub" style={{ margin: '8px 0' }}>AI assessment (aid only): {a.ai_assessment}</p>}
          {gradeInput('scan', a)}
          {remarksField('scan', a)}
        </div>
      ))}

      <div className="submission-card">
        <div className="submission-card-head">
          <span>Overall remarks</span>
        </div>
        <textarea
          rows={3}
          style={{ width: '100%', resize: 'vertical', marginTop: 8 }}
          placeholder="Optional feedback on the attempt as a whole…"
          value={overallRemarks}
          onChange={(e) => setOverallRemarks(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 6 }}
          disabled={savingOverall}
          onClick={saveOverallRemarks}
        >
          {savingOverall && <span className="spinner" />}
          Save overall remarks
        </button>
      </div>
    </div>
  );
}

function ExamAttemptsPanel({ examId }) {
  const [attempts, setAttempts] = useState(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null); // { attemptId, panel: 'flags' | 'grade' } | null

  const fetchAttempts = useCallback(() => {
    axios.get(`${API}/api/admin/exams/${examId}/attempts`, { withCredentials: true })
      .then((res) => setAttempts(res.data.attempts))
      .catch(() => setError('Failed to load attempts.'));
  }, [examId]);

  useEffect(() => { fetchAttempts(); }, [fetchAttempts]);

  const toggle = (attemptId, panel) => {
    setExpanded((cur) => (cur && cur.attemptId === attemptId && cur.panel === panel ? null : { attemptId, panel }));
  };

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!attempts) return <p className="sb-loading" style={{ margin: '16px 0' }}>Loading attempts…</p>;
  if (attempts.length === 0) return <p className="sb-loading" style={{ margin: '16px 0' }}>No attempts yet.</p>;

  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>Student</th>
          <th>Status</th>
          <th>Score</th>
          <th>Grade</th>
          <th>Percentile</th>
          <th>Ended because</th>
          <th>Flags</th>
          <th>Started</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {attempts.map((a) => (
          <Fragment key={a.id}>
            <tr>
              <td className="admin-cell-strong">
                {a.name || a.email}
                {a.name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{a.email}</div>}
              </td>
              <td><span className={`chip ${a.status === 'submitted' ? 'chip-easy' : 'chip-medium'}`}><span className="dot" />{a.status}</span></td>
              <td>
                {a.score ?? '—'}
                {a.percentage != null && <span className="auth-sub" style={{ marginLeft: 6 }}>({Math.round(a.percentage)}%)</span>}
                {a.status === 'submitted' && !a.fully_graded && <span className="chip chip-medium" style={{ marginLeft: 6 }}><span className="dot" />needs grading</span>}
              </td>
              <td>{a.gradeTag ? <span className="chip chip-neutral"><span className="dot" />{a.gradeTag}</span> : '—'}</td>
              <td>{a.percentileTag ? <span className="chip chip-neutral"><span className="dot" />{a.percentileTag}</span> : '—'}</td>
              <td>{END_REASON_LABEL[a.end_reason] || a.end_reason || '—'}</td>
              <td>
                {Number(a.major_flag_count) > 0 && <span className="chip chip-hard" style={{ marginRight: 6 }}><span className="dot" />{a.major_flag_count} major</span>}
                {Number(a.minor_flag_count) > 0 && <span className="chip chip-medium"><span className="dot" />{a.minor_flag_count} minor</span>}
                {Number(a.major_flag_count) === 0 && Number(a.minor_flag_count) === 0 && '—'}
              </td>
              <td>{formatDate(a.started_at)}</td>
              <td className="admin-cell-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggle(a.id, 'grade')}>
                  {expanded?.attemptId === a.id && expanded.panel === 'grade' ? 'Hide grading' : 'Grade'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggle(a.id, 'flags')}>
                  {expanded?.attemptId === a.id && expanded.panel === 'flags' ? 'Hide flags' : 'View flags'}
                </button>
              </td>
            </tr>
            {expanded?.attemptId === a.id && (
              <tr>
                <td colSpan={9} style={{ background: 'var(--surface-2)' }}>
                  {expanded.panel === 'flags'
                    ? <ProctorFlagTimeline attemptId={a.id} />
                    : <GradingForm attemptId={a.id} onGraded={fetchAttempts} />}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function ExamsPanel() {
  const [exams, setExams] = useState(null);
  const [error, setError] = useState('');
  const [formMode, setFormMode] = useState(null); // 'create' | 'loading' | exam_object | null
  const [confirmingId, setConfirmingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [expandedAttemptsExamId, setExpandedAttemptsExamId] = useState(null);
  const [cloneExam, setCloneExam] = useState(null);

  const fetchExams = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/admin/exams`, { withCredentials: true });
      setExams(res.data.exams);
    } catch (err) {
      setError('Failed to load exams.');
    }
  }, []);

  useEffect(() => { fetchExams(); }, [fetchExams]);

  const handleSubmitForm = async (payload) => {
    if (formMode === 'create') {
      await axios.post(`${API}/api/admin/exams`, payload, { withCredentials: true });
    } else {
      await axios.put(`${API}/api/admin/exams/${formMode.id}`, payload, { withCredentials: true });
    }
    setFormMode(null);
    fetchExams();
  };

  const startFullEdit = async (ex) => {
    setFormMode('loading');
    setError('');
    try {
      const res = await axios.get(`${API}/api/admin/exams/${ex.id}`, { withCredentials: true });
      setFormMode({ ...res.data, id: ex.id });
    } catch (err) {
      setError('Failed to fetch full exam details for editing.');
      setFormMode(null);
    }
  };

  const handleDelete = async (id) => {
    setBusyId(id);
    try {
      await axios.delete(`${API}/api/admin/exams/${id}`, { withCredentials: true });
      setExams((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setError('Failed to delete exam.');
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  };

  return (
    <div>
      <div className="admin-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setFormMode(formMode ? null : 'create')}>
          {formMode && formMode !== 'loading' ? 'Close form' : '+ New exam'}
        </button>
      </div>

      {formMode === 'loading' && <p className="sb-loading" style={{ marginBottom: '20px' }}>Loading editor data...</p>}

      {formMode && formMode !== 'loading' && (
        <ExamForm
          initialData={formMode === 'create' ? null : formMode}
          onSubmit={handleSubmitForm}
          onCancel={() => setFormMode(null)}
        />
      )}

      {error && <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>}

      {!exams && !error && <p className="sb-loading">Loading exams…</p>}
      {exams && exams.length === 0 && <p className="sb-loading">No exams yet.</p>}

      {exams && exams.length > 0 && (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Items</th>
                <th>Marks</th>
                <th>Time limit</th>
                <th>Webcam</th>
                <th>Calculator</th>
                <th>Status</th>
                <th>Deadline</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {exams.map((ex) => (
                <Fragment key={ex.id}>
                  <tr>
                    <td className="admin-cell-strong">{ex.title}</td>
                    <td>{ex.item_count}</td>
                    <td>{ex.total_marks}</td>
                    <td>{formatDuration(ex.total_time_seconds)}</td>
                    <td>
                      {ex.webcam_required
                        ? <span className="chip chip-medium"><span className="dot" />Required</span>
                        : '—'}
                    </td>
                    <td>
                      {ex.calculator_allowed
                        ? <span className="chip chip-medium"><span className="dot" />{ex.calculator_type}</span>
                        : '—'}
                    </td>
                    <td><span className={`chip ${STATUS_CLASS[ex.status] || 'chip-medium'}`}><span className="dot" />{ex.status}</span></td>
                    <td>{formatDate(ex.closes_at)}</td>
                    <td className="admin-cell-actions">
                      {confirmingId === ex.id ? (
                        <span className="confirm-row">
                          <button type="button" className="btn btn-danger btn-sm" disabled={busyId === ex.id} onClick={() => handleDelete(ex.id)}>Confirm delete</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(null)}>Cancel</button>
                        </span>
                      ) : (
                        <>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpandedAttemptsExamId(expandedAttemptsExamId === ex.id ? null : ex.id)}>
                            {expandedAttemptsExamId === ex.id ? 'Hide attempts' : 'Attempts'}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => startFullEdit(ex)}>Edit</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCloneExam(ex)}>Clone</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(ex.id)}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                  {expandedAttemptsExamId === ex.id && (
                    <tr>
                      <td colSpan={9} style={{ background: 'var(--surface-2)' }}>
                        <ExamAttemptsPanel examId={ex.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cloneExam && (
        <CloneExamModal
          exam={cloneExam}
          onClose={() => setCloneExam(null)}
          onCloned={() => { setCloneExam(null); fetchExams(); }}
        />
      )}
    </div>
  );
}

// Clones one exam (with its full item set) into one or more target
// subjects at once — the "run this same test across several sections"
// case, see POST /api/admin/exams/:id/clone. Same self-contained
// fixed-overlay treatment as LeaderboardModal above.
function CloneExamModal({ exam, onClose, onCloned }) {
  const [subjects, setSubjects] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    axios.get(`${API}/api/admin/subjects`, { withCredentials: true })
      .then((res) => setSubjects(res.data.subjects))
      .catch(() => setError('Failed to load subjects.'));
  }, []);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (selected.size === 0) { setError('Pick at least one target subject.'); return; }
    setSubmitting(true);
    setError('');
    try {
      await axios.post(`${API}/api/admin/exams/${exam.id}/clone`, { subjectIds: [...selected] }, { withCredentials: true });
      onCloned();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to clone exam.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={onClose}>
      <div className="panel" style={{ maxWidth: 440, width: '100%', maxHeight: '80vh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px' }}>Clone "{exam.title}"</h3>
        <p className="auth-sub" style={{ margin: '0 0 12px' }}>Pick every subject that should get its own copy of this exam, items included.</p>

        {error && <div className="alert" style={{ marginBottom: 10 }}><span className="alert-icon">!</span><span>{error}</span></div>}
        {!subjects ? (
          <p className="sb-loading">Loading subjects…</p>
        ) : subjects.length === 0 ? (
          <p className="sb-loading">No subjects available.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16, maxHeight: 260, overflowY: 'auto' }}>
            {subjects.map((s) => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                {s.name} — {s.org_unit_name}
              </label>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={submitting || !subjects || subjects.length === 0}>
            {submitting && <span className="spinner" />}
            {submitting ? 'Cloning…' : `Clone into ${selected.size || ''} subject${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// INTEGRATIONS — surfaces this org's Google Form webhook URL, since the
// webhook is now per-org (a random secret in the path, not the old shared
// unauthenticated endpoint) and an admin has no other way to find their
// own URL to paste into their Google Form's Apps Script trigger.
// ============================================================================
function IntegrationsPanel() {
  const [org, setOrg] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    axios.get(`${API}/api/admin/organization`, { withCredentials: true })
      .then((res) => setOrg(res.data))
      .catch(() => {});
  }, []);

  if (!org) return null;

  const webhookUrl = `${API}/api/webhook/google-form/${org.webhookSecret}`;

  const copyUrl = () => {
    navigator.clipboard?.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
      <h3 style={{ margin: '0 0 4px' }}>Integrations</h3>
      <p className="auth-sub" style={{ margin: '0 0 10px' }}>
        Point your Google Form's submit trigger at this URL to auto-create student accounts in {org.name}.
      </p>
      <div className="testcase-row">
        <input value={webhookUrl} readOnly style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={copyUrl}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

// ============================================================================
// TAG VISIBILITY — global on/off switches for which of the two tags
// students ever see of their own results (exams AND assignments). Teachers
// always see both regardless of this setting; it only gates the two
// student-facing /result routes.
// ============================================================================
function TagVisibilityPanel() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/admin/tag-visibility`, { withCredentials: true });
      setSettings(res.data);
    } catch {
      setError('Failed to load tag visibility settings.');
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const toggle = async (key) => {
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next); // optimistic
    setSaving(true);
    setError('');
    try {
      const res = await axios.put(`${API}/api/admin/tag-visibility`, next, { withCredentials: true });
      setSettings(res.data);
    } catch {
      setError('Failed to save — reverted.');
      fetchSettings();
    } finally {
      setSaving(false);
    }
  };

  if (!settings && !error) return <p className="sb-loading">Loading tag visibility…</p>;

  return (
    <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
      <h3 style={{ margin: '0 0 4px' }}>Student tag visibility</h3>
      <p className="auth-sub" style={{ margin: '0 0 14px' }}>
        Which tags students see of their own exam/assignment results, once available (deadline passed, and — for exams — fully graded).
      </p>
      {error && <div className="alert" style={{ marginBottom: '12px' }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {settings && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label className="testcase-hidden-toggle" style={{ fontSize: '13px' }}>
            <input type="checkbox" checked={settings.showPercentileTag} disabled={saving} onChange={() => toggle('showPercentileTag')} />
            Percentile tag (Very Strong / Strong / Average / Weak / Very Weak)
          </label>
          <label className="testcase-hidden-toggle" style={{ fontSize: '13px' }}>
            <input type="checkbox" checked={settings.showGradeTag} disabled={saving} onChange={() => toggle('showGradeTag')} />
            Individual score tag (Excellent / Pass / etc., from the grade scale below)
          </label>
        </div>
      )}
    </div>
  );
}

// Per-org cutoff the text-plagiarism comparator (deadline sweep, see
// backend/index.js) uses to decide which submission pairs get flagged for
// teacher review — a Jaccard-similarity score from 0 (nothing alike) to 1
// (identical). Deliberately admin-only, same as grade bands / tag
// visibility above: it's an org-wide policy call, not a per-assignment one.
function ScanPlagiarismThresholdPanel() {
  const [threshold, setThreshold] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    axios.get(`${API}/api/admin/settings/scan-plagiarism-threshold`, { withCredentials: true })
      .then((res) => setThreshold(res.data.threshold))
      .catch(() => setError('Failed to load the plagiarism threshold.'));
  }, []);

  const save = async () => {
    setSaving(true);
    setSaveMessage('');
    setError('');
    try {
      await axios.put(`${API}/api/admin/settings/scan-plagiarism-threshold`, { threshold: Number(threshold) }, { withCredentials: true });
      setSaveMessage('Saved.');
    } catch {
      setError('Failed to save the threshold.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
      <h3 style={{ margin: '0 0 4px' }}>Scanned-assignment plagiarism threshold</h3>
      <p className="auth-sub" style={{ margin: '0 0 14px' }}>
        How similar two scanned answer sheets' recognized text has to be before they're flagged for your review (0 = never flags, 1 = only exact duplicates). Confirming a flag zeroes both submissions' marks until you re-grade them.
      </p>
      {error && <div className="alert" style={{ marginBottom: '12px' }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {threshold !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="number" min="0" max="1" step="0.05"
            style={{ maxWidth: 100 }}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saveMessage && <span className="auth-sub">{saveMessage}</span>}
        </div>
      )}
    </div>
  );
}

// Same shape as ScanPlagiarismThresholdPanel above, for coding assignments —
// separate column/route since code and prose similarity don't live on the
// same natural scale (code shares far more incidental boilerplate).
function CodePlagiarismThresholdPanel() {
  const [threshold, setThreshold] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    axios.get(`${API}/api/admin/settings/code-plagiarism-threshold`, { withCredentials: true })
      .then((res) => setThreshold(res.data.threshold))
      .catch(() => setError('Failed to load the plagiarism threshold.'));
  }, []);

  const save = async () => {
    setSaving(true);
    setSaveMessage('');
    setError('');
    try {
      await axios.put(`${API}/api/admin/settings/code-plagiarism-threshold`, { threshold: Number(threshold) }, { withCredentials: true });
      setSaveMessage('Saved.');
    } catch {
      setError('Failed to save the threshold.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
      <h3 style={{ margin: '0 0 4px' }}>Coding-assignment plagiarism threshold</h3>
      <p className="auth-sub" style={{ margin: '0 0 14px' }}>
        How similar two students' Accepted solutions to the same assignment have to be before they're flagged for your review (0 = never flags, 1 = only exact duplicates). Review flags per-assignment from the Assignments tab — confirming a flag never changes either submission's score, it's just a record for you to act on.
      </p>
      {error && <div className="alert" style={{ marginBottom: '12px' }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {threshold !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="number" min="0" max="1" step="0.05"
            style={{ maxWidth: 100 }}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saveMessage && <span className="auth-sub">{saveMessage}</span>}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// GRADE SCALE — the global, admin-editable band scale behind each exam
// attempt's individual score tag (e.g. "90-100 -> Excellent"). Global, not
// per-exam: one shared scale every exam's grade tag is computed against.
// ============================================================================
function GradeBandsPanel() {
  const [bands, setBands] = useState(null);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({}); // bandId -> { label, minPercent } in-progress edit
  const [newBand, setNewBand] = useState({ label: '', minPercent: '' });
  const [busyId, setBusyId] = useState(null);

  const fetchBands = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/admin/grade-bands`, { withCredentials: true });
      setBands(res.data.gradeBands);
    } catch {
      setError('Failed to load grade bands.');
    }
  }, []);

  useEffect(() => { fetchBands(); }, [fetchBands]);

  const draftFor = (b) => drafts[b.id] || { label: b.label, minPercent: String(b.min_percent) };
  const updateDraft = (id, patch) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...draftFor(bands.find((b) => b.id === id)), ...prev[id], ...patch } }));
  };

  const saveBand = async (id) => {
    setBusyId(id);
    setError('');
    try {
      const draft = draftFor(bands.find((b) => b.id === id));
      await axios.put(`${API}/api/admin/grade-bands/${id}`, {
        label: draft.label, minPercent: Number(draft.minPercent),
      }, { withCredentials: true });
      setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
      fetchBands();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save band.');
    } finally {
      setBusyId(null);
    }
  };

  const deleteBand = async (id) => {
    setBusyId(id);
    setError('');
    try {
      await axios.delete(`${API}/api/admin/grade-bands/${id}`, { withCredentials: true });
      fetchBands();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete band.');
    } finally {
      setBusyId(null);
    }
  };

  const addBand = async () => {
    setError('');
    try {
      await axios.post(`${API}/api/admin/grade-bands`, {
        label: newBand.label, minPercent: Number(newBand.minPercent),
      }, { withCredentials: true });
      setNewBand({ label: '', minPercent: '' });
      fetchBands();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add band.');
    }
  };

  if (!bands && !error) return <p className="sb-loading">Loading grade scale…</p>;

  return (
    <div>
      <p className="auth-sub" style={{ marginBottom: '16px' }}>
        A fully-graded exam attempt's percentage is matched against these bands (highest qualifying band wins)
        to produce its individual score tag. This scale is shared across every exam — teachers only, never shown to students.
      </p>

      {error && <div className="alert" style={{ marginBottom: '16px' }}><span className="alert-icon">!</span><span>{error}</span></div>}

      {bands && (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Minimum %</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => {
                const draft = draftFor(b);
                return (
                  <tr key={b.id}>
                    <td>
                      <input value={draft.label} onChange={(e) => updateDraft(b.id, { label: e.target.value })} />
                    </td>
                    <td>
                      <input type="number" min="0" max="100" style={{ maxWidth: '90px' }}
                        value={draft.minPercent} onChange={(e) => updateDraft(b.id, { minPercent: e.target.value })} />
                    </td>
                    <td className="admin-cell-actions">
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === b.id} onClick={() => saveBand(b.id)}>Save</button>
                      <button type="button" className="btn btn-danger btn-sm" disabled={busyId === b.id} onClick={() => deleteBand(b.id)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td><input placeholder="New band label" value={newBand.label} onChange={(e) => setNewBand((p) => ({ ...p, label: e.target.value }))} /></td>
                <td><input type="number" min="0" max="100" style={{ maxWidth: '90px' }} placeholder="0-100" value={newBand.minPercent} onChange={(e) => setNewBand((p) => ({ ...p, minPercent: e.target.value }))} /></td>
                <td className="admin-cell-actions">
                  <button type="button" className="btn btn-primary btn-sm" disabled={!newBand.label.trim() || newBand.minPercent === ''} onClick={addBand}>+ Add band</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// TEACHERS — mirrors the manual "create a person" flow the app already has
// for students (POST /api/admin/create-student), just for the teacher role.
// A teacher's actual creation authority comes from which subjects they're
// linked to (assigned in SubjectsPanel above), not from anything here —
// this panel only provisions the account and, optionally, its org-chart
// placement.
// ============================================================================
function TeachersPanel({ refreshSignal }) {
  const [teachers, setTeachers] = useState(null);
  const [units, setUnits] = useState([]);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [unitId, setUnitId] = useState('');
  const [creating, setCreating] = useState(false);
  const [csvFile, setCsvFile] = useState(null);
  const [csvResult, setCsvResult] = useState(null);
  const [csvError, setCsvError] = useState('');
  const [csvImporting, setCsvImporting] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editUnitId, setEditUnitId] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [teachersRes, unitsRes] = await Promise.all([
        axios.get(`${API}/api/admin/teachers`, { withCredentials: true }),
        axios.get(`${API}/api/admin/org-units`, { withCredentials: true }),
      ]);
      setTeachers(teachersRes.data.teachers);
      setUnits(unitsRes.data.units.map((u) => ({ ...u, level: unitsRes.data.levels.find((l) => l.id === u.level_def_id) })));
    } catch {
      setError('Failed to load teachers.');
    }
  }, []);

  // refreshSignal ticks whenever OrgStructureBuilder (rendered alongside
  // this panel) adds/renames/removes a unit — without it, this panel's own
  // units list only ever reflected whatever existed at its own mount time.
  useEffect(() => { fetchAll(); }, [fetchAll, refreshSignal]);

  const createTeacher = async (e) => {
    e.preventDefault();
    setError('');
    setResult('');
    setCreating(true);
    try {
      const res = await axios.post(`${API}/api/admin/create-teacher`, {
        email: email.trim(),
        name: name.trim() || null,
        orgUnitId: unitId || null,
      }, { withCredentials: true });
      setResult(res.data.temporaryPassword
        ? `Created. Temporary password: ${res.data.temporaryPassword}`
        : res.data.message);
      setName('');
      setEmail('');
      setUnitId('');
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create teacher.');
    } finally {
      setCreating(false);
    }
  };

  const startEditTeacher = (t) => {
    setEditingId(t.id);
    setEditName(t.name || '');
    setEditUnitId(t.org_unit_id != null ? String(t.org_unit_id) : '');
    setError('');
  };

  // Unit is the one field here that actually gates something now, not just
  // informational placement — POST /api/admin/subjects/:id/teachers only
  // allows assigning a teacher whose own org_unit_id matches the subject's,
  // so this is how a teacher created with no unit (or the wrong one) gets
  // corrected after the fact.
  const saveEditTeacher = async (id) => {
    setSavingEdit(true);
    setError('');
    try {
      await axios.put(`${API}/api/admin/teachers/${id}`, {
        name: editName.trim() || null,
        orgUnitId: editUnitId || null,
      }, { withCredentials: true });
      setEditingId(null);
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update teacher.');
    } finally {
      setSavingEdit(false);
    }
  };

  const downloadCsvTemplate = async () => {
    try {
      const res = await axios.get(`${API}/api/admin/teachers/csv-template`, { withCredentials: true, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'teacher-import-template.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setCsvError('Failed to download template.');
    }
  };

  const importCsv = async () => {
    if (!csvFile) return;
    setCsvError('');
    setCsvResult(null);
    setCsvImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', csvFile);
      const res = await axios.post(`${API}/api/admin/teachers/csv-import`, formData, { withCredentials: true });
      setCsvResult(res.data);
      setCsvFile(null);
      fetchAll();
    } catch (err) {
      setCsvError(err.response?.data?.error || 'Failed to import CSV.');
    } finally {
      setCsvImporting(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginTop: 24 }}>
      <h3 style={{ margin: '0 0 4px' }}>Teachers</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Create a teacher account, then assign them to specific subjects above — their assignment/exam
        authority is scoped to exactly those subjects.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {result && <div className="alert alert-success" style={{ marginBottom: 16 }}><span className="alert-icon">✓</span><span>{result}</span></div>}

      {teachers && teachers.length > 0 && (
        <div className="admin-table-wrap" style={{ marginBottom: 16 }}>
          <table className="admin-table">
            <thead><tr><th>Name</th><th>Email</th><th>Unit</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {teachers.map((t) => (
                <tr key={t.id}>
                  {editingId === t.id ? (
                    <>
                      <td>
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="Full name"
                          style={{ width: 140, padding: '4px 8px', fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                        />
                      </td>
                      <td style={{ color: 'var(--text-dim)' }}>{t.email}</td>
                      <td>
                        <select
                          value={editUnitId}
                          onChange={(e) => setEditUnitId(e.target.value)}
                          style={{ padding: '4px 8px', fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                        >
                          <option value="">No unit</option>
                          {units.map((u) => (
                            <option key={u.id} value={u.id}>{u.name} ({u.level?.label})</option>
                          ))}
                        </select>
                      </td>
                      <td className="admin-cell-actions">
                        <button type="button" className="btn btn-primary btn-sm" disabled={savingEdit} onClick={() => saveEditTeacher(t.id)}>
                          {savingEdit ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={savingEdit} onClick={() => setEditingId(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{t.name || '—'}</td>
                      <td>{t.email}</td>
                      <td>{units.find((u) => u.id === t.org_unit_id)?.name || '—'}</td>
                      <td className="admin-cell-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => startEditTeacher(t)}>Edit</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="testcase-row" style={{ maxWidth: 560 }} onSubmit={createTeacher}>
        <input type="text" placeholder="Full name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="email" placeholder="teacher@school.edu" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <select value={unitId} onChange={(e) => setUnitId(e.target.value)} style={{ minWidth: 180 }}>
          <option value="">No unit (optional)</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.name} ({u.level?.label})</option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary btn-sm" disabled={creating || !email.trim()}>
          {creating ? 'Creating…' : 'Create teacher'}
        </button>
      </form>

      <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
        <div className="field-group-label" style={{ marginBottom: 10 }}>Bulk import from CSV</div>
        <p className="auth-sub" style={{ margin: '0 0 10px' }}>
          Upload a CSV where every column except Name/Email is a tier of your structure, in left-to-right
          order — same format as the student import.
        </p>
        {csvError && <div className="alert" style={{ marginBottom: 12 }}><span className="alert-icon">!</span><span>{csvError}</span></div>}
        {csvResult && (
          <div className={csvResult.errors.length ? 'alert' : 'alert alert-success'} style={{ marginBottom: 12, flexDirection: 'column', alignItems: 'stretch' }}>
            <span>
              {csvResult.created} created, {csvResult.existingAdded} existing account(s) added, {csvResult.skipped} already members
              {csvResult.errors.length > 0 && `, ${csvResult.errors.length} row(s) failed`}
            </span>
            {csvResult.unitsCreated?.length > 0 && (
              <span style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text-dim)' }}>
                New units created: {csvResult.unitsCreated.join(', ')}
              </span>
            )}
            {csvResult.newAccounts?.length > 0 && (
              <table className="admin-table" style={{ marginTop: 10 }}>
                <thead><tr><th>Name</th><th>Email</th><th>Temporary password</th></tr></thead>
                <tbody>
                  {csvResult.newAccounts.map((a, i) => (
                    <tr key={i}><td>{a.name || '—'}</td><td>{a.email}</td><td>{a.temporaryPassword}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {csvResult.errors.length > 0 && (
              <table className="admin-table" style={{ marginTop: 10 }}>
                <thead><tr><th>Row</th><th>Email</th><th>Reason</th></tr></thead>
                <tbody>
                  {csvResult.errors.map((e, i) => (
                    <tr key={i}><td>{e.row}</td><td>{e.email}</td><td>{e.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        <div className="testcase-row" style={{ maxWidth: 560, marginBottom: 0 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={downloadCsvTemplate}>
            Download template
          </button>
          <input type="file" accept=".csv" onChange={(e) => setCsvFile(e.target.files?.[0] || null)} />
          <button type="button" className="btn btn-primary btn-sm" disabled={!csvFile || csvImporting} onClick={importCsv}>
            {csvImporting ? 'Importing…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PROMOTE STUDENTS — end-of-academic-year bulk move from one unit to
// another (see POST /api/admin/org-units/:fromUnitId/promote). Purely an
// org_unit_id reassignment; every score a student has is keyed off their
// user id, not their unit, so nothing about their history needs to change
// here — the backend route's own comment covers why. refreshSignal (bumped
// by OrgStructureBuilder) keeps the two unit dropdowns in sync with
// newly-added units, same as SubjectsPanel/TeachersPanel above.
// ============================================================================
const PCR_STATUS_CLASS = { pending: 'chip-medium', escalated: 'chip-medium', approved: 'chip-easy', rejected: 'chip-hard' };

// ============================================================================
// ADMIN: PROFILE CHANGE REQUESTS — a student's own request to correct their
// roster info lands here first (their own org's admin), not the superadmin.
// Approve/Reject resolve it directly; Escalate hands it to the superadmin
// queue for anything this admin can't or shouldn't decide alone.
// ============================================================================
function AdminProfileChangeRequestsPanel() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [noteDrafts, setNoteDrafts] = useState({});
  const [showAll, setShowAll] = useState(false);

  const fetchRequests = useCallback(() => {
    axios.get(`${API}/api/admin/profile-change-requests`, {
      params: { status: showAll ? 'all' : 'pending' },
      withCredentials: true,
    })
      .then((res) => setRequests(res.data.requests))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load profile change requests.'));
  }, [showAll]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const review = async (id, action) => {
    setBusyId(id);
    setError('');
    try {
      await axios.post(`${API}/api/admin/profile-change-requests/${id}/review`, {
        action,
        note: noteDrafts[id] || '',
      }, { withCredentials: true });
      fetchRequests();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to review request.');
    } finally {
      setBusyId(null);
    }
  };

  if (!requests && !error) return <p className="sb-loading">Loading profile change requests…</p>;

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Profile change requests</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show reviewed too
        </label>
      </div>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Corrections your students have requested to their own roster record. Approve or reject directly,
        or escalate to the platform owner if you can't resolve it yourself.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {requests && requests.length === 0 && <p className="sb-loading">No requests to show.</p>}

      {requests && requests.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Field</th>
                <th>Current → Requested</th>
                <th>Reason</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="admin-cell-strong">
                    {r.student_name || r.student_email}
                    {r.student_name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{r.student_email}</div>}
                  </td>
                  <td>{r.field}</td>
                  <td>{r.current_value || '—'} <span style={{ color: 'var(--text-dim)' }}>&rarr;</span> {r.requested_value}</td>
                  <td style={{ maxWidth: 220, whiteSpace: 'normal' }}>{r.reason || '—'}</td>
                  <td><span className={`chip ${PCR_STATUS_CLASS[r.status] || 'chip-neutral'}`}><span className="dot" />{r.status}</span></td>
                  <td className="admin-cell-actions">
                    {r.status === 'pending' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                        <input
                          placeholder="Note (optional)"
                          value={noteDrafts[r.id] || ''}
                          onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          style={{ width: 180, padding: '4px 8px', fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                        />
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === r.id} onClick={() => review(r.id, 'rejected')}>Reject</button>
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === r.id} onClick={() => review(r.id, 'escalated')}>Escalate</button>
                          <button type="button" className="btn btn-primary btn-sm" disabled={busyId === r.id} onClick={() => review(r.id, 'approved')}>
                            {busyId === r.id ? 'Saving…' : 'Approve'}
                          </button>
                        </div>
                      </div>
                    ) : r.status === 'escalated' ? (
                      <span className="auth-sub">Sent to superadmin{r.escalation_note ? `: ${r.escalation_note}` : ''}</span>
                    ) : (
                      r.review_note || '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// REQUEST ADD-ADMIN — structured, unlike AdminRequestsPanel's free-form
// message below: approving one of these actually creates the membership
// (see POST /api/superadmin/add-admin-requests/:id/approve), so it needs
// real name/email fields, not prose the superadmin has to parse and action
// by hand. Nothing in this dashboard lets an admin add a co-admin directly
// the way they can add a teacher/student themselves — admin is the org's
// top role here, so that has to be gated through the superadmin.
// ============================================================================
function RequestAddAdminPanel() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const fetchRequests = useCallback(() => {
    axios.get(`${API}/api/admin/add-admin-requests`, { withCredentials: true })
      .then((res) => setRequests(res.data.requests))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load your requests.'));
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const submit = async (e) => {
    e.preventDefault();
    setSending(true);
    setError('');
    setSent(false);
    try {
      await axios.post(`${API}/api/admin/add-admin-requests`, { name, email }, { withCredentials: true });
      setName('');
      setEmail('');
      setSent(true);
      fetchRequests();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send request.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 4px' }}>Request another admin be added</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Adding a co-admin for your institution goes through the platform owner — tell them who to add.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {sent && <p className="auth-sub" style={{ color: 'var(--accent)', margin: '0 0 16px' }}>Request sent.</p>}

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 420, marginBottom: 20 }}>
        <input
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: '8px 10px', fontSize: 13.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
        />
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: '8px 10px', fontSize: 13.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={sending} style={{ alignSelf: 'flex-start' }}>
          {sending ? 'Sending…' : 'Send request'}
        </button>
      </form>

      {requests && requests.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Status</th>
                <th>Note</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="admin-cell-strong">{r.new_admin_name || '—'}</td>
                  <td>{r.new_admin_email}</td>
                  <td><span className={`chip ${r.status === 'approved' ? 'chip-easy' : r.status === 'rejected' ? 'chip-hard' : 'chip-medium'}`}><span className="dot" />{r.status}</span></td>
                  <td style={{ maxWidth: 200, whiteSpace: 'normal', fontSize: 13 }}>{r.review_note || '—'}</td>
                  <td>{new Date(r.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ADMIN REQUESTS — an institution admin's own free-form message to the
// platform owner. Separate from AdminProfileChangeRequestsPanel's "Escalate"
// button above: that only fires in reaction to a student's pre-existing
// request, so it's not a way for an admin to reach the superadmin on their
// own initiative. This is that missing direct channel.
// ============================================================================
function AdminRequestsPanel() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const fetchRequests = useCallback(() => {
    axios.get(`${API}/api/admin/requests`, { withCredentials: true })
      .then((res) => setRequests(res.data.requests))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load your requests.'));
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const submit = async (e) => {
    e.preventDefault();
    setSending(true);
    setError('');
    setSent(false);
    try {
      await axios.post(`${API}/api/admin/requests`, { subject, message }, { withCredentials: true });
      setSubject('');
      setMessage('');
      setSent(true);
      fetchRequests();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send request.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 4px' }}>Contact the platform owner</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Send a request or question straight to the superadmin — for anything that isn't a student info correction.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {sent && <p className="auth-sub" style={{ color: 'var(--accent)', margin: '0 0 16px' }}>Request sent.</p>}

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480, marginBottom: 20 }}>
        <input
          placeholder="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
          style={{ padding: '8px 10px', fontSize: 13.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
        />
        <textarea
          placeholder="Message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          rows={4}
          style={{ padding: '8px 10px', fontSize: 13.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', resize: 'vertical' }}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={sending} style={{ alignSelf: 'flex-start' }}>
          {sending ? 'Sending…' : 'Send request'}
        </button>
      </form>

      {requests && requests.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Message</th>
                <th>Status</th>
                <th>Response</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="admin-cell-strong">{r.subject}</td>
                  <td style={{ maxWidth: 260, whiteSpace: 'normal', fontSize: 13 }}>{r.message}</td>
                  <td><span className={`chip ${r.status === 'resolved' ? 'chip-easy' : 'chip-medium'}`}><span className="dot" />{r.status}</span></td>
                  <td style={{ maxWidth: 200, whiteSpace: 'normal', fontSize: 13 }}>{r.response_note || '—'}</td>
                  <td>{new Date(r.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PromoteStudentsPanel({ refreshSignal }) {
  const [units, setUnits] = useState([]);
  const [students, setStudents] = useState(null);
  const [error, setError] = useState('');
  const [fromUnitId, setFromUnitId] = useState('');
  const [toUnitId, setToUnitId] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [promoting, setPromoting] = useState(false);
  const [result, setResult] = useState('');

  const fetchAll = useCallback(async () => {
    try {
      const [unitsRes, studentsRes] = await Promise.all([
        axios.get(`${API}/api/admin/org-units`, { withCredentials: true }),
        axios.get(`${API}/api/admin/students`, { withCredentials: true }),
      ]);
      setUnits(unitsRes.data.units.map((u) => ({ ...u, level: unitsRes.data.levels.find((l) => l.id === u.level_def_id) })));
      setStudents(studentsRes.data.students);
    } catch {
      setError('Failed to load units/students.');
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll, refreshSignal]);

  const studentsInFromUnit = students && fromUnitId
    ? students.filter((s) => String(s.org_unit_id) === String(fromUnitId))
    : [];

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectFromUnit = (id) => {
    setFromUnitId(id);
    setResult('');
    setSelectedIds(new Set((students || []).filter((s) => String(s.org_unit_id) === String(id)).map((s) => s.id)));
  };

  const promote = async () => {
    setPromoting(true);
    setError('');
    setResult('');
    try {
      const res = await axios.post(
        `${API}/api/admin/org-units/${fromUnitId}/promote`,
        { toUnitId: Number(toUnitId), studentIds: Array.from(selectedIds) },
        { withCredentials: true }
      );
      setResult(`Promoted ${res.data.promoted} student(s) to ${res.data.toUnitName}.`);
      setFromUnitId('');
      setToUnitId('');
      setSelectedIds(new Set());
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to promote students.');
    } finally {
      setPromoting(false);
    }
  };

  if (!students) return <p className="sb-loading">Loading…</p>;

  return (
    <div className="panel" style={{ padding: 20, marginTop: 24 }}>
      <h3 style={{ margin: '0 0 4px' }}>Promote students</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        End of academic year — move students from one unit to the next. Their assignment/exam scores stay
        attached to them regardless of which unit they're in, so nothing about their history is affected.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {result && <div className="alert alert-success" style={{ marginBottom: 16 }}><span className="alert-icon">✓</span><span>{result}</span></div>}

      <div className="testcase-row" style={{ maxWidth: 560, marginBottom: 16 }}>
        <select value={fromUnitId} onChange={(e) => selectFromUnit(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">From unit…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.name} ({u.level?.label})</option>
          ))}
        </select>
        <span className="auth-sub">&rarr;</span>
        <select value={toUnitId} onChange={(e) => setToUnitId(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">To unit…</option>
          {units.filter((u) => String(u.id) !== String(fromUnitId)).map((u) => (
            <option key={u.id} value={u.id}>{u.name} ({u.level?.label})</option>
          ))}
        </select>
      </div>

      {fromUnitId && (
        studentsInFromUnit.length === 0 ? (
          <p className="sb-loading">No students currently in this unit.</p>
        ) : (
          <>
            <div className="field-group-label" style={{ marginBottom: 8 }}>
              Students to promote ({selectedIds.size}/{studentsInFromUnit.length} selected)
            </div>
            <div className="admin-table-wrap" style={{ marginBottom: 16, maxHeight: 320, overflowY: 'auto' }}>
              <table className="admin-table">
                <tbody>
                  {studentsInFromUnit.map((s) => (
                    <tr key={s.id}>
                      <td style={{ width: 32 }}>
                        <input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelected(s.id)} />
                      </td>
                      <td className="admin-cell-strong">{s.name || s.email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!toUnitId || selectedIds.size === 0 || promoting}
              onClick={promote}
            >
              {promoting ? 'Promoting…' : `Promote ${selectedIds.size} student(s)`}
            </button>
          </>
        )
      )}
    </div>
  );
}
