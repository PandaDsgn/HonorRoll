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
    const { adminToken, adminEmail, orgName, organizationId } = await createOrgWithAdmin(app);
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(adminEmail);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.organization_name).toBe(orgName);
    expect(res.body.user.organizationId).toBe(organizationId);
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

describe('POST /api/me/switch-organization', () => {
  it('mints a fresh session scoped to a second org the same student belongs to', async () => {
    const { adminToken: admin1Token, orgName: org1Name } = await createOrgWithAdmin(app);
    const student = await createStudent(app, admin1Token, { name: 'Multi Org Student' });
    const org1Token = await loginFirstTime(app, student.email, student.tempPassword, 'student');

    const { adminToken: admin2Token, orgName: org2Name } = await createOrgWithAdmin(app);
    // createStudent (the fixture) always mints its OWN unique email — it
    // has no way to reuse an existing one, so this goes straight through
    // the real route instead, deliberately reusing student.email. Same
    // findOrCreateGlobalUser path as admin.js: an already-existing global
    // user just gets a second membership row, no new temporary password to
    // log in with — org1Token is still their one real session either way.
    const addRes = await request(app)
      .post('/api/admin/create-student')
      .set('Authorization', `Bearer ${admin2Token}`)
      .send({ email: student.email, name: 'Multi Org Student' });
    expect(addRes.status).toBe(201);

    const meBefore = await request(app).get('/api/me').set('Authorization', `Bearer ${org1Token}`);
    expect(meBefore.body.user.organization_name).toBe(org1Name);

    const orgsRes = await request(app).get('/api/me/organizations').set('Authorization', `Bearer ${org1Token}`);
    // Confirms GET /api/me's own organizationId (added alongside this
    // endpoint so the frontend can tell which row in that list is the
    // CURRENT one, not just which orgs exist) matches the org1 row here.
    expect(orgsRes.body.organizations.some((o) => o.organization_name === org1Name && o.organization_id === meBefore.body.user.organizationId)).toBe(true);
    const org2Id = orgsRes.body.organizations.find((o) => o.organization_name === org2Name).organization_id;

    const switchRes = await request(app)
      .post('/api/me/switch-organization')
      .set('Authorization', `Bearer ${org1Token}`)
      .send({ organizationId: org2Id });
    expect(switchRes.status).toBe(200);
    expect(switchRes.body.token).toBeTruthy();
    expect(switchRes.body.user.organization_name).toBe(org2Name);
    expect(switchRes.body.user.organizationId).toBe(org2Id);

    const meAfter = await request(app).get('/api/me').set('Authorization', `Bearer ${switchRes.body.token}`);
    expect(meAfter.status).toBe(200);
    expect(meAfter.body.user.organization_name).toBe(org2Name);
    expect(meAfter.body.user.organizationId).toBe(org2Id);
  });

  it('rejects switching to an org the caller is not a member of', async () => {
    const { adminToken: admin1Token } = await createOrgWithAdmin(app);
    const student = await createStudent(app, admin1Token);
    const org1Token = await loginFirstTime(app, student.email, student.tempPassword, 'student');

    const { organizationId: unrelatedOrgId } = await createOrgWithAdmin(app);

    const res = await request(app)
      .post('/api/me/switch-organization')
      .set('Authorization', `Bearer ${org1Token}`)
      .send({ organizationId: unrelatedOrgId });
    expect(res.status).toBe(404);
  });
});

describe('GET/PUT /api/me/custom-theme', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/me/custom-theme');
    expect(res.status).toBe(401);
  });

  it('returns an empty object before anything has ever been saved', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app).get('/api/me/custom-theme').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customTheme).toEqual({});
  });

  it('round-trips a saved theme', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const theme = { accent: '#ff8800', cardOpacity: 60 };

    const putRes = await request(app)
      .put('/api/me/custom-theme')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ customTheme: theme });
    expect(putRes.status).toBe(200);

    const getRes = await request(app).get('/api/me/custom-theme').set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.customTheme).toEqual(theme);
  });

  it('rejects a non-object customTheme', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app)
      .put('/api/me/custom-theme')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ customTheme: 'not-an-object' });
    expect(res.status).toBe(400);
  });
});
