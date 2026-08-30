import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API } from '../../config';

// ============================================================================
// TEACHERS — mirrors the manual "create a person" flow the app already has
// for students (POST /api/admin/create-student), just for the teacher role.
// A teacher's actual creation authority comes from which subjects they're
// linked to (assigned in SubjectsPanel above), not from anything here —
// this panel only provisions the account and, optionally, its org-chart
// placement.
// ============================================================================
export default function TeachersPanel({ refreshSignal }) {
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
