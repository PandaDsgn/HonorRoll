import { useState, useEffect, useRef } from 'react';

// Extracted from ScanCapture.jsx (the assignment scan flow) so ExamAttempt's
// exam-scan-item flow can reuse the exact same crop-editor/review UI
// instead of a second, drifting copy of it. Pure capture/opencv logic
// lives in ../lib/scanCaptureCore.js instead of here — this file stays
// component-only for react-refresh/only-export-components.

const CORNER_KEYS = ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner'];

// Draggable-corner crop editor for one just-captured raw frame. Detection
// is "hardly 6/10" in practice (a fixed Canny/threshold pipeline can't
// adapt to every lighting/paper/background combination), so every capture
// goes through this instead of trusting the auto-detected quadrilateral
// outright — the same corners jscanify's own extractPaper would have used
// are shown as draggable handles, pre-positioned at its best guess, and the
// student can nudge them before the actual perspective-warp crop happens.
export function CornerEditor({ rawFrameUrl, initialCorners, onConfirm, onRetake }) {
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
export function ReviewScreen({ pages, onRemove, onAddMore, onSubmit, submitting, submitLabel }) {
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
          {submitting ? 'Submitting…' : (submitLabel || `Submit ${pages.length} page${pages.length === 1 ? '' : 's'}`)}
        </button>
      </div>
    </div>
  );
}
