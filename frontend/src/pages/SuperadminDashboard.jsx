import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import { API } from '../config';
import '../admin.css';

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const STATUS_CLASS = { approved: 'chip-easy', pending: 'chip-medium', rejected: 'chip-hard' };

// Platform-owner view — every organization on the platform, with a one-click
// way to drop into any of them as its admin. See POST
// /api/superadmin/organizations/:id/impersonate: this doesn't create a
// parallel "view everything" UI, it just mints a normal admin session token
// for the chosen org and hands you off to the exact same AdminDashboard any
// real admin sees.
export default function SuperadminDashboard() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { user, logout, enterImpersonation } = useAuth();
  const [orgs, setOrgs] = useState(null);
  const [error, setError] = useState('');
  const [enteringId, setEnteringId] = useState(null);

  const fetchOrgs = useCallback(() => {
    axios.get(`${API}/api/superadmin/organizations`, { withCredentials: true })
      .then((res) => setOrgs(res.data.organizations))
      .catch(() => setError('Failed to load organizations.'));
  }, []);

  useEffect(() => { fetchOrgs(); }, [fetchOrgs]);

  const handleLogout = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  const enterOrg = async (org) => {
    setError('');
    setEnteringId(org.id);
    try {
      const res = await axios.post(`${API}/api/superadmin/organizations/${org.id}/impersonate`, {}, { withCredentials: true });
      enterImpersonation(res.data.token, res.data.user);
      navigate('/admin', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to enter organization.');
      setEnteringId(null);
    }
  };

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <span className="auth-sub">{user?.email}</span>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button type="button" className="btn btn-ghost" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <h1 className="problems-title">Superadmin</h1>
        </div>

        {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}

        {!orgs && !error && <p className="sb-loading">Loading organizations…</p>}
        {orgs && orgs.length === 0 && <p className="sb-loading">No organizations yet.</p>}

        {orgs && orgs.length > 0 && (
          <div className="panel admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Status</th>
                  <th>Plan</th>
                  <th>Students</th>
                  <th>Teachers</th>
                  <th>Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => (
                  <tr key={org.id}>
                    <td className="admin-cell-strong">{org.name}</td>
                    <td><span className={`chip ${STATUS_CLASS[org.status] || 'chip-neutral'}`}><span className="dot" />{org.status}</span></td>
                    <td>{org.plan_key} <span className="auth-sub">({org.billing_status})</span></td>
                    <td>{org.student_count}</td>
                    <td>{org.teacher_count}</td>
                    <td>{formatDate(org.created_at)}</td>
                    <td className="admin-cell-actions">
                      <button type="button" className="btn btn-primary btn-sm" disabled={enteringId === org.id} onClick={() => enterOrg(org)}>
                        {enteringId === org.id ? 'Entering…' : 'Enter as admin'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
