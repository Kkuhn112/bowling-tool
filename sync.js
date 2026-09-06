/*
 * Client side of shared games.
 *
 * Sends each tap to the server as an op and listens for the room's state over
 * Server-Sent Events. EventSource reconnects on its own, so a phone that loses
 * signal in the alley picks the game back up when it returns.
 *
 * Everything here is optional: with no server reachable, `available()` fails
 * and the app stays in local mode.
 *
 * The server is normally whoever served the page, but it does not have to be:
 * `setServer()` points a statically hosted copy (GitHub Pages, a file on the
 * phone) at a sync server running elsewhere.
 */
(function (root) {
  'use strict';

  var SERVER_KEY = 'strike.server';
  var status = 'offline';   // offline | connecting | live
  var roomCode = null;
  var stream = null;
  var handlers = { state: [], status: [], error: [] };

  /* '' means "whoever served this page". */
  var serverBase = (function () {
    try {
      return localStorage.getItem(SERVER_KEY) || '';
    } catch (e) {
      return '';
    }
  })();

  function api(path) {
    return serverBase + '/api' + path;
  }

  /* Accepts "192.168.1.4:8080", "localhost:8080" or a full URL. */
  function normalizeServer(value) {
    var text = String(value || '').trim().replace(/\/+$/, '');
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) {
      var looksLocal = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[^/]+\.local)(:\d+)?$/i.test(text) || /:\d+$/.test(text);
      text = (looksLocal ? 'http://' : 'https://') + text;
    }
    return text.replace(/\/+$/, '');
  }

  function server() {
    return serverBase;
  }

  /*
   * Points at a sync server. Returns a promise so the caller can report a bad
   * address instead of silently storing one that never answers.
   */
  function setServer(value) {
    var next = normalizeServer(value);

    if (next && location.protocol === 'https:' && next.indexOf('http://') === 0) {
      // The browser blocks this outright, so say so rather than let it fail obscurely.
      return Promise.reject(new Error('this page is on https, so the sync server needs an https address too'));
    }

    var previous = serverBase;
    serverBase = next;
    return available().then(function () {
      try {
        if (next) localStorage.setItem(SERVER_KEY, next);
        else localStorage.removeItem(SERVER_KEY);
      } catch (e) { /* private mode — it just won't be remembered */ }
      return next;
    }, function (err) {
      serverBase = previous;
      throw err;
    });
  }

  var clientId = (function () {
    var key = 'strike.client';
    try {
      var found = sessionStorage.getItem(key);
      if (found) return found;
      var made = Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(key, made);
      return made;
    } catch (e) {
      return Math.random().toString(36).slice(2, 10);
    }
  })();

  function emit(name, value) {
    handlers[name].forEach(function (fn) { fn(value); });
  }

  function setStatus(next) {
    if (status === next) return;
    status = next;
    emit('status', status);
  }

  function on(name, fn) {
    if (handlers[name]) handlers[name].push(fn);
  }

  /* Sharing needs either a server that served this page, or one named explicitly. */
  function canSync() {
    return serverBase !== '' || location.protocol === 'http:' || location.protocol === 'https:';
  }

  /* Says what is wrong and what to do about it, for whichever way this copy is running. */
  function unreachable() {
    if (serverBase) return new Error('nothing answered at ' + serverBase);
    if (location.protocol === 'file:') {
      return new Error('this copy is a file on the device — run npm start, then add that server’s address below');
    }
    return new Error('no sync server at ' + location.host + ' — run npm start there, or add another server’s address below');
  }

  function request(path, options) {
    return fetch(api(path), Object.assign({
      headers: { 'content-type': 'application/json', 'x-client-id': clientId }
    }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { status: res.status, ok: res.ok, body: body };
      });
    });
  }

  /* Resolves if a sync server is answering. */
  function available() {
    if (!canSync()) return Promise.reject(unreachable());
    return request('/health').then(function (res) {
      if (!res.ok) throw unreachable();
      return true;
    }, function () {
      throw unreachable();
    });
  }

  function listen(code) {
    close();
    roomCode = code;
    setStatus('connecting');

    stream = new EventSource(api('/rooms/' + encodeURIComponent(code) + '/events'));

    stream.addEventListener('state', function (event) {
      setStatus('live');
      try {
        emit('state', JSON.parse(event.data));
      } catch (e) {
        /* a torn frame — the next one will carry the same state */
      }
    });

    // EventSource retries by itself; this only reflects that in the UI.
    stream.onerror = function () {
      if (stream && stream.readyState === EventSource.CLOSED) setStatus('offline');
      else setStatus('connecting');
    };
  }

  /* Starts a room seeded with the game already on this phone. */
  function create(serializedState) {
    return available().then(function () {
      return request('/rooms', { method: 'POST', body: JSON.stringify({ state: serializedState }) });
    }).then(function (res) {
      if (!res.ok) throw new Error(res.body.error || 'could not start a shared game');
      listen(res.body.code);
      emit('state', res.body);
      return res.body;
    });
  }

  function join(code) {
    var clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(clean)) return Promise.reject(new Error('a game code is four letters'));

    return available().then(function () {
      return request('/rooms/' + clean);
    }).then(function (res) {
      if (!res.ok) throw new Error(res.body.error || 'no game with that code');
      listen(clean);
      emit('state', res.body);
      return res.body;
    });
  }

  function close() {
    if (stream) {
      stream.close();
      stream = null;
    }
  }

  function leave() {
    close();
    roomCode = null;
    setStatus('offline');
  }

  /*
   * Sends one op. Resolves with the room's state either way: on a refusal the
   * server hands back the truth, which is what the phone should be showing.
   */
  function send(op) {
    if (!roomCode) return Promise.resolve({ ok: false, error: 'not in a shared game' });

    return request('/rooms/' + roomCode + '/ops', {
      method: 'POST',
      body: JSON.stringify({ op: op, clientId: clientId })
    }).then(function (res) {
      if (res.status === 404) {
        leave();
        return { ok: false, error: 'that shared game has ended' };
      }
      return { ok: res.ok, error: res.ok ? null : res.body.error, payload: res.body.state ? res.body : null };
    }, function () {
      setStatus('connecting');
      return { ok: false, error: 'lost the connection — trying again' };
    });
  }

  root.Sync = {
    clientId: clientId,
    on: on,
    available: available,
    canSync: canSync,
    server: server,
    setServer: setServer,
    create: create,
    join: join,
    leave: leave,
    send: send,
    code: function () { return roomCode; },
    status: function () { return status; },
    isLive: function () { return roomCode !== null; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
