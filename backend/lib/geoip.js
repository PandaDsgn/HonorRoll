// IP -> approximate location, backing GET /api/superadmin/login-map's
// globe (see routes/superadmin.js and login_locations' own comment in
// schema/index.js). Uses ip-api.com's free tier — no signup, no API key —
// rather than a local GeoIP database; see this feature's own design
// conversation for that trade-off. Every IP is looked up AT MOST ONCE:
// results are cached in geo_locations keyed by ip_address, so a returning
// visitor's IP never triggers a second external call, keeping this well
// under the free tier's 45 requests/minute ceiling in practice.
const { pool } = require('./db');

// Loopback/private-range IPs — every local-dev login hits one of these,
// and ip-api.com can't resolve them to a real place anyway (it returns a
// "private range" failure). Skipped entirely rather than sent to the API,
// so local development never wastes a lookup or logs a spurious error.
function isPrivateOrLoopbackIp(ip) {
  if (!ip) return true;
  const stripped = ip.replace(/^::ffff:/, ''); // IPv4-mapped IPv6, e.g. from some proxies
  if (stripped === '::1' || stripped === '127.0.0.1') return true;
  if (/^(10\.|127\.|192\.168\.)/.test(stripped)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(stripped)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(stripped)) return true; // IPv6 unique local (fc00::/7)
  return false;
}

// Returns { country, countryCode, city, lat, lon } or null (private/
// loopback IP, or the lookup genuinely failed — never throws, since a
// geolocation miss should never be the reason a login fails).
async function lookupIpLocation(ip) {
  if (isPrivateOrLoopbackIp(ip)) return null;

  try {
    const cached = await pool.query(
      'SELECT country, country_code, city, lat, lon FROM geo_locations WHERE ip_address = $1',
      [ip]
    );
    if (cached.rows.length > 0) {
      const row = cached.rows[0];
      return { country: row.country, countryCode: row.country_code, city: row.city, lat: row.lat, lon: row.lon };
    }

    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,lat,lon`);
    const data = await res.json();
    if (data.status !== 'success') return null;

    const location = { country: data.country, countryCode: data.countryCode, city: data.city, lat: data.lat, lon: data.lon };
    await pool.query(
      `INSERT INTO geo_locations (ip_address, country, country_code, city, lat, lon)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (ip_address) DO UPDATE SET
         country = $2, country_code = $3, city = $4, lat = $5, lon = $6, fetched_at = now()`,
      [ip, location.country, location.countryCode, location.city, location.lat, location.lon]
    );
    return location;
  } catch (err) {
    console.error(`IP geolocation lookup failed for ${ip}:`, err);
    return null;
  }
}

// Fire-and-forget, same posture as lib/securityEvents.js's logSecurityEvent
// — a login must never fail or be delayed because geolocation is slow or
// unreachable. Called once per successful login (see POST /api/login);
// silently no-ops for a private/loopback IP (every local-dev login) since
// lookupIpLocation itself returns null for those.
async function recordLoginLocation(userId, organizationId, role, ip) {
  try {
    const location = await lookupIpLocation(ip);
    if (!location) return;
    await pool.query(
      `INSERT INTO login_locations (user_id, organization_id, role, ip_address, country, country_code, city, lat, lon)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, organizationId, role, ip, location.country, location.countryCode, location.city, location.lat, location.lon]
    );
  } catch (err) {
    console.error(`Failed to record login location for user ${userId}:`, err);
  }
}

module.exports = { lookupIpLocation, isPrivateOrLoopbackIp, recordLoginLocation };
