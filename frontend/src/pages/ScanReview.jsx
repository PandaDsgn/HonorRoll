import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import { API } from '../config';

function formatScanDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

const SCAN_STATUS_LABELS = { pending: 'Pending', processing: 'Processing', ocr_done: 'Complete', ocr_failed: 'Failed' };
function formatScanStatus(status) {
  return SCAN_STATUS_LABELS[status] || status;
}

const FLAG_STATUS_LABELS = { open: 'Open', reviewed_dismissed: 'Dismissed', reviewed_confirmed: 'Confirmed' };
function formatFlagStatus(status) {
  return FLAG_STATUS_LABELS[status] || status;
}

// One scanned submission's full review — OCR'd pages, each question with
// the AI's correctness assessment (an aid, never authoritative — see
// backend/aiGrading.js) alongside a marks input the teacher actually
// controls, and this submission's plagiarism/handwriting flags with
// confirm/dismiss actions. Linked from AdminDashboard's ScanSubmissionsPanel.
export default function ScanReview() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { theme, toggleTheme } = useTheme();

  const [submission, setSubmission] = useState(null);
  const [marks, setMarks] = useState({}); // { [questionId]: string }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [flagBusyId, setFlagBusyId] = useState(null);
  const [ocrStarting, setOcrStarting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await axios.get(`${API}/api/admin/scan-submissions/${id}`, { withCredentials: true });
        setSubmission(res.data);
        setMarks(Object.fromEntries(res.data.questions.map((q) => [q.questionId, q.marksAwarded ?? ''])));
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to load submission.');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // Plain (non-memoized) re-fetch for after a save/flag action — kept
  // separate from the mount-effect fetch above rather than feeding a
  // useCallback into that effect's deps, which trips
  // react-hooks/set-state-in-effect.
  const refetchSubmission = async () => {
    try {
      const res = await axios.get(`${API}/api/admin/scan-submissions/${id}`, { withCredentials: true });
      setSubmission(res.data);
      setMarks(Object.fromEntries(res.data.questions.map((q) => [q.questionId, q.marksAwarded ?? ''])));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load submission.');
    }
  };

  // While OCR is running, poll for completion instead of leaving the page
  // stuck on "Processing" until some unrelated action happens to refetch —
  // stops itself the moment status moves on to ocr_done/ocr_failed.
  useEffect(() => {
    if (submission?.status !== 'processing') return undefined;
    const timer = setInterval(refetchSubmission, 3000);
    return () => clearInterval(timer);
  }, [submission?.status]);

  const saveGrade = async () => {
    setSaving(true);
    setSaveMessage('');
    try {
      await axios.put(`${API}/api/admin/scan-submissions/${id}/grade`, {
        marks: Object.entries(marks).map(([questionId, marksAwarded]) => ({ questionId: Number(questionId), marksAwarded: marksAwarded === '' ? null : marksAwarded })),
      }, { withCredentials: true });
      setSaveMessage('Grade saved.');
      await refetchSubmission();
    } catch (err) {
      setSaveMessage(err.response?.data?.error || 'Failed to save grade.');
    } finally {
      setSaving(false);
    }
  };

  const runOcrNow = async () => {
    setOcrStarting(true);
    try {
      await axios.post(`${API}/api/admin/scan-submissions/${id}/process`, {}, { withCredentials: true });
      await refetchSubmission();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start OCR.');
    } finally {
      setOcrStarting(false);
    }
  };

  const resolveFlag = async (flag, status) => {
    setFlagBusyId(flag.id);
    try {
      await axios.put(`${API}/api/admin/scan-flags/${flag.type}/${flag.id}`, { status }, { withCredentials: true });
      await refetchSubmission();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update flag.');
    } finally {
      setFlagBusyId(null);
    }
  };

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-toolbar" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="btn btn-ghost" onClick={() => navigate(-1)}>&larr; Back</button>
        </div>

        <div className="panel">
          {loading && <p className="sb-loading">Loading submission…</p>}

          {error && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{error}</span>
            </div>
          )}

          {submission && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                <div>
                  <h2 style={{ margin: '0 0 4px' }}>{submission.name || submission.email}</h2>
                  <p className="auth-sub" style={{ margin: 0 }}>
                    Submitted {formatScanDate(submission.createdAt)} — status: {formatScanStatus(submission.status)}
                    {submission.ocrError && ` (${submission.ocrError})`}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {submission.penalized && <span className="chip chip-hard">Penalized — plagiarism confirmed</span>}
                  {submission.viewUrl && (
                    <a className="btn btn-ghost" href={submission.viewUrl} target="_blank" rel="noreferrer">View PDF</a>
                  )}
                  {submission.status !== 'processing' && (
                    <button type="button" className="btn btn-ghost" disabled={ocrStarting} onClick={runOcrNow}>
                      {ocrStarting && <span className="spinner" />}
                      {ocrStarting ? 'Starting…' : submission.status === 'ocr_done' ? 'Run OCR again' : 'Run OCR now'}
                    </button>
                  )}
                </div>
              </div>

              {submission.flags.length > 0 && (
                <>
                  <div className="field-group-label">Flags</div>
                  <div className="admin-table-wrap" style={{ marginBottom: 20 }}>
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Matched submission</th>
                          <th>Similarity</th>
                          <th>Status</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {submission.flags.map((f) => (
                          <tr key={`${f.type}-${f.id}`}>
                            <td>{f.type === 'text_similarity' ? 'Text plagiarism' : 'Handwriting match'}</td>
                            <td>#{f.otherSubmissionId}</td>
                            <td>{Math.round(f.similarityScore * 100)}%</td>
                            <td>{formatFlagStatus(f.status)}</td>
                            <td>
                              {f.status === 'open' && (
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <button type="button" className="btn btn-ghost btn-sm" disabled={flagBusyId === f.id} onClick={() => resolveFlag(f, 'reviewed_dismissed')}>Dismiss</button>
                                  <button type="button" className="btn btn-primary btn-sm" disabled={flagBusyId === f.id} onClick={() => resolveFlag(f, 'reviewed_confirmed')}>
                                    {f.type === 'text_similarity' ? 'Confirm (penalizes both)' : 'Confirm'}
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="field-group-label">Questions</div>
              <div className="testcase-list" style={{ marginBottom: 20 }}>
                {submission.questions.map((q) => (
                  <div key={q.questionId} className="panel" style={{ padding: 14, marginBottom: 10 }}>
                    <p style={{ margin: '0 0 6px', fontWeight: 600 }}>{q.prompt} <span className="auth-sub">({q.maxMarks} marks)</span></p>
                    {q.aiAssessment && (
                      <p className="auth-sub" style={{ margin: '0 0 8px' }}>AI assessment (not authoritative): {q.aiAssessment}</p>
                    )}
                    <label htmlFor={`marks-${q.questionId}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      Marks awarded:
                      <input
                        id={`marks-${q.questionId}`}
                        type="number"
                        min="0"
                        max={q.maxMarks}
                        style={{ maxWidth: 90 }}
                        value={marks[q.questionId] ?? ''}
                        onChange={(e) => setMarks((prev) => ({ ...prev, [q.questionId]: e.target.value }))}
                      />
                    </label>
                  </div>
                ))}
              </div>

              <div className="field-group-label">OCR'd text</div>
              {submission.pages.length > 0 ? (
                submission.pages.map((p) => (
                  <div key={p.page} className="panel" style={{ padding: 14, marginBottom: 10 }}>
                    <p className="auth-sub" style={{ margin: '0 0 6px' }}>Page {p.page} — confidence {Math.round((p.confidence || 0) * 100)}%</p>
                    <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'var(--font-sans)' }}>{p.text || '(no text recognized)'}</pre>
                  </div>
                ))
              ) : submission.status === 'pending' ? (
                <p className="auth-sub" style={{ margin: '0 0 20px' }}>OCR hasn't run yet — it starts automatically once the assignment's deadline passes, or use "Run OCR now" above to process it immediately.</p>
              ) : submission.status === 'processing' ? (
                <p className="auth-sub" style={{ margin: '0 0 20px' }}>OCR is running now — this can take a minute or two. Reload to check back.</p>
              ) : submission.status === 'ocr_failed' ? (
                <p className="auth-sub" style={{ margin: '0 0 20px' }}>OCR failed{submission.ocrError ? `: ${submission.ocrError}` : '.'} Please refer to the scanned pdf, or try "Run OCR now" again.</p>
              ) : (
                <p className="auth-sub" style={{ margin: '0 0 20px' }}>No text recognised. Please refer to the scanned pdf.</p>
              )}

              {saveMessage && <p className="auth-sub" style={{ margin: '0 0 8px' }}>{saveMessage}</p>}
              <div className="scan-capture-actions">
                <button type="button" className="btn btn-primary" onClick={saveGrade} disabled={saving}>
                  {saving && <span className="spinner" />}
                  {saving ? 'Saving…' : 'Save grade'}
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
