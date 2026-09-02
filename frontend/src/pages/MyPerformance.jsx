import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher, { SpaceNotifications } from '../components/SpaceSwitcher';
import LogoutFab from '../components/LogoutFab';
import PercentBar from '../components/PercentBar';
import IdCard from '../components/IdCard';
import PhotoPicker from '../components/PhotoPicker';
import { PERF_STATUS_LABELS, PERF_STATUS_CLASS } from '../lib/performanceStatus';
import { API } from '../config';
import '../admin.css';
import '../IdCard.css';

const REQUEST_STATUS_LABELS = { pending: 'Pending review', approved: 'Approved', rejected: 'Rejected' };
const REQUEST_STATUS_CLASS = { pending: 'chip-medium', approved: 'chip-easy', rejected: 'chip-hard' };

// PercentileTag/GradeTag chips — null-safe, renders nothing when the tag
// itself is null (either the institution has that visibility setting
// turned off, or there wasn't enough population/data to compute one yet).
function TagChips({ percentileTag, gradeTag }) {
  if (!percentileTag && !gradeTag) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 6, marginLeft: 8 }}>
      {percentileTag && <span className="chip chip-neutral"><span className="dot" />{percentileTag}</span>}
      {gradeTag && <span className="chip chip-neutral"><span className="dot" />{gradeTag}</span>}
    </span>
  );
}

// Cross-institution student dashboard — two tabs, "My Info" (identity + a
// request-a-correction flow routed to the superadmin, since a student can't
// edit their own roster record directly — see
// ensureProfileChangeRequestsSchema's own comment on the backend for why)
// opens first, since that's the more static/glanceable of the two; from
// there a student clicks through to Performance (every institution this
// student is enrolled in, see GET /api/me/performance, with a per-org
// assignment/exam rollup — click through to one org's own breakdown via
// GET /api/me/performance/:organizationId).
export default function MyPerformance() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [tab, setTab] = useState('info');

  const [organizations, setOrganizations] = useState(null);
  const [error, setError] = useState('');
  const [selectedOrgId, setSelectedOrgId] = useState(null);

  useEffect(() => {
    axios.get(`${API}/api/me/performance`, { withCredentials: true })
      .then((res) => setOrganizations(res.data.organizations))
      .catch(() => setError('Failed to load your performance.'));
  }, []);

  return (
    <div className="sb-shell">
      <LogoutFab />
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="performance" />
          <SpaceNotifications />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <h1 className="problems-title">My dashboard</h1>
          <div className="segmented" role="tablist" aria-label="My dashboard section">
            <button type="button" role="tab" aria-pressed={tab === 'info'} className={tab === 'info' ? 'active' : ''} onClick={() => setTab('info')}>
              My Info
            </button>
            <button type="button" role="tab" aria-pressed={tab === 'performance'} className={tab === 'performance' ? 'active' : ''} onClick={() => setTab('performance')}>
              Performance
            </button>
          </div>
        </div>

        {tab === 'performance' ? (
          <>
            {error && <div className="alert" role="alert"><span className="alert-icon">!</span><span>{error}</span></div>}
            {!organizations && !error && <p className="sb-loading">Loading…</p>}
            {organizations && (
              selectedOrgId ? (
                <OrgDetail organizationId={selectedOrgId} onBack={() => setSelectedOrgId(null)} />
              ) : (
                <OrgOverview organizations={organizations} onSelect={setSelectedOrgId} />
              )
            )}
          </>
        ) : (
          <MyInfoPanel />
        )}
      </section>
    </div>
  );
}

// ============================================================================
// GRAPHS — hand-rolled (no charting library in this codebase), on the
// app's own theme tokens so they match light/dark automatically. Two
// building blocks: a vertical bar chart (per-question breakdown, and the
// overall per-item trend) and a single-value percentile gauge (a lone
// number reads better as a position-on-a-track than as a one-bar chart).
// ============================================================================

