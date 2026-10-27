# Reversi

Classic Reversi (also known as Othello) on an 8×8 board. Plain JavaScript,
Vite, and vitest — original visuals, no proprietary artwork.

## Playing it

```bash
npm install
npm run dev
```

`npm test` covers move generation, flips, pass/end detection, and a basic AI
choice. `npm run build` emits static `dist/`.

## Rules in short

- Black opens from the standard centre four.
- A move must flip at least one opponent disc in a straight line.
- No legal move means that side passes; the game ends when neither can move.
- Most discs wins (draw on equality).

## Modes

| Mode         | Notes                                      |
| ------------ | ------------------------------------------ |
| Vs computer  | You play Black; a greedy heuristic AI plays White |
| Two players  | Hotseat on one device                      |

Press `H` to toggle legal-move hints, `N` for a new game.

## Layout

```
src/
  game/
    board.js    8×8 grid, opening position, counts
    rules.js    legal moves, flips, pass / winner
    engine.js   session state (hotseat / AI)
    ai.js       depth-1 disc + corner heuristic
  main.js       UI wiring
  style.css     original green-board look
tests/
```

## Feature comparison (vs classic Reversi / Othello)

Evidence class: **DOCUMENTED** public rules (board size, opening, flip rays,
pass when no move, majority win). No LIVE Windows / commercial Othello build
was exercised for pixel or timed AI parity.

| Feature | Proprietary reference (DOCUMENTED) | Our implementation | Result |
| ------- | ---------------------------------- | ------------------ | ------ |
| 8×8 board | Standard | Same | Pass |
| Opening centre four | d4/e5 white, e4/d5 black | Same | Pass |
| Black moves first | Standard | Same | Pass |
| Orthogonal + diagonal flips | Eight rays | Same | Pass |
| Must flip ≥1 disc | Illegal otherwise | Same | Pass |
| Pass when no legal move | Opponent plays again | Same | Pass |
| End when neither can move | Count discs | Same | Pass |
| Majority / draw | Standard scoring | Same | Pass |
| Legal-move hints | Common in digital editions | Toggleable dots (`H`) | Pass |
| Vs computer | Typical digital feature | Heuristic AI (not tournament strength) | Partial |
| Timed / ranked online | Some commercial editions | Not implemented | Fail |
| Exact commercial AI / UI chrome | LIVE product behaviour | Untested LIVE | Untested |

## Licence

MIT — see `LICENSE`, matching the repository root.
