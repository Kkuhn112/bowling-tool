# Strike — mobile bowling score tracker

A phone-sized web app for keeping score during a game of ten-pin bowling, with
the **maximum score still possible** updated after every ball — and an optional
shared mode where everyone's phone scores the same game.

No build step and no dependencies: static files for the app, and a sync server
written against Node's standard library alone.

## Using it

Open `index.html` in a browser for a game on one phone, or run the server to get
the same app plus shared games:

```sh
npm start                     # http://localhost:8080
```

To keep it on a phone, open the page and use **Add to Home Screen** — it runs
full-screen and the game is saved locally, so closing the tab mid-game loses
nothing.

### During a game

- **Tap the pins you knocked down**, or hit the big **STRIKE** / **SPARE**
  button. Counts that can't happen (an 8 when only 3 pins are standing) are
  greyed out, so you can't enter an impossible game.
- The scorecard fills itself in. A frame shows `–` while it is still waiting on
  its bonus balls, exactly like a paper sheet.
- **Max possible** assumes you strike out from here. It starts at 300 and drops
  the moment a strike or spare is missed, so you always know what is still on
  the table.
- **Undo** (top right) steps back through every ball, including the handover
  between players.
- Add players from the `+ Player` chip or the menu. The lane passes to the next
  player automatically when a frame ends; tap a chip to jump to anyone.
- Keyboard shortcuts on a desktop: `0`–`9`, `x` or `/` for the mark button,
  `Backspace` to undo.

## Playing together

Two people, two phones, one scorecard. In the menu, **Start a shared game** gives
you a four-letter code (and an invite link — `…/#PKWH`); anyone who joins it can
enter balls, and every phone sees the card, whose turn it is, and undo in step.

- **Whoever is nearest the ball return scores it.** There is no "your player" —
  any phone can enter the ball for whoever is up.
- **The server decides.** Each tap is sent as an operation and replayed through
  the same scoring rules the browser uses, so two people tapping at once can't
  corrupt the card. An impossible ball is refused and the phone re-syncs.
- **Undo is safe.** It carries the version it is undoing, so it can never
  silently delete a ball that arrived from the other phone in between.
- **Dropouts recover.** Phones reconnect on their own and pick the game back up;
  a reload rejoins from the code in the URL.
- **Nothing is lost when you leave.** Leaving a shared game drops you back to
  keeping score on your own phone.

Without a server — opened from a file, or hosted statically — the app stays in
local mode and the menu says so. Everything else works exactly the same.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup and the page shell |
| `styles.css` | All styling — dark, touch-first, safe-area aware |
| `scoring.js` | Scoring engine: frames, bonuses, legal rolls, max possible |
| `ops.js` | Game state and the operations that change it |
| `sync.js` | Client side of shared games |
| `app.js` | UI layer — rendering, players, undo, persistence |
| `server/server.js` | Static host + room server for shared games |
| `test/` | Tests for the engine, the operations, and the server |

`scoring.js` and `ops.js` carry no DOM code and load both as plain `<script>`
tags in the browser and as CommonJS modules in Node — the phone and the server
run the same rules, which is what keeps a shared game consistent.

State is a log of rolls rather than a pile of frames:

```js
{ players: [{id, name}], rolls: [{playerId, pins}], active: 0, version: 3 }
```

Replaying the log rebuilds every scorecard, and undo is a pop — which is what
makes two people scoring at once safe to reason about.

### Sync API

| Route | Does |
| --- | --- |
| `POST /api/rooms` | Opens a room, optionally seeded with the game already in progress |
| `GET /api/rooms/:code` | Current state of a room |
| `GET /api/rooms/:code/events` | Server-Sent Events stream: a `state` event on every change |
| `POST /api/rooms/:code/ops` | Applies one operation; `409` plus the live state if the game moved on |

Rooms live in memory and are mirrored to `.rooms.json` so a restart doesn't wipe
a game in progress; idle ones are dropped after 12 hours.

Server-Sent Events rather than WebSockets: a scorecard is a handful of small
messages a minute, `EventSource` reconnects by itself, and it needs nothing
beyond Node's own `http` module.

## Tests

```sh
npm test
```

Covers the awkward parts of bowling scoring (strike and spare bonuses, frames
that can't be scored yet, the tenth frame's third ball, illegal rolls, the
max-possible projection), the shared-state operations (handover, undo,
stale-version refusal, replay), and the server end to end — including two
subscribers watching one game update live.

## Hosting it

- **Shared games** need somewhere that runs Node: `npm start`, with `PORT` and
  `HOST` read from the environment. Render, Fly and Railway all take it as-is;
  on a home network, both phones on the same wifi is enough.
- **Local-only** works on any static host, GitHub Pages included: **Settings →
  Pages → Deploy from a branch**, this branch and the root folder. The
  scorekeeping is identical; only the shared mode is unavailable.
