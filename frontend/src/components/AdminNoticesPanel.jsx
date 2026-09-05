import { useState, useEffect, useCallback, Fragment } from 'react';
import axios from 'axios';
import { API } from '../config';
import { NOTICE_TYPES, NoteTypeIcon } from './NoteTypeIcons';
import { formatDate } from '../lib/formatDate';

// The org's one shared notices list — unlike TeacherUploadsPanel (each
// teacher's own personal library), every admin here manages the SAME list
// (GET /api/notices has no admin_id/poster scoping at all) and any admin
// can delete any notice, since a notice is an org announcement, not any one
// admin's personal post. No subject field either — notices aren't attached
// to a subject, so this form is one step shorter than the teacher upload
// form it's otherwise a close copy of.
export default function AdminNoticesPanel() {
  const [notices, setNotices] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const [type, setType] = useState('pdf');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState(null);
  const [bodyText, setBodyText] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [posting, setPosting] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const activeType = NOTICE_TYPES.find((t) => t.value === type);

  const fetchNotices = useCallback(async () => {
    try {
      const params = {};
      if (search.trim()) params.search = search.trim();
      const res = await axios.get(`${API}/api/notices`, { params, withCredentials: true });
      setNotices(res.data.notices);
    } catch {
      setError('Failed to load notices.');
    }
  }, [search]);

  useEffect(() => { fetchNotices(); }, [fetchNotices]);

  const selectType = (value) => {
    setType(value);
    setFile(null);
    setBodyText('');
    setExternalUrl('');
  };

  const post = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (activeType.isFile && !file) return;
    if (type === 'text' && !bodyText.trim()) return;
    if (type === 'link' && !externalUrl.trim()) return;

    setPosting(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('type', type);
      formData.append('title', title.trim());
      if (activeType.isFile) formData.append('file', file);
      if (type === 'text') formData.append('bodyText', bodyText.trim());
      if (type === 'link') formData.append('externalUrl', externalUrl.trim());

      await axios.post(`${API}/api/admin/notices`, formData, { withCredentials: true });
      setTitle('');
      setFile(null);
      setBodyText('');
      setExternalUrl('');
      e.target.reset();
      fetchNotices();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to post notice.');
    } finally {
      setPosting(false);
    }
  };

  const remove = async (id) => {
    setBusyId(id);
    setError('');
    try {
      await axios.delete(`${API}/api/admin/notices/${id}`, { withCredentials: true });
      setNotices((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete notice.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="panel" style={{ padding: 20, marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 12px' }}>Post a notice</h3>

        <div role="tablist" aria-label="Notice type" style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {NOTICE_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-pressed={type === t.value}
              onClick={() => selectType(t.value)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px',
                borderRadius: 'var(--radius-sm)', border: `1px solid ${type === t.value ? 'var(--accent)' : 'var(--border)'}`,
                background: type === t.value ? 'var(--accent-soft, var(--surface-2))' : 'var(--surface-2)',
                color: type === t.value ? 'var(--accent)' : 'var(--text-dim)', cursor: 'pointer', fontSize: 13,
              }}
            >
              <t.icon size={15} />
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={post} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-h)' }}
          />

          {activeType.isFile && (
            <input type="file" accept={activeType.accept} onChange={(e) => setFile(e.target.files[0] || null)} required />
          )}
          {type === 'text' && (
            <textarea
              placeholder="Notice text"
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              required
              rows={3}
              style={{ flex: '1 1 320px', minWidth: 240, padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-h)', resize: 'vertical' }}
            />
          )}
          {type === 'link' && (
            <input
              type="url"
              placeholder="https://…"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              required
              style={{ flex: '1 1 260px', minWidth: 220, padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-h)' }}
            />
          )}

          <button type="submit" className="btn btn-primary btn-sm" disabled={posting}>
            {posting && <span className="spinner" />}
            {posting ? 'Posting…' : 'Post'}
          </button>
        </form>
      </div>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}

      <div className="admin-toolbar" style={{ gap: 8 }}>
        <input
          placeholder="Search by title…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-h)', minWidth: 220 }}
        />
      </div>

      {!notices && !error && <p className="sb-loading">Loading notices…</p>}
      {notices && notices.length === 0 && <p className="sb-loading">No notices yet.</p>}

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
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpandedId(expandedId === n.id ? null : n.id)}>
                          {expandedId === n.id ? 'Hide' : 'Read'}
                        </button>
                      ) : n.type === 'link' ? (
                        <a className="btn btn-ghost btn-sm" href={n.externalUrl} target="_blank" rel="noreferrer">Open</a>
                      ) : n.viewUrl ? (
                        <a className="btn btn-ghost btn-sm" href={n.viewUrl} target="_blank" rel="noreferrer">View</a>
                      ) : null}
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === n.id} onClick={() => remove(n.id)}>
                        {busyId === n.id ? 'Removing…' : 'Delete'}
                      </button>
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
    </div>
  );
}
