import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { API } from '../config';
import '../Exam.css';

const PENDING_COPY = {
  deadline: 'Your tags will be visible once this assignment\'s deadline passes.',
  notGraded: 'Your teacher hasn\'t graded this submission yet.',
  ocrFailed: 'We couldn\'t read your scanned submission — check with your teacher.',
};

// Student's own result for one assignment — mirrors ExamResult.jsx, see
// backend/index.js GET /api/problems/:id/result. A key missing from the
// response means that tag is toggled off platform-wide — its row is
// omitted entirely rather than shown as some placeholder.
export default function AssignmentResult() {
  const navigate = useNavigate();
  const { id } = useParams();

  const [phase, setPhase] = useState('loading'); // loading | error | pending | graded
  const [errorMessage, setErrorMessage] = useState('');
  const [pendingReason, setPendingReason] = useState(null);
  const [result, setResult] = useState({});
  const [scanGrade, setScanGrade] = useState(null); // scan-mode only — see below

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // submission_mode decides which result shape this assignment even
        // has — code mode's percentile/grade tags (GET .../result) don't
        // exist for a scanned submission, which is graded per-question
        // instead (GET /api/me/scan-submission's `grade` field).
        const problemRes = await axios.get(`${API}/api/problems/${id}`, { withCredentials: true });
        if (cancelled) return;

        if (problemRes.data.problem.submission_mode === 'scan') {
          const subRes = await axios.get(`${API}/api/me/scan-submission`, { params: { problemId: id }, withCredentials: true });
          if (cancelled) return;
          if (!subRes.data.submission || !subRes.data.submission.grade) {
            setPendingReason(subRes.data.submission?.status === 'ocr_failed' ? 'ocrFailed' : 'notGraded');
            setPhase('pending');
          } else {
            setScanGrade(subRes.data.submission.grade);
            setPhase('graded');
          }
          return;
        }

        const res = await axios.get(`${API}/api/problems/${id}/result`, { withCredentials: true });
        if (cancelled) return;
        if (res.data.status === 'pending') {
          setPendingReason(res.data.reason);
          setPhase('pending');
        } else {
          setResult(res.data);
          setPhase('graded');
        }
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err.response?.data?.error || 'Could not load your result.');
        setPhase('error');
      }
    })();

    return () => { cancelled = true; };
  }, [id]);

  const showPercentile = result.percentileTag !== undefined;
  const showOverall = result.overallAssignmentsPercentileTag !== undefined;
  const showGrade = result.gradeTag !== undefined;
  const noTagsEnabled = phase === 'graded' && !scanGrade && !showPercentile && !showOverall && !showGrade;

  return (
    <div className="sb-shell exam-message-shell">
      <div className="panel exam-message-panel">
        <h1 className="problems-title">Your result</h1>

        {phase === 'loading' && <p className="sb-loading">Loading…</p>}

        {phase === 'error' && <p>{errorMessage}</p>}

        {phase === 'pending' && <p>{PENDING_COPY[pendingReason] || 'Your result isn\'t available yet.'}</p>}

        {noTagsEnabled && <p>Your teacher hasn't enabled result tags yet.</p>}

        {phase === 'graded' && scanGrade && (
          <>
            <div className="exam-mcq-option" style={{ cursor: 'default', marginBottom: 12 }}>
              <span>Total</span>
              <span className="chip chip-neutral" style={{ marginLeft: 'auto' }}>{scanGrade.awardedMarks}/{scanGrade.totalMarks}</span>
            </div>
            <div className="exam-mcq-options">
              {scanGrade.questions.map((q, i) => (
                <div key={i} className="exam-mcq-option" style={{ cursor: 'default' }}>
                  <span>{q.prompt}</span>
                  <span className="chip chip-neutral" style={{ marginLeft: 'auto' }}>{q.marksAwarded}/{q.maxMarks}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {phase === 'graded' && !noTagsEnabled && !scanGrade && (
          <>
            <p>
              Percentile reflects how you did relative to other students, grouped into five bands
              (Very Weak to Very Strong) — not your raw score.
            </p>
            <div className="exam-mcq-options" style={{ marginTop: 8 }}>
              {showPercentile && (
                <div className="exam-mcq-option" style={{ cursor: 'default' }}>
                  <span>This assignment</span>
                  <span className="chip chip-neutral" style={{ marginLeft: 'auto' }}>
                    <span className="dot" />{result.percentileTag || 'Not yet ranked'}
                  </span>
                </div>
              )}
              {showOverall && (
                <div className="exam-mcq-option" style={{ cursor: 'default' }}>
                  <span>Overall (all your assignments)</span>
                  <span className="chip chip-neutral" style={{ marginLeft: 'auto' }}>
                    <span className="dot" />{result.overallAssignmentsPercentileTag || 'Not yet ranked'}
                  </span>
                </div>
              )}
              {showGrade && (
                <div className="exam-mcq-option" style={{ cursor: 'default' }}>
                  <span>Grade</span>
                  <span className="chip chip-neutral" style={{ marginLeft: 'auto' }}>
                    <span className="dot" />{result.gradeTag || 'Not yet graded'}
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        <button type="button" className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => navigate('/assignments')}>
          Back to assignments
        </button>
      </div>
    </div>
  );
}
