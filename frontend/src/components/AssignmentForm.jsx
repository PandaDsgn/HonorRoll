import { useState, useEffect } from 'react';
import axios from 'axios';
import { API } from '../config';

const LANGS = ['python', 'c', 'cpp', 'java'];
const QUESTION_TYPES = [
  { id: 'scan', label: 'Scanned (handwritten)' },
  { id: 'mcq', label: 'MCQ' },
  { id: 'short', label: 'Short answer' },
  { id: 'long', label: 'Long answer' },
  { id: 'coding', label: 'Coding' },
];
const emptyTestCase = () => ({ input: '', expectedOutput: '', isHidden: true });

// Same mcq/short/long/coding/scan shape ExamForm.jsx's items use — no
// per-question time limit (only the whole assignment has one) and no
// coding "reuse an existing assignment" mode (see
// normalizeScanAssignmentQuestion on the backend for why).
function emptyQuestion(type = 'scan') {
  return {
    type,
    prompt: '',
    marks: 1,
    options: [{ id: 'a', text: '' }, { id: 'b', text: '' }],
    correctOptionId: '',
    wordLimit: '',
    starterCode: { python: '', c: '', cpp: '', java: '' },
    testCases: [emptyTestCase()],
  };
}

// Converts one question as returned by GET /api/admin/problems/:id into
// this form's internal shape, filling in defaults for whatever an
// older/plain scan-only question never had.
function questionFromServer(q) {
  return {
    type: q.type || 'scan',
    prompt: q.prompt || '',
    marks: q.marks ?? 1,
    options: Array.isArray(q.options) && q.options.length ? q.options : [{ id: 'a', text: '' }, { id: 'b', text: '' }],
    correctOptionId: q.correctOptionId || '',
    wordLimit: q.wordLimit != null ? String(q.wordLimit) : '',
    starterCode: { python: '', c: '', cpp: '', java: '', ...(q.starterCode || {}) },
    testCases: Array.isArray(q.testCases) && q.testCases.length ? q.testCases : [emptyTestCase()],
  };
}

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

