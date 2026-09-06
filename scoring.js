/*
 * Ten-pin bowling scoring engine.
 *
 * Works as a plain <script> in the browser (exposes `window.Bowling`) and as a
 * CommonJS module in Node (for the tests in test/), so the same code runs in both.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Bowling = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FRAMES = 10;
  var PINS = 10;

  function createGame() {
    var frames = [];
    for (var i = 0; i < FRAMES; i++) frames.push([]);
    return { frames: frames };
  }

  function cloneGame(game) {
    return { frames: game.frames.map(function (f) { return f.slice(); }) };
  }

  /* A frame is done when no more balls may be thrown in it. */
  function isFrameComplete(frames, i) {
    var f = frames[i];
    if (i < FRAMES - 1) return f[0] === PINS || f.length === 2;
    if (f.length < 2) return false;
    // The tenth frame earns a third ball for a strike or a spare.
    if (f[0] === PINS || f[0] + f[1] === PINS) return f.length === 3;
    return true;
  }

  /* Index of the frame being bowled, or -1 once the game is over. */
  function currentFrame(game) {
    for (var i = 0; i < FRAMES; i++) if (!isFrameComplete(game.frames, i)) return i;
    return -1;
  }

  function isGameOver(game) {
    return currentFrame(game) === -1;
  }

  /* Which ball of the current frame comes next (1-based), or 0 if the game is over. */
  function currentBall(game) {
    var i = currentFrame(game);
    return i === -1 ? 0 : game.frames[i].length + 1;
  }

  /* Pins left standing — i.e. the highest legal value for the next roll. */
  function pinsStanding(game) {
    var i = currentFrame(game);
    if (i === -1) return 0;
    var f = game.frames[i];

    if (i < FRAMES - 1) return f.length === 0 ? PINS : PINS - f[0];

    // Tenth frame: a strike or a spare racks a fresh set of pins.
    if (f.length === 0) return PINS;
    if (f.length === 1) return f[0] === PINS ? PINS : PINS - f[0];
    if (f[0] === PINS) return f[1] === PINS ? PINS : PINS - f[1];
    return PINS; // first two balls were a spare, so the bonus ball gets a full rack
  }

  function isLegalRoll(game, pins) {
    return Number.isInteger(pins) && pins >= 0 && pins <= pinsStanding(game);
  }

  /* Records a roll. Returns true if it was accepted. */
  function roll(game, pins) {
    if (!isLegalRoll(game, pins)) return false;
    game.frames[currentFrame(game)].push(pins);
    return true;
  }

  /* Removes the most recent roll. Returns true if there was one. */
  function undo(game) {
    for (var i = FRAMES - 1; i >= 0; i--) {
      if (game.frames[i].length) { game.frames[i].pop(); return true; }
    }
    return false;
  }

  /*
   * Scores the game.
   *   frameScores — value of each frame, or null while its bonus is unknown
   *   cumulative  — running total per frame, null from the first unknown frame on
   *   total       — last known running total
   */
  function score(game) {
    var frames = game.frames;
    var rolls = [];
    var startOf = [];
    for (var i = 0; i < FRAMES; i++) {
      startOf.push(rolls.length);
      rolls.push.apply(rolls, frames[i]);
    }

    var frameScores = [];
    var cumulative = [];
    var running = 0;
    var pending = false;

    for (var f = 0; f < FRAMES; f++) {
      var frame = frames[f];
      var s = startOf[f];
      var value = null;

      if (f < FRAMES - 1) {
        if (frame[0] === PINS) {
          // Strike: worth 10 plus the next two balls.
          var b1 = rolls[s + 1], b2 = rolls[s + 2];
          if (b1 !== undefined && b2 !== undefined) value = PINS + b1 + b2;
        } else if (frame.length === 2) {
          if (frame[0] + frame[1] === PINS) {
            // Spare: worth 10 plus the next ball.
            var b = rolls[s + 2];
            if (b !== undefined) value = PINS + b;
          } else {
            value = frame[0] + frame[1];
          }
        }
      } else if (isFrameComplete(frames, f)) {
        value = frame.reduce(function (a, b) { return a + b; }, 0);
      }

      frameScores.push(value);
      if (!pending && value !== null) {
        running += value;
        cumulative.push(running);
      } else {
        pending = true;
        cumulative.push(null);
      }
    }

    return { frameScores: frameScores, cumulative: cumulative, total: running };
  }

  /*
   * Best score still reachable: replay the game knocking down every pin left.
   * Greedy is optimal here — a strike or spare always beats leaving pins up,
   * and both rack a fresh set for the following ball.
   */
  function maxPossible(game) {
    var projected = cloneGame(game);
    while (!isGameOver(projected)) roll(projected, pinsStanding(projected));
    return score(projected).total;
  }

  /* Scoresheet marks for one frame: X, /, - or the pin count. */
  function marks(frame) {
    var out = [];
    var standing = PINS;
    var freshRack = true;
    for (var i = 0; i < frame.length; i++) {
      var r = frame[i];
      if (freshRack && r === PINS) {
        out.push('X');
        standing = PINS;
      } else if (!freshRack && r === standing) {
        out.push('/');
        standing = PINS;
        freshRack = true;
      } else {
        out.push(r === 0 ? '-' : String(r));
        standing -= r;
        freshRack = false;
      }
    }
    return out;
  }

  return {
    FRAMES: FRAMES,
    PINS: PINS,
    createGame: createGame,
    cloneGame: cloneGame,
    isFrameComplete: isFrameComplete,
    currentFrame: currentFrame,
    currentBall: currentBall,
    isGameOver: isGameOver,
    pinsStanding: pinsStanding,
    isLegalRoll: isLegalRoll,
    roll: roll,
    undo: undo,
    score: score,
    maxPossible: maxPossible,
    marks: marks
  };
});
