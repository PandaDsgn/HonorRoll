import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher, { SpaceNotifications } from '../components/SpaceSwitcher';
import LogoutFab from '../components/LogoutFab';
import OrgStructureBuilder from '../components/OrgStructureBuilder';
import SubjectsPanel from '../components/SubjectsPanel';
import TeacherUploadsPanel from '../components/TeacherUploadsPanel';
import AdminNoticesPanel from '../components/AdminNoticesPanel';
import BillingPanel from '../components/BillingPanel';
import MenuIcon from './admin/MenuIcon';
import GradebookPanel from './admin/GradebookPanel';
import { TeacherStudentsPanel, TeacherStudentDetailPanel } from './admin/TeacherStudentsPanel';
import { StudentDetailPanel, StudentsPanel } from './admin/StudentsPanel';
import AssignmentsPanel from './admin/AssignmentsPanel';
import ExamsPanel from './admin/ExamsPanel';
import {
  IntegrationsPanel, OrgLogoPanel, TagVisibilityPanel,
  ScanPlagiarismThresholdPanel, CodePlagiarismThresholdPanel, GradeBandsPanel,
} from './admin/OrgSettingsPanels';
import TeachersPanel from './admin/TeachersPanel';
import PromoteStudentsPanel from './admin/PromoteStudentsPanel';
import { RequestAddAdminPanel, AdminRequestsPanel } from './admin/SuperadminContactPanels';
import DoubtsPanel from './admin/DoubtsPanel';
import ChatPanel from './admin/ChatPanel';
import ChatReportsPanel from './admin/ChatReportsPanel';
import '../admin.css';
import '../IdCard.css';

