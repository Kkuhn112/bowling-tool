# Strike — mobile bowling score tracker

A phone-sized web app for keeping score during a game of ten-pin bowling, with
the **maximum score still possible** updated after every ball.

No build step, no dependencies, no network — three static files you can open
straight from disk or host anywhere.

## Using it

Open `index.html` in a browser, or serve the folder:

```sh
npx http-server . -p 8080     # then open http://localhost:8080 on your phone
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

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup and the page shell |
| `styles.css` | All styling — dark, touch-first, safe-area aware |
| `scoring.js` | Scoring engine: frames, bonuses, legal rolls, max possible |
| `app.js` | UI layer — rendering, players, undo, persistence |
| `test/` | Tests for the scoring engine |

`scoring.js` is deliberately free of DOM code so the rules can be tested on
their own; it loads as a plain `<script>` in the browser and as a CommonJS
module in Node.

## Tests

```sh
npm test
```

Covers the awkward parts of bowling scoring: strike and spare bonuses, frames
that can't be scored yet, the tenth frame's third ball, illegal rolls, and the
max-possible projection.

## Hosting it

Any static host works. For GitHub Pages: repository **Settings → Pages →
Deploy from a branch**, pick this branch and the root folder.
