// Real-time push over WebSocket — the shared delivery layer both the
// notification bell and the encrypted chat feature ride on, replacing
// NotificationBell.jsx's old 30s poll as the primary path (a slow safety-
// net poll stays as a fallback on the frontend, in case a socket silently
// dies). Mounted at its own path (/ws) rather than intercepting every
// upgrade request on the server, since nothing else on this app ever
// upgrades a connection.
//
// Auth is a query param (?token=...), not a header: a browser's
// WebSocket constructor can't set Authorization on its handshake request
// the way axios can on a normal fetch. Verified with the exact same
// verifySessionToken lib/auth.js's authenticateToken uses, so HTTP and WS
// auth can never drift into accepting different things as "logged in."
//
// Cross-replica fan-out: Render can run more than one instance of this
// app, and a browser's WebSocket connection is pinned to whichever
// instance it dialed — if a chat message is written on replica A but the
// recipient's socket is open on replica B, A has to tell B about it
// somehow. Same "start in-process, upgrade to Redis if configured, degrade
// gracefully if not" posture as rateLimiter.js's SwappableStore: with no
// REDIS_URL, sendToUser just delivers to whatever's connected to THIS
// process (correct and sufficient for a single instance); with one
// configured, every replica also publishes/subscribes on one shared Redis
// channel so a user's other-replica sockets hear about it too.
const { WebSocketServer } = require('ws');
const { verifySessionToken } = require('./auth');
const { getRedisClient } = require('../redisClient');

const REALTIME_CHANNEL = 'honorroll:realtime';

// Map<userId, Set<WebSocket>> — a user can have more than one tab/device
// connected at once (same "more than one live session" reality the
// trusted-devices feature already accounts for), so every registered
// socket for that user gets the push, not just the first/last one.
const socketsByUserId = new Map();

function registerSocket(userId, ws) {
  if (!socketsByUserId.has(userId)) socketsByUserId.set(userId, new Set());
  socketsByUserId.get(userId).add(ws);
}
function unregisterSocket(userId, ws) {
  const set = socketsByUserId.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) socketsByUserId.delete(userId);
}

// Delivers {event, data} to every socket THIS process has open for
// userId — the local half of sendToUser below, and also what a Redis
// pub/sub message from another replica ultimately calls into.
function deliverLocally(userId, event, data) {
  const set = socketsByUserId.get(userId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({ event, data });
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// Fire-and-forget publisher, resolved once at boot — mirrors
// connectRedisAndUpgradeStores' own "connect once, reuse forever" shape.
// null until/unless Redis is actually configured and reachable.
let publisher = null;

async function setupRedisFanout() {
  const client = await getRedisClient();
  if (!client) return; // no REDIS_URL, or it failed to connect — single-instance mode, nothing more to do
  publisher = client;

  // Subscribing puts a Redis client into a mode where it can't run any
  // other command, so this needs its own dedicated connection rather than
  // reusing the same client every other Redis-backed feature (rate
  // limiting) shares.
  const subscriber = client.duplicate();
  subscriber.on('error', (err) => console.error('Realtime Redis subscriber error:', err));
  await subscriber.connect();
  await subscriber.subscribe(REALTIME_CHANNEL, (message) => {
    try {
      const { userId, event, data } = JSON.parse(message);
      deliverLocally(userId, event, data);
    } catch (err) {
      console.error('Failed to handle realtime pub/sub message:', err);
    }
  });
  console.log('Realtime push backed by Redis (shared across replicas).');
}

// The one function every other route file calls. Always delivers to this
// process's own sockets immediately (correct even before/without Redis);
// additionally publishes so any OTHER replica's sockets for this user hear
// about it too, if Redis is configured.
function sendToUser(userId, event, data) {
  deliverLocally(userId, event, data);
  if (publisher) {
    publisher.publish(REALTIME_CHANNEL, JSON.stringify({ userId, event, data })).catch((err) => {
      console.error('Failed to publish realtime event (continuing anyway):', err);
    });
  }
}

// Called once from index.js with the real http.Server (not the Express
// app) — a WebSocketServer needs the underlying server to hook its own
// 'upgrade' listener onto, which `app.listen()` never exposes.
function attachRealtime(server) {
  setupRedisFanout().catch((err) => console.error('Realtime Redis fan-out setup failed (continuing in single-instance mode):', err));

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    let userId;
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) throw new Error('No token provided');
      userId = verifySessionToken(token).userId;
    } catch (err) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    registerSocket(userId, ws);
    ws.on('close', () => unregisterSocket(userId, ws));
    ws.on('error', () => unregisterSocket(userId, ws));
  });
}

module.exports = { attachRealtime, sendToUser };
