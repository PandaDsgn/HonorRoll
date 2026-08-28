const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin } = require('./helpers/fixtures');

describe('billing routes', () => {
  it('GET /api/billing/plans is public and returns the plan catalog', async () => {
    const res = await request(app).get('/api/billing/plans');
    expect(res.status).toBe(200);
    expect(res.body.plans.free).toBeDefined();
    expect(res.body.plans.free.studentCap).toBe(30);
  });

  it('GET /api/admin/billing/status requires auth', async () => {
    const res = await request(app).get('/api/admin/billing/status');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/billing/status returns the free plan for a fresh org', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app).get('/api/admin/billing/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.planKey).toBe('free');
  });

  it('POST /api/admin/billing/checkout rejects an invalid plan', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app)
      .post('/api/admin/billing/checkout')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ planKey: 'not-a-real-plan', billingCycle: 'monthly' });
    expect(res.status).toBe(400);
  });
});
