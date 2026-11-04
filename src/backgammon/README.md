# Backgammon

**Live app:** [backgammon.puter.com](https://backgammon.puter.com/)

Play backgammon against the computer or a friend. No frameworks — just vanilla
JavaScript, HTML, and CSS, built with Vite.

## Features

- **Player vs. Computer** with three difficulty levels (Easy / Medium / Hard)
- **Pass & Play** — two players sharing one device
- **Online play** — private peer-to-peer games over the
  [Puter Peer API](https://docs.puter.com/Peer/) (WebRTC): create a game,
  share the invite code or link, and play with resign and rematch support.
  The Puter SDK is loaded only when online mode is opened. **The dice are
  agreed between the two players rather than thrown by either of them** — see
  [Fair dice](#fair-dice) below.
- **The doubling cube** — off by default, and a setting like the clock. With it
  on, gammons and backgammons are scored against it and a running points total
  is kept for the sitting; with it off the game is scored 1 / 2 / 3 and no cube
  appears on the board at all.
- **Clocks** — Bullet, Blitz, and Rapid time controls with a Fischer
  increment, or no limit at all. The clock starts with the opening roll, so a
  board nobody has touched costs nothing. Running out of time loses the game
  at whatever the cube says it is worth. In an online game the host picks the
  control and each side sends its own clock with every turn, so neither drifts.
- **Games survive a reload** — a game in progress against the computer or in
  pass & play is stored as you play and picked up where you left off, dice and
  clocks included. The clock does not run while the page is closed.
- **Review and export** — step through the game with the on-screen controls or
  the arrow keys, click any turn to jump to that position, and copy or download
  the whole game as a `.mat` transcript.
- Full backgammon rules, enforced by a hand-written engine — see
  [The ruleset](#the-ruleset) below.
- Click-to-move or drag-and-drop, with a landing ring drawn exactly where a
  checker would come to rest, pip counts, and the previous turn highlighted
- Play as White, Black, or a random side; settings persist between visits
- Responsive layout with light, dark, and follow-system themes

## The ruleset

Standard backgammon, one game at a time, enforced by
`src/engine/backgammon.js` — with or without the cube, as you choose:

- **The opening roll decides who starts.** Each player throws one die and the
  higher one moves first, playing both dice. A tie is thrown again.
- **Use as many dice as you can.** A move that fits but strands a die another
  order would have played is not legal, and the engine will not offer it. When
  only one of two unequal dice can be played, it has to be the larger.
- **Doubles are worth four moves**, not two.
- **A checker on the bar comes in first**, and nothing else may move until it
  does. A turn with no legal play at all simply passes.
- **Bearing off** needs every checker home. An exact roll always lifts one; a
  larger roll may only be spent when nothing is left further from home.
- **Gammons and backgammons.** Bearing off first wins one point, two if the
  loser has borne nothing off, and three if they are also still on the bar or
  in the winner's home board — all multiplied by the cube.
- **The cube**, when it is switched on, may be turned at the start of your own
  turn, before the dice, if you own it or it is still in the middle. Take and it
  doubles and passes to you; drop and the game ends at once at the old stake.
  It is a setting because a great many people learned backgammon without it —
  and a cube nobody asked for is a number on the bar with no explanation. The
  choice is a property of the game, not of the app: it is recorded in the save
  file and sent to a guest at the online handshake, so both sides always agree
  about whether there is a cube.

Out of scope: match play to a target score, and with it the Crawford and
Jacoby rules; the Nackgammon and hypergammon opening positions; and
chouettes.

## Fair dice

Backgammon is the one game in this family where the moves alone do not decide
the game — the dice do. Offline that is no harder than `Math.random`, but a
peer-to-peer game with no server has nobody to throw them, and whoever
generates a number gets to choose it.

So an online roll is a commit-reveal round, and it costs three messages:

1. the side about to roll picks a secret and sends only its SHA-256
2. the other side answers with a secret of its own, in the clear
3. the roller opens its secret; both sides check it against the commitment and
   derive the same two dice from the pair

Neither side can steer the outcome: the roller committed before it could see
the opponent's contribution, and the opponent answered without being able to
read the roller's. A reveal that does not match its commitment ends the game
and says why — there is no innocent way for that to happen. Rounds are
numbered so a message cannot be replayed, and the game itself refuses dice it
was not waiting for or that the wrong side threw — which is what stops a fresh
round being opened to escape a roll already thrown, or to take a turn (and the
double it might have begun with) away from the side whose turn it is.

The same thinking runs through the offline game. `undo` puts a turn's dice
back on the table exactly as they were rather than handing back a fresh roll,
and is only offered before the next roll is thrown — rolling makes the turn
before it final, as at a real board, so a roll you dislike cannot be undone
away. The save file records the roll you are part-way through for the same
reason — otherwise reloading the page would be a re-roll.

`src/engine/dice.js` holds the derivation (including the rejection sampling
that keeps `byte % 6` from making 1-4 fractionally likelier than 5 and 6);
`src/net/online.js` runs the protocol.

## The engine

`src/engine/backgammon.js` is a hand-written backgammon engine. Two things
shape it:

**It deals in whole turns.** One roll produces one play — two to four checker
moves applied, recorded, and undone together. Building a play up a checker at a
time is the controller's job; the engine offers `legalMoves(pending)` for that
and never holds a half-finished turn itself. That is what keeps the clock, the
history, the save format, and the wire protocol all dealing in turns.

**The board is one signed array of 26 slots.** `points[1..24]` are the points,
positive counts meaning White and negative meaning Black. The two ends belong
to one colour each: `points[25]` is White's bar and `points[0]` is Black's,
which is exactly where each colour *enters from* — White enters with die d onto
25-d, Black onto 0+d — so entry needs no special arithmetic. Borne-off checkers
are counted separately, because the slot a colour bears off *to* is the slot the
other colour's bar already occupies.

The awkward part of backgammon move generation is the obligation to use as many
dice as possible, which cannot be decided one move at a time. Each candidate is
measured by how far the turn can still go after it, and only the moves that
keep the turn at its full length survive. `distinctPlays()` — what the search
uses — expands through the same `legalMoves`, so the two can never disagree
about what is legal.

## The AI

`src/engine/ai.js` is the computer opponent: expectimax over the dice, on a
hand-written positional evaluation.

Backgammon needs a different shape of search from chess or checkers. There is
no deep line to calculate — the dice cut every line off after one ply — so
depth buys almost nothing and breadth over the dice buys everything. One ply
means "score every position I can reach with this roll"; two plies means "and
then average, over all 21 rolls the opponent might throw, how well they
answer" — the expectation, not the worst case, because the opponent does not
choose their dice either.

Everything scores in **pips**, so one unit is one pip of the race. The terms
are material and shape: the race itself, checkers borne off, the value of each
made point (the 5-point and the bar point highest), primes squared, anchors in
the opponent's home board, stacks past three, checkers on the bar, and the
pips each blot expects to lose to being hit. Once the two sides have run past
each other the game is a pure race and every positional term is dropped.

| Level | Plies | Randomness window |
| --- | --- | --- |
| Easy | 1 | 14 pips |
| Medium | 1 | 3 pips |
| Hard | 2 | 0 |

Measured over 200 games a side: Hard takes about 60% of games from Medium and
about 85% from Easy, at roughly 10ms a move worst case. Widening the Hard
shortlist past ten candidates bought nothing but time — the second ply refines
an ordering the evaluation has already mostly got right, so most of the
strength is in `evaluate`, not in the search.

The cube decisions turn the same evaluation into a rough win probability with a
logistic fitted by eye, and use the classic thresholds: double between about
68% and 87%, take from about 24%. That is enough to make the computer's cube
handling reasonable and nowhere near enough to make it a cube expert.

## Around the game

`src/game/` holds the parts that surround a game rather than play it, none of
which touch the DOM:

- `clock.js` — the time controls and the two countdowns. Time is charged from
  timestamps rather than decremented on a tick, so a throttled timer or a
  sleeping laptop costs display accuracy and never the time actually charged.
- `persistence.js` — reading and writing the stored game, and validating a save
  before the app trusts it. Games are stored as the list of things that
  happened — each turn's dice and checker moves, and every cube action — which
  replays into the cube, the history, and the notation a bare position would
  lose.
- `notation.js` — the standard move notation (`8/5`, `bar/20`, `6/off`, with a
  star for a hit and `(2)` for two checkers doing the same thing) and the
  `.mat` transcript every backgammon program reads.

`src/ui/boardView.js` draws the board and turns gestures into slot-level
callbacks. The board is one 14-column, 2-row CSS grid — six points, the bar,
six more points, and the bear-off tray, top and bottom — and every size inside
it is derived from the width of a single point.

## Development

```sh
npm install
npm run dev      # start the dev server
npm test         # run the test suite (rules, moves, bear-off, dice, cube, AI…)
npm run build    # production build to dist/
npm run preview  # serve the production build
```

## Regenerating images

Every image the site ships comes from two sources: `src/icon.png` is the app
mark, and `tools/og-image.svg` is the social card the mark is dropped into.
One script turns both into PNGs, with no browser in the loop:

```sh
brew install librsvg imagemagick   # once
node tools/render-images.mjs
```

That writes the favicons, the app icons, the Apple touch icon, `favicon.ico`,
and `og-image.png` into `public/`.

The store screenshots are the one set of images that cannot come from an SVG,
because they are pictures of the running app. They are still not taken by hand:

```sh
npm run shots
```

serves the app to headless Chrome, seeds it with a game the engine and the
computer opponent played out under a seeded generator, drives it, photographs
it, and lays the result into the promotional canvas at each store size. See
[`store/description.md`](store/description.md), and
[`STORE_LISTING.md`](STORE_LISTING.md) for the copy that goes with them.

**The palette in `src/style.css` is sampled from `src/icon.png`** — the felt,
the two point colours, both checkers, and the frame are the icon's own values,
and every neutral on the page is that same green hue held at a different
lightness. If the mark is ever replaced, re-sample it:

```sh
magick src/icon.png -trim +repage -resize 60x60 -colors 8 -format "%c" histogram:info: | sort -rn
```

and move the tokens at the top of `src/style.css` to match, along with the
`theme-color` metas in `index.html`, `public/site.webmanifest`, and the
gradients in `tools/og-image.svg`.

## Analytics

Privacy-friendly analytics by [Plausible](https://plausible.io) — no cookies,
no personal data, nothing that needs a consent banner. The script tag is in
`index.html` and the plausible.io origin is allowed by the CSP in
`customHttp.yml`; `src/analytics.js` swallows every call, so a blocked script,
an offline visitor, or a self-hosted deploy with no analytics all play the
same game.

Three custom events, and only three. Each is a player getting something out of
the app rather than merely touching it:

| Event | Fires when | Props |
| --- | --- | --- |
| `Game Completed` | a game reaches an end, having had at least one turn played | mode, result, reason, points, level, clock, cube |
| `Played Again` | another game begins straight after one finished | mode |
| `Online Game Connected` | two peers complete the handshake and a game starts | role |

Deliberately not tracked: **starting** a game, which is intent rather than
value and which pageviews already count; and **creating an invite**, since an
invite nobody joins is a dead end — the connection is the same funnel step
that actually landed. Add `Game Started` back if you want a denominator for a
completion rate.

Custom events only appear in Plausible once you add them as goals, and props
only once you enable them, both in the site's settings.

## Credits

Icons by [Lucide](https://lucide.dev). The board, the checkers, and the dice
are drawn in CSS, not image assets — see `src/style.css`.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
