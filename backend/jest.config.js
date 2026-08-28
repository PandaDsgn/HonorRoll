// maxWorkers: 1 — every test file requires the same index.js (one shared
// `pool`/Express `app`), and all of them hit the same isolated test
// database (see tests/setupEnv.js) — running test FILES in parallel would
// mean concurrent, uncoordinated writes/deletes across shared tables
// (users, organizations, memberships, ...), which is a recipe for flaky
// cross-file interference. Integration tests against a real Postgres are
// already slower than unit tests; testTimeout gives room for that plus a
// cold schema-bootstrap pass on the very first run.
module.exports = {
  testEnvironment: 'node',
  globalSetup: './tests/globalSetup.js',
  setupFiles: ['./tests/setupEnv.js'],
  maxWorkers: 1,
  testTimeout: 20000,
  testMatch: ['**/tests/**/*.test.js'],
  // Jest's default watchman-based file watching gets confused by the
  // sibling `frontend/` package's own node_modules when run from the repo
  // root — irrelevant when run from backend/ (the intended invocation),
  // but harmless to exclude defensively either way.
  testPathIgnorePatterns: ['/node_modules/'],
};
