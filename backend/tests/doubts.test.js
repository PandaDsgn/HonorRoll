const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin, createTeacher, createStudent, loginFirstTime, unique } = require('./helpers/fixtures');

// End-to-end smoke test for the doubts feature (routes/doubts.js): a
// student asks a subject teacher a question, the teacher answers, and a
// second, unrelated student can browse the same subject's board but never
// sees who asked it — the core visibility model ensureDoubtsSchema's own
// comment in schema/index.js describes.
describe('doubts routes', () => {
  let adminToken;
  let subjectId;
  let teacherToken;
  let teacherId;
  let coTeacherToken;
  let studentToken;
  let student2Token;
  let doubtId;
  let openDoubtId;

  beforeAll(async () => {
    ({ adminToken } = await createOrgWithAdmin(app));

    const levelRes = await request(app)
      .post('/api/admin/org-levels')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: 'Year' });
    const levelDefId = levelRes.body.level.id;

    const unitRes = await request(app)
      .post('/api/admin/org-units')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Year 1', levelDefId, parentUnitId: null });
    const orgUnitId = unitRes.body.unit.id;

    const subjectRes = await request(app)
      .post('/api/admin/subjects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Math', orgUnitId });
    subjectId = subjectRes.body.subject.id;

    const teacherEmail = `${unique('teacher')}@example.com`;
    const teacherCreateRes = await request(app)
      .post('/api/admin/create-teacher')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Math Teacher', email: teacherEmail, orgUnitId });
    teacherId = teacherCreateRes.body.teacher.id;
    teacherToken = await loginFirstTime(app, teacherEmail, teacherCreateRes.body.temporaryPassword, 'teacher');

    await request(app)
      .post(`/api/admin/subjects/${subjectId}/teachers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: teacherId });

    const coTeacherEmail = `${unique('coteacher')}@example.com`;
    const coTeacherCreateRes = await request(app)
      .post('/api/admin/create-teacher')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Co Teacher', email: coTeacherEmail, orgUnitId });
    coTeacherToken = await loginFirstTime(app, coTeacherEmail, coTeacherCreateRes.body.temporaryPassword, 'teacher');
    await request(app)
      .post(`/api/admin/subjects/${subjectId}/teachers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: coTeacherCreateRes.body.teacher.id });

    const student1 = await createStudent(app, adminToken, { name: 'Student One', orgUnitId });
    studentToken = await loginFirstTime(app, student1.email, student1.tempPassword, 'student');

    const student2 = await createStudent(app, adminToken, { name: 'Student Two', orgUnitId });
    student2Token = await loginFirstTime(app, student2.email, student2.tempPassword, 'student');
  });

  it('GET /api/doubts/subjects requires auth', async () => {
    const res = await request(app).get('/api/doubts/subjects');
    expect(res.status).toBe(401);
  });

  it("GET /api/doubts/subjects (student) includes the subject they're in", async () => {
    const res = await request(app).get('/api/doubts/subjects').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.subjects.map((s) => s.id)).toContain(subjectId);
  });

  it('GET /api/doubts/subjects/:id/teachers (student) includes the assigned teacher', async () => {
    const res = await request(app).get(`/api/doubts/subjects/${subjectId}/teachers`).set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.teachers.map((t) => t.id)).toContain(teacherId);
  });

  it('POST /api/doubts (student) posts a new doubt to the teacher', async () => {
    const res = await request(app)
      .post('/api/doubts')
      .set('Authorization', `Bearer ${studentToken}`)
      .field('subjectId', subjectId)
      .field('teacherId', teacherId)
      .field('questionText', 'Why does integration by parts work?');
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    doubtId = res.body.id;
  });

  it("POST /api/doubts recognizes a PDF as 'document' (503, not the old 'photo or video' 400 — B2 isn't configured in the test env, see tests/setupEnv.js)", async () => {
    const res = await request(app)
      .post('/api/doubts')
      .set('Authorization', `Bearer ${studentToken}`)
      .field('subjectId', subjectId)
      .field('questionText', 'Can someone check my proof? Attached as a PDF.')
      .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'proof.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(503);
  });

  it('POST /api/doubts still rejects an attachment that is neither a photo, video, nor PDF', async () => {
    const res = await request(app)
      .post('/api/doubts')
      .set('Authorization', `Bearer ${studentToken}`)
      .field('subjectId', subjectId)
      .field('questionText', 'This one has a bogus attachment type.')
      .attach('file', Buffer.from('not a real file'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('POST /api/doubts rejects a teacher not assigned to the subject', async () => {
    const res = await request(app)
      .post('/api/doubts')
      .set('Authorization', `Bearer ${studentToken}`)
      .field('subjectId', subjectId)
      .field('teacherId', '00000000-0000-0000-0000-000000000000')
      .field('questionText', 'Doomed to fail');
    expect(res.status).toBe(400);
  });

  it("GET /api/teacher/doubts shows the teacher's own queue with the real student name", async () => {
    const res = await request(app).get('/api/teacher/doubts').set('Authorization', `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    const row = res.body.doubts.find((d) => d.id === doubtId);
    expect(row).toBeDefined();
    expect(row.studentName).toBe('Student One');
    expect(row.status).toBe('open');
  });

  it('a co-teacher of the subject (not the one addressed) also gets a new-doubt notification', async () => {
    const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${coTeacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications.some((n) => n.type === 'doubt' && n.doubtId === doubtId)).toBe(true);
  });

  it("GET /api/teacher/doubts (co-teacher) doesn't show a doubt addressed to someone else", async () => {
    const res = await request(app).get('/api/teacher/doubts').set('Authorization', `Bearer ${coTeacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.doubts.some((d) => d.id === doubtId)).toBe(false);
  });

  it('GET /api/doubts (board) redacts the asker for a different student', async () => {
    const res = await request(app).get('/api/doubts').query({ subjectId }).set('Authorization', `Bearer ${student2Token}`);
    expect(res.status).toBe(200);
    const row = res.body.doubts.find((d) => d.id === doubtId);
    expect(row).toBeDefined();
    expect(row.askerName).toBeNull();
    expect(row.isMine).toBe(false);
  });

  it('GET /api/doubts (board) shows the real asker name to the asker themselves', async () => {
    const res = await request(app).get('/api/doubts').query({ subjectId }).set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    const row = res.body.doubts.find((d) => d.id === doubtId);
    expect(row.isMine).toBe(true);
    expect(row.askerName).toBe('Student One');
  });

  it('GET /api/doubts/:id rejects a teacher not assigned to this doubt', async () => {
    const otherTeacher = await createTeacher(app, adminToken, { name: 'Other Teacher' });
    const otherTeacherToken = await loginFirstTime(app, otherTeacher.email, otherTeacher.tempPassword, 'teacher');
    const res = await request(app).get(`/api/doubts/${doubtId}`).set('Authorization', `Bearer ${otherTeacherToken}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/doubts/:id/replies rejects a student who is neither the asker nor the teacher', async () => {
    const res = await request(app)
      .post(`/api/doubts/${doubtId}/replies`)
      .set('Authorization', `Bearer ${student2Token}`)
      .send({ bodyText: 'Not my doubt to answer' });
    expect(res.status).toBe(403);
  });

  it('POST /api/doubts/:id/replies (teacher) answers and flips status to answered', async () => {
    const res = await request(app)
      .post(`/api/doubts/${doubtId}/replies`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ bodyText: 'Because the product rule run in reverse gives you that formula.' });
    expect(res.status).toBe(201);

    const detail = await request(app).get(`/api/doubts/${doubtId}`).set('Authorization', `Bearer ${studentToken}`);
    expect(detail.body.doubt.status).toBe('answered');
    expect(detail.body.replies).toHaveLength(1);
    expect(detail.body.replies[0].authorRole).toBe('teacher');
  });

  it("GET /api/doubts/similar ranks the just-asked doubt for a near-duplicate query", async () => {
    const res = await request(app)
      .get('/api/doubts/similar')
      .query({ subjectId, q: 'why does integration by parts work anyway' })
      .set('Authorization', `Bearer ${student2Token}`);
    expect(res.status).toBe(200);
    expect(res.body.doubts.some((d) => d.id === doubtId)).toBe(true);
  });

  it('GET /api/doubts/mine (student) lists their own doubt', async () => {
    const res = await request(app).get('/api/doubts/mine').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.doubts.some((d) => d.id === doubtId)).toBe(true);
  });

  it('GET /api/notifications (student) includes the reply notification', async () => {
    const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications.some((n) => n.type === 'doubt' && n.doubtId === doubtId)).toBe(true);
  });

  it('GET /api/notifications (teacher) includes the original new-doubt notification', async () => {
    const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications.some((n) => n.type === 'doubt' && n.doubtId === doubtId)).toBe(true);
  });

  it('POST /api/doubts/:id/replies (student follow-up) reopens the doubt', async () => {
    const res = await request(app)
      .post(`/api/doubts/${doubtId}/replies`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ bodyText: "I'm still confused, can you show an example?" });
    expect(res.status).toBe(201);

    const detail = await request(app).get(`/api/doubts/${doubtId}`).set('Authorization', `Bearer ${teacherToken}`);
    expect(detail.body.doubt.status).toBe('open');
    expect(detail.body.replies).toHaveLength(2);
  });

  // Subject-wide doubts — no teacherId at all, so every teacher of the
  // subject (not just one addressed teacher) can see and answer it.
  describe('unaddressed (subject-wide) doubts', () => {
    it('POST /api/doubts with no teacherId succeeds', async () => {
      const res = await request(app)
        .post('/api/doubts')
        .set('Authorization', `Bearer ${studentToken}`)
        .field('subjectId', subjectId)
        .field('questionText', 'What is the chain rule, in plain English?');
      expect(res.status).toBe(201);
      openDoubtId = res.body.id;
    });

    it('GET /api/doubts/mine shows no specific teacher for it', async () => {
      const res = await request(app).get('/api/doubts/mine').set('Authorization', `Bearer ${studentToken}`);
      const row = res.body.doubts.find((d) => d.id === openDoubtId);
      expect(row).toBeDefined();
      expect(row.teacherName).toBeNull();
    });

    it("GET /api/teacher/doubts includes it for BOTH the subject's teachers, addressedToMe false", async () => {
      const teacherRes = await request(app).get('/api/teacher/doubts').set('Authorization', `Bearer ${teacherToken}`);
      const teacherRow = teacherRes.body.doubts.find((d) => d.id === openDoubtId);
      expect(teacherRow).toBeDefined();
      expect(teacherRow.addressedToMe).toBe(false);

      const coTeacherRes = await request(app).get('/api/teacher/doubts').set('Authorization', `Bearer ${coTeacherToken}`);
      const coTeacherRow = coTeacherRes.body.doubts.find((d) => d.id === openDoubtId);
      expect(coTeacherRow).toBeDefined();
      expect(coTeacherRow.addressedToMe).toBe(false);
    });

    it('a co-teacher (never addressed) can open it and reply to it', async () => {
      const detail = await request(app).get(`/api/doubts/${openDoubtId}`).set('Authorization', `Bearer ${coTeacherToken}`);
      expect(detail.status).toBe(200);

      const reply = await request(app)
        .post(`/api/doubts/${openDoubtId}/replies`)
        .set('Authorization', `Bearer ${coTeacherToken}`)
        .send({ bodyText: "It's the derivative of the outer function times the derivative of the inner one." });
      expect(reply.status).toBe(201);

      const afterReply = await request(app).get(`/api/doubts/${openDoubtId}`).set('Authorization', `Bearer ${studentToken}`);
      expect(afterReply.body.doubt.status).toBe('answered');
    });

    it('a teacher wholly unrelated to the subject still gets rejected', async () => {
      const outsider = await createTeacher(app, adminToken, { name: 'Outsider Teacher' });
      const outsiderToken = await loginFirstTime(app, outsider.email, outsider.tempPassword, 'teacher');
      const res = await request(app).get(`/api/doubts/${openDoubtId}`).set('Authorization', `Bearer ${outsiderToken}`);
      expect(res.status).toBe(403);
    });

    it("a student follow-up on an unaddressed doubt notifies every one of the subject's teachers", async () => {
      await request(app)
        .post(`/api/doubts/${openDoubtId}/replies`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ bodyText: 'Could you give a worked example?' });

      const teacherNotifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${teacherToken}`);
      expect(teacherNotifs.body.notifications.some((n) => n.doubtId === openDoubtId)).toBe(true);

      const coTeacherNotifs = await request(app).get('/api/notifications').set('Authorization', `Bearer ${coTeacherToken}`);
      expect(coTeacherNotifs.body.notifications.some((n) => n.doubtId === openDoubtId)).toBe(true);
    });
  });
});
