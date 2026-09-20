// Self-hosted mediasoup SFU for HonorRoll live classes — see the plan's
// own "Division of responsibility" comment for why this is a fully
// separate process from backend/, not a route module: Render (where
// backend/ lives) only exposes HTTP(S) to the internet, but WebRTC media
// is raw UDP, so this has to run somewhere with real port control instead
// (an Azure VM — see media-server/README.md for the one-time setup).
//
// This process knows NOTHING about subjects, students, or roles — every
// authorization decision (can this person start/join this class) already
// happened in the main backend (routes/liveClasses.js) before it ever
// signs the join token this process trusts. All this process enforces is
// what that token says: which session, which user, and whether they're
// allowed to produce video (true only for the session's own teacher —
// see canProduceVideo below) or just audio (everyone, so a student can
// unmute to ask something).
const http = require('http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { WebSocketServer } = require('ws');
const mediasoup = require('mediasoup');

const PORT = process.env.PORT || 4443;
// The VM's own public IP (or a DNS name resolving to it) — baked into
// every ICE candidate mediasoup hands out, so a client's browser knows
// where to actually send RTP. Required; there's no sane default the way
// PORT has one.
const ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP;
const MIN_PORT = Number(process.env.MEDIASOUP_MIN_PORT) || 40000;
const MAX_PORT = Number(process.env.MEDIASOUP_MAX_PORT) || 40999;

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
];

// One session per live_sessions row (backend/schema/index.js) — id is
// just that row's own numeric id, stringified; nothing here ever talks to
// Postgres, so this map IS the session's state, full stop. Created lazily
// on the first peer's WS connection, torn down when the last peer leaves
// or the main backend's own "end class" call forces it closed (see
// POST /internal/sessions/:id/close below) — nothing about an in-progress
// call needs to survive this process restarting, so none of this is
// persisted.
const sessions = new Map(); // sessionId -> { router, peers: Map<userId, Peer> }

let worker;

async function getOrCreateSession(sessionId) {
  let session = sessions.get(sessionId);
  if (session) return session;
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  session = { router, peers: new Map() };
  sessions.set(sessionId, session);
  return session;
}

function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  for (const peer of session.peers.values()) {
    try { peer.ws.close(4000, 'Class ended'); } catch { /* already closing */ }
  }
  session.router.close();
  sessions.delete(sessionId);
}

