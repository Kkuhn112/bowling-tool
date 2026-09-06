#!/usr/bin/env node
/*
 * Strike sync server.
 *
 * Serves the static app and keeps shared games in rooms. Two phones open the
 * same room code; each tap is sent as an op, validated here with the same
 * ops.js the browser runs, and the resulting state is pushed to everyone over
 * Server-Sent Events. No dependencies — Node's own http server does all of it.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Ops = require('../ops.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOMS_FILE = process.env.ROOMS_FILE || path.join(ROOT, '.rooms.json');

const MAX_ROOMS = 500;
const MAX_VIEWERS_PER_ROOM = 16;
const MAX_BODY_BYTES = 64 * 1024;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // an idle room outlives any real game
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;

// Code alphabet without characters that get misread aloud or on a screen.
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY349';
const CODE_LENGTH = 4;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

/** @type {Map<string, {code: string, state: object, viewers: Set<object>, updatedAt: number}>} */
const rooms = new Map();

/* ---------- rooms ---------- */

function makeCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return null;
}

function createRoom(state) {
  if (rooms.size >= MAX_ROOMS) return null;
  const code = makeCode();
  if (!code) return null;
  const room = { code, state, viewers: new Set(), updatedAt: Date.now() };
  rooms.set(code, room);
  return room;
}

function roomPayload(room) {
  return { code: room.code, viewers: room.viewers.size, state: Ops.serialize(room.state) };
}

function broadcast(room, except) {
  const data = `event: state\ndata: ${JSON.stringify(roomPayload(room))}\n\n`;
  for (const viewer of room.viewers) {
    if (viewer === except) continue;
    try {
      viewer.write(data);
    } catch (err) {
      room.viewers.delete(viewer);
    }
  }
}

function touch(room) {
  room.updatedAt = Date.now();
  schedulePersist();
}

function sweep() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.viewers.size === 0 && room.updatedAt < cutoff) rooms.delete(code);
  }
  schedulePersist();
}

/* ---------- persistence ---------- */
/* Rooms live in memory; this only exists so a restart doesn't wipe a game in progress. */

let persistTimer = null;
let persisting = false;

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, 2000);
  if (persistTimer.unref) persistTimer.unref();
}

async function persist() {
  if (persisting) return;
  persisting = true;
  const snapshot = {};
  for (const [code, room] of rooms) {
    snapshot[code] = { state: Ops.serialize(room.state), updatedAt: room.updatedAt };
  }
  try {
    const tmp = ROOMS_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ rooms: snapshot }), 'utf8');
    await fsp.rename(tmp, ROOMS_FILE);
  } catch (err) {
    console.warn('could not save rooms:', err.message);
  } finally {
    persisting = false;
  }
}

function loadRooms() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
  } catch (err) {
    return; // no saved rooms, or unreadable — start clean
  }
  const saved = (raw && raw.rooms) || {};
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const code of Object.keys(saved)) {
    const entry = saved[code];
    const state = entry && Ops.deserialize(entry.state);
    if (!state || !(entry.updatedAt > cutoff)) continue;
    rooms.set(code, { code, state, viewers: new Set(), updatedAt: entry.updatedAt });
  }
}

/* ---------- http helpers ---------- */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('body was not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(ROOT, relative);

  // Never serve outside the project, and never the server or its saved rooms.
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  if (target.startsWith(path.join(ROOT, 'server')) || target === ROOMS_FILE) {
    return sendJson(res, 404, { error: 'not found' });
  }

  const type = MIME[path.extname(target).toLowerCase()];
  if (!type) return sendJson(res, 404, { error: 'not found' });

  let file;
  try {
    file = await fsp.readFile(target);
  } catch (err) {
    return sendJson(res, 404, { error: 'not found' });
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': file.length,
    'cache-control': 'no-cache'
  });
  res.end(req.method === 'HEAD' ? undefined : file);
}

/* ---------- api ---------- */

function clientIdOf(req, body) {
  const header = req.headers['x-client-id'];
  const id = header || (body && body.clientId);
  return typeof id === 'string' ? id.slice(0, 64) : null;
}

async function createRoomRoute(req, res) {
  const body = await readJsonBody(req);

  // A room can be seeded with the game already on the phone that started it.
  const seeded = body.state ? Ops.deserialize(body.state) : null;
  const state = seeded || Ops.newState(Array.isArray(body.names) ? body.names : undefined);
  state.version = 0;
  state.lastOp = null;

  const room = createRoom(state);
  if (!room) return sendJson(res, 503, { error: 'too many games are open right now' });

  touch(room);
  sendJson(res, 201, roomPayload(room));
}

function subscribeRoute(req, res, room) {
  if (room.viewers.size >= MAX_VIEWERS_PER_ROOM) {
    return sendJson(res, 503, { error: 'this game already has the most phones it can take' });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  room.viewers.add(res);
  // The joiner gets the state once; everyone else just sees the viewer count change.
  res.write(`event: state\ndata: ${JSON.stringify(roomPayload(room))}\n\n`);
  broadcast(room, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  const drop = () => {
    clearInterval(heartbeat);
    if (room.viewers.delete(res)) broadcast(room);
  };
  req.on('close', drop);
  req.on('error', drop);
}

async function opRoute(req, res, room) {
  const body = await readJsonBody(req);
  const op = body && body.op;
  if (!op || typeof op !== 'object') return sendJson(res, 400, { error: 'no operation sent' });

  op.clientId = clientIdOf(req, body);
  const result = Ops.apply(room.state, op);
  if (!result.ok) {
    // 409: the op was understood but the game had moved on. The current state
    // comes back with it so the phone can re-sync instead of guessing.
    return sendJson(res, 409, Object.assign({ error: result.reason }, roomPayload(room)));
  }

  touch(room);
  broadcast(room);
  sendJson(res, 200, roomPayload(room));
}

/* ---------- routing ---------- */

const ROOM_ROUTE = /^\/api\/rooms\/([A-Za-z0-9]{1,8})(\/events|\/ops)?$/;

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, rooms: rooms.size });

  if (pathname === '/api/rooms') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return createRoomRoute(req, res);
  }

  const match = ROOM_ROUTE.exec(pathname);
  if (match) {
    const room = rooms.get(match[1].toUpperCase());
    if (!room) return sendJson(res, 404, { error: 'no game with that code' });
    const suffix = match[2] || '';

    if (suffix === '/events') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      return subscribeRoute(req, res, room);
    }
    if (suffix === '/ops') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      return opRoute(req, res, room);
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return sendJson(res, 200, roomPayload(room));
  }

  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) return res.end();
    sendJson(res, 400, { error: err.message || 'bad request' });
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function start(port = PORT, host = HOST) {
  loadRooms();
  const sweeper = setInterval(sweep, SWEEP_EVERY_MS);
  if (sweeper.unref) sweeper.unref();

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

async function stop() {
  for (const room of rooms.values()) {
    for (const viewer of room.viewers) viewer.end();
    room.viewers.clear();
  }
  await persist();
  await new Promise((resolve) => server.close(resolve));
}

if (require.main === module) {
  start().then(() => {
    const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`Strike is serving on http://${shown}:${PORT}`);
    console.log('Open it on both phones — one starts a shared game, the other joins with the code.');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stop().then(() => process.exit(0), () => process.exit(1));
    });
  }
}

module.exports = { server, start, stop, rooms };
