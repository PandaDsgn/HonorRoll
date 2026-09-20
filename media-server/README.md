# HonorRoll media-server

Self-hosted [mediasoup](https://mediasoup.org/) SFU powering live classes —
see `backend/routes/liveClasses.js` for the app-side half. Deployed to its
own VM, not Render: Render only exposes HTTP(S) to the internet (it proxies
everything through its own edge), and WebRTC media is raw UDP, which never
reaches a Render-hosted container. This process needs a real public IP and
full port control instead.

This process trusts nothing about subjects, students, or roles — it only
verifies a short-lived JWT (signed by the main backend with the same
`JWT_SECRET`, see `GET /api/live-sessions/:id/join`) saying which session a
connection belongs to and whether it may produce video (true only for that
session's own teacher) or audio (everyone).

## One-time VM setup (Azure for Students — free, no card, school email only)

1. Create an Azure for Students account, provision one Ubuntu LTS VM (the
   smallest B-series burstable size is enough — mediasoup's per-stream
   media processing is genuinely light; it's Node app servers that tend to
   be the heavy thing, not this).
2. On the VM:
   ```
   sudo apt update
   sudo apt install -y build-essential python3 nginx certbot python3-certbot-nginx coturn
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```
   `build-essential`/`python3` are for mediasoup's native worker, compiled
   at `npm install` time — the one OS-level build dependency this repo has
   never needed anywhere else.
3. `git clone` this repo (or just copy `media-server/`), `cd media-server && npm install`.
4. Configure `coturn` (`/etc/turnserver.conf`) with a long-term-credential
   shared secret and this VM's public IP — needed as a TURN fallback for
   networks (many school networks included) that block direct UDP.
5. nginx + certbot: a reverse proxy terminating TLS for the signaling
   WebSocket (a plain `ws://` endpoint won't work from a page served over
   `https://`) and forwarding to this app's `PORT`.
6. Azure Network Security Group — open inbound:
   - UDP `MEDIASOUP_MIN_PORT`-`MEDIASOUP_MAX_PORT` (mediasoup's own RTP range)
   - UDP 3478 + coturn's own relay range (TURN/STUN)
   - TCP 443 (nginx, the signaling WebSocket)
7. Run as a systemd service (not a bare `node index.js` in a terminal) so
   it restarts automatically — including after the `worker.on('died', ...)`
   exit this process deliberately does on a mediasoup worker crash (see
   `index.js`'s own comment; there's no in-process recovery from that, by
   mediasoup's own design).

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `JWT_SECRET` | yes | Same value as the main backend's — this is the entire trust boundary between the two services, see file-header comment in `index.js`. |
| `MEDIASOUP_ANNOUNCED_IP` | yes | This VM's public IP (or a DNS name resolving to it) — baked into every ICE candidate handed to clients. |
| `PORT` | no (default `4443`) | What nginx proxies to. |
| `MEDIASOUP_MIN_PORT` / `MEDIASOUP_MAX_PORT` | no (default `40000`-`40999`) | mediasoup's own RTP port range — must match the NSG rule above. |

## Main backend's own env vars (set on Render, not here)

- `MEDIA_SERVER_WS_URL` — the public `wss://` signaling endpoint, handed to
  the frontend by `GET /api/live-sessions/:id/join`.
- `JWT_SECRET` — already exists; nothing new to add there.
