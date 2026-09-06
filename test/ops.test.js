'use strict';

const test = require('node:test');
const assert = require('node:assert');
const B = require('../scoring.js');
const Ops = require('../ops.js');

function twoPlayers() {
  return Ops.newState(['Ada', 'Bo']);
}

function roll(state, playerIndex, pins, extra) {
  const op = Object.assign({ type: 'roll', playerId: state.players[playerIndex].id, pins }, extra || {});
  return Ops.apply(state, op);
}

function totalFor(state, playerIndex) {
  return B.score(Ops.gameFor(state, state.players[playerIndex].id)).total;
}

test('a new state has one player and no rolls', () => {
  const state = Ops.newState();
  assert.strictEqual(state.players.length, 1);
  assert.strictEqual(state.players[0].name, 'Player 1');
  assert.deepStrictEqual(state.rolls, []);
  assert.strictEqual(state.version, 0);
});

test('rolls replay into per-player games', () => {
  const state = twoPlayers();
  roll(state, 0, 10);
  roll(state, 1, 7);
  roll(state, 1, 3);
  roll(state, 0, 4);
  roll(state, 0, 4);

  assert.strictEqual(totalFor(state, 0), 26); // 10+4+4, then 8
  assert.deepStrictEqual(Ops.gameFor(state, state.players[1].id).frames[0], [7, 3]);
});

test('each applied op bumps the version', () => {
  const state = twoPlayers();
  roll(state, 0, 5);
  assert.strictEqual(state.version, 1);
  roll(state, 0, 5);
  assert.strictEqual(state.version, 2);
});

test('the lane passes to the next player when a frame ends', () => {
  const state = twoPlayers();
  assert.strictEqual(state.active, 0);

  roll(state, 0, 4);
  assert.strictEqual(state.active, 0, 'mid-frame the same player keeps the lane');

  roll(state, 0, 3);
  assert.strictEqual(state.active, 1, 'a finished frame hands over');

  roll(state, 1, 10);
  assert.strictEqual(state.active, 0, 'a strike ends the frame immediately');
});

test('the handover skips players who have finished', () => {
  const state = twoPlayers();
  for (let i = 0; i < 12; i++) roll(state, 0, 10);
  assert.strictEqual(B.isGameOver(Ops.gameFor(state, state.players[0].id)), true);

  roll(state, 1, 10);
  assert.strictEqual(state.active, 1, 'the only player still bowling keeps the lane');
});

test('a solo game keeps the lane after every frame', () => {
  const state = Ops.newState(['Solo']);
  roll(state, 0, 10);
  assert.strictEqual(state.active, 0);
});

test('illegal rolls are refused with a reason', () => {
  const state = twoPlayers();
  roll(state, 0, 6);

  const bad = roll(state, 0, 7);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /4 pins/);
  assert.strictEqual(state.rolls.length, 1, 'a refused op changes nothing');
  assert.strictEqual(state.version, 1);
});

test('a finished player cannot roll again', () => {
  const state = Ops.newState(['Solo']);
  for (let i = 0; i < 12; i++) roll(state, 0, 10);

  const extra = roll(state, 0, 10);
  assert.strictEqual(extra.ok, false);
  assert.match(extra.reason, /already finished/);
});

test('rolls for a departed player are refused', () => {
  const state = twoPlayers();
  const goneId = state.players[1].id;
  Ops.apply(state, { type: 'remove_player', playerId: goneId });

  const result = Ops.apply(state, { type: 'roll', playerId: goneId, pins: 5 });
  assert.strictEqual(result.ok, false);
});

