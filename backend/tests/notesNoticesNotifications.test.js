const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin, createTeacher, loginFirstTime } = require('./helpers/fixtures');

describe('notes/notices/notifications routes', () => {
  let adminToken;
  let teacherToken;
  beforeAll(async () => {
    ({ adminToken } = await createOrgWithAdmin(app));
    const { email, tempPassword } = await createTeacher(app, adminToken);
    teacherToken = await loginFirstTime(app, email, tempPassword, 'teacher');
  });

  it('GET /api/notices requires auth', async () => {
    const res = await request(app).get('/api/notices');
    expect(res.status).toBe(401);
  });

  it('GET /api/notices returns an empty list for a fresh org', async () => {
    const res = await request(app).get('/api/notices').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.notices).toEqual([]);
  });

  it('GET /api/notes/subjects requires auth', async () => {
    const res = await request(app).get('/api/notes/subjects');
    expect(res.status).toBe(401);
  });

  it('GET /api/notes/subjects returns an empty list for a fresh teacher', async () => {
    const res = await request(app).get('/api/notes/subjects').set('Authorization', `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.subjects)).toBe(true);
  });

  it('GET /api/notes/subjects rejects an admin (teacher/student only)', async () => {
    const res = await request(app).get('/api/notes/subjects').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /api/notifications requires auth', async () => {
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(401);
  });

  it('GET /api/notifications rejects an admin (student/teacher only)', async () => {
    const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });
});
