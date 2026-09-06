/* Strike — mobile bowling score tracker. UI layer; the maths lives in scoring.js. */
(function () {
  'use strict';

  var STORAGE_KEY = 'strike.game.v1';
  var MAX_PLAYERS = 8;

  var el = {
    players: document.getElementById('players'),
    board: document.getElementById('board'),
    boardWrap: document.querySelector('.board-wrap'),
    keys: document.getElementById('keys'),
    score: document.getElementById('score'),
    scoreSub: document.getElementById('scoreSub'),
    max: document.getElementById('max'),
    maxSub: document.getElementById('maxSub'),
    bar: document.getElementById('bar'),
    turnInfo: document.getElementById('turnInfo'),
    pinsInfo: document.getElementById('pinsInfo'),
    undoBtn: document.getElementById('undoBtn'),
    menuBtn: document.getElementById('menuBtn'),
    sheet: document.getElementById('sheet'),
    scrim: document.getElementById('scrim'),
    roster: document.getElementById('roster'),
    addPlayerBtn: document.getElementById('addPlayerBtn'),
    newGameBtn: document.getElementById('newGameBtn'),
    results: document.getElementById('results'),
    resultsTitle: document.getElementById('resultsTitle'),
    standings: document.getElementById('standings'),
    playAgainBtn: document.getElementById('playAgainBtn'),
    reviewBtn: document.getElementById('reviewBtn')
  };

  var state = { players: [], active: 0 };
  var history = [];
  var resultsDismissed = false;
  var numberKeys = [];
  var markKey = null;

  /* ---------- state ---------- */

  function newPlayer(name) {
    return { name: name, game: Bowling.createGame() };
  }

  function activePlayer() {
    return state.players[state.active];
  }

  function snapshot() {
    return JSON.stringify({
      active: state.active,
      players: state.players.map(function (p) {
        return { name: p.name, frames: p.game.frames };
      })
    });
  }

  function restore(json) {
    var data = JSON.parse(json);
    state.active = data.active;
    state.players = data.players.map(function (p) {
      var player = newPlayer(p.name);
      player.game.frames = p.frames.map(function (f) { return f.slice(); });
      return player;
    });
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, snapshot());
    } catch (e) {
      /* private mode / full quota — the game just won't survive a reload */
    }
  }

  function load() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return false;
    }
    if (!raw) return false;
    try {
      restore(raw);
      // Trust nothing that came out of storage: it must be a legal game.
      if (!state.players.length || !state.players.every(validGame)) throw new Error('bad save');
      if (!(state.active >= 0 && state.active < state.players.length)) state.active = 0;
      return true;
    } catch (e) {
      state.players = [];
      return false;
    }
  }

  function validGame(player) {
    var frames = player.game.frames;
    if (!Array.isArray(frames) || frames.length !== Bowling.FRAMES) return false;
    var replay = Bowling.createGame();
    for (var i = 0; i < frames.length; i++) {
      if (!Array.isArray(frames[i])) return false;
      for (var j = 0; j < frames[i].length; j++) {
        if (!Bowling.roll(replay, frames[i][j])) return false;
      }
    }
    // The replay must land the rolls in the same frames they claim to be in.
    return JSON.stringify(replay.frames) === JSON.stringify(frames);
  }

  function gameOverForEveryone() {
    return state.players.every(function (p) { return Bowling.isGameOver(p.game); });
  }

  /* ---------- actions ---------- */

  function pushHistory() {
    history.push(snapshot());
    if (history.length > 200) history.shift();
  }

  function roll(pins) {
    var player = activePlayer();
    if (!player || !Bowling.isLegalRoll(player.game, pins)) return;

    pushHistory();
    var frameIndex = Bowling.currentFrame(player.game);
    Bowling.roll(player.game, pins);
    buzz(pins === 10 ? 18 : 8);

    // Hand the lane over as soon as the frame is finished.
    if (state.players.length > 1 && Bowling.isFrameComplete(player.game.frames, frameIndex)) {
      state.active = nextPlayerIndex();
    }

    resultsDismissed = false;
    save();
    render();
  }

  function nextPlayerIndex() {
    var n = state.players.length;
    for (var step = 1; step <= n; step++) {
      var i = (state.active + step) % n;
      if (!Bowling.isGameOver(state.players[i].game)) return i;
    }
    return state.active;
  }

  function undo() {
    if (!history.length) return;
    restore(history.pop());
    resultsDismissed = false;
    buzz(8);
    save();
    render();
  }

  function newGame() {
    pushHistory();
    state.players.forEach(function (p) { p.game = Bowling.createGame(); });
    state.active = 0;
    resultsDismissed = false;
    save();
    render();
  }

  function addPlayer() {
    if (state.players.length >= MAX_PLAYERS) return;
    pushHistory();
    state.players.push(newPlayer('Player ' + (state.players.length + 1)));
    save();
    render();
  }

  function removePlayer(index) {
    if (state.players.length < 2) return;
    pushHistory();
    state.players.splice(index, 1);
    if (state.active >= state.players.length) state.active = state.players.length - 1;
    save();
    render();
  }

  function selectPlayer(index) {
    state.active = index;
    save();
    render();
  }

  function buzz(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) { /* not supported */ }
  }

  /* The next ball gets a full rack — so a 10 would be a strike, not a spare. */
  function isFreshRack(game) {
    var i = Bowling.currentFrame(game);
    if (i === -1) return false;
    var f = game.frames[i];
    if (f.length === 0) return true;
    if (i < Bowling.FRAMES - 1) return false;
    if (f.length === 1) return f[0] === Bowling.PINS;
    return f[0] === Bowling.PINS ? f[1] === Bowling.PINS : true;
  }

  /* ---------- rendering ---------- */

  function render() {
    var player = activePlayer();
    var result = Bowling.score(player.game);
    var max = Bowling.maxPossible(player.game);
    var over = Bowling.isGameOver(player.game);

    renderPlayers();
    renderBoard(player.game, result);
    renderStats(player.game, result, max, over);
    renderKeys(player.game, over);
    renderRoster();
    renderResults();

    el.undoBtn.disabled = history.length === 0;
  }

  function renderPlayers() {
    el.players.innerHTML = '';
    state.players.forEach(function (p, i) {
      var chip = document.createElement('button');
      chip.className = 'player-chip' +
        (i === state.active ? ' active' : '') +
        (Bowling.isGameOver(p.game) ? ' done' : '');
      chip.innerHTML = '<span class="pname"></span><span class="pscore"></span>';
      chip.querySelector('.pname').textContent = p.name;
      chip.querySelector('.pscore').textContent = Bowling.score(p.game).total;
      chip.addEventListener('click', function () { selectPlayer(i); });
      el.players.appendChild(chip);
    });

    if (state.players.length < MAX_PLAYERS) {
      var add = document.createElement('button');
      add.className = 'player-chip add';
      add.textContent = '+ Player';
      add.addEventListener('click', addPlayer);
      el.players.appendChild(add);
    }
  }

  function renderBoard(game, result) {
    var current = Bowling.currentFrame(game);
    el.board.innerHTML = '';

    for (var i = 0; i < Bowling.FRAMES; i++) {
      var frame = game.frames[i];
      var marks = Bowling.marks(frame);
      var boxes = i === Bowling.FRAMES - 1 ? 3 : 2;

      var cell = document.createElement('div');
      cell.className = 'frame' + (i === current ? ' current' : '');

      var no = document.createElement('div');
      no.className = 'fno';
      no.textContent = i + 1;
      cell.appendChild(no);

      // A strike in frames 1-9 sits in the second box, as on a paper scoresheet.
      var shown = (i < Bowling.FRAMES - 1 && marks[0] === 'X') ? ['', 'X'] : marks;

      var rolls = document.createElement('div');
      rolls.className = 'rolls';
      for (var b = 0; b < boxes; b++) {
        var mark = shown[b];
        var box = document.createElement('div');
        box.className = 'roll' +
          (mark === 'X' ? ' strike' : '') +
          (mark === '/' ? ' spare' : '') +
          (mark === undefined || mark === '' ? ' empty' : '');
        box.textContent = mark === undefined ? '' : mark;
        rolls.appendChild(box);
      }
      cell.appendChild(rolls);

      var total = document.createElement('div');
      var value = result.cumulative[i];
      total.className = 'total' + (value === null ? ' pending' : '');
      total.textContent = value === null ? (frame.length ? '–' : '') : value;
      cell.appendChild(total);

      el.board.appendChild(cell);
    }

    var currentCell = el.board.children[current];
    if (currentCell && currentCell.scrollIntoView) {
      currentCell.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderStats(game, result, max, over) {
    var scored = result.cumulative.filter(function (v) { return v !== null; }).length;
    var frame = Bowling.currentFrame(game);
    var ball = Bowling.currentBall(game);
    var standing = Bowling.pinsStanding(game);

    el.score.textContent = result.total;
    el.scoreSub.textContent = scored ? 'through frame ' + scored : 'no frames scored yet';

    el.max.textContent = max;
    el.maxSub.textContent = over
      ? 'game complete'
      : max === 300 ? 'a perfect game is still on'
        : '+' + (max - result.total) + ' still on the table';

    el.bar.style.width = (max ? Math.round((result.total / max) * 100) : 0) + '%';

    if (over) {
      el.turnInfo.innerHTML = '<b>Game over</b> · ' + escapeHtml(activePlayer().name);
      el.pinsInfo.textContent = 'final score ' + result.total;
    } else {
      el.turnInfo.innerHTML = '<b>' + escapeHtml(activePlayer().name) + '</b> · Frame ' +
        (frame + 1) + ' · Ball ' + ball;
      el.pinsInfo.textContent = standing + (standing === 1 ? ' pin standing' : ' pins standing');
    }
  }

  function buildKeys() {
    for (var n = 0; n <= 9; n++) {
      var key = document.createElement('button');
      key.className = 'key';
      key.textContent = n;
      key.dataset.pins = n;
      key.addEventListener('click', onKey);
      numberKeys.push(key);
      el.keys.appendChild(key);
    }

    markKey = document.createElement('button');
    markKey.className = 'key wide';
    markKey.addEventListener('click', onMarkKey);
    el.keys.appendChild(markKey);
  }

  function onKey(event) {
    roll(Number(event.currentTarget.dataset.pins));
  }

  function onMarkKey() {
    if (markKey.disabled) return;
    if (markKey.dataset.action === 'results') {
      resultsDismissed = false;
      renderResults();
      return;
    }
    roll(Number(markKey.dataset.pins));
  }

  function renderKeys(game, over) {
    var standing = Bowling.pinsStanding(game);
    var fresh = isFreshRack(game);
    var everyoneDone = gameOverForEveryone();

    numberKeys.forEach(function (key, n) {
      key.disabled = over || n > standing;
    });

    markKey.dataset.pins = standing;
    markKey.dataset.action = 'roll';
    markKey.classList.toggle('spare', !over && !fresh);
    markKey.classList.remove('ghost');

    if (!over) {
      markKey.disabled = false;
      markKey.textContent = fresh ? '✕  STRIKE' : '/  SPARE  ·  ' + standing;
    } else if (everyoneDone && resultsDismissed) {
      markKey.disabled = false;
      markKey.dataset.action = 'results';
      markKey.classList.add('ghost');
      markKey.textContent = 'SHOW RESULTS';
    } else {
      markKey.disabled = true;
      markKey.textContent = everyoneDone ? 'GAME OVER' : 'PLAYER FINISHED';
    }
  }

  function renderRoster() {
    // Never rebuild the list out from under a name being typed.
    if (el.roster.contains(document.activeElement)) return;
    el.roster.innerHTML = '';
    state.players.forEach(function (p, i) {
      var row = document.createElement('div');
      row.className = 'roster-row';

      var input = document.createElement('input');
      input.type = 'text';
      input.value = p.name;
      input.maxLength = 18;
      input.setAttribute('aria-label', 'Player name');
      input.addEventListener('input', function () {
        p.name = input.value;
        save();
        renderPlayers();
        renderStats(activePlayer().game, Bowling.score(activePlayer().game),
          Bowling.maxPossible(activePlayer().game), Bowling.isGameOver(activePlayer().game));
      });
      input.addEventListener('blur', function () {
        if (!input.value.trim()) {
          p.name = 'Player ' + (i + 1);
          save();
          render();
        }
      });
      row.appendChild(input);

      if (state.players.length > 1) {
        var remove = document.createElement('button');
        remove.className = 'icon-btn';
        remove.setAttribute('aria-label', 'Remove ' + p.name);
        remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';
        confirmTwice(remove, 'Sure?', function () { removePlayer(i); });
        row.appendChild(remove);
      }

      el.roster.appendChild(row);
    });
  }

  function renderResults() {
    var finished = gameOverForEveryone();
    var show = finished && !resultsDismissed;

    el.results.classList.toggle('open', show);
    // The keypad is dead once every game is over — give the space to the card.
    var app = document.querySelector('.app');
    app.classList.toggle('all-done', finished);
    app.classList.toggle('results-open', show);

    if (!finished) {
      el.boardWrap.style.paddingBottom = '';
      return;
    }

    var ranked = state.players
      .map(function (p) { return { name: p.name, total: Bowling.score(p.game).total }; })
      .sort(function (a, b) { return b.total - a.total; });

    el.resultsTitle.textContent = state.players.length > 1
      ? ranked[0].name + ' wins'
      : 'Final score · ' + ranked[0].total;

    el.standings.innerHTML = '';
    ranked.forEach(function (entry, i) {
      var rank = i > 0 && ranked[i - 1].total === entry.total ? null : i + 1;
      var row = document.createElement('div');
      row.className = 'standing' + (entry.total === ranked[0].total ? ' win' : '');
      row.innerHTML = '<span class="rank"></span><span class="who"></span><span class="pts"></span>';
      row.querySelector('.rank').textContent = rank === null ? '' : rank;
      row.querySelector('.who').textContent = entry.name;
      row.querySelector('.pts').textContent = entry.total;
      el.standings.appendChild(row);
    });

    // Keep the whole scorecard visible above the card once it is laid out.
    el.boardWrap.style.paddingBottom = show
      ? el.results.querySelector('.results-card').offsetHeight + 24 + 'px'
      : '';
  }

  /* Turns a destructive button into a two-tap confirm instead of a native dialog. */
  function confirmTwice(button, prompt, action) {
    var armed = false;
    var original = button.innerHTML;
    var timer = null;

    button.addEventListener('click', function () {
      if (armed) {
        clearTimeout(timer);
        action();
        return;
      }
      armed = true;
      button.textContent = prompt;
      if (button.classList.contains('icon-btn')) button.classList.add('wide-confirm');
      timer = setTimeout(function () {
        armed = false;
        button.innerHTML = original;
        button.classList.remove('wide-confirm');
      }, 2600);
    });
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- sheet ---------- */

  function openSheet() {
    el.sheet.classList.add('open');
    el.scrim.classList.add('open');
  }

  function closeSheet() {
    el.sheet.classList.remove('open');
    el.scrim.classList.remove('open');
  }

  /* ---------- wiring ---------- */

  function init() {
    if (!load()) state.players = [newPlayer('Player 1')];

    buildKeys();

    el.undoBtn.addEventListener('click', undo);
    el.menuBtn.addEventListener('click', openSheet);
    el.scrim.addEventListener('click', closeSheet);
    document.getElementById('closeSheetBtn').addEventListener('click', closeSheet);
    el.addPlayerBtn.addEventListener('click', addPlayer);
    el.playAgainBtn.addEventListener('click', function () {
      newGame();
      closeSheet();
    });
    el.reviewBtn.addEventListener('click', function () {
      resultsDismissed = true;
      render();
    });
    confirmTwice(el.newGameBtn, 'Tap again to reset', function () {
      newGame();
      closeSheet();
    });

    document.addEventListener('keydown', function (event) {
      if (event.target.tagName === 'INPUT') return;
      var key = event.key;
      if (key >= '0' && key <= '9') roll(Number(key));
      else if (key === 'x' || key === 'X' || key === '/' || key === 'Enter') onMarkKey();
      else if (key === 'Backspace' || key === 'z') undo();
      else if (key === 'Escape') closeSheet();
      else return;
      event.preventDefault();
    });

    render();
  }

  init();
})();
