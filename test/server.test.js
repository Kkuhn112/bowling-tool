'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Keep the saved-rooms file out of the project while testing.
const roomsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'strike-')), 'rooms.json');
process.env.ROOMS_FILE = roomsFile;

const Ops = require('../ops.js');
const app = require('../server/server.js');

let base;

before(async () => {
  await app.start(0, '127.0.0.1');
  base = 'http://127.0.0.1:' + app.server.address().port;
});

after(async () => {
  await app.stop();
});

const post = (url, body, headers) => fetch(base + url, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
  body: JSON.stringify(body || {})
});

async function newRoom(body) {
  const res = await post('/api/rooms', body);
  assert.strictEqual(res.status, 201);
  return res.json();
}

const sendOp = (code, op, clientId) => post('/api/rooms/' + code + '/ops', { op }, clientId ? { 'x-client-id': clientId } : null);

/* Reads `event: state` frames off an SSE stream one at a time. */
function openStream(code) {
  const controller = new AbortController();
  const queue = [];
  const waiting = [];
  let buffer = '';

  const ready = fetch(base + '/api/rooms/' + code + '/events', { signal: controller.signal })
    .then(async (res) => {
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            const payload = JSON.parse(line.slice(6));
            if (waiting.length) waiting.shift()(payload);
            else queue.push(payload);
          }
        }
      })().catch(() => { /* stream closed */ });
      return res;
    });

  return {
    ready,
    next(timeoutMs = 3000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a state event')), timeoutMs);
        waiting.push((payload) => { clearTimeout(timer); resolve(payload); });
      });
    },
    close() { controller.abort(); }
  };
}

test('health reports the server is up', async () => {
  const res = await fetch(base + '/api/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).ok, true);
});

test('a new room gets a short code and a one-player game', async () => {
  const room = await newRoom({ names: ['Ada'] });
  assert.match(room.code, /^[A-Z0-9]{4}$/);
  assert.strictEqual(room.state.players[0].name, 'Ada');
  assert.strictEqual(room.state.version, 0);
  assert.strictEqual(room.viewers, 0);
});

test('a room can be seeded with the game already in progress', async () => {
  const local = Ops.newState(['Ada', 'Bo']);
  Ops.apply(local, { type: 'roll', playerId: local.players[0].id, pins: 10 });

  const room = await newRoom({ state: Ops.serialize(local) });
  assert.strictEqual(room.state.rolls.length, 1);
  assert.strictEqual(room.state.players.length, 2);
  assert.strictEqual(room.state.version, 0, 'the seeded room starts its own version count');
});

test('a room seeded with an impossible game falls back to a fresh one', async () => {
  const room = await newRoom({ state: { players: [{ id: 'x', name: 'Ada' }], rolls: [{ playerId: 'x', pins: 99 }] } });
  assert.strictEqual(room.state.rolls.length, 0);
  assert.strictEqual(room.state.players.length, 1);
});

test('rolls are applied and readable back', async () => {
  const room = await newRoom({ names: ['Ada'] });
  const id = room.state.players[0].id;

  const res = await sendOp(room.code, { type: 'roll', playerId: id, pins: 7 });
  assert.strictEqual(res.status, 200);
  const after = await res.json();
  assert.deepStrictEqual(after.state.rolls, [{ playerId: id, pins: 7 }]);
  assert.strictEqual(after.state.version, 1);

  const fetched = await (await fetch(base + '/api/rooms/' + room.code)).json();
  assert.deepStrictEqual(fetched.state, after.state);
});

test('a lowercase code finds the same room', async () => {
  const room = await newRoom({ names: ['Ada'] });
  const res = await fetch(base + '/api/rooms/' + room.code.toLowerCase());
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).code, room.code);
});

test('an illegal roll comes back as 409 with the live state', async () => {
  const room = await newRoom({ names: ['Ada'] });
  const id = room.state.players[0].id;
  await sendOp(room.code, { type: 'roll', playerId: id, pins: 6 });

  const res = await sendOp(room.code, { type: 'roll', playerId: id, pins: 7 });
  assert.strictEqual(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /4 pins/);
  assert.strictEqual(body.state.rolls.length, 1, 'the caller gets the truth back to re-sync from');
});

test('undo from a stale version is refused', async () => {
  const room = await newRoom({ names: ['Ada'] });
  const id = room.state.players[0].id;
  await sendOp(room.code, { type: 'roll', playerId: id, pins: 3 });
  const seen = (await (await sendOp(room.code, { type: 'roll', playerId: id, pins: 4 })).json()).state.version;
  await sendOp(room.code, { type: 'roll', playerId: id, pins: 5 }); // the other phone scores

  const stale = await sendOp(room.code, { type: 'undo', baseVersion: seen });
  assert.strictEqual(stale.status, 409);
  assert.match((await stale.json()).error, /someone else/);

  const fresh = await sendOp(room.code, { type: 'undo', baseVersion: 3 });
  assert.strictEqual(fresh.status, 200);
});

