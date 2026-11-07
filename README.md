# Lenda Sabha Arena — Standalone Online Multiplayer

This package removes the Claude-only `window.claude.use('room')` requirement when the game is opened from this server. The Node.js server serves the game page and relays room presence and gameplay events over WebSockets.

## Run locally

1. Install Node.js 20 or newer.
2. Open a terminal in this folder.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:10000` in two browser windows (or on two devices on the same network, using the host computer's LAN IP).
6. On one player, choose Online → Create room. Share the six-character code. The other player chooses Online → Join room.

Local network testing only works while both devices can reach the computer running the server. Internet play requires hosting this Node server on a public WebSocket-capable web service.

## Deploy on Render

1. Upload this whole folder to a GitHub repository. Keep `server.js`, `package.json`, `render.yaml`, and `public/index.html` together.
2. In Render, create a **Web Service** from that repository. The included `render.yaml` supplies the Node runtime, `npm install`, `npm start`, and `/healthz` health check.
3. When deployment succeeds, open the public `https://...onrender.com` URL. Share that exact URL with friends; both players must use the same URL.
4. Use the Online menu to create/join a room.

The server supports secure WebSockets through `wss://` automatically when served over HTTPS. Render supports inbound WebSocket connections. Free web services can spin down after 15 minutes without activity, so the first connection after inactivity may take a little longer to wake up.

## Important limits

- The game uses peer-reported state for this small casual prototype; it is not an authoritative anti-cheat server.
- Rooms exist in memory and disappear if the server restarts or sleeps/restarts.
- The room relay is limited to 8 players per room.
- For more reliable production multiplayer, add authoritative simulation, persistent room coordination, input validation, and reconnect/resume support.
- Do not publish API keys or personal information in the repository.
