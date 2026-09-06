'use strict';

const test = require('node:test');
const assert = require('node:assert');
const B = require('../scoring.js');

function play(rolls) {
  const game = B.createGame();
  for (const pins of rolls) {
    assert.ok(B.roll(game, pins), `roll of ${pins} should be legal`);
  }
  return game;
}

const repeat = (n, value) => Array.from({ length: n }, () => value);

test('a fresh game scores zero and no frame is complete', () => {
  const game = B.createGame();
  assert.strictEqual(B.score(game).total, 0);
  assert.strictEqual(B.currentFrame(game), 0);
  assert.strictEqual(B.currentBall(game), 1);
  assert.strictEqual(B.isGameOver(game), false);
});

test('a perfect game is 300', () => {
  const game = play(repeat(12, 10));
  assert.strictEqual(B.score(game).total, 300);
  assert.strictEqual(B.isGameOver(game), true);
});

test('all fives (every frame a spare) is 150', () => {
  const game = play(repeat(21, 5));
  assert.strictEqual(B.score(game).total, 150);
  assert.strictEqual(B.isGameOver(game), true);
});

test('all nine-and-miss frames total 90', () => {
  const game = play(repeat(10, [9, 0]).flat());
  assert.strictEqual(B.score(game).total, 90);
});

test('a gutter game is 0', () => {
  const game = play(repeat(20, 0));
  assert.strictEqual(B.score(game).total, 0);
  assert.strictEqual(B.isGameOver(game), true);
});

test('open frames are just pinfall', () => {
  const game = play(repeat(10, [4, 5]).flat());
  assert.strictEqual(B.score(game).total, 90);
  assert.deepStrictEqual(B.score(game).cumulative, [9, 18, 27, 36, 45, 54, 63, 72, 81, 90]);
});

test('a spare picks up the next ball as a bonus', () => {
  const game = play([7, 3, 4, 2]);
  const { frameScores, cumulative } = B.score(game);
  assert.strictEqual(frameScores[0], 14); // 10 + 4
  assert.strictEqual(frameScores[1], 6);
  assert.strictEqual(cumulative[1], 20);
});

test('a strike picks up the next two balls as a bonus', () => {
  const game = play([10, 4, 2]);
  const { frameScores, cumulative } = B.score(game);
  assert.strictEqual(frameScores[0], 16); // 10 + 4 + 2
  assert.strictEqual(cumulative[1], 22);
});

test('a frame stays unscored until its bonus balls are thrown', () => {
  const game = play([10]);
  const { frameScores, cumulative, total } = B.score(game);
  assert.strictEqual(frameScores[0], null);
  assert.strictEqual(cumulative[0], null);
  assert.strictEqual(total, 0);
});

test('the tenth frame allows three balls after a strike or spare', () => {
  const nine = repeat(18, 0);
  assert.strictEqual(B.score(play(nine.concat([10, 10, 10]))).total, 30);
  assert.strictEqual(B.score(play(nine.concat([5, 5, 10]))).total, 20);
  assert.strictEqual(B.score(play(nine.concat([10, 3, 7]))).total, 20);
  assert.strictEqual(B.score(play(nine.concat([4, 5]))).total, 9);
});

test('a nine in the tenth frame ends the game after two balls', () => {
  const game = play(repeat(18, 0).concat([4, 5]));
  assert.strictEqual(B.isGameOver(game), true);
  assert.strictEqual(B.pinsStanding(game), 0);
});

test('pins standing reflects what is left in the rack', () => {
  const game = B.createGame();
  assert.strictEqual(B.pinsStanding(game), 10);
  B.roll(game, 4);
  assert.strictEqual(B.pinsStanding(game), 6);
  B.roll(game, 6); // spare, new frame
  assert.strictEqual(B.pinsStanding(game), 10);
});

test('pins standing in the tenth frame re-racks after a strike or spare', () => {
  const nine = repeat(18, 0);

  const afterStrike = play(nine.concat([10]));
  assert.strictEqual(B.pinsStanding(afterStrike), 10);

  const afterStrikeThenSix = play(nine.concat([10, 6]));
  assert.strictEqual(B.pinsStanding(afterStrikeThenSix), 4);

  const afterSpare = play(nine.concat([3, 7]));
  assert.strictEqual(B.pinsStanding(afterSpare), 10);
});

test('illegal rolls are rejected', () => {
  const game = play([4]);
  assert.strictEqual(B.roll(game, 7), false); // only 6 pins left
  assert.strictEqual(B.roll(game, -1), false);
  assert.strictEqual(B.roll(game, 1.5), false);
  assert.deepStrictEqual(game.frames[0], [4]);

  const over = play(repeat(12, 10));
  assert.strictEqual(B.roll(over, 10), false); // game is finished
});

test('undo removes the last roll only', () => {
  const game = play([10, 7]);
  assert.strictEqual(B.undo(game), true);
  assert.deepStrictEqual(game.frames[1], []);
  assert.strictEqual(B.undo(game), true);
  assert.deepStrictEqual(game.frames[0], []);
  assert.strictEqual(B.undo(game), false);
});

test('max possible starts at 300 and tracks what is still reachable', () => {
  assert.strictEqual(B.maxPossible(B.createGame()), 300);

  // A first ball of 9 costs the strike but a spare can still follow.
  assert.strictEqual(B.maxPossible(play([9])), 290);

  // Leaving the frame open costs the spare bonus too.
  assert.strictEqual(B.maxPossible(play([9, 0])), 279);

  // Once every ball is thrown the max equals the final score.
  const finished = play(repeat(21, 5));
  assert.strictEqual(B.maxPossible(finished), B.score(finished).total);
});

test('max possible never drops below the score already earned', () => {
  const game = B.createGame();
  const sequence = [10, 7, 3, 9, 0, 10, 0, 8, 8, 2, 0, 6, 10, 10, 10, 8, 1];
  for (const pins of sequence) {
    B.roll(game, pins);
    assert.ok(B.maxPossible(game) >= B.score(game).total);
    assert.ok(B.maxPossible(game) <= 300);
  }
});

test('marks render the scoresheet symbols', () => {
  assert.deepStrictEqual(B.marks([10]), ['X']);
  assert.deepStrictEqual(B.marks([4, 6]), ['4', '/']);
  assert.deepStrictEqual(B.marks([0, 10]), ['-', '/']);
  assert.deepStrictEqual(B.marks([9, 0]), ['9', '-']);
  assert.deepStrictEqual(B.marks([10, 10, 10]), ['X', 'X', 'X']);
  assert.deepStrictEqual(B.marks([10, 3, 7]), ['X', '3', '/']);
  assert.deepStrictEqual(B.marks([4, 6, 10]), ['4', '/', 'X']);
  assert.deepStrictEqual(B.marks([10, 0, 10]), ['X', '-', '/']);
});
