# Checkers

**Live app:** [checkers.puter.com](https://checkers.puter.com/)

Play American checkers (English draughts) against the computer or a friend.
No frameworks — just vanilla JavaScript, HTML, and CSS, built with Vite.

## Features

- **Player vs. Computer** with three difficulty levels (Easy / Medium / Hard)
- **Pass & Play** — two players sharing one device
- **Online play** — private peer-to-peer games over the
  [Puter Peer API](https://docs.puter.com/Peer/) (WebRTC): create a game,
  share the invite code or link, and play with resign and rematch support.
  The Puter SDK is loaded only when online mode is opened.
- **Clocks** — Bullet, Blitz, and Rapid time controls with a Fischer
  increment, or no limit at all. The clock starts with the first move, so a
  board nobody has touched yet costs nothing. Running out of time loses the
  game. In an online game the host picks the control and each side sends its
  own clock with every move, so neither drifts.
- **Games survive a reload** — a game in progress against the computer or in
  pass & play is stored as you play and picked up where you left off, clocks
  included. The clock does not run while the page is closed.
- **Review and export** — step through the game with the on-screen controls
  or the arrow keys, click any move to jump to that position, and copy or
  download the whole game as PDN.
- Full checkers rules, enforced by a hand-written rules engine — see
  [The ruleset](#the-ruleset) below.
- Click-to-move or drag-and-drop, with legal-move hints and last-move
  highlighting
- Move list in PDN notation, captured pieces, and piece count
- Play as White, Black, or a random side; settings persist between visits
- Responsive layout with light, dark, and follow-system themes

## The ruleset

This is standard American checkers / English draughts (8x8, men that cannot
fly, kings that move and capture one square at a time), enforced by
`src/engine/checkers.js`:

- **Capture is mandatory.** If any of your pieces can jump, you must jump —
  quiet moves are not offered while a capture is available anywhere on the
  board. A jump sequence keeps going as long as another capture is available
  from the landing square, so one turn can clear several pieces.
- **Crowning ends the turn.** A man that reaches the far row is crowned
  immediately and stops there, even if the newly-made king could have jumped
  again. A king moves and captures one square at a time in any of the four
  diagonal directions, like a chess king restricted to diagonals.
- **No legal move loses.** Checkers has no stalemate: a side that cannot move
  — because every piece is captured, or because every remaining piece is
  blocked — has lost, not drawn.
- **Two ways to draw.** Threefold repetition, and the 40-move rule (40 moves
  by each side, 80 plies, with no capture and no man moved — only kings
  shuffling back and forth).

## The engine

`src/engine/checkers.js` is a hand-written checkers engine (no draughts
libraries). It deals only in whole turns — a multi-jump capture is generated,
applied, and undone as a single move carrying its full path from origin to
final landing square, never as several separate hops chained together by a
caller.

Move generation is validated by a perft test (`tests/perft.test.js`) against
published reference node counts: depths 1-6 from the starting position match
Aart J. C. Bik, "Computing Deep Perft and Divide Numbers for Checkers," ICGA
Journal 35(4):206-213 (2012) — 7, 49, 302, 1469, 7361, 36768 — per the table
at <https://www.aartbik.com/MISC/checkers.html>.

## The AI

`src/engine/ai.js` is the computer opponent: negamax search with alpha-beta
pruning, capture-first move ordering, and a piece-square evaluation (material,
advancement toward crowning, back-row occupancy, and an edge-column
adjustment). Because capture is mandatory, quiescence search is exact rather
than heuristic — a position is quiet precisely when the side to move has no
jump, so the horizon never falls in the middle of an exchange.

Difficulty combines search depth with a randomness window so lower levels
play plausible-but-imperfect moves:

| Level | Depth | Window |
| --- | --- | --- |
| Easy | 2 | 120 |
| Medium | 6 | 30 |
| Hard | 8 | 0 |

Hard was tuned down from an initial depth of 10 after measuring per-move
worst cases on this machine: depth 10 spiked to 3604ms on a single move,
depth 9 to 1232ms, and depth 8 stayed under 499ms worst-case across a range
of positions — the depth that fits comfortably under the UI's think-time
budget.

## Around the game

`src/game/` holds the parts that surround a game rather than play it, none of
which touch the DOM:

- `chain.js` — the turns that continue a jump sequence already partly played,
  and the next-hop squares available from the current point in a chain.
- `clock.js` — the time controls and the two countdowns. Time is charged from
  timestamps rather than decremented on a tick, so a throttled timer or a
  sleeping laptop costs display accuracy and never the time actually charged.
- `persistence.js` — reading and writing the stored game, and validating a
  save before the app trusts it. Games are stored as a move list (a path of
  PDN square numbers per turn, not a from/to/promotion tuple — checkers has no
  promotion, and a jump chain can visit more than two squares), which
  replays into the captured pieces, the notation, and the repetition counts a
  bare position would lose.
- `pdn.js` — building the PDN export.

`src/net/online.js` wraps one private online game over the Puter Peer API: a
host serves an invite code, exactly one guest may connect, and a jump chain
crosses the wire as a single message (the whole path, not one message per
hop) so the position, the turn, and the clock handover stay atomic.

## Development

```sh
npm install
npm run dev      # start the dev server
npm test         # run the test suite (engine rules, perft, AI, and more)
npm run build    # production build to dist/
npm run preview  # serve the production build
```

## Regenerating images

`sharp`, `png-to-ico`, and `playwright` are deliberately not project
dependencies — they're only needed to regenerate images, so they're installed
with `--no-save` and never touch `package.json` or `package-lock.json`.

**Social preview image and app-store assets** (Playwright — drives a real
browser against the running dev server, staging positions through the app's
own save format so every board captured is one the real engine produced):

```sh
npm i --no-save playwright && npx playwright install chromium
npm run dev                       # serves the app the shots are taken of
node tools/render-og.mjs          # public/og-image.png (1200x630)
node tools/store-screenshots.mjs  # store/screenshots/ — 4 assets x 3 sizes, light theme
```

The store assets are compositions, not raw screenshots: each pairs a headline
with a magnified window onto a real region of the app. The crops are measured
between element edges and padded into the gaps between cards, so no edge of an
asset ever lands mid-text. The copy on them lives in `STORE_LISTING.md`.

**Icons and favicon** (sharp, png-to-ico — rendered from `src/icon.png`, the
source of truth for the mark):

```sh
npm i --no-save sharp png-to-ico
```

`.trim()` the source first — it carries a few transparent pixels of slack
around the squircle, and at 16px they cost real area — then resize to
`public/favicon-16x16.png`, `favicon-32x32.png`, `icon-128.png`,
`icon-192.png`, and `icon-512.png`, passing `{ effort: 10 }` to `.png()`
(lossless, and about a third the bytes on a mark this photographic).

`apple-touch-icon.png` (180x180) is the same render `.flatten()`ed onto the
sand at the squircle's edge, `#eadcc5`: iOS paints black behind transparency
and lays its own mask over the square, and that mask lands within a pixel or
two of the icon's own corner radius, so the fill is all but invisible.

There is deliberately no `maskable` icon. Android crops those to the middle
80% and this mark reaches within 15px of its own bottom edge — the white
piece would lose its rim. The `any` icons get the legacy treatment instead.

Finally assemble `public/favicon.ico` from 16/32/48px renders with
`png-to-ico`. These are one-off commands, not a committed script.

The palette in `src/style.css` is derived from this file — see the comment
above `:root`. Re-extract it if the icon is ever replaced.

## Credits

Icons by [Lucide](https://lucide.dev). Checkers pieces are drawn in CSS, not
image assets — see `src/style.css`.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
