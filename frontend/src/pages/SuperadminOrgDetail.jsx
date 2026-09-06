import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { setOrgOverrideHeader } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import Breadcrumbs from '../components/Breadcrumbs';
import { API } from '../config';
import { formatDateTime as formatDate } from '../lib/formatDate';
import '../admin.css';

// A page built for the superadmin, not a trip through the institution's own
// AdminDashboard — see SuperadminDashboard's own comment on why. Every
// axios call this page makes carries an X-Organization-Id header (set once
// on mount below) instead of a swapped session token, so the superadmin's
// own login never changes; the backend re-derives admin authority for this
// one org from that header on every request (see requireAdmin's
// applySuperadminOrgOverride). Listing data reuses the same
// /api/admin/students, /api/admin/teachers, /api/admin/org-units,
// /api/admin/subjects, /api/admin/billing/status routes a real admin's own
// dashboard calls — same data, same shape — but every action here (add
// admin directly, terminate anyone's access, override billing) is its own
// superadmin-only endpoint, not a re-implementation of an admin one.
export default function SuperadminOrgDetail() {
  const navigate = useNavigate();
  const location = useLocation();
  const { orgId } = useParams();
  const { theme, toggleTheme } = useTheme();
  const [orgName, setOrgName] = useState(location.state?.orgName || null);
  const [section, setSection] = useState('people');
  // Every admin-scoped fetch below (teachers/students/structure/billing —
  // anything routed through requireAdmin's applySuperadminOrgOverride,
  // rather than a genuinely superadmin-only endpoint like AdminsSection's
  // own /api/superadmin/organizations) depends on the X-Organization-Id
  // header this effect sets. React runs a CHILD's effects before its
  // PARENT's on mount — so PeopleSection/StructureSection/BillingSection's
  // own child components (TeachersSection, StudentsSection, ...) would
  // otherwise fire their fetches before this effect ever ran, hitting
  // requireAdmin with no override header and a hard "Admin access
  // required" 403 on every single page load, deterministically. Gating
  // those sections behind headerReady means they don't even mount — so
  // their fetch effects can't fire — until the header is already set.
  const [headerReady, setHeaderReady] = useState(false);

  useEffect(() => {
    setOrgOverrideHeader(orgId);
    setHeaderReady(true);
    return () => { setOrgOverrideHeader(null); setHeaderReady(false); };
  }, [orgId]);

  // Split out from the header effect above (rather than one effect
  // depending on both orgId and orgName) — sharing a dependency array
  // would re-run the header effect's own cleanup+re-fire every time this
  // fetch resolves and calls setOrgName, briefly flipping headerReady
  // false-then-true and unmounting/remounting every child section for no
  // reason.
  useEffect(() => {
    if (orgName) return;
    axios.get(`${API}/api/superadmin/organizations/${orgId}`, { withCredentials: true })
      .then((res) => setOrgName(res.data.organization.name))
      .catch(() => setOrgName('this organization'));
  }, [orgId, orgName]);

  const SECTIONS = [
    { id: 'people', label: 'Admins, Teachers & Students' },
    { id: 'structure', label: 'Structure' },
    { id: 'billing', label: 'Billing' },
  ];

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="admin-shell">
        <Breadcrumbs items={[
          { label: 'Superadmin', to: '/superadmin' },
          { label: orgName || 'Loading…' },
        ]} />
        <div className="admin-head">
          <h1 className="problems-title">
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginRight: 10 }} onClick={() => navigate('/superadmin')}>&larr; All organizations</button>
            {orgName || 'Loading…'}
          </h1>
          <div className="segmented" role="tablist" aria-label="Organization section">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-pressed={section === s.id}
                className={section === s.id ? 'active' : ''}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {!headerReady ? (
          <p className="sb-loading">Loading…</p>
        ) : section === 'people' ? (
          <PeopleSection orgId={orgId} orgName={orgName} highlightStudentId={location.state?.selectStudentId} />
        ) : section === 'structure' ? (
          <StructureSection orgId={orgId} />
        ) : (
          <BillingSection orgId={orgId} />
        )}
      </section>
    </div>
  );
}

