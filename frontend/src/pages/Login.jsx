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
  return role === 'admin' || role === 'teacher' ? '/admin' : '/assignments';
}

export default function Login() {
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

  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { login } = useAuth();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await axios.post(
        `${API}/api/login`,
        { email, password }
      );

      if (response.data.requiresOrgSelection) {
        setOrgChoice(response.data);
        return;
      }

      if (response.status === 200) {
        login(response.data.token, response.data.user);
        navigate(landingPathFor(response.data.user.role));
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
      login(response.data.token, response.data.user);
      navigate(landingPathFor(response.data.user.role));
    } catch (err) {
      setError(err.response?.data?.error || 'Network error. Is the backend server running?');
      setOrgChoice(null);
    } finally {
      setSelectingOrgId(null);
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
            <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
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

  return (
    <div className="auth-shell">
      <div className="auth-card bracket-frame">
        <span className="corner tl" aria-hidden="true" />
        <span className="corner tr" aria-hidden="true" />
        <span className="corner bl" aria-hidden="true" />
        <span className="corner br" aria-hidden="true" />

        <div className="auth-card-head">
          <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>

        <h2 className="auth-title">Sign in to your workspace</h2>
        <p className="auth-sub">Use your student credentials to continue.</p>

        <form onSubmit={handleLogin} className="auth-form">
          <div className="field">
            <label htmlFor="email">Student email</label>
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
            <button type="button" className="auth-link" onClick={() => navigate('/forgot-password')}>
              Forgot your password?
            </button>
          </div>

          <button type="submit" className="btn btn-primary auth-submit" disabled={isLoading}>
            {isLoading && <span className="spinner" />}
            {isLoading ? 'Signing in' : 'Sign in'}
          </button>
        </form>

        <div className="auth-divider">New institution</div>
        <button type="button" className="auth-alt-action" onClick={() => navigate('/signup')}>
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
      </div>
    </div>
  );
}
