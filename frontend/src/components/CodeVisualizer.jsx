import { useEffect, useMemo, useRef, useState } from 'react';
import ReferenceDiagram from './ReferenceDiagram';
import { buildShareUrl } from '../lib/shareStep';

const PLAY_INTERVAL_MS = 550;
const SPEEDS = [0.5, 1, 2, 4];

function StepIcon({ d }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICON_PATHS = {
  first: 'M2 1v10h1.5V1H2zm2.5 5 5.5 5V1z',
  prev: 'M8 1v10L2.5 6z',
  next: 'M4 1v10L9.5 6z',
  last: 'M8.5 1v10H10V1H8.5zM7 6 1.5 1v10z',
  play: 'M2 1.2 L10.5 6 L2 10.8 Z',
  pause: 'M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z',
};

function ShareIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9.5" cy="2.5" r="1.5" /><circle cx="2.5" cy="6" r="1.5" /><circle cx="9.5" cy="9.5" r="1.5" />
      <path d="M3.8 5.2 8.2 3.3M3.8 6.8 8.2 8.7" />
    </svg>
  );
}

const EVENT_LABELS = { line: 'line', call: 'call', return: 'return', exception: 'exception' };

function isRef(value) {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '__ref__');
}

// Assigns every heap object a small, STABLE display number (#1, #2, ...) in
// first-appearance order across the WHOLE trace, not per-step — a list
// created on step 3 keeps the same #N tag on step 40 as long as it's the
// same Python object (same id()). ReferenceDiagram only ever sees one
// step's heap at a time, so this has to be computed up here where the
// full step list is available.
function buildHeapIdLabels(steps) {
  const labels = {};
  let next = 1;
  for (const step of steps || []) {
    for (const id of Object.keys(step.heap || {})) {
      if (!(id in labels)) labels[id] = next++;
    }
  }
  return labels;
}

// "Formal" view: the same step data as the diagram, but as literal
// Python-style text (name = [1, 2, 3]) instead of boxes — some students
// read a plain literal faster than a graph, especially for small state.
// Resolves refs through heap recursively; a cycle (a container that
// contains itself) prints as `...` at the repeat, same as Python's own
// repr() does for self-referential containers.
function formatFormalValue(value, heap, seen) {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value.startsWith('<') && value.endsWith('>')) return value;
    return JSON.stringify(value);
  }
  if (isRef(value)) {
    const id = value.__ref__;
    if (seen.has(id)) return '...';
    const obj = heap[id];
    if (!obj) return '<?>';
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    if (obj.type === 'dict') {
      const parts = obj.items.map(([k, v]) => `${typeof k === 'string' ? JSON.stringify(k) : String(k)}: ${formatFormalValue(v, heap, nextSeen)}`);
      if (obj.more) parts.push('...');
      return `{${parts.join(', ')}}`;
    }
    const parts = obj.items.map((v) => formatFormalValue(v, heap, nextSeen));
    if (obj.more) parts.push('...');
    if (obj.type === 'tuple') return parts.length === 1 ? `(${parts[0]},)` : `(${parts.join(', ')})`;
    if (obj.type === 'set') return parts.length ? `{${parts.join(', ')}}` : 'set()';
    return `[${parts.join(', ')}]`;
  }
  return String(value);
}

function FormalView({ locals, heap }) {
  const entries = Object.entries(locals);
  return (
    <div className="viz-formal">
      {entries.length === 0 && <div className="viz-empty-row">No local variables yet</div>}
      {entries.map(([name, value]) => (
        <div className="viz-formal-row" key={name}>
          <span className="viz-formal-name">{name}</span>
          <span className="viz-formal-eq">=</span>
          <span className="viz-formal-value">{formatFormalValue(value, heap, new Set())}</span>
        </div>
      ))}
    </div>
  );
}

