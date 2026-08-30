import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API } from '../../config';

// ============================================================================
// REQUEST ADD-ADMIN — structured, unlike AdminRequestsPanel's free-form
// message below: approving one of these actually creates the membership
// (see POST /api/superadmin/add-admin-requests/:id/approve), so it needs
// real name/email fields, not prose the superadmin has to parse and action
// by hand. Nothing in this dashboard lets an admin add a co-admin directly
// the way they can add a teacher/student themselves — admin is the org's
// top role here, so that has to be gated through the superadmin.
// ============================================================================
export function RequestAddAdminPanel() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const fetchRequests = useCallback(() => {
    axios.get(`${API}/api/admin/add-admin-requests`, { withCredentials: true })
      .then((res) => setRequests(res.data.requests))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load your requests.'));
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const submit = async (e) => {
    e.preventDefault();
    setSending(true);
    setError('');
    setSent(false);
    try {
      await axios.post(`${API}/api/admin/add-admin-requests`, { name, email }, { withCredentials: true });
      setName('');
      setEmail('');
      setSent(true);
      fetchRequests();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send request.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 4px' }}>Request another admin be added</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Adding a co-admin for your institution goes through the platform owner — tell them who to add.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {sent && <p className="auth-sub" style={{ color: 'var(--accent)', margin: '0 0 16px' }}>Request sent.</p>}

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 420, marginBottom: 20 }}>
        <input
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: '8px 10px', fontSize: 13.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
        />
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: '8px 10px', fontSize: 13.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={sending} style={{ alignSelf: 'flex-start' }}>
          {sending ? 'Sending…' : 'Send request'}
        </button>
      </form>

      {requests && requests.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Status</th>
                <th>Note</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="admin-cell-strong">{r.new_admin_name || '—'}</td>
                  <td>{r.new_admin_email}</td>
                  <td><span className={`chip ${r.status === 'approved' ? 'chip-easy' : r.status === 'rejected' ? 'chip-hard' : 'chip-medium'}`}><span className="dot" />{r.status}</span></td>
                  <td style={{ maxWidth: 200, whiteSpace: 'normal', fontSize: 13 }}>{r.review_note || '—'}</td>
                  <td>{new Date(r.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ADMIN REQUESTS — an institution admin's own free-form message to the
// platform owner. Separate from AdminProfileChangeRequestsPanel's "Escalate"
// button above: that only fires in reaction to a student's pre-existing
// request, so it's not a way for an admin to reach the superadmin on their
// own initiative. This is that missing direct channel.
// ============================================================================
export function AdminRequestsPanel() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const fetchRequests = useCallback(() => {
    axios.get(`${API}/api/admin/requests`, { withCredentials: true })
      .then((res) => setRequests(res.data.requests))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load your requests.'));
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const submit = async (e) => {
    e.preventDefault();
    setSending(true);
    setError('');
    setSent(false);
    try {
      await axios.post(`${API}/api/admin/requests`, { subject, message }, { withCredentials: true });
      setSubject('');
      setMessage('');
      setSent(true);
      fetchRequests();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send request.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 4px' }}>Contact the platform owner</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Send a request or question straight to the superadmin — for anything that isn't a student info correction.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {sent && <p className="auth-sub" style={{ color: 'var(--accent)', margin: '0 0 16px' }}>Request sent.</p>}

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480, marginBottom: 20 }}>
        <input
          placeholder="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
          style={{ padding: '8px 10px', fontSize: 13.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
        />
        <textarea
          placeholder="Message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          rows={4}
          style={{ padding: '8px 10px', fontSize: 13.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', resize: 'vertical' }}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={sending} style={{ alignSelf: 'flex-start' }}>
          {sending ? 'Sending…' : 'Send request'}
        </button>
      </form>

      {requests && requests.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Message</th>
                <th>Status</th>
                <th>Response</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="admin-cell-strong">{r.subject}</td>
                  <td style={{ maxWidth: 260, whiteSpace: 'normal', fontSize: 13 }}>{r.message}</td>
                  <td><span className={`chip ${r.status === 'resolved' ? 'chip-easy' : 'chip-medium'}`}><span className="dot" />{r.status}</span></td>
                  <td style={{ maxWidth: 200, whiteSpace: 'normal', fontSize: 13 }}>{r.response_note || '—'}</td>
                  <td>{new Date(r.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
