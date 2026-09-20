import { useCustomTheme } from '../context/CustomThemeContext';

// Real <img>/<video> elements, not a CSS background-image var on <body> —
// the previous version drove this off a --custom-bg-image custom property
// and it silently never painted (some other opaque page-shell surface
// always won the paint order), and CSS alone can't loop a video anyway.
// Mounted once in App.jsx, first, so it sits behind all normal-flow page
// content without needing a z-index fight — position: fixed takes it out
// of flow, and every real page element painted after it in the DOM simply
// draws on top.
export default function CustomBackgroundLayer() {
  const { custom } = useCustomTheme();
  if (!custom.bgVideo && !custom.bgImage) return null;

  return (
    <div className="custom-bg-layer" aria-hidden="true">
      {custom.bgVideo ? (
        <video key={custom.bgVideo} className="custom-bg-media" src={custom.bgVideo} autoPlay loop muted playsInline />
      ) : (
        <img className="custom-bg-media" src={custom.bgImage} alt="" />
      )}
    </div>
  );
}
