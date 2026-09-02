// One shared WebSocket connection per logged-in session — replaces
// NotificationBell.jsx's old primary-path 30s poll, and is what the chat
// feature uses for instant delivery. A single module-level connection
// (not one per component) means the bell and the chat page can both react
// to the same socket without either owning its lifecycle or opening a
// second redundant connection.
import { API } from '../config';

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let currentToken = null;
const listeners = new Map(); // event name -> Set<handler>

function wsUrl(token) {
  const base = API.replace(/^http/, 'ws');
  return `${base}/ws?token=${encodeURIComponent(token)}`;
}

function dispatch(event, data) {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of set) handler(data);
}

function scheduleReconnect() {
  if (!currentToken || reconnectTimer) return;
  // Capped exponential backoff (1s, 2s, 4s, ... up to 30s) — a dropped
  // connection (a laptop sleeping, a flaky network) shouldn't hammer the
  // server with immediate retries, but should still recover quickly for
  // the common "blip" case.
  const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (currentToken) connect(currentToken);
  }, delay);
}

function connect(token) {
  currentToken = token;
  ws = new WebSocket(wsUrl(token));
  ws.onopen = () => { reconnectAttempt = 0; };
  ws.onmessage = (event) => {
    try {
      const { event: name, data } = JSON.parse(event.data);
      dispatch(name, data);
    } catch {
      // Ignore a malformed frame — never worth tearing down the whole
      // connection over one bad message.
    }
  };
  ws.onclose = () => { if (currentToken) scheduleReconnect(); };
  ws.onerror = () => { ws.close(); };
}

// Called once from AuthContext when a session becomes active.
export function connectRealtime(token) {
  disconnectRealtime();
  connect(token);
}

// Called once from AuthContext on logout — currentToken=null is what
// stops scheduleReconnect from trying to revive a connection the user
// deliberately ended.
export function disconnectRealtime() {
  currentToken = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  reconnectAttempt = 0;
}

// Subscribe to a named push event ('notification', 'chat-message', ...).
// Returns an unsubscribe function, so a component's own effect cleanup can
// just be `return on('x', handler)` without a separate off() call.
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => {
    const set = listeners.get(event);
    if (set) set.delete(handler);
  };
}
