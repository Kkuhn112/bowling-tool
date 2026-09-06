/*
 * Shared game state and the operations that change it.
 *
 * Both the browser and the server run this file, so an op applied optimistically
 * on a phone lands exactly where the server puts it. State is deliberately a log
 * of rolls rather than a pile of frames: replaying it rebuilds every scorecard,
 * and undo is a pop, which is what makes two people entering scores at once safe.
 *
 *   state = {
 *     players: [{ id, name }],
 *     rolls:   [{ playerId, pins }],   // in the order they were thrown
 *     active:  0,                      // index into players
 *     version: 0,                      // bumped by every applied op
 *     lastOp:  { by, label, clientId } // for "Sam rolled a strike" notices
 *   }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./scoring.js'));
  else root.Ops = factory(root.Bowling);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Bowling) {
  'use strict';

  var MAX_PLAYERS = 8;
  var MAX_NAME = 18;

  function makeId() {
    return Math.random().toString(36).slice(2, 10);
  }

  function cleanName(name, fallback) {
    var text = String(name === undefined || name === null ? '' : name).trim().slice(0, MAX_NAME);
    return text || fallback;
  }

  function newState(names) {
    var list = (names && names.length ? names : ['Player 1']).slice(0, MAX_PLAYERS);
    return {
      players: list.map(function (name, i) {
        return { id: makeId(), name: cleanName(name, 'Player ' + (i + 1)) };
      }),
      rolls: [],
      active: 0,
      version: 0,
      lastOp: null
    };
  }

  /* Rebuilds every player's game by replaying the roll log. */
  function games(state) {
    var byId = {};
    state.players.forEach(function (p) { byId[p.id] = Bowling.createGame(); });
    state.rolls.forEach(function (r) {
      var game = byId[r.playerId];
      if (game) Bowling.roll(game, r.pins);
    });
    return byId;
  }

  function gameFor(state, playerId) {
    return games(state)[playerId];
  }

  function indexOfPlayer(state, playerId) {
    for (var i = 0; i < state.players.length; i++) {
      if (state.players[i].id === playerId) return i;
    }
    return -1;
  }

  /* The next player still bowling, starting after `from`. */
  function nextActive(state, from, byId) {
    var n = state.players.length;
    for (var step = 1; step <= n; step++) {
      var i = (from + step) % n;
      var game = byId[state.players[i].id];
      if (game && !Bowling.isGameOver(game)) return i;
    }
    return from;
  }

  function rollLabel(game, pins) {
    if (pins === Bowling.PINS && Bowling.pinsStanding(game) === Bowling.PINS) return 'rolled a strike';
    if (pins === Bowling.pinsStanding(game) && Bowling.currentBall(game) > 1) return 'picked up a spare';
    if (pins === 0) return 'missed';
    return 'knocked down ' + pins;
  }

  function fail(reason) {
    return { ok: false, reason: reason };
  }

  /*
   * Applies an op in place. Returns {ok:true} or {ok:false, reason}.
   * `op.clientId` and `op.baseVersion` are optional and only used for shared games.
   */
  function apply(state, op) {
    if (!op || typeof op.type !== 'string') return fail('unknown operation');

    var byId = games(state);
    var actorName = null;
    var label = null;

    switch (op.type) {
      case 'roll': {
        var playerId = op.playerId || (state.players[state.active] || {}).id;
        var index = indexOfPlayer(state, playerId);
        if (index === -1) return fail('that player is no longer in the game');

        var game = byId[playerId];
        if (Bowling.isGameOver(game)) return fail(state.players[index].name + ' has already finished');
        if (!Bowling.isLegalRoll(game, op.pins)) {
          return fail('only ' + Bowling.pinsStanding(game) + ' pins were standing');
        }

        var frame = Bowling.currentFrame(game);
        actorName = state.players[index].name;
        label = rollLabel(game, op.pins);

        state.rolls.push({ playerId: playerId, pins: op.pins });
        Bowling.roll(game, op.pins);

        // Hand the lane over as soon as the frame is finished.
        if (state.players.length > 1 && Bowling.isFrameComplete(game.frames, frame)) {
          state.active = nextActive(state, index, byId);
        } else {
          state.active = index;
        }
        break;
      }

      case 'undo': {
        if (!state.rolls.length) return fail('there is nothing to undo');
        if (op.baseVersion !== undefined && op.baseVersion !== state.version) {
          return fail('someone else scored in the meantime');
        }
        var undone = state.rolls.pop();
        var back = indexOfPlayer(state, undone.playerId);
        if (back !== -1) state.active = back;
        actorName = back === -1 ? null : state.players[back].name;
        label = 'took a ball back';
        break;
      }

      case 'select_player': {
        var pick = indexOfPlayer(state, op.playerId);
        if (pick === -1) return fail('that player is no longer in the game');
        state.active = pick;
        break;
      }

      case 'add_player': {
        if (state.players.length >= MAX_PLAYERS) return fail('that is the most players a lane can take');
        var added = { id: op.id || makeId(), name: cleanName(op.name, 'Player ' + (state.players.length + 1)) };
        state.players.push(added);
        actorName = added.name;
        label = 'joined the game';
        break;
      }

      case 'remove_player': {
        if (state.players.length < 2) return fail('a game needs at least one player');
        var gone = indexOfPlayer(state, op.playerId);
        if (gone === -1) return fail('that player is already gone');
        actorName = state.players[gone].name;
        label = 'left the game';
        state.players.splice(gone, 1);
        state.rolls = state.rolls.filter(function (r) { return r.playerId !== op.playerId; });
        if (state.active >= state.players.length) state.active = state.players.length - 1;
        break;
      }

      case 'rename_player': {
        var target = indexOfPlayer(state, op.playerId);
        if (target === -1) return fail('that player is no longer in the game');
        state.players[target].name = cleanName(op.name, state.players[target].name);
        break;
      }

      case 'new_game': {
        state.rolls = [];
        state.active = 0;
        label = 'started a new game';
        break;
      }

      default:
        return fail('unknown operation');
    }

    state.version += 1;
    state.lastOp = label
      ? { by: actorName, label: label, clientId: op.clientId || null, at: Date.now() }
      : null;
    return { ok: true };
  }

  /* Strips a state down to the fields worth storing or sending. */
  function serialize(state) {
    return {
      players: state.players.map(function (p) { return { id: p.id, name: p.name }; }),
      rolls: state.rolls.map(function (r) { return { playerId: r.playerId, pins: r.pins }; }),
      active: state.active,
      version: state.version,
      lastOp: state.lastOp || null
    };
  }

  /* Rebuilds a state from untrusted input (storage or the network). */
  function deserialize(raw) {
    if (!raw || !Array.isArray(raw.players) || !raw.players.length) return null;

    var state = {
      players: [],
      rolls: [],
      active: 0,
      version: Number.isFinite(raw.version) ? raw.version : 0,
      lastOp: raw.lastOp || null
    };

    var seen = {};
    for (var i = 0; i < raw.players.length && state.players.length < MAX_PLAYERS; i++) {
      var p = raw.players[i];
      if (!p || typeof p.id !== 'string' || seen[p.id]) return null;
      seen[p.id] = true;
      state.players.push({ id: p.id, name: cleanName(p.name, 'Player ' + (i + 1)) });
    }

    // Replay the log so an impossible game can never come back from storage.
    var byId = games(state);
    var rolls = Array.isArray(raw.rolls) ? raw.rolls : [];
    for (var j = 0; j < rolls.length; j++) {
      var r = rolls[j];
      if (!r || !byId[r.playerId]) return null;
      if (!Bowling.roll(byId[r.playerId], r.pins)) return null;
      state.rolls.push({ playerId: r.playerId, pins: r.pins });
    }

    state.active = Number.isInteger(raw.active) && raw.active >= 0 && raw.active < state.players.length
      ? raw.active
      : 0;
    return state;
  }

  return {
    MAX_PLAYERS: MAX_PLAYERS,
    makeId: makeId,
    cleanName: cleanName,
    newState: newState,
    games: games,
    gameFor: gameFor,
    indexOfPlayer: indexOfPlayer,
    apply: apply,
    serialize: serialize,
    deserialize: deserialize
  };
});
