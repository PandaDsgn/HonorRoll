// Rate limiting, shared across however many replicas of this app are
// running behind the load balancer. In-memory rate limiting (express-
// rate-limit's own default store) counts requests PER PROCESS — with N
// horizontally-scaled replicas, an attacker effectively gets N times the
// limit, split across whichever replica the load balancer happens to route
// each request to. A Redis-backed store fixes that: every replica reads
// and writes the same counters, so the limit is accurate platform-wide, not
// per-instance.
//
// The middleware itself has to be registered synchronously, at the top of
// the Express stack, before any route is defined — otherwise routes below
// it would already have sent a response before the limiter ever got a
// chance to run. But connecting to Redis is async. Resolving that: this
// starts every limiter on the in-memory MemoryStore immediately (real
// protection from request one, even on a single instance with no Redis
// configured at all), then — only if REDIS_URL is set — connects to Redis
// in the background and swaps the store's target underneath the same
// already-registered middleware once it's ready. Nothing downstream ever
// sees the swap; `SwappableStore` just delegates each call to whichever
// backing store is current.
const { rateLimit, MemoryStore, ipKeyGenerator } = require('express-rate-limit');

// The integration test suite (tests/) exercises real signup/login flows
// dozens of times per run, all from the same loopback IP — real, correct
// production behavior for a human attacker attempting that many auth
// requests, but it means the test suite itself trips its own rate limiter
// well before covering everything it needs to. Skipping enforcement (not
// skipping the middleware entirely — `skip` still runs standardHeaders
// bookkeeping, just never counts/blocks) under NODE_ENV=test is the
// standard fix for this class of conflict; nothing about the exported
// limiter's real behavior changes for an actual deployment.
const skipInTest = () => process.env.NODE_ENV === 'test';

class SwappableStore {
  constructor() {
    this.target = new MemoryStore();
  }
  init(options) {
    this.options = options;
    this.target.init?.(options);
  }
  swapTo(newStore) {
    newStore.init?.(this.options);
    this.target = newStore;
  }
  increment(key) { return this.target.increment(key); }
  decrement(key) { return this.target.decrement?.(key); }
  resetKey(key) { return this.target.resetKey?.(key); }
  resetAll() { return this.target.resetAll?.(); }
}

// General ceiling on every route — generous enough that no real user
// script (the frontend polling billing status, an exam's proctoring
// heartbeat, etc.) ever brushes it, but low enough to blunt a scraping
// script or a runaway client-side retry loop. 300 requests/5 min per IP.
const globalStore = new SwappableStore();
const globalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: globalStore,
  skip: skipInTest,
  message: { error: 'Too many requests — please slow down and try again shortly.' },
});

// Login/signup/password-reset are the actual brute-force/credential-
// stuffing targets, so they get a much tighter ceiling than everything
// else: 10 attempts per 15 minutes per IP. Deliberately keyed on IP (the
// default), not email — keying on email would let an attacker sidestep the
// limit by trying different emails from the same IP, and would let an
// attacker lock a VICTIM out by hammering their email from elsewhere.
const authStore = new SwappableStore();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: authStore,
  skip: skipInTest,
  message: { error: 'Too many attempts — please wait 15 minutes and try again.' },
});

// The AI assistant costs real Groq tokens per message, unlike everything
// else globalLimiter already covers — its own tighter, per-USER (not
// per-IP) ceiling on top. Keyed by the authenticated user's own id since
// this route always sits behind authenticateToken first — per-user is the
// right unit for an LLM-cost budget (an office/campus NAT sharing one IP
// shouldn't share one chat budget). 20 messages / 10 minutes is generous
// for real back-and-forth use while bounding a runaway/scripted client.
const assistantStore = new SwappableStore();
const assistantLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: assistantStore,
  skip: skipInTest,
  // req.user.userId is always set in practice — this route sits behind
  // authenticateToken, which already 401s before this middleware ever
  // runs on an unauthenticated request. The req.ip fallback only exists
  // so this never throws if that assumption is ever violated; routed
  // through ipKeyGenerator (rather than the raw string) so it doesn't
  // let a whole IPv6 /64 share one bucket, per express-rate-limit's own
  // validation.
  keyGenerator: (req) => (req.user?.userId ? String(req.user.userId) : ipKeyGenerator(req.ip)),
  message: { error: 'You\'ve sent a lot of messages — please wait a bit before asking the assistant something else.' },
});

// Fire-and-forget — called once at boot (see index.js). Never blocks
// server startup on Redis being reachable, and a failed/slow connection
// just leaves both limiters on MemoryStore, same as no REDIS_URL at all.
async function connectRedisAndUpgradeStores() {
  const { getRedisClient } = require('./redisClient');
  const client = await getRedisClient();
  if (!client) return;
  const { RedisStore } = require('rate-limit-redis');
  globalStore.swapTo(new RedisStore({ prefix: 'rl:global:', sendCommand: (...args) => client.sendCommand(args) }));
  authStore.swapTo(new RedisStore({ prefix: 'rl:auth:', sendCommand: (...args) => client.sendCommand(args) }));
  assistantStore.swapTo(new RedisStore({ prefix: 'rl:assistant:', sendCommand: (...args) => client.sendCommand(args) }));
  console.log('Rate limiting backed by Redis (shared across replicas).');
}

module.exports = { globalLimiter, authLimiter, assistantLimiter, connectRedisAndUpgradeStores };
