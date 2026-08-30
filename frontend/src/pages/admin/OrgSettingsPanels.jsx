import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import ImageCropper from '../../components/ImageCropper';
import { API } from '../../config';

// ============================================================================
// INTEGRATIONS — surfaces this org's Google Form webhook URL, since the
// webhook is now per-org (a random secret in the path, not the old shared
// unauthenticated endpoint) and an admin has no other way to find their
// own URL to paste into their Google Form's Apps Script trigger.
// ============================================================================
export function IntegrationsPanel() {
  const [org, setOrg] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    axios.get(`${API}/api/admin/organization`, { withCredentials: true })
      .then((res) => setOrg(res.data))
      .catch(() => {});
  }, []);

  if (!org) return null;

  const webhookUrl = `${API}/api/webhook/google-form/${org.webhookSecret}`;

  const copyUrl = () => {
    navigator.clipboard?.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
      <h3 style={{ margin: '0 0 4px' }}>Integrations</h3>
      <p className="auth-sub" style={{ margin: '0 0 10px' }}>
        Point your Google Form's submit trigger at this URL to auto-create student accounts in {org.name}.
      </p>
      <div className="testcase-row">
        <input value={webhookUrl} readOnly style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px', textOverflow: 'ellipsis', overflow: 'hidden', minWidth: 0, width: '100%' }} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={copyUrl}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

// ============================================================================
// INSTITUTION — lets an admin upload/replace their org's logo, shown on
// every ID card issued under it (see IdCard.jsx and GET /api/me/id-card).
// Same shape as IntegrationsPanel above (fetch GET /api/admin/organization
// on mount, one focused control), lives under its own "Institution" tab
// rather than folded into Grading's org-wide-policy panels since a logo
// isn't a grading/plagiarism policy — it's branding.
// ============================================================================
export function OrgLogoPanel() {
  const [org, setOrg] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [cropFile, setCropFile] = useState(null);
  const fileInputRef = useRef(null);

  const fetchOrg = () => {
    axios.get(`${API}/api/admin/organization`, { withCredentials: true })
      .then((res) => setOrg(res.data))
      .catch(() => {});
  };

  useEffect(fetchOrg, []);

  // Picking a file only opens the cropper (square, PNG output so a
  // transparent-background logo stays transparent instead of getting
  // flattened the way the JPEG profile-photo crop is) — the actual upload
  // happens once the admin confirms a crop, same two-step flow PhotoPicker
  // already uses for profile photos.
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCropFile(file);
  };

  const handleCropConfirm = async (blob) => {
    setCropFile(null);
    setUploading(true);
    setError('');
    const formData = new FormData();
    formData.append('logo', blob, 'logo.png');
    try {
      await axios.post(`${API}/api/admin/organization/logo`, formData, { withCredentials: true });
      fetchOrg();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to upload logo.');
    } finally {
      setUploading(false);
    }
  };

  if (!org) return null;

  return (
    <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
      <h3 style={{ margin: '0 0 4px' }}>Institution logo</h3>
      <p className="auth-sub" style={{ margin: '0 0 14px' }}>
        Shown on every ID card issued under {org.name} (each member's own Profile page).
      </p>
      {error && <div className="alert" style={{ marginBottom: 10 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {cropFile && (
        <div className="cropper-overlay" role="dialog" aria-modal="true">
          <ImageCropper
            file={cropFile}
            onCancel={() => setCropFile(null)}
            onConfirm={handleCropConfirm}
            mimeType="image/png"
            quality={1}
            confirmLabel="Use this logo"
          />
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div
          style={{
            width: 72, height: 72, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-strong)',
            background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden', flexShrink: 0,
          }}
        >
          {org.logoUrl ? (
            <img src={org.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>No logo</span>
          )}
        </div>
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : org.logoUrl ? 'Replace logo' : 'Upload logo'}
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// TAG VISIBILITY — global on/off switches for which of the two tags
// students ever see of their own results (exams AND assignments). Teachers
// always see both regardless of this setting; it only gates the two
// student-facing /result routes.
// ============================================================================
export function TagVisibilityPanel() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/admin/tag-visibility`, { withCredentials: true });
      setSettings(res.data);
    } catch {
      setError('Failed to load tag visibility settings.');
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const toggle = async (key) => {
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next); // optimistic
    setSaving(true);
    setError('');
    try {
      const res = await axios.put(`${API}/api/admin/tag-visibility`, next, { withCredentials: true });
      setSettings(res.data);
    } catch {
      setError('Failed to save — reverted.');
      fetchSettings();
    } finally {
      setSaving(false);
    }
  };

  if (!settings && !error) return <p className="sb-loading">Loading tag visibility…</p>;

  return (
    <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
      <h3 style={{ margin: '0 0 4px' }}>Student tag visibility</h3>
      <p className="auth-sub" style={{ margin: '0 0 14px' }}>
        Which tags students see of their own exam/assignment results, once available (deadline passed, and — for exams — fully graded).
      </p>
      {error && <div className="alert" style={{ marginBottom: '12px' }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {settings && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label className="testcase-hidden-toggle" style={{ fontSize: '13px' }}>
            <input type="checkbox" checked={settings.showPercentileTag} disabled={saving} onChange={() => toggle('showPercentileTag')} />
            Percentile tag (Very Strong / Strong / Average / Weak / Very Weak)
          </label>
          <label className="testcase-hidden-toggle" style={{ fontSize: '13px' }}>
            <input type="checkbox" checked={settings.showGradeTag} disabled={saving} onChange={() => toggle('showGradeTag')} />
            Individual score tag (Excellent / Pass / etc., from the grade scale below)
          </label>
        </div>
      )}
    </div>
  );
}

// Per-org cutoff the text-plagiarism comparator (deadline sweep, see
// backend/index.js) uses to decide which submission pairs get flagged for
// teacher review — a Jaccard-similarity score from 0 (nothing alike) to 1
// (identical). Deliberately admin-only, same as grade bands / tag
// visibility above: it's an org-wide policy call, not a per-assignment one.
export function ScanPlagiarismThresholdPanel() {
  const [threshold, setThreshold] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    axios.get(`${API}/api/admin/settings/scan-plagiarism-threshold`, { withCredentials: true })
      .then((res) => setThreshold(res.data.threshold))
      .catch(() => setError('Failed to load the plagiarism threshold.'));
  }, []);

  const save = async () => {
    setSaving(true);
    setSaveMessage('');
    setError('');
    try {
      await axios.put(`${API}/api/admin/settings/scan-plagiarism-threshold`, { threshold: Number(threshold) }, { withCredentials: true });
      setSaveMessage('Saved.');
    } catch {
      setError('Failed to save the threshold.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
      <h3 style={{ margin: '0 0 4px' }}>Scanned-assignment plagiarism threshold</h3>
      <p className="auth-sub" style={{ margin: '0 0 14px' }}>
        How similar two scanned answer sheets' recognized text has to be before they're flagged for your review (0 = never flags, 1 = only exact duplicates). Confirming a flag zeroes both submissions' marks until you re-grade them.
      </p>
      {error && <div className="alert" style={{ marginBottom: '12px' }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {threshold !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="number" min="0" max="1" step="0.05"
            style={{ maxWidth: 100 }}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saveMessage && <span className="auth-sub">{saveMessage}</span>}
        </div>
      )}
    </div>
  );
}

// Same shape as ScanPlagiarismThresholdPanel above, for coding assignments —
// separate column/route since code and prose similarity don't live on the
// same natural scale (code shares far more incidental boilerplate).
export function CodePlagiarismThresholdPanel() {
  const [threshold, setThreshold] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    axios.get(`${API}/api/admin/settings/code-plagiarism-threshold`, { withCredentials: true })
      .then((res) => setThreshold(res.data.threshold))
      .catch(() => setError('Failed to load the plagiarism threshold.'));
  }, []);

  const save = async () => {
    setSaving(true);
    setSaveMessage('');
    setError('');
    try {
      await axios.put(`${API}/api/admin/settings/code-plagiarism-threshold`, { threshold: Number(threshold) }, { withCredentials: true });
      setSaveMessage('Saved.');
    } catch {
      setError('Failed to save the threshold.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
      <h3 style={{ margin: '0 0 4px' }}>Coding-assignment plagiarism threshold</h3>
      <p className="auth-sub" style={{ margin: '0 0 14px' }}>
        How similar two students' Accepted solutions to the same assignment have to be before they're flagged for your review (0 = never flags, 1 = only exact duplicates). Review flags per-assignment from the Assignments tab — confirming a flag never changes either submission's score, it's just a record for you to act on.
      </p>
      {error && <div className="alert" style={{ marginBottom: '12px' }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {threshold !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="number" min="0" max="1" step="0.05"
            style={{ maxWidth: 100 }}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saveMessage && <span className="auth-sub">{saveMessage}</span>}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// GRADE SCALE — the global, admin-editable band scale behind each exam
// attempt's individual score tag (e.g. "90-100 -> Excellent"). Global, not
// per-exam: one shared scale every exam's grade tag is computed against.
// ============================================================================
export function GradeBandsPanel() {
  const [bands, setBands] = useState(null);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({}); // bandId -> { label, minPercent } in-progress edit
  const [newBand, setNewBand] = useState({ label: '', minPercent: '' });
  const [busyId, setBusyId] = useState(null);

  const fetchBands = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/admin/grade-bands`, { withCredentials: true });
      setBands(res.data.gradeBands);
    } catch {
      setError('Failed to load grade bands.');
    }
  }, []);

  useEffect(() => { fetchBands(); }, [fetchBands]);

  const draftFor = (b) => drafts[b.id] || { label: b.label, minPercent: String(b.min_percent) };
  const updateDraft = (id, patch) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...draftFor(bands.find((b) => b.id === id)), ...prev[id], ...patch } }));
  };

  const saveBand = async (id) => {
    setBusyId(id);
    setError('');
    try {
      const draft = draftFor(bands.find((b) => b.id === id));
      await axios.put(`${API}/api/admin/grade-bands/${id}`, {
        label: draft.label, minPercent: Number(draft.minPercent),
      }, { withCredentials: true });
      setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
      fetchBands();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save band.');
    } finally {
      setBusyId(null);
    }
  };

  const deleteBand = async (id) => {
    setBusyId(id);
    setError('');
    try {
      await axios.delete(`${API}/api/admin/grade-bands/${id}`, { withCredentials: true });
      fetchBands();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete band.');
    } finally {
      setBusyId(null);
    }
  };

  const addBand = async () => {
    setError('');
    try {
      await axios.post(`${API}/api/admin/grade-bands`, {
        label: newBand.label, minPercent: Number(newBand.minPercent),
      }, { withCredentials: true });
      setNewBand({ label: '', minPercent: '' });
      fetchBands();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add band.');
    }
  };

  if (!bands && !error) return <p className="sb-loading">Loading grade scale…</p>;

  return (
    <div>
      <p className="auth-sub" style={{ marginBottom: '16px' }}>
        A fully-graded exam attempt's percentage is matched against these bands (highest qualifying band wins)
        to produce its individual score tag. This scale is shared across every exam — teachers only, never shown to students.
      </p>

      {error && <div className="alert" style={{ marginBottom: '16px' }}><span className="alert-icon">!</span><span>{error}</span></div>}

      {bands && (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Minimum %</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => {
                const draft = draftFor(b);
                return (
                  <tr key={b.id}>
                    <td>
                      <input value={draft.label} onChange={(e) => updateDraft(b.id, { label: e.target.value })} />
                    </td>
                    <td>
                      <input type="number" min="0" max="100" style={{ maxWidth: '90px' }}
                        value={draft.minPercent} onChange={(e) => updateDraft(b.id, { minPercent: e.target.value })} />
                    </td>
                    <td className="admin-cell-actions">
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === b.id} onClick={() => saveBand(b.id)}>Save</button>
                      <button type="button" className="btn btn-danger btn-sm" disabled={busyId === b.id} onClick={() => deleteBand(b.id)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td><input placeholder="New band label" value={newBand.label} onChange={(e) => setNewBand((p) => ({ ...p, label: e.target.value }))} /></td>
                <td><input type="number" min="0" max="100" style={{ maxWidth: '90px' }} placeholder="0-100" value={newBand.minPercent} onChange={(e) => setNewBand((p) => ({ ...p, minPercent: e.target.value }))} /></td>
                <td className="admin-cell-actions">
                  <button type="button" className="btn btn-primary btn-sm" disabled={!newBand.label.trim() || newBand.minPercent === ''} onClick={addBand}>+ Add band</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
