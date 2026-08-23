import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function SpaceSwitcher({ activeTab }) {
  const navigate = useNavigate();
  const { isAdmin, role } = useAuth();

  const spaces = [
    { id: 'assignments', label: 'Assignments', path: '/assignments' },
    { id: 'exams', label: 'Exams', path: '/exams' },
    { id: 'ide', label: 'IDE', path: '/ide' },
    ...(role === 'student' ? [{ id: 'performance', label: 'My Info', path: '/performance' }] : []),
    ...(isAdmin ? [{ id: 'admin', label: 'Admin', path: '/admin' }] : []),
  ];

  return (
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
  );
}
