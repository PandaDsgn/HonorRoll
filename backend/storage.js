// Backblaze B2 (S3-compatible) client for scanned-assignment PDF storage.
// Kept out of index.js — this is the one piece of the scan-OCR feature that
// isn't a route handler, and the main file is already ~5200 lines.
//
// Chosen over Cloudflare R2: R2's free tier now requires a card on file to
// even enable the service (a recent Cloudflare change, not documented up
// front), whereas B2's 10GB free tier needs no billing details at all — a
// better fit for "stay free, no new paid infra." Same S3-compatible API
// either way, so this file barely differs from an R2 version — only the
// endpoint/credential shape changes.
//
// No fallback for any of these four env vars, same "no sane default for a
// secret" posture as JWT_SECRET/RAZORPAY_*: getB2Client() returns null when
// unconfigured, and every caller here checks for that and fails gracefully
// (503, not a crash) rather than the app refusing to boot at all — matches
// getRazorpayClient()'s pattern in index.js, since a school shouldn't be
// blocked from every other feature just because scanning hasn't been set up.
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let b2Client = null;
function getB2Client() {
  const { B2_ENDPOINT, B2_KEY_ID, B2_APPLICATION_KEY } = process.env;
  if (!B2_ENDPOINT || !B2_KEY_ID || !B2_APPLICATION_KEY) return null;
  if (!b2Client) {
    // B2_ENDPOINT is the bucket's S3 endpoint host shown in the B2 dashboard,
    // e.g. "s3.us-west-004.backblazeb2.com" — the region is always its
    // middle segment, so there's no separate region env var to get wrong.
    const region = B2_ENDPOINT.split('.')[1] || 'us-west-004';
    b2Client = new S3Client({
      region,
      endpoint: `https://${B2_ENDPOINT}`,
      credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APPLICATION_KEY },
    });
  }
  return b2Client;
}

function isB2Configured() {
  return getB2Client() !== null && !!process.env.B2_BUCKET_NAME;
}

// Object key convention: scans/<organizationId>/<problemId>/<submissionId>.pdf
function scanObjectKey(organizationId, problemId, submissionId) {
  return `scans/${organizationId}/${problemId}/${submissionId}.pdf`;
}

// Same idea as scanObjectKey, separate top-level prefix so an exam's and a
// problem's own id sequences can never collide on the same bucket path —
// see exam_items' 'scan' type / exam_attempts.scan_storage_key in index.js.
function examScanObjectKey(organizationId, examId, attemptId) {
  return `exam-scans/${organizationId}/${examId}/${attemptId}.pdf`;
}

// Separate top-level prefix again, same reasoning — a teacher-uploaded
// note file for the Uploads/Notes feature shares nothing with a scanned
// answer sheet except "it's a file in this same bucket." Keyed by a random
// UUID rather than the notes row's own id: the upload has to happen BEFORE
// the DB insert here (notes.storage_key is required non-empty by
// notes_content_check for every file-based type, so there's no placeholder-
// row-then-update-the-key step to get an id from first, unlike
// scanObjectKey's submissionId). Extension varies with the note's media
// type (pdf/image/video/audio) — passed in rather than hardcoded, unlike
// scanObjectKey/examScanObjectKey, which are always PDF.
function notesObjectKey(organizationId, subjectId, fileId, extension = '.pdf') {
  return `notes/${organizationId}/${subjectId}/${fileId}${extension}`;
}

// Same idea, one level shallower — a notice has no subject to key under
// (admin notices are org-wide, not attached to any one subject), so this
// only ever nests under organizationId before the random file id.
function noticesObjectKey(organizationId, fileId, extension = '.pdf') {
  return `notices/${organizationId}/${fileId}${extension}`;
}

// Same shape as notesObjectKey — a doubt's attachment is scoped to a
// subject the same way a note is. Default extension is .jpg (a photo,
// the common case) rather than .pdf, unlike every helper above.
function doubtsObjectKey(organizationId, subjectId, fileId, extension = '.jpg') {
  return `doubts/${organizationId}/${subjectId}/${fileId}${extension}`;
}

