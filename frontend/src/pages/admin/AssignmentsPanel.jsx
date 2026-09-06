import { useState, useEffect, useCallback, Fragment } from 'react';
import axios from 'axios';
import AssignmentForm from '../../components/AssignmentForm';
import { DIFFICULTY_CLASS, STATUS_CLASS, formatDate, toDatetimeLocal } from './format';
import { ScanSubmissionsPanel } from './ScanGrading';
import { API } from '../../config';

// ============================================================================
// ASSIGNMENTS PANEL
// ============================================================================
export default function AssignmentsPanel() {
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
    } catch {
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
    } catch {
      setError('Failed to fetch full assignment details for editing.');
      setFormMode(null);
    }
  };

  const handleDelete = async (id) => {
    setBusyId(id);
    try {
      await axios.delete(`${API}/api/admin/problems/${id}`, { withCredentials: true });
      setProblems((prev) => prev.filter((p) => p.id !== id));
    } catch {
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
    } catch {
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
