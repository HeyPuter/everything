# Inventory

Inventory management on [Puter](https://puter.com): products, per-location stock, barcodes, photos, purchase cost, low-stock alerts, supplier orders, history, reports, and CSV import/export.

Built with vanilla JavaScript (no frameworks), [Puter.js](https://docs.puter.com) for auth and storage, [Lucide](https://lucide.dev) icons, and [Vite](https://vite.dev).

## Features

- **Products**: name, SKU, barcode, category, unit of measure, pack size, purchase cost, selling price, photo, notes
- **Kits**: one product made of others, built ahead of time (components out, kit in, costed at what the parts cost) or sold as a kit (holds no stock; selling one takes its components out), with what it can make on screen and alerts and reorder seeing through to the parts
- **Variants**: one product kept in several sizes or colours, with a family holding the shared half, variants holding the SKU, barcode, stock and cost, collapsed to one row in the list and totalled as one line of money
- **A page per product** at `#/product/<id>`: stock by location with its own receive/remove/move, lots in FEFO order, cost, price and margin, what's on order, a movement chart, and the last few log entries. Bookmarkable and linked from every row, card, and report
- **Stock**: receive, remove, recount, and move between locations. Every change lands in the activity log, carrying what a receipt paid and what a sale took in
- **Units**: counted goods stay whole; measured ones (kg, L, m) take decimals, and packs are received by the case
- **Locations**: per-location stock levels and transfers, with what each place actually holds
- **Shelf codes**: an optional bin code per product per place, searchable on rows, dialogs, labels and the count sheet, which can be ordered by it so a count follows the room instead of the alphabet
- **Minimums**: what a place should hold, per product, and a replenish list that moves stock forward from wherever it sits, or says plainly when a shortfall is a purchase, not a move
- **Barcodes**: USB/Bluetooth scanners, the phone camera, or typing. Scan to adjust stock, one item after another
- **Take out**: a scan-through basket for a day's sales, a delivery, or a job's materials, with one reason, location and note for the lot, overridable per line, committed in one pass and undoable as one
- **Low-stock alerts**: per-product thresholds with a store-wide default, dashboard alerts, and a navigation badge
- **Demand**: units out per day from the log, days of cover on every row, a "Running out soon" filter, and suggested reorder points you accept (never applied on their own)
- **Reorder**: alerts grouped by supplier and ordered by urgency, with suggested quantities (twice the threshold, or a coverage horizon in days of demand), order sheets to copy/download/email, and receive-all
- **History**: the full activity log, filterable by product, type, and date, exportable as CSV, with older months archived
- **Counts kept**: every committed stocktake on record (scope, what was counted and skipped, units over and short, variance at cost), each openable as its own report, printable and exportable, with older ones rolled down to their totals
- **Reports**: stock value over time, top movers, real sales (revenue, cost of goods, gross profit, realized margin), dead stock, what counting found missing over time, value by category and location, and margins
- **Bulk actions**: multi-select to edit, re-assign, archive, export, or delete in one write
- **Archive**: retire products without losing their details, thresholds, SKU, or history
- **Suppliers**: contacts, order notes, per-supplier product/value stats, and a price list of what each one supplies
- **Multiple sources per product**: each supplier with their own order code, price, pack size, and lead time; one marked default, the cheapest shown (never chosen), and a reorder line switchable before the sheet is made. Order sheets print the supplier's own code, and receiving values the delivery at what was agreed
- **CSV import/export**: column auto-detection (including shelf codes, per-location stock and bins), SKU matching (update, add to stock, or skip), losslessly re-importable exports
- **Safety net**: undo on delete, full JSON backup/restore, and automatic snapshots before anything destructive
- **Design**: responsive app shell (sidebar on desktop, tab bar on mobile), light/dark/system theme, keyboard- and screen-reader-friendly
- **Storage**: everything lives in the user's own Puter account via `puter.kv` and `puter.fs`; no server of our own

## Development

```sh
npm install
npm run dev
```

Open `http://localhost:5174/` for the real Puter SDK, or `http://localhost:5174/mock.html` for a local in-memory mock of Puter (no account needed; data persists in localStorage).

## Tests

```sh
npm test
```

Vitest unit tests cover the CSV parser/serializer and column mapping, inventory logic (stock status, stats, filtering, import merge), per-location stock and its migration, units and pack sizes, the activity log, reorder maths, demand rates and the thresholds they imply, take-out baskets, per-location minimums and the transfers they imply, supplier sources and their price lists, shelf codes and the walk they imply, variant families and their totals, kept counts and their bounded history, kit recipes and what they can make, report maths, backup validation, and the store's persistence paths against a fake Puter SDK.

`tests/integrity.test.js` reproduces GitHub issues #34–#38 using independent
store sessions and injected storage failures. It checks concurrent and offline
stock movements, receipt recovery, retained rejected writes, fulfillable kit
sales, and required safety snapshots. `tests/sync-ui.test.js` checks the error,
retry, and receipt recovery controls in the DOM.

## Persistence and recovery

Inventory edits are recorded under unique `inv:op:v1:<uuid>` keys before the
ordinary collection keys are updated. These immutable commits are authoritative;
the collection keys are projections. Stock and its activity share a commit, and
purchase receipts include order state in the same commit. A reload reconstructs
the complete receipt even when a projection write failed. A network retry reuses
the commit key, so it cannot apply the receipt twice.

Each commit describes changes from the session's own last saved state. Different
records and fields merge, and stock and lot deltas accumulate across sessions.
Changes discovered before saving that would overdraw stock are rejected. If two
in-flight commits together overdraw stock, or edit a concurrently deleted record,
loading stops with an explicit conflict and a download of the preserved operation
data for review. That recovery file is diagnostic data, not an ordinary backup.

The implementation uses the documented [KV list](https://docs.puter.com/KV/list/)
and [KV set](https://docs.puter.com/KV/set/) APIs. It lists journal keys and fetches
only uncached immutable entries; materialized collections update incrementally.
The journal currently retains prior operations, including after a logical erase,
and its key listing grows with usage. Do not delete journal entries or deploy an
older writer against this format: a future compaction needs a coordinated
checkpoint/migration. Reload existing tabs when deploying this version.

API-rejected offline writes stay on the device and offer retry and backup export.
An automatic safety snapshot must save both its payload and manifest to the cloud
before erase, restore, import, stocktake, or take-out can proceed. Those operations
therefore need a connection; disposable sample cleanup explicitly bypasses the
snapshot. Routine stock edits and receipts still queue while offline.

## Build

```sh
npm run build
```

Static output lands in `dist/`.

## Landing page, documentation, and guides

The signed-out home page is a static, crawlable landing page, inspired by the
sibling `cap-table` project. Signed-in visitors continue into the existing app.
Public help is available without a Puter session or JavaScript:

- `/docs/`: 25 product walkthroughs, from setup and importing to stocktakes, printing,
  settings, troubleshooting, and a reference section covering the CSV columns, the
  activity log, and every keyboard and scanner behaviour
- `/guides/`: 15 concept guides with worked examples and practical checklists, covering
  stock fundamentals, the working day, planning, and record keeping

The library includes search, category navigation, breadcrumbs, page contents,
related articles, mobile navigation, and print styles. Settings also links to
both collections. Search and navigation disclosures are progressive enhancements;
the article text and links are present in the generated HTML.

### Editing content

- `src/views/landing.html`: shared landing page, header, and footer; the sign-in
  view enhances the same HTML that Vite inserts into the initial document.
- `src/styles/landing.css`: public-page styling scoped to `.landing`.
- `site/content.js`: article content, categories, section IDs, and related links.
- `site/render.js` and `site/plugin.js`: static document rendering and Vite routes.
- `site/client.js` and `site/styles.css`: library interactions and reading layout.
- `public/screenshots/`: existing sample-data captures from `store/source/ui/`.

### Hosting

The production site is hosted at `https://inventory.puter.com`. Deploy the complete
`dist/` directory at the origin's root. The build emits an `index.html` for each
article and collection, plus `404.html`; configure the
static host to serve directory indexes and use that file for missing pages.
Do not rewrite all requests to the app's root document. App routes continue to
use `#/…`. The Vite development server also supports library routes, canonical
trailing-slash redirects, and missing-article responses.

The default build uses `https://inventory.puter.com` for canonical links, absolute
social URLs, structured article metadata, and `sitemap.xml`:

```sh
npm run build
```

Set `SITE_URL` at build time to override the origin for another deployment.
Use `SITE_URL= npm run build` to omit canonical links, absolute social URLs,
structured metadata, and the sitemap. The static pages, search, and app work
normally. The service worker keeps visited public pages under their own URLs; an unavailable article
never falls back to showing the inventory workspace.

The public-site tests cover links, assets, metadata, search, mobile navigation,
sign-in retries, and offline page isolation alongside the existing inventory tests.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
