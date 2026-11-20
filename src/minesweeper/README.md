# Minesweeper

A clean, original Minesweeper built from the documented rules of classic
Windows Minesweeper. Plain JavaScript, Vite, and vitest — no frameworks, no
Microsoft artwork, sounds, or trademarks.

## Playing it

```bash
npm install
npm run dev
```

`npm test` runs the rule engine. `npm run build` emits a static `dist/` you can
serve from anywhere.

## Classic boards

| Difficulty   | Size   | Mines |
| ------------ | ------ | ----- |
| Beginner     | 9×9    | 10    |
| Intermediate | 16×16  | 40    |
| Expert       | 16×30  | 99    |

## Controls

| Input                         | Action                                      |
| ----------------------------- | ------------------------------------------- |
| Left-click / Enter / Space    | Reveal                                      |
| Right-click / long-press / F  | Toggle flag                                 |
| Middle-click / both / C       | Chord when adjacent flags match the number  |
| Arrow keys                    | Move focus                                  |
| R                             | New game                                    |
| 1 / 2 / 3                     | Beginner / Intermediate / Expert            |

## Layout

```
src/
  game/
    difficulties.js   classic board sizes
    board.js          generation, neighbours, adjacent counts
    engine.js         reveal, flag, chord, flood fill, win/lose
    timer.js          seconds clock, capped at 999
    bestTimes.js      localStorage personal bests
  ui/
    boardView.js      grid rendering and input
  main.js             HUD, theme, difficulty wiring
  style.css           original visuals
tests/                vitest coverage for the rules above
```

## Feature comparison (vs classic Windows Minesweeper)

Evidence class: **DOCUMENTED** public rules (widely published board sizes,
click semantics, chord behaviour, first-click safety, timer/mine counter).
No LIVE Windows binary was exercised for this port — cells marked Untested
where only a live build could confirm pixel/timing nuances.

| Feature | Proprietary reference (DOCUMENTED) | Our implementation | Result |
| ------- | ---------------------------------- | ------------------ | ------ |
| Beginner 9×9 / 10 mines | Standard beginner board | Same | Pass |
| Intermediate 16×16 / 40 | Standard intermediate board | Same | Pass |
| Expert 16×30 / 99 | Standard expert board | Same | Pass |
| Left-click reveal | Opens a hidden cell | Same | Pass |
| Right-click flag | Marks a suspected mine | Toggle flag (no question-mark cycle) | Partial |
| Chord on numbered cell | Middle / both buttons when flags match | Middle, both, or `C` | Pass |
| First-click safety | First opened cell is never a mine | Board generated after first click, cell excluded | Pass |
| Flood fill on zeros | Opens contiguous empty region | Same | Pass |
| Mine counter | Mines − flags (may go negative) | Same | Pass |
| Timer | Starts on first click; whole seconds | Same; display capped at 999 | Pass |
| Face / reset | Smiley resets; changes on win/lose/press | Same idea, emoji face (original chrome) | Pass |
| Win / lose | Clear all safe cells / open a mine | Same | Pass |
| Best times | High scores per difficulty | localStorage bests per difficulty | Pass |
| Question marks | Optional mark cycle in some versions | Not implemented | Fail |
| Custom field sizes | Supported in later Windows editions | Not implemented | Fail |
| Sound / original bitmaps | Proprietary assets | Original CSS visuals only | Pass (intentional) |
| Exact Win32 timing / chrome | LIVE Windows UI | Untested LIVE | Untested |

## Licence

MIT — see `LICENSE`, matching the repository root.
