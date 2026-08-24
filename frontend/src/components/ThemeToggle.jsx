function SunIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 1.5v2M10 16.5v2M18.5 10h-2M3.5 10h-2M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4M15.7 15.7l-1.4-1.4M5.7 5.7 4.3 4.3" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M15.5 12.6A6.8 6.8 0 0 1 7.4 4.5a.6.6 0 0 0-.8-.7A7.9 7.9 0 1 0 16.2 13.4a.6.6 0 0 0-.7-.8Z" />
    </svg>
  );
}

export default function ThemeToggle({ theme, onToggle }) {
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={onToggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
