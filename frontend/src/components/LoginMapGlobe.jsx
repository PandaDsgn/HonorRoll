import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Globe from 'react-globe.gl';
import axios from 'axios';
import { API } from '../config';

// Same role palette as SuperadminDashboard's own ROLE_CLASS chips, just as
// hex (the globe's points render on a WebGL canvas, not through CSS
// classes) — kept visually consistent with the rest of that dashboard
// rather than picking an unrelated color scheme just for this panel.
const ROLE_COLORS = {
  student: '#3ba55d',
  teacher: '#f0a020',
  admin: '#e14848',
  superadmin: '#a970ff',
};
const INSTITUTION_COLOR = '#5aa9e6';

// GET /api/superadmin/login-map already decided, per person/institution,
// whether to show their "general" (usual) location or their "last" one —
// see that route's own comment for why (an unusual-location signal would
// otherwise be buried under everyone's ordinary day-to-day noise). This
// component's only job is turning that decision into points on a globe;
// isAnomaly just controls the pulsing-ring treatment below, it never
// re-decides which location to plot.
function toPoint(entry, { color, kind }) {
  const loc = entry.displayLocation;
  if (loc?.lat == null || loc?.lon == null) return null;
  const label = kind === 'institution'
    ? entry.organizationName
    : `${entry.name || entry.email}${entry.organizationName ? ` — ${entry.organizationName}` : ''}`;
  return {
    kind,
    lat: loc.lat,
    lng: loc.lon,
    color,
    isAnomaly: entry.isAnomaly,
    label,
    city: loc.city,
    country: loc.country,
    role: entry.role,
    entry,
  };
}

export default function LoginMapGlobe() {
  const globeRef = useRef();
  const containerRef = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [size, setSize] = useState({ width: 800, height: 480 });
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    axios.get(`${API}/api/superadmin/login-map`, { withCredentials: true })
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load login map.'));
  }, []);

  // react-globe.gl renders into a fixed-size canvas — it doesn't reflow
  // with its container on its own, so width has to be measured and kept
  // in sync with the panel's actual size (a `panel` here can be anywhere
  // from a phone width to a wide desktop dashboard).
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setSize({ width: containerRef.current.offsetWidth, height: 480 });
      }
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  const points = useMemo(() => {
    if (!data) return [];
    const institutionPoints = data.institutions.map((o) => toPoint(o, { color: INSTITUTION_COLOR, kind: 'institution' })).filter(Boolean);
    const peoplePoints = data.people.map((p) => toPoint(p, { color: ROLE_COLORS[p.role] || '#888', kind: 'person' })).filter(Boolean);
    return [...institutionPoints, ...peoplePoints];
  }, [data]);

  // Without this, the globe just opens on whatever default coordinate
  // react-globe.gl happens to center on — with only a handful of points
  // (or just one, e.g. right after this feature's own first login), the
  // odds the auto-rotate above has actually brought any of them into view
  // by the time someone glances at the panel are low. Centers on the
  // simple average of every point's lat/lng instead — not reprojected
  // through anything fancier, since "roughly where most of the data is"
  // is all this needs to be useful, and an exact centroid would be
  // overkill for what's ultimately just picking a reasonable starting
  // camera angle.
  useEffect(() => {
    if (!globeRef.current || points.length === 0) return;
    const avgLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
    const avgLng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
    globeRef.current.pointOfView({ lat: avgLat, lng: avgLng, altitude: 2 }, 1000);
  }, [points]);

  // Anomalies get their own ring layer (a pulsing halo react-globe.gl
  // animates on its own) rather than just a different point color — a
  // color alone would be one more hue to memorize in an already-4-color
  // legend; a ring reads immediately as "something about THIS one is
  // different" regardless of which role/color it belongs to.
  const anomalyRings = useMemo(
    () => points.filter((p) => p.isAnomaly).map((p) => ({ lat: p.lat, lng: p.lng, color: p.color })),
    [points]
  );

  const handlePointClick = useCallback((point) => setSelected(point), []);

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 4px' }}>Login Map</h3>
      <p className="auth-sub" style={{ margin: '0 0 12px' }}>
        Where every institution and person generally logs in from — a pulsing ring means their most recent login
        was somewhere unusual for them, and that last location is what's plotted instead of their usual one.
      </p>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12, fontSize: 12.5 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: INSTITUTION_COLOR, display: 'inline-block' }} />Institution</span>
        {Object.entries(ROLE_COLORS).map(([role, color]) => (
          <span key={role} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
            {role}
          </span>
        ))}
      </div>

      {error && <div className="alert" style={{ marginBottom: 12 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {!error && data && points.length === 0 && (
        <p className="sb-loading" style={{ marginBottom: 12 }}>No geolocated logins yet — the map fills in as people sign in.</p>
      )}

      {/* The globe itself renders unconditionally — it's the map, not a
          per-login visual, so it has no reason to wait for data (or for
          the fetch above to even finish) before showing up. pointsData/
          ringsData are simply empty arrays until login-map data arrives,
          same globe either way. */}
      <div ref={containerRef} style={{ width: '100%' }}>
        <Globe
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor="rgba(0,0,0,0)"
          globeImageUrl="//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
          bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
          pointsData={points}
          pointColor="color"
          pointAltitude={0.012}
          pointRadius={0.35}
          pointLabel="label"
          onPointClick={handlePointClick}
          ringsData={anomalyRings}
          ringColor={() => (t) => `rgba(255, 90, 90, ${1 - t})`}
          ringMaxRadius={2.2}
          ringPropagationSpeed={1.5}
          ringRepeatPeriod={1400}
        />
      </div>

      {selected && (
        <div className="panel" style={{ padding: 14, marginTop: 12, background: 'var(--surface-2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div>
              <strong>{selected.kind === 'institution' ? selected.entry.organizationName : (selected.entry.name || selected.entry.email)}</strong>
              {selected.kind === 'person' && <span className={`chip chip-neutral`} style={{ marginLeft: 8 }}><span className="dot" />{selected.role}</span>}
              <p className="auth-sub" style={{ margin: '6px 0 0' }}>
                {selected.isAnomaly ? 'Last login (unusual for them): ' : 'Generally logs in from: '}
                {selected.city}, {selected.country}
              </p>
              {selected.isAnomaly && (
                <p className="auth-sub" style={{ margin: '4px 0 0' }}>
                  Usually: {selected.entry.generalLocation.city}, {selected.entry.generalLocation.country}
                </p>
              )}
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
