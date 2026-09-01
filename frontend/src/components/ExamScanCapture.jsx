import { useState, useEffect, useRef, useCallback } from 'react';
import jscanify from 'jscanify/client';
import {
  PAGE_WIDTH, PAGE_HEIGHT, loadOpenCv, buildPdfBlob, fallbackCorners,
  detectCorners, detectCornersForPreview, applyScanFilter,
} from '../lib/scanCaptureCore';
import { CornerEditor, ReviewScreen } from './ScanCaptureShared';
import '../pages/ScanCapture.css';

// The exam-taking counterpart to ScanCapture.jsx's camera flow — same
// capture -> corner-edit -> review -> one-compiled-PDF pipeline (see
// ../lib/scanCaptureCore.js and ./ScanCaptureShared.jsx for the shared
// pieces), but self-contained rather than a full routed page: ExamAttempt
// mounts this directly once every on-screen item is answered and there's
// at least one scan-type item left to cover, and it hands the finished
// Blob back via onDone rather than uploading anything itself — ExamAttempt
// owns the actual POST /api/exams/:id/scan-submit call and the sequencing
// with ending the attempt afterward.
//
// Deliberately doesn't have ScanCapture's "read the questions first" or
// "already submitted" screens — the exam flow already showed every item's
// prompt on-screen, and there's no prior submission to ever collide with.
//
// onDone is awaited here (must return a Promise that rejects on failure) —
// same "try the async call, drop back to reviewing on catch" pattern
// ScanCapture.jsx's own handleUpload uses, just with the actual network
// call living in the parent (ExamAttempt owns sequencing the upload with
// ending the attempt afterward) instead of inline.
export default function ExamScanCapture({ items, onDone }) {
  // 'loading' -> 'scanning' -> 'editing' (per-capture crop) -> 'scanning'
  // (repeat) -> 'reviewing' -> 'submitting', or 'error' if the camera/
  // scanner engine itself never came up.
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [pages, setPages] = useState([]);
  const [captureError, setCaptureError] = useState('');
  const [rawCapture, setRawCapture] = useState(null);
  const [debugInfo, setDebugInfo] = useState('');

  const videoRef = useRef(null);
  const displayCanvasRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const scannerRef = useRef(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    (async () => {
      try {
        await loadOpenCv();
        if (cancelledRef.current) return;
        scannerRef.current = new jscanify();
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
        setError(err.message || 'Failed to start the scanner.');
        setPhase('error');
      }
    })();

    return () => {
      cancelledRef.current = true;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const grabFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || video.readyState < 2 || video.videoWidth === 0) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }, []);

  // Live edge-detection overlay — see ScanCapture.jsx's own copy of this
  // effect for the full reasoning on the smoothing/miss-streak logic.
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
        setDebugInfo(video ? `readyState=${video.readyState} size=${video.videoWidth}x${video.videoHeight}` : 'no video element');
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

  const handleSubmit = async () => {
    setPhase('submitting');
    setUploadError('');
    try {
      await onDone(buildPdfBlob(pages));
    } catch (err) {
      setPhase('reviewing');
      setUploadError(err.message || 'Failed to submit — you can try again.');
    }
  };

  const totalMarks = items.reduce((sum, it) => sum + (Number(it.marks) || 0), 0);

  return (
    <div className="panel scan-capture-panel">
      <h2 style={{ margin: '0 0 8px' }}>Scan your handwritten answers</h2>
      <p className="auth-sub" style={{ margin: '0 0 12px' }}>
        {items.length} item{items.length === 1 ? '' : 's'} to scan, {totalMarks} marks total — every page you capture here goes into one combined PDF for your teacher to grade.
      </p>
      <ol className="scan-question-list" style={{ marginBottom: 16 }}>
        {items.map((it, idx) => (
          <li key={it.id} className="scan-question-item">
            <span>{idx + 1}. {it.prompt}</span>
            <span className="chip chip-neutral">{it.marks} marks</span>
          </li>
        ))}
      </ol>

      {phase === 'loading' && <p className="sb-loading">Starting the scanner…</p>}

      {phase === 'error' && (
        <div className="alert" role="alert">
          <span className="alert-icon">!</span>
          <span>{error}</span>
        </div>
      )}

      <div className="scan-capture-video-wrap" style={{ display: phase === 'scanning' ? 'block' : 'none' }}>
        <video ref={videoRef} className="scan-capture-video-hidden" autoPlay muted playsInline />
        <canvas ref={displayCanvasRef} className="scan-capture-canvas" />
      </div>
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
            {pages.length === 0 && (
              <button type="button" className="btn btn-ghost" onClick={() => onDone(null)}>
                Skip — submit exam without scanned pages
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

      {(phase === 'reviewing' || phase === 'submitting') && (
        <>
          {uploadError && (
            <div className="alert" role="alert" style={{ marginBottom: 12 }}>
              <span className="alert-icon">!</span>
              <span>{uploadError}</span>
            </div>
          )}
          <ReviewScreen
            pages={pages}
            onRemove={removePage}
            onAddMore={() => setPhase('scanning')}
            onSubmit={handleSubmit}
            submitting={phase === 'submitting'}
            submitLabel={`Submit exam with ${pages.length} scanned page${pages.length === 1 ? '' : 's'}`}
          />
        </>
      )}
    </div>
  );
}
