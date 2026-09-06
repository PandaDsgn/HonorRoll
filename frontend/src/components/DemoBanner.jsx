import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Fixed to the top of the viewport for the whole time a demo session is
// active — see App.jsx, mounted once at the router root next to
// AssistantWidget so it survives every route change, same as the org's
// own 30-minute lifetime on the backend (POST /api/demo/start, backend/
// lib/demo.js). The countdown here is purely a UI courtesy; the actual
// expiry is enforced server-side (the JWT itself expires with the org),
// so a stale/frozen tab can't extend a demo past its real deadline.
export default function DemoBanner() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  // A ticking clock, not a ticking countdown — secondsLeft itself is
  // derived straight from (expiresAt, now) on every render below, so
  // this effect only ever calls setState from inside the interval's own
  // callback, never synchronously from the effect body.
  const [now, setNow] = useState(() => Date.now());

  const expiresAt = user?.is_demo ? user.demo_expires_at : null;

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
