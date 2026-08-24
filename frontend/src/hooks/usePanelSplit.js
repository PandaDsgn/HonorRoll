import { useState, useEffect, useCallback } from 'react';

// Drag-to-resize the left/right column split in .sandbox (shared by IDE.jsx
// and Sandbox.jsx) — the "vertical line" between the two columns. Clamped
// to [MIN_PERCENT, MAX_PERCENT] so a fast drag can't collapse either side to
// nothing or push the divider off-screen. containerRef must point at the
// .sandbox flex-row element so drag position can be read as a percentage of
// its own width, not the viewport's.
const STORAGE_KEY = 'codejudge-editor-split';
const MIN_PERCENT = 20;
const MAX_PERCENT = 70;
const DEFAULT_PERCENT = 40;

function getInitialPercent() {
  const stored = Number(window.localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(stored) && stored >= MIN_PERCENT && stored <= MAX_PERCENT) return stored;
  return DEFAULT_PERCENT;
}

export function usePanelSplit(containerRef) {
  const [leftPercent, setLeftPercent] = useState(getInitialPercent);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, String(leftPercent));
  }, [leftPercent]);

  useEffect(() => {
    if (!dragging) return undefined;

    const clampFromClientX = (clientX) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const percent = ((clientX - rect.left) / rect.width) * 100;
      setLeftPercent(Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent)));
    };

    const onMouseMove = (e) => clampFromClientX(e.clientX);
    const onTouchMove = (e) => { if (e.touches[0]) clampFromClientX(e.touches[0].clientX); };
    const stopDragging = () => setDragging(false);

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('mouseup', stopDragging);
    window.addEventListener('touchend', stopDragging);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('mouseup', stopDragging);
      window.removeEventListener('touchend', stopDragging);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, containerRef]);

  const startDragging = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  return { leftPercent, dragging, startDragging };
}
