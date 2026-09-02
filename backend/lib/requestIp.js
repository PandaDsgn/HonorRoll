// Render fronts every request — custom domain or the default *.onrender.com
// subdomain alike — through Cloudflare's own edge network before it ever
// reaches this container. `trust proxy` (see index.js) correctly walks past
// Render's own internal, private-network hops, but Cloudflare's edge node
// itself sits one hop further out and connects on a public IP, so that walk
// stops there and hands back CLOUDFLARE'S address as req.ip — not the
// visitor's. Confirmed directly: a real login recorded a Cloudflare-owned IP
// (172.68.x.x, geolocating to Portland, OR) instead of the visitor's actual
// location, and since Cloudflare's anycast network can route the same
// visitor through a different edge node on every request, anything keyed on
// req.ip (rate limits, security-event IPs, login geolocation) was really
// keyed on "which Cloudflare PoP happened to handle this," not the visitor.
//
// Cloudflare's CF-Connecting-IP header carries the real visitor IP and can't
// be spoofed by the client — Cloudflare strips any client-supplied header of
// the same name and sets its own at the edge — so prefer it whenever
// present. Falls back to req.ip for local dev, where there's no Cloudflare
// in front and this header never shows up.
function getClientIp(req) {
  return req?.headers?.['cf-connecting-ip'] || req?.ip || null;
}

module.exports = { getClientIp };
