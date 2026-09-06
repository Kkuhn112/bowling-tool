/* Strike — UI layer. Rules live in scoring.js, state changes in ops.js, sharing in sync.js. */
(function () {
  'use strict';

  var STORAGE_KEY = 'strike.game.v2';

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
    liveChip: document.getElementById('liveChip'),
    toast: document.getElementById('toast'),
    sheet: document.getElementById('sheet'),
    scrim: document.getElementById('scrim'),
    syncPanel: document.getElementById('syncPanel'),
    roster: document.getElementById('roster'),
    addPlayerBtn: document.getElementById('addPlayerBtn'),
    newGameBtn: document.getElementById('newGameBtn'),
    results: document.getElementById('results'),
    resultsTitle: document.getElementById('resultsTitle'),
    standings: document.getElementById('standings'),
    playAgainBtn: document.getElementById('playAgainBtn'),
    reviewBtn: document.getElementById('reviewBtn')
  };

  var state = Ops.newState();
  var games = {};            // player id -> scored game, rebuilt every render
  var serverVersion = 0;     // last version the server confirmed
  var viewers = 0;
  var resultsDismissed = false;
  var syncNote = '';         // why sharing is unavailable, if it is
  var numberKeys = [];
  var markKey = null;
  var toastTimer = null;

  /* ---------- state plumbing ---------- */

  function activePlayer() {
    return state.players[state.active] || state.players[0];
  }

  function activeGame() {
    return games[activePlayer().id];
  }

  function save() {
    if (Sync.isLive()) return; // a shared game lives on the server
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Ops.serialize(state)));
    } catch (e) {
      /* private mode or full quota — the game just won't survive a reload */
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var restored = Ops.deserialize(JSON.parse(raw));
      if (!restored) return false;
      state = restored;
      return true;
    } catch (e) {
      return false;
    }
  }

  /*
   * The one way the game changes. Locally it just applies; in a shared game it
   * also goes to the server, whose reply is the version everyone ends up on.
   */
  function commit(op) {
    op.clientId = Sync.clientId;

    if (!Sync.isLive()) {
      var local = Ops.apply(state, op);
      if (!local.ok) return toast(local.reason);
      save();
      render();
      return;
    }

    // Undo is the one op that must not race: it carries the version it undoes,
    // so it can never quietly delete a ball this phone hasn't seen yet.
    if (op.type === 'undo') {
      op.baseVersion = serverVersion;
      Sync.send(op).then(handleReply);
      return;
    }

    var optimistic = Ops.apply(state, op);
    if (!optimistic.ok) return toast(optimistic.reason);
    render();
    Sync.send(op).then(handleReply);
  }

  function handleReply(reply) {
    if (reply.payload) adopt(reply.payload);
    if (!reply.ok && reply.error) toast(reply.error);
  }

  /* Takes the server's word for the state of the game. */
  function adopt(payload) {
    var next = Ops.deserialize(payload.state);
    if (!next) return;

    var lastOp = payload.state.lastOp;
    var moved = next.version !== state.version;

    state = next;
    serverVersion = next.version;
    viewers = payload.viewers || 0;
    if (moved) resultsDismissed = false;

    // Say who did what, but only for the phone that didn't do it.
    if (moved && lastOp && lastOp.by && lastOp.clientId !== Sync.clientId) {
      toast(lastOp.by + ' ' + lastOp.label, 'remote');
    }
    render();
  }

  function buzz(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) { /* not supported */ }
  }

  function toast(text, kind) {
    if (!text) return;
    el.toast.textContent = text;
    el.toast.className = 'toast open' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.className = 'toast';
    }, 2800);
  }

  /* ---------- actions ---------- */

  function roll(pins) {
    var game = activeGame();
    if (!game || !Bowling.isLegalRoll(game, pins)) return;
    buzz(pins === Bowling.PINS ? 18 : 8);
    commit({ type: 'roll', playerId: activePlayer().id, pins: pins });
  }

  function undo() {
    buzz(8);
    commit({ type: 'undo' });
  }

  function newGame() {
    commit({ type: 'new_game' });
  }

  function addPlayer() {
    // The id is chosen here so this phone and the server agree on it.
    commit({ type: 'add_player', id: Ops.makeId(), name: 'Player ' + (state.players.length + 1) });
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

  function everyoneDone() {
    return state.players.every(function (p) { return Bowling.isGameOver(games[p.id]); });
  }

  /* ---------- rendering ---------- */

  function render() {
    games = Ops.games(state);

    var game = activeGame();
    var result = Bowling.score(game);
    var max = Bowling.maxPossible(game);
    var over = Bowling.isGameOver(game);

    renderPlayers();
    renderBoard(game, result);
    renderStats(game, result, max, over);
    renderKeys(game, over);
    renderLive();
    renderSyncPanel();
    renderRoster();
    renderResults();

    el.undoBtn.disabled = state.rolls.length === 0;
  }

  function renderPlayers() {
    el.players.innerHTML = '';
    state.players.forEach(function (p, i) {
      var chip = document.createElement('button');
      chip.className = 'player-chip' +
        (i === state.active ? ' active' : '') +
        (Bowling.isGameOver(games[p.id]) ? ' done' : '');
      chip.innerHTML = '<span class="pname"></span><span class="pscore"></span>';
      chip.querySelector('.pname').textContent = p.name;
      chip.querySelector('.pscore').textContent = Bowling.score(games[p.id]).total;
      chip.addEventListener('click', function () {
        commit({ type: 'select_player', playerId: p.id });
      });
      el.players.appendChild(chip);
    });

    if (state.players.length < Ops.MAX_PLAYERS) {
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
    if (currentCell && currentCell.scrollIntoView) currentCell.scrollIntoView({ block: 'nearest' });
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
      render();
      return;
    }
    roll(Number(markKey.dataset.pins));
  }

  function renderKeys(game, over) {
    var standing = Bowling.pinsStanding(game);
    var fresh = isFreshRack(game);
    var done = everyoneDone();

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
    } else if (done && resultsDismissed) {
      markKey.disabled = false;
      markKey.dataset.action = 'results';
      markKey.classList.add('ghost');
      markKey.textContent = 'SHOW RESULTS';
    } else {
      markKey.disabled = true;
      markKey.textContent = done ? 'GAME OVER' : 'PLAYER FINISHED';
    }
  }

  function renderLive() {
    var live = Sync.isLive();
    el.liveChip.hidden = !live;
    if (!live) return;

    var status = Sync.status();
    el.liveChip.className = 'live-chip ' + status;
    el.liveChip.innerHTML = '<span class="dot"></span><span class="code"></span><span class="count"></span>';
    el.liveChip.querySelector('.code').textContent = Sync.code();
    el.liveChip.querySelector('.count').textContent = status === 'live'
      ? (viewers > 1 ? viewers + ' phones' : '1 phone')
      : 'reconnecting';
  }

  function renderSyncPanel() {
    // Text being typed here must survive an update arriving from the other
    // phone — but a focused button is no reason to hold back a redraw.
    var typing = document.activeElement;
    if (typing && typing.tagName === 'INPUT' && el.syncPanel.contains(typing)) return;
    el.syncPanel.innerHTML = '';

    if (Sync.isLive()) {
      var live = document.createElement('div');
      live.className = 'room';
      live.innerHTML =
        '<div class="room-code"></div>' +
        '<p class="hint">Anyone on this code can enter scores — the card stays in step on every phone.</p>';
      live.querySelector('.room-code').textContent = Sync.code();

      var copy = button('Copy invite link', 'sheet-btn', function () {
        var link = location.origin + location.pathname + '#' + Sync.code();
        var done = function () { toast('Link copied'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(done, function () { toast(link); });
        } else {
          toast(link);
        }
      });

      var leave = button('Leave shared game', 'sheet-btn danger', function () {
        Sync.leave();
        history.replaceState(null, '', location.pathname + location.search);
        save();
        render();
        toast('Back to keeping score on this phone');
      });

      el.syncPanel.appendChild(live);
      el.syncPanel.appendChild(copy);
      el.syncPanel.appendChild(leave);
      return;
    }

    var start = button('Start a shared game', 'sheet-btn primary', function () {
      start.disabled = true;
      Sync.create(Ops.serialize(state)).then(function (payload) {
        location.hash = payload.code;
        adopt(payload);
        toast('Share code ' + payload.code);
      }, function (err) {
        syncNote = err.message;
        start.disabled = false;
        render();
      });
    });

    var joinRow = document.createElement('form');
    joinRow.className = 'join-row';
    joinRow.innerHTML =
      '<input id="joinCode" inputmode="latin" autocomplete="off" autocapitalize="characters" ' +
      'spellcheck="false" maxlength="4" placeholder="CODE" aria-label="Game code">' +
      '<button class="sheet-btn" type="submit">Join</button>';
    joinRow.addEventListener('submit', function (event) {
      event.preventDefault();
      joinRoom(joinRow.querySelector('#joinCode').value);
    });

    el.syncPanel.appendChild(start);
    el.syncPanel.appendChild(joinRow);

    var note = document.createElement('p');
    note.className = 'hint';
    note.textContent = syncNote ||
      'Start a game to get a four-letter code, then hand it to whoever is sitting with the other phone.';
    el.syncPanel.appendChild(note);

    // Only worth showing once this copy has no server of its own, or is already
    // pointed at one — otherwise it is a setting nobody needs to think about.
    if (syncNote || Sync.server()) el.syncPanel.appendChild(serverRow());
  }

  /* Points a statically hosted copy at a sync server running somewhere else. */
  function serverRow() {
    var wrap = document.createElement('div');

    var row = document.createElement('form');
    row.className = 'server-row';
    // Deliberately not type="url": an address like 192.168.1.4:8080 is exactly
    // what people have to hand, and the browser would refuse to submit it.
    row.innerHTML =
      '<input id="serverUrl" type="text" inputmode="url" autocomplete="off" spellcheck="false" ' +
      'placeholder="192.168.1.4:8080" aria-label="Sync server address">' +
      '<button class="sheet-btn" type="submit">Use</button>';

    var input = row.querySelector('#serverUrl');
    input.value = Sync.server();

    row.addEventListener('submit', function (event) {
      event.preventDefault();
      var button = row.querySelector('button');
      button.disabled = true;
      Sync.setServer(input.value).then(function (url) {
        syncNote = '';
        input.blur(); // let the panel redraw into its connected state
        toast(url ? 'Connected to ' + url : 'Using this site');
        render();
      }, function (err) {
        syncNote = err.message;
        button.disabled = false;
        render();
      });
    });

    wrap.appendChild(row);

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = Sync.server()
      ? 'Sharing is going through this server. Clear the box and tap Use to go back to this site.'
      : 'Running the server elsewhere? Put its address here — the one npm start prints for your network.';
    wrap.appendChild(hint);

    return wrap;
  }

  function joinFromHash() {
    var invited = location.hash.replace('#', '').toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(invited)) return;
    if (!Sync.canSync() || Sync.code() === invited) return;
    joinRoom(invited);
  }

  function joinRoom(code) {
    return Sync.join(code).then(function (payload) {
      location.hash = payload.code;
      adopt(payload);
      closeSheet();
      toast('Joined game ' + payload.code);
    }, function (err) {
      syncNote = err.message;
      toast(err.message);
      render();
    });
  }

  function button(text, className, onClick) {
    var el2 = document.createElement('button');
    el2.className = className;
    el2.textContent = text;
    el2.addEventListener('click', onClick);
    return el2;
  }

  function renderRoster() {
    // Never rebuild the list out from under a name being typed.
    if (el.roster.contains(document.activeElement)) return;
    el.roster.innerHTML = '';

    state.players.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'roster-row';

      var input = document.createElement('input');
      input.type = 'text';
      input.value = p.name;
      input.maxLength = 18;
      input.setAttribute('aria-label', 'Player name');
      // Committed on blur or Enter, so a shared game isn't spammed per keystroke.
      input.addEventListener('change', function () {
        commit({ type: 'rename_player', playerId: p.id, name: input.value });
      });
      input.addEventListener('blur', function () {
        if (input.value !== p.name) commit({ type: 'rename_player', playerId: p.id, name: input.value });
      });
      row.appendChild(input);

      if (state.players.length > 1) {
        var remove = document.createElement('button');
        remove.className = 'icon-btn';
        remove.setAttribute('aria-label', 'Remove ' + p.name);
        remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';
        confirmTwice(remove, 'Sure?', function () {
          commit({ type: 'remove_player', playerId: p.id });
        });
        row.appendChild(remove);
      }

      el.roster.appendChild(row);
    });
  }

  function renderResults() {
    var finished = everyoneDone();
    var show = finished && !resultsDismissed;

    el.results.classList.toggle('open', show);
    var app = document.querySelector('.app');
    app.classList.toggle('all-done', finished);
    app.classList.toggle('results-open', show);

    if (!finished) {
      el.boardWrap.style.paddingBottom = '';
      return;
    }

    var ranked = state.players
      .map(function (p) { return { name: p.name, total: Bowling.score(games[p.id]).total }; })
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
  function confirmTwice(target, prompt, action) {
    var armed = false;
    var original = target.innerHTML;
    var timer = null;

    target.addEventListener('click', function () {
      if (armed) {
        clearTimeout(timer);
        action();
        return;
      }
      armed = true;
      target.textContent = prompt;
      if (target.classList.contains('icon-btn')) target.classList.add('wide-confirm');
      timer = setTimeout(function () {
        armed = false;
        target.innerHTML = original;
        target.classList.remove('wide-confirm');
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

    // Find out whether sharing is even possible before the user taps and waits.
    if (!Sync.isLive()) {
      Sync.available().then(function () {
        if (!syncNote) return;
        syncNote = '';
        render();
      }, function (err) {
        if (syncNote === err.message) return;
        syncNote = err.message;
        render();
      });
    }
  }

  function closeSheet() {
    el.sheet.classList.remove('open');
    el.scrim.classList.remove('open');
  }

  /* ---------- wiring ---------- */

  function init() {
    load();
    buildKeys();

    el.undoBtn.addEventListener('click', undo);
    el.menuBtn.addEventListener('click', openSheet);
    el.liveChip.addEventListener('click', openSheet);
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

    Sync.on('state', adopt);
    Sync.on('status', function (status) {
      renderLive();
      if (status === 'connecting') toast('Reconnecting…');
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

    // An invite link (#CODE) drops you straight into that game — on load, and
    // on a tap that only changes the hash because the app is already open.
    window.addEventListener('hashchange', joinFromHash);
    joinFromHash();
  }

  init();
})();
