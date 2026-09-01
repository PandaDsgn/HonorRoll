import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import jscanify from 'jscanify/client';
import CodeMirror from '@uiw/react-codemirror';
import { CODE_LANGUAGES, getCodeMirrorExtension } from '../lib/codeLanguages';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import {
  PAGE_WIDTH, PAGE_HEIGHT, loadOpenCv, buildPdfBlob, fallbackCorners,
  detectCorners, detectCornersForPreview, applyScanFilter,
} from '../lib/scanCaptureCore';
import { CornerEditor, ReviewScreen } from '../components/ScanCaptureShared';
import { API } from '../config';
import './ScanCapture.css';
import '../Exam.css';

const CODING_LANGUAGES = CODE_LANGUAGES.map(({ id, label }) => ({ id, label }));
function getLanguageExtension(language) {
  return getCodeMirrorExtension(language);
}

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

function sanitizeFilenamePart(value) {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'NA';
}

function buildFilename(ctx) {
  const parts = [ctx.studentName, ctx.classPath, ctx.rollNumber, ctx.assignmentNo, ctx.subjectName].map(sanitizeFilenamePart);
  return `${parts.join('_')}.pdf`;
}

// Live camera scanner: detects and highlights a document's edges in the
// video feed in real time (jscanify, wrapping opencv.js), lets a student
// capture multiple pages — each confirmed via a draggable-corner crop
// editor rather than trusted blindly — review the full bundle, and upload
// it. See POST /api/problems/:id/scan-submit. No OCR happens yet; this
// phase only covers capture -> edit -> review -> upload.
export default function ScanCapture() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { theme, toggleTheme } = useTheme();

  // 'loading' -> 'already-submitted' (if a submission already exists — no
  // camera requested at all until the student explicitly chooses to
  // replace it) OR 'questions' (answer any mcq/short/long/coding questions
  // right here, then either scan/upload a PDF for the scan-type ones, or —
  // if there aren't any — submit directly) -> EITHER 'scanning' ->
  // 'editing' (per-capture crop) -> 'scanning' (repeat) -> 'reviewing' ->
  // 'uploading' OR 'upload-review' (a PDF picked from elsewhere, awaiting
  // confirm) -> 'upload-submitting' -> 'done', or 'error' at any point
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [scanContext, setScanContext] = useState(null);
  const [existingSubmission, setExistingSubmission] = useState(null);
  const [pages, setPages] = useState([]); // final cropped/warped data URLs
  const [captureError, setCaptureError] = useState('');
  const [uploadResult, setUploadResult] = useState(null);
  const [rawCapture, setRawCapture] = useState(null); // { url, corners } — awaiting crop confirmation
  const [uploadedFile, setUploadedFile] = useState(null); // File chosen via the "upload a PDF" path
  const [uploadFileError, setUploadFileError] = useState('');
  const fileInputRef = useRef(null);

  // Answers for mcq/short/long/coding questions — keyed by question id,
  // same shape ExamAttempt.jsx uses. scan-type questions never appear here
  // at all (they're answered on paper, not through this form).
  const [answers, setAnswers] = useState({});
  const [runResults, setRunResults] = useState({});
  const digitalQuestions = (scanContext?.questions || []).filter((q) => q.type !== 'scan');
  const scanQuestions = (scanContext?.questions || []).filter((q) => q.type === 'scan');

  const updateAnswer = (questionId, patch) => {
    setAnswers((prev) => ({ ...prev, [questionId]: { ...prev[questionId], ...patch } }));
  };

  const buildAnswersArray = () => digitalQuestions.map((q) => ({ questionId: q.id, ...answers[q.id] }));

  const runCodingQuestion = async (q) => {
    const ans = answers[q.id];
    if (!ans?.code || runResults[q.id]?.status === 'running') return;
    setRunResults((prev) => ({ ...prev, [q.id]: { status: 'running', results: [] } }));
    const results = [];
    for (const sample of q.samples || []) {
      try {
        const res = await axios.post(`${API}/api/execute/${ans.language}`, { code: ans.code, stdin: sample.input }, { withCredentials: true });
        const out = (res.data.output || '').trim().replace(/\r\n/g, '\n');
        const exp = (sample.expected_output || '').trim().replace(/\r\n/g, '\n');
        results.push({ input: sample.input, expected: sample.expected_output, actual: res.data.output, pass: out === exp });
      } catch (err) {
        results.push({ input: sample.input, expected: sample.expected_output, actual: err.response?.data?.error || 'Execution failed', pass: false });
      }
    }
    setRunResults((prev) => ({ ...prev, [q.id]: { status: 'done', results } }));
  };
  // Surfaces what the live-highlight loop is actually seeing — readyState,
  // frame dimensions, last error — since there's no way to reach a phone's
  // devtools console mid-test. Safe to remove once the camera pipeline is
  // confirmed working reliably across devices.
  const [debugInfo, setDebugInfo] = useState('');

  const videoRef = useRef(null);
  const displayCanvasRef = useRef(null);
  // opencv.js's cv.imread() (which jscanify calls internally) only accepts
  // a canvas, an image element, or an element id string — NOT a raw
  // HTMLVideoElement, despite jscanify's own highlightPaper/extractPaper
  // JSDoc examples showing a plain "image" parameter. Every real jscanify
  // example (including its own README) draws the current video frame onto
  // an intermediate canvas first and passes THAT in — this hidden canvas is
  // that intermediate step, reused for both the live-highlight loop and
  // actual page capture so there's exactly one place the video->canvas
  // frame grab happens.
  const captureCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const scannerRef = useRef(null);

  // Requests the camera and wires it to the (already-mounted, see the JSX
  // note further down) video element — split out from the setup effect so
  // it can be triggered either immediately (no existing submission) or
  // later, only once the student explicitly chooses "Submit a replacement"
  // on the already-submitted screen. A cancelled ref-check mirrors the
  // pattern the old inline version used, just callable from two places now.
  const startCamera = useCallback(async (cancelledRef) => {
    try {
      const localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
      if (cancelledRef.current) {
        localStream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = localStream;
      if (videoRef.current) {
        videoRef.current.srcObject = localStream;
        await videoRef.current.play();
      }
      if (!cancelledRef.current) setPhase('scanning');
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err.response?.data?.error || err.message || 'Failed to start the scanner.');
      setPhase('error');
    }
  }, []);

  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    (async () => {
      try {
        setPhase('loading');
        const [ctxRes, subRes] = await Promise.all([
          axios.get(`${API}/api/me/scan-context`, { params: { problemId: id }, withCredentials: true }),
          axios.get(`${API}/api/me/scan-submission`, { params: { problemId: id }, withCredentials: true }),
          loadOpenCv(),
        ]);
        if (cancelledRef.current) return;
        setScanContext(ctxRes.data);
        scannerRef.current = new jscanify();

        const initialAnswers = {};
        (ctxRes.data.questions || []).forEach((q) => {
          if (q.type === 'mcq') initialAnswers[q.id] = { selectedOptionId: null };
          else if (q.type === 'coding') {
            const firstLang = Object.keys(q.starterCode || {})[0] || 'python';
            initialAnswers[q.id] = { language: firstLang, code: q.starterCode?.[firstLang] || '' };
          } else if (q.type === 'short' || q.type === 'long') {
            initialAnswers[q.id] = { textAnswer: '' };
          }
        });
        setAnswers(initialAnswers);

        if (subRes.data.submission) {
          setExistingSubmission(subRes.data.submission);
          setPhase('already-submitted');
          return;
        }

        setPhase('questions');
      } catch (err) {
        if (cancelledRef.current) return;
        setError(err.response?.data?.error || err.message || 'Failed to start the scanner.');
        setPhase('error');
      }
    })();

    return () => {
      cancelledRef.current = true;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, [id, startCamera]);

  // "Submit a replacement" on the already-submitted screen — back to the
  // questions screen first, same as the no-existing-submission path above,
  // rather than jumping straight into the camera.
  const handleReplaceSubmission = () => {
    setExistingSubmission(null);
    setUploadedFile(null);
    setPhase('questions');
  };

  const handleStartScanning = () => startCamera(cancelledRef);

  // "Upload a PDF" path — a scan produced elsewhere (a phone scanning app,
  // a flatbed scanner) rather than HonorRoll's own in-browser camera flow.
  // Never touches the camera/jscanify pipeline at all; the file goes
  // straight to review, then straight to the server as-is.
  const handleChooseFile = () => fileInputRef.current?.click();

  const handleFileSelected = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file after "choose a different file"
    if (!file) return;
    if (file.type !== 'application/pdf') {
      setUploadFileError('That file isn\'t a PDF — please choose a .pdf file.');
      return;
    }
    setUploadFileError('');
    setError('');
    setUploadedFile(file);
    setPhase('upload-review');
  };

  const handleUploadFile = async () => {
    if (!uploadedFile || !scanContext) return;
    setPhase('upload-submitting');
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', uploadedFile, buildFilename(scanContext));
      formData.append('filename', buildFilename(scanContext));
      formData.append('answers', JSON.stringify(buildAnswersArray()));
      const res = await axios.post(`${API}/api/problems/${id}/scan-submit`, formData, { withCredentials: true });
      setUploadResult(res.data);
      setPhase('done');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to upload your scanned submission.');
      setPhase('upload-review');
    }
  };

  // Snapshots the current video frame onto the hidden intermediate canvas
  // and returns it — the only thing ever passed to jscanify/cv.imread, per
  // the note on captureCanvasRef above. Returns null if the video has no
  // frame ready yet.
  const grabFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || video.readyState < 2 || video.videoWidth === 0) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }, []);

  // Live edge-detection overlay — draws the raw frame plus a highlighted
  // quadrilateral onto the visible canvas roughly every 3rd animation frame
  // (~20fps at 60Hz), since full contour detection on every single frame is
  // unnecessary CPU/battery cost for a highlight that only needs to look
  // responsive, not perfectly smooth.
  //
  // Deliberately NOT using jscanify's highlightPaper() directly — it redraws
  // from a fresh, independent detection every call with no memory of the
  // previous frame, so tiny per-frame noise (lighting flicker, hand shake)
  // made the box visibly jump to a different quadrilateral several times a
  // second. detectCorners() is called directly instead so the corners can
  // be smoothed with an exponential moving average before drawing — each
  // new detection nudges the displayed box toward it rather than snapping,
  // and a short miss-streak grace period (MAX_MISSES) keeps the box in
  // place through a momentary dropout instead of flickering it away.
  useEffect(() => {
    if (phase !== 'scanning') return undefined;
    let rafId;
    let frameCount = 0;
    let smoothedCorners = null;
    let missStreak = 0;
    const SMOOTH_ALPHA = 0.3;
    const MAX_MISSES = 6;
    const blend = (a, b) => ({ x: a.x + (b.x - a.x) * SMOOTH_ALPHA, y: a.y + (b.y - a.y) * SMOOTH_ALPHA });

    const tick = () => {
      frameCount += 1;
      const video = videoRef.current;
      const canvas = displayCanvasRef.current;
      if (frameCount % 15 === 0) {
        setDebugInfo(video ? `readyState=${video.readyState} size=${video.videoWidth}x${video.videoHeight} paused=${video.paused}` : 'no video element');
      }
      if (frameCount % 3 === 0 && canvas && scannerRef.current) {
        const frame = grabFrame();
        if (frame) {
          try {
            const detected = detectCornersForPreview(scannerRef.current, frame);
            if (detected) {
              missStreak = 0;
              smoothedCorners = smoothedCorners
                ? {
                    topLeftCorner: blend(smoothedCorners.topLeftCorner, detected.topLeftCorner),
                    topRightCorner: blend(smoothedCorners.topRightCorner, detected.topRightCorner),
                    bottomLeftCorner: blend(smoothedCorners.bottomLeftCorner, detected.bottomLeftCorner),
                    bottomRightCorner: blend(smoothedCorners.bottomRightCorner, detected.bottomRightCorner),
                  }
                : detected;
            } else {
              missStreak += 1;
              if (missStreak > MAX_MISSES) smoothedCorners = null;
            }

            canvas.width = frame.width;
            canvas.height = frame.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(frame, 0, 0);
            if (smoothedCorners) {
              const c = smoothedCorners;
              ctx.strokeStyle = 'orange';
              ctx.lineWidth = 6;
              ctx.beginPath();
              ctx.moveTo(c.topLeftCorner.x, c.topLeftCorner.y);
              ctx.lineTo(c.topRightCorner.x, c.topRightCorner.y);
              ctx.lineTo(c.bottomRightCorner.x, c.bottomRightCorner.y);
              ctx.lineTo(c.bottomLeftCorner.x, c.bottomLeftCorner.y);
              ctx.closePath();
              ctx.stroke();
            }
          } catch (err) {
            setDebugInfo(`detection error: ${err.message || err}`);
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [phase, grabFrame]);

  // Capturing no longer crops immediately — it freezes the raw frame,
  // seeds the corner editor with jscanify's own best-guess quadrilateral
  // (or the full frame edges if nothing was detected at all, so there's
  // always something to drag), and hands off to <CornerEditor>. The actual
  // crop only happens once the student confirms there.
  const handleCapture = useCallback(() => {
    setCaptureError('');
    if (!scannerRef.current) return;
    const frame = grabFrame();
    if (!frame) {
      setCaptureError("Camera feed isn't ready yet — wait a moment and try again.");
      return;
    }
    try {
      const detected = detectCorners(scannerRef.current, frame);
      const corners = detected || fallbackCorners(frame.width, frame.height);
      setRawCapture({ url: frame.toDataURL('image/jpeg', 0.92), corners });
      setPhase('editing');
    } catch (err) {
      setCaptureError(`Failed to capture this page: ${err.message || err}`);
    }
  }, [grabFrame]);

  const confirmCrop = useCallback((corners) => {
    const img = new Image();
    img.onload = () => {
      try {
        const extracted = scannerRef.current.extractPaper(img, PAGE_WIDTH, PAGE_HEIGHT, corners);
        if (extracted) {
          applyScanFilter(extracted);
          setPages((prev) => [...prev, extracted.toDataURL('image/jpeg', 0.92)]);
        } else {
          setCaptureError('Failed to crop this page — try capturing it again.');
        }
      } catch (err) {
        setCaptureError(`Failed to crop this page: ${err.message || err}`);
      } finally {
        setRawCapture(null);
        setPhase('scanning');
      }
    };
    img.src = rawCapture.url;
  }, [rawCapture]);

  const retakeCapture = () => {
    setRawCapture(null);
    setPhase('scanning');
  };

  const removePage = (idx) => setPages((prev) => prev.filter((_, i) => i !== idx));

  const handleUpload = async () => {
    if (pages.length === 0 || !scanContext) return;
    setPhase('uploading');
    setError('');
    try {
      const blob = buildPdfBlob(pages);
      const filename = buildFilename(scanContext);
      const formData = new FormData();
      formData.append('file', blob, filename);
      formData.append('filename', filename);
      formData.append('answers', JSON.stringify(buildAnswersArray()));
      const res = await axios.post(`${API}/api/problems/${id}/scan-submit`, formData, { withCredentials: true });
      setUploadResult(res.data);
      setPhase('done');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to upload your scanned submission.');
      setPhase('reviewing');
    }
  };

  // For a scan-mode assignment with NO scan-type questions at all (every
  // question is mcq/short/long/coding) — no PDF ever needed, just the
  // answers. No 'file' field in the FormData at all; the backend only
  // requires one when the assignment actually has scan-type questions.
  const handleSubmitDigitalOnly = async () => {
    if (!scanContext) return;
    setPhase('upload-submitting');
    setError('');
    try {
      const formData = new FormData();
      formData.append('answers', JSON.stringify(buildAnswersArray()));
      const res = await axios.post(`${API}/api/problems/${id}/scan-submit`, formData, { withCredentials: true });
      setUploadResult(res.data);
      setPhase('done');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to submit.');
      setPhase('questions');
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
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/assignments')}>&larr; Back to assignments</button>
        </div>

        <div className="panel scan-capture-panel">
          {/* This route serves BOTH a purely-digital assignment (every
              question mcq/short/long/coding, no camera ever involved) and a
              mixed one with an actual paper-scan question — "Scan & submit"
              only makes sense for the latter, so the heading is generic
              until scanContext confirms there's a scan-type question at
              all (scanQuestions is [] both before scanContext loads and for
              a genuinely scan-less assignment, so this reads correctly in
              every phase, not just 'questions'). */}
          <h2 style={{ margin: '0 0 8px' }}>{scanQuestions.length > 0 ? 'Scan & submit' : 'Submit assignment'}</h2>

          {phase === 'loading' && <p className="sb-loading">Starting the scanner…</p>}

          {phase === 'error' && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{error}</span>
            </div>
          )}

          {phase === 'already-submitted' && existingSubmission && (
            <div>
              <div className="alert alert-success" role="status" style={{ marginBottom: 16 }}>
                <span className="alert-icon">✓</span>
                <span>
                  Submitted {formatScanDate(existingSubmission.createdAt)} — status: {formatScanStatus(existingSubmission.status)}
                  {existingSubmission.ocrError && ` (${existingSubmission.ocrError})`}
                </span>
              </div>
              <div className="scan-capture-actions">
                {existingSubmission.viewUrl && (
                  <a className="btn btn-ghost" href={existingSubmission.viewUrl} target="_blank" rel="noreferrer">
                    View my submission
                  </a>
                )}
                <button type="button" className="btn btn-primary" onClick={handleReplaceSubmission}>
                  Submit a replacement
                </button>
              </div>
              <p className="auth-sub" style={{ marginTop: 12 }}>
                Submitting a replacement will permanently discard your current submission — only your latest one is ever kept.
              </p>
            </div>
          )}

          {phase === 'questions' && scanContext && (
            <div>
              <p className="auth-sub" style={{ margin: '0 0 12px' }}>
                {scanQuestions.length > 0
                  ? "Answer anything below that isn't on paper first — you won't be able to see this again once the camera opens."
                  : 'Answer every question below, then submit.'}
              </p>

              {scanQuestions.length > 0 && (
                <p className="auth-sub" style={{ margin: '0 0 12px' }}>
                  Note: your scanned page is submitted together with the rest of your answers, but it's read and graded afterward — that part of your result may take a little longer to appear than the rest.
                </p>
              )}

              {(scanContext.questions || []).map((q, idx) => {
                const ans = answers[q.id] || {};
                return (
                  <div className="panel exam-take-item" key={q.id} style={{ marginBottom: 14 }}>
                    <div className="exam-take-item-head">
                      <span className="exam-item-index">Question {idx + 1}</span>
                      <span className="chip chip-neutral"><span className="dot" />{q.marks} marks</span>
                    </div>

                    {q.prompt && <p className="exam-take-prompt">{q.prompt}</p>}

                    {q.type === 'scan' && (
                      <p className="auth-sub">Answer this on paper — you'll scan it in below.</p>
                    )}

                    {q.type === 'mcq' && (
                      <div className="exam-mcq-options">
                        {(q.options || []).map((o) => (
                          <label className="exam-mcq-option" key={o.id}>
                            <input
                              type="radio"
                              name={`scan-q-${q.id}`}
                              checked={ans.selectedOptionId === o.id}
                              onChange={() => updateAnswer(q.id, { selectedOptionId: o.id })}
                            />
                            <span>{o.text}</span>
                          </label>
                        ))}
                      </div>
                    )}

                    {(q.type === 'short' || q.type === 'long') && (
                      <div className="field">
                        <textarea
                          rows={q.type === 'long' ? 6 : 3}
                          value={ans.textAnswer || ''}
                          onChange={(e) => updateAnswer(q.id, { textAnswer: e.target.value })}
                        />
                        {q.wordLimit && (
                          <span className="exam-word-count">
                            {(ans.textAnswer || '').trim().split(/\s+/).filter(Boolean).length} / {q.wordLimit} words
                          </span>
                        )}
                      </div>
                    )}

                    {q.type === 'coding' && (
                      <div className="exam-coding-item">
                        <select
                          aria-label="Language"
                          className="language-select"
                          value={ans.language || ''}
                          onChange={(e) => updateAnswer(q.id, { language: e.target.value, code: q.starterCode?.[e.target.value] || '' })}
                        >
                          {CODING_LANGUAGES.map((l) => (
                            <option key={l.id} value={l.id}>{l.label}</option>
                          ))}
                        </select>

                        <div className="editor-panel lc-editor exam-editor">
                          <CodeMirror
                            value={ans.code || ''}
                            height="220px"
                            theme={theme === 'light' ? 'light' : 'dark'}
                            extensions={getLanguageExtension(ans.language)}
                            onChange={(val) => updateAnswer(q.id, { code: val })}
                          />
                        </div>

                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => runCodingQuestion(q)} disabled={runResults[q.id]?.status === 'running'}>
                          {runResults[q.id]?.status === 'running' ? <span className="spinner" /> : null} Run against samples
                        </button>

                        {runResults[q.id]?.status === 'done' && (
                          <div className="exam-run-results">
                            {runResults[q.id].results.map((r, i) => (
                              <div key={i} className={`exam-run-case ${r.pass ? 'pass' : 'fail'}`}>
                                <span className="chip chip-neutral">Sample {i + 1}: {r.pass ? 'Passed' : 'Failed'}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {uploadFileError && (
                <div className="alert" role="alert" style={{ marginBottom: 12 }}>
                  <span className="alert-icon">!</span>
                  <span>{uploadFileError}</span>
                </div>
              )}
              {error && (
                <div className="alert" role="alert" style={{ marginBottom: 12 }}>
                  <span className="alert-icon">!</span>
                  <span>{error}</span>
                </div>
              )}

              <div className="scan-capture-actions">
                {scanQuestions.length > 0 ? (
                  <>
                    <button type="button" className="btn btn-primary" onClick={handleStartScanning}>Scan with camera</button>
                    <button type="button" className="btn btn-ghost" onClick={handleChooseFile}>Upload a scanned PDF</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={handleSubmitDigitalOnly}>
                    Submit
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Always mounted (hidden) so handleChooseFile's ref.click() works
              regardless of phase — same reasoning as the video element below. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            style={{ display: 'none' }}
            onChange={handleFileSelected}
          />

          {phase === 'upload-review' && uploadedFile && (
            <div>
              <p className="auth-sub" style={{ margin: '0 0 12px' }}>
                Ready to submit this file as your scanned answer sheet.
              </p>
              {error && (
                <div className="alert" role="alert" style={{ marginBottom: 12 }}>
                  <span className="alert-icon">!</span>
                  <span>{error}</span>
                </div>
              )}
              <div className="scan-review-page" style={{ maxWidth: 320 }}>
                <div className="scan-review-page-footer">
                  <span className="chip chip-neutral"><span className="dot" />{uploadedFile.name}</span>
                  <span className="auth-sub">{(uploadedFile.size / (1024 * 1024)).toFixed(1)} MB</span>
                </div>
              </div>
              <div className="scan-capture-actions">
                <button type="button" className="btn btn-ghost" onClick={handleChooseFile}>Choose a different file</button>
                <button type="button" className="btn btn-primary" onClick={handleUploadFile}>Submit</button>
              </div>
            </div>
          )}

          {phase === 'upload-submitting' && (
            <p className="sb-loading"><span className="spinner" /> Submitting…</p>
          )}

          {/* Always mounted, regardless of phase — the setup effect attaches
              the camera stream to this video element while phase is still
              'loading' (before the async getUserMedia call even resolves),
              so the ref must already exist by then. Conditionally rendering
              this under a phase check left videoRef.current null at attach
              time, silently no-opping the stream attach — the actual cause
              of a permanently black preview / readyState stuck at 0 during
              phone testing. Hidden via CSS, not JSX unmounting, whenever
              it's not the active view. */}
          <div className="scan-capture-video-wrap" style={{ display: phase === 'scanning' ? 'block' : 'none' }}>
            <video ref={videoRef} className="scan-capture-video-hidden" autoPlay muted playsInline />
            <canvas ref={displayCanvasRef} className="scan-capture-canvas" />
          </div>
          {/* Never displayed — the intermediate video-frame->canvas snapshot
              grabFrame() draws into, since cv.imread() rejects a raw video
              element. Doesn't need to be mounted unconditionally like the
              video/canvas above since nothing attaches a stream to it directly. */}
          <canvas ref={captureCanvasRef} style={{ display: 'none' }} />

          {phase === 'scanning' && (
            <>
              <p className="auth-sub" style={{ margin: '0 0 12px' }}>
                Line the page up within the frame, then capture — you'll get a chance to adjust the crop next.
              </p>

              {debugInfo && <p className="auth-sub" style={{ margin: '8px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{debugInfo}</p>}

              {captureError && (
                <div className="alert" role="alert" style={{ marginTop: 12 }}>
                  <span className="alert-icon">!</span>
                  <span>{captureError}</span>
                </div>
              )}

              <div className="scan-capture-actions">
                <button type="button" className="btn btn-primary" onClick={handleCapture}>Capture page</button>
                {pages.length > 0 && (
                  <button type="button" className="btn btn-primary" onClick={() => setPhase('reviewing')}>
                    Review {pages.length} page{pages.length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            </>
          )}

          {phase === 'editing' && rawCapture && (
            <CornerEditor
              rawFrameUrl={rawCapture.url}
              initialCorners={rawCapture.corners}
              onConfirm={confirmCrop}
              onRetake={retakeCapture}
            />
          )}

          {(phase === 'reviewing' || phase === 'uploading') && (
            <>
              {error && (
                <div className="alert" role="alert" style={{ marginBottom: 12 }}>
                  <span className="alert-icon">!</span>
                  <span>{error}</span>
                </div>
              )}
              <ReviewScreen
                pages={pages}
                onRemove={removePage}
                onAddMore={() => setPhase('scanning')}
                onSubmit={handleUpload}
                submitting={phase === 'uploading'}
              />
            </>
          )}

          {phase === 'done' && (
            <div className="alert alert-success" role="status">
              <span className="alert-icon">✓</span>
              <span>Submitted — status: {formatScanStatus(uploadResult?.status || 'pending')}. Your teacher will grade it once it's processed.</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
