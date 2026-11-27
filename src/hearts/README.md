# Hearts

A clean, original Hearts built from the documented rules of classic Microsoft
Hearts (Windows 95–XP era). Plain JavaScript, Vite, and vitest — no frameworks,
no Microsoft artwork, sounds, or trademarks.

## Playing it

```bash
npm install
npm run dev
```

`npm test` runs the rule engine. `npm run build` emits a static `dist/` you can
serve from anywhere.

## Classic rules (summary)

| Piece | Behaviour |
| ----- | --------- |
| Players | You + 3 computer seats (West, North, East) |
| Pass | Left → right → across → hold, then repeat |
| Opening lead | Holder of the 2♣ leads the first trick |
| Follow suit | Required when able |
| Hearts broken | Hearts may not be led until a heart has been played (unless a player has only hearts) |
| First trick | Cannot dump hearts or the Queen of Spades when void |
| Scoring | Each ♥ = 1, Q♠ = 13 (26 per hand) |
| Shoot the moon | Take all 26 → you score 0, others +26 |
| Match | First to reach/exceed 100 ends it; lowest total wins |

## Layout

```
src/
  game/
    cards.js      ranks, suits, penalties
    deal.js       shuffle/deal + pass directions
    rules.js      legal plays, trick winner, hearts broken
    scoring.js    hand scores, moon, match end
    ai.js         pass + play heuristics
    engine.js     match lifecycle
  ui/
    cards.js      card DOM
  main.js         table wiring, theme
  style.css       original felt / chrome
tests/            vitest coverage for the rules above
```

## Feature comparison (vs classic Microsoft Hearts)

Evidence class: **DOCUMENTED** public rules (pass cycle, 2♣ lead, follow-suit,
hearts-breaking, first-trick dump ban, Q♠/hearts scoring, shoot-the-moon,
play-to-100). No LIVE Windows binary was exercised for this port — cells marked
Untested where only a live build could confirm UI/timing nuances.

| Feature | Proprietary reference (DOCUMENTED) | Our implementation | Result |
| ------- | ---------------------------------- | ------------------ | ------ |
| 4 players, 13 cards each | Standard deal | Same | Pass |
| Pass left / right / across / hold | Rotating pass cycle | Same | Pass |
| Pass exactly 3 cards | Required before play (except hold) | Same | Pass |
| 2♣ opens first trick | Documented opening lead | Same | Pass |
| Follow suit | Required when able | Same | Pass |
| Hearts may not lead until broken | Documented | Same; only-hearts exception | Pass |
| No ♥ / Q♠ dump on first trick | Documented when void | Same | Pass |
| ♥ = 1, Q♠ = 13 | Standard penalties | Same | Pass |
| Shoot the moon | All 26 → others +26 | Same (others +26 / shooter 0) | Pass |
| Match to 100 | First ≥100 ends; lowest wins | Same | Pass |
| Computer opponents | Built-in AI | Heuristic AI (legal + duck/dump) | Partial |
| Exact Win32 chrome / sounds / names | LIVE Windows UI | Original CSS chrome only | Pass (intentional) |
| Animated card flight | LIVE Windows UI | Untested LIVE / not mirrored | Untested |
| Optional “queen of spades warning” etc. | Some editions | Not implemented | Fail |

## Licence

MIT — see `LICENSE`, matching the repository root.
