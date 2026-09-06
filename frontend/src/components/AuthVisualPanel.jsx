import ShowcaseCard from './ShowcaseCard';

// Dark editorial panel paired with every auth screen (Login/Signup/
// ForgotPassword/ResetPassword/VerifyOrganization) — shared here rather
// than repeated per-page since it's identical markup in all of them.
// Reuses the same auto-cycling product showcase as the Home hero (see
// .auth-panel .code-window-card in index.css, which pins its otherwise
// theme-aware colors to their dark values — this panel is always dark
// regardless of site theme, same as .console/.idcard).
export default function AuthVisualPanel() {
  return (
    <div className="auth-panel" aria-hidden="true">
      <span className="auth-panel-eyebrow">HonorRoll</span>
      <p className="auth-panel-quote">“Where assignments earn their grade.”</p>
      <ShowcaseCard />
    </div>
  );
}
