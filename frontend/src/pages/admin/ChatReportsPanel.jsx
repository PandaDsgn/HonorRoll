import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API } from '../../config';

// Admin-facing review queue for POST /api/chat/:otherUserId/messages/:messageId/report
// — the only safety mechanism chat's true E2EE can have, since the server
// otherwise never sees message content. Modeled directly on
// SuperadminContactPanels.jsx's AdminRequestsPanel (same panel + table +
// chip-status shape for exactly this "review queue" pattern).
export default function ChatReportsPanel() {
  const [reports, setReports] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const fetchReports = useCallback(() => {
    axios.get(`${API}/api/admin/chat-reports`, { withCredentials: true })
      .then((res) => setReports(res.data.reports))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load chat reports.'));
  }, []);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  const markReviewed = async (id) => {
    setBusyId(id);
    try {
      await axios.put(`${API}/api/admin/chat-reports/${id}`, { status: 'reviewed' }, { withCredentials: true });
      fetchReports();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update this report.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 4px' }}>Chat reports</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Messages a recipient flagged from the encrypted chat between students and teachers. Chat is genuinely
        end-to-end encrypted, so this is the only way a message's content ever reaches you — only what a reporter
        chose to flag, nothing else.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {!reports && !error && <p className="sb-loading">Loading…</p>}
      {reports && reports.length === 0 && <p className="sb-loading">No reports.</p>}

      {reports && reports.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Reported</th>
                <th>Reporter</th>
                <th>Message</th>
                <th>Note</th>
                <th>Status</th>
                <th>Reported</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td className="admin-cell-strong">{r.reportedName}</td>
                  <td>{r.reporterName}</td>
                  <td style={{ maxWidth: 280, whiteSpace: 'normal', fontSize: 13 }}>{r.plaintextContent}</td>
                  <td style={{ maxWidth: 200, whiteSpace: 'normal', fontSize: 13 }}>{r.reporterNote || '—'}</td>
                  <td><span className={`chip ${r.status === 'reviewed' ? 'chip-easy' : 'chip-medium'}`}><span className="dot" />{r.status}</span></td>
                  <td>{new Date(r.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
                  <td>
                    {r.status === 'open' && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === r.id} onClick={() => markReviewed(r.id)}>
                        {busyId === r.id ? 'Saving…' : 'Mark reviewed'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
