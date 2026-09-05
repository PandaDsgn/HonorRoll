import { useState, useEffect, useCallback, Fragment } from 'react';
import axios from 'axios';
import { API } from '../config';
import { NOTE_TYPES, NoteTypeIcon } from './NoteTypeIcons';
import { formatDate } from '../lib/formatDate';

// A teacher's own PDF/photo/video/audio/text/link library, one row per
// upload — always scoped to what THEY posted (see GET/DELETE
// /api/teacher/notes on the backend), never a co-teacher's. subjectId only
// ever offers subjects this teacher is actually linked to (GET
// /api/notes/subjects, same source AssignmentForm's own subject dropdown
// reads from). The subject filter and the title search both narrow the
// same list server-side rather than filtering client-side — matches how
// every other admin-dashboard list in this app already works.
export default function TeacherUploadsPanel() {
  const [subjects, setSubjects] = useState([]);
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState('');
  const [filterSubjectId, setFilterSubjectId] = useState('');
  const [search, setSearch] = useState('');

  const [type, setType] = useState('pdf');
  const [uploadSubjectId, setUploadSubjectId] = useState('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState(null);
  const [bodyText, setBodyText] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const activeType = NOTE_TYPES.find((t) => t.value === type);

  useEffect(() => {
    axios.get(`${API}/api/notes/subjects`, { withCredentials: true })
      .then((res) => setSubjects(res.data.subjects))
      .catch(() => setError('Failed to load subjects.'));
  }, []);

  const fetchNotes = useCallback(async () => {
    try {
      const params = {};
      if (filterSubjectId) params.subjectId = filterSubjectId;
      if (search.trim()) params.search = search.trim();
      const res = await axios.get(`${API}/api/teacher/notes`, { params, withCredentials: true });
      setNotes(res.data.notes);
    } catch {
      setError('Failed to load uploads.');
    }
  }, [filterSubjectId, search]);

  useEffect(() => { fetchNotes(); }, [fetchNotes]);

  const selectType = (value) => {
    setType(value);
    setFile(null);
    setBodyText('');
    setExternalUrl('');
  };

  const upload = async (e) => {
    e.preventDefault();
    if (!uploadSubjectId || !title.trim()) return;
    if (activeType.isFile && !file) return;
    if (type === 'text' && !bodyText.trim()) return;
    if (type === 'link' && !externalUrl.trim()) return;

    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('type', type);
      formData.append('subjectId', uploadSubjectId);
      formData.append('title', title.trim());
      if (activeType.isFile) formData.append('file', file);
      if (type === 'text') formData.append('bodyText', bodyText.trim());
      if (type === 'link') formData.append('externalUrl', externalUrl.trim());

      await axios.post(`${API}/api/teacher/notes`, formData, { withCredentials: true });
      setTitle('');
      setFile(null);
      setBodyText('');
      setExternalUrl('');
      e.target.reset();
      fetchNotes();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to upload note.');
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id) => {
    setBusyId(id);
    setError('');
    try {
      await axios.delete(`${API}/api/teacher/notes/${id}`, { withCredentials: true });
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete note.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="panel" style={{ padding: 20, marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 12px' }}>Post a note</h3>

        <div role="tablist" aria-label="Note type" style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {NOTE_TYPES.map((t) => (
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

        <form onSubmit={upload} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={uploadSubjectId} onChange={(e) => setUploadSubjectId(e.target.value)} required style={{ minWidth: 200 }}>
            <option value="">Select subject…</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.org_unit_name})</option>
            ))}
          </select>
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
              placeholder="Note text"
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

          <button type="submit" className="btn btn-primary btn-sm" disabled={uploading}>
            {uploading && <span className="spinner" />}
            {uploading ? 'Posting…' : 'Post'}
          </button>
        </form>
      </div>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}

      <div className="admin-toolbar" style={{ gap: 8 }}>
        <select value={filterSubjectId} onChange={(e) => setFilterSubjectId(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">All subjects</option>
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

      {!notes && !error && <p className="sb-loading">Loading uploads…</p>}
      {notes && notes.length === 0 && <p className="sb-loading">No uploads yet.</p>}

      {notes && notes.length > 0 && (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th aria-label="Type" />
                <th>Title</th>
                <th>Subject</th>
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
                      <td colSpan={5} style={{ background: 'var(--surface-2)', whiteSpace: 'pre-wrap' }}>{n.bodyText}</td>
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
