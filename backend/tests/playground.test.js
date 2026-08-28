const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin } = require('./helpers/fixtures');

// Real sandboxed code execution — slower than the other integration tests
// (spawns an actual python3 subprocess under runLimited's ulimits), hence
// its own longer per-test timeout.
describe('POST /api/playground/execute/:language', () => {
  let adminToken;
  beforeAll(async () => {
    ({ adminToken } = await createOrgWithAdmin(app));
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/playground/execute/python').send({ code: 'print(1)' });
    expect(res.status).toBe(401);
  });

  it('rejects an unsupported language', async () => {
    const res = await request(app)
      .post('/api/playground/execute/not-a-real-language')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'whatever' });
    expect(res.status).toBe(400);
  });

  it('runs Python code and returns its stdout', async () => {
    const res = await request(app)
      .post('/api/playground/execute/python')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'print("hello from jest")' });
    expect(res.status).toBe(200);
    expect(res.body.output).toContain('hello from jest');
  }, 15000);

  it('captures stdin', async () => {
    const res = await request(app)
      .post('/api/playground/execute/python')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'print("got:", input())', stdin: 'echo-me' });
    expect(res.status).toBe(200);
    expect(res.body.output).toContain('got: echo-me');
  }, 15000);
});
