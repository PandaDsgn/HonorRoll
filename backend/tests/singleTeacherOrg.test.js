const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin, createStudent, loginFirstTime, unique } = require('./helpers/fixtures');

// A small tuition center where the founder is both admin and its only
// teacher — see organizations.is_single_teacher's own comment in
// schema/index.js. Three things this buys them, each covered below:
// (1) signing up with a personal Gmail, no institutional domain required;
// (2) every subject they create auto-enrolls them as its teacher; (3) an
// "acting role" toggle unlocks real teacher-only routes (doubts, notes)
// for them, scoped to just this org — chat is covered separately in
// chat.test.js since it's a universal admin capability, not tied to this
// flag at all.
describe('single-teacher organizations', () => {
  it('POST /api/organizations/signup rejects a personal webmail address by default', async () => {
    const res = await request(app).post('/api/organizations/signup').send({
      organizationName: unique('Regular School'),
      email: `${unique('founder')}@gmail.com`,
      password: 'Test-Password-123!',
      name: 'Founder',
      accessCode: process.env.PLATFORM_OWNER_SECRET,
      acceptedTos: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/institutional email/);
  });

  it('POST /api/organizations/signup with isSingleTeacher accepts a personal webmail address and flags the org', async () => {
    const res = await request(app).post('/api/organizations/signup').send({
      organizationName: unique('Tiny Tuition'),
      email: `${unique('founder')}@gmail.com`,
      password: 'Test-Password-123!',
      name: 'Founder',
      accessCode: process.env.PLATFORM_OWNER_SECRET,
      acceptedTos: true,
      isSingleTeacher: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.isSingleTeacher).toBe(true);

    const meRes = await request(app).get('/api/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(meRes.body.user.is_single_teacher).toBe(true);
  });

  describe('acting-role toggle and auto-assignment', () => {
    let adminToken;
    let orgUnitId;

    beforeAll(async () => {
      const signupRes = await request(app).post('/api/organizations/signup').send({
        organizationName: unique('Founder Tuition'),
        email: `${unique('founder')}@gmail.com`,
        password: 'Test-Password-123!',
        name: 'Founder',
        accessCode: process.env.PLATFORM_OWNER_SECRET,
        acceptedTos: true,
        isSingleTeacher: true,
      });
      adminToken = signupRes.body.token;

      const levelRes = await request(app)
        .post('/api/admin/org-levels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: 'Batch' });
      const unitRes = await request(app)
        .post('/api/admin/org-units')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Batch A', levelDefId: levelRes.body.level.id, parentUnitId: null });
      orgUnitId = unitRes.body.unit.id;
    });

    it('auto-assigns the founder as the teacher of every subject they create', async () => {
      const subjectRes = await request(app)
        .post('/api/admin/subjects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Physics', orgUnitId });
      expect(subjectRes.status).toBe(201);

      // GET /api/doubts/subjects (the teacher-scoped branch) only lists a
      // subject once the caller is actually present in subject_teachers
      // for it — an empty result here would mean auto-assignment silently
      // didn't happen.
      const subjectsRes = await request(app).get('/api/doubts/subjects').set('Authorization', `Bearer ${adminToken}`);
      expect(subjectsRes.status).toBe(200);
      expect(subjectsRes.body.subjects.some((s) => s.id === subjectRes.body.subject.id)).toBe(true);
    });

    it('lets the founder answer a doubt addressed to their subject, acting as its teacher', async () => {
      const subjectRes = await request(app)
        .post('/api/admin/subjects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Chemistry', orgUnitId });
      const subjectId = subjectRes.body.subject.id;

      const student = await createStudent(app, adminToken, { name: 'Test Student', orgUnitId });
      const studentToken = await loginFirstTime(app, student.email, student.tempPassword, 'student');

      const doubtRes = await request(app)
        .post('/api/doubts')
        .set('Authorization', `Bearer ${studentToken}`)
        .field('subjectId', String(subjectId))
        .field('questionText', 'Why is the sky blue?');
      expect(doubtRes.status).toBe(201);

      const replyRes = await request(app)
        .post(`/api/doubts/${doubtRes.body.id}/replies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bodyText: 'Rayleigh scattering.' });
      expect(replyRes.status).toBe(201);

      const detail = await request(app).get(`/api/doubts/${doubtRes.body.id}`).set('Authorization', `Bearer ${studentToken}`);
      expect(detail.body.doubt.status).toBe('answered');
      expect(detail.body.replies[0].authorRole).toBe('teacher');
    });
  });

  it('a regular (non-single-teacher) org admin still cannot answer a doubt directly', async () => {
    const { adminToken } = await createOrgWithAdmin(app);

    const levelRes = await request(app)
      .post('/api/admin/org-levels')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: 'Grade' });
    const unitRes = await request(app)
      .post('/api/admin/org-units')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Grade 1', levelDefId: levelRes.body.level.id, parentUnitId: null });
    const subjectRes = await request(app)
      .post('/api/admin/subjects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Biology', orgUnitId: unitRes.body.unit.id });

    // Not acting-teacher outside a single-teacher org — same 403 a plain
    // admin always got from this route (it's teacher/student only).
    const subjectsRes = await request(app).get('/api/doubts/subjects').set('Authorization', `Bearer ${adminToken}`);
    expect(subjectsRes.status).toBe(403);

    const student = await createStudent(app, adminToken, { orgUnitId: unitRes.body.unit.id });
    const studentToken = await loginFirstTime(app, student.email, student.tempPassword, 'student');
    const doubtRes = await request(app)
      .post('/api/doubts')
      .set('Authorization', `Bearer ${studentToken}`)
      .field('subjectId', String(subjectRes.body.subject.id))
      .field('questionText', 'Why do plants need sunlight?');

    const replyRes = await request(app)
      .post(`/api/doubts/${doubtRes.body.id}/replies`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bodyText: 'Photosynthesis.' });
    expect(replyRes.status).toBe(403);
  });

  it('POST /api/admin/subjects/:id/teachers accepts an admin as a manual assignment, in any org', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const levelRes = await request(app)
      .post('/api/admin/org-levels')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: 'Grade' });
    const unitRes = await request(app)
      .post('/api/admin/org-units')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Grade 1', levelDefId: levelRes.body.level.id, parentUnitId: null });
    const subjectRes = await request(app)
      .post('/api/admin/subjects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'History', orgUnitId: unitRes.body.unit.id });

    const meRes = await request(app).get('/api/me').set('Authorization', `Bearer ${adminToken}`);
    const assignRes = await request(app)
      .post(`/api/admin/subjects/${subjectRes.body.subject.id}/teachers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: meRes.body.user.id });
    expect(assignRes.status).toBe(201);
  });
});
