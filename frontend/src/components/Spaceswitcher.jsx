import { Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';

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

  const spaces = [
    ...(role === 'student' ? [{ id: 'performance', label: 'Dashboard', path: '/performance' }] : []),
    ...(role === 'student' ? [{ id: 'notes', label: 'Notes', path: '/notes' }] : []),
    ...(role === 'admin' || role === 'teacher' ? [{ id: 'admin', label: 'Dashboard', path: '/admin' }] : []),
    // A teacher creates/grades assignments and exams from their own admin
    // dashboard tabs (see AssignmentsPanel/ExamsPanel there) — they never
    // attempt one themselves the way a student does, so these two links
    // (which point at the student-facing attempt flow) are student/admin
    // only. Admin keeps both to preview what a student sees.
    ...(role !== 'teacher' ? [{ id: 'assignments', label: 'Assignments', path: '/assignments' }] : []),
    ...(role !== 'teacher' ? [{ id: 'exams', label: 'Exams', path: '/exams' }] : []),
    { id: 'ide', label: 'IDE', path: '/ide' },
    ...(role === 'student' || role === 'teacher' ? [{ id: 'notices', label: 'Notices', path: '/notices' }] : []),
  ];

  return (
    <Fragment>
      <div className="segmented" role="tablist" aria-label="Space">
        {spaces.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-pressed={activeTab === s.id}
            className={activeTab === s.id ? 'active' : ''}
            onClick={() => navigate(s.path)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {(role === 'student' || role === 'teacher') && <NotificationBell />}
    </Fragment>
  );
}
