import { useState, useEffect, useCallback, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher from '../components/SpaceSwitcher';
import { NoteTypeIcon } from '../components/NoteTypeIcons';
import { API } from '../config';
import '../admin.css';

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// A student's Notes tab — pick a subject (only ones their own org_unit can
// see, same ancestor-reaches-descendants rule the rest of the app already
// uses — see GET /api/notes/subjects) to get that subject's notes, most
// recent first; or search by title, which works across every subject at
// once so finding a specific PDF never requires knowing which subject it's
// filed under first. GET /api/notes enforces both rules again server-side.
export default function Notes() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { logout } = useAuth();

  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    axios.get(`${API}/api/notes/subjects`, { withCredentials: true })
      .then((res) => setSubjects(res.data.subjects))
      .catch(() => setError('Failed to load subjects.'));
  }, []);

  const fetchNotes = useCallback(async () => {
    const trimmedSearch = search.trim();
    if (!subjectId && !trimmedSearch) {
      setNotes(null);
      return;
    }
    setError('');
    try {
      const params = {};
      if (subjectId) params.subjectId = subjectId;
      if (trimmedSearch) params.search = trimmedSearch;
      const res = await axios.get(`${API}/api/notes`, { params, withCredentials: true });
      setNotes(res.data.notes);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load notes.');
    }
  }, [subjectId, search]);

  useEffect(() => { fetchNotes(); }, [fetchNotes]);

  const handleLogout = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="notes" />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button type="button" className="btn btn-ghost" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <h1 className="problems-title">Notes</h1>
        </div>

        <div className="admin-toolbar" style={{ gap: 8 }}>
          <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} style={{ minWidth: 200 }}>
            <option value="">Select subject…</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.org_unit_name})</option>
            ))}
          </select>
          <input
            placeholder="Search by title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-h)', minWidth: 220 }}
          />
        </div>

        {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}

        {!subjectId && !search.trim() && (
          <p className="sb-loading">Select a subject or search by title to see notes.</p>
        )}
        {notes && notes.length === 0 && <p className="sb-loading">No notes found.</p>}

        {notes && notes.length > 0 && (
          <div className="panel admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th aria-label="Type" />
                  <th>Title</th>
                  <th>Subject</th>
                  <th>Teacher</th>
                  <th>Posted</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {notes.map((n) => (
                  <Fragment key={n.id}>
                    <tr>
                      <td><NoteTypeIcon type={n.type} /></td>
                      <td className="admin-cell-strong">{n.title}</td>
                      <td>{n.subjectName}</td>
                      <td>{n.teacherName || '—'}</td>
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
                        <td colSpan={6} style={{ background: 'var(--surface-2)', whiteSpace: 'pre-wrap' }}>{n.bodyText}</td>
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
