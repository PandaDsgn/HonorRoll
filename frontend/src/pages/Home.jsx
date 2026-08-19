import { useNavigate } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';

export default function Home() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { user, loading } = useAuth();

  // Logged-in visitors get sent straight back into the app instead of being
  // asked to sign in again; logged-out visitors get the sign-in CTA.
  const handleCta = () => {
    if (!user) return navigate('/login');
    navigate(user.role === 'admin' ? '/admin' : '/assignments');
  };

  return (
    <div className="landing-shell">
      <header className="sb-topbar">
        {/* Deliberately no "AssignMeant" wordmark here — it's the big heading below instead */}
        <span />
        <div className="sb-actions">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <main className="landing-hero">
        <h1 className="landing-brand"><BrandMark /></h1>
        <h2 className="landing-title">The way assignments are meant to be graded.</h2>
        <p className="landing-sub">
          Write your solutions to your assignments, run codes independently, give exams, and get feedback.
        </p>

        <div className="landing-cta-row">
          <button type="button" className="btn btn-primary landing-cta" onClick={handleCta} disabled={loading}>
            {loading ? 'Loading…' : user ? 'Continue to your workspace' : 'Sign in to your workspace'}
          </button>
          {!user && !loading && (
            <button type="button" className="btn btn-ghost landing-cta" onClick={() => navigate('/signup')}>
              Set up your school or college
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