// A single peer's own mediasoup objects — transports/producers/consumers
// are only ever created for this one connection, and all of them close
// together when it disconnects (see the 'close' handler below), same
// "everything this connection owns dies with it" shape a WebRTC signaling
// peer always has.
function createPeer(ws, { userId, canProduceVideo, canProduceAudio }) {
  return {
    ws, userId, canProduceVideo, canProduceAudio,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  };
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

// Tells every OTHER peer in the session about a producer that just
// appeared (the teacher's camera going live, or a student unmuting to ask
// something) so each of them can decide whether to consume it. Broadcast
// to everyone, not just the teacher — the point of unmuting is the whole
// class hears the question, same as a real classroom.
function broadcastNewProducer(session, fromUserId, producer) {
  for (const peer of session.peers.values()) {
    if (peer.userId === fromUserId) continue;
    send(peer.ws, { notification: 'newProducer', data: { producerId: producer.id, peerId: fromUserId, kind: producer.kind } });
  }
}

async function handleMessage(ws, session, peer, { id, method, data }) {
  try {
    let result;
    switch (method) {
      case 'getRouterRtpCapabilities':
        result = session.router.rtpCapabilities;
        break;

      case 'createWebRtcTransport': {
        const transport = await session.router.createWebRtcTransport({
          listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        });
        peer.transports.set(transport.id, transport);
        result = {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        };
        break;
      }

      case 'connectWebRtcTransport': {
        const transport = peer.transports.get(data.transportId);
        if (!transport) throw new Error('Unknown transport');
        await transport.connect({ dtlsParameters: data.dtlsParameters });
        result = {};
        break;
      }

      case 'produce': {
        if (data.kind === 'video' && !peer.canProduceVideo) {
          // The actual "only the teacher broadcasts video" enforcement —
          // same job Daily's own permissions.canSend used to do, now
          // enforced here instead of trusting the client's own UI to
          // just not offer the option.
          throw new Error('Not allowed to produce video in this session');
        }
        if (data.kind === 'audio' && !peer.canProduceAudio) throw new Error('Not allowed to produce audio in this session');
        const transport = peer.transports.get(data.transportId);
        if (!transport) throw new Error('Unknown transport');
        const producer = await transport.produce({ kind: data.kind, rtpParameters: data.rtpParameters });
        peer.producers.set(producer.id, producer);
        broadcastNewProducer(session, peer.userId, producer);
        result = { id: producer.id };
        break;
      }

      case 'consume': {
        if (!session.router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
          throw new Error('Cannot consume this producer with the given capabilities');
        }
        const transport = peer.transports.get(data.transportId);
        if (!transport) throw new Error('Unknown transport');
        // Created paused, resumed explicitly once the client's ready to
        // receive — mediasoup's own recommended pattern, avoids a burst
        // of media arriving before the client has finished setting up
        // the consumer on its end.
        const consumer = await transport.consume({
          producerId: data.producerId,
          rtpCapabilities: data.rtpCapabilities,
          paused: true,
        });
        peer.consumers.set(consumer.id, consumer);
        result = {
          id: consumer.id,
          producerId: data.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };
        break;
      }

      case 'resumeConsumer': {
        const consumer = peer.consumers.get(data.consumerId);
        if (!consumer) throw new Error('Unknown consumer');
        await consumer.resume();
        result = {};
        break;
      }

      case 'closeProducer': {
        // A student muting again after unmuting to ask something — closing
        // the client-side producer alone stops it sending RTP but leaves
        // the server-side Producer object (and every peer's Consumer of
        // it) allocated until they eventually disconnect. Closing it here
        // tears all of that down immediately instead.
        //
        // ponytail: other peers' Consumers of this producer aren't told it
        // closed — mediasoup itself auto-closes them server-side, but
        // nothing notifies their client, so a stale (silent, since this is
        // audio-only — video is never closed mid-session this way) entry
        // lingers in their `remoteConsumers` list until they leave. Upgrade
        // path: broadcast a `producerClosed` notification here the same
        // way `broadcastNewProducer` does, and have the client prune its
        // list on receipt.
        const producer = peer.producers.get(data.producerId);
        if (!producer) throw new Error('Unknown producer');
        producer.close();
        peer.producers.delete(data.producerId);
        result = {};
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
    send(ws, { id, data: result });
  } catch (err) {
    send(ws, { id, error: err.message });
  }
}

function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    let payload;
    try {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token');
      // Same JWT_SECRET the main backend signs every session token with —
      // see routes/liveClasses.js's GET /api/live-sessions/:id/join. No
      // separate secret to provision/rotate for this service; the trust
      // boundary between the two is a secret that already exists.
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const sessionId = String(payload.sessionId);

    // Attach the message/close listeners synchronously, before the
    // `await` below — `ws`'s receiver starts processing frames as soon as
    // the handshake completes, not when a listener happens to get
    // attached, so a client that sends its first request the instant its
    // own socket opens can otherwise land here before getOrCreateSession
    // (a real async call — creating a mediasoup Router) has resolved,
    // silently dropping that first message. Buffer anything that arrives
    // before `ready` resolves instead.
    let session, peer;
    const buffered = [];
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (!peer) { buffered.push(message); return; }
      handleMessage(ws, session, peer, message);
    });
    ws.on('close', () => {
      if (!peer) return;
      for (const transport of peer.transports.values()) transport.close();
      session.peers.delete(payload.userId);
      if (session.peers.size === 0) closeSession(sessionId);
    });

    session = await getOrCreateSession(sessionId);
    peer = createPeer(ws, payload);
    session.peers.set(payload.userId, peer);

    // Catch a peer up on whoever's already producing in this session
    // (they joined after the teacher already started broadcasting, the
    // common case) — broadcastNewProducer only reaches peers who were
    // already connected at produce-time.
    for (const otherPeer of session.peers.values()) {
      if (otherPeer.userId === payload.userId) continue;
      for (const producer of otherPeer.producers.values()) {
        send(ws, { notification: 'newProducer', data: { producerId: producer.id, peerId: otherPeer.userId, kind: producer.kind } });
      }
    }

    for (const message of buffered) handleMessage(ws, session, peer, message);
  });
}

function createApp() {
  const app = express();
  app.use(express.json());

  // Server-to-server only — the main backend calls this the moment a
  // teacher hits "End class" (see routes/liveClasses.js's POST
  // /api/teacher/live-sessions/:id/end), so lingering student connections
  // actually drop immediately instead of waiting for their own socket to
  // notice the teacher's producer vanished. Trusts the same JWT_SECRET,
  // scoped with a distinguishing `type` claim so a regular join token
  // can never be replayed here.
  app.post('/internal/sessions/:id/close', (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (payload.type !== 'close-session' || String(payload.sessionId) !== req.params.id) {
      return res.status(403).json({ error: 'Token not scoped to this session' });
    }
    closeSession(req.params.id);
    res.status(200).json({ message: 'Session closed' });
  });

  app.get('/healthz', (req, res) => res.status(200).json({ ok: true, sessions: sessions.size }));

  return app;
}

async function main() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  if (!ANNOUNCED_IP) throw new Error('MEDIASOUP_ANNOUNCED_IP is required');

  worker = await mediasoup.createWorker({ rtcMinPort: MIN_PORT, rtcMaxPort: MAX_PORT });
  worker.on('died', () => {
    // mediasoup's own documented failure mode: the worker subprocess can
    // die (an OS-level crash in the native binary, not a JS exception
    // this process could catch any other way) — no graceful recovery
    // path exists mid-process, so this exits and relies on systemd (see
    // media-server/README.md) to restart it clean rather than limping on
    // with a dead media engine.
    console.error('mediasoup worker died, exiting');
    process.exit(1);
  });

  const app = createApp();
  const server = http.createServer(app);
  attachWebSocketServer(server);

  server.listen(PORT, () => console.log(`media-server listening on :${PORT}`));
}

main().catch((err) => {
  console.error('media-server failed to start:', err);
  process.exit(1);
});