// A chat attachment's bytes are ciphertext (see routes/chat.js) — this
// server never learns what type of file it actually is, so there's no
// real extension to speak of; the default here is purely cosmetic (never
// read back or relied on for anything, unlike every other *ObjectKey's
// extension param).
function chatObjectKey(organizationId, senderId, fileId, extension = '.bin') {
  return `chat/${organizationId}/${senderId}/${fileId}${extension}`;
}

// Profile photos belong to the global user identity (see memberships'
// "users is pure identity" comment in index.js), not any one organization
// — a student who uploads a headshot can reuse it as the photo on every
// institution's ID card, hence userId (not organizationId) as the first
// segment. photoId is the user_photos row's own id, so re-uploading never
// collides with an earlier photo the user hasn't deleted yet.
function avatarObjectKey(userId, photoId, extension = '.jpg') {
  return `avatars/${userId}/${photoId}${extension}`;
}

// One logo per organization (no sub-id needed — uploading a new one just
// overwrites the same key, same as how a real institution replaces its
// letterhead rather than keeping every old version around).
function orgLogoObjectKey(organizationId, extension = '.png') {
  return `org-logos/${organizationId}${extension}`;
}

// contentType defaults to PDF for scanObjectKey/examScanObjectKey's own
// callers (unchanged behavior for them); the notes feature passes the
// uploaded file's real mimetype so an image/video/audio note is served back
// with the right Content-Type instead of being mislabeled as a PDF.
async function uploadScanPdf(objectKey, buffer, contentType = 'application/pdf') {
  const client = getB2Client();
  if (!client) throw new Error('B2 is not configured');
  await client.send(new PutObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: objectKey,
    Body: buffer,
    ContentType: contentType,
  }));
}

// Presigned GET, short-lived — used by the teacher-facing review UI in a
// later phase to view a submission's PDF without making the bucket public.
async function getScanPdfUrl(objectKey, expiresInSeconds = 900) {
  const client = getB2Client();
  if (!client) throw new Error('B2 is not configured');
  return getSignedUrl(client, new GetObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: objectKey }), { expiresIn: expiresInSeconds });
}

// Used by the OCR pipeline (see index.js's deadline sweep) to get the
// actual PDF bytes to send to the OCR Space — the presigned URL above is
// for browser viewing, this is for server-side re-fetching. Also reused by
// the ID card photo/logo proxy routes (see GET /api/me/id-card/:id/:kind)
// to stream an image through our own origin — B2 doesn't send CORS
// headers on these objects, so a browser-side canvas (html2canvas, for the
// "Download PNG" button) can read a plain <img src> of one just fine but
// can never read its pixels back out for export; proxying through a route
// that already carries our own CORS headers sidesteps that entirely.
async function downloadScanPdf(objectKey) {
  const client = getB2Client();
  if (!client) throw new Error('B2 is not configured');
  const res = await client.send(new GetObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: objectKey }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), contentType: res.ContentType };
}

// Called when a resubmission replaces an earlier one (only the final
// submission before an assignment's deadline is ever kept/graded — see
// POST /api/problems/:id/scan-submit) so the superseded PDF doesn't sit
// around in the bucket forever burning into the free tier's storage quota.
async function deleteScanPdf(objectKey) {
  const client = getB2Client();
  if (!client) throw new Error('B2 is not configured');
  await client.send(new DeleteObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: objectKey }));
}

module.exports = {
  isB2Configured, scanObjectKey, examScanObjectKey, notesObjectKey, noticesObjectKey,
  avatarObjectKey, orgLogoObjectKey, doubtsObjectKey, chatObjectKey,
  uploadScanPdf, getScanPdfUrl, downloadScanPdf, deleteScanPdf,
};
