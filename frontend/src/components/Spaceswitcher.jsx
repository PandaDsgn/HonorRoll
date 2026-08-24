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

  // One single priority order, filtered per role rather than reordered per
  // role — every role sees a subsequence of this exact same list, so the
  // relative hierarchy (whatever a role does see, it sees in this order)
  // never drifts between roles: Dashboard (home base) > Notices
  // (time-sensitive announcements) > Assignments/Exams (actionable, has a
  // deadline) > Notes (reference material, no deadline) > IDE (a free
  // scratch space, the least "important" item here since nothing about it
  // is graded or due).
  const spaces = [
    ...(role === 'student' ? [{ id: 'performance', label: 'Dashboard', path: '/performance' }] : []),
    ...(role === 'admin' || role === 'teacher' ? [{ id: 'admin', label: 'Dashboard', path: '/admin' }] : []),
    ...(role === 'student' || role === 'teacher' ? [{ id: 'notices', label: 'Notices', path: '/notices' }] : []),
    // A teacher/admin creates/grades assignments and exams from their own
    // admin dashboard tabs (see AssignmentsPanel/ExamsPanel there) — they
    // never attempt one themselves the way a student does, so these
    // student-facing attempt-flow links (and the free-form IDE) are
    // student-only, same as Notes below.
    ...(role === 'student' ? [{ id: 'assignments', label: 'Assignments', path: '/assignments' }] : []),
    ...(role === 'student' ? [{ id: 'exams', label: 'Exams', path: '/exams' }] : []),
    ...(role === 'student' ? [{ id: 'notes', label: 'Notes', path: '/notes' }] : []),
    ...(role === 'student' ? [{ id: 'ide', label: 'IDE', path: '/ide' }] : []),
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
          className="icon-btn"
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
    </Fragment>
  );
}

// Split out from SpaceSwitcher itself so pages can position it independently
// in their own .sb-actions row without duplicating the student/teacher role
// check in every page — this is the one place that check lives. (Used to
// sit right after a top-bar Log out button; that button now lives only as
// LogoutFab on each role's Dashboard page, but this component's own
// position in .sb-actions was left as-is rather than relocated for no
// reason.)
export function SpaceNotifications() {
  const { role } = useAuth();
  return (role === 'student' || role === 'teacher') ? <NotificationBell /> : null;
}
