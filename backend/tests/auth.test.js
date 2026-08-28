const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin, unique } = require('./helpers/fixtures');

describe('POST /api/organizations/signup', () => {
  it('rejects a missing organization name', async () => {
    const res = await request(app).post('/api/organizations/signup').send({
      email: 'x@example.com', password: 'pw', name: 'X', accessCode: process.env.PLATFORM_OWNER_SECRET, acceptedTos: true,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a wrong/missing access code', async () => {
    const res = await request(app).post('/api/organizations/signup').send({
      organizationName: 'Some School', email: `${unique('a')}@example.com`, password: 'pw', name: 'X',
      accessCode: 'definitely-wrong', acceptedTos: true,
    });
    expect(res.status).toBe(403);
  });

  it('rejects signup without accepting ToS', async () => {
    const res = await request(app).post('/api/organizations/signup').send({
      organizationName: 'Some School', email: `${unique('a')}@example.com`, password: 'pw', name: 'X',
      accessCode: process.env.PLATFORM_OWNER_SECRET,
    });
    expect(res.status).toBe(400);
  });

  it('creates an org + admin and logs in successfully', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    expect(typeof adminToken).toBe('string');
    expect(adminToken.split('.').length).toBe(3); // looks like a JWT
  });
});

describe('POST /api/login', () => {
  it('rejects an unknown email', async () => {
    const res = await request(app).post('/api/login').send({ email: 'nobody@example.com', password: 'whatever' });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong password for a real account', async () => {
    const { adminEmail } = await createOrgWithAdmin(app);
    const res = await request(app).post('/api/login').send({ email: adminEmail, password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('rejects login when the selected account-type tab does not match the real role', async () => {
    // Regression test for the exact bug fixed earlier this session: signing
    // in with a real admin's credentials while "Student" is selected must
    // be REJECTED, not silently logged in as whatever role the account
    // actually has.
    const { adminEmail, adminPassword } = await createOrgWithAdmin(app);
    const res = await request(app).post('/api/login').send({ email: adminEmail, password: adminPassword, audience: 'student' });
    expect(res.status).toBe(401);
  });

  it('logs in successfully with the matching audience', async () => {
    const { adminEmail, adminPassword } = await createOrgWithAdmin(app);
    const res = await request(app).post('/api/login').send({ email: adminEmail, password: adminPassword, audience: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('admin');
  });
});
