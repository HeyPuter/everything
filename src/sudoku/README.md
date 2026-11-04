# Sudoku

**Live app:** [sudoku.puter.com](https://sudoku.puter.com/)

A Sudoku that generates its own puzzles, grades them by the reasoning they
actually demand, and explains its hints instead of just filling in the answer.
No frameworks: plain JavaScript, Vite, and Puter.js for the optional account.

## Playing it

```bash
npm install
npm run dev
```

`npm run build` produces a static `dist/` that can be served from anywhere.
Puter.js requires an HTTP origin, so open the dev server rather than the file.

## What is interesting here

**Difficulty means something.** Most generators pick a number of clues and call
it a level. This one solves each candidate puzzle with a ladder of human
techniques (`src/engine/techniques.js`) and reports the hardest one it needed,
so the label describes the deductions the puzzle forces on you:

| Level  | Clues | What it demands                                        |
| ------ | ----- | ------------------------------------------------------ |
| Easy   | 38    | Singles only, with plenty to start from                |
| Medium | 30    | Still singles, but far fewer clues: expect to scan     |
| Hard   | 25+   | Pointing pairs, box/line reductions, naked pairs       |
| Expert | 22+   | Hidden subsets, X-Wings, Y-Wings                       |

Measuring difficulty that way turned up something worth knowing: most minimal
Sudoku grids fall to singles alone, and the ones needing an X-Wing are scarce.
That is why the two easier levels are separated by how much scanning they take
and the two harder ones by the techniques they require. It is both honest to the
player and reachable often enough to generate quickly (Expert lands on target in
a couple of hundred milliseconds).

**Every puzzle is solvable by logic.** Generation rejects any grid the technique
ladder cannot finish, so no puzzle ever needs a guess, and the hint button
always has something true to say.

**Hints are reasoning, not answers.** A hint names the technique, highlights the
cells it read, and says why the conclusion follows:

> **Pointing pair.** In box 1, 5 can only go in r1c1 or r1c2, all in row 1. So 5
> is somewhere in that box, and can be removed from the rest of row 1.

Eliminations a hint establishes are remembered separately from your own pencil
marks, which is what lets repeated hints make progress rather than restating the
same deduction.

**One solution, always.** Uniqueness is re-checked after every clue removed, so
a puzzle can never be finished two different ways.

## Layout

```
src/
  engine/            no DOM, no storage, no randomness that is not seeded
    grid.js          index maths, the 27 units, the 20 peers of each cell
    solver.js        constraint propagation plus search; uniqueness counting
    techniques.js    the human technique ladder, behind hints and grading
    generator.js     dig-and-check generation, difficulty targeting
    random.js        seeded PRNG, so the daily puzzle is the same for everyone
    generator.worker.js  generation off the main thread
  game/              rules of play, saving, records
    state.js         the board, moves, and total undo/redo
    hints.js         the ladder applied to the position in front of you
    serialize.js     versioned, validating save format
    stats.js         records, and a merge that cannot lose a personal best
    persistence.js   localStorage first, Puter account as a second copy
    settings.js      preferences, and why each default is what it is
    timer.js         a clock that survives a backgrounded tab
    puzzles.js       worker with an inline fallback
  ui/
    boardView.js     the 81 cells, the ARIA grid pattern
    keypad.js        digits, with a count of how many are left
  net/puter.js       account and cloud storage, all of it optional
  main.js            wiring, keyboard, theme, dialogs
```

## The icon

`icon.png` at the root is the master artwork and is not shipped: Vite copies
`public/` into the build and ignores the root. Everything in `public/` that is
an icon is derived from it by `scripts/generate-icons.sh`, which needs
ImageMagick. Replace the master, run the script, commit what changes.

The sizes are not all the same picture. A favicon and the header mark keep the
artwork's own rounded corners and its shadow on transparency; the 16px favicon
is sharpened, because thin rules and small numerals reduced that far turn into a
pale smudge on a white tab strip. The Apple touch icon is opaque and cropped to
the edges, since iOS applies its own mask and does not want a second set of
corners inside it. The maskable icon sits at 66% of its canvas on the accent
blue, which is what keeps a rounded square of this corner radius inside the
circle Android may crop it to.

## Keyboard

| Key                    | Action                                  |
| ---------------------- | --------------------------------------- |
| Arrow keys, Home, End  | Move around the grid                    |
| 1 to 9                 | Enter a digit                           |
| Shift + 1 to 9         | Enter a pencil mark instead             |
| Backspace, Delete, 0   | Clear the cell                          |
| N                      | Toggle pencil-mark mode                 |
| H                      | Hint                                    |
| P                      | Pause                                   |
| Ctrl/Cmd + Z           | Undo                                    |
| Ctrl/Cmd + Shift + Z   | Redo                                    |
| Escape                 | Dismiss the hint                        |

## The Puter account

Everything works signed out; the whole game runs from localStorage. Signing in
carries your times and your unfinished puzzle between devices, using
[`puter.kv`](https://docs.puter.com/KV/) under two keys. Records are merged field
by field so neither device's progress is dropped; a saved game cannot be merged
that way, so the newer of the two wins. A read that failed is never treated as an
empty store, which is the mistake that would let a flaky connection wipe a
player's records.

Inside a Puter app window (`puter.env === 'app'` or `'gui'`) the session belongs
to the shell, so the app shows who is signed in and offers no sign-out.

## Accessibility

- The grid uses the ARIA grid pattern: real rows, column indices, and one roving
  tabindex, so a keyboard reaches the board in a single Tab and arrow keys move
  within it.
- Every cell is labelled with its position and contents, and says whether a
  digit is a clue, your entry, or wrong.
- Placements, mistakes, hints and results are announced through a live region.
- Nothing is signalled by colour alone: clues differ from entries in weight as
  well as hue, the pencil-marks toggle changes its glyph rather than just its
  tint, and a digit repeating one of its peers says so in the cell's name and
  not only in the red wash it gets.
- Contrast is checked against WCAG AA in both themes, including the label colour
  on filled buttons, which needs opposite answers in light and dark.
- `prefers-reduced-motion` removes every transition. The one exception is the
  generating spinner, which without motion is indistinguishable from a hung app.

## Tests

```bash
npm test
```

333 tests. The ones worth knowing about:

- **Technique soundness.** Every step the ladder takes, on every difficulty, is
  checked against the puzzle's unique solution: a placement must match it, and
  an elimination must never remove the digit that belongs in that cell. This is
  the property that makes a hint trustworthy.
- **Hints always finish.** Following hints alone carries an Expert puzzle from
  empty to solved, which is the promise the hint button makes.
- **Generation.** Each level is checked for a unique solution, for being
  solvable by logic alone, and for actually reaching the difficulty it claims.
- **Sync.** A cloud read that fails must not be mistaken for an empty account,
  and a merge must be commutative and idempotent so repeated syncs cannot
  inflate or erase records.
- **Save format.** `decode` is checked against truncation, wrong versions, clues
  that disagree with the solution, and a "solution" that is not solved.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
