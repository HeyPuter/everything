# Solitaire

Klondike solitaire, built with Vite and plain JavaScript (ES modules, no
framework). The game menu in the header picks draw-one or draw-three
Klondike, either with Vegas scoring (a $52 ante, $5 per card played home,
one pass through the deck when drawing one and three when drawing three, and
a running bank across games), or Spider with one, two, or four suits.

Each game lives behind the same rules adapter (`src/game/modes.js`): board,
drag, and the save/stats plumbing call it instead of a specific game's
rules. Klondike's rules are in `src/game/state.js` and `rules.js`, Spider's
in `src/game/spider.js`. Desktop windows get realistic card art via a vendored SVG deck;
small screens fall back to plain top-left rank-and-suit cards. Games and
stats can optionally sync to Puter cloud storage.

## Build and serve

```
npm ci
npm run build
```

This produces static assets in `dist/`. Serve that directory with any static
file server. The repo root is **not** directly servable — `index.html` loads
`/src/main.js` as an ES module, which starts with CSS imports a browser
cannot resolve without Vite's dev server or a build step.

## Development

```
npm run dev
```

Starts the Vite dev server with hot module reload.

## Tests

```
npm test
```

Runs the Vitest suite (`npm run test:watch` for watch mode). Coverage is
`src/game/**` (pure game rules) plus the save/stats sync layer in
`src/services/**`; rendering and drag-and-drop are verified by playing the
game rather than with DOM tests.

## Vendored code

`src/vendor/cardmeister.js` is a vendored public-domain (Unlicense) SVG
playing-card deck — see `src/vendor/README.md` for licensing and integration
notes.

## Progressive Web App

The game is installable and playable offline, following the structure of
the sibling `checkers` project (`site.webmanifest`, a full icon set, social
preview and search metadata) plus one deliberate extension: an offline
service worker.

`public/sw.js` is registered from `src/main.js`, **production builds only**
(`import.meta.env.PROD`) — a service worker on the dev server would
intercept fetches for files Vite hasn't rebuilt yet, turning every
subsequent change into a stale-cache mystery. It uses **runtime caching, not
a precache manifest**: Vite content-hashes every asset filename on each
build, so a hand-written precache list would go stale the moment a new
build shipped.

- Only same-origin `GET` requests are ever touched. Cross-origin requests —
  notably `js.puter.com` — are never intercepted or cached, so a signed-in
  session is never served stale or offline from here.
- Navigations (loading `/`) try the network first and fall back to whatever
  shell was cached on a previous visit, so a cold offline launch still
  boots.
- Everything else (hashed JS/CSS bundles, icons, the vendored deck) is
  served cache-first and populated lazily as it's requested.
- **Busting the cache**: bump the `CACHE` constant at the top of
  `public/sw.js` (e.g. `solitaire-v1` → `solitaire-v2`). On `activate`, every
  cache whose name isn't the current one is deleted. For code deploys this is
  belt-and-braces, not load-bearing — a new build's `index.html` is always
  fetched fresh from the network on the next online visit and references new
  hashed filenames the cache doesn't have yet, so the worst case without a
  bump is cache bloat (orphaned old-hash entries), not staleness. It **is**
  load-bearing, though, whenever an unhashed `public/` asset changes content
  without changing its filename — `site.webmanifest` or an icon, say — since
  `cacheFirst` will keep serving a returning visitor's (or installed PWA
  user's) old copy of that exact filename indefinitely until the bump forces
  a clean slate.

## Regenerating images

`playwright`, `sharp`, and `png-to-ico` are deliberately not project
dependencies — they're only needed to regenerate images, so they're
installed with `--no-save` and never touch `package.json` or
`package-lock.json`.

The social preview and the store screenshots drive a real browser against
the running dev server, so the vendored deck (`src/vendor/cardmeister.js`)
renders the actual card art, not a mockup. The icon set needs neither a
browser nor the dev server — its source is a file.

```sh
# A later `npm i --no-save …` prunes the earlier --no-save installs, so ask
# for everything you'll need in one go.
npm i --no-save sharp png-to-ico playwright
npx playwright install chromium

node tools/render-icons.mjs       # public/favicon.ico, favicon-*.png, icon-*.png, icon-maskable-512.png, apple-touch-icon.png

npm run dev                       # serves the dev server the two shots below are taken of
node tools/render-og.mjs          # public/og-image.png (1200x630)
node tools/store-screenshots.mjs  # store/screenshots/ — 4 scenes x 3 sizes
```

Changing the icon touches all three: `tools/og-image.html` puts
`icon-128.png` in the social preview's brand badge, and the app's own header
shows it (`index.html`'s `.brand .mark`), so it appears in every store
screenshot too.

**Icons** (`icon.png` + `tools/render-icons.mjs`): `icon.png` at the repo
root is the master — a 1178x1178 RGBA tile, an Ace of Spades over a red card
back on felt green, with a squircle silhouette and transparent corners. Keep
it at least 512px: every emitted file is a `sharp` lanczos3 downsample of it
and never an upscale.

- `favicon-16x16`, `favicon-32x32`, `icon-128`, `icon-192`, `icon-512` are
  straight downsamples with the transparent corners intact, so the tile's
  own silhouette shows against whatever a tab strip or title bar paints
  behind it.
- `favicon.ico` is assembled from 16/32/48 renders with `png-to-ico`; the
  48px render isn't kept as a standalone file.
- `apple-touch-icon.png` (180) **is** flattened onto felt — iOS paints black
  behind any alpha and then applies a squircle mask squarer than this
  master's corners, so untouched transparent corners would survive the mask
  as black wedges.
- `icon-maskable-512.png` is the manifest's `purpose: "maskable"` icon: the
  tile inset to the middle 80% over full-bleed felt, so a platform's circle
  or teardrop crop lands on felt instead of slicing the ace.

The two full-bleed backgrounds are a vertical gradient sampled from the
master's own top and bottom edges (`FELT_TOP`/`FELT_BOTTOM` in the script),
so the fill continues the tile's gradient rather than butting a flat colour
against it. Re-sample those two constants if the artwork is ever replaced.

**Social preview** (`tools/og-image.html` + `tools/render-og.mjs`): a real
1200x630 page in the app's own felt-green and system-font look, showing an
actual in-progress Klondike board — stock, waste, two started foundations,
a played-into tableau — rendered with the same `<playing-card>` element the
game itself uses, not an empty table. Facebook, LinkedIn, and Slack cache
share images per URL, so after changing the picture either re-scrape it in
their debuggers or bump the filename.

**App store screenshots** (`tools/store-screenshots.mjs`, see `STORE_LISTING.md`):
four scenes — a fresh deal, a mid-game board, the win cascade mid-flight, and
the same board narrow enough to trigger the plain phone card face — each
rendered at 1920x1080, 1024x768, and 1080x2280 into `store/screenshots/`.
Every board is staged by writing a real `serialize.js` save into
`localStorage['solitaire.save.v1']` and letting the app restore it, exactly
as a resumed game would, rather than drawn by hand; see the tool's own header
comment for the full staging rationale, including why the win-cascade scene
is the one exception (its pre-win position is hand-arranged, not autoplayed)
and why that scene's exact composition varies between runs.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
