import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API } from '../config';

// Where clicking a notification of a given type sends the student — the
// list pages, deliberately, not a specific item's detail route: an exam's
// detail route (ExamAttempt) starts the proctored attempt on load, so
// jumping straight there from a notification click would surprise-start an
// exam rather than just show the student what's new.
const NOTIFICATION_LINK_BY_TYPE = { assignment: '/assignments', exam: '/exams' };

function BellIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function timeAgo(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Student/teacher notification feed — a bell in the shared top bar
// (rendered alongside SpaceSwitcher, gated to those two roles there) with
// an unread-count badge, polled every 30s the same way Problems.jsx/
// Exams.jsx poll their own countdowns. Opening the dropdown marks
// everything currently unread as read in one call (POST
// /api/notifications/mark-read) rather than tracking each item's read
// state individually — matches how most notification bells behave (badge
// clears on open, not on a per-item basis).
export default function NotificationBell() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/notifications`, { withCredentials: true });
      setNotifications(res.data.notifications);
    } catch {
      // Silent — a failed poll just tries again next interval; no error UI
      // for a non-critical background feed.
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const toggleOpen = async () => {
    const opening = !open;
    setOpen(opening);
    if (opening && unreadCount > 0) {
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      try {
        await axios.post(`${API}/api/notifications/mark-read`, {}, { withCredentials: true });
      } catch {
        // Best-effort — worst case the badge reappears on the next poll.
      }
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn btn-ghost"
        aria-label="Notifications"
        aria-expanded={open}
        onClick={toggleOpen}
        style={{ position: 'relative' }}
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute', top: 2, right: 2, minWidth: 15, height: 15, padding: '0 3px',
              borderRadius: 999, background: 'var(--danger, #e5484d)', color: '#fff',
              fontSize: 10, fontWeight: 700, lineHeight: '15px', textAlign: 'center',
            }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="panel"
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 320, maxHeight: 380,
            overflowY: 'auto', zIndex: 50, padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          }}
        >
          {notifications.length === 0 ? (
            <p className="sb-loading" style={{ margin: '12px 8px' }}>No notifications yet.</p>
          ) : (
            notifications.map((n) => {
              const linkTo = NOTIFICATION_LINK_BY_TYPE[n.type];
              return (
                <div
                  key={n.id}
                  role={linkTo ? 'button' : undefined}
                  tabIndex={linkTo ? 0 : undefined}
                  onClick={linkTo ? () => { setOpen(false); navigate(linkTo); } : undefined}
                  style={{
                    padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                    background: n.read ? 'transparent' : 'var(--surface-2)',
                    cursor: linkTo ? 'pointer' : 'default',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-h)' }}>{n.title}</div>
                  {n.body && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>{n.body}</div>}
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{timeAgo(n.createdAt)}</div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
