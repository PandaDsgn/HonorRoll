const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin } = require('./helpers/fixtures');

describe('exams routes', () => {
  it('GET /api/admin/exams requires auth', async () => {
    const res = await request(app).get('/api/admin/exams');
    expect(res.status).toBe(401);
  });

  it('GET /api/exams returns an empty list for a fresh org', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app).get('/api/exams').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.exams).toEqual([]);
  });

  it('POST /api/admin/exams creates an exam with items', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app)
      .post('/api/admin/exams')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Midterm',
        totalTimeSeconds: 3600,
        items: [
          { type: 'mcq', marks: 5, prompt: 'What is 2+2?', options: [{ id: 'a', text: '4' }, { id: 'b', text: '5' }], correctOptionId: 'a' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.examId).toBeTruthy();

    const listRes = await request(app).get('/api/admin/exams').set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.exams.length).toBe(1);
  });
});
