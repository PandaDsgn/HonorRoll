import { useState, useEffect, useCallback, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { formatDate, formatScanStatus } from './format';
import { API } from '../../config';

// OCR isn't instrumented with real per-page progress (processOneScanSubmission
// runs start-to-finish in one call, no incremental status updates), so this
// is an honest elapsed-time estimate against OCR_SPACE_ID's ~60s GPU budget
// (see ocr-space/app.py's @spaces.GPU(duration=60)), not a lie about exact
// completion — capped short of 100% so it never claims "done" while the row
// is still genuinely 'processing'. Ticks every second via its own timer
// rather than polling the server, since only the ring needs to animate —
// the surrounding table re-fetches on its own schedule when it matters
// (status actually changing). Color runs red (just started) to green
// (about to finish); the "Processing" label next to it stays plain text
// deliberately, so pace context comes from the ring, not from re-coloring
// words on every render.
const OCR_EXPECTED_MS = 60_000;
function ScanProgressRing({ processingStartedAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const startedMs = processingStartedAt ? new Date(processingStartedAt).getTime() : now;
  const elapsedMs = Math.max(0, now - startedMs);
  const pct = Math.min(95, (elapsedMs / OCR_EXPECTED_MS) * 100);
  const hue = (pct / 100) * 120; // 0 = red, 120 = green
  const radius = 8;
  const circumference = 2 * Math.PI * radius;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <svg width="20" height="20" viewBox="0 0 20 20" style={{ flexShrink: 0 }} aria-hidden="true">
        <circle cx="10" cy="10" r={radius} fill="none" stroke="var(--border-strong)" strokeWidth="3" />
        <circle
          cx="10" cy="10" r={radius} fill="none"
          stroke={`hsl(${hue}, 75%, 50%)`}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          transform="rotate(-90 10 10)"
          style={{ transition: 'stroke-dashoffset 0.8s linear, stroke 0.8s linear' }}
        />
      </svg>
      <span>Processing</span>
    </span>
  );
}

// Lazily fetches one submission's full detail and renders the plain
// recognized text — a quick "what did OCR actually read" check, separate
// from ScanReview's full grading view. Concatenates pages in order rather
// than showing per-page confidence scores (ScanReview already covers that
// detail); a teacher opening this just wants to read the text. Message
// differs by status rather than always assuming OCR already ran — with the
// deadline-gated sweep, "pending"/"processing" are the normal state for a
// while, not a failure, so it shouldn't look like the same "nothing found"
// outcome as an ocr_done row with empty pages.
function ScanExtractedText({ submissionId }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    axios.get(`${API}/api/admin/scan-submissions/${submissionId}`, { withCredentials: true })
      .then((res) => { if (!cancelled) setDetail(res.data); })
      .catch(() => { if (!cancelled) setError('Failed to load extracted text.'); });
    return () => { cancelled = true; };
  }, [submissionId]);

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!detail) return <p className="sb-loading" style={{ margin: '12px 0' }}>Loading extracted text…</p>;

  if (detail.status === 'pending') {
    return <p className="auth-sub" style={{ margin: '12px 0' }}>OCR hasn't run yet — it starts automatically once the assignment's deadline passes, or use "Run OCR now" to process it immediately.</p>;
  }
  if (detail.status === 'processing') {
    return <p className="auth-sub" style={{ margin: '12px 0' }}>OCR is running now — this can take a minute or two.</p>;
  }
  if (detail.status === 'ocr_failed') {
    return <p className="auth-sub" style={{ margin: '12px 0' }}>OCR failed{detail.ocrError ? `: ${detail.ocrError}` : '.'} Please refer to the scanned pdf, or try "Run OCR now" again.</p>;
  }

  const combinedText = (detail.pages || []).map((p) => p.text || '').join('\n\n').trim();
  if (!combinedText) {
    return (
      <p className="auth-sub" style={{ margin: '12px 0' }}>
        {detail.viewUrl ? 'No text recognised. Please refer to the scanned pdf.' : 'This assignment has no scanned questions — nothing to OCR.'}
      </p>
    );
  }

  return (
    <pre style={{ whiteSpace: 'pre-wrap', margin: '12px 0', fontFamily: 'var(--font-sans)' }}>{combinedText}</pre>
  );
}

// Lets a teacher upload a PDF on a student's behalf (e.g. a paper answer
// sheet scanned elsewhere, never touching the in-browser camera capture
// flow) instead of waiting for the student to submit themselves. Whatever
// the picked file is named is irrelevant to how it's stored server-side —
// see the backend route's own comment — this form doesn't expose or let
// the admin choose a filename at all, only which student it's for.
function AdminScanUploadForm({ problemId, onUploaded }) {
  const [email, setEmail] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !file) return;
    setBusy(true);
    setMessage('');
    try {
      const formData = new FormData();
      formData.append('email', email.trim());
      formData.append('file', file);
      await axios.post(`${API}/api/admin/problems/${problemId}/scan-submissions`, formData, { withCredentials: true });
      setMessage('Uploaded — OCR starting now.');
      setEmail('');
      setFile(null);
      e.target.reset();
      onUploaded();
    } catch (err) {
      setMessage(err.response?.data?.error || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
      <input
        type="email"
        placeholder="Student's email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-h)' }}
      />
      <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files[0] || null)} required />
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
        {busy && <span className="spinner" />}
        {busy ? 'Uploading…' : 'Upload PDF for student'}
      </button>
      {message && <span className="auth-sub">{message}</span>}
    </form>
  );
}