// ============================================================================
// PEOPLE — admins, teachers, and students together on one tab (status/plan
// already show on SuperadminDashboard's own table before you ever click in,
// so there's no separate overview here — just stacks the three roster
// sections, top authority down).
// ============================================================================
function PeopleSection({ orgId, orgName, highlightStudentId }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h3 style={{ margin: '0 0 12px' }}>Admins</h3>
        <AdminsSection orgId={orgId} orgName={orgName} />
      </div>
      <div>
        <h3 style={{ margin: '0 0 12px' }}>Teachers</h3>
        <TeachersSection orgId={orgId} />
      </div>
      <div>
        <h3 style={{ margin: '0 0 12px' }}>Students</h3>
        <StudentsSection orgId={orgId} highlightId={highlightStudentId} />
      </div>
    </div>
  );
}

// A "Terminate access" button + confirm-inline pattern shared by
// Admins/Students/Teachers below — each just removes one person's
// membership in this org (see DELETE /api/superadmin/organizations/:orgId/
// members/:userId), any role, unlike the admin-facing student-only delete.
function TerminateButton({ orgId, userId, label, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await axios.delete(`${API}/api/superadmin/organizations/${orgId}/members/${userId}`, { withCredentials: true });
      onDone(res.data.message);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove.');
      setBusy(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
        {error && <span style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</span>}
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        <button type="button" className="btn btn-sm" style={{ background: 'var(--danger)', color: '#fff' }} disabled={busy} onClick={run}>
          {busy ? 'Removing…' : 'Confirm'}
        </button>
      </div>
    );
  }
  return (
    <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setConfirming(true)}>
      {label || 'Terminate access'}
    </button>
  );
}

