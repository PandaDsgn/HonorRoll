import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API } from '../config';
import { useAuth } from '../context/AuthContext';

const DEMO_ROLES = ['student', 'teacher', 'admin'];

// Rendered as a normal-flow element BEFORE <Routes> at the router root (see
// App.jsx) — not position:fixed. That's deliberate: a fixed banner overlays
// instead of pushing content down, and every page in this app has its own
// header built assuming it starts at the very top of the viewport (several
// use min-height:100vh), so a fixed overlay covered them. Being a normal
// flow sibling means the very next element (whichever page is routed)
// simply renders below it, guaranteed, without needing to reserve matching
// space anywhere else — position:sticky (see index.css) keeps it pinned to
// the top through scroll without taking it out of flow. Survives every
// route change since it's mounted once at the router root, same as the
// org's own 30-minute lifetime on the backend (POST /api/demo/start,
// backend/lib/demo.js). The countdown here is purely a UI courtesy; the
// actual expiry is enforced server-side (the JWT itself expires with the
// org), so a stale/frozen tab can't extend a demo past its real deadline.
export default function DemoBanner() {
  const { user, login, logout } = useAuth();
  const navigate = useNavigate();
  // A ticking clock, not a ticking countdown — secondsLeft itself is
  // derived straight from (expiresAt, now) on every render below, so
  // this effect only ever calls setState from inside the interval's own
  // callback, never synchronously from the effect body.
  const [now, setNow] = useState(() => Date.now());
  const [switching, setSwitching] = useState(false);

  const expiresAt = user?.is_demo ? user.demo_expires_at : null;

  // Switches which of the SAME demo org's 3 seeded identities the browser
  // is signed in as (see POST /api/demo/switch-role) — not a new demo, the
  // same one, same clock, same data, so whatever the previous role changed
  // (a teacher posting an assignment, say) is immediately visible after
  // switching to student.
  const handleRoleSwitch = async (e) => {
    const role = e.target.value;
    if (role === user.role) return;
    setSwitching(true);
    try {
      const res = await axios.post(`${API}/api/demo/switch-role`, { role });
      login(res.data.token, res.data.user);
      navigate(role === 'student' ? '/assignments' : '/admin', { replace: true });
    } catch {
      // Best-effort — the role select just snaps back to the current role
      // on the next render since nothing changed in `user`.
    } finally {
      setSwitching(false);
    }
  };

  useEffect(() => {
    if (!expiresAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const secondsLeft = expiresAt ? Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000)) : null;

  useEffect(() => {
    if (secondsLeft === 0) {
      logout();
      navigate('/', { replace: true });
    }
  }, [secondsLeft, logout, navigate]);

  if (secondsLeft === null) return null;

  const minutes = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const seconds = String(secondsLeft % 60).padStart(2, '0');

  return (
    <div className="demo-banner" role="status">
      <span>Demo session, resets in {minutes}:{seconds}</span>
      <label className="demo-banner-role">
        Viewing as
        <select value={user.role} onChange={handleRoleSwitch} disabled={switching} aria-label="Switch demo role">
          {DEMO_ROLES.map((r) => (
            <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="demo-banner-exit"
        onClick={() => { logout(); navigate('/', { replace: true }); }}
      >
        Exit demo
      </button>
    </div>
  );
}
