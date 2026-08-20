import { useState, useEffect } from 'react';
import axios from 'axios';
import { API } from '../config';

const LANGS = ['python', 'c', 'cpp', 'java'];
const emptyTestCase = () => ({ input: '', expectedOutput: '', isHidden: true });
const emptyQuestion = () => ({ prompt: '', marks: 1 });

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
    initialData?.questions?.length ? initialData.questions : [emptyQuestion()]
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
      cleanQuestions = questions
        .filter((q) => q.prompt.trim() !== '')
        .map((q) => ({ prompt: q.prompt.trim(), marks: Number(q.marks) > 0 ? Number(q.marks) : 1 }));
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
          <div className="testcase-list">
            {questions.map((q, idx) => (
              <div className="testcase-row" key={idx}>
                <input placeholder={`Question ${idx + 1}`} value={q.prompt} onChange={(e) => updateQuestion(idx, { prompt: e.target.value })} required />
                <input type="number" min="1" style={{ maxWidth: 90 }} placeholder="marks" value={q.marks} onChange={(e) => updateQuestion(idx, { marks: e.target.value })} required />
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => removeQuestion(idx)} disabled={questions.length === 1}>×</button>
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
