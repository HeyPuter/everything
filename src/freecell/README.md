# FreeCell

Classic FreeCell with Microsoft-style deal numbers ([Rosetta / FreeCell FAQ](https://rosettacode.org/wiki/Deal_cards_for_FreeCell)).

Original implementation — no Microsoft binaries or trademarked assets.

## Comparison (DOCUMENTED)

| Capability | Windows FreeCell (DOCUMENTED) | This app |
| --- | --- | --- |
| Deal RNG + numbers 1…32000 | Yes | Yes |
| 4 free cells, 8 cascades, 4 foundations | Yes | Yes |
| Alternating-color cascades, suit foundations | Yes | Yes |
| Supermove (empty cells/columns) | Yes | Yes |
| Auto-home safe cards | Yes | Yes |
| Question-mark / Win32 chrome | Yes | No |

## Develop

```bash
npm ci
npm test
npm run dev
```
