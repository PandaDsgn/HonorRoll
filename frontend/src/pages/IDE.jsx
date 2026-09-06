import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { CODE_LANGUAGES, codeFileName, getCodeMirrorExtension, HELLO_WORLD_CODE } from '../lib/codeLanguages';
import { execLineExtensions, setExecLine } from '../lib/execLineHighlight';
import { useTheme } from '../hooks/useTheme';
import { useFontSize } from '../hooks/useFontSize';
import { usePanelSplit } from '../hooks/usePanelSplit';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher, { SpaceNotifications } from '../components/SpaceSwitcher';
import CodeVisualizer from '../components/CodeVisualizer';
import { readSharePayload, clearSharePayload } from '../lib/shareStep';
import { API } from '../config';
import '../Visualizer.css';

const LANGUAGES = CODE_LANGUAGES.map((l) => ({ ...l, file: codeFileName(l.id, 'main') }));
const DEFAULT_CODE = HELLO_WORLD_CODE;

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d="M2 1.2 L10.5 6 L2 10.8 Z" />
    </svg>
  );
}

function VizIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="1" y="7.5" width="2.5" height="3.5" />
      <rect x="4.75" y="4.5" width="2.5" height="6.5" />
      <rect x="8.5" y="1.5" width="2.5" height="9.5" />
    </svg>
  );
}

