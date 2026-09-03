const request = require('supertest');
const { webcrypto } = require('crypto');
const app = require('../index');
const { pool } = require('../lib/db');
const { createOrgWithAdmin, createStudent, loginFirstTime, unique } = require('./helpers/fixtures');

// End-to-end smoke test for the encrypted chat feature (routes/chat.js):
// contact resolution follows the exact same subject_teachers relationship
// doubts.js already uses, and — the actual point of this feature — a real
// ECDH+AES-GCM round trip via Node's own WebCrypto (identical API to a
// browser's) proves messages genuinely travel as ciphertext the server
// never has any way to read, not just "trust the code review."
async function generateKeypair() {
  return webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
}
async function exportPublicJwk(publicKey) {
  return JSON.stringify(await webcrypto.subtle.exportKey('jwk', publicKey));
}
async function deriveSharedKey(myPrivateKey, theirPublicJwkString) {
  const theirPublicKey = await webcrypto.subtle.importKey(
    'jwk', JSON.parse(theirPublicJwkString), { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  return webcrypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey }, myPrivateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
async function encrypt(key, plaintext) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: Buffer.from(ciphertextBuf).toString('base64'), iv: Buffer.from(iv).toString('base64') };
}
async function decrypt(key, ciphertextB64, ivB64) {
  const plainBuf = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(ivB64, 'base64') }, key, Buffer.from(ciphertextB64, 'base64')
  );
  return new TextDecoder().decode(plainBuf);
}