export default function AssignmentForm({ initialData, onSubmit, onCancel }) {
  const isEditMode = !!initialData;

  // 'scan' assignments skip the code-judge fields entirely — students
  // scan handwritten answers to these questions instead of writing code.
  // submissionMode itself can't change after creation (the type toggle
  // below is hidden in edit mode), but everything else — including the
  // question set — is fully editable.
  const [submissionMode, setSubmissionMode] = useState(initialData?.submissionMode || 'code');
  const [assignmentNo, setAssignmentNo] = useState(initialData?.assignmentNo || '');
  const [questions, setQuestions] = useState(
    initialData?.questions?.length ? initialData.questions.map(questionFromServer) : [emptyQuestion()]
  );

  const [title, setTitle] = useState(initialData?.title || '');
  const [difficulty, setDifficulty] = useState(initialData?.difficulty || 'Easy');
  const [description, setDescription] = useState(initialData?.description || '');

  const [starterCode, setStarterCode] = useState(() => {
    const def = { python: '', c: '', cpp: '', java: '' };
    return initialData?.starterCode ? { ...def, ...initialData.starterCode } : def;
  });

  const [testCases, setTestCases] = useState(
    initialData?.testCases?.length ? initialData.testCases : [emptyTestCase()]
  );

  const [opensAt, setOpensAt] = useState(formatLocal(initialData?.opensAt));
  const [closesAt, setClosesAt] = useState(formatLocal(initialData?.closesAt));
  const [subjectId, setSubjectId] = useState(initialData?.subjectId != null ? String(initialData.subjectId) : '');
  const [subjects, setSubjects] = useState([]);

  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Best-effort — an admin sees every subject and can leave this on "No
  // subject" for an org-wide item; a teacher only ever sees (via the
  // backend's own org-scoping) the subjects they're actually assigned to,
  // and must pick one since teacher-created items are always subject-scoped.
  useEffect(() => {
    axios.get(`${API}/api/admin/subjects`, { withCredentials: true })
      .then((res) => setSubjects(res.data.subjects))
      .catch(() => {});
  }, []);

  const updateTestCase = (idx, patch) => {
    setTestCases((prev) => prev.map((tc, i) => (i === idx ? { ...tc, ...patch } : tc)));
  };
  const addTestCase = () => setTestCases((prev) => [...prev, emptyTestCase()]);
  const removeTestCase = (idx) => setTestCases((prev) => prev.filter((_, i) => i !== idx));

  const updateQuestion = (idx, patch) => {
    setQuestions((prev) => prev.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  };
  const addQuestion = () => setQuestions((prev) => [...prev, emptyQuestion()]);
  const removeQuestion = (idx) => setQuestions((prev) => prev.filter((_, i) => i !== idx));

  // Switching a question's type wipes its type-specific fields (a
  // half-filled MCQ becomes meaningless once it's a coding question) but
  // keeps marks, same as ExamForm's changeItemType.
  const changeQuestionType = (idx, type) => {
    setQuestions((prev) => prev.map((q, i) => (i === idx ? { ...emptyQuestion(type), marks: q.marks } : q)));
  };

  const addOption = (idx) => {
    setQuestions((prev) => prev.map((q, i) => {
      if (i !== idx) return q;
      const nextId = String.fromCharCode(97 + q.options.length);
      return { ...q, options: [...q.options, { id: nextId, text: '' }] };
    }));
  };
  const updateOption = (idx, optionId, text) => {
    setQuestions((prev) => prev.map((q, i) => (i === idx
      ? { ...q, options: q.options.map((o) => (o.id === optionId ? { ...o, text } : o)) }
      : q)));
  };
  const removeOption = (idx, optionId) => {
    setQuestions((prev) => prev.map((q, i) => {
      if (i !== idx) return q;
      const options = q.options.filter((o) => o.id !== optionId);
      const correctOptionId = q.correctOptionId === optionId ? '' : q.correctOptionId;
      return { ...q, options, correctOptionId };
    }));
  };

  const updateQuestionStarterCode = (idx, lang, code) => {
    setQuestions((prev) => prev.map((q, i) => (i === idx
      ? { ...q, starterCode: { ...q.starterCode, [lang]: code } }
      : q)));
  };
  const updateQuestionTestCase = (idx, tcIdx, patch) => {
    setQuestions((prev) => prev.map((q, i) => (i === idx
      ? { ...q, testCases: q.testCases.map((tc, j) => (j === tcIdx ? { ...tc, ...patch } : tc)) }
      : q)));
  };
  const addQuestionTestCase = (idx) => {
    setQuestions((prev) => prev.map((q, i) => (i === idx ? { ...q, testCases: [...q.testCases, emptyTestCase()] } : q)));
  };
  const removeQuestionTestCase = (idx, tcIdx) => {
    setQuestions((prev) => prev.map((q, i) => (i === idx
      ? { ...q, testCases: q.testCases.filter((_, j) => j !== tcIdx) }
      : q)));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!title.trim() || !description.trim()) {
      setError('Title and description are required.');
      return;
    }

    let cleanCases = [];
    let cleanQuestions = [];
    if (submissionMode === 'code') {
      cleanCases = testCases.filter((tc) => tc.expectedOutput.trim() !== '');
      if (cleanCases.length === 0) {
        setError('At least one test case with an expected output is required.');
        return;
      }
    } else {
      if (!assignmentNo.trim()) {
        setError('Assignment number is required for scanned assignments.');
        return;
      }
      for (let i = 0; i < questions.length; i += 1) {
        const q = questions[i];
        const label = `Question ${i + 1}`;
        if (!q.marks || Number(q.marks) <= 0) { setError(`${label}: marks must be a positive number.`); return; }
        if (q.type === 'mcq') {
          if (!q.prompt.trim()) { setError(`${label}: question text is required.`); return; }
          const filled = q.options.filter((o) => o.text.trim());
          if (filled.length < 2) { setError(`${label}: add at least 2 options.`); return; }
          if (!q.correctOptionId || !filled.some((o) => o.id === q.correctOptionId)) {
            setError(`${label}: select which option is correct.`);
            return;
          }
        } else if (q.type === 'short' || q.type === 'long' || q.type === 'scan') {
          if (!q.prompt.trim()) { setError(`${label}: question text is required.`); return; }
        } else if (q.type === 'coding') {
          if (!q.prompt.trim()) { setError(`${label}: question text is required.`); return; }
          const filledCases = q.testCases.filter((tc) => tc.expectedOutput.trim());
          if (filledCases.length === 0) { setError(`${label}: add at least one test case with an expected output.`); return; }
        }
      }
      cleanQuestions = questions.map((q) => ({
        type: q.type,
        marks: Number(q.marks),
        prompt: q.prompt.trim(),
        options: q.type === 'mcq' ? q.options.filter((o) => o.text.trim()) : undefined,
        correctOptionId: q.type === 'mcq' ? q.correctOptionId : undefined,
        wordLimit: (q.type === 'short' || q.type === 'long') && q.wordLimit ? Number(q.wordLimit) : undefined,
        starterCode: q.type === 'coding'
          ? Object.fromEntries(Object.entries(q.starterCode).filter(([, code]) => code.trim() !== ''))
          : undefined,
        testCases: q.type === 'coding' ? q.testCases.filter((tc) => tc.expectedOutput.trim() !== '') : undefined,
      }));
      if (cleanQuestions.length === 0) {
        setError('At least one question is required for scanned assignments.');
        return;
      }
    }

    if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) {
      setError('Deadline (closes) must be after the opening time.');
      return;
    }

    const payload = {
      title: title.trim(),
      difficulty,
      description: description.trim(),
      submissionMode,
      opensAt: toIsoOrNull(opensAt),
      closesAt: toIsoOrNull(closesAt),
      subjectId: subjectId || null,
      ...(submissionMode === 'code'
        ? {
            starterCode: Object.fromEntries(Object.entries(starterCode).filter(([, code]) => code.trim() !== '')),
            testCases: cleanCases,
          }
        : { assignmentNo: assignmentNo.trim(), questions: cleanQuestions }),
    };

    setSubmitting(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save assignment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="panel assignment-form" onSubmit={handleSubmit}>
      {!isEditMode && (
        <div className="field" style={{ marginBottom: 16 }}>
          <label>Assignment type</label>
          <div className="segmented" role="tablist" aria-label="Assignment type">
            <button type="button" role="tab" aria-pressed={submissionMode === 'code'} className={submissionMode === 'code' ? 'active' : ''} onClick={() => setSubmissionMode('code')}>
              Code
            </button>
            <button type="button" role="tab" aria-pressed={submissionMode === 'scan'} className={submissionMode === 'scan' ? 'active' : ''} onClick={() => setSubmissionMode('scan')}>
              Scanned handwritten
            </button>
          </div>
        </div>
      )}

      <div className="assignment-form-grid">
        <div className="field">
          <label htmlFor="af-title">Title</label>
          <input id="af-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>

        <div className="field">
          <label htmlFor="af-difficulty">Difficulty</label>
          <select id="af-difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            <option>Easy</option>
            <option>Medium</option>
            <option>Hard</option>
          </select>
        </div>

        {submissionMode === 'scan' && (
          <div className="field">
            <label htmlFor="af-assignment-no">Assignment number</label>
            <input id="af-assignment-no" placeholder="e.g. 3 or HW-3" value={assignmentNo} onChange={(e) => setAssignmentNo(e.target.value)} required />
          </div>
        )}

        <div className="field">
          <label htmlFor="af-opens">Opens at (optional)</label>
          <input id="af-opens" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="af-closes">Deadline (optional)</label>
          <input id="af-closes" type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="af-subject">Subject</label>
          <select id="af-subject" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">No subject (org-wide)</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name} — {s.org_unit_name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="af-desc">Description</label>
        <textarea id="af-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} required />
      </div>

      {submissionMode === 'code' && (
        <>
          <div className="field-group-label">Starter code (optional per language)</div>
          <div className="assignment-form-grid">
            {LANGS.map((lang) => (
              <div className="field" key={lang}>
                <label htmlFor={`af-code-${lang}`}>{lang}</label>
                <textarea
                  id={`af-code-${lang}`}
                  rows={4}
                  className="code-textarea"
                  value={starterCode[lang]}
                  onChange={(e) => setStarterCode((prev) => ({ ...prev, [lang]: e.target.value }))}
                />
              </div>
            ))}
          </div>

          <div className="field-group-label">Test cases</div>
          <div className="testcase-list">
            {testCases.map((tc, idx) => (
              <div className="testcase-row" key={idx}>
                <input placeholder="stdin (optional)" value={tc.input} onChange={(e) => updateTestCase(idx, { input: e.target.value })} />
                <input placeholder="expected output" value={tc.expectedOutput} onChange={(e) => updateTestCase(idx, { expectedOutput: e.target.value })} required />
                <label className="testcase-hidden-toggle">
                  <input type="checkbox" checked={tc.isHidden} onChange={(e) => updateTestCase(idx, { isHidden: e.target.checked })} />
                  hidden
                </label>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => removeTestCase(idx)} disabled={testCases.length === 1}>×</button>
              </div>
            ))}
            <button type="button" className="btn btn-ghost" onClick={addTestCase}>+ Add test case</button>
          </div>
        </>
      )}

      {submissionMode === 'scan' && (
        <>
          <div className="field-group-label">Questions</div>
          <div className="exam-item-list">
            {questions.map((q, idx) => (
              <div className="exam-item-card" key={idx}>
                <div className="exam-item-head">
                  <span className="exam-item-index">Question {idx + 1}</span>

                  <div className="field">
                    <label>Type</label>
                    <select className="assignment-select" value={q.type} onChange={(e) => changeQuestionType(idx, e.target.value)}>
                      {QUESTION_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>

                  <div className="field exam-item-field-sm">
                    <label>Marks</label>
                    <input type="number" min="1" value={q.marks} onChange={(e) => updateQuestion(idx, { marks: e.target.value })} />
                  </div>

                  <button type="button" className="btn btn-ghost btn-icon" onClick={() => removeQuestion(idx)} disabled={questions.length === 1}>×</button>
                </div>

                {(q.type === 'mcq' || q.type === 'short' || q.type === 'long' || q.type === 'scan' || q.type === 'coding') && (
                  <div className="field">
                    <label>Question text</label>
                    <textarea rows={q.type === 'long' ? 4 : 2} value={q.prompt} onChange={(e) => updateQuestion(idx, { prompt: e.target.value })} />
                  </div>
                )}

                {q.type === 'scan' && (
                  <p className="exam-item-hint">Answered on paper — every scanned question in this assignment compiles into one PDF the student uploads together.</p>
                )}

                {q.type === 'mcq' && (
                  <div className="mcq-options">
                    {q.options.map((o) => (
                      <div className="mcq-option-row" key={o.id}>
                        <input
                          type="radio"
                          name={`af-correct-${idx}`}
                          checked={q.correctOptionId === o.id}
                          onChange={() => updateQuestion(idx, { correctOptionId: o.id })}
                          aria-label={`Mark option ${o.id} correct`}
                        />
                        <input
                          type="text"
                          placeholder={`Option ${o.id}`}
                          value={o.text}
                          onChange={(e) => updateOption(idx, o.id, e.target.value)}
                        />
                        <button type="button" className="btn btn-ghost btn-icon" onClick={() => removeOption(idx, o.id)} disabled={q.options.length <= 2}>×</button>
                      </div>
                    ))}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => addOption(idx)}>+ Add option</button>
                  </div>
                )}

                {(q.type === 'short' || q.type === 'long') && (
                  <div className="field exam-item-field-md">
                    <label>Word limit (optional)</label>
                    <input type="number" min="1" placeholder="No limit" value={q.wordLimit} onChange={(e) => updateQuestion(idx, { wordLimit: e.target.value })} />
                  </div>
                )}

                {q.type === 'coding' && (
                  <>
                    <div className="field-group-label">Starter code (optional per language)</div>
                    <div className="assignment-form-grid">
                      {LANGS.map((lang) => (
                        <div className="field" key={lang}>
                          <label>{lang}</label>
                          <textarea
                            rows={4}
                            className="code-textarea"
                            value={q.starterCode[lang]}
                            onChange={(e) => updateQuestionStarterCode(idx, lang, e.target.value)}
                          />
                        </div>
                      ))}
                    </div>

                    <div className="field-group-label">Test cases</div>
                    <div className="testcase-list">
                      {q.testCases.map((tc, tcIdx) => (
                        <div className="testcase-row" key={tcIdx}>
                          <input placeholder="stdin (optional)" value={tc.input} onChange={(e) => updateQuestionTestCase(idx, tcIdx, { input: e.target.value })} />
                          <input placeholder="expected output" value={tc.expectedOutput} onChange={(e) => updateQuestionTestCase(idx, tcIdx, { expectedOutput: e.target.value })} />
                          <label className="testcase-hidden-toggle">
                            <input type="checkbox" checked={tc.isHidden} onChange={(e) => updateQuestionTestCase(idx, tcIdx, { isHidden: e.target.checked })} />
                            hidden
                          </label>
                          <button type="button" className="btn btn-ghost btn-icon" onClick={() => removeQuestionTestCase(idx, tcIdx)} disabled={q.testCases.length === 1}>×</button>
                        </div>
                      ))}
                      <button type="button" className="btn btn-ghost" onClick={() => addQuestionTestCase(idx)}>+ Add test case</button>
                    </div>
                  </>
                )}
              </div>
            ))}
            <button type="button" className="btn btn-ghost" onClick={addQuestion}>+ Add question</button>
          </div>
        </>
      )}

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
          {isEditMode ? (submitting ? 'Saving...' : 'Save changes') : (submitting ? 'Creating...' : 'Create assignment')}
        </button>
      </div>
    </form>
  );
}
