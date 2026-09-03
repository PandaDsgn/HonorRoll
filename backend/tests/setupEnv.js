// Runs (via Jest's `setupFiles`) BEFORE any test file, and before index.js
// is ever require()'d — sets every env var index.js reads at module-load
// time to point at the isolated, disposable test Postgres container
// (docker run ... -p 5433:5432 postgres:15-alpine, container name
// honorroll_test_db — NOT the real dev/prod database) rather than
// whatever's in backend/.env. index.js's own `require('dotenv').config()`
// never overwrites an already-set process.env var (dotenv's default
// behavior), so setting these here first is what keeps tests from ever
// touching the real Neon database or its real seeded institution data.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://test:test@localhost:5433/honorroll_test';
process.env.DB_SSL = 'false'; // the local test container speaks plain TCP, no TLS
process.env.JWT_SECRET = 'test-jwt-secret-not-for-real-use';
process.env.JWT_EXPIRATION = '1h';
process.env.NODE_ENV = 'test';
process.env.PLATFORM_OWNER_SECRET = 'test-access-code'; // gates POST /api/organizations/signup — fixtures use the real signup route rather than hand-crafted SQL, so this needs a known value
// Deliberately blanked: GROQ_API_KEY, GEMINI_API_KEY, RAZORPAY_*, B2_*,
// GMAIL_*, REDIS_URL, SUPERADMIN_EMAILS — every one of these already has
// an isConfigured()-style guard (isGroqConfigured, isOcrConfigured,
// isB2Configured, isAssistantConfigured, rateLimiter's Redis upgrade) that
// makes the corresponding feature degrade cleanly rather than crash when
// missing, which is exactly the existing "unconfigured deploy" behavior
// this test suite is meant to run under.
//
// Set to '' rather than left merely absent — a developer's own real
// backend/.env commonly HAS real values for these (that's the whole point
// of .env), and index.js's dotenv.config() call only skips a key it finds
// already present in process.env, blank or not (that's the "never
// overwrites an already-set var" rule referenced above). Leaving these
// keys genuinely unset here means dotenv would still fill them in from
// the real .env moments later when index.js loads — which is exactly what
// happened before this fix: a real B2 bucket was silently reachable from
// a supposedly-isolated test run, so a test exercising an upload path
// wrote a real object into it. An explicit '' both satisfies "already
// present, don't overwrite" and reads as falsy everywhere these are
// checked, so every isConfigured() guard still resolves the same way as
// a genuinely-absent key would.
for (const key of [
  'GROQ_API_KEY', 'GROQ_MODEL', 'GEMINI_API_KEY', 'GEMINI_MODEL',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
  'B2_ENDPOINT', 'B2_KEY_ID', 'B2_APPLICATION_KEY', 'B2_BUCKET_NAME',
  'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_SENDER_EMAIL',
  'REDIS_URL', 'SUPERADMIN_EMAILS',
]) {
  process.env[key] = '';
}