describe('chat routes', () => {
  let adminToken;
  let teacherToken;
  let teacherId;
  let studentToken;
  let studentId;
  let outsiderTeacherToken;
  let outsiderTeacherId;

  beforeAll(async () => {
    ({ adminToken } = await createOrgWithAdmin(app));

    const levelRes = await request(app).post('/api/admin/org-levels').set('Authorization', `Bearer ${adminToken}`).send({ label: 'Year' });
    const levelDefId = levelRes.body.level.id;
    const unitRes = await request(app).post('/api/admin/org-units').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Year 1', levelDefId, parentUnitId: null });
    const orgUnitId = unitRes.body.unit.id;
    const subjectRes = await request(app).post('/api/admin/subjects').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Chemistry', orgUnitId });
    const subjectId = subjectRes.body.subject.id;

    const teacherEmail = `${unique('teacher')}@example.com`;
    const teacherCreateRes = await request(app).post('/api/admin/create-teacher').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Chem Teacher', email: teacherEmail, orgUnitId });
    teacherId = teacherCreateRes.body.teacher.id;
    teacherToken = await loginFirstTime(app, teacherEmail, teacherCreateRes.body.temporaryPassword, 'teacher');
    await request(app).post(`/api/admin/subjects/${subjectId}/teachers`).set('Authorization', `Bearer ${adminToken}`).send({ userId: teacherId });

    const student = await createStudent(app, adminToken, { name: 'Chem Student', orgUnitId });
    studentId = student.studentId;
    studentToken = await loginFirstTime(app, student.email, student.tempPassword, 'student');

    // A second, unrelated org unit with its own teacher — never assigned
    // to any subject the student can see, so canChat() must reject them.
    const otherUnitRes = await request(app).post('/api/admin/org-units').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Year 2', levelDefId, parentUnitId: null });
    const outsiderEmail = `${unique('outsider')}@example.com`;
    const outsiderCreateRes = await request(app).post('/api/admin/create-teacher').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Outsider Teacher', email: outsiderEmail, orgUnitId: otherUnitRes.body.unit.id });
    outsiderTeacherId = outsiderCreateRes.body.teacher.id;
    outsiderTeacherToken = await loginFirstTime(app, outsiderEmail, outsiderCreateRes.body.temporaryPassword, 'teacher');
  });

  it('GET /api/chat/contacts requires auth', async () => {
    const res = await request(app).get('/api/chat/contacts');
    expect(res.status).toBe(401);
  });

  it('GET /api/chat/contacts (student) includes the subject teacher, not the outsider', async () => {
    const res = await request(app).get('/api/chat/contacts').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.contacts.map((c) => c.id);
    expect(ids).toContain(teacherId);
    expect(ids).not.toContain(outsiderTeacherId);
  });

  it('GET /api/chat/contacts (teacher) includes the student', async () => {
    const res = await request(app).get('/api/chat/contacts').set('Authorization', `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.contacts.map((c) => c.id)).toContain(studentId);
  });

  it('GET /api/chat/keys/me returns 404 before any key is uploaded', async () => {
    const res = await request(app).get('/api/chat/keys/me').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(404);
  });

  let studentKeypair, teacherKeypair;

  it('PUT /api/chat/keys/me uploads a public key + opaque wrapped-private-key blob', async () => {
    studentKeypair = await generateKeypair();
    const publicKeyJwk = await exportPublicJwk(studentKeypair.publicKey);
    const res = await request(app)
      .put('/api/chat/keys/me')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ publicKeyJwk, wrappedPrivateKey: 'opaque-blob-the-server-cannot-read', wrapSalt: 'c2FsdA==', wrapIv: 'aXY=' });
    expect(res.status).toBe(200);

    teacherKeypair = await generateKeypair();
    const teacherPublicKeyJwk = await exportPublicJwk(teacherKeypair.publicKey);
    const teacherRes = await request(app)
      .put('/api/chat/keys/me')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ publicKeyJwk: teacherPublicKeyJwk, wrappedPrivateKey: 'another-opaque-blob', wrapSalt: 'c2FsdA==', wrapIv: 'aXY=' });
    expect(teacherRes.status).toBe(200);
  });

  it('GET /api/chat/keys/me now returns exactly what was uploaded', async () => {
    const res = await request(app).get('/api/chat/keys/me').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.wrappedPrivateKey).toBe('opaque-blob-the-server-cannot-read');
  });

  it("GET /api/chat/keys/:userId (student fetching teacher's public key) succeeds now that it's uploaded", async () => {
    const res = await request(app).get(`/api/chat/keys/${teacherId}`).set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.publicKeyJwk).toBeDefined();
  });

  it('GET /api/chat/keys/:userId rejects a non-contact (outsider teacher)', async () => {
    const res = await request(app).get(`/api/chat/keys/${outsiderTeacherId}`).set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });

  const plaintext = 'Could you go over today\'s titration lab results with me?';
  let messageId;

  it('a real ECDH+AES-GCM message round-trips: sent as ciphertext, stored as ciphertext, decrypts back to the exact original text', async () => {
    const studentSharedKey = await deriveSharedKey(studentKeypair.privateKey, await exportPublicJwk(teacherKeypair.publicKey));
    const { ciphertext, iv } = await encrypt(studentSharedKey, plaintext);

    const postRes = await request(app)
      .post(`/api/chat/${teacherId}/messages`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ ciphertext, iv });
    expect(postRes.status).toBe(201);
    messageId = postRes.body.id;

    // The server's own stored/returned ciphertext must never contain the
    // plaintext substring anywhere — a real, automated check that
    // encryption actually happened, not just that the code compiles.
    expect(ciphertext).not.toContain(plaintext);
    expect(Buffer.from(ciphertext, 'base64').toString('latin1')).not.toContain(plaintext);

    const getRes = await request(app).get(`/api/chat/${studentId}/messages`).set('Authorization', `Bearer ${teacherToken}`);
    expect(getRes.status).toBe(200);
    const row = getRes.body.messages.find((m) => m.id === messageId);
    expect(row).toBeDefined();
    expect(row.fromMe).toBe(false);
    expect(row.ciphertext).not.toContain(plaintext);
    expect(row.hasAttachment).toBe(false);
    expect(row.attachmentUrl).toBeUndefined();

    const teacherSharedKey = await deriveSharedKey(teacherKeypair.privateKey, await exportPublicJwk(studentKeypair.publicKey));
    const decrypted = await decrypt(teacherSharedKey, row.ciphertext, row.iv);
    expect(decrypted).toBe(plaintext);
  });

  it('the resulting notification never leaks the plaintext, only who it is from', async () => {
    const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    const notif = res.body.notifications.find((n) => n.type === 'chat');
    expect(notif).toBeDefined();
    expect(notif.body).not.toContain(plaintext);
    expect(notif.body).toContain('Chem Student');
  });

  it('POST /api/chat/:otherUserId/messages rejects a non-contact pair', async () => {
    const res = await request(app)
      .post(`/api/chat/${studentId}/messages`)
      .set('Authorization', `Bearer ${outsiderTeacherToken}`)
      .send({ ciphertext: 'ZmFrZQ==', iv: 'ZmFrZQ==' });
    expect(res.status).toBe(403);
  });

  it('GET /api/chat/:otherUserId/messages rejects a non-contact pair', async () => {
    const res = await request(app).get(`/api/chat/${studentId}/messages`).set('Authorization', `Bearer ${outsiderTeacherToken}`);
    expect(res.status).toBe(403);
  });

  // Attachment validation — B2 isn't configured in the test env (see
  // tests/setupEnv.js), so these can't exercise a real upload, but they do
  // prove the request-shape validation for non-text message types works:
  // a well-formed attachment request gets as far as "recognized, storage
  // unavailable" (503) rather than being rejected outright, and a
  // malformed one (bad type, or a type that requires a file with none
  // attached) is rejected before ever reaching the storage layer at all.
  it('POST /api/chat/:otherUserId/messages rejects an invalid messageType', async () => {
    const res = await request(app)
      .post(`/api/chat/${teacherId}/messages`)
      .set('Authorization', `Bearer ${studentToken}`)
      .field('messageType', 'bogus')
      .field('iv', 'ZmFrZQ==');
    expect(res.status).toBe(400);
  });

  it('POST /api/chat/:otherUserId/messages rejects a non-text type with no file attached', async () => {
    const res = await request(app)
      .post(`/api/chat/${teacherId}/messages`)
      .set('Authorization', `Bearer ${studentToken}`)
      .field('messageType', 'photo')
      .field('iv', 'ZmFrZQ==');
    expect(res.status).toBe(400);
  });

  it('POST /api/chat/:otherUserId/messages recognizes a well-formed attachment (503, storage not configured — not a 400)', async () => {
    const res = await request(app)
      .post(`/api/chat/${teacherId}/messages`)
      .set('Authorization', `Bearer ${studentToken}`)
      .field('messageType', 'photo')
      .field('iv', 'ZmFrZQ==')
      .attach('file', Buffer.from('fake pre-encrypted bytes'), { filename: 'photo.enc', contentType: 'application/octet-stream' });
    expect(res.status).toBe(503);
  });

  // The attachment bytes are fetched through this route (not a presigned
  // B2 URL handed to the client) specifically because B2 sends no CORS
  // headers, so a browser fetch() reading a cross-origin response body
  // would otherwise always fail — see that route's own comment.
  describe('GET .../messages/:messageId/attachment', () => {
    let photoMessageId;

    beforeAll(async () => {
      const insertRes = await pool.query(
        `INSERT INTO chat_messages (organization_id, sender_id, recipient_id, message_type, iv, storage_key)
         VALUES ((SELECT organization_id FROM chat_messages WHERE id = $1), $2, $3, 'photo', 'ZmFrZQ==', 'fake-key')
         RETURNING id`,
        [messageId, studentId, teacherId]
      );
      photoMessageId = insertRes.rows[0].id;
    });

    it('rejects a non-contact pair', async () => {
      const res = await request(app)
        .get(`/api/chat/${studentId}/messages/${photoMessageId}/attachment`)
        .set('Authorization', `Bearer ${outsiderTeacherToken}`);
      expect(res.status).toBe(404);
    });

    it('rejects a message id that does not belong to this thread', async () => {
      const res = await request(app)
        .get(`/api/chat/${outsiderTeacherId}/messages/${photoMessageId}/attachment`)
        .set('Authorization', `Bearer ${teacherToken}`);
      expect(res.status).toBe(404);
    });

    it('404s a text message (no storage_key to fetch)', async () => {
      const res = await request(app)
        .get(`/api/chat/${teacherId}/messages/${messageId}/attachment`)
        .set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(404);
    });

    it('recognizes a real attachment (503, storage not configured in the test env — not a 404)', async () => {
      const res = await request(app)
        .get(`/api/chat/${teacherId}/messages/${photoMessageId}/attachment`)
        .set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(503);
    });
  });

  // Reporting — the only safety mechanism true E2EE chat can have (see
  // routes/chat.js's own comment). `messageId` here is the earlier
  // student -> teacher text message from the round-trip test above, so
  // the teacher is its recipient and the only one who can report it.
  describe('message reporting', () => {
    let reportId;

    it('POST .../report rejects the sender reporting their own message', async () => {
      const res = await request(app)
        .post(`/api/chat/${teacherId}/messages/${messageId}/report`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ plaintextContent: plaintext });
      expect(res.status).toBe(403);
    });

    it('POST .../report rejects reporting a non-text message', async () => {
      const nonTextRes = await pool.query(
        `INSERT INTO chat_messages (organization_id, sender_id, recipient_id, message_type, iv, storage_key)
         VALUES ((SELECT organization_id FROM chat_messages WHERE id = $1), $2, $3, 'photo', 'ZmFrZQ==', 'fake-key')
         RETURNING id`,
        [messageId, studentId, teacherId]
      );
      const nonTextMessageId = nonTextRes.rows[0].id;
      const res = await request(app)
        .post(`/api/chat/${studentId}/messages/${nonTextMessageId}/report`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ plaintextContent: 'irrelevant' });
      expect(res.status).toBe(400);
    });

    it('POST .../report succeeds for the recipient reporting a text message', async () => {
      const res = await request(app)
        .post(`/api/chat/${studentId}/messages/${messageId}/report`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ plaintextContent: plaintext, note: 'seems off' });
      expect(res.status).toBe(201);
      reportId = res.body.id;
    });

    it('GET .../messages shows reportedByMe true for the reporter (and stays true across a fresh fetch)', async () => {
      const res = await request(app).get(`/api/chat/${studentId}/messages`).set('Authorization', `Bearer ${teacherToken}`);
      expect(res.body.messages.find((m) => m.id === messageId).reportedByMe).toBe(true);
    });

    it('GET .../messages shows reportedByMe false for the reported user (report identity is per-reporter, not global)', async () => {
      const res = await request(app).get(`/api/chat/${teacherId}/messages`).set('Authorization', `Bearer ${studentToken}`);
      expect(res.body.messages.find((m) => m.id === messageId).reportedByMe).toBe(false);
    });

    it('POST .../report rejects a duplicate report of the same message by the same reporter', async () => {
      const res = await request(app)
        .post(`/api/chat/${studentId}/messages/${messageId}/report`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ plaintextContent: plaintext });
      expect(res.status).toBe(409);
    });

    it('GET /api/admin/chat-reports (admin) sees the report, with the reported plaintext', async () => {
      const res = await request(app).get('/api/admin/chat-reports').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const row = res.body.reports.find((r) => r.id === reportId);
      expect(row).toBeDefined();
      expect(row.plaintextContent).toBe(plaintext);
      expect(row.reporterNote).toBe('seems off');
      expect(row.status).toBe('open');
    });

    it('GET /api/admin/chat-reports rejects a non-admin', async () => {
      const res = await request(app).get('/api/admin/chat-reports').set('Authorization', `Bearer ${teacherToken}`);
      expect(res.status).toBe(403);
    });

    it('PUT /api/admin/chat-reports/:id marks a report reviewed', async () => {
      const putRes = await request(app)
        .put(`/api/admin/chat-reports/${reportId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'reviewed' });
      expect(putRes.status).toBe(200);

      const getRes = await request(app).get('/api/admin/chat-reports').set('Authorization', `Bearer ${adminToken}`);
      expect(getRes.body.reports.find((r) => r.id === reportId).status).toBe('reviewed');
    });
  });

  // Editing — text-only, sender-only, within 15 minutes of created_at
  // (see routes/chat.js's EDIT_WINDOW_MS). `messageId` is still the same
  // student -> teacher text message from the round-trip test at the top
  // of this file, unaffected by the reporting tests above (reporting
  // never touches the message row itself).
  describe('message editing', () => {
    it('PUT .../messages/:messageId rejects the non-sender (recipient) editing it', async () => {
      const res = await request(app)
        .put(`/api/chat/${studentId}/messages/${messageId}`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ ciphertext: 'ZmFrZQ==', iv: 'ZmFrZQ==' });
      expect(res.status).toBe(403);
    });

    it('PUT .../messages/:messageId rejects editing a non-text message', async () => {
      const nonTextRes = await pool.query(
        `INSERT INTO chat_messages (organization_id, sender_id, recipient_id, message_type, iv, storage_key)
         VALUES ((SELECT organization_id FROM chat_messages WHERE id = $1), $2, $3, 'photo', 'ZmFrZQ==', 'fake-key')
         RETURNING id`,
        [messageId, studentId, teacherId]
      );
      const res = await request(app)
        .put(`/api/chat/${teacherId}/messages/${nonTextRes.rows[0].id}`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ ciphertext: 'ZmFrZQ==', iv: 'ZmFrZQ==' });
      expect(res.status).toBe(400);
    });

    it('PUT .../messages/:messageId rejects an expired edit window', async () => {
      const oldRes = await pool.query(
        `INSERT INTO chat_messages (organization_id, sender_id, recipient_id, message_type, ciphertext, iv, created_at)
         VALUES ((SELECT organization_id FROM chat_messages WHERE id = $1), $2, $3, 'text', 'ZmFrZQ==', 'ZmFrZQ==', now() - interval '16 minutes')
         RETURNING id`,
        [messageId, studentId, teacherId]
      );
      const res = await request(app)
        .put(`/api/chat/${teacherId}/messages/${oldRes.rows[0].id}`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ ciphertext: 'ZmFrZQ==', iv: 'ZmFrZQ==' });
      expect(res.status).toBe(400);
    });

    it('PUT .../messages/:messageId lets the sender edit within the window; the refetched thread shows the new content and editedAt', async () => {
      const newPlaintext = 'Actually, could we push this to tomorrow instead?';
      const studentSharedKey = await deriveSharedKey(studentKeypair.privateKey, await exportPublicJwk(teacherKeypair.publicKey));
      const { ciphertext, iv } = await encrypt(studentSharedKey, newPlaintext);

      const putRes = await request(app)
        .put(`/api/chat/${teacherId}/messages/${messageId}`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ ciphertext, iv });
      expect(putRes.status).toBe(200);
      expect(putRes.body.editedAt).toBeDefined();

      const getRes = await request(app).get(`/api/chat/${teacherId}/messages`).set('Authorization', `Bearer ${studentToken}`);
      const row = getRes.body.messages.find((m) => m.id === messageId);
      expect(row.editedAt).toBeDefined();
      const teacherSharedKey = await deriveSharedKey(teacherKeypair.privateKey, await exportPublicJwk(studentKeypair.publicKey));
      expect(await decrypt(teacherSharedKey, row.ciphertext, row.iv)).toBe(newPlaintext);
    });
  });

  // Read receipts — a fresh message end-to-end, since `messageId` above
  // already got marked read by the very first round-trip test in this
  // file (its own GET as the teacher already did that).
  describe('read receipts', () => {
    it('a new message starts unread, then shows readAt once the recipient has fetched the thread', async () => {
      const studentSharedKey = await deriveSharedKey(studentKeypair.privateKey, await exportPublicJwk(teacherKeypair.publicKey));
      const { ciphertext, iv } = await encrypt(studentSharedKey, 'One more thing —');
      const postRes = await request(app)
        .post(`/api/chat/${teacherId}/messages`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ ciphertext, iv });
      const newMessageId = postRes.body.id;

      const beforeRes = await request(app).get(`/api/chat/${teacherId}/messages`).set('Authorization', `Bearer ${studentToken}`);
      expect(beforeRes.body.messages.find((m) => m.id === newMessageId).readAt).toBeNull();

      // The recipient (teacher) opening the thread is what marks it read.
      await request(app).get(`/api/chat/${studentId}/messages`).set('Authorization', `Bearer ${teacherToken}`);

      const afterRes = await request(app).get(`/api/chat/${teacherId}/messages`).set('Authorization', `Bearer ${studentToken}`);
      expect(afterRes.body.messages.find((m) => m.id === newMessageId).readAt).not.toBeNull();
    });
  });
});
