// Backs the new-device OTP step-up (see POST /api/login's isDeviceTrusted
// check on the backend, and Login.jsx's requiresDeviceVerification
// branch). A random id generated once and persisted in localStorage is
// the only practical way to say "this is the same browser as last time" —
// IPs rotate constantly (mobile networks, VPNs) and a user-agent string
// proves nothing on its own, so this is exactly as strong as "this
// browser still has that localStorage value," the same trust model every
// "remember this device" flow relies on. Clearing site data, private
// browsing, or a different browser all correctly produce a fresh id —
// that's not a bug, that's what makes "new device" mean anything.
const DEVICE_ID_KEY = 'honorroll_device_id';

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
