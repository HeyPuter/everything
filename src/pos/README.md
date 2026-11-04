# Point of Sale

**Live app:** [pos.puter.com](https://pos.puter.com/)

A fast, friendly register for small shops. Product catalog, checkout, receipts,
refunds, cash reconciliation, and sales reports, with all data stored in the
user's own [Puter](https://puter.com) cloud. No server of your own, no payment
processor required.

Built with vanilla JavaScript and Vite. No frameworks.

## Features

- **Register**: tap-first product grid with search and category filters, custom
  one-off items, quantity and per-line discounts, order-level discounts (with
  reusable presets), cash payments with change calculation and quick-tender
  buttons, card and other payments recorded manually.
- **Arrange the grid**: a Favorites chip for the tiles a shop pins, and an
  Arrange mode (behind the manager PIN) where tiles are dragged with a finger
  or moved with per-tile arrows for keyboard and screen-reader parity. The
  order is stored per product and applies inside "All" and inside each
  category; "Sort by best-selling" arranges it from the last 30 days of sales
  in one tap. New products land at the end, and the arrangement travels in the
  JSON backup.
- **Barcode scanning**: USB/Bluetooth keyboard-wedge scanners work with no
  setup (a scan is told from typing by its timing), and the camera where
  `BarcodeDetector` exists. An exact SKU rings up hands-free and repeat scans
  bump the quantity; an unknown code offers to create the product with the SKU
  filled in, or to ring it up as a one-off.
- **Product options**: sizes, milks, and extras as option groups with signed
  price deltas, required or optional, single or multi-select. Tapping a product
  with options opens a one-screen picker; identical combinations merge into one
  cart line, and reports still aggregate by base product.
- **Notes**: a note on an item ("no ice", "decaf") from the line editor, and a
  note on the sale ("for Sam", "gift wrap") from the payment sheet. Quick notes
  a shop types once in Settings become one-tap chips over either field. Notes
  are copied onto the receipt, print under their item, appear on the shared
  copy, and are searchable; a line with a note stays its own cart line, so two
  flat whites with one decaf are two lines.
- **Split payments**: settle one sale across several tenders with a live
  remaining balance and a one-tap "rest on card". Change is computed only on
  the cash tender that overshoots.
- **Hold and resume**: park a sale under a name or an automatic label, serve the
  next customer, and pick it back up later. The open cart autosaves too, so a
  reload or a sleeping tablet costs nothing.
- **Offline**: sales always complete. A network failure puts the finished
  receipt in a local outbox, the cashier sees the normal success screen, and the
  queue drains itself when the connection returns — exactly once per sale.
  The register also *opens* offline: a service worker keeps the app shell and
  the Puter SDK cached, and a signed-in device boots from its last-known local
  copy of settings and catalog — selling works, history and edits say they
  need a connection.
- **Refunds**: return a sale in full or line by line, with the customer owed
  what they paid (their share of every discount, at that day's tax rate).
  Refunds are their own numbered receipts with negative amounts, so reports net
  them out and the original is never rewritten. Void stays for same-day
  mistakes.
- **Loyalty card**: one scheme, off by default — stamps (buy N of a product or
  category, the next is free) or spend (a percentage back, spendable past a
  threshold). Progress is worked out from the receipts already stored against
  the customer, so there is no parallel ledger to drift and a refunded sale
  takes its stamps back with it. Attaching a customer at checkout shows the
  card, a ready reward is one tap (and one tap to undo), the slip prints where
  the card stands, and Reports shows what rewards cost.
- **Store credit**: refund to a balance instead of opening the drawer, and take
  that balance as a tender on a later sale — composing with split payments, so
  credit plus card in one sale is a solved problem. The balance is derived from
  an append-only ledger of movements, each pointing at the receipt that caused
  it; manual credit is PIN-gated and keeps its reason. The refund slip prints
  the credit and the balance, the customer page shows the entries behind the
  figure, and Reports shows outstanding credit as its own figure, because a
  shop should know what it owes.
- **Cash drawer**: opening float, cash in and out with reasons, and an
  end-of-day close that counts the drawer against expected cash and records
  over/short. Prints as a Z-report; past closes are browsable from Reports.
- **Stocktake**: count the shop and post every variance in one pass, optionally
  scoped to a category and optionally blind (the expected figure hidden while
  counting). Counted quantities are typed, not deltas; a scan jumps to that
  product's row; the sheet is saved as you go, so a sleeping tablet costs
  nothing. A review screen shows every variance in units and — where costs are
  kept — what it is worth, before anything moves. Each line lands in the
  movement ledger with a `stocktake` reason and a shared session id, and past
  counts are browsable.
- **Catalog**: products with price, category, SKU, tile color, per-product tax
  assignment, option groups, and optional stock tracking with low-stock and
  out-of-stock badges.
- **Cost and profit**: an optional cost price beside the price, with the margin
  worked out as it's typed. Cost is snapshotted onto the receipt line at the
  moment of sale, so a supplier's price rise can't rewrite what March earned.
  Reports gain gross profit and margin (net of tax, refunds netted out), Top
  products can rank by what earns most rather than what sells most, and the
  catalog shows margins and flags anything selling at or below cost. Where cost
  is known for only part of the trade, the figures say so.
- **Taxes**: any number of named rates, a store default, per-product overrides,
  tax-free products, and a tax-inclusive pricing mode. Receipts show a breakdown
  by rate. All math is integer-cent exact: subtotal, discounts, tax, and total
  always agree.
- **Tax summary**: what was collected for any period, one row per rate with its
  taxable base, tax, and gross — plus zero-rated and tax-free trade on their own
  rows, the way a return asks for them. Refunds net out at the rate their sale
  was rung up at, tax-inclusive shops read the gross taken and the tax within
  it, and the total reconciles with the Tax collected tile. Quarter and year
  ranges (and a previous-quarter quick pick) sit beside today/7d/30d; the
  summary prints as a document and exports as its own CSV.
- **Receipts**: sequential numbering, monthly history with day groups and day
  totals, printable documents, and a shareable image for the customer (Web Share
  where available, download everywhere else) — no printer required.
- **Thermal printer and cash drawer**: direct ESC/POS printing to a receipt
  printer over Web Bluetooth, Web Serial, or WebUSB, with a remembered choice,
  a paper width, a test print, and auto-print on sale complete. The drawer
  wired to the printer opens on cash sales, and "No sale" opens it for change —
  PIN-gated and recorded in the day's movements. The printer belongs to the
  device, not the account; where a browser can't reach one (an iPad, or any
  page without https) Settings says so plainly and everything keeps printing
  through the browser's own dialog. Nothing about selling depends on it.
- **Reports**: today / 7 days / 30 days / month-to-date, revenue net of refunds
  with deltas vs the previous period, gross profit and margin where costs are
  kept, revenue-by-day (or by-hour) chart with an accessible table view, top
  products by revenue or profit, sales by category, payment-method breakdown,
  and day closes.
- **Catalog import**: bring a product list in from a spreadsheet — your own
  export or another till's. The header row is guessed at and every column can
  be pointed by hand, semicolon files and decimal commas included; a preview
  says exactly what will happen ("312 new, 18 matched by SKU and updated, 4
  rows skipped") before anything is written. Products are matched by SKU, so a
  supplier's 4% rise is a spreadsheet edit and a re-import. The catalog exports
  as CSV too, which doubles as the import template.
- **Your data**: whole-dataset JSON backup and restore (with a preview before
  anything is written), plus CSV exports of receipts and line items for any date
  range.
- **Automatic restore points**: a snapshot once a day, at every day close, and
  before anything destructive — a restore, a catalog import, a posted stocktake,
  a sample-data wipe. Written to the shop's own Puter storage with the same
  exporter the backup button uses, and restored through the same previewed,
  validated path. Settings lists them with what each holds and what they cost in
  storage; retention keeps the newest few plus one a week and prunes the rest,
  and a run of failures says so plainly rather than going quiet.
- **First run**: guided onboarding (store name, currency, tax rate) or a rich
  sample dataset (a cafe with 90 days of sales, options, splits, and two weeks
  of day closes) that can be wiped with one tap.
- Light, dark, and system themes. Responsive, app-like layout for desktop,
  tablet, and phone. Keyboard- and screen-reader-friendly.

## Storage design

Everything lives in the signed-in user's Puter account:

| Where | What | Why |
|---|---|---|
| `puter.kv` | settings, products, categories, taxes, discount presets, customers, the store-credit ledger, held sales, the open cart, the open stocktake, month indexes | small, hot, single-key reads |
| `puter.fs` | `pos-data/sales-YYYY-MM.json`, `drawer-`, `stock-` and `stocktake-YYYY-MM.json`, one file per month; `pos-data/snapshots/` | history grows unbounded; reads scale with the months a report looks at, and a restore point is a whole dataset |
| `localStorage` | the offline outbox (account-scoped), theme, this device's printer, the boot snapshot of settings + catalog | must survive with no network, be durable before the success screen paints, or describe this device rather than the shop |

Receipts store copies of names, prices, costs, chosen options, rates, and
computed totals, so history survives catalog edits and rate changes. They are never
rewritten: older shapes (a single `payment` before split tenders) are normalized
at read time.

## Development

```bash
npm install
npm run dev        # http://localhost:5174 (real Puter SDK, requires sign-in)
```

For UI work without a Puter account, open `/mock.html` on the dev server. It
installs an in-memory Puter mock persisted to localStorage
(`localStorage.removeItem('pos:mock')` resets it).

```bash
npm test           # vitest: cart math, store, refunds, drawer, offline, CSV, …
npm run build      # production build to dist/
npm run preview    # serve the production build
```

## Project structure

```
src/
  lib/       totals.js (cart math), store.js (Puter data layer),
             options.js, refunds.js, drawer.js, payments.js, profit.js,
             loyalty.js, outbox.js, sync.js, csv.js, product-csv.js,
             tax-report.js, backup.js, snapshots.js, receipt-doc.js,
             escpos.js, printer.js, scan.js, sample.js, money.js,
             dates.js, env.js, util.js
  ui/        shell, modal, toast, theme, icons (Lucide), onboarding,
             receipt renderer/printing, receipt image, z-report,
             tax summary document, drawer sheet, product form,
             product import, stocktake, scanner, csv export,
             sync status, dom helpers
  views/     register, products, receipts, reports, settings, auth
  styles/    tokens (light/dark), base, components, views, print
test/        vitest suites + in-memory Puter mock
dev/         browser Puter mock for mock.html
```

## Notes

- When running inside a Puter app window (`puter.env === 'app'`), the app hides
  sign-out; the platform owns the session.
- Sales are recorded without integrated payment processing; card payments are
  recorded as taken on an external terminal.
- Only sale recording is queued offline. Catalog and settings edits, voids, and
  refunds need a connection and say so; an edit the cloud rejects is rolled back
  rather than left on screen looking saved.
- A sale still waiting to sync can be printed and shared but not voided or
  refunded: the record of what came back would live only on this device, so
  those two wait until the sale has landed, which the receipt says.
- CSV exports mark any cell that would otherwise be read as a spreadsheet
  formula as text; amounts and quantities stay numbers.
- The customer directory, like everything else, lives only in the
  shopkeeper's own Puter account — no third party ever sees it.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
