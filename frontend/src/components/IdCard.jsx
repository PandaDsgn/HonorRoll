import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { QRCodeCanvas } from 'qrcode.react';
import BrandMark from './BrandMark';
import PhotoPicker from './PhotoPicker';
import { API } from '../config';
import '../IdCard.css';

// Same role-to-landing-page mapping as Login.jsx's own landingPathFor —
// duplicated rather than imported, since that's a page component and this
// is a shared one; trivial enough to re-derive here rather than add a
// cross-module dependency for three lines. Scanning this QR is meant for
// the cardholder's OWN device (see this card's own comment on the QR
// below) — anyone else scanning it just lands on the sign-in screen,
// since dashboardUrl carries no token or identifying data of any kind,
// only a route.
function landingPathFor(role) {
  if (role === 'superadmin') return 'superadmin';
  return role === 'admin' || role === 'teacher' ? 'admin' : 'assignments';
}

// Renders one institution's digital ID card, fetched from
// GET /api/me/id-card/:organizationId — and, if the viewer belongs to more
// than one institution, lets them cycle between each one's card (prev/next
// over the `organizations` list already returned by GET /api/me/organizations,
// so no extra request is needed just to know how many institutions exist).
// "Download PNG" rasterizes the card itself via html2canvas, same lazy-import
// pattern already proven in ReferenceDiagram.jsx's own PNG export.
//
// Clicking the photo area opens an INLINE PhotoPicker right here (not a
// navigate-away to /profile) — uploading a photo alone was never enough to
// make it show up on a card; PUT /api/me/organizations/:id/photo has to
// actually be called to set that org's memberships.active_photo_id, and
// this is the one place that call happens. onSelect wires straight into
// PhotoPicker's own selection prop rather than duplicating its upload/
// delete logic here.
export default function IdCard({ organizations, initialOrganizationId, onClose }) {
  const startIndex = Math.max(0, organizations.findIndex((o) => o.organization_id === initialOrganizationId));
  const [index, setIndex] = useState(startIndex);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [pickingPhoto, setPickingPhoto] = useState(false);
  const [selectError, setSelectError] = useState(null);
  const cardRef = useRef(null);
  const photoImgRef = useRef(null);
  const logoImgRef = useRef(null);

  const activeOrg = organizations[index];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPickingPhoto(false);
    if (!activeOrg) return undefined;
    axios.get(`${API}/api/me/id-card/${activeOrg.organization_id}`, { withCredentials: true })
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || 'Could not load this ID card.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeOrg]);

  const cycle = (delta) => {
    setIndex((i) => (i + delta + organizations.length) % organizations.length);
  };

  // Re-fetches in place after a selection — deliberately not routed through
  // the effect above (which also resets pickingPhoto/loading state, which
  // would close the picker AND flash a full loading screen for what's just
  // a photo swap on an already-open card).
  const handleSelectPhoto = async (photoId) => {
    if (!activeOrg) return;
    setSelectError(null);
    try {
      await axios.put(
        `${API}/api/me/organizations/${activeOrg.organization_id}/photo`,
        { photoId },
        { withCredentials: true }
      );
      const res = await axios.get(`${API}/api/me/id-card/${activeOrg.organization_id}`, { withCredentials: true });
      setData(res.data);
      setPickingPhoto(false);
    } catch (err) {
      setSelectError(err.response?.data?.error || 'Failed to set that photo for this card.');
    }
  };

  // B2 sends no CORS headers on the photo/logo objects (confirmed: a plain
  // GET succeeds but carries no Access-Control-Allow-Origin), so the <img>
  // tags below display them fine — plain display never needs CORS — but
  // html2canvas can't read their pixels back out of the canvas to build the
  // PNG; the browser treats that canvas as tainted. Swapping each one to a
  // same-origin blob URL, fetched through our own authenticated proxy route
  // (GET /api/me/id-card/:orgId/:kind, which does carry the right CORS
  // header) just for the moment of capture, sidesteps that entirely.
  const swapToBlobUrl = async (imgEl, orgId, kind) => {
    const res = await axios.get(`${API}/api/me/id-card/${orgId}/${kind}`, { responseType: 'blob', withCredentials: true });
    const objectUrl = URL.createObjectURL(res.data);
    const originalSrc = imgEl.src;
    await new Promise((resolve, reject) => {
      imgEl.onload = resolve;
      imgEl.onerror = reject;
      imgEl.src = objectUrl;
    });
    return { imgEl, originalSrc, objectUrl };
  };

  const handleDownload = async () => {
    if (!cardRef.current || downloading) return;
    setDownloading(true);
    const swapped = [];
    try {
      const { default: html2canvas } = await import('html2canvas');

      if (data.photoUrl && photoImgRef.current) {
        swapped.push(await swapToBlobUrl(photoImgRef.current, activeOrg.organization_id, 'photo'));
      }
      if (data.logoUrl && logoImgRef.current) {
        swapped.push(await swapToBlobUrl(logoImgRef.current, activeOrg.organization_id, 'logo'));
      }

      const canvas = await html2canvas(cardRef.current, { scale: 2, backgroundColor: null });
      const link = document.createElement('a');
      const orgSlug = (data?.organizationName || 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      link.download = `honorroll-id-${orgSlug || 'card'}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch {
      // The card itself is unaffected by a failed export — leave the
      // button clickable to try again rather than showing an error state
      // for what's ultimately just a save-to-disk step.
    } finally {
      for (const { imgEl, originalSrc, objectUrl } of swapped) {
        imgEl.onload = null;
        imgEl.onerror = null;
        imgEl.src = originalSrc;
        URL.revokeObjectURL(objectUrl);
      }
      setDownloading(false);
    }
  };

  const issuedLabel = data?.issuedAt
    ? new Date(data.issuedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase()
    : '';

  // import.meta.env.BASE_URL is vite.config.js's own `base` ('/HonorRoll/'
  // in both dev and prod — this app is always served under that path, see
  // vite.config.js), and the app itself is a HashRouter, so the real route
  // has to sit after a literal '#/' for React Router to ever see it — a
  // bare path would just load the SPA shell at "/" and silently ignore the
  // rest. Points at the role-appropriate dashboard, not any particular
  // sub-page, so it stays correct even if this card is downloaded once and
  // scanned months later.
  const dashboardUrl = data
    ? `${window.location.origin}${import.meta.env.BASE_URL}#/${landingPathFor(data.role)}`
    : '';

  return (
    <div className="idcard-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="idcard-modal">
        <div className="idcard-modal-header">
          <div>
            <h2 className="idcard-modal-title">Your ID card</h2>
            <p className="idcard-modal-sub">
              {organizations.length > 1
                ? `Card ${index + 1} of ${organizations.length} — drawn from your profile.`
                : 'Drawn from your profile.'}
            </p>
          </div>
          <div className="idcard-modal-header-actions">
            {organizations.length > 1 && (
              <div className="idcard-cycle">
                <button type="button" className="btn btn-ghost idcard-cycle-btn" onClick={() => cycle(-1)} aria-label="Previous institution">‹</button>
                <span className="idcard-cycle-label">{index + 1} / {organizations.length}</span>
                <button type="button" className="btn btn-ghost idcard-cycle-btn" onClick={() => cycle(1)} aria-label="Next institution">›</button>
              </div>
            )}
            <button type="button" className="idcard-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        {loading && <div className="idcard-status">Loading card…</div>}
        {!loading && error && <div className="idcard-status idcard-error">{error}</div>}

        {!loading && !error && data && (
          <>
            <div className="idcard bracket-frame" ref={cardRef}>
              <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />

              <div className="idcard-band">
                <div className="idcard-brand brand"><BrandMark /></div>
                <div className="idcard-band-role">{data.role}</div>
              </div>

              <div className="idcard-body">
                <div className="idcard-main">
                  <div
                    className={`idcard-photo-wrap${!data.photoUrl ? ' idcard-photo-wrap-empty' : ''}`}
                    onClick={() => setPickingPhoto((v) => !v)}
                    role="button"
                    tabIndex={0}
                    aria-label={data.photoUrl ? 'Change photo' : 'Add a photo'}
                  >
                    {data.photoUrl
                      ? <img ref={photoImgRef} src={data.photoUrl} alt={data.name ? `${data.name}'s photo` : 'ID photo'} className="idcard-photo" />
                      : (
                        <div className="idcard-photo idcard-photo-empty">
                          <span className="idcard-photo-plus">+</span>
                          <span>Add photo</span>
                        </div>
                      )}
                  </div>
                  <div className="idcard-identity">
                    <div className="idcard-name">{data.name}</div>
                    <div className="idcard-handle">{data.email}</div>
                  </div>
                </div>

                <div className="idcard-detail-grid">
                  <div className="idcard-detail-cell">
                    <div className="idcard-detail-label">Institution</div>
                    <div className="idcard-detail-value">{data.organizationName}</div>
                    {data.orgUnitName && <div className="idcard-detail-sub">{data.orgUnitName}</div>}
                  </div>
                  <div className="idcard-detail-cell idcard-detail-cell-right">
                    <div className="idcard-detail-label">Card ID</div>
                    <div className="idcard-detail-value idcard-detail-value-mono">{data.cardId}</div>
                    <div className="idcard-detail-sub">Issued {issuedLabel}</div>
                  </div>
                </div>

                <div className="idcard-footer-row">
                  <div className="idcard-qr-wrap">
                    {/* size=144 sets the canvas's actual pixel buffer (crisp
                        on retina displays and in the 2x-scaled PNG export —
                        handleDownload's own html2canvas scale — instead of
                        visibly upscaling a 72px-native canvas); the style
                        override below is what actually displays it at the
                        wrapper's own 72px box. qrcode.react sets inline
                        height/width={size} by default, which as an INLINE
                        style beats .idcard-qr-wrap canvas's own width/
                        height: 100% rule in the stylesheet — passing style
                        explicitly here overrides that default instead of
                        fighting it from the CSS side. */}
                    <QRCodeCanvas
                      value={dashboardUrl}
                      size={144}
                      bgColor="#ffffff"
                      fgColor="#0a0a0d"
                      level="M"
                      style={{ width: '100%', height: '100%' }}
                    />
                  </div>
                  <div className="idcard-qr-caption">Scan to open<br />dashboard</div>
                  {data.logoUrl && (
                    <div className="idcard-logo-wrap">
                      <img ref={logoImgRef} src={data.logoUrl} alt="Institution logo" className="idcard-org-logo" />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {pickingPhoto && (
              <div className="idcard-photo-panel">
                <div className="idcard-photo-panel-header">
                  <h3>Choose a photo for this card</h3>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPickingPhoto(false)}>Done</button>
                </div>
                {selectError && <div className="photo-picker-error">{selectError}</div>}
                <PhotoPicker selectedPhotoId={data.photoId} onSelect={handleSelectPhoto} />
              </div>
            )}

            <div className="idcard-actions">
              <button type="button" className="btn btn-primary" onClick={handleDownload} disabled={downloading}>
                {downloading ? 'Saving…' : 'Download PNG'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setPickingPhoto((v) => !v)}>
                {data.photoUrl ? 'Change photo' : 'Add a photo'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
