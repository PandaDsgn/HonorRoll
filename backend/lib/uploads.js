// Shared multer instance for teacher notes (Uploads tab) and admin notices
// — the ONE upload config used by more than one route file, so it lives
// here rather than being duplicated. Requiring it back from index.js (were
// index.js circularly required FROM a route file instead) isn't safe since
// index.js's own module.exports isn't set until the very end of that file —
// a small standalone module sidesteps that entirely.
const multer = require('multer');

// In-memory only — CSV rosters are realistically tens to low-thousands of
// rows, never large enough to need disk storage or a streaming parser. 2MB
// cap is generous for a plain-text student roster.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// per-type mimetype check happens in the route itself once req.body.type is
// available (multer's fileFilter only sees fields that arrived on the wire
// before the file part, which the frontend can't be relied on to guarantee).
// 200MB covers a realistically long lecture-recording video, the largest
// file type this accepts — B2's 10GB free tier absorbs a modest number of
// these before it becomes a real capacity concern.
const notesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Backs both profile-photo and org-logo uploads (POST /api/me/photos and
// POST /api/admin/organization/logo) — same 5MB-ish sizing logic as the
// others: generous for a headshot or a letterhead logo, nowhere near
// notesUpload's 200MB video ceiling. Gated at the multer level (not
// deferred to the route like notesUpload) since every caller of this
// instance is always an image, unlike notesUpload's multi-type field.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

// Memory storage (not disk) — a scanned answer-sheet PDF is uploaded once,
// immediately forwarded to B2, then discarded; there's nothing to stream to
// disk for. 25MB covers a realistically long multi-page handwritten answer
// scanned at phone-camera resolution. Shared by exam scan-submit, problem
// scan-submit, and the admin scan-submissions upload route.
const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});

module.exports = { notesUpload, avatarUpload, scanUpload, csvUpload };
