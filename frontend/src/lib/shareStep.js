// Shareable "step" links for the IDE's Visualize panel — no backend
// storage involved. A trace is fully reproducible from (language, code,
// stdin) alone, so the link just carries those plus the step index; the
// receiving page re-runs the trace itself and jumps straight to that step.
// That sidesteps needing a new DB table / retrieval endpoint entirely,
// at the cost of the URL growing with the snippet's own length — fine for
// the short teaching snippets this page is meant for.
const PARAM = 'share';

export function buildShareUrl({ language, code, stdin, step }) {
  const payload = { l: language, c: code, s: stdin || '', i: step };
  const url = new URL(window.location.href);
  url.hash = `${url.hash.split('?')[0]}?${PARAM}=${encodeURIComponent(JSON.stringify(payload))}`;
  return url.toString();
}

// Reads the share payload out of the current hash-router URL (HashRouter
// puts the query string after the route, e.g. "#/ide?share=..."), if any.
export function readSharePayload() {
  const hash = window.location.hash || '';
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return null;
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  const raw = params.get(PARAM);
  if (!raw) return null;
  try {
    const payload = JSON.parse(decodeURIComponent(raw));
    if (typeof payload.l !== 'string' || typeof payload.c !== 'string') return null;
    return {
      language: payload.l,
      code: payload.c,
      stdin: typeof payload.s === 'string' ? payload.s : '',
      step: Number.isInteger(payload.i) ? payload.i : 0,
    };
  } catch {
    return null;
  }
}

// Strips the share query off the URL after it's been consumed, so a
// subsequent Run/edit doesn't keep pointing at the original shared
// snapshot in the address bar.
export function clearSharePayload() {
  const hash = window.location.hash || '';
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return;
  const route = hash.slice(0, queryIndex);
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${route}`);
}
