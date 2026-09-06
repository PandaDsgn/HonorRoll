import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import axios from 'axios';
import { useAuth } from '../../context/AuthContext';
import PercentBar from '../../components/PercentBar';
import { formatDate } from './format';
import { API } from '../../config';

// ============================================================================
// STUDENT DETAIL PANEL — identity + the two total scores only (see
// GET /api/admin/students/:id's own comment on why the attempt-by-attempt
// history and percentile tags were dropped).
// ============================================================================
export function StudentDetailPanel({ studentId, onBack }) {
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

export function StudentsPanel({ onSelectStudent }) {
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
    } catch {
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
