// Wrapper around the HonorRoll OCR Hugging Face Space (see ../ocr-space/
// app.py) — calls its auto-generated Gradio API via @gradio/client rather
// than a hand-rolled multipart POST, since Gradio Spaces (not Docker —
// Docker Spaces now require a paid HF plan) expose their functions through
// Gradio's own queue/predict protocol, not a plain REST route. Follows the
// same lazy-config-check posture as storage.js/mailer.js: no client built
// until every required env var exists, so an unconfigured deploy degrades
// gracefully (deadline sweep logs and retries later) instead of crashing
// at boot.
//
// Two required env vars beyond the shared secret: OCR_SPACE_ID (the
// Space's "username/space-name", not a URL — @gradio/client resolves the
// actual endpoint itself) and HF_TOKEN, a Hugging Face access token for an
// account with access to the Space — required because the Space is
// private (calling any private Space's API needs one, regardless of the
// shared-secret check inside the function itself).
const { Client, handle_file } = require('@gradio/client');

function isOcrConfigured() {
  return !!(process.env.OCR_SPACE_ID && process.env.OCR_SHARED_SECRET && process.env.HF_TOKEN);
}

let clientPromise = null;
function getClient() {
  // Cached — Client.connect() does a handshake with the Space, no need to
  // repeat that per OCR call. Space cold-starts (waking from sleep on the
  // free tier) are absorbed inside client.predict() itself, not here.
  if (!clientPromise) {
    clientPromise = Client.connect(process.env.OCR_SPACE_ID, { token: process.env.HF_TOKEN })
      .catch((err) => { clientPromise = null; throw err; }); // don't cache a failed connection
  }
  return clientPromise;
}

// pdfBuffer: Buffer of the submission's PDF bytes (already downloaded from
// B2 by the caller). Returns { pages: [{page, text, confidence}],
// handwriting_features: {...} }. Throws on any failure — the deadline
// sweep's per-submission try/catch is what turns that into an
// ocr_failed/ocr_error row rather than crashing the whole sweep.
async function runOcr(pdfBuffer) {
  if (!isOcrConfigured()) throw new Error('OCR is not configured (OCR_SPACE_ID/OCR_SHARED_SECRET/HF_TOKEN missing)');

  const client = await getClient();
  // Positional args, matching app.py's gr.Interface inputs=[pdf_file, shared_secret] order.
  const result = await client.predict('/ocr', [handle_file(pdfBuffer), process.env.OCR_SHARED_SECRET]);
  const data = result.data[0];
  if (data && data.error) throw new Error(`OCR Space error: ${data.error}`);
  return data;
}

module.exports = { isOcrConfigured, runOcr };
