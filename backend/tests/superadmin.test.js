const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin } = require('./helpers/fixtures');

describe('superadmin routes', () => {
  it('GET /api/superadmin/organizations requires auth', async () => {
    const res = await request(app).get('/api/superadmin/organizations');
    expect(res.status).toBe(401);
  });

  it('GET /api/superadmin/organizations rejects a non-superadmin', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app).get('/api/superadmin/organizations').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /api/superadmin/requests rejects a non-superadmin', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app).get('/api/superadmin/requests').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /api/superadmin/add-admin-requests rejects a non-superadmin', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app).get('/api/superadmin/add-admin-requests').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });
});
