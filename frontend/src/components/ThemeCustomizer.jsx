import { useEffect, useRef, useState } from 'react';
import { useCustomTheme } from '../context/CustomThemeContext';
import '../ThemeCustomizer.css';

// Keeps the base64 copy comfortably under localStorage's ~5-10MB quota
// (base64 inflates the original by roughly a third). Video gets more
// headroom since a useful loop is rarely much smaller than this.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;

function PaletteIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-.9.7-1.6 1.6-1.6H17a3 3 0 0 0 3-3c0-5-3.6-9-8-9Z" />
      <circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="10.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Sits in every page's own top bar, immediately before ThemeToggle (see
// that component, which renders this) — same .icon-btn trigger + anchored
// dropdown shape as NotificationBell, so it reads as one more top-bar
// control rather than a bolted-on floating widget.
export default function ThemeCustomizer() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const containerRef = useRef(null);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const {
    custom, setAccent, setBg, setSurface, setTextPrimary, setTextSecondary,
    setCardOpacity, setBgImage, setBgVideo, clearBgMedia, reset, autoPickAccent,
  } = useCustomTheme();

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Falls back to whatever the active theme is currently rendering so a
  // swatch never opens on a meaningless black default.
  const currentAccent = custom.accent || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f6fe4';
  const currentBg = custom.bg || getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff';
  const currentSurface = custom.surface || getComputedStyle(document.documentElement).getPropertyValue('--surface-base').trim() || '#ffffff';
  const currentTextPrimary = custom.textPrimary || getComputedStyle(document.documentElement).getPropertyValue('--text-h').trim() || '#111111';
  const currentTextSecondary = custom.textSecondary || getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim() || '#787774';
  const opacityPct = custom.cardOpacity ?? 100;

  const handleMediaPick = async (e, kind) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    const isVideo = kind === 'video';
    if (!file.type.startsWith(isVideo ? 'video/' : 'image/')) {
      setError(isVideo ? 'Pick a video file.' : 'Pick an image file.');
      return;
    }
    const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (file.size > limit) {
      setError(`That file is too big — try one under ${Math.round(limit / (1024 * 1024))}MB.`);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (isVideo) setBgVideo(dataUrl);
      else setBgImage(dataUrl);
    } catch {
      setError('Could not read that file — try a different one.');
    }
  };

  const handleAutoPick = async () => {
    setError('');
    setPicking(true);
    try {
      await autoPickAccent();
    } catch {
      setError('Could not pick a color from that background.');
    } finally {
      setPicking(false);
    }
  };

  const hasBgMedia = Boolean(custom.bgImage || custom.bgVideo);

  return (
    <div ref={containerRef} className="customize-container">
      <button
        type="button"
        className="icon-btn"
        aria-label="Customize appearance"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Customize appearance"
      >
        <PaletteIcon />
      </button>

      {open && (
        <div className="customize-dropdown">
          <div className="customize-row">
            <label htmlFor="customize-accent">Accent color</label>
            <input id="customize-accent" type="color" value={currentAccent} onChange={(e) => setAccent(e.target.value)} />
          </div>

          <div className="customize-row">
            <label htmlFor="customize-bg">Background color</label>
            <input id="customize-bg" type="color" value={currentBg} onChange={(e) => setBg(e.target.value)} />
          </div>

          <div className="customize-row">
            <label htmlFor="customize-surface">Card color</label>
            <input id="customize-surface" type="color" value={currentSurface} onChange={(e) => setSurface(e.target.value)} />
          </div>

          <div className="customize-row">
            <label htmlFor="customize-text-primary">Primary text</label>
            <input id="customize-text-primary" type="color" value={currentTextPrimary} onChange={(e) => setTextPrimary(e.target.value)} />
          </div>

          <div className="customize-row">
            <label htmlFor="customize-text-secondary">Secondary text</label>
            <input id="customize-text-secondary" type="color" value={currentTextSecondary} onChange={(e) => setTextSecondary(e.target.value)} />
          </div>

          <div className="customize-row customize-row-stack">
            <label htmlFor="customize-opacity">Card transparency — {opacityPct}%</label>
            <input
              id="customize-opacity"
              type="range"
              min="20"
              max="100"
              step="5"
              value={opacityPct}
              onChange={(e) => setCardOpacity(Number(e.target.value))}
            />
          </div>

          <div className="customize-divider" />

          <div className="customize-row-stack">
            <label>Background</label>
            {hasBgMedia ? (
              <div className="customize-image-preview">
                {custom.bgVideo ? (
                  <video className="customize-media-thumb" src={custom.bgVideo} muted playsInline autoPlay loop />
                ) : (
                  <img className="customize-media-thumb" src={custom.bgImage} alt="" />
                )}
                <button type="button" className="btn btn-ghost" onClick={clearBgMedia}>Remove</button>
              </div>
            ) : (
              <div className="customize-bg-upload-buttons">
                <button type="button" className="btn btn-ghost" onClick={() => imageInputRef.current?.click()}>Upload image</button>
                <button type="button" className="btn btn-ghost" onClick={() => videoInputRef.current?.click()}>Upload video</button>
              </div>
            )}
            <input ref={imageInputRef} type="file" accept="image/*" onChange={(e) => handleMediaPick(e, 'image')} hidden />
            <input ref={videoInputRef} type="file" accept="video/*" onChange={(e) => handleMediaPick(e, 'video')} hidden />
          </div>

          {hasBgMedia && (
            <button type="button" className="btn btn-ghost" onClick={handleAutoPick} disabled={picking}>
              {picking ? 'Picking color…' : 'Auto-pick accent from background'}
            </button>
          )}

          {error && <div className="customize-error">{error}</div>}

          <button type="button" className="btn customize-reset" onClick={reset}>Reset to default</button>
        </div>
      )}
    </div>
  );
}
