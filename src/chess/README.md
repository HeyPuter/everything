# Chess

Play chess against the computer or a friend. No frameworks — just vanilla JavaScript, HTML, and CSS, built with Vite.

## Features

- **Player vs. Computer** with three difficulty levels (Easy / Medium / Hard)
- **Pass & Play** — two players sharing one device
- **Online play** — private peer-to-peer games over the
  [Puter Peer API](https://docs.puter.com/Peer/) (WebRTC): create a game,
  share the invite code or link, and play with resign and rematch support.
  The Puter SDK is loaded only when online mode is opened.
- **Chess clocks** — Bullet, Blitz, and Rapid time controls with a Fischer
  increment, or no limit at all. The clock starts with the first move, so a
  board nobody has touched yet costs nothing. Running out of time loses the
  game, unless the opponent has no way to mate, which draws it (FIDE 6.9). In an
  online game the host picks the control and each side sends its own clock with
  every move, so neither drifts.
- **Games survive a reload** — a game in progress against the computer or in
  pass & play is stored as you play and picked up where you left off, clocks
  included. The clock does not run while the page is closed.
- **Review, export and import** — step through the game with the on-screen
  controls or the arrow keys, click any move to jump to that position, and copy
  or download the whole game as PGN. Load a PGN from the clipboard or a `.pgn`
  file to review a game played elsewhere (comments, variations and annotation
  glyphs are ignored; a `[FEN]` tag is honoured so a game that did not start
  from the initial array still replays).
- Full chess rules: castling, en passant, promotion, checkmate, stalemate,
  threefold repetition, the fifty-move rule, and insufficient material
- Click-to-move or drag-and-drop, with legal-move hints, last-move and
  check highlights, and smooth move animation
- Move list in standard algebraic notation, captured pieces, and material count
- Play as White, Black, or a random side; settings persist between visits
- Responsive layout with light, dark, and follow-system themes

## The engine

`src/engine/chess.js` is a hand-written chess engine (no chess libraries).
Move generation is validated by perft tests against reference node counts.

`src/engine/ai.js` is the computer opponent: negamax search with alpha-beta
pruning, MVV-LVA move ordering, quiescence search, and a piece-square-table
evaluation with a mop-up term for mating a lone king. A move that ends the game
by threefold repetition or the fifty-move rule is scored as the draw it is, so
the engine neither shuffles a won game away nor misses a draw it could claim.
Difficulty combines search depth with a randomness window so lower levels play
plausible-but-imperfect moves.

## Around the game

`src/game/` holds the parts that surround a game rather than play it, none of
which touch the DOM:

- `clock.js` — the time controls and the two countdowns. Time is charged from
  timestamps rather than decremented on a tick, so a throttled timer or a
  sleeping laptop costs display accuracy and never the time actually charged.
- `persistence.js` — reading and writing the stored game, and validating a save
  before the app trusts it. Games are stored as a move list, which replays into
  the captured pieces, the notation, and the repetition counts a bare FEN would
  lose.
- `pgn.js` — building the export, and reading a PGN back into a move list.

## Development

```sh
npm install
npm run dev      # start the dev server
npm test         # run the test suite (engine rules, perft, SAN, PGN, AI)
npm run build    # production build to dist/
npm run preview  # serve the production build
```

## Credits

Chess piece images by Colin M.L. Burnett (CC BY-SA 3.0) — see
`public/pieces/LICENSE.txt`. Icons by [Lucide](https://lucide.dev).

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
