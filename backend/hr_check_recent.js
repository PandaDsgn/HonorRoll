require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const events = await pool.query(`
    SELECT event_type, actor_email, ip_address, created_at FROM security_events
    WHERE event_type IN ('login_success','login_failed','login_blocked') AND created_at > now() - interval '2 hours'
    ORDER BY created_at DESC LIMIT 20
  `);
  console.log('Recent auth events (last 2h):', events.rows.length);
  events.rows.forEach(r => console.log(' -', r.created_at.toISOString(), r.event_type, r.actor_email, '| ip:', r.ip_address));

  const locs = await pool.query(`SELECT ip_address, city, country, created_at FROM login_locations ORDER BY created_at DESC LIMIT 10`);
  console.log('\nlogin_locations rows total (recent):', locs.rows.length);
  locs.rows.forEach(r => console.log(' -', r.created_at.toISOString(), r.ip_address, r.city, r.country));

  const geo = await pool.query(`SELECT ip_address, country, city, fetched_at FROM geo_locations ORDER BY fetched_at DESC LIMIT 10`);
  console.log('\ngeo_locations cache rows:', geo.rows.length);
  geo.rows.forEach(r => console.log(' -', r.ip_address, r.city, r.country));

  await pool.end();
})();
