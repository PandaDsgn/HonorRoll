// Orchestrates lib/e2ee.js's primitives into "does this device already
// have a usable private key, and if not, get one" — called once right
// after login (ensureE2eeKeys) and lazily by the chat page itself
// (getPrivateKey), since a page reload clears the in-memory cache below
// but not localStorage.
//
// The raw (unwrapped) private key is persisted locally on THIS device —
// in localStorage, same as frontend/src/lib/deviceId.js's own device-
// bound value — so a page refresh never needs the account password again.
// This is a normal, accepted part of client-side E2EE (Signal Desktop,
// WhatsApp Web, etc. all keep session key material on the device for
// exactly this reason): the guarantee "true end-to-end encryption" makes
// is that the SERVER never sees a private key or plaintext message, not
// that the user's own device is somehow off-limits to itself. The server
// (routes/chat.js, GET/PUT /api/chat/keys/me) only ever sees the
// password-wrapped form.
import axios from 'axios';
import { API } from '../config';
import { generateKeypair, exportPublicKeyJwk, wrapPrivateKey, unwrapPrivateKey } from './e2ee';

const LOCAL_PRIVATE_KEY_JWK = 'honorroll_e2ee_private_key_jwk';
let cachedPrivateKey = null;

async function importRawJwk(jwkJson) {
  return crypto.subtle.importKey('jwk', JSON.parse(jwkJson), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
}
async function persistLocally(privateKey) {
  localStorage.setItem(LOCAL_PRIVATE_KEY_JWK, JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey)));
}

// Called once, right after a successful login, while the plaintext
// password just typed is still in scope — see Login.jsx. Best-effort by
// design: the caller wraps this in try/catch and never lets a chat-setup
// failure block the login itself.
export async function ensureE2eeKeys(password) {
  const localJwk = localStorage.getItem(LOCAL_PRIVATE_KEY_JWK);
  if (localJwk) {
    cachedPrivateKey = await importRawJwk(localJwk);
    return;
  }
  try {
    const res = await axios.get(`${API}/api/chat/keys/me`);
    cachedPrivateKey = await unwrapPrivateKey(res.data, password);
    await persistLocally(cachedPrivateKey);
  } catch (err) {
    if (err.response?.status !== 404) throw err;
    // First time this account has ever used chat, on any device.
    const { publicKey, privateKey } = await generateKeypair();
    const wrapped = await wrapPrivateKey(privateKey, password);
    await axios.put(`${API}/api/chat/keys/me`, { publicKeyJwk: await exportPublicKeyJwk(publicKey), ...wrapped });
    cachedPrivateKey = privateKey;
    await persistLocally(privateKey);
  }
}

// Lazily recovers the key from this device's own local storage if the
// in-memory cache above was cleared by a page reload — the chat page
// calls this rather than assuming ensureE2eeKeys already ran this same
// page load. Returns null only if this device has never called
// ensureE2eeKeys successfully at all (e.g. it failed at the last login) —
// the chat page's own job to show a clear "log out and back in" message
// in that rare case, not this function's.
export async function getPrivateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;
  const localJwk = localStorage.getItem(LOCAL_PRIVATE_KEY_JWK);
  if (!localJwk) return null;
  cachedPrivateKey = await importRawJwk(localJwk);
  return cachedPrivateKey;
}

export function clearLocalE2eeKey() {
  localStorage.removeItem(LOCAL_PRIVATE_KEY_JWK);
  cachedPrivateKey = null;
}
