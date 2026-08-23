import { useNavigate } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from './ThemeToggle';
import BrandMark from './BrandMark';

// Shared page shell for /terms and /privacy — public, no auth actions
// (unlike sb-topbar elsewhere), since these need to be readable by someone
// who hasn't signed in yet (e.g. mid-signup, deciding whether to accept).
export default function LegalShell({ children }) {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="legal-shell">
      <header className="legal-header">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>&larr; Back</button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>
      <div className="legal-content">{children}</div>
    </div>
  );
}
