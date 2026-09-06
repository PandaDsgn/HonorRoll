import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import AuthVisualPanel from '../components/AuthVisualPanel';
import { API } from '../config';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | sent
  const [error, setError] = useState('');

  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setStatus('sending');

    try {
      await axios.post(`${API}/api/forgot-password`, { email });
      // The backend always returns 200 here, even for unknown emails, so we
      // never reveal whether an account exists.
      setStatus('sent');
    } catch (err) {
      setError(err.response?.data?.error || 'Network error. Is the backend server running?');
      setStatus('idle');
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

        <h2 className="auth-title">Reset your password</h2>
        <p className="auth-sub">Enter your registered email and we'll send you a reset link.</p>

        {status === 'sent' ? (
          <div className="alert alert-success" role="status">
            <span className="alert-icon">✓</span>
            <span>If that email exists in our system, a reset link is on its way. Check your inbox.</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="auth-form">
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                placeholder="you@university.edu"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <button type="submit" className="btn btn-primary auth-submit" disabled={status === 'sending'}>
              {status === 'sending' && <span className="spinner" />}
              {status === 'sending' ? 'Sending' : 'Send reset link'}
            </button>
          </form>
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
