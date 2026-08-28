import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher, { SpaceNotifications } from '../components/SpaceSwitcher';
import LogoutFab from '../components/LogoutFab';
import PhotoPicker from '../components/PhotoPicker';
import IdCard from '../components/IdCard';
import { API } from '../config';
import '../admin.css';
import '../IdCard.css';

// The one profile page every role shares (unlike MyPerformance, which is
// student-only and analytics-focused) — photo library management and, per
// institution the user belongs to, a digital ID card. A teacher also sees
// a "start your own institution" entry point here (see POST
// /api/me/start-institution on the backend) — same access-code gate as
// the logged-out org signup form, just reachable without leaving the app.
export default function MyProfile() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { user, login, refetch } = useAuth();

  const [organizations, setOrganizations] = useState(null);
  const [error, setError] = useState('');
  const [cardOrgId, setCardOrgId] = useState(null);

  const [showStartForm, setShowStartForm] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [startResult, setStartResult] = useState('');

  const fetchOrganizations = () => {
    axios.get(`${API}/api/me/organizations`, { withCredentials: true })
      .then((res) => setOrganizations(res.data.organizations))
      .catch(() => setError('Failed to load your institutions.'));
  };

  useEffect(fetchOrganizations, []);

  const handleStartInstitution = async (e) => {
    e.preventDefault();
    if (!orgName.trim() || !accessCode.trim()) return;
    setStarting(true);
    setStartError('');
    setStartResult('');
    try {
      const res = await axios.post(
        `${API}/api/me/start-institution`,
        { organizationName: orgName.trim(), accessCode: accessCode.trim() },
        { withCredentials: true }
      );
      // The response carries a fresh session token scoped to the new org
      // (admin role there) — swap it in via the same login() the actual
      // login form uses, then refetch /api/me so `user`/`role` everywhere
      // in the app reflect the new session instead of the old one.
      login(res.data.token, user);
      await refetch();
      setStartResult(res.data.message);
      setOrgName('');
      setAccessCode('');
      setShowStartForm(false);
      fetchOrganizations();
    } catch (err) {
      setStartError(err.response?.data?.error || 'Failed to create institution.');
    } finally {
      setStarting(false);
    }
  };

  const canStartInstitution = organizations?.some((o) => o.role === 'teacher');

  return (
    <div className="sb-shell">
      <LogoutFab />
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="profile" />
          <SpaceNotifications />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <h1 className="problems-title">My profile</h1>
        </div>

        {error && <div className="alert" role="alert"><span className="alert-icon">!</span><span>{error}</span></div>}

        <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 4px' }}>Your details</h3>
          <p className="auth-sub" style={{ margin: '0 0 16px' }}>
            {user?.name || user?.email}{user?.name && ` — ${user.email}`}
          </p>

          <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-dim)' }}>My photos</h4>
          <PhotoPicker />
        </div>

        <div className="panel" style={{ padding: 20 }}>
          <h3 style={{ margin: '0 0 4px' }}>Your institutions</h3>
          <p className="auth-sub" style={{ margin: '0 0 16px' }}>
            View or download your ID card for each institution you belong to.
          </p>

          {!organizations && !error && <p className="sb-loading">Loading…</p>}
          {organizations && organizations.length === 0 && (
            <p className="sb-loading">You aren't a member of any institution yet.</p>
          )}
          {organizations && organizations.length > 0 && (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th>Institution</th><th>Role</th><th /></tr></thead>
                <tbody>
                  {organizations.map((o) => (
                    <tr key={o.organization_id}>
                      <td className="admin-cell-strong">{o.organization_name}</td>
                      <td><span className="chip chip-neutral"><span className="dot" />{o.role}</span></td>
                      <td>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCardOrgId(o.organization_id)}>
                          View ID Card
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canStartInstitution && (
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
              {!showStartForm ? (
                <button type="button" className="btn btn-secondary-choice btn-sm" onClick={() => setShowStartForm(true)}>
                  Start your own institution
                </button>
              ) : (
                <form onSubmit={handleStartInstitution} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 360 }}>
                  <h4 style={{ margin: '0 0 4px' }}>Start your own institution</h4>
                  <p className="auth-sub" style={{ margin: '0 0 8px' }}>
                    Founds a brand-new institution with you as its admin — e.g. to run your own private coaching.
                    You'll need the same access code used for any new HonorRoll institution signup.
                  </p>
                  {startError && <div className="alert" style={{ marginBottom: 4 }}><span className="alert-icon">!</span><span>{startError}</span></div>}
                  {startResult && <div className="alert alert-success" style={{ marginBottom: 4 }}><span className="alert-icon">✓</span><span>{startResult}</span></div>}
                  <div className="field">
                    <label htmlFor="start-org-name">Institution name</label>
                    <input id="start-org-name" value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label htmlFor="start-access-code">Access code</label>
                    <input id="start-access-code" type="password" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} required />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={starting}>
                      {starting ? 'Creating…' : 'Create institution'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowStartForm(false)}>Cancel</button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      </section>

      {cardOrgId && organizations && (
        <IdCard organizations={organizations} initialOrganizationId={cardOrgId} onClose={() => setCardOrgId(null)} />
      )}
    </div>
  );
}
