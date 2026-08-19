import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher from '../components/SpaceSwitcher';
import { useAuth } from '../context/AuthContext';
import { API } from '../config';

const STATUS_CLASS = { open: 'chip-easy', upcoming: 'chip-medium', closed: 'chip-hard' };

// Mirrors formatTimeLeft in Problems.jsx — same "Xd Yh left" shape, applied
// to an exam's closes_at instead of an assignment's.
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

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

// One attempt ever (see backend exam_attempts UNIQUE constraint) — so the
// only states a card needs are "haven't started" vs "already used it up".
// "View result" (rather than a bare "Completed") since the card becomes a
// link straight to /exams/:id/result once submitted.
function attemptChip(attemptStatus) {
  if (attemptStatus === 'submitted') return { label: 'View result', className: 'chip-easy' };
  if (attemptStatus === 'in_progress') return { label: 'In progress', className: 'chip-medium' };
  return { label: 'Not started', className: 'chip-neutral' };
}

export default function Exams() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  const [exams, setExams] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const fetchExams = async () => {
      try {
        const response = await axios.get(`${API}/api/exams`, { withCredentials: true });
        setExams(response.data.exams);
      } catch (err) {
        console.error('Failed to fetch exams', err);
        setLoadError('Could not load exams. Is the backend server running?');
      }
    };
    fetchExams();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  const { logout } = useAuth();
  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="exams" />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button type="button" className="btn btn-ghost" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>

      <section className="problems-list">
        <h1 className="problems-title">Exams</h1>
        <p className="problems-sub">
          Once you start an exam it runs in fullscreen with a fixed timer — leaving fullscreen or
          switching tabs ends it immediately, and each exam can only be taken once.
        </p>

        {loadError && (
          <div className="alert" role="alert">
            <span className="alert-icon">!</span>
            <span>{loadError}</span>
          </div>
        )}

        {!exams && !loadError && <p className="sb-loading">Loading exams…</p>}

        {exams && exams.length === 0 && <p className="sb-loading">No exams yet.</p>}

        {exams && exams.length > 0 && (
          <div className="problem-cards">
            {exams.map((ex, idx) => {
              const timeLeft = ex.status === 'open' ? formatTimeLeft(ex.closes_at, now) : null;
              const attempt = attemptChip(ex.attempt_status);
              return (
                <button
                  key={ex.id}
                  type="button"
                  className="problem-card"
                  onClick={() => navigate(ex.attempt_status === 'submitted' ? `/exams/${ex.id}/result` : `/exams/${ex.id}`)}
                >
                  <span className="problem-card-title">
                    <span className="problem-card-index">{idx + 1}.</span> {ex.title}
                  </span>
                  <span className="problem-card-badges">
                    <span className="chip chip-neutral">
                      <span className="dot" />
                      {ex.total_marks} marks
                    </span>
                    <span className="chip chip-neutral">
                      <span className="dot" />
                      {formatDuration(ex.total_time_seconds)}
                    </span>
                    <span className={`chip ${STATUS_CLASS[ex.status] || 'chip-medium'}`}>
                      <span className="dot" />
                      {ex.status === 'open' ? 'Open' : ex.status === 'upcoming' ? 'Upcoming' : 'Closed'}
                    </span>
                    <span className={`chip ${attempt.className}`}>
                      <span className="dot" />
                      {attempt.label}
                    </span>
                    {timeLeft && <span className="problem-card-timeleft">{timeLeft}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
