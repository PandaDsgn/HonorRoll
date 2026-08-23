import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API } from '../config';

// Flat admin table for subjects — each attached to whatever org_unit tier
// an admin picked (org_unit_name shows exactly where), with an inline
// teacher-assignment control. Creating/renaming/deleting a subject and
// assigning its teachers is admin-only; a teacher only ever gets read
// access to (a subset of) this list, via GET /api/admin/subjects itself,
// to power the subject-picker on the assignment/exam forms.
//
// Teacher assignment is unit-scoped, not free-text email: a subject
// belongs to exactly one org_unit, and only teachers whose OWN org_unit_id
// matches that unit are eligible to be assigned to it (enforced again on
// the backend — see POST /api/admin/subjects/:id/teachers's own comment —
// so this isn't just a UI-side suggestion). The picker per row is a
// dropdown of exactly those eligible teachers, narrowed by an optional
// name search when a unit has enough teachers that scrolling a plain
// <select> gets unwieldy. A teacher with no unit set, or the wrong one,
// simply won't appear here until an admin corrects it via TeachersPanel's
// own Edit button.
export default function SubjectsPanel({ refreshSignal }) {
  const [subjects, setSubjects] = useState(null);
  const [units, setUnits] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [newUnitId, setNewUnitId] = useState('');
  const [teacherSearch, setTeacherSearch] = useState({});
  const [teacherPick, setTeacherPick] = useState({});
  const [busyId, setBusyId] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [subjRes, unitsRes, teachersRes] = await Promise.all([
        axios.get(`${API}/api/admin/subjects`, { withCredentials: true }),
        axios.get(`${API}/api/admin/org-units`, { withCredentials: true }),
        axios.get(`${API}/api/admin/teachers`, { withCredentials: true }),
      ]);
      setSubjects(subjRes.data.subjects);
      setUnits(unitsRes.data.units.map((u) => ({ ...u, level: unitsRes.data.levels.find((l) => l.id === u.level_def_id) })));
      setTeachers(teachersRes.data.teachers);
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

  const addTeacher = async (subjectId, userId) => {
    if (!userId) return;
    setError('');
    try {
      await axios.post(`${API}/api/admin/subjects/${subjectId}/teachers`, { userId }, { withCredentials: true });
      setTeacherPick((prev) => ({ ...prev, [subjectId]: '' }));
      setTeacherSearch((prev) => ({ ...prev, [subjectId]: '' }));
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
        and exams only under their own subjects — only teachers already placed in this subject's own unit
        (see the Teachers panel below) can be assigned to it.
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
              {subjects.map((s) => {
                const assignedIds = new Set(s.teachers.map((t) => t.id));
                const eligible = teachers.filter((t) => t.org_unit_id === s.org_unit_id && !assignedIds.has(t.id));
                const search = (teacherSearch[s.id] || '').trim().toLowerCase();
                const filtered = search
                  ? eligible.filter((t) => (t.name || '').toLowerCase().includes(search) || t.email.toLowerCase().includes(search))
                  : eligible;
                return (
                  <tr key={s.id}>
                    <td className="admin-cell-strong">{s.name}</td>
                    <td>{s.org_unit_name}</td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                        {s.teachers.map((t) => (
                          <span key={t.id} className="chip chip-medium">
                            <span className="dot" />
                            {t.name || t.email}
                            <button
                              type="button"
                              onClick={() => removeTeacher(s.id, t.id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', marginLeft: 2, padding: 0 }}
                              aria-label={`Remove ${t.name || t.email}`}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <input
                          placeholder="Search teacher by name…"
                          value={teacherSearch[s.id] || ''}
                          onChange={(e) => setTeacherSearch((prev) => ({ ...prev, [s.id]: e.target.value }))}
                          style={{ width: 150, padding: '4px 8px', fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                        />
                        <select
                          value={teacherPick[s.id] || ''}
                          onChange={(e) => { setTeacherPick((prev) => ({ ...prev, [s.id]: e.target.value })); addTeacher(s.id, e.target.value); }}
                          disabled={eligible.length === 0}
                          style={{ maxWidth: 170, padding: '4px 8px', fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                        >
                          <option value="">{eligible.length === 0 ? 'No eligible teachers' : filtered.length === 0 ? 'No match' : 'Assign teacher…'}</option>
                          {filtered.map((t) => (
                            <option key={t.id} value={t.id}>{t.name || t.email}{t.name ? ` (${t.email})` : ''}</option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className="admin-cell-actions">
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === s.id} onClick={() => deleteSubject(s.id)}>
                        {busyId === s.id ? 'Removing…' : 'Remove'}
                      </button>
                    </td>
                  </tr>
                );
              })}
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
