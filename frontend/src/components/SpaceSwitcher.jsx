import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { API } from '../config';
import { on } from '../lib/realtime';
import { chatLinkFor } from '../lib/chatLink';
import NotificationBell from './NotificationBell';

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

// A standing shortcut straight to Chat, with its own unread badge — reuses
// the exact same `type: 'chat'` notifications this app already creates on
// every new message (see routes/chat.js's createNotification call) rather
// than inventing a second unread-count source of truth. Its own small poll/
// push loop, same shape as NotificationBell's, since unread COUNT (not the
// notification list itself) is this component's only state — sharing
// NotificationBell's internal state isn't worth the coupling for that.
function ChatShortcut() {
  const navigate = useNavigate();
  const { role } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  const fetchUnread = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/notifications`, { withCredentials: true });
      setUnreadCount(res.data.notifications.filter((n) => n.type === 'chat' && !n.read).length);
    } catch {
      // Silent — same "just try again next interval" posture as NotificationBell's own poll.
    }
  }, []);

  useEffect(() => {
    fetchUnread();
    const interval = setInterval(fetchUnread, 120000);
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') fetchUnread(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const offNotification = on('notification', fetchUnread);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      offNotification();
    };
  }, [fetchUnread]);

  const link = chatLinkFor(role);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label="Chat"
      onClick={() => navigate(link.path, link.state ? { state: link.state } : undefined)}
      style={{ position: 'relative' }}
    >
      <SendIcon />
      {unreadCount > 0 && (
        <span
          style={{
            position: 'absolute', top: 2, right: 2, minWidth: 15, height: 15, padding: '0 3px',
            borderRadius: 999, background: 'var(--amber)', color: '#1a1006',
            fontSize: 10, fontWeight: 700, lineHeight: '15px', textAlign: 'center',
          }}
        >
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
    </button>
  );
}

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
  // row (up to 5 buttons for a student now, plus the More dropdown below) —
  // same items, same navigate() call, just collapsed. Both the row and the
  // toggle/dropdown are always in the DOM; a media query picks which one is
  // visible, so there's no layout flash from a JS-computed width check on
  // mount.
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const containerRef = useRef(null);
  const moreRef = useRef(null);

  // One single priority order, filtered per role rather than reordered per
  // role — every role sees a subsequence of this exact same list, so the
  // relative hierarchy (whatever a role does see, it sees in this order)
  // never drifts between roles: Dashboard (home base) > Notices
  // (time-sensitive announcements) > Assignments/Exams (actionable, has a
  // deadline).
  const spaces = [
    ...(role === 'student' ? [{ id: 'performance', label: 'Dashboard', path: '/performance' }] : []),
    ...(role === 'admin' || role === 'teacher' ? [{ id: 'admin', label: 'Dashboard', path: '/admin' }] : []),
    ...(role === 'student' || role === 'teacher' ? [{ id: 'notices', label: 'Notices', path: '/notices' }] : []),
    // A teacher/admin creates/grades assignments and exams from their own
    // admin dashboard tabs (see AssignmentsPanel/ExamsPanel there) — they
    // never attempt one themselves the way a student does, so these
    // student-facing attempt-flow links are student-only, same as
    // moreSpaces below.
    ...(role === 'student' ? [{ id: 'assignments', label: 'Assignments', path: '/assignments' }] : []),
    ...(role === 'student' ? [{ id: 'exams', label: 'Exams', path: '/exams' }] : []),
    // Admin/teacher only now — a student's own photo library, institutions,
    // and ID cards live under their Dashboard's My Info tab instead (see
    // MyPerformance.jsx's MyInfoPanel).
    ...(role === 'admin' || role === 'teacher' ? [{ id: 'profile', label: 'Profile', path: '/profile' }] : []),
  ];

  // Reference material and scratch tools — nothing here has a deadline the
  // way Assignments/Exams do, so it's the lowest-priority tier and gets
  // folded behind one "More" button instead of each taking its own slot in
  // the row: Notes (reference material) > Doubts (ask, not time-sensitive
  // once posted) > IDE (a free scratch space). Student-only today since
  // that's the only role with enough items to need folding at all. Chat
  // used to live here too — it's now its own standing icon beside the
  // notification bell (see ChatShortcut below), not buried a dropdown
  // click deep, since unlike Notes/Doubts/IDE it can have something
  // genuinely time-sensitive waiting (a new message).
  const moreSpaces = role === 'student' ? [
    { id: 'notes', label: 'Notes', path: '/notes' },
    { id: 'doubts', label: 'Doubts', path: '/doubts' },
    { id: 'ide', label: 'IDE', path: '/ide' },
  ] : [];
  const moreActive = moreSpaces.some((s) => s.id === activeTab);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setMobileOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [mobileOpen]);

  useEffect(() => {
    if (!moreOpen) return undefined;
    const onClickOutside = (e) => {
      if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [moreOpen]);

  const go = (path) => {
    setMobileOpen(false);
    setMoreOpen(false);
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
        {moreSpaces.length > 0 && (
          <div style={{ position: 'relative' }} ref={moreRef}>
            <button
              type="button"
              role="tab"
              aria-haspopup="true"
              aria-expanded={moreOpen}
              aria-pressed={moreActive}
              className={moreActive ? 'active' : ''}
              onClick={() => setMoreOpen((v) => !v)}
            >
              More
            </button>
            {moreOpen && (
              <div className="panel segmented space-nav-drawer" role="tablist" aria-label="More">
                {moreSpaces.map((s) => (
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
        )}
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
            {[...spaces, ...moreSpaces].map((s) => (
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
  return (role === 'student' || role === 'teacher') ? (
    <>
      <ChatShortcut />
      <NotificationBell />
    </>
  ) : null;
}
