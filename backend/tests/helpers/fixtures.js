// Test fixtures go through the REAL routes (signup, login, create-teacher,
// create-student) rather than hand-crafted SQL inserts — this both avoids
// fixtures drifting out of sync with the real schema/validation rules AND
// means every fixture creation is itself exercising real app code, adding
// incidental coverage on top of whatever the actual test file is checking.
const request = require('supertest');
const jwt = require('jsonwebtoken');

let counter = 0;
function unique(prefix) {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

// Creates a brand-new organization + its founding admin account, and logs
// straight in — email verification is a separate soft gate elsewhere in
// the app (organizations.email_verified_at), never checked by POST
// /api/login itself, so skipping it here is faithful to real login
// behavior, not a shortcut around it.
async function createOrgWithAdmin(app, { orgName = unique('Test Org') } = {}) {
  const email = `${unique('admin')}@example.com`;
  const password = 'Test-Password-123!';
  const name = 'Test Admin';

  const signupRes = await request(app).post('/api/organizations/signup').send({
    organizationName: orgName,
    email,
    password,
    name,
    accessCode: process.env.PLATFORM_OWNER_SECRET,
    acceptedTos: true,
  });
  if (signupRes.status !== 201 && signupRes.status !== 200) {
    throw new Error(`Fixture signup failed (${signupRes.status}): ${JSON.stringify(signupRes.body)}`);
  }

  const loginRes = await request(app).post('/api/login').send({ email, password, audience: 'admin' });
  if (loginRes.status !== 200 || !loginRes.body.token) {
    throw new Error(`Fixture admin login failed (${loginRes.status}): ${JSON.stringify(loginRes.body)}`);
  }

  // The login response body's `user` object carries organization_name, not
  // organizationId — decoding the token itself (mintSessionToken's own
  // payload shape: userId/role/organizationId/orgUnitId) is the reliable
  // way to get it back out.
  const decoded = jwt.decode(loginRes.body.token);

  return {
    orgName,
    adminEmail: email,
    adminPassword: password,
    adminToken: loginRes.body.token,
    organizationId: decoded.organizationId,
  };
}

// Adds one teacher to an already-created org via the real admin route, and
// logs in as them. Requires an admin's own bearer token (ownership of the
// org being added to is enforced server-side from that token, not passed
// explicitly).
async function createTeacher(app, adminToken, { name = 'Test Teacher' } = {}) {
  const email = `${unique('teacher')}@example.com`;
  const createRes = await request(app)
    .post('/api/admin/create-teacher')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name, email });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`Fixture create-teacher failed (${createRes.status}): ${JSON.stringify(createRes.body)}`);
  }
  return { email, tempPassword: createRes.body.temporaryPassword, teacherId: createRes.body.teacher?.id };
}

// Same idea for a student — create-student's own response shape mirrors
// create-teacher's (temp password issued server-side, emailed out in real
// use, returned directly here since mailer.js has nothing configured in
// the test env and degrades gracefully rather than actually sending).
async function createStudent(app, adminToken, { name = 'Test Student', orgUnitId } = {}) {
  const email = `${unique('student')}@example.com`;
  const createRes = await request(app)
    .post('/api/admin/create-student')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name, email, orgUnitId });
  if (createRes.status !== 201 && createRes.status !== 200) {
    throw new Error(`Fixture create-student failed (${createRes.status}): ${JSON.stringify(createRes.body)}`);
  }
  return { email, tempPassword: createRes.body.temporaryPassword, studentId: createRes.body.student?.id };
}

// A teacher/student's account is created BY an admin, so their first-ever
// login doesn't get a real session token — mintTosPendingToken's own
// comment explains why: POST /api/login returns {requiresTosAcceptance,
// tosPendingToken} instead, and only POST /api/login/accept-tos exchanges
// that for a real usable token. Logging in through this helper (rather
// than assuming a bare POST /api/login already returns `token`) is what a
// real first-time teacher/student login actually requires.
async function loginFirstTime(app, email, password, audience) {
  const loginRes = await request(app).post('/api/login').send({ email, password, audience });
  if (loginRes.status !== 200) {
    throw new Error(`Fixture login failed (${loginRes.status}): ${JSON.stringify(loginRes.body)}`);
  }
  if (loginRes.body.token) return loginRes.body.token;
  if (!loginRes.body.requiresTosAcceptance) {
    throw new Error(`Fixture login returned neither a token nor requiresTosAcceptance: ${JSON.stringify(loginRes.body)}`);
  }
  const tosRes = await request(app).post('/api/login/accept-tos').send({ tosPendingToken: loginRes.body.tosPendingToken });
  if (tosRes.status !== 200 || !tosRes.body.token) {
    throw new Error(`Fixture accept-tos failed (${tosRes.status}): ${JSON.stringify(tosRes.body)}`);
  }
  return tosRes.body.token;
}

module.exports = { createOrgWithAdmin, createTeacher, createStudent, loginFirstTime, unique };
