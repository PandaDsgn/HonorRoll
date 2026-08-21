import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import jscanify from 'jscanify/client';
import { jsPDF } from 'jspdf';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import { API } from '../config';
import './ScanCapture.css';

// A4 at ~150dpi — a reasonable balance between OCR-legible resolution and
// file size for a multi-page scanned answer sheet.
const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;

const CORNER_KEYS = ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner'];

// jscanify needs opencv.js's global `cv` before any of its methods run.
// opencv.js itself (~9MB, WASM) is deliberately NOT bundled — loaded from
// CDN on demand, same pattern as loadRazorpayScript in BillingPanel.jsx.
// Unlike a plain script load, `cv` existing after script.onload doesn't
// mean it's ready — the WASM binary is still compiling asynchronously at
// that point, so this also waits on cv.onRuntimeInitialized before resolving.
const OPENCV_SRC = 'https://docs.opencv.org/4.7.0/opencv.js';
function loadOpenCv() {
  return new Promise((resolve, reject) => {
    if (window.cv?.Mat) return resolve();
    const onScriptLoaded = () => {
      if (window.cv?.Mat) return resolve();
      window.cv['onRuntimeInitialized'] = resolve;
    };
    const existing = document.querySelector(`script[src="${OPENCV_SRC}"]`);
    if (existing) {
      if (window.cv) onScriptLoaded();
      else existing.addEventListener('load', onScriptLoaded);
      existing.addEventListener('error', () => reject(new Error('Failed to load the scanner engine')));
      return;
    }
    const script = document.createElement('script');
    script.src = OPENCV_SRC;
    script.async = true;
    script.onload = onScriptLoaded;
    script.onerror = () => reject(new Error('Failed to load the scanner engine'));
    document.body.appendChild(script);
  });
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

function buildPdfBlob(pageDataUrls) {
  const doc = new jsPDF({ unit: 'px', format: [PAGE_WIDTH, PAGE_HEIGHT] });
  pageDataUrls.forEach((dataUrl, i) => {
    if (i > 0) doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    doc.addImage(dataUrl, 'JPEG', 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  });
  return doc.output('blob');
}

function fallbackCorners(width, height) {
  return {
    topLeftCorner: { x: 0, y: 0 },
    topRightCorner: { x: width, y: 0 },
    bottomLeftCorner: { x: 0, y: height },
    bottomRightCorner: { x: width, y: height },
  };
}

// Runs jscanify's own contour detection standalone (not via
// highlightPaper/extractPaper, which do this internally but don't expose
// the result). Manages opencv.js Mat memory manually (.delete()) since
// these are WASM-backed objects the JS garbage collector doesn't know
// about — a real detection pipeline that leaks Mats will exhaust WASM heap
// after enough captures.
//
// No area/plausibility filtering here — this raw result is what seeds the
// corner editor after a capture, and ANY detected quad (even an uncertain,
// smaller-than-ideal one) is a far better starting point for a quick manual
// nudge than forcing the student to drag all four corners in from the
// extreme frame edges. An earlier version filtered out small detections
// here too (reusing the same gate as the live-preview highlight, see
// detectCornersForPreview below) and that's what caused real background
// to end up in a submitted page — the filter rejected a valid-but-modest
// detection, fell back to full-frame corners, and the resulting "drag from
// scratch" task was too imprecise to do reliably on a phone screen.
function detectCorners(scanner, canvas) {
  const img = window.cv.imread(canvas);
  try {
    const contour = scanner.findPaperContour(img);
    if (!contour) return null;
    const corners = scanner.getCornerPoints(contour);
    contour.delete();
    const { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner } = corners;
    if (!topLeftCorner || !topRightCorner || !bottomLeftCorner || !bottomRightCorner) return null;
    return corners;
  } finally {
    img.delete();
  }
}

// Shoelace formula — polygon area from the 4 corner points directly, so the
// live-preview area gate below doesn't need to keep the opencv contour
// object alive just to call cv.contourArea() on it.
function quadArea(corners) {
  const pts = [corners.topLeftCorner, corners.topRightCorner, corners.bottomRightCorner, corners.bottomLeftCorner];
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % 4];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(area / 2);
}

// jscanify's findPaperContour() just picks the single LARGEST contour by
// area with no other sanity check — a strong specular highlight/reflection
// on glossy paper, or a graphic/text block with sharp internal edges, can
// register as a "stronger" contour than the actual page-vs-background
// boundary, especially against a plain light-colored desk. This gate is
// ONLY applied to the live-preview highlight (where confidently drawing a
// box around noise is worse than showing nothing) — NOT to the capture-seed
// path above, which needs a starting guess even when it's an uncertain one.
const MIN_PAPER_AREA_RATIO = 0.2;
function detectCornersForPreview(scanner, canvas) {
  const corners = detectCorners(scanner, canvas);
  if (!corners) return null;
  const frameArea = canvas.width * canvas.height;
  return quadArea(corners) >= frameArea * MIN_PAPER_AREA_RATIO ? corners : null;
}

// Turns a perspective-corrected color photo into the flat, bright-white-
// background/vivid-ink look real scanner apps (Adobe Scan's "Color" mode)
// produce — CLAHE alone (an earlier version of this function) only sharpens
// LOCAL contrast, it never actually drives the page background toward true
// white, so the result still reads as "a photo of paper," just a punchier
// one. This is the standard technique for that: estimate the page's own
// lighting via a heavy blur (large enough to smooth over both gradual
// falloff and any localized glare/reflection, far larger than a line of
// text), then divide the image by that estimate so every pixel gets
// rescaled toward how it would look under perfectly even lighting — the
// background converges on TARGET regardless of how unevenly it was
// actually lit, and ink darkens by comparison. The SAME per-pixel
// correction factor is applied to R, G, and B alike, which is what keeps
// color/hue intact (only brightness is being normalized) rather than
// draining it out the way full grayscale+threshold binarization did.
function applyScanFilter(canvas) {
  const cv = window.cv;
  const TARGET = 248; // near-pure-white target for the normalized background
  const src = cv.imread(canvas);
  const rgb = new cv.Mat();
  const gray = new cv.Mat();
  const background = new cv.Mat();
  const bgFloat = new cv.Mat();
  const targetMat = new cv.Mat(canvas.height, canvas.width, cv.CV_32F, new cv.Scalar(TARGET));
  const factor = new cv.Mat();
  const factorChannels = new cv.MatVector();
  const factorMerged = new cv.Mat();
  const rgbFloat = new cv.Mat();
  const correctedFloat = new cv.Mat();
  const corrected8u = new cv.Mat();
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

    let kSize = Math.round(Math.min(rgb.cols, rgb.rows) / 8);
    if (kSize % 2 === 0) kSize += 1;
    if (kSize < 3) kSize = 3;
    cv.GaussianBlur(gray, background, new cv.Size(kSize, kSize), 0, 0, cv.BORDER_DEFAULT);

    background.convertTo(bgFloat, cv.CV_32F);
    cv.divide(targetMat, bgFloat, factor); // factor = TARGET / local background
    factorChannels.push_back(factor);
    factorChannels.push_back(factor);
    factorChannels.push_back(factor);
    cv.merge(factorChannels, factorMerged);

    rgb.convertTo(rgbFloat, cv.CV_32FC3);
    cv.multiply(rgbFloat, factorMerged, correctedFloat);
    // convertTo down to 8-bit saturate-casts automatically — out-of-range
    // values clamp to [0,255] with no separate clamping step needed.
    correctedFloat.convertTo(corrected8u, cv.CV_8UC3);
    cv.imshow(canvas, corrected8u);
  } finally {
    src.delete();
    rgb.delete();
    gray.delete();
    background.delete();
    bgFloat.delete();
    targetMat.delete();
    factor.delete();
    factorChannels.delete();
    factorMerged.delete();
    rgbFloat.delete();
    correctedFloat.delete();
    corrected8u.delete();
  }
  return canvas;
}

