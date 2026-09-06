import { useNavigate } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from './ThemeToggle';
import BrandMark from './BrandMark';

// Shared shell for every full-page error state (NotFound/Forbidden below,
// plus ErrorBoundary's crash fallback) — one layout instead of three
// near-identical copies, same "own header, own footer, own big number"
// shape as the landing page's own hero treatment.
export default function ErrorPage({ code, title, message, actions }) {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="landing-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>
      <hr className="rule" />

      <main className="error-page">
        <span className="error-page-code" aria-hidden="true">{code}</span>
        <h1>{title}</h1>
        <p>{message}</p>
        <div className="error-page-actions">{actions}</div>
      </main>
    </div>
  );
}
