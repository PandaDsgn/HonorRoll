// True end-to-end encryption for the chat feature — every function here
// runs entirely in the browser via the native Web Crypto API (no
// third-party crypto library; ECDH/AES-GCM/PBKDF2 are all natively
// supported). The backend (routes/chat.js) only ever sees the outputs of
// encrypt()/wrapPrivateKey() below — ciphertext and an opaque wrapped-key
// blob it has no way to open.
//
// Key model: each user has one ECDH (P-256) keypair. The public key is
// uploaded in the clear (it's not secret). The private key is exported,
// then encrypted ("wrapped") with an AES-GCM key derived from the user's
// own account password via PBKDF2 — same password everywhere means the
// same wrapping key everywhere, so the SAME private key can be recovered
// on any device the user logs into, without the server ever holding key
// material it can read. See Login.jsx's ensureE2eeKeys() for where this
// gets called, and schema/index.js's own comment on why a password RESET
// (as opposed to a normal login) can't recover it.
//
// Per-conversation keys are never stored anywhere: the AES-GCM key shared
// between two people is re-derived on demand via ECDH ("my private key +
// their public key"), which produces the identical key from either side —
// see deriveSharedKey.

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

export async function generateKeypair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
}

export async function exportPublicKeyJwk(publicKey) {
  return JSON.stringify(await crypto.subtle.exportKey('jwk', publicKey));
}

// 210,000 iterations of PBKDF2-SHA256 matches OWASP's current baseline
// recommendation for password-based key derivation — expensive enough to
// meaningfully slow a brute-force guess of the account password, cheap
// enough (well under a second) to run once at login without the user
// noticing.
async function derivePasswordWrappingKey(password, saltBuf) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations: 210000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Returns {wrappedPrivateKey, wrapSalt, wrapIv} — all base64, all safe to
// upload to PUT /api/chat/keys/me as-is. The plaintext private key and the
// plaintext password both only ever exist in this function's own local
// variables, never persisted or sent anywhere themselves.
export async function wrapPrivateKey(privateKey, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await derivePasswordWrappingKey(password, salt);
  const privateKeyJwkBytes = new TextEncoder().encode(JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey)));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, privateKeyJwkBytes);
  return {
    wrappedPrivateKey: bufToBase64(wrapped),
    wrapSalt: bufToBase64(salt),
    wrapIv: bufToBase64(iv),
  };
}

// The inverse of wrapPrivateKey — {wrappedPrivateKey, wrapSalt, wrapIv} is
// exactly what GET /api/chat/keys/me returns. Throws if `password` is
// wrong (AES-GCM's own authentication tag fails to verify), which is the
// correct behavior — there's no way to tell "wrong password" from
// "corrupted blob" and no need to, since the caller should treat both the
// same way (fail closed, don't recover a private key from a mismatch).
export async function unwrapPrivateKey({ wrappedPrivateKey, wrapSalt, wrapIv }, password) {
  const wrappingKey = await derivePasswordWrappingKey(password, base64ToBuf(wrapSalt));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(wrapIv) }, wrappingKey, base64ToBuf(wrappedPrivateKey));
  const jwk = JSON.parse(new TextDecoder().decode(decrypted));
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
}

// ECDH key agreement — myPrivateKey + theirPublicKeyJwk (a JSON string, as
// stored/returned by the backend) produces the exact same AES-GCM key
// theirPrivateKey + myPublicKeyJwk would produce on their side. Neither
// side ever transmits this key; it's derived locally, every time it's
// needed, from public material plus a private key that never leaves the
// device it was unwrapped on.
export async function deriveSharedKey(myPrivateKey, theirPublicKeyJwkString) {
  const theirPublicKey = await crypto.subtle.importKey(
    'jwk', JSON.parse(theirPublicKeyJwkString), { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey }, myPrivateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function encryptMessage(sharedKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, new TextEncoder().encode(plaintext));
  return { ciphertext: bufToBase64(ciphertext), iv: bufToBase64(iv) };
}

export async function decryptMessage(sharedKey, ciphertextB64, ivB64) {
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(ivB64) }, sharedKey, base64ToBuf(ciphertextB64));
  return new TextDecoder().decode(plainBuf);
}

// Same AES-GCM call as encryptMessage/decryptMessage above, just skipping
// the TextEncoder/TextDecoder step — for a chat attachment (photo/video/
// voice/document), where the payload is already raw bytes (from a File's
// own .arrayBuffer(), or a MediaRecorder Blob's) rather than a string.
// Returns/accepts a raw ArrayBuffer, not base64 — the caller is the one
// uploading a Blob (POST /api/chat/.../messages' multipart file field) or
// fetching one back (the presigned attachmentUrl GET already returns), so
// base64 round-tripping here would just be wasted work.
export async function encryptBytes(sharedKey, arrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, arrayBuffer);
  return { ciphertext, iv: bufToBase64(iv) };
}

export async function decryptBytes(sharedKey, ciphertextArrayBuffer, ivB64) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(ivB64) }, sharedKey, ciphertextArrayBuffer);
}
