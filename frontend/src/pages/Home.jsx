import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API } from '../config';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';

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

        {/* Auto-cycling, no interaction — three frames take turns via a
            pure-CSS opacity loop (see .showcase-frame-1/2/3 keyframes),
            each one a real (fake) snapshot of the product rather than an
            illustration of it. */}
        <div className="showcase code-window-card" aria-hidden="true">
          <div className="showcase-frame showcase-frame-1">
            <div className="showcase-label">Assignments</div>
            <div className="showcase-scan">
              <div className="showcase-scan-doc">
                <span className="showcase-scan-corner tl" />
                <span className="showcase-scan-corner tr" />
                <span className="showcase-scan-corner bl" />
                <span className="showcase-scan-corner br" />
                <div className="showcase-scan-lines">
                  <span style={{ width: '78%' }} />
                  <span style={{ width: '92%' }} />
                  <span style={{ width: '65%' }} />
                  <span style={{ width: '85%' }} />
                  <span style={{ width: '40%' }} />
                </div>
              </div>
              <div className="hero-mock-console">
                <span className="console-out">Scan captured, ready to submit</span>
              </div>
            </div>
          </div>

          <div className="showcase-frame showcase-frame-2">
            <div className="showcase-label">Timed exams</div>
            <div className="showcase-exam">
              <div className="showcase-exam-row">
                <span>Question 4 of 12</span>
                <span className="showcase-timer">18:42</span>
              </div>
              <div className="showcase-exam-q">A binary search tree has 31 nodes. What is the maximum possible height?</div>
              <div className="showcase-exam-options">
                <div className="showcase-exam-opt">30</div>
                <div className="showcase-exam-opt showcase-exam-opt-selected">5</div>
                <div className="showcase-exam-opt">15</div>
              </div>
            </div>
          </div>

          <div className="showcase-frame showcase-frame-3">
            <div className="showcase-label">Code sandbox</div>
            <div className="hero-mock-tab">binary_search.go</div>
            <pre className="hero-mock-code">{`func binarySearch(nums []int, target int) int {
    lo, hi := 0, len(nums)-1
    for lo <= hi {
        mid := (lo + hi) / 2
        if nums[mid] == target {
            return mid
        } else if nums[mid] < target {
            lo = mid + 1
        } else {
            hi = mid - 1
        }
    }
    return -1
}
`}</pre>
          </div>
        </div>
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
        </div>
        <span className="landing-footer-version">© HonorRoll</span>
      </footer>
    </div>
  );
}
