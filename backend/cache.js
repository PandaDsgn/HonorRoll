// Small TTL cache for genuinely read-heavy, write-rare data — Redis-backed
// (shared, correct across every horizontally-scaled replica) when
// REDIS_URL is set, an in-memory Map otherwise (per-instance, still real,
// just not precise across replicas — same tradeoff as rateLimiter.js).
// Deliberately not a general-purpose HTTP response cache: only specific,
// deliberately chosen call sites use this (see index.js), each picked
// because they're read on nearly every request but only ever written by a
// rare admin action.
const { getRedisClient } = require('./redisClient');

const memoryStore = new Map(); // key -> { value, expiresAt }

function memoryGet(key) {
  const entry = memoryStore.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    memoryStore.delete(key);
    return undefined;
  }
  return entry.value;
}

function memorySet(key, value, ttlSeconds) {
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function memoryDelPrefix(prefix) {
  for (const key of memoryStore.keys()) {
    if (key.startsWith(prefix)) memoryStore.delete(key);
  }
}

// Returns the cached value for `key`, or calls `compute()` and caches
// whatever it resolves to for `ttlSeconds`. `compute` is only ever invoked
// on a miss, same as any other memoize-with-TTL helper — this is the one
// function most call sites actually use.
async function cached(key, ttlSeconds, compute) {
  const client = await getRedisClient();
  if (client) {
    const hit = await client.get(key).catch(() => null);
    if (hit != null) return JSON.parse(hit);
    const value = await compute();
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds }).catch((err) => console.error('Cache set failed:', err));
    return value;
  }
  const hit = memoryGet(key);
  if (hit !== undefined) return hit;
  const value = await compute();
  memorySet(key, value, ttlSeconds);
  return value;
}

// Called by the handful of write routes that mutate something a `cached()`
// call site above depends on (e.g. an org's structure) — invalidates every
// key under `prefix` so the next read recomputes instead of waiting out
// the TTL. Prefix, not a single key, since e.g. org-units caching is keyed
// per-organization but a single edit should only ever need to drop that
// one org's entry, not the whole cache — callers pass the specific prefix
// that matches.
async function invalidate(prefix) {
  const client = await getRedisClient();
  if (client) {
    // SCAN, not KEYS — KEYS blocks the whole Redis instance on a large
    // keyspace; SCAN walks it in small non-blocking increments instead.
    let cursor = '0';
    do {
      const res = await client.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
      cursor = res.cursor;
      if (res.keys.length > 0) await client.del(res.keys);
    } while (cursor !== '0');
    return;
  }
  memoryDelPrefix(prefix);
}

module.exports = { cached, invalidate };
