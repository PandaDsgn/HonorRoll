import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import { EyeIcon, EyeOffIcon } from '../components/EyeIcons';
import { API } from '../config';

// Routes a freshly-issued session token to the right landing page, shared
// by the direct-login path and the post-picker path below.
function landingPathFor(role) {
  if (role === 'superadmin') return '/superadmin';
  return role === 'admin' || role === 'teacher' ? '/admin' : '/assignments';
}

// Sent to the backend as `audience` and enforced there (see POST
// /api/login) — picking a tab is a real filter, not just a label:
// signing in with a student's own credentials while "Teacher" is selected
// is now a rejection, not a silent redirect into the student area.
const AUDIENCES = [
  { key: 'student', label: 'Student' },
  { key: 'teacher', label: 'Teacher' },
  { key: 'admin', label: 'Admin' },
  { key: 'superadmin', label: 'Super Admin' },
];

export default function Login() {
  const [audience, setAudience] = useState('student');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Set only when one email maps to more than one organization — see
  // POST /api/login, which returns { requiresOrgSelection: true, ... }
  // instead of a usable token in that case.
  const [orgChoice, setOrgChoice] = useState(null);
  const [selectingOrgId, setSelectingOrgId] = useState(null);
  // Set when the account is a teacher/student signing in for the first
  // time — their account was created by an admin, so they never saw a
  // Terms of Service checkbox anywhere else (see POST /api/login's
  // requiresTosAcceptance branch). Holds the short-lived token that
  // completes the login once they accept.
  const [tosPendingToken, setTosPendingToken] = useState(null);
  const [acceptingTos, setAcceptingTos] = useState(false);

  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { login } = useAuth();

  const audienceLabel = AUDIENCES.find((a) => a.key === audience)?.label || 'Student';

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await axios.post(
        `${API}/api/login`,
        { email, password, audience }
      );

      if (response.data.requiresOrgSelection) {
        setOrgChoice(response.data);
        return;
      }

      if (response.data.requiresTosAcceptance) {
        setTosPendingToken(response.data.tosPendingToken);
        return;
      }

      if (response.status === 200) {
        login(response.data.token, response.data.user);
        // replace, not push — otherwise /login stays one swipe/back-button
        // press behind the dashboard forever, and a signed-in user landing
        // back on the login form (then having to swipe forward again to
        // undo it) reads as a bug, not real "back" navigation.
        navigate(landingPathFor(response.data.user.role), { replace: true });
      }
    } catch (err) {
      if (err.response?.data?.error) {
        setError(err.response.data.error);
      } else {
        setError('Network error. Is the backend server running?');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectOrg = async (organizationId) => {
    setError('');
    setSelectingOrgId(organizationId);
    try {
      const response = await axios.post(`${API}/api/login/select-organization`, {
        preAuthToken: orgChoice.preAuthToken,
        organizationId,
      });
      if (response.data.requiresTosAcceptance) {
        setOrgChoice(null);
        setTosPendingToken(response.data.tosPendingToken);
        return;
      }
      login(response.data.token, response.data.user);
      navigate(landingPathFor(response.data.user.role), { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Network error. Is the backend server running?');
      setOrgChoice(null);
    } finally {
      setSelectingOrgId(null);
    }
  };

  const handleAcceptTos = async () => {
    setError('');
    setAcceptingTos(true);
    try {
      const response = await axios.post(`${API}/api/login/accept-tos`, { tosPendingToken });
      login(response.data.token, response.data.user);
      navigate(landingPathFor(response.data.user.role), { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Network error. Is the backend server running?');
      setTosPendingToken(null);
    } finally {
      setAcceptingTos(false);
    }
  };

  if (orgChoice) {
    return (
      <div className="auth-shell">
        <div className="auth-card bracket-frame">
          <span className="corner tl" aria-hidden="true" />
          <span className="corner tr" aria-hidden="true" />
          <span className="corner bl" aria-hidden="true" />
          <span className="corner br" aria-hidden="true" />

          <div className="auth-card-head">
            <button type="button" className="brand" onClick={() => navigate('/', { replace: true })}><BrandMark /></button>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>

          <h2 className="auth-title">Choose a workspace</h2>
          <p className="auth-sub">This email belongs to more than one organization.</p>

          <div className="org-picker-list">
            {orgChoice.organizations.map((org) => (
              <button
                key={org.organizationId}
                type="button"
                className="org-picker-item"
                disabled={selectingOrgId !== null}
                onClick={() => handleSelectOrg(org.organizationId)}
              >
                <span className="org-picker-item-name">{org.organizationName}</span>
                <span className={`chip chip-${org.role === 'admin' ? 'hard' : org.role === 'teacher' ? 'medium' : 'easy'}`}>
                  <span className="dot" />
                  {org.role}
                </span>
              </button>
            ))}
          </div>

          <div className="auth-back-row">
            <button type="button" className="auth-link" onClick={() => setOrgChoice(null)}>
              Back to sign in
            </button>
          </div>

          {error && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (tosPendingToken) {
    return (
      <div className="auth-shell">
        <div className="auth-card bracket-frame">
          <span className="corner tl" aria-hidden="true" />
          <span className="corner tr" aria-hidden="true" />
          <span className="corner bl" aria-hidden="true" />
          <span className="corner br" aria-hidden="true" />

          <div className="auth-card-head">
            <button type="button" className="brand" onClick={() => navigate('/', { replace: true })}><BrandMark /></button>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>

          <h2 className="auth-title">Before you continue</h2>
          <p className="auth-sub">
            This is your first time signing in — please review and accept our Terms of Service and
            Privacy Policy to continue.
          </p>

          <p style={{ margin: '16px 0' }}>
            <a href="#/terms" target="_blank" rel="noreferrer" className="auth-link" style={{ display: 'inline' }}>Terms of Service</a>
            {' · '}
            <a href="#/privacy" target="_blank" rel="noreferrer" className="auth-link" style={{ display: 'inline' }}>Privacy Policy</a>
          </p>

          <button type="button" className="btn btn-primary auth-submit" disabled={acceptingTos} onClick={handleAcceptTos}>
            {acceptingTos && <span className="spinner" />}
            {acceptingTos ? 'Continuing…' : 'Accept and continue'}
          </button>

          <div className="auth-back-row">
            <button type="button" className="auth-link" onClick={() => setTosPendingToken(null)}>
              Back to sign in
            </button>
          </div>

          {error && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card bracket-frame">
        <span className="corner tl" aria-hidden="true" />
        <span className="corner tr" aria-hidden="true" />
        <span className="corner bl" aria-hidden="true" />
        <span className="corner br" aria-hidden="true" />

        <div className="auth-card-head">
          <button type="button" className="brand" onClick={() => navigate('/', { replace: true })}><BrandMark /></button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>

        <h2 className="auth-title">Sign in to your workspace</h2>
        <p className="auth-sub">Use your {audienceLabel.toLowerCase()} credentials to continue.</p>

        <div className="segmented" role="tablist" aria-label="Signing in as" style={{ margin: '4px 0 20px' }}>
          {AUDIENCES.map((a) => (
            <button
              key={a.key}
              type="button"
              role="tab"
              aria-pressed={audience === a.key}
              className={audience === a.key ? 'active' : ''}
              onClick={() => setAudience(a.key)}
            >
              {a.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleLogin} className="auth-form">
          <div className="field">
            <label htmlFor="email">{audienceLabel} email</label>
            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <div className="password-field-wrap">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>

          <div className="auth-forgot-row">
            <button type="button" className="auth-link" onClick={() => navigate('/forgot-password', { replace: true })}>
              Forgot your password?
            </button>
          </div>

          <button type="submit" className="btn btn-primary auth-submit" disabled={isLoading}>
            {isLoading && <span className="spinner" />}
            {isLoading ? 'Signing in' : 'Sign in'}
          </button>
        </form>

        <div className="auth-divider">New institution</div>
        <button type="button" className="auth-alt-action" onClick={() => navigate('/signup', { replace: true })}>
          <span className="auth-alt-action-text">
            <span className="auth-alt-action-title">Set up your school or college</span>
            <span className="auth-alt-action-sub">Create an isolated workspace for your institution</span>
          </span>
          <span className="auth-alt-action-arrow" aria-hidden="true">→</span>
        </button>

        {error && (
          <div className="alert" role="alert">
            <span className="alert-icon">!</span>
            <span>{error}</span>
          </div>
        )}

        <p className="auth-sub" style={{ textAlign: 'center', margin: '20px 0 0' }}>
          <a href="#/terms" target="_blank" rel="noreferrer" className="auth-link" style={{ display: 'inline' }}>Terms of Service</a>
          {' · '}
          <a href="#/privacy" target="_blank" rel="noreferrer" className="auth-link" style={{ display: 'inline' }}>Privacy Policy</a>
        </p>
      </div>
    </div>
  );
}
