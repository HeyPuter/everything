# Trips design spec

Derived from the Puter desktop GUI (`heyputer/packages/puter/src/gui/src/css/style.css`, `dashboard.css`, `services/ThemeService.js`, `puter-js/src/modules/UI.js`) and the first-party apps in `everything/src/*`. Paths below are relative to `src/` in this repo unless prefixed with `heyputer/` (the Puter repo).

## 0. Summary

- There is no shared package. Each app ships its own `src/styles/tokens.css`, but the collaboration and productivity apps (teamchat, projects, tasks, expense, crm, invoicing, inventory, pos, contracts, cap-table, signatures, time-tracking, documents, spreadsheet, email: 15 apps) share one vocabulary and almost identical neutrals: `--page / --surface / --surface-2 / --surface-3 / --ink / --ink-2 / --ink-3 / --hairline / --hairline-strong / --scrim / --accent / --accent-strong / --accent-ink / --accent-wash`. Use this one.
- A second family (wiki, records, notes, calendar, field-service, fleet, legal, and the creative/engineering tools) uses `--bg / --text / --text-2 / --border`, often switched by `data-theme-resolved`. It is denser and more tool-like. Don't use it for this app.
- The accent is per app, sampled from the app icon's hue and then darkened (light) or lightened (dark) until it passes contrast. For a blue icon, use Puter's selection hue (213°, `--select-color` in the desktop GUI), tuned below.
- Flat surfaces separated by hairlines. Shadows only on floating layers. System font stack. Lucide icons. Vanilla JS + Vite, no framework, `el()` DOM helper.
- Dark mode: `prefers-color-scheme` by default, plus a `data-theme="light|dark"` stamp on `<html>` from an in-app System/Light/Dark control. The stamp is applied before first paint from `localStorage`, and the choice is also saved to `puter.kv` so it follows the account. Puter does not broadcast light/dark to apps (details in §2).

---

## 1. Color tokens

### 1.1 Recommended set (paste as `src/styles/tokens.css`)

