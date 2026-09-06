import { useEffect, useRef, useState } from 'react';

// Aspect/output are caller-configurable (square profile photos, square
// institution logos — both reuse this same component) rather than fixed to
// one shape; VIEWPORT_WIDTH stays constant and VIEWPORT_HEIGHT derives from
// whatever aspect the caller passes, so the crop the student/admin sees is
// always exactly what gets produced, at any ratio.
const VIEWPORT_WIDTH = 240;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

// A minimal drag-to-pan, slider-to-zoom cropper — no external library, just
// a positioned <img> inside a fixed, clipped viewport plus a canvas to
// render the final crop. Deliberately simple: this exists so a student
// picks WHAT part of their photo becomes their ID card face (or an admin
// picks what part of an institution's artwork becomes its logo), not to be
// a general-purpose photo editor.
export default function ImageCropper({
  file, onCancel, onConfirm,
  aspect = 1, outputWidth = 480, mimeType = 'image/jpeg', quality = 0.92, confirmLabel = 'Use this photo',
}) {
  const outputHeight = Math.round(outputWidth / aspect);
  const viewportHeight = Math.round(VIEWPORT_WIDTH / aspect);
  const [imgUrl, setImgUrl] = useState(null);
  const [natural, setNatural] = useState(null); // { width, height } once loaded
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const dragStartRef = useRef(null);
  const imgRef = useRef(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const baseScale = natural ? Math.max(VIEWPORT_WIDTH / natural.width, viewportHeight / natural.height) : 1;
  const scale = baseScale * zoom;
  const displayWidth = natural ? natural.width * scale : 0;
  const displayHeight = natural ? natural.height * scale : 0;

  // The image must always fully cover the viewport — offset is clamped so
  // its edges can never pull inward past the viewport's own edges.
  const clampOffset = (x, y, w = displayWidth, h = displayHeight) => ({
    x: Math.min(0, Math.max(VIEWPORT_WIDTH - w, x)),
    y: Math.min(0, Math.max(viewportHeight - h, y)),
  });

  const handleImgLoad = (e) => {
    const width = e.target.naturalWidth;
    const height = e.target.naturalHeight;
    setNatural({ width, height });
    const s = Math.max(VIEWPORT_WIDTH / width, viewportHeight / height);
    setOffset({ x: (VIEWPORT_WIDTH - width * s) / 2, y: (viewportHeight - height * s) / 2 });
  };

  const startDrag = (e) => {
    if (!natural) return;
    e.preventDefault();
    const point = 'touches' in e ? e.touches[0] : e;
    dragStartRef.current = { x: point.clientX, y: point.clientY, offset };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return undefined;
    const move = (e) => {
      const point = 'touches' in e ? e.touches[0] : e;
      const dx = point.clientX - dragStartRef.current.x;
      const dy = point.clientY - dragStartRef.current.y;
      setOffset(clampOffset(dragStartRef.current.offset.x + dx, dragStartRef.current.offset.y + dy));
    };
    const stop = () => setDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('touchend', stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  // Re-anchors the viewport's CENTER point (not the image's corner) when
  // zoom changes — without this, zooming in would visibly yank the image
  // toward its top-left corner instead of growing from where you're
  // actually looking.
  const handleZoomChange = (e) => {
    if (!natural) return;
    const nextZoom = Number(e.target.value);
    const nextScale = baseScale * nextZoom;
    const centerX = VIEWPORT_WIDTH / 2;
    const centerY = viewportHeight / 2;
    const imgX = (centerX - offset.x) / scale;
    const imgY = (centerY - offset.y) / scale;
    setZoom(nextZoom);
    setOffset(clampOffset(
      centerX - imgX * nextScale,
      centerY - imgY * nextScale,
      natural.width * nextScale,
      natural.height * nextScale
    ));
  };

  const handleConfirm = () => {
    if (!natural || saving) return;
    setSaving(true);
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d');
    // k maps viewport pixels to output-canvas pixels — same ratio on both
    // axes since outputWidth/outputHeight share the viewport's own aspect
    // ratio, so this one factor reproduces exactly what's visible in the
    // viewport, just at higher resolution.
    const k = outputWidth / VIEWPORT_WIDTH;
    ctx.drawImage(
      imgRef.current,
      0, 0, natural.width, natural.height,
      offset.x * k, offset.y * k, natural.width * scale * k, natural.height * scale * k
    );
    canvas.toBlob((blob) => {
      setSaving(false);
      if (blob) onConfirm(blob);
    }, mimeType, quality);
  };

  return (
    <div className="cropper">
      <p className="cropper-hint">Drag to reposition, use the slider to zoom.</p>
      <div
        className="cropper-viewport"
        style={{ width: VIEWPORT_WIDTH, height: viewportHeight, cursor: dragging ? 'grabbing' : 'grab' }}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
      >
        {imgUrl && (
          <img
            ref={imgRef}
            src={imgUrl}
            alt="Image being cropped"
            onLoad={handleImgLoad}
            draggable={false}
            className="cropper-img"
            style={natural ? { width: displayWidth, height: displayHeight, left: offset.x, top: offset.y } : { opacity: 0 }}
          />
        )}
      </div>
      <input
        type="range"
        className="cropper-zoom"
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        step={0.01}
        value={zoom}
        onChange={handleZoomChange}
        aria-label="Zoom"
        disabled={!natural}
      />
      <div className="cropper-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleConfirm} disabled={!natural || saving}>
          {saving ? 'Saving…' : confirmLabel}
        </button>
      </div>
    </div>
  );
}