// The IDE's Visualize panel: step controls + a call-stack breadcrumb + a
// boxes-and-arrows memory diagram (see ReferenceDiagram.jsx) + output, all
// over a trace already fetched by the caller. Purely a scrubber over data
// it's handed — it owns only which step is selected and whether autoplay
// is running, not the fetch itself (that stays in IDE.jsx next to the Run
// flow it mirrors). Reports the active line back up via onStepChange so
// the caller can push it into the CodeMirror highlight. language/code/
// stdin are needed only for the Share button (see lib/shareStep.js) —
// a shared link re-runs the trace on arrival rather than the server
// storing it, so the exact source that produced this trace has to travel
// with the link. initialStep, when given, seeds the very first trace this
// component ever receives (used once, then ignored — see the ref below)
// so following a shared link lands on the right step instead of step 1.
export default function CodeVisualizer({ trace, isTracing, traceError, onStepChange, language, code, stdin, initialStep, theme }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [numberBase, setNumberBase] = useState('dec');
  const [showIndex, setShowIndex] = useState(true);
  const [viewMode, setViewMode] = useState('simplified');
  const [speed, setSpeed] = useState(1);
  const [shareCopied, setShareCopied] = useState(false);
  const initialStepAppliedRef = useRef(false);

  const steps = trace?.steps || [];
  const currentStep = steps[stepIndex] || null;
  const prevStep = stepIndex > 0 ? (steps[stepIndex - 1] || null) : null;
  const atStart = stepIndex === 0;
  const atEnd = stepIndex >= steps.length - 1;
  const heapIdLabels = useMemo(() => buildHeapIdLabels(steps), [steps]);

  // New trace arrived (or was cleared) — restart the scrub, applying
  // initialStep only the very first time (a shared link's target step),
  // never on a later re-run even if the prop is still set.
  useEffect(() => {
    const step = !initialStepAppliedRef.current && initialStep != null
      ? Math.min(Math.max(initialStep, 0), Math.max(steps.length - 1, 0))
      : 0;
    initialStepAppliedRef.current = true;
    setStepIndex(step);
    setPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace]);

  useEffect(() => {
    onStepChange(currentStep ? currentStep.line : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  useEffect(() => {
    if (!playing) return undefined;
    if (atEnd) { setPlaying(false); return undefined; }
    const id = setTimeout(() => setStepIndex((i) => Math.min(i + 1, steps.length - 1)), PLAY_INTERVAL_MS / speed);
    return () => clearTimeout(id);
  }, [playing, stepIndex, atEnd, steps.length, speed]);

  const jumpTo = (i) => { setPlaying(false); setStepIndex(Math.min(Math.max(i, 0), Math.max(steps.length - 1, 0))); };

  const handleShare = async () => {
    const url = buildShareUrl({ language, code, stdin, step: stepIndex });
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1800);
    } catch {
      // Clipboard access can be denied (permissions, non-HTTPS context in
      // dev, etc.) — the diagram itself doesn't depend on this succeeding,
      // so just leave the button clickable to try again rather than
      // surfacing a whole error state for a copy-to-clipboard failure.
    }
  };

  let ledClass = 'led blue';
  if (isTracing) ledClass = 'led amber pulse';
  else if (traceError) ledClass = 'led red';
  else if (trace) ledClass = 'led teal';

  return (
    <div className="visualizer">
      <div className="visualizer-header">
        <span className="eyebrow">
          <span className={ledClass} />
          Visualize
        </span>
        {!isTracing && currentStep && (
          <span className="viz-step-count">
            <span className={`viz-event-badge viz-event-${currentStep.event}`}>{EVENT_LABELS[currentStep.event] || currentStep.event}</span>
            Step {stepIndex + 1} / {steps.length}
          </span>
        )}
      </div>

      {isTracing && <div className="viz-empty">Running and tracing execution…</div>}
      {!isTracing && traceError && <div className="viz-empty viz-error">{traceError}</div>}
      {!isTracing && !traceError && !trace && (
        <div className="viz-empty">Hit "Run" to step through your code line by line.</div>
      )}

      {!isTracing && !traceError && steps.length > 0 && currentStep && (
        <>
          <div className="viz-controls">
            <button type="button" className="btn btn-ghost viz-step-btn" aria-label="First step" disabled={atStart} onClick={() => jumpTo(0)}><StepIcon d={ICON_PATHS.first} /></button>
            <button type="button" className="btn btn-ghost viz-step-btn" aria-label="Previous step" disabled={atStart} onClick={() => jumpTo(stepIndex - 1)}><StepIcon d={ICON_PATHS.prev} /></button>
            <button type="button" className="btn btn-primary viz-play-btn" onClick={() => setPlaying((p) => !p)} disabled={atEnd && !playing}>
              <StepIcon d={playing ? ICON_PATHS.pause : ICON_PATHS.play} />
              {playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" className="btn btn-ghost viz-step-btn" aria-label="Next step" disabled={atEnd} onClick={() => jumpTo(stepIndex + 1)}><StepIcon d={ICON_PATHS.next} /></button>
            <button type="button" className="btn btn-ghost viz-step-btn" aria-label="Last step" disabled={atEnd} onClick={() => jumpTo(steps.length - 1)}><StepIcon d={ICON_PATHS.last} /></button>
            <input
              type="range"
              className="viz-scrubber"
              min={0}
              max={Math.max(steps.length - 1, 0)}
              value={stepIndex}
              onChange={(e) => jumpTo(Number(e.target.value))}
              aria-label="Scrub to step"
            />
          </div>

          <div className="viz-secondary-row">
            <div className="viz-callstack-inline">
              <span className="viz-callstack-label">Stack</span>
              {currentStep.stack.map((fn, i, arr) => (
                <span key={`${fn}-${i}`} className="viz-callstack-item">
                  <span className={`viz-callstack-chip${i === arr.length - 1 ? ' viz-callstack-chip-active' : ''}`}>{fn}</span>
                  {i < arr.length - 1 && <span className="viz-callstack-arrow">›</span>}
                </span>
              ))}
            </div>

            <div className="viz-secondary-controls">
              <div className="segmented viz-mini-segmented">
                {['dec', 'bin', 'oct', 'hex'].map((b) => (
                  <button key={b} type="button" className={numberBase === b ? 'active' : ''} onClick={() => setNumberBase(b)}>{b}</button>
                ))}
              </div>
              <div className="segmented viz-mini-segmented">
                {[['simplified', 'simplified'], ['formal', 'formal']].map(([val, label]) => (
                  <button key={val} type="button" className={viewMode === val ? 'active' : ''} onClick={() => setViewMode(val)}>{label}</button>
                ))}
              </div>
              <button
                type="button"
                className={`btn btn-ghost viz-index-toggle${showIndex ? ' viz-toggle-on' : ''}`}
                aria-pressed={showIndex}
                onClick={() => setShowIndex((v) => !v)}
              >
                index
              </button>
              <select
                aria-label="Playback speed"
                className="viz-speed-select"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
              <button type="button" className="btn btn-ghost viz-share-btn" onClick={handleShare}>
                <ShareIcon />
                {shareCopied ? 'Copied!' : 'Share this step'}
              </button>
            </div>
          </div>

          {viewMode === 'formal' ? (
            <FormalView locals={currentStep.locals} heap={currentStep.heap} />
          ) : (
            <ReferenceDiagram
              locals={currentStep.locals}
              heap={currentStep.heap}
              prevLocals={prevStep?.locals ?? null}
              prevHeap={prevStep?.heap ?? null}
              idLabels={heapIdLabels}
              showIndex={showIndex}
              numberBase={numberBase}
              theme={theme}
            />
          )}

          <div className="viz-output">
            <div className="viz-panel-title">Output so far</div>
            <pre className="viz-output-body">{currentStep.stdout || '(no output yet)'}</pre>
          </div>

          {currentStep.event === 'exception' && (
            <div className="viz-exception">{currentStep.error}</div>
          )}
          {trace.error && atEnd && currentStep.event !== 'exception' && (
            <div className="viz-exception">{trace.error}</div>
          )}
          {trace.truncated && atEnd && (
            <div className="viz-truncated-note">
              Trace stopped at {steps.length} steps to keep things fast — the program itself still ran to completion.
            </div>
          )}
        </>
      )}
    </div>
  );
}
