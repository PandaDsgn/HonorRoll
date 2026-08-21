import { jsPDF } from 'jspdf';

// Pure capture/crop logic shared by ScanCapture.jsx (assignments) and
// ExamScanCapture.jsx (exam scan-type items) — split out from the
// components that use it (see ../components/ScanCaptureShared.jsx) purely
// so this file can stay function/constant-only, which is what Fast
// Refresh's "only export components" rule wants from a .jsx file.

// A4 at ~150dpi — a reasonable balance between OCR-legible resolution and
// file size for a multi-page scanned answer sheet.
export const PAGE_WIDTH = 1240;
export const PAGE_HEIGHT = 1754;

// jscanify needs opencv.js's global `cv` before any of its methods run.
// opencv.js itself (~9MB, WASM) is deliberately NOT bundled — loaded from
// CDN on demand, same pattern as loadRazorpayScript in BillingPanel.jsx.
// Unlike a plain script load, `cv` existing after script.onload doesn't
// mean it's ready — the WASM binary is still compiling asynchronously at
// that point, so this also waits on cv.onRuntimeInitialized before resolving.
const OPENCV_SRC = 'https://docs.opencv.org/4.7.0/opencv.js';
export function loadOpenCv() {
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

export function buildPdfBlob(pageDataUrls) {
  const doc = new jsPDF({ unit: 'px', format: [PAGE_WIDTH, PAGE_HEIGHT] });
  pageDataUrls.forEach((dataUrl, i) => {
    if (i > 0) doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    doc.addImage(dataUrl, 'JPEG', 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  });
  return doc.output('blob');
}

export function fallbackCorners(width, height) {
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
export function detectCorners(scanner, canvas) {
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
export function quadArea(corners) {
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
export function detectCornersForPreview(scanner, canvas) {
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
export function applyScanFilter(canvas) {
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
