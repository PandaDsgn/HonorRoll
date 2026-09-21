import ThemeCustomizer from './ThemeCustomizer';

// Thin passthrough — kept as its own file/name since ~20 pages already
// import ThemeToggle, but the actual light/dark control now lives inside
// ThemeCustomizer's single settings dropdown (bundled with accent/
// background/text customization per the user's own request), not as a
// separate button next to it.
export default function ThemeToggle({ theme, onToggle }) {
  return <ThemeCustomizer theme={theme} onToggle={onToggle} />;
}
