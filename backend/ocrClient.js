// Text transcription: Gemini API (plain HTTPS fetch, no SDK — same posture
// as mailer.js's Gmail call and aiGrading.js's Groq call). Used to be a
// self-hosted EasyOCR (detection) + TrOCR (recognition) pipeline on the
// HonorRoll HF Space, but TrOCR-base-handwritten is trained only on IAM —
// natural handwritten English prose — and produced confident nonsense on
// anything else: code, math notation, chemistry symbols, Greek letters.
// Gemini's broad multimodal training actually handles that variety, and it
// accepts a PDF directly (no need to rasterize pages or detect lines
// ourselves first) — one call per submission replaces the whole detect->
// crop->recognize pipeline.
//
// Handwriting-style fingerprint (stroke width/slant/ink density, used only
// as a review-only plagiarism signal — see scan_handwriting_flags in
// index.js) is NOT something an LLM call produces; that's still computed
// by the HF Space (see ../ocr-space/app.py), now stripped down to just
// that pure-OpenCV piece. This module calls both and combines them into
// the same { pages, handwriting_features } shape callers already expect —
// see runOcr's own comment for exactly how failures in each half differ.
const { Client } = require('@gradio/client');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_URL = () => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

// The only hard requirement — text transcription is the actual point of
// this module. The HF Space vars below gate a best-effort secondary signal
// only (see isHandwritingFeaturesConfigured), not this.
function isOcrConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

function isHandwritingFeaturesConfigured() {
  return !!(process.env.OCR_SPACE_ID && process.env.OCR_SHARED_SECRET && process.env.HF_TOKEN);
}

const TRANSCRIBE_PROMPT = `You are transcribing a scanned handwritten student answer sheet, page by page. The answers may cover any school subject — plain prose, source code, mathematics, chemistry, physics — and may use Greek letters, subscripts/superscripts, chemical formulas, reaction arrows, or programming syntax.

Rules:
- Transcribe EXACTLY what is written. Do not solve problems, correct mistakes, answer questions, or add anything not actually on the page.
- Preserve code verbatim: exact syntax, brackets, semicolons, indentation as best you can tell.
- Preserve math/chemistry/physics notation using standard Unicode characters where possible (e.g. √ × ÷ ± ° α β θ π Σ Δ, subscripts/superscripts), or a plain-text equivalent (e.g. "x^2", "H2O", "a/b") when a symbol can't be represented.
- If a page is blank or a section is genuinely illegible, say so plainly (e.g. "[blank]" or "[illegible]") rather than guessing.
- One entry per page, in order.

For each page, also self-rate how confident you are in the transcription's accuracy, from 0 (mostly guessing) to 1 (fully legible and certain).`;

const PAGES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    pages: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          page: { type: 'INTEGER' },
          text: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
        },
        required: ['page', 'text', 'confidence'],
      },
    },
  },
  required: ['pages'],
};

async function transcribeWithGemini(pdfBuffer) {
  const res = await fetch(GEMINI_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
          { text: TRANSCRIBE_PROMPT },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: PAGES_SCHEMA },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API returned ${res.status}: ${body}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no transcription content');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.pages)) throw new Error('Gemini response missing pages array');
  return parsed.pages;
}

let gradioClientPromise = null;
function getGradioClient() {
  // Cached — Client.connect() does a handshake with the Space, no need to
  // repeat that per call. Space cold-starts (waking from sleep on the free
  // tier) are absorbed inside client.predict() itself, not here.
  if (!gradioClientPromise) {
    gradioClientPromise = Client.connect(process.env.OCR_SPACE_ID, { token: process.env.HF_TOKEN })
      .catch((err) => { gradioClientPromise = null; throw err; }); // don't cache a failed connection
  }
  return gradioClientPromise;
}

// Best-effort — a broken/unconfigured Space shouldn't block the actual
// transcription from being saved. Returns null (not a throw) on any
// failure; the caller logs and moves on with handwriting_features: null.
async function fetchHandwritingFeatures(pdfBuffer) {
  if (!isHandwritingFeaturesConfigured()) return null;
  try {
    const client = await getGradioClient();
    // A raw Buffer would go through handle_file() as a nameless/typeless
    // Blob, which the Space's gr.File(file_types=['.pdf']) input rejects
    // outright — it needs a filename ending in .pdf to pass that check.
    const file = new File([pdfBuffer], 'scan.pdf', { type: 'application/pdf' });
    const result = await client.predict('/handwriting-features', [file, process.env.OCR_SHARED_SECRET]);
    const data = result.data[0];
    if (data && data.error) throw new Error(`Handwriting-features Space error: ${data.error}`);
    return data?.handwriting_features ?? null;
  } catch (err) {
    console.error('Handwriting-features fetch failed (continuing without it):', err);
    return null;
  }
}

// pdfBuffer: Buffer of the submission's PDF bytes (already downloaded from
// B2 by the caller). Returns { pages: [{page, text, confidence}],
// handwriting_features: {...} | null }. Throws only on a transcription
// failure — the deadline sweep's per-submission try/catch is what turns
// that into an ocr_failed/ocr_error row rather than crashing the whole
// sweep. A handwriting-features failure never throws (see above) — that
// signal is a nice-to-have, not something worth losing a whole submission's
// transcription over.
async function runOcr(pdfBuffer) {
  if (!isOcrConfigured()) throw new Error('OCR is not configured (GEMINI_API_KEY missing)');

  const [pages, handwritingFeatures] = await Promise.all([
    transcribeWithGemini(pdfBuffer),
    fetchHandwritingFeatures(pdfBuffer),
  ]);

  return { pages, handwriting_features: handwritingFeatures };
}

module.exports = { isOcrConfigured, runOcr };