// Draggable-corner crop editor for one just-captured raw frame. Detection
// is "hardly 6/10" in practice (a fixed Canny/threshold pipeline can't
// adapt to every lighting/paper/background combination), so every capture
// goes through this instead of trusting the auto-detected quadrilateral
// outright — the same corners jscanify's own extractPaper would have used
// are shown as draggable handles, pre-positioned at its best guess, and the
// student can nudge them before the actual perspective-warp crop happens.
function CornerEditor({ rawFrameUrl, initialCorners, onConfirm, onRetake }) {
  const [corners, setCorners] = useState(initialCorners);
  // Rendered container width + the image's native resolution — tracked as
  // state (not read from refs during render, which React's rules forbid as
  // an impure render) and used to derive `scale`, the ratio between the
  // native pixel coordinates corner points are stored in and the CSS pixels
  // the image is actually displayed at.
  const [containerWidth, setContainerWidth] = useState(0);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const imgRef = useRef(null);
  const containerRef = useRef(null);
  const draggingRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const observer = new ResizeObserver((entries) => setContainerWidth(entries[0].contentRect.width));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleMove = (e) => {
      const key = draggingRef.current;
      const container = containerRef.current;
      if (!key || !container || !naturalSize.width) return;
      const rect = container.getBoundingClientRect();
      const scale = rect.width / naturalSize.width;
      const point = 'touches' in e ? e.touches[0] : e;
      const x = Math.max(0, Math.min(naturalSize.width, (point.clientX - rect.left) / scale));
      const y = Math.max(0, Math.min(naturalSize.height, (point.clientY - rect.top) / scale));
      setCorners((prev) => ({ ...prev, [key]: { x, y } }));
    };
    const handleUp = () => { draggingRef.current = null; };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [naturalSize]);

  const scale = containerWidth && naturalSize.width ? containerWidth / naturalSize.width : 0;

  return (
    <div className="scan-corner-editor">
      <p className="auth-sub" style={{ margin: '0 0 12px' }}>Drag the corners to match the page edges, then confirm.</p>
      <div className="scan-corner-editor-frame" ref={containerRef}>
        <img
          ref={imgRef}
          src={rawFrameUrl}
          alt="Captured page, awaiting crop"
          className="scan-corner-editor-img"
          onLoad={(e) => setNaturalSize({ width: e.target.naturalWidth, height: e.target.naturalHeight })}
        />
        {scale > 0 && (
          <svg className="scan-corner-editor-svg">
            <polygon
              points={CORNER_KEYS.map((k) => `${corners[k].x * scale},${corners[k].y * scale}`).join(' ')}
            />
          </svg>
        )}
        {scale > 0 && CORNER_KEYS.map((key) => (
          <div
            key={key}
            className="scan-corner-handle"
            style={{ left: corners[key].x * scale, top: corners[key].y * scale }}
            onPointerDown={(e) => { e.preventDefault(); draggingRef.current = key; }}
          />
        ))}
      </div>
      <div className="scan-capture-actions">
        <button type="button" className="btn btn-ghost" onClick={onRetake}>Retake</button>
        <button type="button" className="btn btn-primary" onClick={() => onConfirm(corners)}>Use this page</button>
      </div>
    </div>
  );
}

