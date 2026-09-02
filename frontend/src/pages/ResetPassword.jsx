import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import { EyeIcon, EyeOffIcon } from '../components/EyeIcons';
import { API } from '../config';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [done, setDone] = useState(false);

  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setIsLoading(true);
    try {
      await axios.post(`${API}/api/reset-password`, {
        token,
        newPassword: password,
      });
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Network error. Is the backend server running?');
    } finally {
      setIsLoading(false);
    }
  };

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

        <h2 className="auth-title">Set a new password</h2>
        <p className="auth-sub">Choose a new password for your account.</p>

        {!done && (
          <div className="alert" role="alert">
            <span className="alert-icon">!</span>
            <span>
              If you've used encrypted chat, resetting your password makes your old messages permanently unreadable —
              they're encrypted with a key tied to your current password, and there's no way to recover it after a
              reset. New messages after this will work fine.
            </span>
          </div>
        )}

        {!token && (
          <div className="alert" role="alert">
            <span className="alert-icon">!</span>
            <span>This reset link is missing its token. Request a new one from the forgot password page.</span>
          </div>
        )}

        {done ? (
          <div className="alert alert-success" role="status">
            <span className="alert-icon">✓</span>
            <span>Password reset. Taking you to sign in…</span>
          </div>
        ) : (
          token && (
            <form onSubmit={handleSubmit} className="auth-form">
              <div className="field">
                <label htmlFor="password">New password</label>
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

              <div className="field">
                <label htmlFor="confirmPassword">Confirm new password</label>
                <div className="password-field-wrap">
                  <input
                    id="confirmPassword"
                    type={showConfirmPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="password-toggle-btn"
                    onClick={() => setShowConfirmPassword((prev) => !prev)}
                    aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  >
                    {showConfirmPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              <button type="submit" className="btn btn-primary auth-submit" disabled={isLoading}>
                {isLoading && <span className="spinner" />}
                {isLoading ? 'Resetting' : 'Reset password'}
              </button>
            </form>
          )
        )}

        {error && (
          <div className="alert" role="alert">
            <span className="alert-icon">!</span>
            <span>{error}</span>
          </div>
        )}

        <div className="auth-back-row">
          <button type="button" className="auth-link" onClick={() => navigate('/login', { replace: true })}>
            Back to sign in
          </button>
        </div>
      </div>
    </div>
  );
}