test('undo pops the last ball and returns the lane to its thrower', () => {
  const state = twoPlayers();
  roll(state, 0, 3);
  roll(state, 0, 4); // frame over, lane passes to Bo
  assert.strictEqual(state.active, 1);

  const result = Ops.apply(state, { type: 'undo' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.rolls.length, 1);
  assert.strictEqual(state.active, 0, 'the lane goes back to whoever threw it');
});

test('undo on an empty game is refused', () => {
  const state = twoPlayers();
  assert.strictEqual(Ops.apply(state, { type: 'undo' }).ok, false);
});

test('undo against a stale version is refused', () => {
  const state = twoPlayers();
  roll(state, 0, 5);
  const seen = state.version;
  roll(state, 0, 5); // someone else scores in the meantime

  const stale = Ops.apply(state, { type: 'undo', baseVersion: seen });
  assert.strictEqual(stale.ok, false);
  assert.match(stale.reason, /someone else/);
  assert.strictEqual(state.rolls.length, 2, 'nothing was popped');

  const fresh = Ops.apply(state, { type: 'undo', baseVersion: state.version });
  assert.strictEqual(fresh.ok, true);
});

test('removing a player takes their rolls with them', () => {
  const state = twoPlayers();
  roll(state, 0, 10);
  roll(state, 1, 9);
  const boId = state.players[1].id;

  Ops.apply(state, { type: 'remove_player', playerId: boId });
  assert.strictEqual(state.players.length, 1);
  assert.ok(state.rolls.every((r) => r.playerId !== boId));
  assert.strictEqual(totalFor(state, 0), 0, "Ada's own game is untouched");
});

test('the last player cannot be removed', () => {
  const state = Ops.newState(['Solo']);
  assert.strictEqual(Ops.apply(state, { type: 'remove_player', playerId: state.players[0].id }).ok, false);
});

test('players can be added up to the cap and renamed', () => {
  const state = Ops.newState(['Solo']);
  for (let i = 1; i < Ops.MAX_PLAYERS; i++) {
    assert.strictEqual(Ops.apply(state, { type: 'add_player' }).ok, true);
  }
  assert.strictEqual(Ops.apply(state, { type: 'add_player' }).ok, false);

  Ops.apply(state, { type: 'rename_player', playerId: state.players[0].id, name: '  Ada  ' });
  assert.strictEqual(state.players[0].name, 'Ada');

  Ops.apply(state, { type: 'rename_player', playerId: state.players[0].id, name: '   ' });
  assert.strictEqual(state.players[0].name, 'Ada', 'a blank name keeps the old one');
});

test('a new game clears the rolls but keeps the players', () => {
  const state = twoPlayers();
  roll(state, 0, 10);
  Ops.apply(state, { type: 'new_game' });
  assert.deepStrictEqual(state.rolls, []);
  assert.strictEqual(state.players.length, 2);
  assert.strictEqual(state.active, 0);
});

test('lastOp describes what just happened, for the other phone', () => {
  const state = twoPlayers();

  roll(state, 0, 10, { clientId: 'phone-a' });
  assert.deepStrictEqual(
    { by: state.lastOp.by, label: state.lastOp.label, clientId: state.lastOp.clientId },
    { by: 'Ada', label: 'rolled a strike', clientId: 'phone-a' }
  );

  roll(state, 1, 4);
  roll(state, 1, 6);
  assert.strictEqual(state.lastOp.label, 'picked up a spare');

  roll(state, 0, 0);
  assert.strictEqual(state.lastOp.label, 'missed');
});

test('a state survives a round trip through serialize and deserialize', () => {
  const state = twoPlayers();
  roll(state, 0, 10);
  roll(state, 1, 4);
  roll(state, 1, 6);

  const copy = Ops.deserialize(JSON.parse(JSON.stringify(Ops.serialize(state))));
  assert.deepStrictEqual(Ops.serialize(copy), Ops.serialize(state));
  assert.strictEqual(totalFor(copy, 0), totalFor(state, 0));
});

test('deserialize rejects states it cannot replay', () => {
  const state = twoPlayers();
  const id = state.players[0].id;

  assert.strictEqual(Ops.deserialize(null), null);
  assert.strictEqual(Ops.deserialize({ players: [] }), null);
  assert.strictEqual(Ops.deserialize({ players: [{ id, name: 'Ada' }], rolls: [{ playerId: 'nope', pins: 3 }] }), null);
  assert.strictEqual(
    Ops.deserialize({ players: [{ id, name: 'Ada' }], rolls: [{ playerId: id, pins: 7 }, { playerId: id, pins: 7 }] }),
    null,
    '7 then 7 in one frame is not a game'
  );
  assert.strictEqual(
    Ops.deserialize({ players: [{ id, name: 'A' }, { id, name: 'B' }] }),
    null,
    'duplicate player ids are rejected'
  );
});

test('deserialize clamps a bogus active index', () => {
  const state = Ops.deserialize({ players: [{ id: 'a', name: 'Ada' }], rolls: [], active: 99 });
  assert.strictEqual(state.active, 0);
});
