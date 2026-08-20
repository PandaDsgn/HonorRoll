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

async function uploadScanPdf(objectKey, buffer) {
  const client = getB2Client();
  if (!client) throw new Error('B2 is not configured');
  await client.send(new PutObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: objectKey,
    Body: buffer,
    ContentType: 'application/pdf',
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
// for browser viewing, this is for server-side re-fetching.
async function downloadScanPdf(objectKey) {
  const client = getB2Client();
  if (!client) throw new Error('B2 is not configured');
  const res = await client.send(new GetObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: objectKey }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
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

module.exports = { isB2Configured, scanObjectKey, uploadScanPdf, getScanPdfUrl, downloadScanPdf, deleteScanPdf };
