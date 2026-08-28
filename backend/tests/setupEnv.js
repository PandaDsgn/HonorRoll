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
// Deliberately unset/absent: GROQ_API_KEY, GEMINI_API_KEY, RAZORPAY_*,
// B2_*, GMAIL_*, REDIS_URL, SUPERADMIN_EMAILS — every one of these already
// has an isConfigured()-style guard (isGroqConfigured, isOcrConfigured,
// isB2Configured, isAssistantConfigured, rateLimiter's Redis upgrade) that
// makes the corresponding feature degrade cleanly rather than crash when
// missing, which is exactly the existing "unconfigured deploy" behavior
// this test suite runs under.
