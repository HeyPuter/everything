# VBA Studio

VBA-inspired macro environment for Everything office workflows ([issue #25](https://github.com/HeyPuter/everything/issues/25)).

This is an **original** interpreter and worksheet host — not Microsoft Visual Basic for Applications, and it does not ship any Office binaries or proprietary assets.

## Comparison (DOCUMENTED)

| Capability | Classic Microsoft VBA (DOCUMENTED) | This app |
| --- | --- | --- |
| `Sub` / `End Sub` | Yes | Yes |
| `Dim`, `For`/`Next`, `If`/`Then`/`Else` | Yes | Yes (subset) |
| `MsgBox` | Yes | Yes (message log) |
| `Range("A1").Value` | Excel host | In-browser worksheet host |
| Full Excel object model / ActiveX | Yes | No (UNVERIFIED / out of scope for v0) |
| Binary-compatible with `.bas` from Office | Yes | No — syntax-inspired only |

## Develop

```bash
npm ci
npm test
npm run dev
```