// ============================================================================
// ADMINS — every admin membership for this org, with a way to add one
// directly (no request/approve queue needed since the superadmin is already
// here) and to terminate any of them.
// ============================================================================
function AdminsSection({ orgId }) {
  const [admins, setAdmins] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchAdmins = useCallback(() => {
    axios.get(`${API}/api/superadmin/organizations`, { withCredentials: true })
      .then((res) => {
        const found = res.data.organizations.find((o) => String(o.id) === String(orgId));
        setAdmins(found ? found.admins : []);
      })
      .catch(() => setError('Failed to load admins.'));
  }, [orgId]);

  useEffect(() => { fetchAdmins(); }, [fetchAdmins]);

  const submit = async (e) => {
    e.preventDefault();
    setAdding(true);
    setError('');
    setMessage('');
    try {
      const res = await axios.post(`${API}/api/superadmin/organizations/${orgId}/admins`, { name, email }, { withCredentials: true });
      setMessage(res.data.isNew ? `${email} was created and added as admin — credentials emailed to them.` : `${email} was added as admin.`);
      setName('');
      setEmail('');
      fetchAdmins();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add admin.');
    } finally {
      setAdding(false);
    }
  };

  if (error && !admins) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;

  return (
    <div>
      <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px' }}>Add an admin</h3>
        {error && <div className="alert" style={{ marginBottom: 12 }}><span className="alert-icon">!</span><span>{error}</span></div>}
        {message && <p className="auth-sub" style={{ color: 'var(--accent)', margin: '0 0 12px' }}>{message}</p>}
        <form onSubmit={submit} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="admin-name">Name (optional)</label>
            <input id="admin-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="admin-email">Email</label>
            <input id="admin-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={adding}>{adding ? 'Adding…' : 'Add admin'}</button>
        </form>
      </div>

      <div className="panel admin-table-wrap">
        {!admins ? <p className="sb-loading" style={{ padding: 20 }}>Loading…</p> : admins.length === 0 ? (
          <p className="sb-loading" style={{ padding: 20 }}>No admins yet.</p>
        ) : (
          <table className="admin-table">
            <thead><tr><th>Name</th><th>Email</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.email}>
                  <td className="admin-cell-strong">{a.name || '—'}</td>
                  <td>{a.email}</td>
                  <td className="admin-cell-actions">
                    {a.user_id && (
                      <TerminateButton orgId={orgId} userId={a.user_id} onDone={() => { setMessage(`Removed ${a.email}.`); fetchAdmins(); }} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// STRUCTURE — org units (indented by level) and subjects per unit. A fresh,
// simplified view built for this page — not OrgStructureBuilder, which is
// the institution admin's own dense tree-builder widget. Rename/delete only
// here; adding new units/subjects still goes through the admin's own
// Structure tab, since designing a hierarchy from scratch is a rarer,
// higher-stakes action than the oversight/correction this page is for.
// ============================================================================
function StructureSection({ orgId }) {
  const [levels, setLevels] = useState(null);
  const [units, setUnits] = useState(null);
  const [subjects, setSubjects] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [editingUnit, setEditingUnit] = useState(null);
  const [editName, setEditName] = useState('');

  const fetchAll = useCallback(() => {
    Promise.all([
      axios.get(`${API}/api/admin/org-units`, { withCredentials: true }),
      axios.get(`${API}/api/admin/subjects`, { withCredentials: true }),
    ])
      .then(([unitsRes, subjectsRes]) => {
        setLevels(unitsRes.data.levels);
        setUnits(unitsRes.data.units);
        setSubjects(subjectsRes.data.subjects);
      })
      .catch(() => setError('Failed to load structure.'));
  }, [orgId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const renameUnit = async (id) => {
    setBusyId(id);
    try {
      await axios.put(`${API}/api/admin/org-units/${id}`, { name: editName }, { withCredentials: true });
      setEditingUnit(null);
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to rename unit.');
    } finally {
      setBusyId(null);
    }
  };

  const deleteUnit = async (id) => {
    setBusyId(id);
    try {
      await axios.delete(`${API}/api/admin/org-units/${id}`, { withCredentials: true });
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete unit — it may still have students or sub-units.');
    } finally {
      setBusyId(null);
    }
  };

  const deleteSubject = async (id) => {
    setBusyId(id);
    try {
      await axios.delete(`${API}/api/admin/subjects/${id}`, { withCredentials: true });
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete subject.');
    } finally {
      setBusyId(null);
    }
  };

  if (error && !units) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!units || !levels || !subjects) return <p className="sb-loading">Loading…</p>;

  const unitDepth = (unit) => {
    let depth = 0;
    let cur = unit;
    while (cur?.parent_unit_id) {
      cur = units.find((u) => u.id === cur.parent_unit_id);
      depth += 1;
      if (!cur) break;
    }
    return depth;
  };

  const sortedUnits = [...units].sort((a, b) => {
    const la = levels.find((l) => l.id === a.level_def_id)?.tier_index ?? 0;
    const lb = levels.find((l) => l.id === b.level_def_id)?.tier_index ?? 0;
    return la - lb || a.name.localeCompare(b.name);
  });

  return (
    <div>
      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}

      <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px' }}>Units</h3>
        {units.length === 0 ? <p className="sb-loading">No units defined yet.</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {sortedUnits.map((u) => {
              const level = levels.find((l) => l.id === u.level_def_id);
              return (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: unitDepth(u) * 24, padding: '6px 0' }}>
                  {editingUnit === u.id ? (
                    <>
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} style={{ maxWidth: 220 }} />
                      <button type="button" className="btn btn-primary btn-sm" disabled={busyId === u.id} onClick={() => renameUnit(u.id)}>Save</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingUnit(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className="admin-cell-strong">{u.name}</span>
                      <span className="auth-sub" style={{ fontSize: 12 }}>{level?.label}</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditingUnit(u.id); setEditName(u.name); }}>Rename</button>
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} disabled={busyId === u.id} onClick={() => deleteUnit(u.id)}>Delete</button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel admin-table-wrap">
        <h3 style={{ margin: '0 0 12px', padding: '20px 20px 0' }}>Subjects</h3>
        {subjects.length === 0 ? <p className="sb-loading" style={{ padding: '0 20px 20px' }}>No subjects defined yet.</p> : (
          <table className="admin-table">
            <thead><tr><th>Subject</th><th>Unit</th><th>Teachers</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {subjects.map((s) => (
                <tr key={s.id}>
                  <td className="admin-cell-strong">{s.name}</td>
                  <td>{s.org_unit_name}</td>
                  <td style={{ fontSize: 12.5 }}>{s.teachers.length === 0 ? '—' : s.teachers.map((t) => t.email).join(', ')}</td>
                  <td className="admin-cell-actions">
                    <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} disabled={busyId === s.id} onClick={() => deleteSubject(s.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const PLAN_ORDER = ['free', 'starter', 'growth', 'institution', 'scale'];
const STATUS_OPTIONS = ['free', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired', 'created', 'authenticated'];

// ============================================================================
// BILLING — current subscription at a glance, plus a direct override that
// bypasses Razorpay entirely (comps, manual invoicing, correcting a stuck
// subscription) — see POST .../billing/override on the backend.
// ============================================================================
function BillingSection({ orgId }) {
  const [status, setStatus] = useState(null);
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ planKey: 'free', billingCycle: 'monthly', status: 'active', currentPeriodEnd: '' });
  const [saving, setSaving] = useState(false);

  const fetchStatus = useCallback(() => {
    axios.get(`${API}/api/admin/billing/status`, { withCredentials: true })
      .then((res) => {
        setStatus(res.data);
        setForm((f) => ({ ...f, planKey: res.data.planKey, billingCycle: res.data.billingCycle || 'monthly', status: res.data.status }));
      })
      .catch(() => setError('Failed to load billing status.'));
  }, [orgId]);

  useEffect(() => {
    fetchStatus();
    axios.get(`${API}/api/billing/plans`, { withCredentials: true }).then((res) => setPlans(res.data.plans)).catch(() => {});
  }, [fetchStatus]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await axios.post(`${API}/api/superadmin/organizations/${orgId}/billing/override`, {
        planKey: form.planKey,
        billingCycle: form.planKey === 'free' ? null : form.billingCycle,
        status: form.status,
        currentPeriodEnd: form.currentPeriodEnd || null,
      }, { withCredentials: true });
      setMessage('Billing updated.');
      fetchStatus();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update billing.');
    } finally {
      setSaving(false);
    }
  };

  if (error && !status) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!status || !plans) return <p className="sb-loading">Loading…</p>;

  return (
    <div>
      <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px' }}>Current subscription</h3>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <div>
            <div className="field-group-label">Plan</div>
            <p style={{ margin: '4px 0 0' }}>{plans[status.planKey]?.label || status.planKey}</p>
          </div>
          <div>
            <div className="field-group-label">Status</div>
            <p style={{ margin: '4px 0 0' }}>{status.status}</p>
          </div>
          <div>
            <div className="field-group-label">Billing cycle</div>
            <p style={{ margin: '4px 0 0' }}>{status.billingCycle || '—'}</p>
          </div>
          <div>
            <div className="field-group-label">Renews / expires</div>
            <p style={{ margin: '4px 0 0' }}>{status.currentPeriodEnd ? formatDate(status.currentPeriodEnd) : '—'}</p>
          </div>
          <div>
            <div className="field-group-label">Students</div>
            <p style={{ margin: '4px 0 0' }}>{status.currentStudentCount} / {status.studentCap}</p>
          </div>
        </div>
      </div>

      <div className="panel" style={{ padding: 20 }}>
        <h3 style={{ margin: '0 0 4px' }}>Override billing</h3>
        <p className="auth-sub" style={{ margin: '0 0 16px' }}>
          Sets the plan/status directly — bypasses Razorpay entirely. Use for comps, manual invoicing, or fixing a stuck subscription.
        </p>
        {error && <div className="alert" style={{ marginBottom: 12 }}><span className="alert-icon">!</span><span>{error}</span></div>}
        {message && <p className="auth-sub" style={{ color: 'var(--accent)', margin: '0 0 12px' }}>{message}</p>}
        <form onSubmit={submit} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="ov-plan">Plan</label>
            <select id="ov-plan" value={form.planKey} onChange={(e) => setForm((f) => ({ ...f, planKey: e.target.value }))}>
              {PLAN_ORDER.map((k) => <option key={k} value={k}>{plans[k]?.label || k}</option>)}
            </select>
          </div>
          {form.planKey !== 'free' && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="ov-cycle">Billing cycle</label>
              <select id="ov-cycle" value={form.billingCycle} onChange={(e) => setForm((f) => ({ ...f, billingCycle: e.target.value }))}>
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
          )}
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="ov-status">Status</label>
            <select id="ov-status" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="ov-period-end">Renews/expires (optional)</label>
            <input id="ov-period-end" type="date" value={form.currentPeriodEnd} onChange={(e) => setForm((f) => ({ ...f, currentPeriodEnd: e.target.value }))} />
          </div>
          <button type="submit" className="btn btn-secondary-choice btn-sm" disabled={saving}>{saving ? 'Saving…' : 'Apply override'}</button>
        </form>
      </div>
    </div>
  );
}

// ============================================================================
// STUDENTS — every student in this org, with per-row termination.
// ============================================================================
function StudentsSection({ orgId, highlightId }) {
  const [students, setStudents] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const fetchStudents = useCallback(() => {
    axios.get(`${API}/api/admin/students`, { withCredentials: true })
      .then((res) => setStudents(res.data.students))
      .catch(() => setError('Failed to load students.'));
  }, [orgId]);

  useEffect(() => { fetchStudents(); }, [fetchStudents]);

  if (error && !students) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!students) return <p className="sb-loading">Loading…</p>;

  return (
    <div>
      {message && <p className="auth-sub" style={{ color: 'var(--accent)', margin: '0 0 12px' }}>{message}</p>}
      {students.length === 0 ? (
        <p className="sb-loading">No students yet.</p>
      ) : (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Name</th><th>Email</th><th>Unit</th><th>Joined</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id} style={String(s.id) === String(highlightId) ? { background: 'var(--surface-2)' } : undefined}>
                  <td className="admin-cell-strong">{s.name || '—'}</td>
                  <td>{s.email}</td>
                  <td style={{ fontSize: 12.5 }}>{s.unit_path?.map((p) => p.name).join(' / ') || '—'}</td>
                  <td>{formatDate(s.created_at)}</td>
                  <td className="admin-cell-actions">
                    <TerminateButton orgId={orgId} userId={s.id} onDone={(msg) => { setMessage(msg); fetchStudents(); }} />
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
// TEACHERS — every teacher in this org, with per-row termination.
// ============================================================================
function TeachersSection({ orgId }) {
  const [teachers, setTeachers] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const fetchTeachers = useCallback(() => {
    axios.get(`${API}/api/admin/teachers`, { withCredentials: true })
      .then((res) => setTeachers(res.data.teachers))
      .catch(() => setError('Failed to load teachers.'));
  }, [orgId]);

  useEffect(() => { fetchTeachers(); }, [fetchTeachers]);

  if (error && !teachers) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!teachers) return <p className="sb-loading">Loading…</p>;

  return (
    <div>
      {message && <p className="auth-sub" style={{ color: 'var(--accent)', margin: '0 0 12px' }}>{message}</p>}
      {teachers.length === 0 ? (
        <p className="sb-loading">No teachers yet.</p>
      ) : (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Name</th><th>Email</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {teachers.map((t) => (
                <tr key={t.id}>
                  <td className="admin-cell-strong">{t.name || '—'}</td>
                  <td>{t.email}</td>
                  <td className="admin-cell-actions">
                    <TerminateButton orgId={orgId} userId={t.id} onDone={(msg) => { setMessage(msg); fetchTeachers(); }} />
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