// Every student's scan submission for one scan-mode assignment — at most
// one row per student (a resubmission replaces the previous one outright,
// see POST /api/problems/:id/scan-submit), so unlike AssignmentAttemptsPanel
// above there's no "best of several" to pick, just each student's final
// upload.
export function ScanSubmissionsPanel({ problemId }) {
  const navigate = useNavigate();
  const [submissions, setSubmissions] = useState(null);
  const [hasScanQuestions, setHasScanQuestions] = useState(false);
  const [error, setError] = useState('');
  const [expandedTextId, setExpandedTextId] = useState(null);
  const [processingId, setProcessingId] = useState(null);

  const fetchSubmissions = useCallback(() => {
    axios.get(`${API}/api/admin/problems/${problemId}/scan-submissions`, { withCredentials: true })
      .then((res) => { setSubmissions(res.data.submissions); setHasScanQuestions(res.data.hasScanQuestions); })
      .catch(() => setError('Failed to load submissions.'));
  }, [problemId]);

  useEffect(() => { fetchSubmissions(); }, [fetchSubmissions]);

  // While anything's still 'processing', poll for completion — otherwise
  // the ring above stays stuck showing "Processing" until some unrelated
  // action (mount, an upload, "Run OCR now") happens to refetch the table.
  useEffect(() => {
    if (!submissions?.some((s) => s.status === 'processing')) return undefined;
    const timer = setInterval(fetchSubmissions, 3000);
    return () => clearInterval(timer);
  }, [submissions, fetchSubmissions]);

  const runOcrNow = async (submissionId) => {
    setProcessingId(submissionId);
    try {
      await axios.post(`${API}/api/admin/scan-submissions/${submissionId}/process`, {}, { withCredentials: true });
      fetchSubmissions();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start OCR.');
    } finally {
      setProcessingId(null);
    }
  };

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!submissions) return <p className="sb-loading" style={{ margin: '16px 0' }}>Loading submissions…</p>;

  return (
    <>
      <AdminScanUploadForm problemId={problemId} onUploaded={fetchSubmissions} />
      {submissions.length === 0 ? (
        <p className="sb-loading" style={{ margin: '16px 0' }}>No submissions yet.</p>
      ) : (
        <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Student</th>
              {hasScanQuestions && <th>Status</th>}
              <th>Marks</th>
              <th>Submitted</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {submissions.map((s) => (
              <Fragment key={s.id}>
                <tr>
                  <td className="admin-cell-strong">
                    {s.name || s.email}
                    {s.name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{s.email}</div>}
                  </td>
                  {hasScanQuestions && (
                    <td>
                      {s.status === 'processing' ? (
                        <ScanProgressRing processingStartedAt={s.processingStartedAt} />
                      ) : (
                        <span className={`chip ${s.status === 'ocr_done' ? 'chip-easy' : s.status === 'ocr_failed' ? 'chip-hard' : 'chip-medium'}`}>
                          <span className="dot" />{formatScanStatus(s.status)}
                        </span>
                      )}
                    </td>
                  )}
                  <td>
                    {s.fullyGraded ? `${s.awardedMarks}/${s.totalMarks}` : `—/${s.totalMarks}`}
                    {s.penalized && <span className="chip chip-hard" style={{ marginLeft: 6 }}>penalized</span>}
                  </td>
                  <td>{formatDate(s.createdAt)}</td>
                  <td className="admin-cell-actions">
                    {s.viewUrl && <a className="btn btn-ghost btn-sm" href={s.viewUrl} target="_blank" rel="noreferrer">View PDF</a>}
                    {hasScanQuestions && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpandedTextId(expandedTextId === s.id ? null : s.id)}>
                        {expandedTextId === s.id ? 'Hide text' : 'View text'}
                      </button>
                    )}
                    {hasScanQuestions && s.status !== 'processing' && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={processingId === s.id} onClick={() => runOcrNow(s.id)}>
                        {processingId === s.id && <span className="spinner" />}
                        {s.status === 'ocr_done' ? 'Run OCR again' : 'Run OCR now'}
                      </button>
                    )}
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`/admin/scan-submissions/${s.id}`)}>Grade</button>
                  </td>
                </tr>
                {expandedTextId === s.id && (
                  <tr>
                    <td colSpan={hasScanQuestions ? 5 : 4} style={{ background: 'var(--surface-2)' }}>
                      <ScanExtractedText submissionId={s.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}
