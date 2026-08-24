import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { useTheme } from '../hooks/useTheme';
import { useExamLockdown } from '../hooks/useExamLockdown';
import { useProctoring } from '../hooks/useProctoring';
import ExamScanCapture from '../components/ExamScanCapture';
import ExamCalculator from '../components/ExamCalculator';
import { API } from '../config';
import '../Exam.css';

const LANGUAGES = [
  { id: 'python', label: 'Python' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'java', label: 'Java' },
];

function getLanguageExtension(language) {
  if (language === 'python') return [python()];
  if (language === 'c' || language === 'cpp') return [cpp()];
  if (language === 'java') return [java()];
  return [];
}

// Server-authoritative countdown — recomputed from `deadlineAt` every tick
// rather than a client-only decrementing counter, so it can't drift or be
// tampered with by pausing the tab / messing with the system clock.
function formatTimer(ms) {
  if (ms === null || ms === undefined) return '--:--';
  const s = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

const END_REASON_LABEL = {
  manual: 'You submitted this exam.',
  time_up: 'Time ran out — your answers were submitted automatically.',
  violation_visibility: 'This exam ended because you switched away from the tab.',
  violation_blur: 'This exam ended because the window lost focus.',
  violation_fullscreen_exit: 'This exam ended because fullscreen was exited.',
  violation_unload: 'This exam ended because the page was closed or reloaded.',
  violation_proctor_absence: 'This exam ended because no face was detected in the camera for too long.',
  violation_proctor_phone: 'This exam ended because a phone was detected in the camera frame.',
};

export default function ExamAttempt() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { theme } = useTheme();

  // loading -> intro -> active -> [scanning, only if the exam has any
  // scan-type items] -> ended, or blocked/error at any point before active.
  // 'scanning' hands off to ExamScanCapture — see handleSubmitClick below
  // for why that's a distinct phase rather than folded into forceEnd.
  const [phase, setPhase] = useState('loading');
  const [examMeta, setExamMeta] = useState(null);
  const [blockedMessage, setBlockedMessage] = useState('');
  const [startError, setStartError] = useState('');
  const [starting, setStarting] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);

  const [attemptId, setAttemptId] = useState(null);
  const [deadlineAt, setDeadlineAt] = useState(null);
  const [items, setItems] = useState([]);
  const [answers, setAnswers] = useState({});
  const [runResults, setRunResults] = useState({});
  const [remainingMs, setRemainingMs] = useState(null);
  const [armed, setArmed] = useState(false);
  const [proctoringEnabled, setProctoringEnabled] = useState(false);
  const [endReason, setEndReason] = useState(null);

  const answersRef = useRef({});
  useEffect(() => { answersRef.current = answers; }, [answers]);

  const endingRef = useRef(false);

  useEffect(() => {
    const load = async () => {
      setPhase('loading');
      try {
        const res = await axios.get(`${API}/api/exams/${id}`, { withCredentials: true });
        setExamMeta(res.data.exam);
        if (res.data.attemptStatus === 'submitted') {
          setBlockedMessage('You have already completed this exam.');
          setPhase('blocked');
        } else if (res.data.attemptStatus === 'in_progress') {
          setBlockedMessage('This exam was already started and cannot be resumed.');
          setPhase('blocked');
        } else {
          setPhase('intro');
        }
      } catch (err) {
        setBlockedMessage(err.response?.data?.error || 'Could not load this exam.');
        setPhase('blocked');
      }
    };
    load();
  }, [id]);

  const buildAnswersArray = useCallback(() => (
    Object.entries(answersRef.current).map(([itemId, ans]) => ({ itemId: Number(itemId), ...ans }))
  ), []);

  // Holds the lockdown hook's exitFullscreen, synced via an effect below
  // (not written during render — the linter flags that as unsafe even
  // though exitFullscreen itself is referentially stable). Needed because
  // forceEnd and useExamLockdown each depend on the other (forceEnd calls
  // exitFullscreen; the lockdown hook calls forceEnd on a violation) — this
  // ref is what breaks that cycle instead of forceEnd closing over a
  // `lockdown` binding declared further down the file.
  const exitFullscreenRef = useRef(() => {});

  // The one path every ending route funnels through: manual Submit, the
  // timer hitting zero, and every lockdown violation. Guarded so a
  // violation firing at the same instant as the timer (or a double-click)
  // can't submit twice.
  const forceEnd = useCallback(async (reason, detail) => {
    if (endingRef.current) return;
    endingRef.current = true;
    setArmed(false); // disarm BEFORE exiting fullscreen, so that doesn't self-trigger a violation
    setProctoringEnabled(false);
    exitFullscreenRef.current();
    try {
      await axios.post(`${API}/api/exams/${id}/submit`, {
        reason,
        answers: buildAnswersArray(),
        detail,
      }, { withCredentials: true });
    } catch {
      // Best-effort — the attempt may already be closed by a racing beacon.
    }
    setEndReason(reason);
    setPhase('ended');
  }, [id, buildAnswersArray]);

  const lockdown = useExamLockdown({
    armed,
    onViolation: forceEnd,
    beaconUrl: attemptId ? `${API}/api/exams/${id}/submit` : null,
    buildBeaconPayload: () => ({ reason: 'violation_unload', answers: buildAnswersArray() }),
  });
  useEffect(() => {
    exitFullscreenRef.current = lockdown.exitFullscreen;
  }, [lockdown.exitFullscreen]);

  // ML webcam proctoring — only ever active on a webcam_required exam,
  // while the attempt is actually running. Minor flags (ambiguous —
  // head turned, gaze away) just get logged; major flags (unambiguous — no
  // face in frame, a phone in frame) end the exam the same way a lockdown
  // violation does.
  const proctoring = useProctoring({
    enabled: proctoringEnabled,
    onMinorFlag: (flagType, detail) => {
      axios.post(`${API}/api/exams/${id}/proctor-flag`, {
        severity: 'minor', flagType, detail,
      }, { withCredentials: true }).catch(() => {});
    },
    onMajorFlag: (flagType, detail) => {
      forceEnd(flagType === 'face_absent' ? 'violation_proctor_absence' : 'violation_proctor_phone', detail);
    },
  });
  const { videoRef: proctorVideoRef } = proctoring;

  // Belt-and-braces on top of forceEnd's own exitFullscreen() call — if the
  // exam ever lands on 'ended'/'blocked' while still fullscreen (a stray
  // browser quirk, a direct URL nav after ending, etc.), this independent
  // check closes it out too, so fullscreen can never visibly get stuck on.
  useEffect(() => {
    if (phase === 'ended' || phase === 'blocked') {
      lockdown.exitFullscreen();
    }
    // lockdown.exitFullscreen is a stable useCallback — the whole `lockdown`
    // object is a new literal every render, so depending on it here would
    // re-run this effect (and re-call exitFullscreen) on every render instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, lockdown.exitFullscreen]);

  // Countdown tick — active through 'scanning' too, not just 'active': a
  // student who reaches the scan step is functionally done, but their
  // deadline hasn't stopped, and this is the only thing standing between
  // a stalled scan phase and an exam that never actually ends.
  useEffect(() => {
    if ((phase !== 'active' && phase !== 'scanning') || !deadlineAt) return undefined;
    const tick = () => {
      const rem = deadlineAt - Date.now();
      setRemainingMs(rem);
      if (rem <= 0) forceEnd('time_up');
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [phase, deadlineAt, forceEnd]);

  const hasScanItems = items.some((it) => it.type === 'scan');

  // The manual Submit button's real handler — routed through the
  // interactive scan phase first when the exam has any scan-type items,
  // since forceEnd (also the beacon/timeout/violation path) can't
  // realistically carry a multi-page camera capture through an unload
  // event. Disarms the lockdown/proctoring the same way forceEnd itself
  // does before exiting fullscreen — requesting a NEW camera stream here
  // (a different device than proctoring's, on most phones, but the SAME
  // device on a single-camera laptop) must never register as a blur/
  // visibility violation just because the permission prompt appeared.
  const handleSubmitClick = () => {
    if (!hasScanItems) {
      forceEnd('manual');
      return;
    }
    setArmed(false);
    setProctoringEnabled(false);
    setPhase('scanning');
  };

  // Called once ExamScanCapture finishes — either with a compiled PDF, or
  // null if the student chose to skip scanning entirely. Uploads first,
  // then actually ends the attempt via the normal forceEnd path. Left to
  // throw on failure rather than caught here — ExamScanCapture's own
  // handleSubmit awaits this and drops back to its review screen on
  // rejection, same "try, catch, let them retry" shape ScanCapture.jsx's
  // own handleUpload uses.
  const handleScanDone = async (pdfBlob) => {
    if (!pdfBlob) {
      forceEnd('manual');
      return;
    }
    const formData = new FormData();
    formData.append('file', pdfBlob, 'scan.pdf');
    await axios.post(`${API}/api/exams/${id}/scan-submit`, formData, { withCredentials: true });
    forceEnd('manual');
  };

  const handleStart = async () => {
    setStarting(true);
    setStartError('');
    const fsOk = await lockdown.requestFullscreen();
    if (!fsOk) {
      setStartError("Fullscreen is required for this exam and isn't available on this device/browser.");
      setStarting(false);
      return;
    }

    if (examMeta?.webcam_required) {
      // Just a permission probe — useProctoring opens its own long-lived
      // stream once armed below. Stopping this one immediately means the
      // camera/mic don't flicker on/off/on for the student. One combined
      // request so there's a single permission prompt, not two.
      try {
        const probeStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        probeStream.getTracks().forEach((t) => t.stop());
      } catch {
        lockdown.exitFullscreen();
        setStartError('This exam requires webcam and microphone access. Please allow camera and microphone permission and try again.');
        setStarting(false);
        return;
      }
    }

    try {
      const res = await axios.post(`${API}/api/exams/${id}/start`, {}, { withCredentials: true });
      const initialAnswers = {};
      res.data.items.forEach((it) => {
        if (it.type === 'mcq') {
          initialAnswers[it.id] = { selectedOptionId: null };
        } else if (it.type === 'coding') {
          const firstLang = Object.keys(it.starterCode || {})[0] || 'python';
          initialAnswers[it.id] = { language: firstLang, code: it.starterCode?.[firstLang] || '' };
        } else {
          initialAnswers[it.id] = { textAnswer: '' };
        }
      });
      setAttemptId(res.data.attemptId);
      setDeadlineAt(new Date(res.data.deadlineAt).getTime());
      setItems(res.data.items);
      setAnswers(initialAnswers);
      setArmed(true);
      if (examMeta?.webcam_required) setProctoringEnabled(true);
      setPhase('active');
    } catch (err) {
      lockdown.exitFullscreen();
      setStartError(err.response?.data?.error || 'Failed to start exam.');
    } finally {
      setStarting(false);
    }
  };

  const updateAnswer = (itemId, patch) => {
    setAnswers((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...patch } }));
  };

  const runCodingItem = async (item) => {
    const ans = answers[item.id];
    if (!ans?.code || runResults[item.id]?.status === 'running') return;
    setRunResults((prev) => ({ ...prev, [item.id]: { status: 'running', results: [] } }));

    const results = [];
    for (const sample of item.samples || []) {
      try {
        const res = await axios.post(
          `${API}/api/execute/${ans.language}`,
          { code: ans.code, stdin: sample.input },
          { withCredentials: true }
        );
        const out = (res.data.output || '').trim().replace(/\r\n/g, '\n');
        const exp = (sample.expected_output || '').trim().replace(/\r\n/g, '\n');
        results.push({ input: sample.input, expected: sample.expected_output, actual: res.data.output, pass: out === exp });
      } catch (err) {
        results.push({ input: sample.input, expected: sample.expected_output, actual: err.response?.data?.error || 'Execution failed', pass: false });
      }
    }
    setRunResults((prev) => ({ ...prev, [item.id]: { status: 'done', results } }));
  };

  if (phase === 'loading') {
    return <div className="sb-shell"><p className="sb-loading" style={{ padding: 40 }}>Loading exam…</p></div>;
  }

  if (phase === 'blocked') {
    return (
      <div className="sb-shell exam-message-shell">
        <div className="panel exam-message-panel">
          <h1 className="problems-title">{examMeta?.title || 'Exam'}</h1>
          <p>{blockedMessage}</p>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/exams')}>Back to exams</button>
        </div>
      </div>
    );
  }

  if (phase === 'intro') {
    return (
      <div className="sb-shell exam-message-shell">
        <div className="panel exam-message-panel">
          <h1 className="problems-title">{examMeta?.title}</h1>
          {examMeta?.description && <p>{examMeta.description}</p>}
          <ul className="exam-rules">
            <li>{examMeta?.total_marks} marks, {Math.round(examMeta?.total_time_seconds / 60)} minutes.</li>
            <li>This exam runs in fullscreen for its entire duration.</li>
            <li>Leaving fullscreen, switching tabs, or letting the window lose focus ends the exam immediately with whatever answers exist at that moment.</li>
            <li>You can only take this exam once — closing or reloading the page also ends it.</li>
            {examMeta?.webcam_required && (
              <li>This exam requires webcam and microphone access. Your camera and audio are monitored for the duration — no face in frame, or a phone held up to it, ends the exam immediately; unusual movement or conversation is logged.</li>
            )}
            {examMeta?.calculator_allowed && (
              <li>A {examMeta.calculator_type} calculator is available during this exam via the toolbar button.</li>
            )}
          </ul>

          {startError && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{startError}</span>
            </div>
          )}

          <button type="button" className="btn btn-primary" onClick={handleStart} disabled={starting}>
            {starting && <span className="spinner" />}
            {starting ? 'Starting…' : 'Start Exam'}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'ended') {
    return (
      <div className="sb-shell exam-message-shell">
        <div className="panel exam-message-panel">
          <h1 className="problems-title">Exam submitted</h1>
          <p>{END_REASON_LABEL[endReason] || 'Your exam has ended.'}</p>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/exams')}>Back to exams</button>
        </div>
      </div>
    );
  }

  if (phase === 'scanning') {
    return (
      <div className="sb-shell">
        <header className="sb-topbar exam-take-topbar">
          <span className="brand">{examMeta?.title}</span>
          <span className="sb-timer exam-countdown" title="Time remaining">{formatTimer(remainingMs)}</span>
        </header>
        <section className="admin-shell">
          <ExamScanCapture
            items={items.filter((it) => it.type === 'scan')}
            onDone={handleScanDone}
          />
        </section>
      </div>
    );
  }

  // phase === 'active'
  return (
    <div className="sb-shell">
      <header className="sb-topbar exam-take-topbar">
        <span className="brand">{examMeta?.title}</span>
        <div className="sb-actions">
          <span className="sb-timer exam-countdown" title="Time remaining">{formatTimer(remainingMs)}</span>
          {examMeta?.calculator_allowed && (
            <button type="button" className="btn btn-ghost" onClick={() => setShowCalculator((s) => !s)}>
              {showCalculator ? 'Hide Calculator' : 'Calculator'}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={handleSubmitClick}>Submit Exam</button>
        </div>
      </header>

      {examMeta?.calculator_allowed && showCalculator && (
        <ExamCalculator type={examMeta.calculator_type} onClose={() => setShowCalculator(false)} />
      )}

      <div className="exam-take-body">
        {items.map((item, idx) => {
          const ans = answers[item.id] || {};
          return (
            <div className="panel exam-take-item" key={item.id}>
              <div className="exam-take-item-head">
                <span className="exam-item-index">Item {idx + 1}</span>
                <span className="chip chip-neutral"><span className="dot" />{item.marks} marks</span>
              </div>

              {item.prompt && <p className="exam-take-prompt">{item.prompt}</p>}

              {item.type === 'mcq' && (
                <div className="exam-mcq-options">
                  {(item.options || []).map((o) => (
                    <label className="exam-mcq-option" key={o.id}>
                      <input
                        type="radio"
                        name={`item-${item.id}`}
                        checked={ans.selectedOptionId === o.id}
                        onChange={() => updateAnswer(item.id, { selectedOptionId: o.id })}
                      />
                      <span>{o.text}</span>
                    </label>
                  ))}
                </div>
              )}

              {(item.type === 'short' || item.type === 'long') && (
                <div className="field">
                  <textarea
                    rows={item.type === 'long' ? 6 : 3}
                    value={ans.textAnswer || ''}
                    onChange={(e) => updateAnswer(item.id, { textAnswer: e.target.value })}
                  />
                  {item.wordLimit && (
                    <span className="exam-word-count">
                      {(ans.textAnswer || '').trim().split(/\s+/).filter(Boolean).length} / {item.wordLimit} words
                    </span>
                  )}
                </div>
              )}

              {item.type === 'scan' && (
                <p className="auth-sub">Answer this on paper — you'll scan it in with your camera after submitting.</p>
              )}

              {item.type === 'coding' && (
                <div className="exam-coding-item">
                  <div className="segmented" role="tablist">
                    {LANGUAGES.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        className={ans.language === l.id ? 'active' : ''}
                        onClick={() => updateAnswer(item.id, { language: l.id, code: item.starterCode?.[l.id] || '' })}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>

                  <div className="editor-panel lc-editor exam-editor">
                    <CodeMirror
                      value={ans.code || ''}
                      height="260px"
                      theme={theme === 'light' ? 'light' : 'dark'}
                      extensions={getLanguageExtension(ans.language)}
                      onChange={(val) => updateAnswer(item.id, { code: val })}
                    />
                  </div>

                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => runCodingItem(item)} disabled={runResults[item.id]?.status === 'running'}>
                    {runResults[item.id]?.status === 'running' ? <span className="spinner" /> : null} Run against samples
                  </button>

                  {runResults[item.id]?.status === 'done' && (
                    <div className="exam-run-results">
                      {runResults[item.id].results.map((r, i) => (
                        <div key={i} className={`exam-run-case ${r.pass ? 'pass' : 'fail'}`}>
                          <span className="chip chip-neutral">Sample {i + 1}: {r.pass ? 'Passed' : 'Failed'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {proctoringEnabled && (
        <div className="exam-proctor-preview" title="Your camera — monitored for the rest of this exam">
          <video ref={proctorVideoRef} autoPlay muted playsInline />
        </div>
      )}
    </div>
  );
}
