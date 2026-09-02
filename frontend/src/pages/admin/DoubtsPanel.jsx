import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API } from '../../config';
import { DoubtDetail, DoubtCard } from '../Doubts';

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// ============================================================================
// DOUBTS — a teacher's own queue: every doubt addressed specifically to
// them, plus every unaddressed doubt in a subject they teach (never one
// narrowed to a co-teacher instead) — see GET /api/teacher/doubts and
// ensureDoubtsSchema's own comment in schema/index.js for the full
// visibility model. Real student identity always shown here — the
// redaction on the student-facing board (pages/Doubts.jsx) doesn't apply on
// this side. Shares its thread/reply view with that same student page
// (DoubtDetail, exported from there) rather than a second copy of it.
// ============================================================================
export default function DoubtsPanel() {
  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [status, setStatus] = useState('open');
  const [doubts, setDoubts] = useState(null);
  const [error, setError] = useState('');
  const [selectedDoubtId, setSelectedDoubtId] = useState(null);

  useEffect(() => {
    axios.get(`${API}/api/doubts/subjects`, { withCredentials: true })
      .then((res) => setSubjects(res.data.subjects))
      .catch(() => {});
  }, []);

  const fetchDoubts = useCallback(() => {
    setError('');
    axios.get(`${API}/api/teacher/doubts`, {
      params: { subjectId: subjectId || undefined, status: status || undefined },
      withCredentials: true,
    })
      .then((res) => setDoubts(res.data.doubts))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load doubts.'));
  }, [subjectId, status]);

  useEffect(() => { fetchDoubts(); }, [fetchDoubts]);

  if (selectedDoubtId) {
    return (
      <DoubtDetail
        doubtId={selectedDoubtId}
        role="teacher"
        onBack={() => { setSelectedDoubtId(null); fetchDoubts(); }}
      />
    );
  }

  return (
    <div>
      <div className="admin-toolbar" style={{ gap: 8 }}>
        <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">All my subjects</option>
          {subjects.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.org_unit_name})</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ minWidth: 160 }}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="answered">Answered</option>
        </select>
      </div>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {!doubts && !error && <p className="sb-loading">Loading…</p>}
      {doubts && doubts.length === 0 && <p className="sb-loading">No doubts here.</p>}

      {doubts && doubts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {doubts.map((d) => (
            <DoubtCard
              key={d.id}
              doubt={d}
              onOpen={setSelectedDoubtId}
              caption={<>{d.subjectName} · asked by {d.studentName} · {formatDate(d.createdAt)}{!d.addressedToMe && <> · open to all of this subject's teachers</>}</>}
            />
          ))}
        </div>
      )}
    </div>
  );
}
