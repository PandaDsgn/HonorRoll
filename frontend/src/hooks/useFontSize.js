import { useState, useEffect, useCallback } from 'react';

// Shared by IDE.jsx and Sandbox.jsx (both render a CodeMirror editor) so
// bumping the font size in one place sticks across every code-editing page,
// same "one namespaced localStorage key, lazy-init state, persist on
// change" shape as useTheme.js.
const STORAGE_KEY = 'codejudge-editor-font-size';
const MIN_FONT_SIZE = 11;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 14;
const STEP = 1;

function getInitialFontSize() {
  const stored = Number(window.localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(stored) && stored >= MIN_FONT_SIZE && stored <= MAX_FONT_SIZE) return stored;
  return DEFAULT_FONT_SIZE;
}

export function useFontSize() {
  const [fontSize, setFontSize] = useState(getInitialFontSize);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, String(fontSize));
  }, [fontSize]);

  const increaseFontSize = useCallback(() => {
    setFontSize((prev) => Math.min(MAX_FONT_SIZE, prev + STEP));
  }, []);
  const decreaseFontSize = useCallback(() => {
    setFontSize((prev) => Math.max(MIN_FONT_SIZE, prev - STEP));
  }, []);

  return {
    fontSize,
    increaseFontSize,
    decreaseFontSize,
    canIncrease: fontSize < MAX_FONT_SIZE,
    canDecrease: fontSize > MIN_FONT_SIZE,
  };
}
