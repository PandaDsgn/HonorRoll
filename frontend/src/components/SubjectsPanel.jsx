import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API } from '../config';

// Flat admin table for subjects — each attached to whatever org_unit tier
// an admin picked (org_unit_name shows exactly where), with an inline
// teacher-assignment control. Creating/renaming/deleting a subject and
// assigning its teachers is admin-only; a teacher only ever gets read
// access to (a subset of) this list, via GET /api/admin/subjects itself,
// to power the subject-picker on the assignment/exam forms.
export default function SubjectsPanel({ refreshSignal }) {
  const [subjects, setSubjects] = useState(null);
  const [units, setUnits] = useState([]);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [newUnitId, setNewUnitId] = useState('');
  const [teacherEmailDraft, setTeacherEmailDraft] = useState({});
  const [busyId, setBusyId] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [subjRes, unitsRes] = await Promise.all([
        axios.get(`${API}/api/admin/subjects`, { withCredentials: true }),
        axios.get(`${API}/api/admin/org-units`, { withCredentials: true }),
      ]);
      setSubjects(subjRes.data.subjects);
      setUnits(unitsRes.data.units.map((u) => ({ ...u, level: unitsRes.data.levels.find((l) => l.id === u.level_def_id) })));
    } catch {
      setError('Failed to load subjects.');
    }
  }, []);

  // refreshSignal ticks whenever OrgStructureBuilder (rendered alongside
  // this panel) adds/renames/removes a unit — without it, this panel's own
  // units list only ever reflected whatever existed at its own mount time.
  useEffect(() => { fetchAll(); }, [fetchAll, refreshSignal]);

  const addSubject = async () => {
    const name = newName.trim();
    if (!name || !newUnitId) return;
    setError('');
    try {
      await axios.post(`${API}/api/admin/subjects`, { name, orgUnitId: Number(newUnitId) }, { withCredentials: true });
      setNewName('');
      setNewUnitId('');
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add subject.');
    }
  };

  const deleteSubject = async (id) => {
    setBusyId(id);
    setError('');
    try {
      await axios.delete(`${API}/api/admin/subjects/${id}`, { withCredentials: true });
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove subject.');
    } finally {
      setBusyId(null);
    }
  };

  const addTeacher = async (subjectId) => {
    const email = (teacherEmailDraft[subjectId] || '').trim();
    if (!email) return;
    setError('');
    try {
      await axios.post(`${API}/api/admin/subjects/${subjectId}/teachers`, { email }, { withCredentials: true });
      setTeacherEmailDraft((prev) => ({ ...prev, [subjectId]: '' }));
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to assign teacher.');
    }
  };

  const removeTeacher = async (subjectId, userId) => {
    setError('');
    try {
      await axios.delete(`${API}/api/admin/subjects/${subjectId}/teachers/${userId}`, { withCredentials: true });
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove teacher.');
    }
  };

  if (!subjects && !error) return <p className="sb-loading">Loading subjects…</p>;

  return (
    <div className="panel" style={{ padding: 20, marginTop: 24 }}>
      <h3 style={{ margin: '0 0 4px' }}>Subjects</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Attach a subject to any tier of your structure — one on a department reaches every year beneath it;
        one on a specific year stays scoped to just that year. Teachers assigned here can create assignments
        and exams only under their own subjects.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}

      {subjects && subjects.length > 0 && (
        <div className="admin-table-wrap" style={{ marginBottom: 16 }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Unit</th>
                <th>Teachers</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {subjects.map((s) => (
                <tr key={s.id}>
                  <td className="admin-cell-strong">{s.name}</td>
                  <td>{s.org_unit_name}</td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      {s.teachers.map((t) => (
                        <span key={t.id} className="chip chip-medium">
                          <span className="dot" />
                          {t.email}
                          <button
                            type="button"
                            onClick={() => removeTeacher(s.id, t.id)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', marginLeft: 2, padding: 0 }}
                            aria-label={`Remove ${t.email}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <input
                        placeholder="teacher email"
                        value={teacherEmailDraft[s.id] || ''}
                        onChange={(e) => setTeacherEmailDraft((prev) => ({ ...prev, [s.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') addTeacher(s.id); }}
                        style={{ width: 160, padding: '4px 8px', fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                      />
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => addTeacher(s.id)}>+</button>
                    </div>
                  </td>
                  <td className="admin-cell-actions">
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === s.id} onClick={() => deleteSubject(s.id)}>
                      {busyId === s.id ? 'Removing…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="testcase-row" style={{ maxWidth: 520 }}>
        <input placeholder="Subject name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <select value={newUnitId} onChange={(e) => setNewUnitId(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">Attach to unit…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.name} ({u.level?.label})</option>
          ))}
        </select>
        <button type="button" className="btn btn-primary btn-sm" disabled={!newName.trim() || !newUnitId} onClick={addSubject}>
          Add subject
        </button>
      </div>
    </div>
  );
}
