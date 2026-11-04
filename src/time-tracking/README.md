# Hourly

**Live app:** [tt.puter.com](https://tt.puter.com/)

Timesheets and time tracking. Track billable hours by client, project, or task, stored in your own [Puter](https://developer.puter.com) account.

## Features

- One-tap timer that survives reloads and can be edited while running, plus quick manual entries with smart duration parsing ("1:30", "90m", "1.5h")
- Optional start and end times on entries, derived from each other, with a soft warning when a day is double-booked
- Weekly and monthly timesheets with day-by-day breakdowns, an hours-per-day overview, and jump-to-date navigation
- A weekly grid for filling in a week at once: projects down, days across, keyboard-first, with row, column, and week totals
- Search across all entries: free text plus client and billing filters
- Invoicing workflow: per-client unbilled totals, bulk mark-as-invoiced with rate locking, and a printable invoice
- Invoice branding: an optional logo and a payment-details block, both snapshotted per invoice so a rebrand never rewrites an issued one
- Payment tracking: due dates from your payment terms, full or partial payments, and one place showing what is open, what is overdue, and how late
- Invoice lines beyond tracked time: fixed fees, pass-through expenses, and discounts, with a per-line tax opt-out
- A printable timesheet behind any invoice or date range: days, tasks, and durations, with amounts and notes as toggles
- Reports over any date range, grouped by client, project, or task, with CSV export
- Rates that cascade: entry override, then project, then client, then your default
- Billing rules per client: rounding, minimum billable time, tax rate, and payment terms, each inheriting your global default
- Billing-ready rounding (round billable time up to 5/6/10/15/30 minute increments)
- Project budgets and monthly retainers with progress bars and threshold warnings
- Import history from Toggl, Clockify, or Harvest CSV exports (idempotent), clock times included
- Works offline: an installable PWA with a local mirror and a write queue that syncs on reconnect
- Picks up work from your other devices: every write reconciles with the server copy instead of overwriting it, and the tab re-reads when you come back to it
- Forgot-to-stop and forgot-to-start safeguards, with opt-in system notifications
- Aging unbilled time: a ready-to-invoice list ordered by age, beside the invoices, with an optional monthly reminder
- Start, stop, or log without opening the app first: installed-icon shortcuts and copyable start links
- Clients and projects with per-client colors, non-billable projects, and archiving that keeps history
- Light, dark, and system theme (system is the default)
- Full JSON backup and restore, plus sample data to explore

## Stack

- Vanilla JavaScript, no frameworks
- [Puter.js](https://docs.puter.com) for auth, key-value settings, and per-month entry files
- [Lucide](https://lucide.dev) icons
- [Vite](https://vite.dev) for dev/build, [Vitest](https://vitest.dev) for tests

## Development

```sh
npm install
npm run dev        # dev server (real Puter sign-in)
npm test           # unit tests
npm run build      # production build to dist/
```

Open `/mock.html` on the dev server to run against an in-memory Puter mock
(no account needed). Query switches: `?signedout=1` shows the intro page;
`?env=app` simulates running inside Puter, where no sign-out is offered;
`?slow=800` adds latency to see the boot splash; `?offline=1` fails every
kv/fs call to exercise the offline mirror and write queue.

## URL actions

The app can be addressed from outside itself, so a home-screen icon, an OS
shortcut, or a launcher can reach an action directly:

| Link | What it does |
| --- | --- |
| `#/?action=log` | Opens the Log time sheet |
| `#/?action=stop` | Stops the running timer and logs the entry |
| `#/?action=start&project=<id>[&task=<text>]` | Starts a timer on that project |

Installed as a PWA, "Log time" and "Stop timer" also appear in the app
icon's shortcut menu. A per-project start link is on the project sheet
under "Copy start link". Every action either does the one thing it names
or says why it could not; the action is stripped from the URL before it
runs, so a reload never repeats it.

## Several devices, one account

Every document is written whole, so a write reconciles with the server
copy first rather than replacing it: records merge by id, the newest write
wins, and the ids this device last saw on the server are what tell a
delete from an addition (so a merge never resurrects deleted work, and
never drops newly created work). The tab re-reads and reconciles when it
regains focus, when the connection returns, and on a slow beat, saying so
only when something actually changed. Queued offline writes reconcile on
their way out too.

## Storage layout

Small, hot data lives in Puter KV (settings, clients, projects, the month
index, and the running timer). Entries live in one JSON file per month under
`hourly-data/`, so reads scale with the months you look at, not with the
total number of entries.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