Neutrals, status colors, and avatar slots come from teamchat (`teamchat/src/styles/tokens.css`), the most complete collaborative set. The accent is retuned to Puter blue. Field border comes from documents/spreadsheet. Pop shadow comes from projects.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--page` | `#f1f1ee` | `#0b0b0d` | app background, behind panes |
| `--surface` | `#ffffff` | `#18181a` | cards, panels, dialogs, menus, inputs |
| `--surface-2` | `#f0efec` | `#222224` | hover fill, secondary button, wells, segmented track |
| `--surface-3` | `#e6e5e0` | `#2c2c2f` | pressed/hover on surface-2, switch-off track, top bar |
| `--sidebar` | `#f1f0ed` | `#141416` | left nav column (optional; projects uses `--surface`) |
| `--ink` | `#111110` | `#f4f4f2` | primary text (17.6 / 17.4:1 on page) |
| `--ink-2` | `#4f4e4a` | `#bdbcb6` | secondary text, idle icons, nav labels |
| `--ink-3` | `#6d6b66` | `#8f8e88` | muted/meta text, placeholders (4.96 / 5.83:1 on page; under 4.5 on surface-3, so don't put text there) |
| `--hairline` | `rgba(17,17,16,.10)` | `rgba(255,255,255,.10)` | every divider and card border |
| `--hairline-strong` | `rgba(17,17,16,.18)` | `rgba(255,255,255,.18)` | hover border, menu border, dashed drop zones |
| `--field-border` | `rgba(17,17,16,.48)` | `rgba(255,255,255,.42)` | text-field borders (3:1 non-text contrast) |
| `--row-hover` | `rgba(17,17,16,.035)` | `rgba(255,255,255,.045)` | subtle hover on dense list rows |
| `--scrim` | `rgba(17,17,16,.44)` | `rgba(0,0,0,.6)` | modal/drawer backdrop |
| `--accent` | `#1e6ac8` | `#6ca7ef` | primary fill, focus ring, active indicators (white on it 5.3:1; dark page ink on it 7.6:1) |
| `--accent-strong` | `#1b5eb1` | `#91bdf3` | primary hover, accent-colored text and links, selected-nav text |
| `--accent-ink` | `#ffffff` | `#0f0f10` | text/icon on an `--accent` fill |
| `--accent-wash` | `rgba(30,106,200,.10)` | `rgba(108,167,239,.16)` | selected row/nav, active chip, drop target |
| `--accent-wash-strong` | `rgba(30,106,200,.18)` | `rgba(108,167,239,.26)` | pressed selected, stronger highlight |
| `--selection` | `rgba(30,106,200,.30)` | `rgba(108,167,239,.38)` | `::selection` (a wash-level alpha is too faint; see tasks `--select-bg`) |
| `--danger` | `#c22a2a` | `#f07373` | destructive text/fill, errors |
| `--danger-ink` | `#ffffff` | `#1a0b0b` | text on a `--danger` fill |
| `--danger-wash` | `rgba(194,42,42,.10)` | `rgba(240,115,115,.14)` | danger button rest state, error callout |
| `--success` | `#1a7f37` | `#4cc26a` | confirmed, paid, online presence |
| `--success-wash` | `rgba(26,127,55,.10)` | `rgba(76,194,106,.14)` | success chip/callout |
| `--warn` | `#9a6700` | `#e0b13d` | pending, offline, away |
| `--warn-strong` | `#6d4c00` | `#e0b13d` | warn text on a warn wash |
| `--warn-wash` | `rgba(154,103,0,.12)` | `rgba(224,177,61,.14)` | offline bar, "needs booking" chip |
| `--pop-shadow` | `0 8px 28px rgba(17,17,16,.16)` | `0 8px 28px rgba(0,0,0,.5)` | menus, popovers, drag ghost, desktop dialogs only |

Focus ring is `--accent` (no separate token in this family; wiki and records add `--focus`). Info/neutral notices use `--accent-wash` with `--ink-2` text.

Categorical "day" colors for itinerary days, place categories, and map routes come from tasks' list slots (`tasks/src/styles/tokens.css`, `--slot-1..8`). They are validated in both themes and are at least 4.2:1 on `--surface` in light and at least 5.9:1 in dark. Use them for dots, stripes, map markers and polylines (3:1 needed). For text, put `--ink` on a `color-mix(in srgb, var(--day-n) 14%, transparent)` wash rather than colored text.

| Slot | Light | Dark |
|---|---|---|
| `--day-1` | `#2a6fc4` | `#6ea8e8` |
| `--day-2` | `#1b8a68` | `#3fb391` |
| `--day-3` | `#b26a00` | `#d99a3d` |
| `--day-4` | `#b3438f` | `#dc7ab8` |
| `--day-5` | `#4f52c9` | `#898cf0` |
| `--day-6` | `#c03535` | `#e57373` |
| `--day-7` | `#4b7a1f` | `#8ab55c` |
| `--day-8` | `#af2aff` | `#c678ff` |

(This reorders tasks' slots so day 1 is blue. Expense has a CVD-validated `--series-1..8` if you need charts for the trip budget: `expense/src/styles/tokens.css`.)

Avatar palette comes verbatim from teamchat (`--av-1..8` with `--av-n-ink`, each at least 4.5:1). Pick a slot by hashing the user id.

```css
:root {
  color-scheme: light;

  --page: #f1f1ee;
  --surface: #ffffff;
  --surface-2: #f0efec;
  --surface-3: #e6e5e0;
  --sidebar: #f1f0ed;
  --ink: #111110;
  --ink-2: #4f4e4a;
  --ink-3: #6d6b66;
  --hairline: rgba(17, 17, 16, 0.1);
  --hairline-strong: rgba(17, 17, 16, 0.18);
  --field-border: rgba(17, 17, 16, 0.48); /* 3:1 on page and surface */
  --row-hover: rgba(17, 17, 16, 0.035);
  --scrim: rgba(17, 17, 16, 0.44);

  /* Puter selection hue (213°), darkened so white text clears 4.5:1. */
  --accent: #1e6ac8;
  --accent-strong: #1b5eb1;
  --accent-ink: #ffffff;
  --accent-wash: rgba(30, 106, 200, 0.1);
  --accent-wash-strong: rgba(30, 106, 200, 0.18);
  --selection: rgba(30, 106, 200, 0.3);

  --danger: #c22a2a;
  --danger-ink: #ffffff;
  --danger-wash: rgba(194, 42, 42, 0.1);
  --success: #1a7f37;
  --success-wash: rgba(26, 127, 55, 0.1);
  --warn: #9a6700;
  --warn-strong: #6d4c00;
  --warn-wash: rgba(154, 103, 0, 0.12);

  --day-1: #2a6fc4; --day-2: #1b8a68; --day-3: #b26a00; --day-4: #b3438f;
  --day-5: #4f52c9; --day-6: #c03535; --day-7: #4b7a1f; --day-8: #af2aff;

  --av-1: #d6e4ff; --av-1-ink: #1d3f8f;
  --av-2: #ffe0cc; --av-2-ink: #8a3a0c;
  --av-3: #d3f4e5; --av-3-ink: #0f5c3a;
  --av-4: #fff1c2; --av-4-ink: #6d4c00;
  --av-5: #fbdce9; --av-5-ink: #8a1c4a;
  --av-6: #e3dcff; --av-6-ink: #45308f;
  --av-7: #d9f0f8; --av-7-ink: #0d5468;
  --av-8: #e9e7e1; --av-8-ink: #3f3d38;

  --pop-shadow: 0 8px 28px rgba(17, 17, 16, 0.16);

  --r-xs: 6px;
  --r-sm: 10px;
  --r-md: 14px;
  --r-lg: 20px;
  --r-full: 999px;

  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --sidebar-w: 260px;
  --panel-w: 380px;
  --header-h: 56px;
  --tabbar-h: 62px;
  --safe-t: env(safe-area-inset-top, 0px);
  --safe-b: env(safe-area-inset-bottom, 0px);
  --safe-l: env(safe-area-inset-left, 0px);
  --safe-r: env(safe-area-inset-right, 0px);
  --safe-s: var(--safe-l); /* inline start and end: swapped under dir="rtl" */
  --safe-e: var(--safe-r);
  --ease: cubic-bezier(0.32, 0.72, 0, 1);
}
:root[dir="rtl"] { --safe-s: var(--safe-r); --safe-e: var(--safe-l); }

/* Dark: by OS preference unless the app stamped light, and by an explicit dark stamp. */
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) { /* dark block below */ }
}
:root[data-theme="dark"] { /* same dark block */ }
```

Dark block (repeat it in both places, as every app does; `:where()` keeps specificity equal to `:root` so the explicit stamp still wins):

```css
  color-scheme: dark;
  --page: #0b0b0d;
  --surface: #18181a;
  --surface-2: #222224;
  --surface-3: #2c2c2f;
  --sidebar: #141416;
  --ink: #f4f4f2;
  --ink-2: #bdbcb6;
  --ink-3: #8f8e88;
  --hairline: rgba(255, 255, 255, 0.1);
  --hairline-strong: rgba(255, 255, 255, 0.18);
  --field-border: rgba(255, 255, 255, 0.42);
  --row-hover: rgba(255, 255, 255, 0.045);
  --scrim: rgba(0, 0, 0, 0.6);
  --accent: #6ca7ef;
  --accent-strong: #91bdf3;
  --accent-ink: #0f0f10;
  --accent-wash: rgba(108, 167, 239, 0.16);
  --accent-wash-strong: rgba(108, 167, 239, 0.26);
  --selection: rgba(108, 167, 239, 0.38);
  --danger: #f07373;
  --danger-ink: #1a0b0b;
  --danger-wash: rgba(240, 115, 115, 0.14);
  --success: #4cc26a;
  --success-wash: rgba(76, 194, 106, 0.14);
  --warn: #e0b13d;
  --warn-strong: #e0b13d;
  --warn-wash: rgba(224, 177, 61, 0.14);
  --day-1: #6ea8e8; --day-2: #3fb391; --day-3: #d99a3d; --day-4: #dc7ab8;
  --day-5: #898cf0; --day-6: #e57373; --day-7: #8ab55c; --day-8: #c678ff;
  --av-1: #1f3566; --av-1-ink: #c9d8ff;
  --av-2: #5a2a10; --av-2-ink: #ffd3ba;
  --av-3: #15452f; --av-3-ink: #bfeed7;
  --av-4: #4d3a05; --av-4-ink: #ffe7a1;
  --av-5: #5a1a37; --av-5-ink: #ffc9df;
  --av-6: #34276b; --av-6-ink: #d9d1ff;
  --av-7: #113f4e; --av-7-ink: #c3e9f5;
  --av-8: #33322f; --av-8-ink: #dad8d1;
  --pop-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
```

If the final app icon isn't blue, keep everything above and resample only the five accent tokens from the icon. Rule (stated in projects, tasks, documents, and spreadsheet tokens): light `--accent` must give at least 4.5:1 with white; dark `--accent` is a lighter tint of the same hue with dark ink on it.

### 1.2 Where apps agree and diverge

| Aspect | Agreement | Divergence |
|---|---|---|
| Neutral ramp | page off-white `#f7f7f5`–`#f9f9f7` (warm), surface `#fff`/`#fdfdfe`, dark page `#0d0d0d`–`#101012`, surface `#161616`–`#19191e` | tasks, invoicing, and signatures lean cool (`#f7f7f9`); calendar uses a full `--gray-0..900` ramp with blue-gray darks (`#0e0f13`) |
| Borders | translucent ink at 10% / 18% (`--hairline`) | bg/text apps use opaque hex (`--border #e2e3e8`); email uses Gmail-like `#e8ebee` |
| Text tiers | 3 tiers, with tier 3 held at 4.5:1 or better on page and surface | wiki and notes add `--text-disabled`; meetings uses `--text-secondary/--text-tertiary` |
| Accent | always derived from the app icon | teamchat indigo `#4f46e5`, projects purple `#8833eb`, tasks `#af2aff`, expense green `#0b7a63`, spreadsheet `#356d49`, documents `#375f91`, calendar `#0043ec`, meetings `#0010d7`, crm `#007663` |
| Accent helpers | `--accent-strong` (text/hover) + `--accent-ink` + `--accent-wash` | bg/text family: `--accent-hover`, `--accent-soft` (opaque), `--accent-text`, `--on-accent` |
| Status names | `--danger` is most common (36 apps) | teamchat, expense, documents, and spreadsheet use `--critical`; `--success` (24) vs `--ok` (8) vs `--pos` (4); `--warning` (24) vs `--warn` (11). This spec uses `--danger`, `--success`, `--warn` (short, matching the page/ink family) |
| Shadows | none on surfaces | projects and calendar add `--pop-shadow`/`--shadow-*` for floating layers; teamchat menus are border-only |

### 1.3 Puter desktop reference values

From `heyputer/packages/puter/src/gui/src/css/style.css` and `dashboard.css`. Use them for brand alignment only. The desktop is older and skeuomorphic (gradient buttons), and the apps don't copy it.

- Selection/brand blue `--select-color: hsl(213.05, 74.22%, 55.88%)` (≈ `#3b86e2`, only 3.7:1 with white, so not usable as a text-bearing fill). The desktop uses it for active context-menu items and file selection.
- Primary button gradient `#34a5f8 → #088ef0`, input focus `#01a0fd`, dashboard link `#5271ff`, danger `#dc2626`.
- Window chrome `hsla(210, 41%, 93%, .8)` (user-themable hue/sat/lightness/alpha), window `border-radius: 4px`, shadow `0 0 15px #00000066`.
- Context menu: `border-radius: 8px`, 4px padding, 1px `#dcdcdc` border, `0 3px 20px #00000022`, translucent white + `backdrop-filter: blur(3px)`, 28px rows, 12px text.
- Dashboard dark: bg `#1e1e1e`, card `#262626`, border `#3d3d3d`, text `#d4d4d4`.
- Font: Inter (self-hosted TTFs).

---

## 2. Dark mode

### 2.1 What apps do

| Pattern | Apps | Notes |
|---|---|---|
| A. `prefers-color-scheme` + `[data-theme=light|dark]` stamp, `localStorage` pre-paint, System/Light/Dark control | teamchat, projects, tasks, expense, documents, spreadsheet, crm, email, calendar, most business apps | Dominant. No attribute = follow OS. |
| B. JS resolves to `[data-theme-resolved=light|dark]` (CSS reads only the resolved attr) | wiki, records, notes, creative/engineering tools | Needs JS before paint; CSS has no media query fallback. |
| C. `[data-theme]` only, no OS fallback | contacts, games | Older. |

Persistence:
- `localStorage['<app>:theme']` is read by an inline `<script>` in `index.html` before the module loads, so there's no flash.
- tasks also saves `settings.theme` to `puter.kv` (Trips uses `me:prefs.theme`) (`tasks/src/lib/store.js`, `views/settings.js:22-35`), and teamchat to `profile.prefs.theme` (`teamchat/src/main.js:195`). On load, the cloud value calls `applyTheme()`.
- Every app also rewrites `<meta name="theme-color">` to the current `--page` (two metas with `media=` for system mode).

### 2.2 Puter desktop integration

- The desktop has no light/dark setting. Its own dark styling is `@media (prefers-color-scheme: dark)` (`style.css:132`, `dashboard.css:149`). The app's iframe gets the same OS preference, so "System" already matches the desktop.
- `puter.ui.on('themeChanged', cb)` exists (`puter-js/src/modules/UI.js:2979-3005`, replayed on subscribe), but its payload is the window-chrome palette only: `{ palette: { primaryHue, primarySaturation, primaryLightness, primaryAlpha, primaryColor } }` (`services/ThemeService.js:121-141`). No first-party app subscribes to it. Ignore it, or at most use `primaryColor === 'white'` as a hint; don't map it to dark mode.
- `puter.ui.contextMenu({ theme })` and `setMenubar({ theme })` accept `'dark'|'light'`, but only when standalone (`puter.env === 'web'`). Inside the desktop they follow the system. If you use them, pass the resolved theme.
- When `puter.env === 'app'`, hide Sign out (`projects/src/views/settings.js:262`, `tasks/src/views/settings.js:173`).

### 2.3 Recommendation (pattern A)

Copy these files:
1. `index.html` pre-paint script and theme-color metas: `tasks/index.html` lines 8-9 and 18-25 (rename key to `trips:theme`).
2. `src/ui/theme.js`: `documents/src/ui/theme.js`, minus the dark-page bits. It has `applyTheme`, `currentTheme`, `isDark`, and `onThemeChange(fn)` listeners that fire on OS changes too. You need the listeners to swap map tiles and redraw canvas/SVG. Set theme-color to `--page` per theme as `teamchat/src/ui/theme.js:27-31` does.
3. CSS: the media-query block plus the `[data-theme="dark"]` block as in §1.1 (`tasks/src/styles/tokens.css` shows the `:where()` form).
4. Settings: a segmented control System/Light/Dark with Lucide `monitor`/`sun`/`moon` (`tasks/src/views/settings.js:22-35`). Persist to `localStorage` immediately and to `puter.kv` (`me:prefs.theme`). Apply the kv value after load.
5. Maps: on `onThemeChange`, switch the basemap style. With MapLibre + OpenFreeMap, use the `positron` and `dark` styles. Don't CSS-invert tiles.

---

## 3. Typography, spacing, radii, elevation, motion

Typography:
- Family: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` (30 apps use a system stack; only meetings, video-studio, and vector-studio load Inter). Puter desktop uses Inter, but apps don't.
- Mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` for confirmation codes and times in tables.
- Body: 15px / 1.45 (teamchat, projects, tasks, expense, crm). Dense editors use 14px.
- `-webkit-font-smoothing: antialiased`.
- On `(pointer: coarse)`, force inputs to 16px to stop iOS zoom (`teamchat/src/styles/base.css`).

| Role | Size / weight | Example |
|---|---|---|
| Auth/hero title | 30px / 800, `letter-spacing: -0.02em` | `.auth-title` (teamchat app.css) |
| View title | 22px / 700, `-0.01em` | `.view-title` (projects base.css) |
| Item/page title (trip name in header) | 19px / 700, ellipsis | `.project-title` |
| Modal title | 18px / 700, `-0.01em` | `.modal-title` |
| Empty-state heading | 17px / 700 | `.empty-title` |
| Panel heading | 16px / 700 | `.panel-head h2` |
| Body / row title | 14–15px / 500–600 | `.card-title` 14/500, `.side-item` 14.5 |
| Button | 14px / 600 (sm 13px) | `.btn` |
| Field label | 13px / 600 `--ink-2` | `.field-label` |
| Tab / segmented | 13.5px / 600 | `.tab`, `.seg button` |
| Meta / hint | 12.5px / 400 `--ink-3` | `.field-hint`, `.pick-text span` |
| Section eyebrow | 11–11.5px / 700, uppercase, `letter-spacing: .06–.07em`, `--ink-3` | `.sidebar-heading`, `.menu-label` |
| Badge count | 11.5px / 700 | `.badge` |

Weights in use: 600 (most), 700, then 500. 800 only for hero titles. Use `font-variant-numeric: tabular-nums` for times, money, and counts.

Spacing uses a 4px base. Most frequent gaps are 8, 6, 10, 2, 4, 12. Most frequent paddings are `10px 12px`, `8px 10px`, `12px 14px`, `9px 12px`, `6px 10px`. Page gutter is 20px on desktop and 12px below 900px. Calendar formalizes a scale `--sp-1..10` = 4, 8, 12, 16, 20, 24, 32, 40. Use that if you want named steps.

Radii (page/ink family): `--r-xs` 6, `--r-sm` 8–10 (buttons, inputs, nav rows), `--r-md` 12–14 (cards, menus, toasts), `--r-lg` 16–20 (dialogs, sheets), `--r-full` (pills, avatars in projects). This spec uses teamchat's 6/10/14/20. Menu items and segmented buttons use a hard 8px inside a 10–14px container. The bg/text tool apps use 4/6/10, which reads tighter. Don't mix the two.

Elevation:
- Surfaces and cards: no shadow. A 1px `--hairline` border, with `--hairline-strong` on hover.
- Floating layers (menus, popovers, desktop dialogs, drag ghost): `--pop-shadow` plus a 1px hairline border.
- Toasts: inverted (`background: var(--ink); color: var(--page)`), no shadow needed.
- Never use gradients. tasks, expense, documents, and spreadsheet say so explicitly in their tokens headers.

Motion:
- Hover color: `background .12s ease`.
- Press: `transform: scale(.98)` over `.08s`.
- Popover in: `pop-in .14s var(--ease)` (scale .97 → 1 + fade).
- Dialog: `.18–.2s`. Bottom sheet: `sheet-up .22–.26s var(--ease)` (translateY 40px).
- Scrim: `fade-in .18s`.
- `--ease: cubic-bezier(0.32, 0.72, 0, 1)` (iOS-sheet spring). Calendar uses `cubic-bezier(.22,.61,.36,1)` and 120/180/260ms.
- Always include the `prefers-reduced-motion` block (`teamchat/src/styles/base.css`, `projects/src/styles/base.css`). Keep spinners pulsing instead of spinning.

---

## 4. Iconography and app icon

UI icons are Lucide (`lucide` npm, `^1.x`), used in 42 of about 50 apps. There is no sprite and no Puter GUI icons.
- Wrap it in a name→component map with `icon(name, size, strokeWidth)` that returns an SVG string with `aria-hidden="true"`: `projects/src/ui/icons.js`. Import only the icons you use so the bundle tree-shakes.
- Sizes: 16 in menus and small buttons, 18 in sidebar rows and `.btn`, 20 in `.icon-btn`, 14 in chips/segmented, 26–28 in empty states.
- Stroke: default 1.8. Bump to 2–2.2 at 14–16px and 2.4–2.6 for tiny checks.
- Color is `currentColor`. Menu-item icons are `--ink-3`. Active nav icons inherit `--accent-strong`.
- Trip-relevant Lucide names: `map`, `map-pin`, `route`, `plane`, `train-front`, `bus`, `car`, `ship`, `bed-double`, `hotel`, `utensils`, `camera`, `landmark`, `mountain`, `ticket`, `luggage`, `backpack`, `wallet`, `receipt`, `calendar-range`, `clock`, `sun`, `cloud-rain`, `users`, `user-plus`, `share-2`, `link-2`, `grip-vertical`, `list-checks`, `sticky-note`, `paperclip`, `globe`, `compass`, `navigation`.

App icon:
- `icon.png` at the app root (large source, 445–1254px square) and `icon-128.png` (128×128 RGBA, used by the root README and the Puter app listing).
- `public/` holds derived `favicon.ico`, `icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, and `apple-touch-icon.png`, all listed in `manifest.webmanifest` (`teamchat/public/manifest.webmanifest`). `projects/scripts/build-icons.sh` regenerates them all from `icon.png` with ImageMagick (badge crop, corner fill with the badge gradient, per-size unsharp).
- Style: rounded-square (squircle) badge, single-hue vertical gradient (lighter top), one white glyph with a soft drop shadow and a slight 3D feel, transparent margin around the badge. Examples: teamchat (blue, speech bubbles), calendar (blue, "31"), expense (green, receipt), projects (purple, winding path + flag). For Trips: a blue or teal badge with a white map pin, folded map, or suitcase. The accent is then sampled from it.
- The boot splash shows `icons/icon-192.png` at 56px with `border-radius: 16px` (`teamchat/index.html`, `.boot-splash` in base.css).

---

## 5. Layout and components

All of these exist as hand-written CSS classes plus small JS factories. No component library. The DOM helper is `el('tag.class.class', attrs, ...children)` from `projects/src/lib/dom.js`. Copy it.

### 5.1 App shell
- Desktop: `.shell { display:flex; height:100dvh }` → left `.sidebar` (240–268px, `--surface` or `--sidebar`, `border-right: 1px solid var(--hairline)`, padding `14px 10px`) + `.main` column (`flex:1; min-width:0`) + optional right `.panel` (`--panel-w` 360–380px, `border-left` hairline). Reference: `projects/src/styles/base.css` (`.shell`, `.sidebar`, `.brand`, `.sidebar-heading`, `.nav-item`, `.sidebar-user`, `.view-head`, `.view-title`, `.save-state`) and `teamchat/src/styles/app.css` (`.shell` grid with resizable sidebar `.side-resizer`, `.panel`, `.panel-head`).
- Inside the Puter window there is no extra title bar; the window head (30px) already shows the app name. The view header is in-content: `.view-head` (padding `16px 0 12px`, title + actions + save state). Teamchat's 44px `.topbar` on `--surface-3` holds global search when a top bar is needed.
- Nav rows: `.nav-item` 8px 10px, radius `--r-sm`, `--ink-2` 14px/500. Hover is `--surface-2`. Active is `--accent-wash` bg + `--accent` text. On a coarse pointer, min-height is 44px.
- Section tabs within a trip (Plan / Bookings / Costs / Lists / Files / Collab / Members, plus Road trip and Settings) use the segmented pill: `.tabs` (track `--surface-2`, 3px padding, radius `--r-md`) + `.tab` (7px 14px, 13.5px/600). Active is `--surface` with a hairline border. `projects/src/styles/base.css` `.tabs/.tab`. Below 900px they stretch full width, and below 370px the icons drop.
- Save/sync indicator: `.save-state` (12px `--ink-3`, pulsing accent dot when busy, `--danger` when failed). Offline: `.offline-bar` (warn border + `--warn-wash`) in `projects/src/styles/components.css:1361`.

### 5.2 Buttons (`teamchat/src/styles/components.css` "Buttons")
- `.btn`: `min-height: 40px`, `padding: 0 16px`, radius `--r-sm`, 14px/600, `--surface-2` bg, transparent 1px border, `gap: 8px`. Hover is `--surface-3`. Active is `scale(.98)`.
- `.btn-primary`: `--accent` / `--accent-ink`, hover `--accent-strong`.
- `.btn-ghost`: transparent, hover `--surface-2`.
- `.btn-outline`: transparent + `--hairline-strong` border.
- `.btn-danger`: `--danger-wash` bg + `--danger` text at rest. On hover it fills `--danger` with `--danger-ink`.
- `.btn-sm`: 32px / 0 12px / 13px. `.btn-block` is full width.
- Disabled/busy: `opacity: .55; pointer-events: none` (keep `aria-busy` focusable).
- `.icon-btn`: 36×36, radius `--r-sm`, `--ink-2`, hover `--surface-2` + `--ink`. `.active` is `--accent-wash` + `--accent-strong`. `.icon-btn-sm` is 30×30 and grows to 40×40 on a coarse pointer.
- FAB on mobile: `tasks/src/styles/components.css` `.fab` (54px circle, accent, above the tab bar).

### 5.3 Inputs, selects, switches, choices (teamchat components.css "Form fields")
- `.field` (column, gap 6, mb 16) > `.field-label` 13/600 `--ink-2` + control + `.field-hint` 12.5 `--ink-3` / `.field-error` 13 `--danger`.
- `.input/.textarea/.select`: min-height 42px, `9px 12px`, radius `--r-sm`, `--surface` bg.
  - Use `--field-border` for the border (teamchat uses `--hairline-strong`, which is under 3:1).
  - Focus: `outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent`.
  - Invalid: `aria-invalid` turns the border `--danger`.
- Select chevron: CSS var holding a data-URI SVG per theme (`--select-chevron` in `documents/src/styles/tokens.css`), because a data URI can't read `currentColor`.
- `.switch` (button `role=switch`, 42×26 track, `--surface-3` off / `--accent` on), `.choice` radio cards (`aria-checked` adds an accent border + wash), `.seg` segmented control.
- Search with leading icon: `.sidebar-find` (projects) or `.input-prefix` (teamchat).

### 5.4 Date pickers
- Apps use the native `<input type="date">` styled as `.input` (`projects/src/ui/bits.js` `dateField`, `expense/src/ui/expenseform.js:32`, `tasks/src/ui/taskform.js:64`). Native pickers follow `color-scheme`, so set `color-scheme` per theme (already in the tokens).
- For trip date ranges and a "days" strip, borrow calendar's mini month: `calendar/src/styles/layout.css` `.mini`, `.mini__grid`, `.mini__cell` with `.is-today`, `.is-selected`, `.is-muted`, `.has-events`. It is a 7-col grid, round cells, `aspect-ratio: 1`, selected = accent fill. For a range, add `.in-range` (an `--accent-wash` band) with rounded ends on the start and end cells.

### 5.5 Dialogs, sheets, drawers
- `.modal-root` (fixed, inset 0) > `.modal-scrim` (`--scrim`, fade-in) + `.modal-panel`.
  - At 640px and wider: centered, `width: min(480px, 100%)`, `.wide` 640px, radius `--r-lg`, padding `18px 24px 22px`.
  - Below 640px: a bottom sheet with a `.sheet-handle` (40×4 pill, `--hairline-strong`), top corners `--r-lg`, safe-area bottom padding.
  - `.modal-head` (title + close `.icon-btn`), `.modal-title` 18/700, `.modal-actions` (flex-end, gap 10).
- JS: `projects/src/ui/modal.js` `openModal`, `confirmDialog`, `promptDialog`. It handles `role=dialog`, `aria-modal`, `inert` on the app and on lower stacked dialogs, Escape, focus return to the opener, and focusing the first field only on wide screens so a phone keyboard doesn't jump. CSS: `teamchat/src/styles/components.css` "Modal" or `projects/src/styles/components.css:257-380`.
- Left nav drawer on mobile: `.modal-panel.drawer` (same machinery, edge-anchored, `min(288px, 84vw)`). `projects/src/ui/navdrawer.js`.
- Detail sheet for an item (place/booking): `projects/src/ui/tasksheet.js`. The sheet lives in the route (`#/…`), so an item is linkable, survives reload, and Back dismisses it.

### 5.6 Menus and popovers
- `.menu`: fixed, min-width 200, `max-width: min(320px, 100vw - 16px)`, padding 5–6px, radius `--r-md`, `--surface`, 1px hairline(-strong) border, `--pop-shadow`, `pop-in .14s`. It scrolls within the viewport when long.
- `.menu-item`: 9px 10px, radius 8px, 14px, icon 16px in `--ink-3`. Hover/focus is `--surface-2`. `.danger` uses `--danger`. `[aria-checked=true]` gets `--accent-wash` + a trailing `.menu-check`.
- `.menu-sep` (1px hairline, 6px margin) and `.menu-label` (11.5px uppercase eyebrow).
- JS: `projects/src/ui/menu.js` `openMenu(anchor, items)` (122 lines). It has role=menu/menuitem/menuitemcheckbox, arrow, Home, End, Escape, and Tab handling, manages `aria-expanded` on the anchor, flips position to stay on screen, and closes on outside click or scroll. Teamchat's `menu.js` adds long-press, submenus, and kbd hints if needed.

### 5.7 Toasts
- `.toast-root`: fixed bottom-center, above the tab bar on mobile, `width: min(420px, 100vw - 32px)`.
- `.toast`: inverted (`--ink` bg, `--page` text), radius `--r-md` (teamchat) or pill (projects), 11px 14px, 14px text, leading 16px icon, `.toast-action` underlined bold for Undo.
- `role="status"`. Focus rings inside use `outline-color: var(--page)`.
- JS: `projects/src/ui/toast.js` (66 lines) or `teamchat/src/ui/toast.js` (with close button).

### 5.8 Empty states, skeletons, loading
- `.empty`: centered column, padding 40px 20px, gap 8. `.empty-icon` is a 56px rounded-16 tile on `--surface-2` with a 26–28px Lucide icon in `--ink-2`, followed by a 17/700 title (`level`: heading level 1–6, default 3, or 0 for a plain title), a 14px `--ink-2` paragraph (max 360px), and an optional primary button. `teamchat/src/styles/components.css`, `projects/src/ui/bits.js` `emptyState`.
- `.skeleton`: `--surface-2` block with radius 8 and a `pulse 1.4s` animation. `.spinner`: 26px ring, `--surface-3` track, `--accent` head.

### 5.9 List rows and cards
- Grouped list: `.card` container (surface, hairline border, `--r-md`, `overflow:hidden`) holding `.task-row`-style rows (`11px 14px`, gap 11, hover `--surface-2`, hairline between rows). `.section-label` above the card (13/650 `--ink-2` + `.count` tabular `--ink-3`). Source: `tasks/src/styles/components.css` `.card`, `.section-label`, `.task-row`, `.task-check`. Use this for itinerary items within a day, bookings, and packing lists.
- Board card: `projects/src/styles/board.css` `.card` (surface, hairline, `--r-md`, `10px 12px`, hover border `--hairline-strong`, `.card-title` 14/500, `.card-row` meta).
- Picker list: `.pick-item` with `aria-selected`/`aria-checked`, an accent-wash selected state, and a square `.pick-check` (teamchat). Use it for "add place to day" and member pickers.
- Stat tiles (budget totals): `expense/src/styles/components.css` `.stats/.stat`, `.meter` progress, `.num` tabular.
- Settings rows: `tasks` `.setting-row` inside `.card`, or `projects` `.settings-card/.settings-row`.

### 5.10 Avatars, member chips, presence
- Initials avatar: `teamchat/src/styles/components.css` `.avatar` (`--size` var, rounded-square radius about 28% of size, `data-color="1..8"` → `--av-n`/`--av-n-ink`, `.avatar-img` overlay for photos). Sizes `.avatar-xs` 20, `.avatar-sm` 24, default 36, `.avatar-lg` 56.
- Stacks: projects `.avatar-stack` (circular, 2px `--surface` ring, `-7px` overlap, `.avatar-extra` "+3" on `--surface-3`) or teamchat `.face-stack`. Pick one shape: rounded-square (teamchat) for people lists, circle stacks (projects) for compact headers. Don't mix them in one view.
- Presence: `.presence` dot (11px, 2px surface ring) with online/away/offline states (teamchat). Live "who's viewing this trip" belongs in the header stack.
- Chips: `.chip` (pill, `--surface-2`, 13/600, trailing remove button), `.pill-accent` (accent wash + `--accent-strong`), `.label-chip` (projects, colored wash with ink pulled toward page ink for contrast). Use these for day/category tags.

### 5.11 Drag and drop (reordering stops, moving between days)
- Handle: Lucide `grip-vertical` in a 20×28 `.nav-grip`-style button, `--ink-3`, `opacity:0` until row hover or focus. It is always visible on `(hover: none)` and uses `touch-action: none`. `projects/src/styles/base.css` `.nav-grip`.
- While dragging:
  - The lifted item is a `.drag-ghost` (fixed, `--pop-shadow`, opacity .95).
  - The slot is a `.card-placeholder` (1.5px dashed `--hairline-strong`, `--accent-wash` fill, `--r-md`) in `projects/src/styles/board.css:259-283`.
  - Set `body.dnd-active { user-select:none; cursor:grabbing }`.
- In-list sorting: `tasks/src/ui/sortable.js` `makeSortable` + `.sortable-dragging` (surface-2, 1.5px accent outline inset), or `projects/src/ui/reorder.js` `initListReorder` (pointer events, slop threshold, Escape cancels). Cross-column: `projects/src/ui/dnd.js` `initBoardDnd` (long-press on touch).
- Keyboard equivalent: Alt+ArrowUp/Down on the focused grip (`projects/src/ui/checklist.js:107`, `navdrawer.js:234`), plus "Move to day…" in the row menu.

---

## 6. Density and feel

- Medium density: 40px buttons, 42px fields, 34–36px nav/menu rows (44px on touch), 15px body. Roomier than the bg/text tool apps (32px rows, 13px text, 4–6px radii) and tighter than Material (no 56px app bars, no FAB-first desktop).
- Structure comes from hairlines and three surface steps (page → surface → surface-2/3), not shadows or color blocks. Cards sit on `--page`. Hover is a surface step, never a shadow lift.
- Neutrals are near-pure gray with a faint warm tint (`#f7f7f5`, `#111110`), not Tailwind slate/zinc blue-grays. The accent appears sparingly: primary button, focus ring, active nav, selection washes. Everything else is ink.
- Selection and active states use translucent washes (`--accent-wash`) so icons keep their color. The Puter dashboard says this explicitly ("a quiet accent wash + hairline ring instead of a solid accent fill").
- Generous radii (10/14/20) with a hard 8px on inner items. Rounded-square avatars and empty-state icon tiles echo the app-icon squircle.
- No gradients, no glassmorphism, no colored page backgrounds, no hero illustrations. The only imagery is user content (trip cover photos, place photos).
- Prose comments in CSS name the contrast ratio each token was tuned to. Keep that habit.

---

## 7. Responsive and mobile

Breakpoints in use:
- 900px: sidebar becomes a drawer (projects) or tab bar + FAB (tasks).
- 720px / 1024px: teamchat hides the topbar below 720px and floats the right panel over content below 1024px.
- 640px: dialogs become bottom sheets.
- 480px and 370px: final compaction (hide tab icons, stack field rows).

Patterns:
- Under 900px, the trip list is a full screen, the trip itself is a full screen with a `.back-btn`, and section tabs stretch across (projects). Or use a bottom `.tabbar` (5 cols, `--tabbar-h` 58–62px + safe-area, surface + top hairline) with a `.fab` for "Add place" (`tasks/src/styles/components.css:169-240`).
- Map + itinerary: side by side at 1024px and wider (itinerary as `.panel`). Below that, use a toggle or a map with a draggable bottom sheet.
- `viewport-fit=cover` + `--safe-*` insets on fixed bars, sheets, and toasts (teamchat applies them everywhere, including landscape notch).
- Input media queries: `(pointer: coarse)` enlarges hit areas (icon-btn-sm to 40px, nav rows to 44px, inputs to 16px). `(hover: none)` reveals hover-only affordances (grips, row actions).
- `100dvh` for the shell. `overscroll-behavior: none` on body. PWA manifest + `apple-mobile-web-app-*` metas (`teamchat/index.html`).

---

## 8. Accessibility conventions

- Focus: global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`.
  - Fields use offset -1px and replace the border.
  - Tightly stacked rows (nav, menu items) use an inset ring (`outline-offset: -2px` or `box-shadow: inset 0 0 0 2px var(--accent)`).
  - On inverted surfaces (toasts, image viewer) the ring is `--page` or white.
  - A modal panel that is itself focused shows no ring.
- Contrast:
  - Tier-3 text is held at 4.5:1 or better on page and surface.
  - Field borders and switch tracks are held at 3:1.
  - Status colors get a `-strong` or `-ink` variant where the base fails as text.
  - Every colored chip pairs color with an icon or label, never color alone (tasks priority note).
  - Day colors are for markers and stripes; text on them uses ink on a wash.
- Hidden: `[hidden] { display:none !important }` so classes that set `display` can't override it. Use `.visually-hidden`/`.sr-only` and a `.skip-link` (teamchat base.css).
- ARIA:
  - Icon buttons always have an `aria-label`.
  - Menus use role=menu/menuitem/menuitemcheckbox + `aria-haspopup="menu"` + an owned `aria-expanded`.
  - Dialogs use role=dialog + `aria-modal` + `aria-label`, with `inert` on the background.
  - Toasts use `role=status`.
  - Toggles use `role=switch`/`aria-checked`. Segmented controls use `role=group` + `aria-pressed` (tasks) or radiogroup + arrow keys (`projects/src/ui/bits.js` `radioGroupKeys`).
  - Nav uses `aria-current="page"`. Busy buttons use `aria-busy` and stay focusable.
- Tooltips: none custom. Use native `title` + `aria-label`.
- Motion: a `prefers-reduced-motion` block that zeroes transitions but keeps the spinner as a pulse.
- Hit targets: 24px minimum on pointer (WCAG 2.5.8), 40–44px on coarse pointers.
- Tests: records, wiki, notes, and help-desk run `axe-core` in vitest (`records/tests/app.test.js`). Teamchat asserts token contrast in tests (`teamchat/tests/highlight.test.js`). Add a token-contrast test for the accent and day palettes.

---

## 9. Structure worth having

Product structure the planner needs, independent of look:
- Dashboard of cover-photo trip cards (photo top, name, date range, member stack) plus a spotlight card for the ongoing or next trip.
- Map and day list side by side, with route polylines colored per day.
- Per-day color tint on the day header, badge and activity rows at different strengths: `color-mix(in srgb, var(--day-n) X%, var(--surface))` with 16% badge / 8% header / 6% rows in light, 24/13/10% in dark.
- Category-colored place icons, stat tiles (days, places, distance, spend), packing progress counters, settle-up cards.
- Theme-aware basemap swap and an explicit z-index scale (`--z-pop`, `--z-modal`, `--z-toast`).

Not wanted: black accents, display fonts, card shadows, glass or blur panels, gradient backdrops, utility-class CSS. Puter apps are hand-written CSS on tokens.

## 10. Files to copy patterns from

1. `teamchat/src/styles/tokens.css`: token structure, dark media + stamp blocks, avatar palette (base for §1.1).
2. `teamchat/src/styles/components.css` + `base.css`: buttons, fields, switch, seg, avatars, presence, modal/sheet, menu, toast, empty, chips, pick list, focus/reduced-motion/iOS-zoom base rules.
3. `projects/src/styles/base.css`: shell, sidebar, nav rows with drag grip, view header, save state, segmented tabs, responsive shell.
4. `projects/src/ui/modal.js`, `menu.js`, `toast.js`, `bits.js`, `icons.js`, `lib/dom.js`: the JS component layer (dialogs with inert/focus return, keyboard menus, toasts, avatar stack, date field, empty state, Lucide wrapper, `el()`).
5. `projects/src/styles/board.css` + `projects/src/ui/dnd.js`: cards, drag ghost, dashed placeholders, cross-column drag (stops between days).
6. `tasks/src/styles/components.css` + `tasks/src/ui/sortable.js`: grouped list card + rows, mobile tab bar + FAB, segmented, in-list sort, `--slot` palette (day colors).
7. `tasks/index.html` + `documents/src/ui/theme.js` + `tasks/src/views/settings.js`: pre-paint theme script, theme module with change listeners, System/Light/Dark control persisted to `puter.kv`.
8. `calendar/src/styles/layout.css` (`.mini*`): month grid for trip date ranges.
9. `expense/src/styles/components.css`: stats, meter, list-group, money formatting (`.num` tabular) for the budget tab.
10. `projects/scripts/build-icons.sh` + `teamchat/public/manifest.webmanifest`: icon derivation and PWA manifest.
