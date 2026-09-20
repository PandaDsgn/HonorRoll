const request = require('supertest');
const app = require('../index');
const { pool } = require('../lib/db');
const { createOrgWithAdmin, createTeacher, createStudent, loginFirstTime, unique } = require('./helpers/fixtures');

// MEDIA_SERVER_WS_URL is deliberately left unset in the test env (see
// tests/setupEnv.js's own "every optional integration degrades cleanly"
// posture) — same as B2 elsewhere in this suite (see doubts.test.js's own
// "503, not the old 400 — B2 isn't configured in the test env" comment),
// so POST /api/teacher/live-sessions can only ever be exercised up to its
// 503. Everything downstream of an actual live_sessions row existing
// (end/current/join against a REAL 'live' row) is set up via a direct pool
// insert instead, the same way chat.test.js already does for rows a route
// itself can't produce in this test environment.
describe('live classes routes', () => {
  let adminToken;
  let subjectId;
  let orgUnitId;
  let teacherToken;
  let teacherId;
  let studentToken;

  beforeAll(async () => {
    ({ adminToken } = await createOrgWithAdmin(app));

    const levelRes = await request(app).post('/api/admin/org-levels').set('Authorization', `Bearer ${adminToken}`).send({ label: 'Year' });
    const unitRes = await request(app).post('/api/admin/org-units').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Year 1', levelDefId: levelRes.body.level.id, parentUnitId: null });
    orgUnitId = unitRes.body.unit.id;
    const subjectRes = await request(app).post('/api/admin/subjects').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Physics', orgUnitId });
    subjectId = subjectRes.body.subject.id;

    const teacherEmail = `${unique('teacher')}@example.com`;
    const teacherCreateRes = await request(app).post('/api/admin/create-teacher').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Physics Teacher', email: teacherEmail, orgUnitId });
    teacherId = teacherCreateRes.body.teacher.id;
    teacherToken = await loginFirstTime(app, teacherEmail, teacherCreateRes.body.temporaryPassword, 'teacher');
    await request(app).post(`/api/admin/subjects/${subjectId}/teachers`).set('Authorization', `Bearer ${adminToken}`).send({ userId: teacherId });

    const student = await createStudent(app, adminToken, { name: 'Physics Student', orgUnitId });
    studentToken = await loginFirstTime(app, student.email, student.tempPassword, 'student');
  });

  describe('GET /api/live-sessions/subjects', () => {
    it('requires auth', async () => {
      const res = await request(app).get('/api/live-sessions/subjects');
      expect(res.status).toBe(401);
    });

    it('lists the subject for the assigned teacher', async () => {
      const res = await request(app).get('/api/live-sessions/subjects').set('Authorization', `Bearer ${teacherToken}`);
      expect(res.status).toBe(200);
      expect(res.body.subjects.some((s) => s.id === subjectId)).toBe(true);
    });

    it("lists every org subject for admin, even ones they aren't personally assigned to", async () => {
      const res = await request(app).get('/api/live-sessions/subjects').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.subjects.some((s) => s.id === subjectId)).toBe(true);
    });

    it('lists the subject for a visible student', async () => {
      const res = await request(app).get('/api/live-sessions/subjects').set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(200);
      expect(res.body.subjects.some((s) => s.id === subjectId)).toBe(true);
    });
  });

  describe('POST /api/teacher/live-sessions', () => {
    it('rejects a student', async () => {
      const res = await request(app).post('/api/teacher/live-sessions').set('Authorization', `Bearer ${studentToken}`).send({ subjectId });
      expect(res.status).toBe(403);
    });

    it('requires a subjectId', async () => {
      const res = await request(app).post('/api/teacher/live-sessions').set('Authorization', `Bearer ${teacherToken}`).send({});
      expect(res.status).toBe(400);
    });

    it('503s — the media server is not configured in the test environment', async () => {
      const res = await request(app).post('/api/teacher/live-sessions').set('Authorization', `Bearer ${teacherToken}`).send({ subjectId });
      expect(res.status).toBe(503);
    });
  });

  describe('against a real live_sessions row (seeded directly, see file-level comment)', () => {
    let liveSessionId;
    let otherTeacherToken;

    beforeAll(async () => {
      const insertRes = await pool.query(
        `INSERT INTO live_sessions (organization_id, subject_id, teacher_id)
         VALUES ((SELECT organization_id FROM subjects WHERE id = $1), $1, $2) RETURNING id`,
        [subjectId, teacherId]
      );
      liveSessionId = insertRes.rows[0].id;

      const otherTeacher = await createTeacher(app, adminToken, { name: 'Other Teacher' });
      otherTeacherToken = await loginFirstTime(app, otherTeacher.email, otherTeacher.tempPassword, 'teacher');
    });

    it('GET /api/live-sessions/:subjectId/current finds it', async () => {
      const res = await request(app).get(`/api/live-sessions/${subjectId}/current`).set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(200);
      expect(res.body.session.id).toBe(liveSessionId);
    });

    it('GET /api/live-sessions/:subjectId/current 404s for a student who cannot see the subject', async () => {
      const outsider = await createStudent(app, adminToken, { orgUnitId: null });
      const outsiderToken = await loginFirstTime(app, outsider.email, outsider.tempPassword, 'student');
      const res = await request(app).get(`/api/live-sessions/${subjectId}/current`).set('Authorization', `Bearer ${outsiderToken}`);
      expect(res.status).toBe(404);
    });

    it('GET /api/live-sessions/:id/join rejects a teacher not assigned to the subject', async () => {
      const res = await request(app).get(`/api/live-sessions/${liveSessionId}/join`).set('Authorization', `Bearer ${otherTeacherToken}`);
      expect(res.status).toBe(403);
    });

    it('GET /api/live-sessions/:id/join 503s for an otherwise-authorized caller — the media server is not configured in the test environment', async () => {
      const res = await request(app).get(`/api/live-sessions/${liveSessionId}/join`).set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(503);
    });

    it('POST /.../end rejects a teacher who did not start it', async () => {
      const res = await request(app).post(`/api/teacher/live-sessions/${liveSessionId}/end`).set('Authorization', `Bearer ${otherTeacherToken}`).send({});
      expect(res.status).toBe(403);
    });

    it('POST /.../end succeeds for the teacher who started it, and the class is no longer "current"', async () => {
      const res = await request(app).post(`/api/teacher/live-sessions/${liveSessionId}/end`).set('Authorization', `Bearer ${teacherToken}`).send({});
      expect(res.status).toBe(200);

      const currentRes = await request(app).get(`/api/live-sessions/${subjectId}/current`).set('Authorization', `Bearer ${studentToken}`);
      expect(currentRes.body.session).toBeNull();
    });

    it('GET /api/live-sessions/:id/join 404s once the class has ended', async () => {
      const res = await request(app).get(`/api/live-sessions/${liveSessionId}/join`).set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(404);
    });
  });
});
