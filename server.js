'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = __dirname;
const rooms = new Map();
const ALLOWED_EVENTS = new Set(['go', 'hit', 'hitAck', 'spHit', 'special', 'mini', 'rnd']);
const MAX_ROOM_PEERS = 8;
const MAX_PRESENCE_BYTES = 24 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function response(ws, id, ok, data = {}, error = '') {
  send(ws, { type: 'response', id, ok, data, error });
}
function peerSnapshot(room) {
  return Array.from(room.clients.values()).map(client => ({
    peer: client.peerId,
    presence: client.presence || {}
  }));
}
function broadcastPeers(room) {
  const message = { type: 'peers', peers: peerSnapshot(room) };
  for (const client of room.clients.values()) send(client.ws, message);
}
function removeClient(ws) {
  const roomName = ws.roomName;
  if (!roomName) return;
  const room = rooms.get(roomName);
  ws.roomName = null;
  if (!room) return;
  room.clients.delete(ws.peerId);
  if (room.clients.size === 0) rooms.delete(roomName);
  else broadcastPeers(room);
}
function safeRoomName(value) {
  const room = String(value || '').trim();
  return /^[a-z0-9_-]{3,80}$/i.test(room) ? room : '';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'lenda-sabha-arena', rooms: rooms.size }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); res.end('Bad request'); return; }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, body) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); res.end('Not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, { type: 'error', error: 'Invalid JSON' }); return; }
    const id = typeof msg.id === 'string' ? msg.id : '';

    if (msg.type === 'join') {
      if (ws.roomName) { response(ws, id, false, {}, 'Already joined a room'); return; }
      const roomName = safeRoomName(msg.room);
      if (!roomName) { response(ws, id, false, {}, 'Room code is invalid'); return; }
      let room = rooms.get(roomName);
      if (!room) { room = { clients: new Map() }; rooms.set(roomName, room); }
      if (room.clients.size >= MAX_ROOM_PEERS) { response(ws, id, false, {}, 'This room is full'); return; }
      ws.roomName = roomName;
      ws.peerId = crypto.randomUUID();
      const client = { ws, peerId: ws.peerId, presence: {} };
      room.clients.set(ws.peerId, client);
      response(ws, id, true, { peerId: ws.peerId, peers: peerSnapshot(room) });
      broadcastPeers(room);
      return;
    }

    if (msg.type === 'leave') { removeClient(ws); return; }
    if (!ws.roomName) { response(ws, id, false, {}, 'Join a room first'); return; }
    const room = rooms.get(ws.roomName);
    const client = room && room.clients.get(ws.peerId);
    if (!room || !client) { response(ws, id, false, {}, 'Room no longer exists'); return; }

    if (msg.type === 'presence') {
      const presence = msg.presence && typeof msg.presence === 'object' ? msg.presence : {};
      if (Buffer.byteLength(JSON.stringify(presence)) > MAX_PRESENCE_BYTES) {
        response(ws, id, false, {}, 'Presence update is too large'); return;
      }
      client.presence = presence;
      response(ws, id, true, { updated: true });
      broadcastPeers(room);
      return;
    }

    if (msg.type === 'emit') {
      const event = String(msg.event || '');
      if (!ALLOWED_EVENTS.has(event)) { response(ws, id, false, {}, 'Event is not allowed'); return; }
      const data = msg.data && typeof msg.data === 'object' ? msg.data : {};
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_EVENT_BYTES) {
        response(ws, id, false, {}, 'Event payload is too large'); return;
      }
      response(ws, id, true, { delivered: true });
      const packet = { type: 'event', event, data, from: ws.peerId };
      // Echo to every connected player. The game already ignores its own remote-only
      // effects, while match-start messages use an ID to avoid duplicate starts.
      for (const other of room.clients.values()) send(other.ws, packet);
      return;
    }

    response(ws, id, false, {}, 'Unknown message type');
  });
  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`Lenda Sabha Arena server listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
