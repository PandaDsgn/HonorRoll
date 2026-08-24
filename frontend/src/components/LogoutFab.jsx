import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

function DoorExitIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

// The only place to log out now — deliberately not in every page's top bar
// anymore, so there's exactly one place a user goes looking for it: their
// own role's Dashboard (/admin, /performance, or the superadmin's own
// dashboard), not a button buried in a crowded top-bar row on every page.
export default function LogoutFab() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [confirming, setConfirming] = useState(false);

  const handleLogout = async () => {
    setConfirming(false);
    await logout();
    navigate('/', { replace: true });
  };

  return (
    <>
      <button type="button" className="logout-fab" onClick={() => setConfirming(true)} aria-label="Log out" title="Log out">
        <DoorExitIcon />
      </button>

      {confirming && (
        <div className="logout-confirm-backdrop" onClick={() => setConfirming(false)}>
          <div className="logout-confirm-card" onClick={(e) => e.stopPropagation()}>
            <div className="logout-confirm-icon"><DoorExitIcon /></div>
            <h3>Log out?</h3>
            <p>You'll need to sign in again to get back to your workspace.</p>
            <div className="logout-confirm-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="btn btn-sm logout-confirm-btn" onClick={handleLogout}>Log out</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