export default function AdminDashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();
  // Defaults to 'students' same as always — location.state?.tab only ever
  // arrives from NotificationBell's doubtLinkFor, landing a teacher
  // straight on their Doubts tab from a "new doubt"/"doubt replied to"
  // notification instead of wherever this dashboard would otherwise open.
  const [tab, setTab] = useState(location.state?.tab || 'students');
  const [selectedStudentId, setSelectedStudentId] = useState(null);
  const [selectedMyStudentId, setSelectedMyStudentId] = useState(null);

  // Mobile-only dropdown for the section tab bar below — see .space-nav-mobile
  // in index.css and SpaceSwitcher's own identical pattern for why both the
  // full row and this toggle/dropdown stay in the DOM at all times.
  const [adminTabsMobileOpen, setAdminTabsMobileOpen] = useState(false);
  const adminTabsMobileRef = useRef(null);
  useEffect(() => {
    if (!adminTabsMobileOpen) return undefined;
    const onClickOutside = (e) => {
      if (adminTabsMobileRef.current && !adminTabsMobileRef.current.contains(e.target)) setAdminTabsMobileOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [adminTabsMobileOpen]);

  // 'students' (StudentsPanel/StudentDetailPanel below) hits admin-only
  // routes — a teacher landing here on the default tab would just see a
  // 403. Bounce them to their own scoped tab once `user` has loaded.
  useEffect(() => {
    if (user?.role === 'teacher' && tab === 'students') setTab('my-students');
  }, [user?.role, tab]);

  // Bumped whenever OrgStructureBuilder changes units/levels, so the
  // sibling panels below it (which each keep their own unit-picker copy)
  // know to refetch instead of showing a newly-added unit only after a
  // full page reload.
  const [unitsVersion, setUnitsVersion] = useState(0);

  return (
    <div className="sb-shell">
      <LogoutFab />
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="admin" />
          <SpaceNotifications />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <div>
            <h1 className="problems-title" style={{ marginBottom: 4 }}>
              {user?.role === 'teacher' ? 'Teacher Dashboard' : 'Admin Dashboard'}
            </h1>
            {user?.name && <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-h)' }}>{user.name}</div>}
            {user?.organization_name && <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 2 }}>{user.organization_name}</div>}
          </div>
          {(() => {
            // Same list rendered twice below (full row on desktop, dropdown
            // on mobile — see .space-nav-mobile's own comment in index.css
            // for why both are always in the DOM) — building it once here
            // keeps the two renders from drifting out of sync with each
            // other as tabs get added/removed.
            const adminTabs = [
              user?.role === 'admin' && { id: 'students', label: 'Students', onClick: () => { setTab('students'); setSelectedStudentId(null); } },
              user?.role === 'teacher' && { id: 'my-students', label: 'My Students', onClick: () => { setTab('my-students'); setSelectedMyStudentId(null); } },
              user?.role === 'teacher' && { id: 'assignments', label: 'Assignments', onClick: () => setTab('assignments') },
              { id: 'exams', label: 'Exams', onClick: () => setTab('exams') },
              { id: 'gradebook', label: 'Gradebook', onClick: () => setTab('gradebook') },
              user?.role === 'teacher' && { id: 'uploads', label: 'Uploads', onClick: () => setTab('uploads') },
              user?.role === 'teacher' && { id: 'doubts', label: 'Doubts', onClick: () => setTab('doubts') },
              // Chat itself dropped from this row — it's now the standing
              // icon beside the notification bell (SpaceSwitcher.jsx's
              // ChatShortcut), same as it was pulled out of the student
              // nav's "More" dropdown for the same reason. The `tab ===
              // 'chat'` render branch further down stays, though — that's
              // still how ChatShortcut's own navigate(..., {state:{tab:
              // 'chat'}}) actually lands on it.
              user?.role === 'admin' && { id: 'notices', label: 'Notices', onClick: () => setTab('notices') },
              user?.role === 'admin' && { id: 'grade-scale', label: 'Grading', onClick: () => setTab('grade-scale') },
              user?.role === 'admin' && { id: 'structure', label: 'Structure', onClick: () => setTab('structure') },
              user?.role === 'admin' && { id: 'institution', label: 'Institution', onClick: () => setTab('institution') },
              user?.role === 'admin' && { id: 'billing', label: 'Billing', onClick: () => setTab('billing') },
              user?.role === 'admin' && { id: 'contact-superadmin', label: 'Contact Superadmin', onClick: () => setTab('contact-superadmin') },
              user?.role === 'admin' && { id: 'chat-reports', label: 'Chat Reports', onClick: () => setTab('chat-reports') },
            ].filter(Boolean);

            return (
              <>
                <div className="segmented space-nav-row" role="tablist" aria-label="Admin section">
                  {adminTabs.map((t) => (
                    <button key={t.id} type="button" role="tab" aria-pressed={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={t.onClick}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="space-nav-mobile" ref={adminTabsMobileRef}>
                  <button type="button" className="icon-btn" aria-label="Section menu" aria-expanded={adminTabsMobileOpen} onClick={() => setAdminTabsMobileOpen((v) => !v)}>
                    <MenuIcon />
                  </button>
                  {adminTabsMobileOpen && (
                    <div className="panel segmented space-nav-drawer" role="tablist" aria-label="Admin section">
                      {adminTabs.map((t) => (
                        <button
                          key={t.id} type="button" role="tab" aria-pressed={tab === t.id}
                          className={tab === t.id ? 'active' : ''}
                          onClick={() => { setAdminTabsMobileOpen(false); t.onClick(); }}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </div>

        {tab === 'students' ? (
          user?.role === 'admin' ? (
            selectedStudentId ? (
              <StudentDetailPanel studentId={selectedStudentId} onBack={() => setSelectedStudentId(null)} />
            ) : (
              <StudentsPanel onSelectStudent={setSelectedStudentId} />
            )
          ) : null
        ) : tab === 'my-students' ? (
          user?.role === 'teacher' ? (
            selectedMyStudentId ? (
              <TeacherStudentDetailPanel studentId={selectedMyStudentId} onBack={() => setSelectedMyStudentId(null)} />
            ) : (
              <TeacherStudentsPanel onSelectStudent={setSelectedMyStudentId} />
            )
          ) : null
        ) : tab === 'assignments' ? (
          user?.role === 'teacher' ? <AssignmentsPanel /> : null
        ) : tab === 'exams' ? (
          <ExamsPanel />
        ) : tab === 'gradebook' ? (
          <GradebookPanel />
        ) : tab === 'uploads' ? (
          user?.role === 'teacher' ? <TeacherUploadsPanel /> : null
        ) : tab === 'doubts' ? (
          user?.role === 'teacher' ? <DoubtsPanel /> : null
        ) : tab === 'chat' ? (
          user?.role === 'teacher' ? <ChatPanel /> : null
        ) : tab === 'notices' ? (
          user?.role === 'admin' ? <AdminNoticesPanel /> : null
        ) : tab === 'structure' ? (
          user?.role === 'admin' ? (
            <>
              <OrgStructureBuilder onChange={() => setUnitsVersion((v) => v + 1)} />
              <SubjectsPanel refreshSignal={unitsVersion} />
              <TeachersPanel refreshSignal={unitsVersion} />
              <PromoteStudentsPanel refreshSignal={unitsVersion} />
            </>
          ) : null
        ) : tab === 'billing' ? (
          user?.role === 'admin' ? <BillingPanel /> : null
        ) : tab === 'institution' ? (
          user?.role === 'admin' ? <OrgLogoPanel /> : null
        ) : tab === 'contact-superadmin' ? (
          user?.role === 'admin' ? (
            <>
              <RequestAddAdminPanel />
              <AdminRequestsPanel />
            </>
          ) : null
        ) : tab === 'chat-reports' ? (
          user?.role === 'admin' ? <ChatReportsPanel /> : null
        ) : tab === 'grade-scale' ? (
          // Every panel here is an org-wide policy call (which tags students
          // see, the grade-band cutoffs, the plagiarism-similarity
          // threshold), same posture as Structure/Billing above — not
          // something a teacher sets, and their own backend routes are all
          // requireAdmin, so rendering this for a teacher was always going
          // to 403. The tab button itself is admin-only for the same reason
          // (see the segmented control above); this check is just the
          // belt-and-braces backstop.
          user?.role === 'admin' ? (
            <>
              <IntegrationsPanel />
              <TagVisibilityPanel />
              <GradeBandsPanel />
              <ScanPlagiarismThresholdPanel />
              <CodePlagiarismThresholdPanel />
            </>
          ) : null
        ) : null}
      </section>
    </div>
  );
}
