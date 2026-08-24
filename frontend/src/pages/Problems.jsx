import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher, { SpaceNotifications } from '../components/SpaceSwitcher';
import { API } from '../config';

const DIFFICULTY_CLASS = { Easy: 'chip-easy', Medium: 'chip-medium', Hard: 'chip-hard' };
const STATUS_CLASS = { open: 'chip-easy', closed: 'chip-hard' }; // reuse existing green/red chip colors

// Formats the gap between `now` and `closesAt` as a short "time left" string.
// Returns null when there's nothing meaningful to show (no deadline set,
// or the assignment isn't open), so the caller can skip rendering it.
function formatTimeLeft(closesAt, now) {
  if (!closesAt) return null;
  const diffMs = new Date(closesAt).getTime() - now;
  if (diffMs <= 0) return null;

  const minutes = Math.floor(diffMs / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  if (mins > 0) return `${mins}m left`;
  return 'Closing soon';
}

// Turns a student's best submission for a problem (see GET /api/problems,
// which now attaches { status, passed, total }) into a small status chip:
//   no submission yet        -> neutral "Not submitted"
//   some but not all passing -> amber   "x/y passed"
//   every case passing       -> green   "Accepted x/y"
function submissionChip(submission) {
  if (!submission) {
    return { label: 'Not submitted', className: 'chip-neutral' };
  }
  const { status, passed, total } = submission;
  if (status === 'Accepted' && passed === total) {
    return { label: `Accepted ${passed}/${total}`, className: 'chip-easy' };
  }
  return { label: `${passed}/${total} passed`, className: 'chip-medium' };
}

export default function Problems() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  const [problems, setProblems] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const fetchProblems = async () => {
      try {
        const response = await axios.get(`${API}/api/problems`, {
          withCredentials: true,
        });
        setProblems(response.data.problems);
      } catch (err) {
        console.error('Failed to fetch problems', err);
        setLoadError('Could not load problems. Is the backend server running?');
      }
    };

    fetchProblems();
  }, []);

  // Ticks the countdown forward every 30s. Deliberately not more frequent
  // than that â€” a live per-second clock on a list page is more distracting
  // than useful, and this still keeps "Xm left" reasonably accurate.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="assignments" />
          <SpaceNotifications />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="problems-list">
        <h1 className="problems-title">Assignments</h1>
        <p className="problems-sub">Pick a problem to open it in the sandbox.</p>

        {loadError && (
          <div className="alert" role="alert">
            <span className="alert-icon">!</span>
            <span>{loadError}</span>
          </div>
        )}

        {!problems && !loadError && <p className="sb-loading">Loading problems…</p>}

        {problems && problems.length === 0 && (
          <p className="sb-loading">No assignments yet.</p>
        )}

        {problems && problems.length > 0 && (
          <div className="problem-cards">
            {problems.map((p, idx) => {
              const timeLeft = p.status === 'open' ? formatTimeLeft(p.closes_at, now) : null;
              const isScan = p.submission_mode === 'scan';
              const sub = isScan
                ? (p.scanSubmitted ? { label: 'Submitted', className: 'chip-easy' } : { label: 'Not submitted', className: 'chip-neutral' })
                : submissionChip(p.submission);
              // Result tags only make sense once the deadline has passed (or
              // there was never one) and the student has actually submitted
              // — matches the same gate GET /api/problems/:id/result (code
              // mode) / GET /api/me/scan-submission (scan mode) enforces.
              const hasSubmitted = isScan ? !!p.scanSubmitted : !!p.submission;
              const resultEligible = hasSubmitted && (!p.closes_at || new Date(p.closes_at) <= new Date(now));
              return (
                <div key={p.id}>
                  <button
                    type="button"
                    className="problem-card"
                    onClick={() => navigate(p.submission_mode === 'scan' ? `/assignments/${p.id}/scan` : `/assignments/${p.id}`)}
                  >
                    <span className="problem-card-title">
                      <span className="problem-card-index">{idx + 1}.</span> {p.title}
                    </span>
                    <span className="problem-card-badges">
                      <span className={`chip ${DIFFICULTY_CLASS[p.difficulty] || 'chip-medium'}`}>
                        <span className="dot" />
                        {p.difficulty}
                      </span>
                      <span className={`chip ${STATUS_CLASS[p.status] || 'chip-medium'}`}>
                        <span className="dot" />
                        {p.status === 'open' ? 'Open' : 'Closed'}
                      </span>
                      <span className={`chip ${sub.className}`}>
                        <span className="dot" />
                        {sub.label}
                      </span>
                      {timeLeft && <span className="problem-card-timeleft">{timeLeft}</span>}
                    </span>
                  </button>
                  {resultEligible && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ marginTop: 6 }}
                      onClick={() => navigate(`/assignments/${p.id}/result`)}
                    >
                      View result
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
