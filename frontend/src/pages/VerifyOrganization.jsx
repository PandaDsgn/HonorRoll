import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import { API } from '../config';

// Landing target for the confirmation link sent by POST /api/organizations/signup.
// Fires the verification call once on mount — there's no form here, just a
// token in the URL to redeem — then reports success/failure. Email
// confirmation is one of two independent gates before an org can add
// students (the other being platform-owner approval), so this deliberately
// doesn't promise the org is fully live yet.
export default function VerifyOrganization() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [status, setStatus] = useState('pending'); // 'pending' | 'success' | 'error'
  const [message, setMessage] = useState('');
  const firedRef = useRef(false);

  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    if (!token || firedRef.current) return;
    firedRef.current = true;
    axios.get(`${API}/api/organizations/verify`, { params: { token } })
      .then((res) => {
        setStatus('success');
        setMessage(res.data.message);
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err.response?.data?.error || 'Network error. Is the backend server running?');
      });
  }, [token]);

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

        <h2 className="auth-title">Confirming your organization</h2>

        {!token && (
          <div className="alert" role="alert">
            <span className="alert-icon">!</span>
            <span>This confirmation link is missing its token.</span>
          </div>
        )}

        {token && status === 'pending' && <p className="auth-sub">One moment…</p>}

        {token && status === 'success' && (
          <div className="alert alert-success" role="status">
            <span className="alert-icon">✓</span>
            <span>{message}</span>
          </div>
        )}

        {token && status === 'error' && (
          <div className="alert" role="alert">
            <span className="alert-icon">!</span>
            <span>{message}</span>
          </div>
        )}

        <div className="auth-back-row">
          <button type="button" className="auth-link" onClick={() => navigate('/login')}>
            Back to sign in
          </button>
        </div>
      </div>
    </div>
  );
}
