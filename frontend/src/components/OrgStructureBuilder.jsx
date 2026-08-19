import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { API } from '../config';

// Interactive "block adder" for an institution's own hierarchy — campuses,
// departments, years, sections, whatever tiers make sense for them, at
// whatever depth (a big college might need 7-8 tiers, a small tuition
// center just 2). Two-layer model, matching the backend: `levels` is the
// ordered *shape* (GET /api/admin/org-levels), `units` is the flat list of
// actual tree nodes built against that shape (GET /api/admin/org-units) —
// the tree itself is built client-side via a simple parent -> children map,
// since there's no tree library anywhere in this frontend and the realistic
// scale here (hundreds of nodes, ~8 tiers deep) doesn't need one.
export default function OrgStructureBuilder() {
  const [levels, setLevels] = useState(null);
  const [units, setUnits] = useState(null);
  const [error, setError] = useState('');
  const [newLevelLabel, setNewLevelLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/admin/org-units`, { withCredentials: true });
      setLevels(res.data.levels);
      setUnits(res.data.units);
    } catch {
      setError('Failed to load organization structure.');
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const childrenByParent = useMemo(() => {
    const map = new Map();
    (units || []).forEach((u) => {
      const key = u.parent_unit_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(u);
    });
    return map;
  }, [units]);

  const nextLevelForTier = useCallback(
    (tierIndex) => (levels || []).find((l) => l.tier_index === tierIndex + 1) || null,
    [levels]
  );

  const addLevel = async () => {
    const label = newLevelLabel.trim();
    if (!label) return;
    setError('');
    setBusy(true);
    try {
      await axios.post(`${API}/api/admin/org-levels`, { label }, { withCredentials: true });
      setNewLevelLabel('');
      await fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add level.');
    } finally {
      setBusy(false);
    }
  };

  const removeLevel = async (id) => {
    setError('');
    try {
      await axios.delete(`${API}/api/admin/org-levels/${id}`, { withCredentials: true });
      await fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove level.');
    }
  };

  const renameLevel = async (id, label) => {
    if (!label.trim()) return;
    setError('');
    try {
      await axios.put(`${API}/api/admin/org-levels/${id}`, { label: label.trim() }, { withCredentials: true });
      await fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to rename level.');
    }
  };

  const addUnit = async (levelDefId, parentUnitId, name) => {
    setError('');
    try {
      await axios.post(`${API}/api/admin/org-units`, { levelDefId, parentUnitId, name }, { withCredentials: true });
      await fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add unit.');
    }
  };

  const renameUnit = async (id, name) => {
    if (!name.trim()) return;
    setError('');
    try {
      await axios.put(`${API}/api/admin/org-units/${id}`, { name: name.trim() }, { withCredentials: true });
      await fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to rename unit.');
    }
  };

  const deleteUnit = async (id) => {
    setError('');
    try {
      await axios.delete(`${API}/api/admin/org-units/${id}`, { withCredentials: true });
      await fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove unit — it may still have child units or people assigned to it.');
    }
  };

  if (!levels && !error) return <p className="sb-loading">Loading organization structure…</p>;
  if (!levels) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;

  const locked = (units || []).length > 0;
  const deepestTier = levels.length > 0 ? Math.max(...levels.map((l) => l.tier_index)) : -1;
  const rootLevel = levels.find((l) => l.tier_index === 0) || null;
  const rootUnits = childrenByParent.get(null) || [];

  return (
    <div>
      <p className="auth-sub" style={{ marginBottom: 16 }}>
        Define your institution's structure from the top down. Once you start adding units below, the tiers
        themselves lock in place — design the shape first, then populate it.
      </p>

      {error && (
        <div className="alert" style={{ marginBottom: 16 }} role="alert">
          <span className="alert-icon">!</span><span>{error}</span>
        </div>
      )}

      <div className="panel" style={{ padding: 20, marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 12px' }}>Levels</h3>

        {levels.length === 0 && <p className="auth-sub" style={{ marginBottom: 12 }}>No levels yet — add your top tier first (e.g. "Campus" or "Department").</p>}

        <div className="exam-item-list">
          {levels.map((l) => (
            <div key={l.id} className="exam-item-card" style={{ flexDirection: 'row', alignItems: 'center' }}>
              <span className="exam-item-index" style={{ paddingBottom: 0 }}>Tier {l.tier_index + 1}</span>
              <input
                defaultValue={l.label}
                onBlur={(e) => { if (e.target.value.trim() !== l.label) renameLevel(l.id, e.target.value); }}
                style={{ flex: 1, marginLeft: 12, marginRight: 12 }}
              />
              {!locked && l.tier_index === deepestTier && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeLevel(l.id)}>Remove</button>
              )}
            </div>
          ))}
        </div>

        {!locked ? (
          <div className="testcase-row" style={{ marginTop: 12 }}>
            <input
              placeholder="e.g. Campus, Department, Year"
              value={newLevelLabel}
              onChange={(e) => setNewLevelLabel(e.target.value)}
            />
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !newLevelLabel.trim()} onClick={addLevel}>
              Add level
            </button>
          </div>
        ) : (
          <p className="auth-sub" style={{ marginTop: 12, marginBottom: 0 }}>Levels are locked because units already exist below.</p>
        )}
      </div>

      {rootLevel && (
        <div className="panel" style={{ padding: 20 }}>
          <h3 style={{ margin: '0 0 12px' }}>Units</h3>
          {rootUnits.map((u) => (
            <OrgUnitNode
              key={u.id}
              unit={u}
              depth={0}
              levels={levels}
              childrenByParent={childrenByParent}
              nextLevelForTier={nextLevelForTier}
              onAddUnit={addUnit}
              onRename={renameUnit}
              onDelete={deleteUnit}
            />
          ))}
          <AddUnitInline levelLabel={rootLevel.label} onAdd={(name) => addUnit(rootLevel.id, null, name)} />
        </div>
      )}
    </div>
  );
}

function AddUnitInline({ levelLabel, onAdd }) {
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        + Add {levelLabel}
      </button>
    );
  }
  return (
    <div className="testcase-row" style={{ marginBottom: 8, maxWidth: 420 }}>
      <input
        autoFocus
        placeholder={levelLabel}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onAdd(name.trim()); setName(''); setOpen(false); } }}
      />
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={!name.trim()}
        onClick={() => { onAdd(name.trim()); setName(''); setOpen(false); }}
      >
        Add
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); setName(''); }}>Cancel</button>
    </div>
  );
}

function OrgUnitNode({ unit, depth, levels, childrenByParent, nextLevelForTier, onAddUnit, onRename, onDelete }) {
  const level = levels.find((l) => l.id === unit.level_def_id);
  const children = childrenByParent.get(unit.id) || [];
  const nextLevel = level ? nextLevelForTier(level.tier_index) : null;

  return (
    <div style={{ marginLeft: depth * 22, marginBottom: 10 }}>
      <div className="exam-item-card" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <input
          defaultValue={unit.name}
          onBlur={(e) => { if (e.target.value.trim() !== unit.name) onRename(unit.id, e.target.value); }}
          style={{ flex: 1, fontWeight: 600 }}
        />
        {level && <span className="chip chip-easy"><span className="dot" />{level.label}</span>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDelete(unit.id)}>Remove</button>
      </div>

      <div style={{ marginTop: 8, marginLeft: 22 }}>
        {children.map((c) => (
          <OrgUnitNode
            key={c.id}
            unit={c}
            depth={depth + 1}
            levels={levels}
            childrenByParent={childrenByParent}
            nextLevelForTier={nextLevelForTier}
            onAddUnit={onAddUnit}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
        {nextLevel && (
          <AddUnitInline levelLabel={nextLevel.label} onAdd={(name) => onAddUnit(nextLevel.id, unit.id, name)} />
        )}
      </div>
    </div>
  );
}
