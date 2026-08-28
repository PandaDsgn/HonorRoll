const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin, createStudent, loginFirstTime } = require('./helpers/fixtures');

describe('GET /api/me', () => {
  it('rejects a request with no token', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('rejects a garbage token', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('returns the admin\'s own identity for a valid admin session', async () => {
    const { adminToken, adminEmail, orgName } = await createOrgWithAdmin(app);
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(adminEmail);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.organization_name).toBe(orgName);
  });

  it('returns a student\'s own identity after an admin creates them', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const { email, tempPassword } = await createStudent(app, adminToken);

    const token = await loginFirstTime(app, email, tempPassword, 'student');

    const meRes = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.role).toBe('student');
    expect(meRes.body.user.email).toBe(email);
  });
});

describe('GET /api/me/organizations', () => {
  it('lists the org the admin belongs to', async () => {
    const { adminToken, organizationId } = await createOrgWithAdmin(app);
    const res = await request(app).get('/api/me/organizations').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.organizations)).toBe(true);
    expect(res.body.organizations.some((o) => o.organization_id === organizationId)).toBe(true);
  });
});
