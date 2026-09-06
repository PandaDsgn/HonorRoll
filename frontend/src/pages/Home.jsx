import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API } from '../config';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import ShowcaseCard from '../components/ShowcaseCard';

const FEATURES = [
  {
    title: 'Assignments',
    desc: 'Write real solutions, submit them, and see exactly what a grader would see. No separate export step.',
  },
  {
    title: 'Timed exams',
    desc: 'Lockdown mode, a live calculator, and per-question scoring that adds up the same way for every student.',
  },
  {
    title: 'Code sandbox',
    desc: 'Seven languages, one editor. Run against real test cases before an assignment is ever due.',
  },
  {
    title: 'Doubt forum',
    desc: 'Post a question to your subject board, attach a photo of your work, and get answered without a side channel.',
  },
];

export default function Home() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { user, loading, login } = useAuth();
  const [demoRole, setDemoRole] = useState('student');
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState('');

  // Logged-in visitors get sent straight back into the app instead of being
  // asked to sign in again; logged-out visitors get the sign-in CTA.
  // Both branches replace, not push — otherwise Home stays one swipe/
  // back-button press behind the dashboard, the same history-pollution bug
  // fixed for the actual login flow (see landingPathFor in Login.jsx).
  const handleCta = () => {
    if (!user) return navigate('/login', { replace: true });
    const home = user.role === 'superadmin' ? '/superadmin' : user.role === 'admin' || user.role === 'teacher' ? '/admin' : '/assignments';
    navigate(home, { replace: true });
  };

  // Provisions a fresh, isolated demo organization (see POST /api/demo/
  // start — backend/lib/demo.js) as whichever role is selected below (any
  // real org role — never superadmin, that's platform staff, not
  // something an organization has) and logs straight into it, same as a
  // real login. The org auto-deletes itself 30 minutes after this call —
  // see DemoBanner for the countdown/exit shown once logged in.
  const handleTryDemo = async () => {
    setDemoError('');
    setDemoLoading(true);
    try {
      const res = await axios.post(`${API}/api/demo/start`, { role: demoRole });
      login(res.data.token, res.data.user);
      navigate(demoRole === 'student' ? '/assignments' : '/admin', { replace: true });
    } catch (err) {
      setDemoError(err.response?.data?.error || 'Could not start the demo. Please try again.');
    } finally {
      setDemoLoading(false);
    }
  };

  return (
    <div className="landing-shell">
      <header className="sb-topbar">
        {/* No wordmark here on Home specifically — it's the hero-brand lockup below instead. */}
        <span />
        <div className="sb-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/about')}>About</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/contact')}>Contact</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/changelog')}>Changelog</button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>
      <hr className="rule" />

      <main className="hero-band">
        <div className="hero-copy">
          <div className="brand hero-brand"><BrandMark /></div>
          <h1 className="landing-title">Assignments<br />earn their grade.</h1>
          <p className="landing-sub">
            Write your solutions, run code independently, sit exams, and get feedback, all in one workspace
            your institution actually owns.
          </p>
          <div className="landing-cta-row">
            <button type="button" className="btn btn-primary landing-cta" onClick={handleCta} disabled={loading}>
              {loading ? 'Loading…' : user ? 'Continue to your workspace' : 'Sign in to your workspace'}
            </button>
            {!user && !loading && (
              <button type="button" className="btn btn-secondary-choice landing-cta" onClick={() => navigate('/signup', { replace: true })}>
                Set up your school or college
              </button>
            )}
          </div>
          {!user && !loading && (
            <div className="demo-picker">
              <span className="demo-picker-label">Try the demo as</span>
              <div className="segmented" role="tablist" aria-label="Demo role">
                {['student', 'teacher', 'admin'].map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="tab"
                    aria-pressed={demoRole === r}
                    className={demoRole === r ? 'active' : ''}
                    onClick={() => setDemoRole(r)}
                  >
                    {r[0].toUpperCase() + r.slice(1)}
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn-primary" onClick={handleTryDemo} disabled={demoLoading}>
                {demoLoading ? 'Setting up…' : 'Start'}
              </button>
            </div>
          )}
          {demoError && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{demoError}</span>
            </div>
          )}
        </div>

        <ShowcaseCard />
      </main>

      <section className="feature-row">
        {FEATURES.map((f) => (
          <div key={f.title} className="feature-card">
            <h3 className="feature-card-title">{f.title}</h3>
            <p className="feature-card-desc">{f.desc}</p>
          </div>
        ))}
      </section>

      {!user && !loading && (
        <section className="callout-coral">
          <h2 className="callout-coral-title">Ready to set your institution up?</h2>
          <p className="callout-coral-sub">Isolated workspaces, per-role access, and grading that stays consistent across every class.</p>
          <button type="button" className="btn callout-coral-btn" onClick={() => navigate('/signup', { replace: true })}>
            Set up your school or college
          </button>
        </section>
      )}

      <hr className="rule" />
      <footer className="landing-footer">
        <div className="landing-footer-links">
          <button type="button" className="landing-footer-link" onClick={() => navigate('/terms')}>Terms of Service</button>
          <span className="landing-footer-dot" aria-hidden="true">·</span>
          <button type="button" className="landing-footer-link" onClick={() => navigate('/privacy')}>Privacy Policy</button>
          <span className="landing-footer-dot" aria-hidden="true">·</span>
          <button type="button" className="landing-footer-link" onClick={() => navigate('/cookies')}>Cookie Policy</button>
          <span className="landing-footer-dot" aria-hidden="true">·</span>
          <button type="button" className="landing-footer-link" onClick={() => navigate('/refunds')}>Refund Policy</button>
        </div>
        <span className="landing-footer-version">© HonorRoll</span>
      </footer>
    </div>
  );
}
