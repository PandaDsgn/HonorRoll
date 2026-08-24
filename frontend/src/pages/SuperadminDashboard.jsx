import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import LogoutFab from '../components/LogoutFab';
import { API } from '../config';
import '../admin.css';

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const STATUS_CLASS = { approved: 'chip-easy', pending: 'chip-medium', rejected: 'chip-hard', terminated: 'chip-hard' };
const ROLE_CLASS = { admin: 'chip-hard', teacher: 'chip-medium', student: 'chip-easy' };
const PCR_STATUS_CLASS = { pending: 'chip-medium', escalated: 'chip-medium', approved: 'chip-easy', rejected: 'chip-hard' };

// Platform-owner view — every organization on the platform, with the org
// name itself as the way in: click it and you land on SuperadminOrgDetail
// (/superadmin/organizations/:orgId) — a page built for the superadmin,
// not a trip through the institution's own AdminDashboard. The superadmin's
// session token is never swapped for an admin one to get there; see
// setOrgOverrideHeader and requireAdmin's own comments for how that org
// detail page's requests still reach the same backend data admin routes
// serve, scoped via header instead of a minted token. What genuinely
// doesn't exist anywhere else on THIS page is a platform-wide roll-up
// (summary cards below), a queue of student
// profile-correction requests escalated by institution admins
// (ProfileChangeRequestsPanel below), and a way to find a specific person
// without knowing which org to look in first (user search below, deep-linking
// straight to their StudentDetailPanel entry when they're a student).
export default function SuperadminDashboard() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { user, setUser } = useAuth();
  const [orgs, setOrgs] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [orgFilter, setOrgFilter] = useState('');
  const [statusBusyId, setStatusBusyId] = useState(null);
  const [deletingOrg, setDeletingOrg] = useState(null); // { id, name } | null — org currently in the confirm-delete flow
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState('');

  const fetchOrgs = useCallback(() => {
    axios.get(`${API}/api/superadmin/organizations`, { withCredentials: true })
      .then((res) => { setOrgs(res.data.organizations); setSummary(res.data.summary); })
      .catch(() => setError('Failed to load organizations.'));
  }, []);

  useEffect(() => { fetchOrgs(); }, [fetchOrgs]);

  // Superadmin is the one role nothing else ever collects a display name
  // for — an admin sets theirs at signup, a teacher/student gets theirs
  // from whoever imported them — so this is the one self-service "set my
  // own name" entry point in the whole app (see PUT /api/me's own comment
  // on the backend). Updates local auth state directly on success rather
  // than a full refetch, since the response already carries the new name.
  const startEditName = () => {
    setNameDraft(user?.name || '');
    setEditingName(true);
  };
  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    setSavingName(true);
    setError('');
    try {
      await axios.put(`${API}/api/me`, { name: trimmed }, { withCredentials: true });
      setUser((prev) => ({ ...prev, name: trimmed }));
      setEditingName(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update name.');
    } finally {
      setSavingName(false);
    }
  };

  // Just a navigation — no API call, no token swap. `orgName` rides along as
  // router state so SuperadminOrgDetail can show it immediately without a
  // fetch; `selectStudentId` (only ever set from the user-search panel's
  // "View" button on a student row) does the same for jumping straight to
  // that student's row in the Students section instead of the section
  // default.
  const enterOrg = (orgId, orgName, selectStudentId) => {
    navigate(`/superadmin/organizations/${orgId}`, { state: { orgName, selectStudentId } });
  };

  // Shared by every status-transition button below (approve/unapprove/
  // reject/terminate) — each just PATCHes the org to a fixed target status
  // (see makeSetOrgStatusRoute on the backend), so the only thing that
  // differs per action is which endpoint and, for the two destructive ones,
  // the confirmation copy.
  const setOrgStatus = async (orgId, action, confirmMessage) => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setError('');
    setStatusBusyId(orgId);
    try {
      await axios.post(`${API}/api/superadmin/organizations/${orgId}/${action}`, {}, { withCredentials: true });
      fetchOrgs();
    } catch (err) {
      setError(err.response?.data?.error || `Failed to ${action} organization.`);
    } finally {
      setStatusBusyId(null);
    }
  };

  // Permanent, backend-enforced: DELETE /api/superadmin/organizations/:id
  // emails every admin of this org a full data export and only then deletes
  // it — if the send fails for any reason, the backend leaves the org
  // untouched. This is the button for that route; typing the exact org name
  // is this form's own guard against a stray click on something that can't
  // be undone.
  const confirmDelete = async () => {
    if (!deletingOrg || deleteConfirmText !== deletingOrg.name) return;
    setDeleting(true);
    setError('');
    setDeleteResult('');
    try {
      const res = await axios.delete(`${API}/api/superadmin/organizations/${deletingOrg.id}`, { withCredentials: true });
      setDeleteResult(res.data.message);
      setDeletingOrg(null);
      setDeleteConfirmText('');
      fetchOrgs();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete organization.');
    } finally {
      setDeleting(false);
    }
  };

  const filteredOrgs = orgs?.filter((o) => o.name.toLowerCase().includes(orgFilter.trim().toLowerCase())) ?? null;

  return (
    <div className="sb-shell">
      <LogoutFab />
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <span className="auth-sub">{user?.email}</span>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <div>
            <h1 className="problems-title" style={{ marginBottom: 4 }}>Superadmin Dashboard</h1>
            {editingName ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
                  style={{ width: 200, padding: '4px 8px', fontSize: 14, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                />
                <button type="button" className="btn btn-primary btn-sm" disabled={savingName || !nameDraft.trim()} onClick={saveName}>
                  {savingName ? 'Saving…' : 'Save'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={savingName} onClick={() => setEditingName(false)}>Cancel</button>
              </div>
            ) : (
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-h)', display: 'flex', alignItems: 'center', gap: 8 }}>
                {user?.name || <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>No name set</span>}
                <button type="button" className="btn btn-ghost btn-sm" onClick={startEditName}>
                  {user?.name ? 'Edit' : 'Add name'}
                </button>
              </div>
            )}
          </div>
        </div>

        {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
        {deleteResult && <div className="alert alert-success" style={{ marginBottom: 16 }}><span className="alert-icon">✓</span><span>{deleteResult}</span></div>}

        {deletingOrg && (
          <div className="panel" style={{ padding: 20, marginBottom: 16, borderColor: 'var(--danger)' }}>
            <h3 style={{ margin: '0 0 4px', color: 'var(--danger)' }}>Permanently delete {deletingOrg.name}?</h3>
            <p className="auth-sub" style={{ margin: '0 0 12px' }}>
              This removes every record this institution has on HonorRoll — roster, structure, assignments, exams,
              submissions, everything — with no way to undo it. A full export will be emailed to its admin(s) first;
              if that email can't be sent, nothing is deleted.
            </p>
            <div className="field" style={{ maxWidth: 360, marginBottom: 12 }}>
              <label htmlFor="delete-confirm-name">Type <strong>{deletingOrg.name}</strong> to confirm</label>
              <input
                id="delete-confirm-name"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-sm" disabled={deleting} onClick={() => { setDeletingOrg(null); setDeleteConfirmText(''); }}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{ background: 'var(--danger)', color: '#fff' }}
                disabled={deleting || deleteConfirmText !== deletingOrg.name}
                onClick={confirmDelete}
              >
                {deleting ? 'Deleting…' : 'Permanently delete'}
              </button>
            </div>
          </div>
        )}

        {summary && <SummaryCards summary={summary} />}

        <ProfileChangeRequestsPanel />

        <AdminMessagesPanel />

        <ContactMessagesPanel />

        <AddAdminRequestsPanel />

        <UserSearchPanel onEnterOrg={enterOrg} />

        <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 12px' }}>Organizations</h3>
          <input
            placeholder="Filter by name…"
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            style={{ maxWidth: 280 }}
          />
        </div>

        {!orgs && !error && <p className="sb-loading">Loading organizations…</p>}
        {filteredOrgs && filteredOrgs.length === 0 && <p className="sb-loading">No organizations match.</p>}

        {filteredOrgs && filteredOrgs.length > 0 && (
          <div className="panel admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Status</th>
                  <th>Plan</th>
                  <th>Admin(s)</th>
                  <th>Students</th>
                  <th>Teachers</th>
                  <th>Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filteredOrgs.map((org) => (
                  <tr key={org.id}>
                    <td className="admin-cell-strong">
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => enterOrg(org.id, org.name)}
                        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}
                      >
                        {org.name}
                      </button>
                    </td>
                    <td><span className={`chip ${STATUS_CLASS[org.status] || 'chip-neutral'}`}><span className="dot" />{org.status}</span></td>
                    <td>{org.plan_key} <span className="auth-sub">({org.billing_status})</span></td>
                    <td style={{ fontSize: 12.5 }}>
                      {org.admins.length === 0 ? <span className="auth-sub">—</span> : org.admins.map((a) => (
                        <div key={a.email}>{a.name || a.email}{a.name && <span className="auth-sub"> ({a.email})</span>}</div>
                      ))}
                    </td>
                    <td>{org.student_count}</td>
                    <td>{org.teacher_count}</td>
                    <td>{formatDate(org.created_at)}</td>
                    <td className="admin-cell-actions">
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {org.status === 'pending' && (
                          <>
                            <button type="button" className="btn btn-ghost btn-sm" disabled={statusBusyId === org.id} onClick={() => setOrgStatus(org.id, 'approve')}>Approve</button>
                            <button type="button" className="btn btn-ghost btn-sm" disabled={statusBusyId === org.id} onClick={() => setOrgStatus(org.id, 'reject', `Reject ${org.name}? They won't be able to add students or teachers until approved.`)}>Reject</button>
                          </>
                        )}
                        {org.status === 'approved' && (
                          <>
                            <button type="button" className="btn btn-ghost btn-sm" disabled={statusBusyId === org.id} onClick={() => setOrgStatus(org.id, 'unapprove', `Move ${org.name} back to pending? They'll keep existing access but won't be able to add students or teachers until re-approved.`)}>Unapprove</button>
                            <button type="button" className="btn btn-ghost btn-sm" disabled={statusBusyId === org.id} onClick={() => setOrgStatus(org.id, 'terminate', `Terminate ${org.name}? Nobody at this institution — admin, teachers, or students — will be able to log in until it's reinstated.`)}>Terminate</button>
                          </>
                        )}
                        {org.status === 'rejected' && (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={statusBusyId === org.id} onClick={() => setOrgStatus(org.id, 'approve')}>Approve</button>
                        )}
                        {org.status === 'terminated' && (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={statusBusyId === org.id} onClick={() => setOrgStatus(org.id, 'approve')}>Reinstate</button>
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => { setDeletingOrg({ id: org.id, name: org.name }); setDeleteConfirmText(''); setDeleteResult(''); }}
                        >
                          Delete
                        </button>
                      </div>
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

function SummaryCards({ summary }) {
  const cardStyle = { flex: '1 1 160px', padding: 16 };
  const numStyle = { fontSize: 28, fontWeight: 700, margin: '4px 0 0' };
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
      <div className="panel" style={cardStyle}>
        <div className="field-group-label">Organizations</div>
        <p style={numStyle}>{summary.totalOrganizations}</p>
      </div>
      <div className="panel" style={cardStyle}>
        <div className="field-group-label">Students</div>
        <p style={numStyle}>{summary.totalStudents}</p>
      </div>
      <div className="panel" style={cardStyle}>
        <div className="field-group-label">Teachers</div>
        <p style={numStyle}>{summary.totalTeachers}</p>
      </div>
      <div className="panel" style={{ ...cardStyle, flex: '2 1 260px' }}>
        <div className="field-group-label" style={{ marginBottom: 8 }}>Plans</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(summary.planBreakdown).map(([plan, count]) => (
            <span key={plan} className="chip chip-neutral"><span className="dot" />{plan}: {count}</span>
          ))}
        </div>
      </div>
      <div className="panel" style={{ ...cardStyle, flex: '2 1 260px' }}>
        <div className="field-group-label" style={{ marginBottom: 8 }}>Billing status</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(summary.billingStatusBreakdown).map(([status, count]) => (
            <span key={status} className="chip chip-neutral"><span className="dot" />{status}: {count}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PROFILE CHANGE REQUESTS — the queue of student info-correction requests
// that were escalated by institution administrators to the superadmin.
// Defaults to the escalated queue; "Show reviewed too" flips to ?status=all.
// ============================================================================
function ProfileChangeRequestsPanel() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [noteDrafts, setNoteDrafts] = useState({});
  const [showAll, setShowAll] = useState(false);

  const fetchRequests = useCallback(() => {
    axios.get(`${API}/api/superadmin/profile-change-requests`, {
      params: { status: showAll ? 'all' : 'escalated' },
      withCredentials: true,
    })
      .then((res) => setRequests(res.data.requests))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load profile change requests.'));
  }, [showAll]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // POST /api/superadmin/profile-change-requests/:id/review — on approval,
  // the backend auto-applies 'name'/'roll_number' fields straight to the
  // DB; anything else is just recorded as approved for a human to action.
  const review = async (id, status) => {
    setBusyId(id);
    setError('');
    try {
      await axios.post(`${API}/api/superadmin/profile-change-requests/${id}/review`, {
        status,
        note: noteDrafts[id] || '',
      }, { withCredentials: true });
      fetchRequests();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to review request.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Admin Requests</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show reviewed too
        </label>
      </div>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Requests from institution administrators.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}

      {!requests && !error && <p className="sb-loading">Loading…</p>}
      {requests && requests.length === 0 && <p className="sb-loading">No requests to show.</p>}

      {requests && requests.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Institution</th>
                <th>Escalated by</th>
                <th>Field</th>
                <th>Current → Requested</th>
                <th>Reason & Notes</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="admin-cell-strong">
                    {r.student_name || r.student_email}
                    {r.student_name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{r.student_email}</div>}
                  </td>
                  <td>{r.organization_name}</td>
                  <td>
                    {r.escalated_by_name || r.escalated_by_email ? (
                      <div>
                        {r.escalated_by_name || 'Admin'}
                        {r.escalated_by_email && <div style={{ color: 'var(--text-dim)', fontSize: '12px' }}>{r.escalated_by_email}</div>}
                      </div>
                    ) : '—'}
                  </td>
                  <td>{r.field}</td>
                  <td>{r.current_value || '—'} <span style={{ color: 'var(--text-dim)' }}>&rarr;</span> {r.requested_value}</td>
                  <td style={{ maxWidth: 220, whiteSpace: 'normal', fontSize: '13px' }}>
                    {r.reason && <div><strong>Student:</strong> {r.reason}</div>}
                    {r.escalation_note && <div style={{ marginTop: 4, color: 'var(--text-dim)' }}><strong>Admin escalation:</strong> {r.escalation_note}</div>}
                    {!r.reason && !r.escalation_note && '—'}
                  </td>
                  <td><span className={`chip ${PCR_STATUS_CLASS[r.status] || 'chip-neutral'}`}><span className="dot" />{r.status}</span></td>
                  <td className="admin-cell-actions">
                    {r.status === 'escalated' || r.status === 'pending' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                        <input
                          placeholder="Review note (optional)"
                          value={noteDrafts[r.id] || ''}
                          onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          style={{ width: 180, padding: '4px 8px', fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === r.id} onClick={() => review(r.id, 'rejected')}>Reject</button>
                          <button type="button" className="btn btn-primary btn-sm" disabled={busyId === r.id} onClick={() => review(r.id, 'approved')}>
                            {busyId === r.id ? 'Saving…' : 'Approve'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      r.review_note || '—'
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

// ============================================================================
// ADMIN MESSAGES — free-form requests institution admins send directly to
// the platform owner (POST /api/admin/requests), separate from the escalated
// student-correction queue above: this is the only channel an admin has to
// reach the superadmin without a student having filed something first.
// Defaults to the open queue; "Show resolved too" flips to ?status=all.
// ============================================================================
function AdminMessagesPanel() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [noteDrafts, setNoteDrafts] = useState({});
  const [showAll, setShowAll] = useState(false);

  const fetchRequests = useCallback(() => {
    axios.get(`${API}/api/superadmin/requests`, {
      params: { status: showAll ? 'all' : 'open' },
      withCredentials: true,
    })
      .then((res) => setRequests(res.data.requests))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load admin messages.'));
  }, [showAll]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const resolve = async (id) => {
    setBusyId(id);
    setError('');
    try {
      await axios.post(`${API}/api/superadmin/requests/${id}/resolve`, {
        note: noteDrafts[id] || '',
      }, { withCredentials: true });
      fetchRequests();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to resolve request.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Admin Messages</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show resolved too
        </label>
      </div>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Direct requests from institution administrators.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {!requests && !error && <p className="sb-loading">Loading…</p>}
      {requests && requests.length === 0 && <p className="sb-loading">No messages to show.</p>}

      {requests && requests.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Admin</th>
                <th>Institution</th>
                <th>Subject</th>
                <th>Message</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="admin-cell-strong">
                    {r.admin_name || r.admin_email}
                    {r.admin_name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{r.admin_email}</div>}
                  </td>
                  <td>{r.organization_name}</td>
                  <td>{r.subject}</td>
                  <td style={{ maxWidth: 260, whiteSpace: 'normal', fontSize: 13 }}>{r.message}</td>
                  <td><span className={`chip ${r.status === 'resolved' ? 'chip-easy' : 'chip-medium'}`}><span className="dot" />{r.status}</span></td>
                  <td className="admin-cell-actions">
                    {r.status === 'open' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                        <input
                          placeholder="Response (optional)"
                          value={noteDrafts[r.id] || ''}
                          onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          style={{ width: 180, padding: '4px 8px', fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                        />
                        <button type="button" className="btn btn-primary btn-sm" disabled={busyId === r.id} onClick={() => resolve(r.id)}>
                          {busyId === r.id ? 'Saving…' : 'Mark resolved'}
                        </button>
                      </div>
                    ) : (
                      r.response_note || '—'
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

// ============================================================================
// CONTACT MESSAGES — the public /contact page's inbox. Unlike every other
// panel on this dashboard, senders here aren't necessarily existing users
// of the platform at all — a prospective institution, a parent, anyone who
// found the marketing site — so there's no admin/organization identity to
// show, just whatever they typed into the form (see POST /api/contact).
// ============================================================================
function ContactMessagesPanel() {
  const [messages, setMessages] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [noteDrafts, setNoteDrafts] = useState({});
  const [showAll, setShowAll] = useState(false);

  const fetchMessages = useCallback(() => {
    axios.get(`${API}/api/superadmin/contact-messages`, {
      params: { status: showAll ? 'all' : 'open' },
      withCredentials: true,
    })
      .then((res) => setMessages(res.data.messages))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load contact messages.'));
  }, [showAll]);

  useEffect(() => { fetchMessages(); }, [fetchMessages]);

  const resolve = async (id) => {
    setBusyId(id);
    setError('');
    try {
      await axios.post(`${API}/api/superadmin/contact-messages/${id}/resolve`, {
        note: noteDrafts[id] || '',
      }, { withCredentials: true });
      fetchMessages();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to resolve message.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Contact Messages</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show resolved too
        </label>
      </div>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Submissions from the public /contact page.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {!messages && !error && <p className="sb-loading">Loading…</p>}
      {messages && messages.length === 0 && <p className="sb-loading">No messages to show.</p>}

      {messages && messages.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Contact</th>
                <th>Message</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id}>
                  <td className="admin-cell-strong">{m.name}</td>
                  <td style={{ fontSize: 12.5 }}>
                    <div>{m.email}</div>
                    <div style={{ color: 'var(--text-dim)' }}>{m.mobile}</div>
                  </td>
                  <td style={{ maxWidth: 320, whiteSpace: 'normal', fontSize: 13 }}>{m.message}</td>
                  <td><span className={`chip ${m.status === 'resolved' ? 'chip-easy' : 'chip-medium'}`}><span className="dot" />{m.status}</span></td>
                  <td className="admin-cell-actions">
                    {m.status === 'open' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                        <input
                          placeholder="Response (optional)"
                          value={noteDrafts[m.id] || ''}
                          onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))}
                          style={{ width: 180, padding: '4px 8px', fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                        />
                        <button type="button" className="btn btn-primary btn-sm" disabled={busyId === m.id} onClick={() => resolve(m.id)}>
                          {busyId === m.id ? 'Saving…' : 'Mark resolved'}
                        </button>
                      </div>
                    ) : (
                      m.response_note || '—'
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

// ============================================================================
// ADD-ADMIN REQUESTS — structured requests from institution admins asking
// for a co-admin to be added (see RequestAddAdminPanel on the admin side).
// Approving one actually creates the membership on the backend, so unlike
// AdminMessagesPanel above there's nothing left for the superadmin to go do
// manually afterward.
// ============================================================================
function AddAdminRequestsPanel() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [noteDrafts, setNoteDrafts] = useState({});
  const [showAll, setShowAll] = useState(false);

  const fetchRequests = useCallback(() => {
    axios.get(`${API}/api/superadmin/add-admin-requests`, {
      params: { status: showAll ? 'all' : 'pending' },
      withCredentials: true,
    })
      .then((res) => setRequests(res.data.requests))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load add-admin requests.'));
  }, [showAll]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const review = async (id, action) => {
    setBusyId(id);
    setError('');
    try {
      await axios.post(`${API}/api/superadmin/add-admin-requests/${id}/${action}`, {
        note: noteDrafts[id] || '',
      }, { withCredentials: true });
      fetchRequests();
    } catch (err) {
      setError(err.response?.data?.error || `Failed to ${action} request.`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Add-Admin Requests</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show reviewed too
        </label>
      </div>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Requests from institution admins to add a co-admin. Approving creates the membership immediately.
      </p>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {!requests && !error && <p className="sb-loading">Loading…</p>}
      {requests && requests.length === 0 && <p className="sb-loading">No requests to show.</p>}

      {requests && requests.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Institution</th>
                <th>Requested by</th>
                <th>New admin</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="admin-cell-strong">{r.organization_name}</td>
                  <td>
                    {r.requested_by_name || r.requested_by_email}
                    {r.requested_by_name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{r.requested_by_email}</div>}
                  </td>
                  <td>
                    {r.new_admin_name || r.new_admin_email}
                    {r.new_admin_name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{r.new_admin_email}</div>}
                  </td>
                  <td><span className={`chip ${r.status === 'approved' ? 'chip-easy' : r.status === 'rejected' ? 'chip-hard' : 'chip-medium'}`}><span className="dot" />{r.status}</span></td>
                  <td className="admin-cell-actions">
                    {r.status === 'pending' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                        <input
                          placeholder="Note (optional)"
                          value={noteDrafts[r.id] || ''}
                          onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          style={{ width: 180, padding: '4px 8px', fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)' }}
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === r.id} onClick={() => review(r.id, 'reject')}>Reject</button>
                          <button type="button" className="btn btn-primary btn-sm" disabled={busyId === r.id} onClick={() => review(r.id, 'approve')}>
                            {busyId === r.id ? 'Saving…' : 'Approve'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      r.review_note || '—'
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

// Global "find this person" search — a superadmin doesn't otherwise have
// any way to locate a specific student/teacher/admin without already
// knowing (and opening) their org. Each membership row gets its own "View"
// action since the same email can belong to several orgs with different
// roles in each.
function UserSearchPanel({ onEnterOrg }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const runSearch = async () => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSearchError('Type at least 2 characters.');
      return;
    }
    setSearching(true);
    setSearchError('');
    try {
      const res = await axios.get(`${API}/api/superadmin/users`, { params: { search: trimmed }, withCredentials: true });
      setResults(res.data.users);
    } catch (err) {
      setSearchError(err.response?.data?.error || 'Search failed.');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 4px' }}>Find a person</h3>
      <p className="auth-sub" style={{ margin: '0 0 12px' }}>Search by name or email across every organization on the platform.</p>
      <div className="testcase-row" style={{ maxWidth: 480 }}>
        <input
          placeholder="Name or email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
        />
        <button type="button" className="btn btn-primary btn-sm" disabled={searching} onClick={runSearch}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>
      {searchError && <p className="auth-sub" style={{ color: 'var(--danger)', margin: '10px 0 0' }}>{searchError}</p>}

      {results && (
        results.length === 0 ? (
          <p className="sb-loading" style={{ marginTop: 12 }}>No matches.</p>
        ) : (
          <div className="admin-table-wrap" style={{ marginTop: 16 }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Memberships</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {results.flatMap((u) => u.memberships.map((m, i) => (
                  <tr key={`${u.id}-${m.organizationId}`}>
                    {i === 0 && (
                      <td className="admin-cell-strong" rowSpan={u.memberships.length}>
                        {u.name || u.email}
                        {u.name && <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontWeight: 400 }}>{u.email}</div>}
                      </td>
                    )}
                    <td>
                      <span className={`chip ${ROLE_CLASS[m.role] || 'chip-neutral'}`}><span className="dot" />{m.role}</span>
                      <span style={{ marginLeft: 8 }}>{m.organizationName}</span>
                    </td>
                    <td className="admin-cell-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => onEnterOrg(m.organizationId, m.organizationName, m.role === 'student' ? u.id : undefined)}
                      >
                        {m.role === 'student' ? 'View & edit' : 'Enter org'}
                      </button>
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
