// The shared Postgres pool + boot-time schema-migration queue — split out
// of index.js as the first step of breaking that file into modules (see
// the project's own review: a single 12K-line file with zero route
// separation was the #1 structural risk called out). Pure relocation:
// nothing about `pool`'s config or `bootSchemaStep`'s serialization
// behavior changed, only where it lives — every one of index.js's
// existing `pool.query(...)` call sites and 49 `bootSchemaStep(ensureX)`
// triggers keep working unchanged, since both names are re-imported back
// into index.js's own scope under the same identifiers.
const { Pool } = require('pg');

// ssl is required for Neon (and most hosted Postgres) even when sslmode=require
// is already in the connection string — this is a belt-and-braces fallback so
// pg doesn't reject Neon's cert chain. But a plain self-hosted Postgres (the
// docker-compose `db` service, or Postgres running directly on a box you
// control) typically has SSL off entirely, and pg's client-side `ssl`
// option isn't negotiable the way sslmode=prefer would be — passing it at
// all makes the client demand SSL and fail outright ("the server does not
// support SSL connections") against one that doesn't offer it. DB_SSL
// defaults to "true" so every existing deployment (Neon) is unaffected;
// set DB_SSL=false for a target that doesn't speak TLS at all.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  // Bounds how many concurrent DB connections one instance can open — with
  // no cap, a burst of concurrent requests would each grab a client and a
  // slow/locked query could exhaust Postgres's own max_connections across
  // every horizontally-scaled replica combined. 20 is pg's own client
  // default; set explicitly so it's a deliberate, visible number rather
  // than an implicit one.
  max: Number(process.env.DB_POOL_MAX) || 20,
});
// node-postgres's own documented gotcha: an idle pooled client can emit an
// 'error' event on its own (the server closed the connection, a network
// blip) with no query in flight to catch it. Pool is an EventEmitter, and
// an EventEmitter with zero listeners on an 'error' event rethrows it as an
// uncaught exception — which crashes the entire Node process instantly,
// taking down every in-flight request on this instance. This listener is
// the difference between "one bad connection logs a warning" and "the
// whole server falls over".
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

// Every ensureXSchema() function (see schema/) is memoized (its own cached
// xSchemaPromise) and most explicitly `await` the specific other schema
// functions their own CREATE TABLE/ALTER TABLE references — but the ~40
// bare `ensureXSchema();` trigger calls that actually KICK OFF that whole
// graph are fired independently, all at once, the instant those modules
// load. Against the real production database that's always been harmless
// (every table already exists, so nearly every one of these is an instant
// no-op) — but against a genuinely empty Postgres (a fresh deploy, this
// repo's own docker-compose `db` service, or the integration test suite's
// own disposable database) it isn't: two unrelated CREATE TABLEs running
// concurrently can still deadlock on Postgres's own catalog locks even
// when neither depends on the other, and any dependency edge that isn't
// explicitly awaited races for real. bootSchemaStep queues every trigger
// call to run strictly one at a time, in the order it's called — which is
// already the order the schema modules are required in, i.e. already
// dependency order by construction (a table's own ensureXSchema always
// appears before the first thing that ALTERs or references it). That
// turns the ordering this file's authors clearly intended, but never
// actually enforced, into something that's really true.
//
// One known remaining gap (found via this app's own test suite, running
// against a truly empty database for the first time): a handful of
// ensureXSchema functions await THEIR OWN dependencies via
// `Promise.all([ensureA(), ensureB()])` rather than sequentially — that's
// still two real concurrent DDL statements on a cold database, and can
// still deadlock, even with bootSchemaStep's own ordering intact. Not
// fixed here (would need auditing each such function individually,
// ideally with the new test suite as the safety net); tests/globalSetup.js
// works around it pragmatically by booting the app twice against a fresh
// database, since every ensureXSchema check is IF-NOT-EXISTS/idempotent
// and converges cleanly on the second pass.
let bootSchemaQueue = Promise.resolve();
function bootSchemaStep(fn) {
  bootSchemaQueue = bootSchemaQueue.then(() => fn()).catch((err) => console.error('Schema boot step failed:', err));
  return bootSchemaQueue;
}

module.exports = { pool, bootSchemaStep };
