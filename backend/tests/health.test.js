const request = require('supertest');
const app = require('../index');

describe('GET /health', () => {
  it('returns 200 before the rate limiter/load guard, confirming the app boots and accepts requests', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
