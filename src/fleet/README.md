# Fleet

**Live app:** [fleet.puter.com](https://fleet.puter.com/)

Free, open-source fleet management for teams that run vehicles and equipment: delivery vans, pickups, trucks, trailers, forklifts, and EVs. An open-source alternative to Fleetio, Whip Around, and similar fleet maintenance software.

Built with vanilla JavaScript, Vite, [Lucide](https://lucide.dev) icons, and [Puter.js](https://docs.puter.com) as the only backend. There is no framework and no server of its own.

> **Early alpha.** Features may change and data could be lost. Please do not rely on it for real fleet records yet.

## Features

- **Dashboard.** See what needs attention: open and overdue issues, service reminders, renewals, work orders, inspection failures, and overdue scheduled inspections. It also shows a vehicle status breakdown, monthly operating costs (fuel, service, other), cost per mile, upcoming service, recent inspections, and renewals due.
- **Vehicles**
  - **Profile.** Each vehicle has a photo, VIN with check-digit validation and model year detection, plate, type, fuel type, status, group, labels, ownership, lifecycle (in-service date, expected service life, resale value), purchase and loan details, and specifications.
  - **Detail page.** An overview with open issues, reminders, renewals, open work orders, and a cost chart. Tabs show service history, inspections, work orders, issues, reminders, fuel, meter history, expenses, assignments, files, and comments.
  - **List.** Saved tabs (all, assigned, unassigned, archived), filters, a column chooser, bulk status and group changes, and CSV import and export.
- **Assignments.** Assign operators to vehicles with start and end dates and meters. Starting a new assignment ends the previous one automatically.
- **Meter history.** Readings come from fuel, service, and inspections, or are entered by hand. The app warns when a reading is lower than an earlier one or jumps suspiciously, and you can void bad readings.
- **Inspections**
  - **Forms.** A form builder with pass or fail, multiple choice (choose the passing answers), number ranges, meter, text, date, photo, signature, and section items. Items can be reordered by drag and drop or with the keyboard. A ready-made pre-trip template is included.
  - **Inspecting.** A phone-first inspection screen with large Pass and Fail targets, "pass all remaining", notes and photos on failures, meter validation, a signature pad, and a progress bar.
  - **After submitting.** Each failed item opens an issue automatically. The inspection history, item failures, and schedules show which vehicles are overdue.
- **Issues.** Record priority, assignee, due date or due meter, labels, photos, and comments. Resolve an issue with a service entry, a work order, or a note, or close it. Bulk resolve, close, and assign.
- **Service reminders.** Repeat by time, by meter, or both, whichever comes first, with due-soon thresholds. You can snooze a reminder, override the next due date or meter once, and see the completion history with on-time compliance. Service entries and work orders complete reminders automatically.
- **Service programs.** Define a maintenance schedule once (for example "Light duty maintenance") and apply it to many vehicles. Reminders stay in sync when the program changes.
- **Renewals.** Vehicle renewals (registration, insurance, emission tests) and contact renewals (driver licenses, medical cards) can repeat. Resolving one rolls its due date forward and can record its cost as an expense.
- **Work orders**
  - **Statuses and views.** Open, in progress, on hold, completed, and cancelled, shown as a list or a drag-and-drop board.
  - **Details.** Repair priority class, technician, outside vendor, and line items with service tasks, labor (hours times rate or a flat cost), parts from inventory, discount, and tax.
  - **Completing.** Completion adds the work to service history, resolves the linked issues and reminders, takes the parts out of stock, and can put the vehicle back in service.
- **Service history.** A record of every maintenance and repair, with the same line item editor, totals, vendor, and receipt photos.
- **Parts and inventory.** Parts have stock by location, aisle, and reorder point, plus low-stock alerts, stock adjustments, and where each part was used.
- **Purchase orders.** Track orders from draft to ordered to received, including partial receipts. Receiving adds stock and updates the part's unit cost.
- **Fuel and energy**
  - **Entries.** Fill-ups and EV charging. Enter any two of volume, price, and total, and the third is calculated.
  - **Economy.** Fuel economy is measured between full fill-ups, so partial fills and missed fill-ups are handled correctly. Metric fleets get L/100 km.
  - **Tracking.** Cost per mile, plus warnings for an overfilled tank or an odometer that went backwards.
- **Expenses.** Insurance, registration, tolls, parking, payments, and other costs per vehicle.
- **Contacts and vendors.** Contacts record roles, license details, labor rates, and assigned vehicles and work. Vendors show their classifications and spend history.
- **Documents.** Every photo and file attached anywhere in the fleet, in one searchable list.
- **Reports.** Operating costs, total cost of ownership, expenses by type, fuel summary, utilization, service costs, service by task, maintenance compliance, inspections (including the most failed items), issues, and inventory valuation. All reports have date ranges and group and type filters, and export to CSV and print.
- **Team access.** The owner invites drivers, members, and admins with single-use links that expire after 7 days. Each person signs in with their own Puter account. Drivers can only submit inspections, fuel, meter readings, and issues, and the team server enforces this.
- **Throughout the app**
  - global search (`/` or Ctrl+K)
  - quick add (`N`)
  - keyboard shortcuts (`?`), including `J` and `K` to move through list rows
  - a "needs attention" panel
  - light, dark, and system themes
  - layouts for desktop, tablet, and phone
  - an offline-capable app shell
- **Sample fleet.** Explore a realistic sample fleet without signing in. Nothing is saved. Signed-in users can also add the sample fleet and remove it later.

## Development

```sh
npm install
npm run dev      # http://fleet.puter.localhost:5173/
npm test         # unit tests (Vitest)
npm run build    # production build in dist/
```

Open `/?demo` to start straight in the sample fleet without the welcome screen.

## Architecture

```
src/
  main.js            boot: sign-in, demo, invitations
  app.js             shared runtime context and role checks
  platform.js        Puter auth, environment, profile picture
  files.js           attachments in the app's Puter folder
  team.js            team access: worker deploy, worker backend, invitations
  core/              framework-free logic (unit tested)
    schema.js          collections and month buckets
    store.js           local-first store and sync engine
    backend.js         Puter KV and in-memory backends
    cache.js           IndexedDB snapshot cache
    actions.js         cross-record operations (meters, service, work orders, stock)
    reminders.js       service and renewal reminder schedules
    fuel.js            economy, cost per meter, warnings
    totals.js          line items, discounts, tax (integer cents)
    inspections.js     item evaluation, schedules, starter form
    costs.js, reports.js, sample.js, format.js, dates.js, money.js, csv.js
  ui/                shell, data grid, forms, dialogs, menus, palette, charts
  views/             one module per screen, loaded on demand
public/worker/       team worker (deployed into each owner's account by the app)
tests/               Vitest unit tests and a jsdom render smoke test
```

### Storage design

Puter KV is backed by DynamoDB, so the layout follows DynamoDB practice. Items are small. A write touches only the records that changed. Reads are key lookups or prefix queries, never scans, and the app never uses secondary indexes.

| Key | Holds |
| --- | --- |
| `fl1:r:<bucket>:<id>` | One record. A bucket loads with a single paged prefix `list` that returns the values. |
| `fl1:settings` | Fleet settings (one small item). |
| `fl1:meta` | `{ bucket: version }`, bumped with an atomic `incr` after every write batch. |
| `fl1:seq` | Issue, work order, and purchase order numbers, from an atomic `incr`. |

**Buckets.** Small collections such as vehicles, contacts, parts, and issues are one bucket each (`vehicles`). Logs that grow every day are split into monthly buckets taken from the record's date (`fuel_202610`): fuel, meter readings, inspections, service entries, and expenses. If a record's date moves to another month, it moves to that month's bucket.

How sync works:

- **Changed buckets only.** A device reads `fl1:meta` (one read) on focus and on a timer, then re-reads only the buckets whose version moved. When a driver logs fuel today, other devices re-read this month's fuel, not years of history.
- **Detecting other devices.** When a device bumps a version and gets back anything other than its own last version plus one, another device wrote in between, so it refreshes that bucket.
- **Local first.** Writes apply locally first, then go out in debounced batches with retry and backoff. An IndexedDB snapshot, including writes not sent yet, makes the app open instantly and keeps it working offline.
- **Files.** Attachments live in the app's Puter folder (`files/<collection>/`), never in KV. Records keep only a small reference. Photos are downscaled in the browser before upload.

### Team access

Puter KV and files are private to each account, so a shared fleet runs through a [Puter worker](https://docs.puter.com/Workers/) in the **owner's own account**. The worker source is `public/worker/fleet-team-worker.js`.

- **Turning it on.** The app writes the worker to the owner's drive, deploys it with `puter.workers.create`, and copies the owner's records and files into it.
- **Using it.** After that, everyone reads and writes through `puter.workers.exec`, which forwards each person's own session.
- **Identity.** The worker identifies the caller from that session, never from the request body, and checks membership and role on every request.
- **Roles.**
  - Admins can manage the team and settings.
  - Members can change any fleet record.
  - Drivers can read everything but write only inspections, fuel, issues, meter readings, and comments.
- **Invitations.** Tokens are stored only as SHA-256 hashes and work once for 7 days. An invitation stops working if the person who sent it is removed. Joining always asks first, because it sends your Puter session to that fleet's worker.
- **Key layout.** The worker uses the same key layout as a single account, so the store and sync engine run unchanged on top of it.

### Performance notes

Fleet is a forms, lists, and charts app, so the right tools are plain DOM and small SVG charts, not WebGL or WebAssembly:

- **Code splitting.** Each screen is its own chunk, loaded on demand. Lucide icons are imported by name, so only the ones used ship.
- **Rendering.** Lists render a page at a time with sorting and filtering in memory. Derived values such as fuel economy, reminder status, and alerts are cached until their inputs change.
- **Live updates.** Only the affected region of a screen redraws, at most once per frame.
- **Money.** All money is stored as integer cents.

## Data and privacy

Each user's data lives in their own Puter account (KV and files). It is not shared with anyone unless the owner turns on team access, and then it stays in the owner's account. The app has no server of its own.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
