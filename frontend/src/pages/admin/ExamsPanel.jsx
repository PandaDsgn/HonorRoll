import { useState, useEffect, useCallback, Fragment } from 'react';
import axios from 'axios';
import ExamForm from '../../components/ExamForm';
import { STATUS_CLASS, formatDate, formatDuration, formatScanStatus } from './format';
import { API } from '../../config';

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

export default function ExamsPanel() {
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
    } catch {
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
    } catch {
      setError('Failed to fetch full exam details for editing.');
      setFormMode(null);
    }
  };

  const handleDelete = async (id) => {
    setBusyId(id);
    try {
      await axios.delete(`${API}/api/admin/exams/${id}`, { withCredentials: true });
      setExams((prev) => prev.filter((e) => e.id !== id));
    } catch {
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
