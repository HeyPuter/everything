# Shifts

**Live app:** [shifts.puter.com](https://shifts.puter.com/)

Shift scheduling for small teams: employee availability, shift assignments, swap requests, and attendance in a single, lightweight web app.

Built with vanilla JavaScript (no UI framework), [Vite](https://vitejs.dev), [Lucide](https://lucide.dev) icons, and [Puter.js](https://docs.puter.com) as the only backend. All data lives in the signed-in user's own Puter cloud key-value store; there is no server to run.

## Features

- **Schedule**: week grid (employees × days) with per-employee colors, open-shift row, availability shading, and overlap/conflict warnings. Collapses to a day list on phones. Overnight shifts wrap past midnight with a "+1" marker and correct cross-day conflict math. One tap copies last week's shifts into the current week (duplicates skipped). Shifts are dragged between cells to change their day, their assignee, or both (hold Alt to copy instead of move, drop on the open-shifts row to unassign); every move is checked, refuses a real overlap, warns about the rest, and can be undone. A Move dialog behind the same code gives keyboards (press M on a chip) and phones the same reach. "Fill open shifts" proposes someone for every open shift in the week at once, each proposal aware of the ones above it, reviewed and adjustable before a single undoable write.
- **Filter and search**: narrow the schedule by role, by person, to open shifts, or to understaffed days, and jump to somebody's row by name. The same filter applies to the week grid, the month overview, the phone day list, the printout, and the published snapshot, which says on its face that it is narrowed. Coverage, cost, hours, and conflicts keep counting the whole week, so a filtered view never hides a warning.
- **Availability and time off**: weekly windows per employee (day on/off + time range) plus date-range time-off entries that override the pattern; both feed warnings when assigning shifts or approving swaps, and time off surfaces on the dashboard.
- **Employee pages**: `#/team/:id` answers the ordinary questions about one person: hours this week and this month against target, upcoming shifts, recent attendance with the late count, time off, and their swap history. Actions sit in one place (add a shift, edit, availability, calendar export, print their week as a handout, archive), and optional phone and email become one-tap `tel:`, `sms:`, and `mailto:` links.
- **Coverage**: minimum headcount per role and weekday (optional time window); unmet requirements flag day headers, the mobile day view, and a dashboard shortlist with one-tap open-shift creation.
- **Hours guardrails**: optional target and max weekly hours per employee, with non-blocking overtime warnings in the shift editor and swap review, colored weekly totals, and a dashboard count.
- **Labor budget**: an optional weekly budget with the projected cost against it, a progress bar that turns and warns once it is crossed, and a breakdown of the week by day and by role so the overspend has an address. An optional overtime multiplier past a weekly hour threshold prices the fifth long shift before it is worked. Absent by default: a team that does not track rates sees nothing.
- **Working-time limits**: three optional numbers (minimum rest between shifts, most hours in a day, most days in a row), off by default. They warn wherever assignments are made (shift editor, swap review, copy week, repeating shifts, bulk fill), demote rather than exclude candidates in the staffing suggestions, and flag the affected row on the week grid. No jurisdiction presets, no compliance engine.
- **Swaps**: request → review → approve/decline. Approval atomically reassigns the shift; requests are validated against conflicts, availability, time off, and hour limits, and history is kept.
- **Attendance and payroll**: per-shift present/late/absent with clock-in/out times (overnight clock-outs handled), lateness computed from the schedule, weekly summary stats, and CSV timesheet export with pay-period presets and per-employee totals. One tap clocks somebody in or out from today's Attendance list or the dashboard, stamping the real minute; a late arrival sets the status itself (with an optional grace period), a manual change always stands, and shifts in progress show a ticking "on now" indicator.
- **Reports**: any date range (with the pay-period presets the timesheet export offers) as small tables: hours per employee scheduled against worked, pay per employee, cost per role, attendance and lateness, coverage gaps and open shifts nobody took. Each figure sits beside the same period before it, each table exports as CSV, and the whole page prints. Archived and former employees appear whenever they worked in the range.
- **Share and print**: publish a read-only weekly snapshot to a public link via Puter hosting (update or revoke any time), and print the week grid with a dedicated landscape print stylesheet.
- **CSV import**: bring a team or a rota in from a spreadsheet, in the same dialog as backups but kept clearly apart from the destructive restore. Columns are auto-detected and shown for confirmation, a preview lists what each row would create and what is wrong with the rows that would not work, unknown assignee names become new people or open shifts, and new role labels join the managed list. Additive, one undo, plus a "paste a list of names" shortcut for getting the team in fast.
- **Restore points**: a rolling set of ten automatic snapshots of the whole dataset, kept as files in the user's own Puter storage: one on the first change of a day, and one immediately before anything replaces the data wholesale (backup restore, sample-data load, sample-data wipe). The Backup and restore dialog lists them with their date, why they were taken, and what they hold; restoring goes through the same preview and confirmation as a file import and takes a snapshot first, so it is itself reversible. There is a manual "Snapshot now", and snapshots skip while offline rather than filling the write queue.
- **Offline**: a per-user local mirror serves reads when the network is down, writes queue and sync when connectivity returns, and a service worker keeps the installed PWA opening offline.
- **Theming**: light, dark, and system (default), no flash on load.
- **Onboarding**: a first-run welcome modal offers a guided start (add your first employee), sample data, or skip. Sample data (team, shifts, swaps, attendance) installs with a persistent banner and can be wiped with one tap to start fresh.

## Development

```sh
npm install
npm run dev        # start dev server
npm test           # run the Vitest suite
npm run build      # production build to dist/
npm run preview    # serve the production build
```

The app must be served over HTTP (Puter.js requirement); any static host works for the `dist/` output.

## Architecture

```
src/
  lib/        time, DOM, id, and icon helpers (pure, tested)
  core/       business logic + data layer
    backend.js     storage adapters: Puter KV (production) / in-memory (tests)
    store.js       state container: actions, persistence, subscriptions
    scheduling.js  validation, conflicts, availability, weekly hours
    swaps.js       swap request lifecycle and evaluation
    attendance.js  attendance records and summaries
    seed.js        sample data generator
    reports.js     period aggregation for the reports view
    csv.js         CSV reader (quoting, CRLF, BOM)
    snapshots.js   rolling restore points in the user's file storage
    import.js      column mapping and row planning for CSV imports
  ui/         app shell, router, views, editors (no framework)
tests/        Vitest suites for lib/ and core/
```

Each collection (employees, shifts, availability, swaps, attendance) is persisted as a JSON document under a namespaced key (`shifts.v1:*`) in Puter KV. The store keeps everything in memory, persists the affected collections after each action, and notifies subscribers, which re-render the active view.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
