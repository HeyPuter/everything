# Accounting

**Live app:** [accounting.puter.com](https://accounting.puter.com/)

Double-entry bookkeeping for small businesses. Send invoices, enter bills, categorize bank transactions, reconcile statements, and run the financial reports an accountant expects.

Everything is stored in the user's own [Puter](https://developer.puter.com) account. There is no server of ours and no database of ours.

## Features

- **Sales**: invoices, estimates (convert to invoice), sales receipts, credit memos, refund receipts, and received payments applied to one or many invoices, with unapplied credits. Statuses (open, due in N days, overdue, partially paid, paid) are derived from payments and due dates, never stored.
- **Expenses**: expenses, checks, bills, bill payments, a Pay bills screen across vendors, vendor credits, credit card refunds, and purchase orders (copy to bill). Category lines and item lines, with a billable customer per line.
- **Banking**: upload statements as CSV (any bank, with a column mapping) or OFX (including .qfx and .qbo files). Review each line: add it with a payee and category, match it to a transaction already in the books (or to an open invoice or bill, which records the payment), record it as a transfer, or exclude it. Re-imports skip lines already imported.
- **Bank rules**: categorize lines automatically by description or amount, for money in or out, per account, in priority order, optionally adding them straight to the books.
- **Reconcile**: tick off cleared transactions against a statement's ending balance, save for later, finish with or without an adjustment, review history, undo the last one, and see a report of reconciled transactions changed afterwards.
- **Chart of accounts**: the standard account types, sub-accounts, account numbers, opening balances, inactive accounts, and a register per account with running balances and cleared/reconciled status.
- **Other transactions**: deposits (combine payments waiting in Undeposited Funds, add other funds, cash back), transfers, credit card payments, and journal entries that must balance.
- **Reports**: Profit and Loss (by month, quarter, or year; compared with the previous period or year), Balance Sheet (and comparison), Statement of Cash Flows, receivables and payables aging (summary and detail), open invoices, unpaid bills, customer and vendor balances, sales by customer and by item, expenses by vendor, sales tax liability, general ledger, trial balance, journal, transaction list, and account list. Cash or accrual basis, collapsible sections, drill-down from any amount to the transactions behind it, CSV export, and print or save as PDF.
- **Recurring transactions**: any common transaction can become a template, created automatically on schedule or listed as a reminder.
- **Sales tax**: tax rates, tax on taxable lines after discounts, the liability report, and recording a tax payment.
- **Customers, vendors, products and services**: detail pages with balances and history, CSV import and export.
- **Closing date**: lock the books through a date so filed periods cannot change.
- **Search** everything from the top bar (transactions by number, name, or amount; contacts; accounts; reports; pages), and Ctrl+Alt keyboard shortcuts (press `?` for the list). Date fields take `+`, `-`, `T`, `M`, `H`, `Y`, `R`, `W`, `K`.
- **Attachments** on any transaction, stored in the user's Puter drive.
- **Audit log** of recent changes, **backup and restore** (download or save to Puter), a **sample company** to explore, and dark, light, and system themes.
- An app-like layout on desktop, tablet, and phone (bottom tab bar, stacked line items, card lists).

## Stack

- Vanilla JavaScript modules, no framework. [Vite](https://vitejs.dev) for dev and build, [Lucide](https://lucide.dev) icons, [Vitest](https://vitest.dev) tests.
- [Puter.js](https://docs.puter.com) for sign-in, the key-value store, and file storage.

### Performance

- Money is integer cents everywhere, so totals are exact.
- The general ledger is column-oriented: postings sorted by date in `Int32Array`/`Float64Array` columns, with a per-account index built by counting sort. A report over a date range is two binary searches and a tight loop; an account register reads its own index. The ledger is rebuilt lazily, once per change, only when something asks for it.
- Derived data (open balances, statuses, the search index, balances) is memoized per store version.
- Long lists render only the rows on screen (windowed tables), and charts are drawn on a canvas at device pixel ratio.
- Pages other than Home and every transaction form load on first use; the first screen needs about 38 KB of gzipped JavaScript.
- Measured in Node with 50,000 transactions (117,000 postings): building the ledger takes about 50 ms, a Profit and Loss or Balance Sheet about 1 ms (58 monthly columns included), receivables aging about 15 ms, and an account register about 5 ms.

## Storage design

Puter's key-value store is DynamoDB underneath: reads are billed per 4 KB of an entry, writes per 1 KB of the whole entry, `list()` has a lower rate limit than `get`/`set`, and there are no secondary indexes. The design follows from that:

- **One small entry per record**, keyed by collection: `a:` accounts, `c:` contacts, `i:` items, `t:` transactions, `b:` bank lines, `r:` rules, `p:` recurring templates, `x:` tax rates, `n:` reconciliations, plus `settings`. Editing an invoice rewrites about 1 KB, never a shard.
- **No index keys.** A company's books fit comfortably in memory, so every query (lists, search, reports) runs locally against the ledger. That keeps every write a single entry.
- **A device cache in IndexedDB**, so opening the app is instant and does not re-read the books.
- **Incremental sync through a change log.** Each save increments a `rev` counter and, in the same batch as the records, writes `log:<rev>` naming the keys it changed, set to expire after 30 days. Another device reads `rev` (one tiny get); if it moved, it reads only the log entries it missed and only the keys they name. A device that is more than 500 changes behind, or has been away longer than the log is kept and finds entries missing, reloads everything. An entry that is still missing ten minutes after a device first looked for it belongs to a batch that never landed, and is given up on.
- **An outbox.** Edits are written to IndexedDB first and sent in batches of up to 100 entries, so a flaky connection never loses an edit and ten quick edits cost one request. Offline edits are kept and sent when the connection returns. A record the store refuses is kept on the device and retried, and does not hold back the edits queued behind it. Tabs share the device copy: an edit waiting in one tab's outbox is sent by that tab, and taken over by another only once that tab has closed (tracked with Web Locks), so an older edit from one tab never overwrites a newer one from another.
- **Files never go to KV.** Attachments live at `attachments/<transaction id>/` and backups at `backups/` in the user's Puter drive.
- Reconciliations store the ids and amounts they cleared, so finishing one never rewrites hundreds of transactions, and later edits show up as discrepancies.

## Development

```sh
npm install
npm run dev      # http://localhost:5181/ (real Puter sign-in)
                 # http://localhost:5181/mock.html runs on an in-memory Puter stand-in
                 #   add ?reset to start over, ?env=app to simulate running inside Puter
npm test
npm run build
```

`dev/viewports.html?path=home` shows the app at phone and tablet widths side by side.

## Tests

`tests/` covers the logic the books depend on: money parsing, rounding and exact proration; dates and named periods; that every transaction type posts balanced entries on both cash and accrual basis; open balances, applications, voids and deletes; the closing date; every report (the balance sheet balances, the trial balance ties, cash flow ties to bank balances, retained earnings roll over at year end, aging buckets); CSV and OFX statement parsing and de-duplication; bank rules, matching, and suggestions; reconciliation; recurring schedules; search; validation; backup and restore; the sample company; and the sync engine (paging, the change log, gaps, the outbox while offline, and cost assertions such as "opening with nothing new costs one read").

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
