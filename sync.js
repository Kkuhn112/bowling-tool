/*
 * Client side of shared games.
 *
 * Sends each tap to the server as an op and listens for the room's state over
 * Server-Sent Events. EventSource reconnects on its own, so a phone that loses
 * signal in the alley picks the game back up when it returns.
 *
 * Everything here is optional: with no server (opened from a file, or hosted
 * statically) `available()` fails and the app stays in local mode.
 */
(function (root) {
  'use strict';

  var API = '/api';
  var status = 'offline';   // offline | connecting | live
  var roomCode = null;
  var stream = null;
  var handlers = { state: [], status: [], error: [] };

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

  /* The page must come from the sync server for any of this to work. */
  function canSync() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  function request(path, options) {
    return fetch(API + path, Object.assign({
      headers: { 'content-type': 'application/json', 'x-client-id': clientId }
    }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { status: res.status, ok: res.ok, body: body };
      });
    });
  }

  /* Resolves if a sync server is answering on this origin. */
  function available() {
    if (!canSync()) return Promise.reject(new Error('open the app from the sync server to play together'));
    return request('/health').then(function (res) {
      if (!res.ok) throw new Error('this copy is hosted without the sync server');
      return true;
    }, function () {
      throw new Error('this copy is hosted without the sync server');
    });
  }

  function listen(code) {
    close();
    roomCode = code;
    setStatus('connecting');

    stream = new EventSource(API + '/rooms/' + encodeURIComponent(code) + '/events');

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
    create: create,
    join: join,
    leave: leave,
    send: send,
    code: function () { return roomCode; },
    status: function () { return status; },
    isLive: function () { return roomCode !== null; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