test('unknown rooms and bad requests are rejected', async () => {
  assert.strictEqual((await fetch(base + '/api/rooms/ZZZZ')).status, 404);
  assert.strictEqual((await sendOp('ZZZZ', { type: 'roll', pins: 1 })).status, 404);

  const room = await newRoom({ names: ['Ada'] });
  assert.strictEqual((await post('/api/rooms/' + room.code + '/ops', {})).status, 400);
  assert.strictEqual((await sendOp(room.code, { type: 'nonsense' })).status, 409);
  assert.strictEqual((await fetch(base + '/api/rooms')).status, 405);
});

test('a second phone sees the first phone\'s rolls live', async () => {
  const room = await newRoom({ names: ['Ada', 'Bo'] });
  const stream = openStream(room.code);
  await stream.ready;

  const first = await stream.next();
  assert.strictEqual(first.state.rolls.length, 0);
  assert.strictEqual(first.viewers, 1);

  await sendOp(room.code, { type: 'roll', playerId: room.state.players[0].id, pins: 10 }, 'phone-a');

  const update = await stream.next();
  assert.strictEqual(update.state.rolls.length, 1);
  assert.strictEqual(update.state.version, 1);
  assert.strictEqual(update.state.lastOp.by, 'Ada');
  assert.strictEqual(update.state.lastOp.label, 'rolled a strike');
  assert.strictEqual(update.state.lastOp.clientId, 'phone-a', 'so the sender can skip its own notice');
  assert.strictEqual(update.state.active, 1, 'the lane passed to Bo on both phones');

  stream.close();
});

test('both phones see the viewer count and each other\'s ops', async () => {
  const room = await newRoom({ names: ['Ada', 'Bo'] });
  const phoneA = openStream(room.code);
  await phoneA.ready;
  await phoneA.next();

  const phoneB = openStream(room.code);
  await phoneB.ready;

  assert.strictEqual((await phoneB.next()).viewers, 2);
  assert.strictEqual((await phoneA.next()).viewers, 2, 'the first phone is told someone joined');

  // Each phone enters its own player's ball; both land in one shared card.
  await sendOp(room.code, { type: 'roll', playerId: room.state.players[0].id, pins: 9 }, 'phone-a');
  await phoneA.next();
  await phoneB.next();
  await sendOp(room.code, { type: 'roll', playerId: room.state.players[0].id, pins: 1 }, 'phone-a');
  await phoneA.next();
  await phoneB.next();

  const seenByA = await sendOp(room.code, { type: 'roll', playerId: room.state.players[1].id, pins: 10 }, 'phone-b');
  assert.strictEqual(seenByA.status, 200);

  const finalA = await phoneA.next();
  const finalB = await phoneB.next();
  assert.deepStrictEqual(finalA.state, finalB.state, 'both phones hold the same game');
  assert.strictEqual(finalA.state.rolls.length, 3);

  phoneA.close();
  phoneB.close();
});

test('the app itself is served, and nothing outside it is', async () => {
  const page = await fetch(base + '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<title>/);

  const script = await fetch(base + '/scoring.js');
  assert.strictEqual(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);

  assert.strictEqual((await fetch(base + '/server/server.js')).status, 404, 'the server is not a static asset');
  // URL parsing already flattens the ".." segments; the resolve guard behind it is a second line.
  assert.strictEqual((await fetch(base + '/%2e%2e/%2e%2e/etc/passwd')).status, 404, 'no path traversal');
  assert.strictEqual((await fetch(base + '/../../etc/passwd')).status, 404, 'no path traversal');
  assert.strictEqual((await fetch(base + '/package.json')).status, 200);
  assert.strictEqual((await fetch(base + '/nope.html')).status, 404);
});

test('the api is usable from a page this server did not serve', async () => {
  const origin = 'https://example.github.io';

  const preflight = await fetch(base + '/api/rooms', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
  });
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /x-client-id/);

  const health = await fetch(base + '/api/health', { headers: { origin } });
  assert.strictEqual(health.headers.get('access-control-allow-origin'), origin);
  assert.strictEqual(health.headers.get('vary'), 'origin');

  const room = await newRoom({ names: ['Ada'] });
  const stream = openStream(room.code);
  await stream.ready;
  await stream.next();

  const rolled = await fetch(base + '/api/rooms/' + room.code + '/ops', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': 'pages', origin },
    body: JSON.stringify({ op: { type: 'roll', playerId: room.state.players[0].id, pins: 10 } })
  });
  assert.strictEqual(rolled.status, 200);
  assert.strictEqual(rolled.headers.get('access-control-allow-origin'), origin);
  assert.strictEqual((await stream.next()).state.rolls.length, 1, 'the ball reaches the other phone');

  stream.close();
});

test('rooms are written to disk so a restart keeps the game', async () => {
  const room = await newRoom({ names: ['Ada'] });
  await sendOp(room.code, { type: 'roll', playerId: room.state.players[0].id, pins: 10 });

  await new Promise((resolve) => setTimeout(resolve, 2200)); // debounced write
  const saved = JSON.parse(fs.readFileSync(roomsFile, 'utf8'));
  assert.ok(saved.rooms[room.code], 'the room is in the saved file');
  assert.strictEqual(saved.rooms[room.code].state.rolls.length, 1);
});
