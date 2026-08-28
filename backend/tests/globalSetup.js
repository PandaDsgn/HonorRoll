// Jest's globalSetup runs ONCE, in its own separate process, before any
// test file (or index.js) is ever required by the actual test workers —
// its only job here is to make sure the test database's schema is fully
// migrated before that happens.
//
// Why this is needed at all: index.js's ~49 ensureXSchema() boot
// migrations are queued serially via bootSchemaStep (see index.js's own
// `bootSchemaQueue`), but several of those functions await THEIR OWN
// dependencies via `Promise.all([ensureA(), ensureB()])` rather than
// sequentially — harmless on an already-migrated database (every
// IF-NOT-EXISTS check is a fast no-op, so "concurrent" no-ops never
// contend for a lock), but on a genuinely EMPTY database those become
// real concurrent DDL statements that can deadlock each other or run out
// of dependency order. Verified empirically: booting the real app twice
// against a cold database converges cleanly on the second pass (every
// table ends up correctly created) even though the first pass logs
// several caught-and-swallowed errors. That's a real pre-existing
// cold-start bug (see the fix already applied to sweepScanSubmissions'
// own timing for a related instance) — worth its own dedicated fix
// later, but out of scope for "make tests bootable" specifically, and not
// safe to rewrite blind without tests already in place to verify against
// (chicken-and-egg). This script sidesteps it by using the REAL
// migration code as-is, just run twice, rather than duplicating 49
// migration functions here.
const { spawn } = require('child_process');
const path = require('path');
const { Client } = require('pg');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://test:test@localhost:5433/honorroll_test';

async function ensureDatabaseExists() {
  const url = new URL(TEST_DB_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(TEST_DB_URL);
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

function bootOncePass(passLabel) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['index.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        DATABASE_URL: TEST_DB_URL,
        DB_SSL: 'false',
        JWT_SECRET: process.env.JWT_SECRET || 'test-jwt-secret-not-for-real-use',
        PORT: '0', // OS-assigned ephemeral port — this process is only here to run migrations, nothing talks to it over HTTP
      },
      stdio: 'ignore',
    });
    child.on('error', reject);
    // 6s is comfortably past what both convergence passes took when
    // verified manually (each settled in well under that against the
    // small schema this app has) — this is a fixed boot-migration pass,
    // not a request-latency-sensitive wait.
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 6000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

module.exports = async function globalSetup() {
  await ensureDatabaseExists();
  await bootOncePass('convergence pass 1 (may partially fail on a cold database — expected)');
  await bootOncePass('convergence pass 2 (schema should now be fully migrated)');
};