export default function IDE() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { fontSize, increaseFontSize, decreaseFontSize, canIncrease, canDecrease } = useFontSize();
  const sandboxRef = useRef(null);
  const editorPanelRef = useRef(null);
  const cmViewRef = useRef(null);
  const { leftPercent, dragging, startDragging } = usePanelSplit(sandboxRef);

  // Lets a student drag the editor taller directly — not the whole panel.
  // editor-panel normally shares .sandbox-right's height with console/
  // visualizer via flex-grow ratios (see index.css/Visualizer.css); once
  // set, this overrides that with an explicit flex-basis so the editor
  // gets exactly what was dragged and console/visualizer share whatever's
  // left. null means "natural flex-grow share, same as before this
  // existed" — most relevant right when Visualize is turned on, since
  // the diagram's own min-height then squeezes the editor down; this is
  // the direct way to claw that room back for the code itself.
  const MIN_EDITOR_HEIGHT = 120;
  const [editorHeight, setEditorHeight] = useState(null);
  const [resizingEditor, setResizingEditor] = useState(false);

  useEffect(() => {
    if (!resizingEditor) return undefined;
    const clampFromClientY = (clientY) => {
      // Measured from editor-panel's OWN top, not .sandbox-right's — that
      // would also count the toolbar above it, making the very first
      // mousemove jump the editor taller by the toolbar's height before
      // it started tracking the cursor properly.
      const rect = editorPanelRef.current?.getBoundingClientRect();
      if (!rect) return;
      setEditorHeight(Math.max(MIN_EDITOR_HEIGHT, clientY - rect.top));
    };
    const onMouseMove = (e) => clampFromClientY(e.clientY);
    const onTouchMove = (e) => { if (e.touches[0]) clampFromClientY(e.touches[0].clientY); };
    const stopResizing = () => setResizingEditor(false);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('mouseup', stopResizing);
    window.addEventListener('touchend', stopResizing);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('mouseup', stopResizing);
      window.removeEventListener('touchend', stopResizing);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizingEditor]);

  const startResizingEditor = (e) => {
    e.preventDefault();
    setResizingEditor(true);
  };

  const [language, setLanguage] = useState('python');
  const [code, setCode] = useState(DEFAULT_CODE.python);
  const [stdin, setStdin] = useState('');
  const [output, setOutput] = useState('Waiting for code execution...');

  const [isExecuting, setIsExecuting] = useState(false);
  const [isError, setIsError] = useState(false);
  const [hasRun, setHasRun] = useState(false);

  const [trace, setTrace] = useState(null);
  const [traceError, setTraceError] = useState(null);
  // Off by default — Console is always the primary output; Visualize is an
  // opt-in extra alongside it, not a replacement, so a student always has
  // somewhere to see their program's output regardless of this toggle.
  const [showVisualizer, setShowVisualizer] = useState(false);
  // A shared step link's target step (see lib/shareStep.js) — only ever
  // set once, right on load, and consumed by CodeVisualizer the first
  // time it mounts with a trace.
  const [initialStep, setInitialStep] = useState(null);
  const [pendingShareRun, setPendingShareRun] = useState(false);

  const activeLang = LANGUAGES.find((l) => l.id === language);
  const visualizerActive = showVisualizer && activeLang?.traceSupported;

  const selectLanguage = (lang) => {
    setLanguage(lang);
    setCode(DEFAULT_CODE[lang] || '');
    setOutput('Waiting for code execution...');
    setIsError(false);
    setHasRun(false);
    setTrace(null);
    setTraceError(null);
  };

  const getLanguageExtension = () => getCodeMirrorExtension(language);

  // Console always gets populated by Run, whichever path runs the code.
  // When the Visualize toggle is on for a traced language, that single
  // trace request supplies BOTH the console output (its finalOutput) and
  // the step-through data — no need to hit the plain execute endpoint too.
  const handleRunCode = async () => {
    setIsExecuting(true);
    setIsError(false);
    setHasRun(false);
    setOutput('Executing in secure container...');

    if (visualizerActive) {
      setTraceError(null);
      try {
        const response = await axios.post(
          `${API}/api/playground/trace/${language}`,
          { code, stdin },
          { withCredentials: true }
        );
        const data = response.data;
        setTrace(data);
        if (data.error) {
          // An uncaught exception mid-program — not a request failure, but
          // still worth surfacing in the console the same way a plain Run
          // would (stdout so far, then the error), not silently omitted.
          setIsError(true);
          setOutput(data.finalOutput ? `${data.finalOutput}\n${data.error}` : data.error);
        } else {
          setOutput(data.finalOutput || '(no output)');
        }
      } catch (err) {
        setTrace(null);
        setIsError(true);
        const message = err.response?.data?.error || 'Network error: Could not reach the server.';
        setTraceError(message);
        setOutput(message);
      } finally {
        setIsExecuting(false);
        setHasRun(true);
      }
      return;
    }

    try {
      const response = await axios.post(
        `${API}/api/playground/execute/${language}`,
        { code, stdin },
        { withCredentials: true }
      );
      if (response.status === 200) {
        setOutput(response.data.output);
      }
    } catch (err) {
      setIsError(true);
      setOutput(err.response?.data?.error || 'Network error: Could not reach the server.');
    } finally {
      setIsExecuting(false);
      setHasRun(true);
    }
  };

  // Clears the active-line highlight whenever the visualizer isn't showing
  // (toggled off, or an untraced language) — CodeVisualizer only reports a
  // line while it's mounted, so nothing else clears this otherwise.
  useEffect(() => {
    if (!visualizerActive) {
      cmViewRef.current?.dispatch({ effects: setExecLine.of(null) });
    }
  }, [visualizerActive]);

  // Loads a shared step link (see lib/shareStep.js) on first mount, if the
  // URL carries one. Split into two effects on purpose: this one only sets
  // state (language/code/stdin/etc.), and handleRunCode below only fires
  // on the NEXT render once those state updates have actually landed —
  // calling handleRunCode directly here would still close over the OLD
  // code/language from before this effect's setState calls, since state
  // updates aren't visible within the same render they were requested in.
  useEffect(() => {
    const payload = readSharePayload();
    if (!payload) return;
    setLanguage(payload.language);
    setCode(payload.code);
    setStdin(payload.stdin);
    setShowVisualizer(true);
    setInitialStep(payload.step);
    setPendingShareRun(true);
    clearSharePayload();
  }, []);

  useEffect(() => {
    if (!pendingShareRun) return;
    setPendingShareRun(false);
    handleRunCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingShareRun]);

  const handleVisualizerStepChange = (line) => {
    cmViewRef.current?.dispatch({ effects: setExecLine.of(line) });
  };

  const consoleStatus = isExecuting ? 'pending' : isError ? 'err' : 'out';

  let ledClass = 'led blue';
  if (isExecuting) {
    ledClass = 'led amber pulse';
  } else if (hasRun) {
    ledClass = isError ? 'led red' : 'led teal';
  }

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="ide" />
          <SpaceNotifications />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="sandbox" ref={sandboxRef}>
        <section className="sandbox-left" style={{ width: `${leftPercent}%` }}>
          <div className="sb-problem-head">
            <h1 className="sb-problem-title">IDE</h1>
          </div>
          <p className="sb-problem-desc">
            A free space to write and run code no problem, no grading, no test cases.
            Pick a language, write anything, and hit Run. If your program reads input,
            add it below and it'll be piped in as stdin.
          </p>

          <div className="field playground-stdin">
            <label htmlFor="stdin">stdin (optional)</label>
            <textarea
              id="stdin"
              rows={6}
              placeholder="Input passed to your program's stdin..."
              value={stdin}
              onChange={(e) => setStdin(e.target.value)}
            />
          </div>
        </section>

        <div
          className={`sandbox-divider${dragging ? ' dragging' : ''}`}
          onMouseDown={startDragging}
          onTouchStart={startDragging}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
        />

        <section className="sandbox-right" style={{ width: `${100 - leftPercent}%` }}>
          <div className="sb-toolbar">
            <div className="sb-toolbar-group">
              <select aria-label="Language" value={language} onChange={(e) => selectLanguage(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>

              <div className="font-size-control">
                <button type="button" className="btn btn-ghost font-size-btn" aria-label="Decrease font size" disabled={!canDecrease} onClick={decreaseFontSize}>−</button>
                <span className="font-size-value">{fontSize}px</span>
                <button type="button" className="btn btn-ghost font-size-btn" aria-label="Increase font size" disabled={!canIncrease} onClick={increaseFontSize}>+</button>
              </div>
            </div>

            <div className="sb-toolbar-buttons">
              <button type="button" className="btn btn-primary" onClick={handleRunCode} disabled={isExecuting}>
                {isExecuting ? <span className="spinner" /> : <PlayIcon />}
                {isExecuting ? 'Running' : 'Run'}
              </button>
              <button
                type="button"
                className={`btn btn-ghost viz-toggle${visualizerActive ? ' viz-toggle-on' : ''}`}
                onClick={() => setShowVisualizer((v) => !v)}
                disabled={!activeLang?.traceSupported}
                aria-pressed={visualizerActive}
                title={activeLang?.traceSupported
                  ? 'Also show a step-by-step visualization alongside the console'
                  : `Visualization isn't available for ${activeLang?.label} yet`}
              >
                <VizIcon />
                Visualize
              </button>
            </div>
          </div>

          <div className="editor-panel" ref={editorPanelRef} style={editorHeight ? { flex: `0 0 ${editorHeight}px` } : undefined}>
            <div className="editor-tab">
              <span className="lang-dot" style={{ background: activeLang?.dot }} />
              {activeLang?.file}
            </div>
            <CodeMirror
              value={code}
              height="100%"
              theme={theme === 'light' ? 'light' : 'dark'}
              extensions={[...getLanguageExtension(), ...execLineExtensions, EditorView.theme({ '&': { fontSize: `${fontSize}px` } })]}
              onChange={(val) => setCode(val)}
              onCreateEditor={(view) => { cmViewRef.current = view; }}
              className="cm-wrap"
            />
          </div>

          <div
            className={`editor-height-divider${resizingEditor ? ' dragging' : ''}`}
            onMouseDown={startResizingEditor}
            onTouchStart={startResizingEditor}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize code editor height"
            title="Drag to make the coding area taller"
          >
            <span className="editor-height-grip" />
          </div>

          <div className="console">
            <div className="console-header">
              <span className="eyebrow">
                <span className={ledClass} />
                Console
              </span>
              {isExecuting && <span className="console-status">running…</span>}
            </div>
            <div className="console-body">
              <div className={`console-line console-${consoleStatus}`}>{output}</div>
            </div>
          </div>

          {visualizerActive && (
            <CodeVisualizer
              trace={trace}
              isTracing={isExecuting}
              traceError={traceError}
              onStepChange={handleVisualizerStepChange}
              language={language}
              code={code}
              stdin={stdin}
              initialStep={initialStep}
              theme={theme}
            />
          )}
        </section>
      </div>
    </div>
  );
}
