// One shared Redis connection for the whole process — rate limiting
// (rateLimiter.js) and response caching (cache.js) both need a
// process-wide, cross-replica-consistent store, and there's no reason for
// each to open its own separate connection to the same Redis instance.
// Connecting is async and optional (REDIS_URL may not be set at all — see
// every caller's own in-memory/no-op fallback), so this exposes a promise
// that resolves to the client once ready, or null if unconfigured/
// unreachable, rather than making callers each re-implement that dance.
let clientPromise = null;

function getRedisClient() {
  if (!process.env.REDIS_URL) return Promise.resolve(null);
  if (!clientPromise) {
    const { createClient } = require('redis');
    const client = createClient({ url: process.env.REDIS_URL });
    // Mirrors pool.on('error') for Postgres elsewhere in this app — an
    // EventEmitter with no 'error' listener rethrows as an uncaught
    // exception and crashes the whole process the first time Redis blips.
    client.on('error', (err) => console.error('Redis client error:', err));
    clientPromise = client.connect()
      .then(() => {
        console.log('Connected to Redis.');
        return client;
      })
      .catch((err) => {
        console.error('Failed to connect to Redis — caching and rate limiting fall back to in-memory (per-instance):', err);
        clientPromise = null;
        return null;
      });
  }
  return clientPromise;
}

module.exports = { getRedisClient };
