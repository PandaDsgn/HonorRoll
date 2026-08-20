import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
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
import BillingPanel from '../components/BillingPanel';
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
  const { theme, toggleTheme } = useTheme();
  const { logout, user, isImpersonating, exitImpersonation } = useAuth();
  const [tab, setTab] = useState('students');
  const [selectedStudentId, setSelectedStudentId] = useState(null);

  const handleLogout = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  const handleExitImpersonation = async () => {
    await exitImpersonation();
    navigate('/superadmin', { replace: true });
  };

  return (
    <div className="sb-shell">
      {isImpersonating && (
        <div className="alert" style={{ margin: 0, borderRadius: 0, justifyContent: 'center' }}>
          <span className="alert-icon">!</span>
          <span>Viewing {user?.organization_name || 'this organization'} as its admin (superadmin mode).</span>
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 12 }} onClick={handleExitImpersonation}>
            Exit
          </button>
        </div>
      )}
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
          <h1 className="problems-title">
            Admin dashboard
            {user?.organization_name && <span className="auth-sub" style={{ marginLeft: 10, fontWeight: 400 }}>— {user.organization_name}</span>}
          </h1>
          <div className="segmented" role="tablist" aria-label="Admin section">
            <button type="button" role="tab" aria-pressed={tab === 'students'} className={tab === 'students' ? 'active' : ''} onClick={() => { setTab('students'); setSelectedStudentId(null); }}>
              Students
            </button>
            <button type="button" role="tab" aria-pressed={tab === 'assignments'} className={tab === 'assignments' ? 'active' : ''} onClick={() => setTab('assignments')}>
              Assignments
            </button>
            <button type="button" role="tab" aria-pressed={tab === 'exams'} className={tab === 'exams' ? 'active' : ''} onClick={() => setTab('exams')}>
              Exams
            </button>
            <button type="button" role="tab" aria-pressed={tab === 'grade-scale'} className={tab === 'grade-scale' ? 'active' : ''} onClick={() => setTab('grade-scale')}>
              Grading
            </button>
            {user?.role === 'teacher' && (
              <button type="button" role="tab" aria-pressed={tab === 'non-submitters'} className={tab === 'non-submitters' ? 'active' : ''} onClick={() => setTab('non-submitters')}>
                Non-submitters
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
          </div>
        </div>

        {tab === 'students' ? (
          selectedStudentId ? (
            <StudentDetailPanel studentId={selectedStudentId} onBack={() => setSelectedStudentId(null)} />
          ) : (
            <StudentsPanel onSelectStudent={setSelectedStudentId} />
          )
        ) : tab === 'assignments' ? (
          <AssignmentsPanel />
        ) : tab === 'exams' ? (
          <ExamsPanel />
        ) : tab === 'non-submitters' ? (
          user?.role === 'teacher' ? <NonSubmittersPanel /> : null
        ) : tab === 'structure' ? (
          user?.role === 'admin' ? (
            <>
              <OrgStructureBuilder />
              <SubjectsPanel />
              <TeachersPanel />
            </>
          ) : null
        ) : tab === 'billing' ? (
          user?.role === 'admin' ? <BillingPanel /> : null
        ) : (
          <>
            <IntegrationsPanel />
            <TagVisibilityPanel />
            <GradeBandsPanel />
            {user?.role === 'admin' && <ScanPlagiarismThresholdPanel />}
          </>
        )}
      </section>
    </div>
  );
}