// bars: [{ label, value }], value in [0, maxValue] or null for "no data yet".
function BarChart({ bars, maxValue = 100, valueFormat = (v) => `${Math.round(v)}%` }) {
  if (bars.length === 0) return <p className="sb-loading">Nothing graded yet.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: 200, padding: '12px 4px 0', minWidth: bars.length * 52 }}>
        {bars.map((b, i) => (
          <div key={i} style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end', minWidth: 40 }}>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4, whiteSpace: 'nowrap' }}>
              {b.value != null ? valueFormat(b.value) : '—'}
            </span>
            <div
              style={{ width: '100%', maxWidth: 36, flex: 1, background: 'var(--surface-2)', borderRadius: 4, display: 'flex', alignItems: 'flex-end', overflow: 'hidden' }}
              title={`${b.label}: ${b.value != null ? valueFormat(b.value) : 'No data'}`}
            >
              <div style={{
                width: '100%',
                height: b.value != null ? `${Math.max(3, Math.min(100, (b.value / maxValue) * 100))}%` : '0%',
                background: 'var(--accent)',
                borderRadius: '4px 4px 0 0',
              }} />
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, textAlign: 'center', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.label}>
              {b.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PercentileGauge({ percentile, populationSize }) {
  if (percentile == null) {
    return <p className="sb-loading">Not enough peers yet to compute a percentile.</p>;
  }
  const pct = Math.round(percentile);
  return (
    <div style={{ padding: '16px 4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>0th</span>
        <span style={{ fontSize: 22, fontWeight: 700 }}>{pct}th percentile</span>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>100th</span>
      </div>
      <div style={{ position: 'relative', height: 10, background: 'var(--surface-2)', borderRadius: 999 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: 'var(--accent)', borderRadius: 999 }} />
        <div style={{ position: 'absolute', left: `${pct}%`, top: -4, transform: 'translateX(-50%)', width: 18, height: 18, borderRadius: '50%', background: 'var(--accent)', border: '3px solid var(--surface-2)' }} />
      </div>
      <p className="auth-sub" style={{ marginTop: 12, marginBottom: 0 }}>
        Stronger than {pct}% of {populationSize} {populationSize === 1 ? 'peer' : 'peers'}.
      </p>
    </div>
  );
}

const GRAPH_KIND = {
  assignment: { itemParam: 'problems', idKey: 'problemId', noun: 'assignment' },
  exam: { itemParam: 'exams', idKey: 'examId', noun: 'exam' },
};

// One graph space per item type — dropdown picks which assignment/exam,
// a second dropdown picks the factor (percentile vs per-question). Only
// items with an actual submission/attempt are selectable; percentile and
// per-question data both require the item to be closed and graded, which
// the two backend routes this calls report back as a 'pending' status for
// rather than an error.
function ItemGraph({ kind, items }) {
  const cfg = GRAPH_KIND[kind];
  const eligible = items.filter((it) => it.status !== 'not_submitted' && it.status !== 'not_attempted');
  const [itemId, setItemId] = useState(eligible[0]?.[cfg.idKey] ?? '');
  const [factor, setFactor] = useState('percentile');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!itemId) { setResult(null); return; }
    setResult(null);
    setError('');
    const url = factor === 'percentile'
      ? `${API}/api/${cfg.itemParam}/${itemId}/result`
      : `${API}/api/${cfg.itemParam}/${itemId}/questions`;
    axios.get(url, { withCredentials: true })
      .then((res) => setResult(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load this graph.'));
  }, [itemId, factor, cfg.itemParam]);

  if (eligible.length === 0) {
    return <p className="sb-loading">Submit or attempt a {cfg.noun} to see its graph here.</p>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <select value={itemId} onChange={(e) => { setItemId(Number(e.target.value) || e.target.value); setResult(null); }} style={{ maxWidth: 260 }}>
          {eligible.map((it) => <option key={it[cfg.idKey]} value={it[cfg.idKey]}>{it.title}</option>)}
        </select>
        <select value={factor} onChange={(e) => { setFactor(e.target.value); setResult(null); }}>
          <option value="percentile">Percentile</option>
          <option value="question">Per question</option>
        </select>
      </div>

      {error && <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>}
      {!error && !result && <p className="sb-loading">Loading…</p>}
      {!error && result && result.status === 'pending' && (
        <p className="sb-loading">
          {result.reason === 'deadline' ? "This isn't closed yet — check back after the deadline." : 'Still being graded — check back soon.'}
        </p>
      )}
      {!error && result && result.status === 'graded' && factor === 'percentile' && (
        <PercentileGauge percentile={result.percentile} populationSize={result.populationSize} />
      )}
      {!error && result && result.status === 'graded' && factor === 'question' && (
        result.mode === 'code' ? (
          <BarChart
            bars={[{ label: 'Test cases', value: result.totalCount > 0 ? (result.passedCount / result.totalCount) * 100 : null }]}
            valueFormat={() => `${result.passedCount}/${result.totalCount} passed`}
          />
        ) : Array.isArray(result.questions) ? (
          <BarChart
            bars={result.questions.map((q) => ({ label: q.label, value: q.earned != null ? (q.earned / q.max) * 100 : null }))}
            valueFormat={(v) => `${Math.round(v)}%`}
          />
        ) : (
          <p className="sb-loading">Loading…</p>
        )
      )}
    </div>
  );
}

// The aggregate counterpart to ItemGraph above — every graded item of this
// type as one bar each, factor dropdown picks whether the bar heights are
// percentile or raw score. Reuses the percent/percentile already loaded
// with the assignments/exams list (see GET /api/me/performance/
// :organizationId) rather than fetching anything extra.
function OverallGraph({ kind, items }) {
  const [factor, setFactor] = useState('percentile');
  const key = factor === 'percentile' ? 'percentile' : 'percent';
  const bars = items.filter((it) => it[key] != null).map((it) => ({ label: it.title, value: it[key] }));

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <select value={factor} onChange={(e) => setFactor(e.target.value)}>
          <option value="percentile">Percentile</option>
          <option value="score">Score</option>
        </select>
      </div>
      <BarChart bars={bars} />
    </div>
  );
}

function OrgOverview({ organizations, onSelect }) {
  if (organizations.length === 0) {
    return <p className="sb-loading">You aren't enrolled as a student in any institution yet.</p>;
  }

  return (
    <div className="panel" style={{ padding: 20 }}>
      <h3 style={{ margin: '0 0 4px' }}>Your institutions</h3>
      <p className="auth-sub" style={{ margin: '0 0 16px' }}>
        Every institution you're enrolled in, with your performance in each.
      </p>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Institution</th>
              <th>Assignments</th>
              <th>Exams</th>
            </tr>
          </thead>
          <tbody>
            {organizations.map((o) => (
              <tr key={o.organizationId} onClick={() => onSelect(o.organizationId)} style={{ cursor: 'pointer' }}>
                <td className="admin-cell-strong">{o.organizationName}</td>
                <td style={{ minWidth: 170 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <PercentBar percent={o.avgAssignmentPercent} />
                    <span style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                      {o.assignmentsSubmitted}/{o.assignmentsTotal}
                      {o.avgAssignmentPercent != null && ` · ${o.avgAssignmentPercent.toFixed(0)}%`}
                    </span>
                    <TagChips percentileTag={o.assignmentPercentileTag} gradeTag={o.assignmentGradeTag} />
                  </div>
                </td>
                <td style={{ minWidth: 170 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <PercentBar percent={o.avgExamPercent} />
                    <span style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                      {o.examsAttempted}/{o.examsTotal}
                      {o.avgExamPercent != null && ` · ${o.avgExamPercent.toFixed(0)}%`}
                    </span>
                    <TagChips percentileTag={o.examPercentileTag} gradeTag={o.examGradeTag} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OrgDetail({ organizationId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get(`${API}/api/me/performance/${organizationId}`, { withCredentials: true })
      .then((res) => setData(res.data))
      .catch(() => setError('Failed to load this institution\'s performance.'));
  }, [organizationId]);

  if (error) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!data) return <p className="sb-loading">Loading…</p>;

  return (
    <div>
      <div className="admin-toolbar" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn-ghost" onClick={onBack}>&larr; Back to institutions</button>
      </div>

      <div className="panel" style={{ padding: '24px', marginBottom: '24px' }}>
        <h2 style={{ margin: 0 }}>{data.organizationName}</h2>
        <div style={{ display: 'flex', gap: 24, marginTop: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200 }}>
            <div className="field-group-label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center' }}>
              Assignments
              <TagChips percentileTag={data.assignmentPercentileTag} gradeTag={data.assignmentGradeTag} />
            </div>
            <PercentBar percent={data.avgAssignmentPercent} />
            <p className="auth-sub" style={{ margin: '6px 0 0' }}>
              {data.avgAssignmentPercent != null ? `${data.avgAssignmentPercent.toFixed(1)}% average` : 'No graded assignments yet'}
            </p>
          </div>
          <div style={{ minWidth: 200 }}>
            <div className="field-group-label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center' }}>
              Exams
              <TagChips percentileTag={data.examPercentileTag} gradeTag={data.examGradeTag} />
            </div>
            <PercentBar percent={data.avgExamPercent} />
            <p className="auth-sub" style={{ margin: '6px 0 0' }}>
              {data.avgExamPercent != null ? `${data.avgExamPercent.toFixed(1)}% average` : 'No graded exams yet'}
            </p>
          </div>
        </div>
      </div>

      {data.historicalScores?.length > 0 && (
        <>
          <h3 style={{ marginBottom: 16 }}>Previous years (imported by your institution)</h3>
          <div className="admin-table-wrap" style={{ marginBottom: 24 }}>
            <table className="admin-table">
              <thead><tr><th>Year</th><th>Assignment score</th><th>Exam score</th><th>Notes</th></tr></thead>
              <tbody>
                {data.historicalScores.map((h) => (
                  <tr key={h.academicYear}>
                    <td className="admin-cell-strong">{h.academicYear}</td>
                    <td>{h.assignmentScorePercent != null ? `${h.assignmentScorePercent}%` : '—'}</td>
                    <td>{h.examScorePercent != null ? `${h.examScorePercent}%` : '—'}</td>
                    <td>{h.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 style={{ marginBottom: 16 }}>Assignments — overall</h3>
      <div className="panel" style={{ padding: 20, marginBottom: 24 }}>
        <OverallGraph kind="assignment" items={data.assignments} />
      </div>

      <h3 style={{ marginBottom: 16 }}>Assignments — per assignment</h3>
      <div className="panel" style={{ padding: 20, marginBottom: 24 }}>
        <ItemGraph kind="assignment" items={data.assignments} />
      </div>

      <h3 style={{ marginBottom: 16 }}>Assignments</h3>
      {data.assignments.length === 0 ? (
        <p className="sb-loading" style={{ marginBottom: 24 }}>No assignments here yet.</p>
      ) : (
        <div className="submission-history" style={{ marginBottom: 24 }}>
          {data.assignments.map((a) => (
            <div className="submission-card" key={a.problemId}>
              <div className="submission-card-head">
                <span>{a.title}{a.subjectName && <span className="auth-sub"> — {a.subjectName}</span>}</span>
                <span className={`chip ${PERF_STATUS_CLASS[a.status]}`}><span className="dot" />{PERF_STATUS_LABELS[a.status]}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <PercentBar percent={a.percent} />
                {a.percent != null && <span className="auth-sub">{a.percent.toFixed(1)}%</span>}
              </div>
              {a.remarks && <p className="auth-sub" style={{ margin: '8px 0 0' }}>Remarks: {a.remarks}</p>}
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginBottom: 16 }}>Exams — overall</h3>
      <div className="panel" style={{ padding: 20, marginBottom: 24 }}>
        <OverallGraph kind="exam" items={data.exams} />
      </div>

      <h3 style={{ marginBottom: 16 }}>Exams — per exam</h3>
      <div className="panel" style={{ padding: 20, marginBottom: 24 }}>
        <ItemGraph kind="exam" items={data.exams} />
      </div>

      <h3 style={{ marginBottom: 16 }}>Exams</h3>
      {data.exams.length === 0 ? (
        <p className="sb-loading">No exams here yet.</p>
      ) : (
        <div className="submission-history">
          {data.exams.map((e) => (
            <div className="submission-card" key={e.examId}>
              <div className="submission-card-head">
                <span>{e.title}{e.subjectName && <span className="auth-sub"> — {e.subjectName}</span>}</span>
                <span className={`chip ${PERF_STATUS_CLASS[e.status]}`}><span className="dot" />{PERF_STATUS_LABELS[e.status]}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <PercentBar percent={e.percent} />
                {e.percent != null && <span className="auth-sub">{e.percent.toFixed(1)}%</span>}
              </div>
              {e.remarks && <p className="auth-sub" style={{ margin: '8px 0 0' }}>Remarks: {e.remarks}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// FIELD_OPTIONS is a starting point, not a hard enum — 'other' lets a
// student flag anything not covered by the two backend can auto-apply
// (name, roll number); the backend just records those for an administrator to
// action, see POST /api/admin/profile-change-requests/:id/review.
const FIELD_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'roll_number', label: 'Roll number' },
  { value: 'email', label: 'Email' },
  { value: 'other', label: 'Something else' },
];

function MyInfoPanel() {
  const { user } = useAuth();
  const [organizations, setOrganizations] = useState(null);
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');

  const [cardOrgId, setCardOrgId] = useState(null);

  const [field, setField] = useState('name');
  const [customField, setCustomField] = useState('');
  const [currentValue, setCurrentValue] = useState('');
  const [requestedValue, setRequestedValue] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitResult, setSubmitResult] = useState('');

  const fetchAll = () => {
    Promise.all([
      axios.get(`${API}/api/me/organizations`, { withCredentials: true }),
      axios.get(`${API}/api/me/profile-change-requests`, { withCredentials: true }),
    ])
      .then(([orgsRes, reqRes]) => {
        setOrganizations(orgsRes.data.organizations);
        setRequests(reqRes.data.requests);
      })
      .catch(() => setError('Failed to load your info.'));
  };

  useEffect(fetchAll, []);

  const submitRequest = async (e) => {
    e.preventDefault();
    const resolvedField = field === 'other' ? customField.trim() : field;
    if (!resolvedField || !requestedValue.trim()) return;
    setSubmitting(true);
    setSubmitError('');
    setSubmitResult('');
    try {
      await axios.post(`${API}/api/me/profile-change-requests`, {
        field: resolvedField,
        currentValue: currentValue.trim() || null,
        requestedValue: requestedValue.trim(),
        reason: reason.trim() || null,
      }, { withCredentials: true });
      setSubmitResult('Request submitted — your institution administrator will review it.');
      setCustomField('');
      setCurrentValue('');
      setRequestedValue('');
      setReason('');
      fetchAll();
    } catch (err) {
      setSubmitError(err.response?.data?.error || 'Failed to submit request.');
    } finally {
      setSubmitting(false);
    }
  };

  if (error) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!organizations || !requests) return <p className="sb-loading">Loading…</p>;

  return (
    <div>
      <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 4px' }}>Your details</h3>
        <p className="auth-sub" style={{ margin: '0 0 16px' }}>{user?.name || user?.email}{user?.name && ` — ${user.email}`}</p>

        <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-dim)' }}>My photos</h4>
        <PhotoPicker />

        <h4 style={{ margin: '20px 0 8px', fontSize: 13, color: 'var(--text-dim)' }}>Your institutions</h4>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Institution</th><th>Role</th><th>Unit</th><th>Roll number</th><th /></tr></thead>
            <tbody>
              {organizations.map((o) => (
                <tr key={o.organization_id}>
                  <td className="admin-cell-strong">{o.organization_name}</td>
                  <td><span className="chip chip-neutral"><span className="dot" />{o.role}</span></td>
                  <td>{o.org_unit_id != null ? o.org_unit_id : '—'}</td>
                  <td>{o.roll_number || '—'}</td>
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
      </div>

      <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 4px' }}>Request a correction</h3>
        <p className="auth-sub" style={{ margin: '0 0 16px' }}>
          Spotted something wrong in your record? Send a request to your institution administrator to fix it —
          this isn't something you can edit yourself.
        </p>
        {submitError && <div className="alert" style={{ marginBottom: 12 }}><span className="alert-icon">!</span><span>{submitError}</span></div>}
        {submitResult && <div className="alert alert-success" style={{ marginBottom: 12 }}><span className="alert-icon">✓</span><span>{submitResult}</span></div>}
        <form onSubmit={submitRequest} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
          <div className="field">
            <label htmlFor="req-field">What needs fixing?</label>
            <select id="req-field" value={field} onChange={(e) => setField(e.target.value)}>
              {FIELD_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          {field === 'other' && (
            <div className="field">
              <label htmlFor="req-custom-field">Field name</label>
              <input id="req-custom-field" value={customField} onChange={(e) => setCustomField(e.target.value)} placeholder="e.g. Department" required />
            </div>
          )}
          {field === 'email' && (
            <p className="auth-sub" style={{ margin: 0 }}>
              Your email is your login across every institution you're enrolled in, so this can't be auto-applied —
              an administrator will reach out to confirm the change before it's made.
            </p>
          )}
          <div className="field">
            <label htmlFor="req-current">Current value (optional)</label>
            <input id="req-current" value={currentValue} onChange={(e) => setCurrentValue(e.target.value)} placeholder="What it currently shows" />
          </div>
          <div className="field">
            <label htmlFor="req-requested">What it should be</label>
            <input id="req-requested" value={requestedValue} onChange={(e) => setRequestedValue(e.target.value)} placeholder="Correct value" required />
          </div>
          <div className="field">
            <label htmlFor="req-reason">Reason (optional)</label>
            <textarea id="req-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Any context that helps" />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={submitting} style={{ alignSelf: 'flex-start' }}>
            {submitting ? 'Submitting…' : 'Submit request'}
          </button>
        </form>
      </div>

      <div className="panel" style={{ padding: 20 }}>
        <h3 style={{ margin: '0 0 4px' }}>Your requests</h3>
        {requests.length === 0 ? (
          <p className="sb-loading">You haven't submitted any correction requests.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Institution</th><th>Field</th><th>Requested value</th><th>Status</th><th>Note</th></tr></thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td>{r.organization_name}</td>
                    <td className="admin-cell-strong">{r.field}</td>
                    <td>{r.requested_value}</td>
                    <td><span className={`chip ${REQUEST_STATUS_CLASS[r.status]}`}><span className="dot" />{REQUEST_STATUS_LABELS[r.status]}</span></td>
                    <td>{r.review_note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {cardOrgId && (
        <IdCard organizations={organizations} initialOrganizationId={cardOrgId} onClose={() => setCardOrgId(null)} />
      )}
    </div>
  );
}
