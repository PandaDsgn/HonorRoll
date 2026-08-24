import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { CODE_LANGUAGES, codeFileName, getCodeMirrorExtension, HELLO_WORLD_CODE } from '../lib/codeLanguages';
import { useTheme } from '../hooks/useTheme';
import { useFontSize } from '../hooks/useFontSize';
import { usePanelSplit } from '../hooks/usePanelSplit';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher, { SpaceNotifications } from '../components/SpaceSwitcher';
import { API } from '../config';

const LANGUAGES = CODE_LANGUAGES.map((l) => ({ ...l, file: codeFileName(l.id, 'main') }));
const DEFAULT_CODE = HELLO_WORLD_CODE;

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d="M2 1.2 L10.5 6 L2 10.8 Z" />
    </svg>
  );
}

export default function IDE() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { fontSize, increaseFontSize, decreaseFontSize, canIncrease, canDecrease } = useFontSize();
  const sandboxRef = useRef(null);
  const { leftPercent, dragging, startDragging } = usePanelSplit(sandboxRef);

  const [language, setLanguage] = useState('python');
  const [code, setCode] = useState(DEFAULT_CODE.python);
  const [stdin, setStdin] = useState('');
  const [output, setOutput] = useState('Waiting for code execution...');

  const [isExecuting, setIsExecuting] = useState(false);
  const [isError, setIsError] = useState(false);
  const [hasRun, setHasRun] = useState(false);

  const selectLanguage = (lang) => {
    setLanguage(lang);
    setCode(DEFAULT_CODE[lang] || '');
    setOutput('Waiting for code execution...');
    setIsError(false);
    setHasRun(false);
  };

  const getLanguageExtension = () => getCodeMirrorExtension(language);

  const handleRunCode = async () => {
    setIsExecuting(true);
    setIsError(false);
    setHasRun(false);
    setOutput('Executing in secure container...');

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

  const activeLang = LANGUAGES.find((l) => l.id === language);
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
            A free space to write and run code — no problem, no grading, no test cases.
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
              <select aria-label="Language" className="language-select" value={language} onChange={(e) => selectLanguage(e.target.value)}>
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

            <button type="button" className="btn btn-primary" onClick={handleRunCode} disabled={isExecuting}>
              {isExecuting ? <span className="spinner" /> : <PlayIcon />}
              {isExecuting ? 'Running' : 'Run'}
            </button>
          </div>

          <div className="editor-panel">
            <div className="editor-tab">
              <span className="lang-dot" style={{ background: activeLang?.dot }} />
              {activeLang?.file}
            </div>
            <CodeMirror
              value={code}
              height="100%"
              theme={theme === 'light' ? 'light' : 'dark'}
              extensions={[...getLanguageExtension(), EditorView.theme({ '&': { fontSize: `${fontSize}px` } })]}
              onChange={(val) => setCode(val)}
              className="cm-wrap"
            />
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
        </section>
      </div>
    </div>
  );
}