// ============================================================================
// NON-SUBMITTERS PANEL — teacher-only. Students in the teacher's own
// classes (their subjects' org units, and everything beneath them) who
// have zero submissions and zero exam attempts anywhere in the org.
// ============================================================================
function NonSubmittersPanel() {
  const [students, setStudents] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get(`${API}/api/teacher/non-submitters`, { withCredentials: true })
      .then((res) => setStudents(res.data.students))
      .catch(() => setError('Failed to load non-submitters.'));
  }, []);

  if (error) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!students) return <p className="sb-loading">Loading…</p>;

  return (
    <div className="panel" style={{ padding: 20 }}>
      <h3 style={{ margin: '0 0 4px' }}>Students who haven't submitted anything</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Scoped to your own classes — students under the subjects you're assigned to who have zero
        assignment submissions and zero exam attempts.
      </p>
      {students.length === 0 ? (
        <p className="sb-loading">Nobody's flagged — every student in your classes has submitted something.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Student</th><th>Unit</th><th>Joined</th></tr></thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id}>
                  <td className="admin-cell-strong">
                    {s.name || s.email}
                    {s.name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{s.email}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)', fontSize: '12.5px' }}>
                    {s.unit_path?.length ? s.unit_path.map((p) => p.name).join(' / ') : '—'}
                  </td>
                  <td>{formatDate(s.created_at)}</td>
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
// STUDENT DETAIL PANEL
// ============================================================================
function StudentDetailPanel({ studentId, onBack }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [expandedProblemId, setExpandedProblemId] = useState(null);

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

  const toggleExpanded = (problemId) => {
    setExpandedProblemId((current) => (current === problemId ? null : problemId));
  };

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
            {(data.overallExamsPercentileTag || data.overallAssignmentsPercentileTag) && (
              <p style={{ margin: '10px 0 0', display: 'flex', gap: 8 }}>
                {data.overallExamsPercentileTag && (
                  <span className="chip chip-neutral"><span className="dot" />Overall (exams): {data.overallExamsPercentileTag}</span>
                )}
                {data.overallAssignmentsPercentileTag && (
                  <span className="chip chip-neutral"><span className="dot" />Overall (assignments): {data.overallAssignmentsPercentileTag}</span>
                )}
              </p>
            )}
          </>
        )}
      </div>

      <h3 style={{ marginBottom: '16px' }}>Assignment Submissions</h3>
      {data.problems.length === 0 ? (
        <p className="sb-loading">This student hasn't submitted any code yet.</p>
      ) : (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Problem</th>
                <th>Difficulty</th>
                <th>Status</th>
                <th>Total Attempts</th>
                <th>Last Attempt</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.problems.map((p) => (
                <Fragment key={p.problem_id}>
                  <tr>
                    <td className="admin-cell-strong">{p.title}</td>
                    <td><span className={`chip ${DIFFICULTY_CLASS[p.difficulty]}`}><span className="dot" />{p.difficulty}</span></td>
                    <td>
                      {p.solved ? (
                        <span className="chip chip-easy"><span className="dot" />Solved</span>
                      ) : (
                        <span className="chip chip-hard"><span className="dot" />Failing</span>
                      )}
                    </td>
                    <td>{p.attempts}</td>
                    <td>{formatDate(p.last_attempt_at)}</td>
                    <td className="admin-cell-actions">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleExpanded(p.problem_id)}>
                        {expandedProblemId === p.problem_id ? 'Hide code' : 'View code'}
                      </button>
                    </td>
                  </tr>
                  {expandedProblemId === p.problem_id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                        <SubmissionHistory studentId={studentId} problemId={p.problem_id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SUBMISSION HISTORY â€” every attempt a student made on one problem, with the
// actual code, so an admin can see exactly what they tried and where it went
// wrong across attempts, not just a pass/fail summary.
// ============================================================================
function SubmissionHistory({ studentId, problemId }) {
  const [submissions, setSubmissions] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetchHistory = async () => {
      try {
        const res = await axios.get(
          `${API}/api/admin/students/${studentId}/problems/${problemId}/submissions`,
          { withCredentials: true }
        );
        if (!cancelled) setSubmissions(res.data.submissions);
      } catch (err) {
        if (!cancelled) setError('Failed to load submission history.');
      }
    };
    fetchHistory();
    return () => { cancelled = true; };
  }, [studentId, problemId]);

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!submissions) return <p className="sb-loading" style={{ margin: '16px 0' }}>Loading attempts…</p>;
  if (submissions.length === 0) return <p className="sb-loading" style={{ margin: '16px 0' }}>No attempts recorded.</p>;

  return (
    <div className="submission-history">
      {submissions.map((s, idx) => (
        <div className="submission-card" key={s.id}>
          <div className="submission-card-head">
            <span>
              Attempt {submissions.length - idx} &middot; {s.language} &middot; {formatDate(s.created_at)}
            </span>
            <span className={`chip ${s.status === 'Accepted' ? 'chip-easy' : 'chip-hard'}`}>
              <span className="dot" />
              {s.status} ({s.passed_count}/{s.total_count})
            </span>
          </div>
          <pre className="submission-code">{s.code}</pre>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// STUDENTS PANEL
// ============================================================================
// Sortable columns on the students table. `numeric: false` (email) sorts
// alphabetically and defaults to ascending; every numeric/date column
// defaults to descending on first click, since "biggest first" is what an
// admin scanning for top/bottom performers wants for all five of these.
const STUDENT_SORT_COLUMNS = [
  { key: 'email', label: 'Email', numeric: false },
  { key: 'problems_solved', label: 'Solved', numeric: true },
  { key: 'total_submissions', label: 'Attempts', numeric: true, title: 'Total attempt numbers — every submission across every assignment' },
  { key: 'total_seconds', label: 'Total time', numeric: true, title: 'True time-on-task: assignment open → final submission, revisits added in' },
  { key: 'last_active_at', label: 'Last active', numeric: true, isDate: true, title: 'Most recent of: last submission, last time the assignment was open' },
  { key: 'successful_test_cases', label: 'Tests passed', numeric: true, title: 'Test cases passed on each problem\'s best attempt, summed' },
  { key: 'composite_score', label: 'Score', numeric: true, title: 'Efficiency score = tests passed / ((1 + attempts) × (1 + hours spent)) — higher = fast, few attempts, high success' },
];

function StudentsPanel({ onSelectStudent }) {
  const [students, setStudents] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [selectedProblemId, setSelectedProblemId] = useState(''); // '' = all assignments combined
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

  // Populate the "scope to assignment" dropdown once. Failing silently here
  // is fine — worst case the dropdown just stays on "All assignments".
  useEffect(() => {
    axios.get(`${API}/api/problems`, { withCredentials: true })
      .then((res) => setAssignments(res.data.problems))
      .catch(() => {});
  }, []);

  const fetchStudents = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/admin/students`, {
        params: selectedProblemId ? { problemId: selectedProblemId } : {},
        withCredentials: true,
      });
      setStudents(res.data.students);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load students.');
    }
  }, [selectedProblemId]);

  useEffect(() => {
    setStudents(null); // show the loading state while re-scoping to a new assignment
    fetchStudents();
  }, [fetchStudents]);

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
      <div className="admin-toolbar" style={{ justifyContent: 'flex-start', gap: '10px', alignItems: 'center' }}>
        <label htmlFor="assignment-filter" style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
          Scope stats to
        </label>
        <select
          id="assignment-filter"
          className="assignment-select"
          value={selectedProblemId}
          onChange={(e) => setSelectedProblemId(e.target.value)}
        >
          <option value="">All assignments (combined)</option>
          {assignments.map((a, idx) => (
            <option key={a.id} value={a.id}>{idx + 1}. {a.title}</option>
          ))}
        </select>
      </div>

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
                  <td>{s.problems_solved}</td>
                  <td>{s.total_submissions}</td>
                  <td>{formatDuration(s.total_seconds)}</td>
                  <td>{formatDate(s.last_active_at)}</td>
                  <td>{s.successful_test_cases}</td>
                  <td>{s.composite_score.toFixed(3)}</td>
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

// Every student's scan submission for one scan-mode assignment — at most
// one row per student (a resubmission replaces the previous one outright,
// see POST /api/problems/:id/scan-submit), so unlike AssignmentAttemptsPanel
// above there's no "best of several" to pick, just each student's final
// upload. No OCR/grading columns yet since that pipeline hasn't been built.
function ScanSubmissionsPanel({ problemId }) {
  const navigate = useNavigate();
  const [submissions, setSubmissions] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    axios.get(`${API}/api/admin/problems/${problemId}/scan-submissions`, { withCredentials: true })
      .then((res) => { if (!cancelled) setSubmissions(res.data.submissions); })
      .catch(() => { if (!cancelled) setError('Failed to load submissions.'); });
    return () => { cancelled = true; };
  }, [problemId]);

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!submissions) return <p className="sb-loading" style={{ margin: '16px 0' }}>Loading submissions…</p>;
  if (submissions.length === 0) return <p className="sb-loading" style={{ margin: '16px 0' }}>No submissions yet.</p>;

  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>Student</th>
          <th>Status</th>
          <th>Marks</th>
          <th>Submitted</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {submissions.map((s) => (
          <tr key={s.id}>
            <td className="admin-cell-strong">
              {s.name || s.email}
              {s.name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{s.email}</div>}
            </td>
            <td>
              <span className={`chip ${s.status === 'ocr_done' ? 'chip-easy' : s.status === 'ocr_failed' ? 'chip-hard' : 'chip-medium'}`}>
                <span className="dot" />{s.status}
              </span>
              {s.penalized && <span className="chip chip-hard" style={{ marginLeft: 6 }}>penalized</span>}
            </td>
            <td>{s.fullyGraded ? `${s.awardedMarks}/${s.totalMarks}` : `—/${s.totalMarks}`}</td>
            <td>{formatDate(s.createdAt)}</td>
            <td className="admin-cell-actions">
              {s.viewUrl && <a className="btn btn-ghost btn-sm" href={s.viewUrl} target="_blank" rel="noreferrer">View PDF</a>}
              {s.status === 'ocr_done' && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`/admin/scan-submissions/${s.id}`)}>Review</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({}); // answerId -> in-progress input value
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(() => {
    axios.get(`${API}/api/admin/exam-attempts/${attemptId}/answers`, { withCredentials: true })
      .then((res) => setAnswers(res.data.answers))
      .catch(() => setError('Failed to load answers.'));
  }, [attemptId]);

  useEffect(() => { load(); }, [load]);

  const gradable = (answers || []).filter((a) => a.type === 'short' || a.type === 'long');

  const saveGrade = async (answerId) => {
    setSavingId(answerId);
    try {
      await axios.put(`${API}/api/admin/exam-answers/${answerId}/grade`, {
        marksAwarded: Number(drafts[answerId]),
      }, { withCredentials: true });
      load();
      onGraded();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save grade.');
    } finally {
      setSavingId(null);
    }
  };

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!answers) return <p className="sb-loading" style={{ margin: '12px 0' }}>Loading answers…</p>;
  if (gradable.length === 0) return <p className="sb-loading" style={{ margin: '12px 0' }}>Nothing to manually grade on this attempt — every item is auto-graded.</p>;

  return (
    <div className="submission-history">
      {gradable.map((a) => (
        <div className="submission-card" key={a.answer_id}>
          <div className="submission-card-head">
            <span>{a.prompt}</span>
            <span className="chip chip-neutral"><span className="dot" />{a.marks} marks</span>
          </div>
          <pre className="submission-code">{a.text_answer || '(no answer given)'}</pre>
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
              onClick={() => saveGrade(a.answer_id)}
            >
              {savingId === a.answer_id && <span className="spinner" />}
              {a.marks_awarded != null ? 'Update' : 'Save'}
            </button>
            {a.marks_awarded != null && <span className="chip chip-easy"><span className="dot" />Graded</span>}
          </div>
        </div>
      ))}
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
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(ex.id)}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                  {expandedAttemptsExamId === ex.id && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--surface-2)' }}>
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
function TeachersPanel() {
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

  useEffect(() => { fetchAll(); }, [fetchAll]);

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
            <thead><tr><th>Name</th><th>Email</th></tr></thead>
            <tbody>
              {teachers.map((t) => <tr key={t.id}><td>{t.name || '—'}</td><td>{t.email}</td></tr>)}
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
