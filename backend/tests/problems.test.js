const request = require('supertest');
const app = require('../index');
const { createOrgWithAdmin } = require('./helpers/fixtures');

describe('problems routes', () => {
  it('GET /api/problems requires auth', async () => {
    const res = await request(app).get('/api/problems');
    expect(res.status).toBe(401);
  });

  it('GET /api/problems returns an empty list for a fresh org', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app).get('/api/problems').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([]);
  });

  it('POST /api/admin/problems creates a coding assignment', async () => {
    const { adminToken } = await createOrgWithAdmin(app);
    const res = await request(app)
      .post('/api/admin/problems')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Add two numbers',
        description: 'Return a + b',
        difficulty: 'Easy',
        testCases: [{ input: '2 3', expectedOutput: '5', isHidden: false }],
        starterCode: {},
      });
    expect(res.status).toBe(201);
    expect(res.body.problemId).toBeTruthy();

    const listRes = await request(app).get('/api/problems').set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.problems.length).toBe(1);
  });
});
