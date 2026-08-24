import { Fragment, useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

// One "Dashboard" entry, same label and same leading position, regardless
// of which role is looking at it — the page it points to differs (a
// student's own /performance vs. an admin/teacher's shared /admin), but
// the button itself shouldn't read differently depending on who's signed
// in. Previously gated on isAdmin (role === 'admin' only), which meant a
// teacher — who legitimately lands on /admin too, see AdminDashboard's own
// role-scoped view — had no way back to it from anywhere else in the app
// once they navigated off it.
export default function SpaceSwitcher({ activeTab }) {
  const navigate = useNavigate();
  const { role } = useAuth();
  // Narrow viewports get a hamburger + dropdown instead of the full button
  // row (up to 6 buttons for a student) — same items, same navigate() call,
  // just collapsed. Both the row and the toggle/dropdown are always in the
  // DOM; a media query picks which one is visible, so there's no layout
  // flash from a JS-computed width check on mount.
  const [mobileOpen, setMobileOpen] = useState(false);
  const containerRef = useRef(null);

  const spaces = [
    ...(role === 'student' ? [{ id: 'performance', label: 'Dashboard', path: '/performance' }] : []),
    ...(role === 'student' ? [{ id: 'notes', label: 'Notes', path: '/notes' }] : []),
    ...(role === 'admin' || role === 'teacher' ? [{ id: 'admin', label: 'Dashboard', path: '/admin' }] : []),
    // A teacher/admin creates/grades assignments and exams from their own
    // admin dashboard tabs (see AssignmentsPanel/ExamsPanel there) — they
    // never attempt one themselves the way a student does, so these
    // student-facing attempt-flow links (and the free-form IDE) are
    // student-only, same as Notes below.
    ...(role === 'student' ? [{ id: 'assignments', label: 'Assignments', path: '/assignments' }] : []),
    ...(role === 'student' ? [{ id: 'exams', label: 'Exams', path: '/exams' }] : []),
    ...(role === 'student' ? [{ id: 'ide', label: 'IDE', path: '/ide' }] : []),
    ...(role === 'student' || role === 'teacher' ? [{ id: 'notices', label: 'Notices', path: '/notices' }] : []),
  ];

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setMobileOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [mobileOpen]);

  const go = (path) => {
    setMobileOpen(false);
    navigate(path);
  };

  return (
    <Fragment>
      <div className="segmented space-nav-row" role="tablist" aria-label="Space">
        {spaces.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-pressed={activeTab === s.id}
            className={activeTab === s.id ? 'active' : ''}
            onClick={() => go(s.path)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="space-nav-mobile" ref={containerRef}>
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Menu"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
        >
          <MenuIcon />
        </button>
        {mobileOpen && (
          <div className="panel segmented space-nav-drawer space-nav-drawer-center" role="tablist" aria-label="Space">
            {spaces.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-pressed={activeTab === s.id}
                className={activeTab === s.id ? 'active' : ''}
                onClick={() => go(s.path)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {(role === 'student' || role === 'teacher') && <NotificationBell />}
    </Fragment>
  );
}
