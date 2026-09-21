import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { API } from '../config';
import { useAuth } from './AuthContext';

// One shared store (Context, not a bare hook) — ThemeCustomizer.jsx (the
// settings dropdown) and CustomBackgroundLayer.jsx (the fixed image/video
// layer, mounted once in App.jsx) both need to react to the same state.
// Two independent useState-backed hooks would each keep their own copy and
// silently drift out of sync the moment one of them changed something.
const CustomThemeContext = createContext(null);

const STORAGE_KEY = 'honorroll-custom-theme';

function loadStored() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

// Slides each channel toward black (negative percent) or white (positive)
// — enough to stand in for "a slightly lighter/darker step" without a
// color library for the couple of call sites that need it.
function shade(hex, percent) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const toward = percent < 0 ? 0 : 255;
  const apply = (c) => clamp(c + (toward - c) * Math.abs(percent));
  return `#${[apply(rgb.r), apply(rgb.g), apply(rgb.b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// WCAG relative luminance — used both to pick black/white button text
// against an arbitrary accent, and to decide whether a custom card color
// needs its -2/-3 depth steps to go lighter or darker.
function relativeLuminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 1;
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

function readableTextColor(hex) {
  return relativeLuminance(hex) > 0.45 ? '#111111' : '#ffffff';
}

// Cheap "dominant color" trick: draw the source scaled all the way down to
// a single pixel — the browser's own downscale filtering does the
// averaging for us, no k-means/quantization needed. Works for both a
// loaded <img> and a <video> that already has a frame painted.
function averageColorFromElement(el, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(el, 0, 0, width, height, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function extractDominantColor({ bgImage, bgVideo }) {
  return new Promise((resolve, reject) => {
    if (bgImage) {
      const img = new Image();
      img.onload = () => {
        try { resolve(averageColorFromElement(img, img.naturalWidth, img.naturalHeight)); }
        catch (err) { reject(err); }
      };
      img.onerror = reject;
      img.src = bgImage;
    } else if (bgVideo) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.addEventListener('loadeddata', () => {
        try { resolve(averageColorFromElement(video, video.videoWidth, video.videoHeight)); }
        catch (err) { reject(err); }
      }, { once: true });
      video.onerror = reject;
      video.src = bgVideo;
    } else {
      reject(new Error('No background media set'));
    }
  });
}

export function CustomThemeProvider({ children }) {
  const [custom, setCustom] = useState(loadStored);
  const { user, loading: authLoading } = useAuth();
  // undefined = "haven't seen an auth result yet" — distinct from null
  // (confirmed logged out) so the very first resolution on a page a
  // visitor was never logged in on doesn't get treated as a "logout".
  const lastUserIdRef = useRef(undefined);
  // Set right before a setCustom call that came FROM the server/a logout
  // reset, so the sync-to-server effect below doesn't immediately PUT that
  // same value straight back (or PUT a reset caused by logging out, which
  // has no session to send it with anyway).
  const skipNextSyncRef = useRef(false);

  // Account sync: adopt the signed-in user's own saved theme (so a
  // different device/browser shows the same look), and clear back to
  // defaults on logout so this account's customization doesn't leak to
  // whoever uses the browser next.
  useEffect(() => {
    if (authLoading) return;
    const uid = user?.id ?? null;
    if (uid === lastUserIdRef.current) return;
    const hadKnownUser = lastUserIdRef.current !== undefined;
    lastUserIdRef.current = uid;

    if (uid) {
      (async () => {
        try {
          const res = await axios.get(`${API}/api/me/custom-theme`);
          skipNextSyncRef.current = true;
          setCustom(res.data.customTheme || {});
        } catch {
          // Offline or the request failed — keep whatever's already
          // applied (local cache) rather than wiping a working look.
        }
      })();
    } else if (hadKnownUser) {
      skipNextSyncRef.current = true;
      setCustom({});
    }
  }, [user, authLoading]);

  useEffect(() => {
    const root = document.documentElement.style;

    if (custom.accent) {
      root.setProperty('--accent', custom.accent);
      root.setProperty('--accent-strong', shade(custom.accent, -0.18));
      root.setProperty('--accent-dim', `${custom.accent}2e`);
      root.setProperty('--on-accent', readableTextColor(custom.accent));
    } else {
      root.removeProperty('--accent');
      root.removeProperty('--accent-strong');
      root.removeProperty('--accent-dim');
      root.removeProperty('--on-accent');
    }

    if (custom.bg) root.setProperty('--bg', custom.bg);
    else root.removeProperty('--bg');

    if (custom.surface) {
      const dark = relativeLuminance(custom.surface) < 0.5;
      root.setProperty('--surface-base', custom.surface);
      root.setProperty('--surface-2-base', shade(custom.surface, dark ? 0.06 : -0.05));
      root.setProperty('--surface-3-base', shade(custom.surface, dark ? 0.12 : -0.09));
    } else {
      root.removeProperty('--surface-base');
      root.removeProperty('--surface-2-base');
      root.removeProperty('--surface-3-base');
    }

    // Percentage string straight into color-mix() (index.css's own
    // --surface: color-mix(... var(--card-opacity, 100%) ...)) — no color
    // math needed here at all, CSS does the blending.
    if (custom.cardOpacity != null) root.setProperty('--card-opacity', `${custom.cardOpacity}%`);
    else root.removeProperty('--card-opacity');

    if (custom.textPrimary) {
      root.setProperty('--text-h', custom.textPrimary);
      root.setProperty('--text', custom.textPrimary);
    } else {
      root.removeProperty('--text-h');
      root.removeProperty('--text');
    }

    if (custom.textSecondary) root.setProperty('--text-dim', custom.textSecondary);
    else root.removeProperty('--text-dim');

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
    } catch {
      // Quota exceeded — a large background image/video pushed past
      // localStorage's ~5-10MB cap. The CSS vars above are still applied
      // for this session; it just won't survive a reload.
      // ponytail: localStorage ceiling — move media to IndexedDB if
      // "quota exceeded" turns out to be a common complaint, not before.
    }

    // A value that just arrived FROM the server (or a logout reset) has
    // nowhere useful to go back to — skip once rather than round-tripping
    // it right back to PUT.
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      return;
    }
    if (!user?.id) return;
    // Debounced — a color input fires on every drag tick, not just on
    // release, and a background image/video turns this into a real
    // multi-MB request that a student's typo-fast clicking shouldn't repeat
    // dozens of times a second.
    const timer = setTimeout(() => {
      axios.put(`${API}/api/me/custom-theme`, { customTheme: custom }).catch(() => {
        // Best-effort, same posture as NotificationBell's mark-read call —
        // worst case this device's look doesn't reach the account this
        // time; it'll try again on the next change.
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [custom, user?.id]);

  const setAccent = useCallback((hex) => setCustom((c) => ({ ...c, accent: hex })), []);
  const setBg = useCallback((hex) => setCustom((c) => ({ ...c, bg: hex })), []);
  const setSurface = useCallback((hex) => setCustom((c) => ({ ...c, surface: hex })), []);
  const setTextPrimary = useCallback((hex) => setCustom((c) => ({ ...c, textPrimary: hex })), []);
  const setTextSecondary = useCallback((hex) => setCustom((c) => ({ ...c, textSecondary: hex })), []);
  const setCardOpacity = useCallback((pct) => setCustom((c) => ({ ...c, cardOpacity: pct })), []);
  // A background is either an image or a video, never both — picking one
  // clears the other so there's no ambiguity about which layer shows.
  const setBgImage = useCallback((dataUrl) => setCustom((c) => ({ ...c, bgImage: dataUrl, bgVideo: undefined })), []);
  const setBgVideo = useCallback((dataUrl) => setCustom((c) => ({ ...c, bgVideo: dataUrl, bgImage: undefined })), []);
  const clearBgMedia = useCallback(() => setCustom((c) => {
    const { bgImage, bgVideo, ...rest } = c;
    return rest;
  }), []);
  const reset = useCallback(() => setCustom({}), []);

  const autoPickAccent = useCallback(async () => {
    const hex = await extractDominantColor(custom);
    setAccent(hex);
  }, [custom, setAccent]);

  const value = {
    custom, setAccent, setBg, setSurface, setTextPrimary, setTextSecondary,
    setCardOpacity, setBgImage, setBgVideo, clearBgMedia, reset, autoPickAccent,
  };

  return <CustomThemeContext.Provider value={value}>{children}</CustomThemeContext.Provider>;
}

export function useCustomTheme() {
  const ctx = useContext(CustomThemeContext);
  if (!ctx) throw new Error('useCustomTheme must be used within a CustomThemeProvider');
  return ctx;
}
