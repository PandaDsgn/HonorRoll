import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import AuthVisualPanel from '../components/AuthVisualPanel';
import { EyeIcon, EyeOffIcon } from '../components/EyeIcons';
import { API } from '../config';

// Self-serve organization signup — a college/school registers itself and
// becomes its own admin. Mirrors Login.jsx's shape/handling; on success
// behaves exactly like a normal login (same AuthContext.login() call).
export default function Signup() {
  const [organizationName, setOrganizationName] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTos, setAcceptedTos] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { login } = useAuth();

  const handleSignup = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await axios.post(`${API}/api/organizations/signup`, {
        organizationName, accessCode, name, email, password, acceptedTos,
      });
      login(response.data.token, response.data.user);
      navigate('/admin', { replace: true });
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

  return (
    <div className="auth-shell">
      <AuthVisualPanel />

      <div className="auth-card">

        <div className="auth-card-head">
          <button type="button" className="brand" onClick={() => navigate('/', { replace: true })}><BrandMark /></button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>

        <h2 className="auth-title">Set up your school or college</h2>
        <p className="auth-sub">Creates your own isolated workspace — you'll be its first admin.</p>

        <form onSubmit={handleSignup} className="auth-form">
          <div className="field">
            <label htmlFor="access-code">Access code</label>
            <input
              id="access-code"
              type="text"
              placeholder="Provided by HonorRoll"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              required
              autoComplete="off"
            />
            <p className="auth-sub" style={{ margin: '6px 0 0' }}>
              Don't have a code? The highest authority at your institution must contact{' '}
              <a href="mailto:honorroll.admin@gmail.com" className="auth-link" style={{ display: 'inline' }}>honorroll.admin@gmail.com</a> to request one.
            </p>
          </div>

          <div className="field">
            <label htmlFor="org-name">Organization name</label>
            <input
              id="org-name"
              type="text"
              placeholder="e.g. Riverside College"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              type="text"
              placeholder="e.g. Jordan Lee"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </div>

          <div className="field">
            <label htmlFor="email">Your email</label>
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
                autoComplete="new-password"
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

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5, margin: '4px 0 0' }}>
            <input
              type="checkbox"
              checked={acceptedTos}
              onChange={(e) => setAcceptedTos(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              I agree to the{' '}
              <a href="#/terms" target="_blank" rel="noreferrer" className="auth-link" style={{ display: 'inline' }}>Terms of Service</a>{' '}
              and{' '}
              <a href="#/privacy" target="_blank" rel="noreferrer" className="auth-link" style={{ display: 'inline' }}>Privacy Policy</a>.
            </span>
          </label>

          <button type="submit" className="btn btn-primary auth-submit" disabled={isLoading || !acceptedTos}>
            {isLoading && <span className="spinner" />}
            {isLoading ? 'Creating…' : 'Create organization'}
          </button>
        </form>

        {error && (
          <div className="alert" role="alert">
            <span className="alert-icon">!</span>
            <span>{error}</span>
          </div>
        )}

        <div className="auth-divider">Already registered</div>
        <button type="button" className="auth-alt-action" onClick={() => navigate('/login', { replace: true })}>
          <span className="auth-alt-action-text">
            <span className="auth-alt-action-title">Sign in to your workspace</span>
            <span className="auth-alt-action-sub">Already have an account at your institution?</span>
          </span>
          <span className="auth-alt-action-arrow" aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}
