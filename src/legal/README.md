# Legal

**Live app:** [legal.puter.com](https://legal.puter.com/)

Free, open-source legal practice management for solo lawyers and small firms. An open-source alternative to Clio, MyCase, and PracticePanther.

Built with vanilla JavaScript, Vite, [Lucide](https://lucide.dev) icons, and [Puter.js](https://docs.puter.com) as the only backend. There is no framework and no server of its own.

> **Early alpha.** Features may change and data could be lost. Please do not use it for real client matters, trust funds, or billing yet.

## Features

- **Dashboard.** Personal view with today's agenda, overdue tasks, billable hours against your monthly target, recent matters with one-click timers, and upcoming deadlines. Firm view with hours by person, receivables aging, and billing totals.
- **Matters.**
  - Numbered automatically (`00012-Lopez`, `00012`, or `2026-00012`), with client, responsible and originating lawyers, staff, practice area, stage, status, open, pending and closed dates, statute of limitations, tags, and related contacts (opposing parties, counsel, judges, witnesses).
  - Billing preference per matter: hourly with an optional matter rate, flat fee, or contingency, plus a budget and a minimum trust balance.
  - Each matter is a workspace with tabs for its dashboard (work in progress, outstanding balance, trust funds, budget), activities, calendar, communications, notes, documents, tasks, bills, trust transactions, and contacts.
  - A stages board shows open matters by stage per practice area, with drag and drop.
- **Contacts.** People and companies with multiple emails, phones, and addresses, CSV import and export, and a page for each contact showing their matters, bills, communications, and notes.
- **Conflict checks.** Search every contact and every party on every matter by name, email, or phone (accent and case insensitive), see each match's role on each matter, and save the result as a note for the file.
- **Time and expenses.**
  - A timer in the top bar that keeps running across reloads (Shift+T), with matter and description.
  - Time entries accept `1.5`, `1:30`, `1h 30m`, or `90m`, and are rounded up to the firm's billing increment (tenths of an hour by default).
  - Rates come from the matter, then the person, then the firm default. Expense and flat fee entries are supported too.
  - The activities list filters by type, period, person, matter, and billing status, with totals and bulk edits.
- **Billing.**
  - Generate draft bills for many matters at once from their unbilled work in a period.
  - Bills move from draft to pending approval to issued. Drafts can be edited line by line, with discounts and tax.
  - Bills print or save as PDF. Issued bills track payments, partial payments, and overdue status.
  - Voiding a bill returns its work to unbilled.
  - Outstanding balances per client with aging buckets, and printable client statements.
- **Trust accounting.**
  - Operating and trust bank accounts. Every movement of money is a ledger transaction, and balances are always computed from those transactions.
  - Trust deposits, withdrawals, transfers to operating, and paying bills from trust.
  - A matter's trust balance can never go below zero.
  - Per-matter trust ledgers, low balance alerts against each matter's minimum, and a three-way reconciliation check.
- **Calendar.**
  - Day, week, month, and agenda views, with event types such as court dates, deadlines, meetings, and calls.
  - Drag events to move them and drag their edge to resize, with undo. The keyboard works too.
  - Layers per firm user, plus layers for task due dates and statute of limitations dates.
- **Tasks.** Due dates, priorities, assignees, and matters. Overdue highlighting and bulk actions. Task list templates create a whole checklist on a matter in one step, assigned by role.
- **Documents.**
  - Upload files to a matter (drag and drop), with categories and a preview for PDFs, images, and text.
  - Document templates with merge fields (`{{client.name}}`, `{{matter.number}}`, and more) generate letters straight into the matter.
- **Communications.** Log phone calls, emails, meetings, and internal messages on a matter. Optionally record the time spent as a time entry in the same step.
- **Reports.** Revenue billed and collected, receivables aging, client ledgers, billable hours and utilization by person, activity by category, matters by practice area and stage, new and closed matters, matter profitability, and trust balances. Each report has a chart, a table, CSV export, and print.
- **Firm users and team sign-in.** Firm users carry roles, hourly rates, monthly targets, and calendar colors. The owner can invite colleagues with single-use links so everyone works on the same firm with their own Puter account.
- **Throughout the app:**
  - global search and command palette (`/` or Ctrl+K)
  - a Create new menu (`N`)
  - keyboard shortcuts (`?` lists them)
  - alerts for overdue tasks, statute of limitations dates, low trust, and overdue bills
  - light, dark, and system themes
  - layouts for desktop, tablet, and phone
  - works offline and syncs when back online
- **Sample firm.** Explore a realistic sample law firm without signing in. Nothing is saved.

## Development

```sh
npm install
npm run dev      # http://legal.puter.localhost:5173/
npm test         # unit and view tests (Vitest)
npm run build    # production build in dist/
```

Open `/?demo` to go straight to the sample firm without the welcome screen.

## Architecture

```
src/
  main.js            boot: sign-in, sample firm, welcome screen
  app.js             shared runtime context
  platform.js        Puter auth, environment, profile picture
  files.js           document files in the app's Puter folder
  team.js            team sign-in: worker deploy, worker backend, invitations
  core/              framework-free logic (unit tested)
    store.js           local-first store and sync engine
    backend.js         Puter KV and in-memory backends
    cache.js           IndexedDB snapshot cache
    finance.js         time values, bills, payments, trust ledger rules
    duration.js        parsing and rounding time entries
    matters.js         matter numbers, conflict search, task list templates
    merge.js           document template merge fields
    derive.js          memoized grouping over collections
    search.js          global search index
    sample.js, settings.js, dates.js, money.js, format.js, csv.js
  ui/                shell, router, dialogs, menus, timer, palette, charts
  views/             one module per screen, loaded on demand
public/worker/       firm server, deployed into each owner's account by the app
tests/               Vitest tests
```

### Storage design

Puter KV is backed by DynamoDB, so the layout follows DynamoDB practice: small items, writes that touch only what changed, and prefix queries instead of scans. There are no secondary indexes, so every lookup the app needs is either a direct key or one collection prefix.

| Key | Holds |
| --- | --- |
| `lg1:r:<collection>:<id>` | One record. A whole collection loads with a single paged prefix `list` (values included). |
| `lg1:settings` | Firm settings (one small item). Lists that grow, such as users and templates, are collections of their own. |
| `lg1:meta` | `{ collection: version }`, bumped with an atomic `incr` after every write batch. |
| `lg1:seq` | Matter and bill numbers, from an atomic `incr`. |
| `lg1:workspaces` | Which firm this person is working in (their own or one they joined). |

How sync works:

- **Changed data only:** when the tab regains focus, and every two minutes, a device reads `lg1:meta` (one read) and re-reads only the collections whose version moved.
- **Detecting other writers:** when a device bumps a version and gets back anything other than its own last version plus one, another device or colleague wrote in between, so it refreshes that collection.
- **Local first:** writes apply locally first, then go out in debounced batches of up to 100 items, with retry and backoff. An IndexedDB snapshot, including writes not yet sent, makes the app open instantly and keeps working offline.
- **Files never go in KV:** documents live in the app's Puter folder (`docs/<matter>/...`). Records keep only a small reference.

### Team sign-in

Puter KV and files are private to each account, so a shared firm runs through a [Puter worker](https://docs.puter.com/Workers/) in the **owner's own account**. Its source is `public/worker/legal-team-worker.js`.

- **Turning it on:** when the owner turns on team sign-in, the app writes the worker to their drive and deploys it with `puter.workers.create`. It then copies the firm's records and document files into it.
- **After that:** everyone, owner included, reads and writes through `puter.workers.exec`, which forwards each person's own session.
- **Access checks:** the worker identifies the caller from that session, never from the request body, and checks membership on every request. Managing the team requires the owner or an admin.
- **Invitations:** tokens are stored only as SHA-256 hashes, work once, and expire after 7 days. They stop working if the person who sent them is removed.
- **Joining asks first:** joining sends your Puter session to that firm's worker, so the app always asks before joining.
- **Same key layout:** the worker uses the same KV layout as a single account, so the store and sync engine run unchanged on top of it. The owner pays for the storage, and the data stays in their account.

### Performance notes

This is a records, forms, and calendar app, so the right tools are plain DOM, CSS, and SVG rather than WebGL or WebAssembly, which would add weight without making anything faster here. What matters is how much work each interaction does:

- **Windowed tables:** large lists (time entries, matters, contacts, bills) render only the rows in view, so twenty thousand entries scroll like twenty.
- **Code splitting:** each screen and its stylesheet is its own chunk, loaded on demand.
- **Icons:** Lucide icons are imported by name, so only the ones used ship.
- **Memoized lookups:** per-matter and per-contact data is grouped once per change (keyed on the store's cached arrays), so matter pages and list columns are O(1) lookups instead of scans.
- **Search:** the palette's searchable text is prepared once per change of each collection.
- **Redraws:** live regions redraw at most once per animation frame and only for the collections they depend on.
- **Money:** all amounts are integer cents, and all dates are plain `YYYY-MM-DD` strings, which avoids timezone drift.

## Data and privacy

Each firm's data lives in its owner's Puter account (KV and files). The app has no server of its own. In a shared firm, colleagues reach the owner's data only through the owner's firm server, which checks membership on every request.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
