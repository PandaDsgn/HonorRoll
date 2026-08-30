import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API } from '../../config';

// ============================================================================
// PROMOTE STUDENTS — end-of-academic-year bulk move from one unit to
// another (see POST /api/admin/org-units/:fromUnitId/promote). Purely an
// org_unit_id reassignment; every score a student has is keyed off their
// user id, not their unit, so nothing about their history needs to change
// here — the backend route's own comment covers why. refreshSignal (bumped
// by OrgStructureBuilder) keeps the two unit dropdowns in sync with
// newly-added units, same as SubjectsPanel/TeachersPanel above.
// ============================================================================
export default function PromoteStudentsPanel({ refreshSignal }) {
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
