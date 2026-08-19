import { useEffect, useRef, useState, useCallback } from 'react';
import { TOKEN_KEY } from '../context/AuthContext';

// Safari (including recent versions) still needs the webkit-prefixed
// Fullscreen API in some configurations — falling back to only the
// unprefixed names is what left fullscreen stuck on after an exam ended
// for anyone on Safari, since exitFullscreen() was silently a no-op there.
function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function requestElementFullscreen(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  return fn ? fn.call(el) : Promise.reject(new Error('Fullscreen API not supported'));
}
function exitDocumentFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  return fn ? fn.call(document) : Promise.resolve();
}

// Enforces "exam mode" lockdown: fullscreen + tab/window-change detection.
// While `armed` is true, exiting fullscreen, backgrounding the tab, or the
// window losing OS focus fires `onViolation(reason)` exactly once — a
// ref-guarded latch stops e.g. visibilitychange and blur both firing for
// the same alt-tab. `armed` is what lets the intro screen, and the app's
// own deliberate exitFullscreen() on submit, avoid self-triggering: the
// caller must flip `armed` to false BEFORE calling exitFullscreen().
//
// Also mirrors Sandbox.jsx's useAssignmentTimeTracking unload handling: a
// pagehide/beforeunload fires a best-effort keepalive fetch beacon (axios
// is unreliable mid-unload, and navigator.sendBeacon can't carry the
// Authorization header this API needs), so closing the tab or reloading is
// itself treated as ending the exam server-side, not just a client-side miss.
export function useExamLockdown({ armed, onViolation, beaconUrl, buildBeaconPayload }) {
  const [isFullscreen, setIsFullscreen] = useState(!!getFullscreenElement());
  const armedRef = useRef(armed);
  const firedRef = useRef(false);
  const onViolationRef = useRef(onViolation);
  const beaconUrlRef = useRef(beaconUrl);
  const buildBeaconPayloadRef = useRef(buildBeaconPayload);

  useEffect(() => {
    armedRef.current = armed;
    if (armed) firedRef.current = false; // re-arm for a fresh attempt
  }, [armed]);
  useEffect(() => { onViolationRef.current = onViolation; }, [onViolation]);
  useEffect(() => { beaconUrlRef.current = beaconUrl; }, [beaconUrl]);
  useEffect(() => { buildBeaconPayloadRef.current = buildBeaconPayload; }, [buildBeaconPayload]);

  const fire = useCallback((reason) => {
    if (!armedRef.current || firedRef.current) return;
    firedRef.current = true;
    onViolationRef.current?.(reason);
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      const fs = !!getFullscreenElement();
      setIsFullscreen(fs);
      if (!fs) fire('violation_fullscreen_exit');
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') fire('violation_visibility');
    };
    const onBlur = () => fire('violation_blur');
    const onUnload = () => {
      if (!armedRef.current) return;
      const url = beaconUrlRef.current;
      const payload = buildBeaconPayloadRef.current?.();
      if (!url || !payload) return;
      const token = localStorage.getItem(TOKEN_KEY);
      try {
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {});
      } catch {
        // Best-effort — the page is already gone either way.
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);

    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [fire]);

  // Must be called synchronously from inside a user-gesture click handler —
  // browsers reject requestFullscreen() otherwise. Resolves false (instead
  // of throwing) when unsupported (e.g. iOS Safari has no arbitrary-element
  // Fullscreen API), so the caller can show a plain "not supported here"
  // message instead of an unhandled rejection.
  const requestFullscreen = useCallback(async () => {
    const el = document.documentElement;
    if (!el.requestFullscreen && !el.webkitRequestFullscreen) return false;
    try {
      await requestElementFullscreen(el);
      return true;
    } catch {
      return false;
    }
  }, []);

  const exitFullscreen = useCallback(() => {
    if (getFullscreenElement()) {
      Promise.resolve(exitDocumentFullscreen()).catch(() => {});
    }
  }, []);

  return { requestFullscreen, exitFullscreen, isFullscreen };
}
