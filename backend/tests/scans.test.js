const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin } = require('./helpers/fixtures');

describe('scans routes', () => {
  it('GET /api/me/scan-context requires auth', async () => {
    const res = await request(app).get('/api/me/scan-context');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/settings/scan-plagiarism-threshold requires auth', async () => {
    const res = await request(app).get('/api/admin/settings/scan-plagiarism-threshold');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/settings/scan-plagiarism-threshold returns the default for a fresh org', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app)
      .get('/api/admin/settings/scan-plagiarism-threshold')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.threshold).toBe('number');
  });
});
