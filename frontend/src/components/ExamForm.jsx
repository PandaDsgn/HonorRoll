import { useState, useEffect } from 'react';
import axios from 'axios';
import { CODE_LANGUAGES } from '../lib/codeLanguages';
import { API } from '../config';

const ITEM_TYPES = [
  { id: 'mcq', label: 'MCQ' },
  { id: 'short', label: 'Short answer' },
  { id: 'long', label: 'Long answer' },
  { id: 'coding', label: 'Coding' },
  { id: 'scan', label: 'Scanned (handwritten)' },
];

function toIsoOrNull(localValue) {
  if (!localValue) return null;
  const d = new Date(localValue);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Every duration in this form is edited in minutes (friendlier for an admin
// typing "45") but stored/sent as seconds (what the backend and the student
// countdown both actually run on).
function secondsToMinutesInput(sec) {
  return sec === null || sec === undefined ? '' : String(Math.round(sec / 60));
}
function minutesInputToSeconds(val) {
  if (val === '' || val === null || val === undefined) return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : null;
}

let itemKeySeq = 0;
function nextItemKey() {
  itemKeySeq += 1;
  return `item-${itemKeySeq}-${Date.now()}`;
}

const CODING_LANGS = CODE_LANGUAGES.map((l) => l.id);
const emptyStarterCode = () => Object.fromEntries(CODING_LANGS.map((id) => [id, '']));
const emptyItemTestCase = () => ({ input: '', expectedOutput: '', isHidden: true });

function emptyItem(type = 'mcq') {
  return {
    key: nextItemKey(),
    type,
    marks: '1',
    timeLimitMinutes: '',
    prompt: '',
    options: [{ id: 'a', text: '' }, { id: 'b', text: '' }],
    correctOptionId: '',
    wordLimit: '',
    problemId: '',
    // coding-only, "custom question" mode (as opposed to 'reuse', which
    // just points problemId at an existing assignment)
    codingMode: 'reuse',
    starterCode: emptyStarterCode(),
    testCases: [emptyItemTestCase()],
  };
}

// Converts one item as returned by GET /api/admin/exams/:id (snake_case,
// seconds) into this form's internal shape (camelCase, minutes for display).
function itemFromServer(it) {
  return {
    key: nextItemKey(),
    type: it.type,
    marks: String(it.marks ?? 1),
    timeLimitMinutes: secondsToMinutesInput(it.time_limit_seconds),
    prompt: it.prompt || '',
    options: Array.isArray(it.options) && it.options.length
      ? it.options.map((o) => ({ id: o.id, text: o.text }))
      : [{ id: 'a', text: '' }, { id: 'b', text: '' }],
    correctOptionId: it.correct_option_id || '',
    wordLimit: it.word_limit != null ? String(it.word_limit) : '',
    problemId: it.problem_id != null ? String(it.problem_id) : '',
    codingMode: it.type === 'coding' && !it.problem_id ? 'custom' : 'reuse',
    starterCode: { ...emptyStarterCode(), ...(it.starter_code || {}) },
    testCases: Array.isArray(it.test_cases) && it.test_cases.length
      ? it.test_cases.map((tc) => ({ input: tc.input || '', expectedOutput: tc.expectedOutput || '', isHidden: !!tc.isHidden }))
      : [emptyItemTestCase()],
  };
}

export default function ExamForm({ initialData, onSubmit, onCancel }) {
  const isEditMode = !!initialData;

  const [title, setTitle] = useState(initialData?.title || '');
  const [description, setDescription] = useState(initialData?.description || '');
  const [totalTimeMinutes, setTotalTimeMinutes] = useState(secondsToMinutesInput(initialData?.total_time_seconds));
  const [webcamRequired, setWebcamRequired] = useState(!!initialData?.webcam_required);
  const [calculatorAllowed, setCalculatorAllowed] = useState(!!initialData?.calculator_allowed);
  const [calculatorType, setCalculatorType] = useState(initialData?.calculator_type || 'basic');
  const [opensAt, setOpensAt] = useState(formatLocal(initialData?.opens_at));
  const [closesAt, setClosesAt] = useState(formatLocal(initialData?.closes_at));
  const [subjectId, setSubjectId] = useState(initialData?.subject_id != null ? String(initialData.subject_id) : '');
  const [subjects, setSubjects] = useState([]);

  useEffect(() => {
    axios.get(`${API}/api/admin/subjects`, { withCredentials: true })
      .then((res) => setSubjects(res.data.subjects))
      .catch(() => {});
  }, []);

  const [items, setItems] = useState(
    initialData?.items?.length ? initialData.items.map(itemFromServer) : [emptyItem()]
  );

  // Populates the "coding item -> which assignment" dropdown. Reuses the
  // same student-facing list endpoint the Students panel already uses for
  // its per-assignment filter.
  const [assignments, setAssignments] = useState([]);
  useEffect(() => {
    axios.get(`${API}/api/problems`, { withCredentials: true })
      .then((res) => setAssignments(res.data.problems))
      .catch(() => {});
  }, []);

  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [bankStatus, setBankStatus] = useState({}); // { [itemKey]: 'saving' | 'saved' | 'error' }
  const [bankItems, setBankItems] = useState(null);
  const [showBankPicker, setShowBankPicker] = useState(false);

  const updateItem = (key, patch) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  };
  const addItem = () => setItems((prev) => [...prev, emptyItem()]);
  const removeItem = (key) => setItems((prev) => prev.filter((it) => it.key !== key));

  // Switching an item's type wipes its type-specific fields (a half-filled
  // MCQ becomes meaningless once it's a coding item) but keeps marks and
  // time limit, since those are meaningful regardless of type.
  const changeItemType = (key, type) => {
    setItems((prev) => prev.map((it) => (it.key === key
      ? { ...emptyItem(type), key, marks: it.marks, timeLimitMinutes: it.timeLimitMinutes }
      : it)));
  };

  const addOption = (key) => {
    setItems((prev) => prev.map((it) => {
      if (it.key !== key) return it;
      const nextId = String.fromCharCode(97 + it.options.length); // a, b, c, ...
      return { ...it, options: [...it.options, { id: nextId, text: '' }] };
    }));
  };
  const updateOption = (key, optionId, text) => {
    setItems((prev) => prev.map((it) => (it.key === key
      ? { ...it, options: it.options.map((o) => (o.id === optionId ? { ...o, text } : o)) }
      : it)));
  };
  const removeOption = (key, optionId) => {
    setItems((prev) => prev.map((it) => {
      if (it.key !== key) return it;
      const options = it.options.filter((o) => o.id !== optionId);
      const correctOptionId = it.correctOptionId === optionId ? '' : it.correctOptionId;
      return { ...it, options, correctOptionId };
    }));
  };

  const setCodingMode = (key, codingMode) => updateItem(key, { codingMode });
  const updateItemStarterCode = (key, lang, code) => {
    setItems((prev) => prev.map((it) => (it.key === key
      ? { ...it, starterCode: { ...it.starterCode, [lang]: code } }
      : it)));
  };
  const updateItemTestCase = (key, idx, patch) => {
    setItems((prev) => prev.map((it) => (it.key === key
      ? { ...it, testCases: it.testCases.map((tc, i) => (i === idx ? { ...tc, ...patch } : tc)) }
      : it)));
  };
  const addItemTestCase = (key) => {
    setItems((prev) => prev.map((it) => (it.key === key
      ? { ...it, testCases: [...it.testCases, emptyItemTestCase()] }
      : it)));
  };
  const removeItemTestCase = (key, idx) => {
    setItems((prev) => prev.map((it) => (it.key === key
      ? { ...it, testCases: it.testCases.filter((_, i) => i !== idx) }
      : it)));
  };

  const totalMarks = items.reduce((sum, it) => sum + (Number(it.marks) || 0), 0);

  const itemToPayload = (it) => ({
    type: it.type,
    marks: Number(it.marks),
    timeLimitSeconds: minutesInputToSeconds(it.timeLimitMinutes),
    prompt: it.prompt.trim(),
    options: it.type === 'mcq' ? it.options.filter((o) => o.text.trim()) : undefined,
    correctOptionId: it.type === 'mcq' ? it.correctOptionId : undefined,
    wordLimit: (it.type === 'short' || it.type === 'long') && it.wordLimit ? Number(it.wordLimit) : undefined,
    problemId: it.type === 'coding' && it.codingMode === 'reuse' ? Number(it.problemId) : undefined,
    starterCode: it.type === 'coding' && it.codingMode === 'custom'
      ? Object.fromEntries(Object.entries(it.starterCode).filter(([, code]) => code.trim() !== ''))
      : undefined,
    testCases: it.type === 'coding' && it.codingMode === 'custom'
      ? it.testCases.filter((tc) => tc.expectedOutput.trim() !== '')
      : undefined,
  });

  const saveItemToBank = async (it) => {
    setBankStatus((s) => ({ ...s, [it.key]: 'saving' }));
    try {
      await axios.post(`${API}/api/admin/question-bank`, { ...itemToPayload(it), subjectId: subjectId || null }, { withCredentials: true });
      setBankStatus((s) => ({ ...s, [it.key]: 'saved' }));
      setTimeout(() => setBankStatus((s) => ({ ...s, [it.key]: undefined })), 2000);
    } catch {
      setBankStatus((s) => ({ ...s, [it.key]: 'error' }));
    }
  };

  const openBankPicker = async () => {
    setShowBankPicker(true);
    setBankItems(null);
    try {
      const res = await axios.get(`${API}/api/admin/question-bank`, { params: subjectId ? { subjectId } : {}, withCredentials: true });
      setBankItems(res.data.items);
    } catch (err) {
      setBankItems([]);
      setError(err.response?.data?.error || 'Failed to load question bank.');
    }
  };

  const insertFromBank = (bankItem) => {
    setItems((prev) => [...prev, itemFromServer(bankItem)]);
    setShowBankPicker(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!title.trim()) { setError('Title is required.'); return; }

    const totalTimeSeconds = minutesInputToSeconds(totalTimeMinutes);
    if (!totalTimeSeconds) { setError('Total exam time is required and must be a positive number of minutes.'); return; }

    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const label = `Item ${i + 1}`;
      if (!it.marks || Number(it.marks) <= 0) { setError(`${label}: marks must be a positive number.`); return; }

      if (it.type === 'mcq') {
        if (!it.prompt.trim()) { setError(`${label}: question text is required.`); return; }
        const filled = it.options.filter((o) => o.text.trim());
        if (filled.length < 2) { setError(`${label}: add at least 2 options.`); return; }
        if (!it.correctOptionId || !filled.some((o) => o.id === it.correctOptionId)) {
          setError(`${label}: select which option is correct.`);
          return;
        }
      } else if (it.type === 'short' || it.type === 'long' || it.type === 'scan') {
        if (!it.prompt.trim()) { setError(`${label}: question text is required.`); return; }
      } else if (it.type === 'coding') {
        if (it.codingMode === 'reuse') {
          if (!it.problemId) { setError(`${label}: pick a coding assignment.`); return; }
        } else {
          if (!it.prompt.trim()) { setError(`${label}: question text is required.`); return; }
          const filledCases = it.testCases.filter((tc) => tc.expectedOutput.trim());
          if (filledCases.length === 0) { setError(`${label}: add at least one test case with an expected output.`); return; }
        }
      }
    }

    const payload = {
      title: title.trim(),
      description: description.trim() || null,
      totalTimeSeconds,
      webcamRequired,
      calculatorAllowed,
      calculatorType: calculatorAllowed ? calculatorType : null,
      opensAt: toIsoOrNull(opensAt),
      closesAt: toIsoOrNull(closesAt),
      subjectId: subjectId || null,
      items: items.map(itemToPayload),
    };

    setSubmitting(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save exam.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="panel assignment-form" onSubmit={handleSubmit}>
      <div className="assignment-form-grid">
        <div className="field">
          <label htmlFor="ex-title">Title</label>
          <input id="ex-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>

        <div className="field">
          <label htmlFor="ex-total-time">Total exam time (minutes)</label>
          <input
            id="ex-total-time"
            type="number"
            min="1"
            value={totalTimeMinutes}
            onChange={(e) => setTotalTimeMinutes(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="ex-opens">Opens at (optional)</label>
          <input id="ex-opens" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="ex-closes">Deadline (optional)</label>
          <input id="ex-closes" type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="ex-subject">Subject</label>
          <select id="ex-subject" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">No subject (org-wide)</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name} — {s.org_unit_name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="ex-desc">Description (optional)</label>
        <textarea id="ex-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <label className="testcase-hidden-toggle" style={{ fontSize: '13px' }}>
        <input type="checkbox" checked={webcamRequired} onChange={(e) => setWebcamRequired(e.target.checked)} />
        Require webcam proctoring for this exam
      </label>

      <label className="testcase-hidden-toggle" style={{ fontSize: '13px' }}>
        <input type="checkbox" checked={calculatorAllowed} onChange={(e) => setCalculatorAllowed(e.target.checked)} />
        Allow a calculator during this exam
      </label>

      {calculatorAllowed && (
        <div className="field" style={{ maxWidth: 320, marginBottom: '16px' }}>
          <label htmlFor="ex-calc-type">Calculator type</label>
          <select id="ex-calc-type" value={calculatorType} onChange={(e) => setCalculatorType(e.target.value)}>
            <option value="basic">Basic — arithmetic, memory, percentage</option>
            <option value="scientific">Scientific — trig, log, powers, roots (fx-991-style)</option>
            <option value="programmer">Programmer — base-N, bitwise ops</option>
            <option value="statistics">Statistics — mean, stddev, variance</option>
            <option value="financial">Financial — TVM solver (PV/FV/PMT/N/I)</option>
          </select>
        </div>
      )}

      <div className="field-group-label">
        Items — {totalMarks} marks total
      </div>

      <div className="exam-item-list">
        {items.map((it, idx) => (
          <div className="exam-item-card" key={it.key}>
            <div className="exam-item-head">
              <span className="exam-item-index">Item {idx + 1}</span>

              <div className="field">
                <label>Type</label>
                <select
                  value={it.type}
                  onChange={(e) => changeItemType(it.key, e.target.value)}
                >
                  {ITEM_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>

              <div className="field exam-item-field-sm">
                <label>Marks</label>
                <input type="number" min="1" value={it.marks} onChange={(e) => updateItem(it.key, { marks: e.target.value })} />
              </div>

              <div className="field exam-item-field-md">
                <label>Time limit (min, optional)</label>
                <input
                  type="number"
                  min="1"
                  placeholder="No sub-limit"
                  value={it.timeLimitMinutes}
                  onChange={(e) => updateItem(it.key, { timeLimitMinutes: e.target.value })}
                />
              </div>

              <button type="button" className="btn btn-ghost btn-sm" onClick={() => saveItemToBank(it)} disabled={bankStatus[it.key] === 'saving'}>
                {bankStatus[it.key] === 'saved' ? 'Saved ✓' : bankStatus[it.key] === 'error' ? 'Failed — retry' : 'Save to bank'}
              </button>

              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => removeItem(it.key)}
                disabled={items.length === 1}
              >
                ×
              </button>
            </div>

            {(it.type === 'mcq' || it.type === 'short' || it.type === 'long' || it.type === 'scan' || (it.type === 'coding' && it.codingMode === 'custom')) && (
              <div className="field">
                <label>Question text</label>
                <textarea
                  rows={it.type === 'long' ? 4 : 2}
                  value={it.prompt}
                  onChange={(e) => updateItem(it.key, { prompt: e.target.value })}
                />
              </div>
            )}

            {it.type === 'scan' && (
              <p className="exam-item-hint">Answered on paper — the student scans it in with their camera, and every scanned item in the exam is combined into one PDF for you to grade.</p>
            )}

            {it.type === 'mcq' && (
              <div className="mcq-options">
                {it.options.map((o) => (
                  <div className="mcq-option-row" key={o.id}>
                    <input
                      type="radio"
                      name={`correct-${it.key}`}
                      checked={it.correctOptionId === o.id}
                      onChange={() => updateItem(it.key, { correctOptionId: o.id })}
                      aria-label={`Mark option ${o.id} correct`}
                    />
                    <input
                      type="text"
                      placeholder={`Option ${o.id}`}
                      value={o.text}
                      onChange={(e) => updateOption(it.key, o.id, e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      onClick={() => removeOption(it.key, o.id)}
                      disabled={it.options.length <= 2}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => addOption(it.key)}>+ Add option</button>
              </div>
            )}

            {(it.type === 'short' || it.type === 'long') && (
              <div className="field exam-item-field-md">
                <label>Word limit (optional)</label>
                <input
                  type="number"
                  min="1"
                  placeholder="No limit"
                  value={it.wordLimit}
                  onChange={(e) => updateItem(it.key, { wordLimit: e.target.value })}
                />
              </div>
            )}

            {it.type === 'coding' && (
              <div className="field">
                <label>Coding question source</label>
                <div className="segmented" role="tablist">
                  <button type="button" className={it.codingMode === 'reuse' ? 'active' : ''} onClick={() => setCodingMode(it.key, 'reuse')}>Reuse existing assignment</button>
                  <button type="button" className={it.codingMode === 'custom' ? 'active' : ''} onClick={() => setCodingMode(it.key, 'custom')}>Write custom question</button>
                </div>
              </div>
            )}

            {it.type === 'coding' && it.codingMode === 'reuse' && (
              <div className="field">
                <label>Coding assignment</label>
                <select
                  value={it.problemId}
                  onChange={(e) => updateItem(it.key, { problemId: e.target.value })}
                >
                  <option value="">Select an assignment…</option>
                  {assignments.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                </select>
                <p className="exam-item-hint">Reuses that assignment's test cases and starter code as-is.</p>
              </div>
            )}

            {it.type === 'coding' && it.codingMode === 'custom' && (
              <>
                <div className="field-group-label">Starter code (optional per language)</div>
                <div className="assignment-form-grid">
                  {CODING_LANGS.map((lang) => (
                    <div className="field" key={lang}>
                      <label>{lang}</label>
                      <textarea
                        rows={4}
                        className="code-textarea"
                        value={it.starterCode[lang]}
                        onChange={(e) => updateItemStarterCode(it.key, lang, e.target.value)}
                      />
                    </div>
                  ))}
                </div>

                <div className="field-group-label">Test cases</div>
                <div className="testcase-list">
                  {it.testCases.map((tc, idx) => (
                    <div className="testcase-row" key={idx}>
                      <input
                        placeholder="stdin (optional)"
                        value={tc.input}
                        onChange={(e) => updateItemTestCase(it.key, idx, { input: e.target.value })}
                      />
                      <input
                        placeholder="expected output"
                        value={tc.expectedOutput}
                        onChange={(e) => updateItemTestCase(it.key, idx, { expectedOutput: e.target.value })}
                      />
                      <label className="testcase-hidden-toggle">
                        <input
                          type="checkbox"
                          checked={tc.isHidden}
                          onChange={(e) => updateItemTestCase(it.key, idx, { isHidden: e.target.checked })}
                        />
                        hidden
                      </label>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={() => removeItemTestCase(it.key, idx)}
                        disabled={it.testCases.length === 1}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button type="button" className="btn btn-ghost" onClick={() => addItemTestCase(it.key)}>+ Add test case</button>
                </div>
              </>
            )}
          </div>
        ))}

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={addItem}>+ Add item</button>
          <button type="button" className="btn btn-ghost" onClick={openBankPicker}>Insert from bank</button>
        </div>

        {showBankPicker && (
          <div className="panel" style={{ padding: 14, marginTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong style={{ fontSize: 13 }}>Question bank{subjectId ? '' : ' (org-wide)'}</strong>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowBankPicker(false)}>Close</button>
            </div>
            {bankItems === null ? (
              <p className="sb-loading">Loading…</p>
            ) : bankItems.length === 0 ? (
              <p className="sb-loading">Nothing saved to the bank yet — use "Save to bank" on any item above.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {bankItems.map((b) => (
                  <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <strong>{b.type}</strong> · {b.marks} marks{b.prompt ? ` · ${b.prompt.slice(0, 60)}` : ''}
                    </span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => insertFromBank(b)}>Insert</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="alert" role="alert">
          <span className="alert-icon">!</span>
          <span>{error}</span>
        </div>
      )}

      <div className="assignment-form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting && <span className="spinner" />}
          {isEditMode ? (submitting ? 'Saving...' : 'Save changes') : (submitting ? 'Creating...' : 'Create exam')}
        </button>
      </div>
    </form>
  );
}
