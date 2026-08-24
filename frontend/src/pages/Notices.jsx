import { useState, useEffect, useCallback, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher, { SpaceNotifications } from '../components/SpaceSwitcher';
import { NoteTypeIcon } from '../components/NoteTypeIcons';
import { API } from '../config';
import '../admin.css';

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Read-only org-wide notice feed — students and teachers alike (see GET
// /api/notices, which has no subject/unit visibility rule at all, unlike
// GET /api/notes). Posting/deleting lives only in AdminNoticesPanel inside
// the admin dashboard; this page is just the shared read side. No subject
// picker (notices aren't subject-scoped) — just search-by-title, and with
// no search the whole feed shows, newest first.
export default function Notices() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  const [search, setSearch] = useState('');
  const [notices, setNotices] = useState(null);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const fetchNotices = useCallback(async () => {
    try {
      const params = {};
      if (search.trim()) params.search = search.trim();
      const res = await axios.get(`${API}/api/notices`, { params, withCredentials: true });
      setNotices(res.data.notices);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load notices.');
    }
  }, [search]);

  useEffect(() => { fetchNotices(); }, [fetchNotices]);

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="notices" />
          <SpaceNotifications />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <h1 className="problems-title">Notices</h1>
        </div>

        <div className="admin-toolbar" style={{ gap: 8 }}>
          <input
            placeholder="Search by title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-h)', minWidth: 220 }}
          />
        </div>

        {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}

        {!notices && !error && <p className="sb-loading">Loading notices…</p>}
        {notices && notices.length === 0 && <p className="sb-loading">No notices found.</p>}

        {notices && notices.length > 0 && (
          <div className="panel admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th aria-label="Type" />
                  <th>Title</th>
                  <th>Posted</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {notices.map((n) => (
                  <Fragment key={n.id}>
                    <tr>
                      <td><NoteTypeIcon type={n.type} /></td>
                      <td className="admin-cell-strong">{n.title}</td>
                      <td>{formatDate(n.createdAt)}</td>
                      <td className="admin-cell-actions">
                        {n.type === 'text' ? (
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => setExpandedId(expandedId === n.id ? null : n.id)}>
                            {expandedId === n.id ? 'Hide' : 'Read'}
                          </button>
                        ) : n.type === 'link' ? (
                          <a className="btn btn-primary btn-sm" href={n.externalUrl} target="_blank" rel="noreferrer">Open</a>
                        ) : n.viewUrl ? (
                          <a className="btn btn-primary btn-sm" href={n.viewUrl} target="_blank" rel="noreferrer">View</a>
                        ) : null}
                      </td>
                    </tr>
                    {expandedId === n.id && n.type === 'text' && (
                      <tr>
                        <td colSpan={4} style={{ background: 'var(--surface-2)', whiteSpace: 'pre-wrap' }}>{n.bodyText}</td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