// Full-size review of every captured page before the actual upload — a
// student should be able to see legibility/framing clearly, not just judge
// from a thumbnail strip, before committing to submit.
function ReviewScreen({ pages, onRemove, onAddMore, onSubmit, submitting }) {
  return (
    <div>
      <p className="auth-sub" style={{ margin: '0 0 12px' }}>
        Review every page before submitting — tap "Retake" on anything that's hard to read.
      </p>
      <div className="scan-review-pages">
        {pages.map((dataUrl, idx) => (
          <div className="scan-review-page" key={idx}>
            <img src={dataUrl} alt={`Page ${idx + 1}`} />
            <div className="scan-review-page-footer">
              <span className="chip chip-neutral"><span className="dot" />Page {idx + 1}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemove(idx)} disabled={submitting}>Remove</button>
            </div>
          </div>
        ))}
      </div>
      <div className="scan-capture-actions">
        <button type="button" className="btn btn-ghost" onClick={onAddMore} disabled={submitting}>+ Add another page</button>
        <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={pages.length === 0 || submitting}>
          {submitting && <span className="spinner" />}
          {submitting ? 'Submitting…' : `Submit ${pages.length} page${pages.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
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
  // replace it) OR 'questions' (read what's being asked, then choose
  // camera-scan or PDF-upload) -> EITHER 'scanning' -> 'editing' (per-capture
  // crop) -> 'scanning' (repeat) -> 'reviewing' -> 'uploading' OR
  // 'upload-review' (a PDF picked from elsewhere, awaiting confirm) ->
  // 'upload-submitting' -> 'done', or 'error' at any point
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
      const res = await axios.post(`${API}/api/problems/${id}/scan-submit`, formData, { withCredentials: true });
      setUploadResult(res.data);
      setPhase('done');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to upload your scanned submission.');
      setPhase('reviewing');
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
          <h2 style={{ margin: '0 0 8px' }}>Scan &amp; submit</h2>

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
                Read through what's being asked before you start scanning — you won't be able to see this list again while the camera is open.
              </p>
              <ol className="scan-question-list">
                {(scanContext.questions || []).map((q, idx) => (
                  <li key={idx} className="scan-question-item">
                    <span>{q.prompt}</span>
                    <span className="chip chip-neutral">{q.marks} marks</span>
                  </li>
                ))}
              </ol>
              {uploadFileError && (
                <div className="alert" role="alert" style={{ marginBottom: 12 }}>
                  <span className="alert-icon">!</span>
                  <span>{uploadFileError}</span>
                </div>
              )}
              <div className="scan-capture-actions">
                <button type="button" className="btn btn-primary" onClick={handleStartScanning}>Scan with camera</button>
                <button type="button" className="btn btn-ghost" onClick={handleChooseFile}>Upload a scanned PDF</button>
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

              {debugInfo && <p className="auth-sub" style={{ margin: '8px 0 0', fontFamily: 'monospace', fontSize: 11 }}>{debugInfo}</p>}

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
