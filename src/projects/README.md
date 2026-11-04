# Project Management

**Live app:** [projects.puter.com](https://projects.puter.com/)

Lightweight project management on [Puter](https://puter.com): kanban boards, timelines, milestones, assignees, comments, and attachments. Think Trello or Asana, not enterprise Jira.

Built with vanilla JavaScript and [Puter.js](https://docs.puter.com) — no frontend framework, no backend of our own. Every byte of your data lives in your own Puter account.

## Features

- **Kanban board** — drag and drop cards and columns (long-press on touch), inline task composer, labels, priorities, due-date badges, and per-column "done" semantics
- **Quick add** — type `Ship the beta !high #design @maya friday` in any composer and the date, priority, label, and assignee are captured as live chips (each with a "keep as text" escape); a global Quick add captures into any project and column without navigating first
- **Saved views** — name the filter, sort, and grouping you set up and it becomes a chip above the filter bar (and an entry in the command palette): rename, reorder, or delete it in a dialog, and reopening a project restores the view you were last looking at. Overdue, High priority, and Unscheduled are built in and need no setup; a view whose label was since deleted says "1 filter no longer applies" instead of quietly showing nothing
- **Filter and search** — a board filter bar (title match plus label, assignee, priority, and due facets) and a cross-project search over titles *and* content: descriptions, checklist items, comments, and attachment names, each result saying where it matched and showing the line it matched in, with a "titles only" scope for when that is the question
- **Timeline** — a Gantt-lite view of every dated task grouped by column, with milestone markers, a today line, weekend shading, and an unscheduled backlog; drag a bar to reschedule, drag its edges to change start or due, drop a backlog task on a day to date it (Alt+arrows do the same from the keyboard)
- **List** — every task in one dense table: sort by title, column, due date, priority, or last change (three clicks on a header returns to board order), group by column, assignee, milestone, or due bucket, edit column/due/priority inline, and multi-select (with shift-click ranges) for bulk moves, dates, priorities, labels, assignees, milestones, duplication, archiving, and deletion — each with an Undo
- **Project brief** — a Markdown overview on the project itself: what it is for, what "done" means, where the spec and the files live. Collapsed to two lines above the board (remembered per project), expandable, editable in place, summarized on the home cards, and carried through duplication, templates, and backups
- **Column settings** — an optional WIP limit per column (the header reads `6 / 4` in a warning tone; nothing is ever blocked), a one-shot "sort this column" by due date, priority, or title with an Undo, and on done columns an "archive tasks after N days" rule applied when the project opens, which says what it archived and offers it back
- **Milestones** — dated targets with progress bars and expandable task lists
- **Tasks** — description, start/due dates, priority, milestone, multiple assignees, labels, checklists, threaded comments, and file attachments — uploaded, or **linked from your Puter Drive** so there is one copy of the truth (a link that breaks says so instead of failing quietly)
- **Reminders** — an optional "remind me" on a task (on the due date, or 1/2/7 days before) that surfaces as a toast while the app is open, a system notification when it is not (permission is asked for in Settings, never on load), and a count in the tab title that needs no permission at all; each fires once a day at most. For notifications that do not need the app running at all, export a calendar file
- **All tasks** — the list view over every project: filter, sort, and group across boards (by project, by column *name*, by assignee, by milestone, or by due bucket), with the label and assignee facets unioned by name and the project shown when a name spans several. Bulk due, priority, duplicate, archive, and delete work across projects; the moves that only mean something inside one (column, label, assignee, milestone) are shown disabled, with the reason
- **Today** — one cross-project agenda of dated, unfinished work grouped into Overdue, Today, This week, and Later, with a checkbox that finishes a task in its own project, and a sidebar count
- **Recurring tasks** — a repeat rule (daily/weekly/monthly, every N) that materializes the next occurrence when the task reaches a done column, with a catch-up pass on project open
- **Markdown** — briefs, descriptions, and comments render a safe subset (headings, lists, quotes, code, bold, italic, links); click to edit the plain Markdown behind them
- **Checklists** — the step below a card: add with Enter, tick, rename, reorder (drag or Alt+arrows), with progress on the card badge
- **Project list** — pin the projects you live in to the top, drag (or Alt+arrow) the rest into the order you want, and filter by name once there are more than eight; the sidebar, the home grid, and the command palette all show the same arrangement
- **Members and labels** — lightweight, per-project; assignees are whoever you plan work for
- **Linkable tasks** — every task has its own URL (`#/p/<id>/t/<taskId>`), so it survives a reload, can be copied from the sheet, and Back dismisses the sheet instead of leaving the board
- **Keyboard** — `⌘/Ctrl+K` opens a command palette that jumps to a project, switches view, runs an action, or finds a task; `n` new task, `N` new project, `g` then `b`/`l`/`t`/`m` for the views, `j`/`k`/`e` to walk and open tasks, `/` to search, `?` for the full list (also in Settings)
- **Mobile navigation** — below 900px the sidebar becomes a slide-in drawer opened from a hamburger in every view header: the same project list, Today count, actions, Settings, and account row, from the same render function
- **Dark, light, and system themes** (system by default), fully responsive, keyboard-accessible board (Alt+arrows moves the focused card)
- **Calendar file** — an `.ics` of every dated, unfinished task and every milestone, for this project or all of them: all-day events (dates here have no time of day), with stable UIDs and a moving `SEQUENCE`, so re-importing updates your calendar instead of triplicating it. Downloaded, or saved over the same file in your Drive. A snapshot, not a published feed
- **Export for people** — one project as **Markdown** (brief, milestones, then tasks by column with their dates, priority, assignees, labels, and checklists), as **CSV** (one flat row per task, for a spreadsheet), or printed: `⌘P` on a board, list, or timeline gives a page with no chrome, columns that break cleanly, ink-friendly timeline bars, and the project and date in a header. Exports respect the filter on screen and say so — "5 of 15 tasks (filter applied)"
- **Backup and restore** — export everything (or one project) as a `.zip` that includes attachment blobs, or plain JSON; save it straight to your Puter Drive instead of `~/Downloads`; import a backup back in as new projects, never overwriting what is there
- **Import from elsewhere** — a **Trello** board's JSON (lists → columns, cards → tasks, labels, members, checklists, card comments, archived cards → the archive, attachments as links to Trello rather than copies) or a **CSV** from Asana or any spreadsheet, with header auto-detection, a column picker with sample values, and a preview of exactly what will come across — and the same account of it afterwards. Always a new project
- **Duplicate and templates** — copy a task, copy a project with or without its tasks, and save any project's structure as a template the new-project form can start from
- **Archive** — retire finished tasks (one at a time, or a whole done column) and completed projects without deleting them; archived work stays out of every board, count, and timeline
- **Restore points** — the first change to a project on any day leaves a copy behind (about 7 daily and 4 weekly are kept, then pruned), listed in Settings and the project menu; restoring takes a copy of the current state first, so it is itself reversible, and a project whose sidebar entry was deleted comes back with it
- **Undo and redo** — `⌘/Ctrl+Z` walks back the gestures a board is made of (a card dragged or Alt+arrowed to another column, a timeline bar rescheduled or resized, a backlog task dated, an inline due date or priority, a bulk list edit, a one-shot column sort, a renamed column, a moved checklist item), `⇧⌘/Ctrl+Z` puts them back, and both say what they did — "Undid move of "Billing page copy review" to Done". Per project, per session, 50 deep, and cleared whenever the ground moves under it (a conflict, a restored snapshot, replayed offline work, or leaving the project)
- **Undo and trash** — deletes show an Undo toast; deleted tasks and projects sit in a trash for 30 days, restorable from the project menu and Settings
- **Offline and installable** — a web app manifest and a service worker that caches the shell (and the Puter SDK), so the app starts with no connection; every project is mirrored to IndexedDB as it is saved, so work survives a closed tab and reads fall back to the last version this device saw, clearly labelled; unsent changes queue and replay when the connection returns, still checking that nothing changed underneath
- **Sample data** — one-click explorable project on first run, wipeable at any time

## Storage design

| Where | What |
| --- | --- |
| Puter KV | Settings, the project index, templates, and saved views (small, hot, single-key reads) |
| Puter FS | One JSON document per project, plus attachment blobs and daily restore points |

Reads scale with the projects you open, not the total number of tasks. Mutations are optimistic: the UI updates instantly, a debounced write persists the document, and failed writes surface a retry toast.

The service worker caches the app shell only — never a byte of anyone's data, because a stale document served silently would be worse than an error. Data has its own mirror in IndexedDB, which the app labels as offline when it shows it.

Two windows on the same account cannot silently overwrite each other. Same-browser tabs announce their writes over a `BroadcastChannel`; across devices, every save first checks that the file is still the one this window loaded (`puter.fs.stat`) and stops if it is not, offering Reload, Keep mine, or a download of the local copy. The project index is merged by id rather than clobbered, so two windows creating projects at once both keep theirs.

## Development

```sh
npm install
npm run dev          # Vite dev server
```

Open `http://localhost:5174/mock.html` to run against an in-memory Puter stub (no account needed; state persists per browser session). Add `?signedout` to exercise the intro page. The real entry point, `index.html`, loads the live Puter SDK.

```sh
npm test             # vitest unit tests (board logic, dates, store, sample data)
npm run build        # production build to dist/
npm run icons        # regenerate public/ icons from icon.png (needs ImageMagick)
```

`icon.png` at the repo root is the only icon that is drawn by hand. Everything
in `public/` — the favicons, the `.ico`, the Apple touch icon, the manifest
sizes and the maskable variant — comes out of `scripts/build-icons.sh`, so
replacing that one file and rerunning `npm run icons` re-skins the app. The
brand colour in `src/styles/tokens.css` is the icon's own hue, darkened for
light mode so it can carry text and hold white on top of it.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
