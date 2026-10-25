# Tasks

Personal and shared to-do lists on [Puter](https://puter.com): recurring
reminders, priorities, subtasks, and calendar integration. No framework,
no backend of its own — just Puter.js and Vite.

## Features

- **Today / Upcoming / Lists / Calendar / Logbook** views in an app-like
  shell: sidebar on desktop, tab bar and floating action button on mobile.
- **Lists** with colors and icons; tasks with notes, due date and time,
  four priority levels, and subtask checklists.
- **Manual ordering**: drag tasks within a list (press-and-move with a
  mouse, press-and-hold on touch) and drag lists in the sidebar and grid;
  a per-row menu offers keyboard-accessible Move up / Move down. List
  detail follows your manual order; Today and Upcoming keep their
  date-first grouping.
- **Quick reschedule**: every open task's row menu offers Today /
  Tomorrow / This weekend / Next week / Remove date (each with Undo); on
  touch, swipe right to complete and left for the actions. The Today view
  can move all overdue tasks to today in one tap.
- **Quick add**: an inline bar on Today and in every list parses natural
  language as you type — "pay rent friday 9am every month !high #home" —
  showing removable chips for what it understood; dismissing a chip
  returns the text to the title, and nothing unrecognized is ever
  dropped. Enter adds and keeps focus for the next task; `n` jumps to it.
- **Tags**: up to five per task, editable with autocomplete in the form
  or as `#word` in quick-add (a `#word` matching a list name picks the
  list instead). Tag chips on rows open a cross-list tag view, the Lists
  page shows every tag with its open count, and search treats `#query`
  as a tag filter. Tags are derived from tasks — no orphan management.
- **Recurring tasks**: every N days/weeks/months/years, weekly rules with
  specific weekdays, rolling from the due date or the completion day.
  Completing an occurrence logs it and rolls the task forward; overdue
  repeats skip missed occurrences instead of piling up.
- **Reminders**: per-task notifications at the due time (or 10 minutes,
  1 hour, or 1 day before; all-day tasks anchor to 09:00) while the app is
  open, with missed reminders summarized on the next visit — plus an
  optional daily notification of everything due and overdue when the app
  opens. Reminders also export as alarms in the calendar feed.
- **Shared lists**: publish any list as a live, read-only link — the
  snapshot lives in the owner's Puter drive (`puter.fs.getReadURL`), is
  rewritten whenever the list changes, and can be revoked at any time;
  viewers need no account. Or **collaborate**: invite people by their
  Puter username to add, edit, and complete tasks with you. The list
  lives under its own prefix in the owner's KV store, shared with each
  member through a Puter KV share; their app finds it on its own (no link
  to pass around), changes arrive live, and the owner can remove anyone,
  which cuts their access right away. Where KV shares aren't available,
  collaboration falls back to linked replicas with a two-link handshake.
- **Calendar integration**: a month view inside the app, one-click `.ics`
  download, and a live `.ics` feed URL that Google/Apple Calendar can
  subscribe to.
- **Multi-device**: the app refetches on focus and merges by task id
  (newer edit wins, deletions carry tombstones), so a phone and a desktop
  tab can be open at once without overwriting each other. Import/wipe
  replace the dataset everywhere instead of merging back.
- **Offline & installable**: a build-generated service worker precaches
  the app shell, so a previously visited app launches with no connection
  (data comes from the local mirror, writes queue and flush on
  reconnect); updates surface as a "new version ready" toast. Installs as
  a PWA on desktop and mobile.
- **Dark / light / system** themes (system is the default), offline reads
  with automatic retry of failed writes, JSON export/import, sample data
  onboarding.

## Storage design

| Where | What | Why |
| --- | --- | --- |
| `puter.kv` `tasks:settings:v1` | preferences | small, hot |
| `puter.kv` `tasks:lists:v1` | lists | small, hot |
| `puter.kv` `tasks:items:v1` | open + recent tasks | one read per boot |
| `puter.kv` `tasks:collab:<id>:*` | collaborative lists (meta, one key per task and per deletion) | shared with members via `puter.kv.share` |
| `puter.fs` `tasks-data/log-YYYY-MM.json` | archived completions | grows unbounded |
| `puter.fs` `tasks-data/shares/<id>.json` | shared-list snapshots | must be readable by others |
| `puter.fs` `tasks-data/tasks.ics` | calendar feed | read by calendar apps |

Completions older than 30 days are archived to monthly files on boot, so
the hot KV document stays small forever. A localStorage mirror provides
instant boots and offline reads; failed writes are flushed when the
connection returns.

## Development

```sh
npm install
npm run dev      # http://localhost:5174 (real Puter SDK)
npm test         # vitest unit tests
npm run build    # production build in dist/
```

To work on the UI without a Puter account, open
`http://localhost:5174/dev/mock.html` — an in-memory mock of the SDK.
Variants: `?signedout` shows the intro page, `?env=app` simulates running
inside the Puter desktop (hides the sign-out row), `?kvshare` adds
owner-side KV shares so inviting by username can be tried (`?kvshare=deny`
refuses the consent prompt).
`dev/phone.html` previews mobile widths side by side.

## Notes on the sharing model

Read-only links use the filesystem: the owner writes a public JSON
snapshot of the list and hands out a tokenized read URL. That gives
viewers a live read-only copy, no account needed.

Multi-writer lists use KV shares. Turning collaboration on asks once for
consent to share the `tasks:collab:` prefix, then copies the list under a
fresh `tasks:collab:<id>:` prefix: `meta` (name, icon, color, owner),
`t:<taskId>` per task and `d:<taskId>` per deletion, so concurrent edits
to different tasks never overwrite each other. Each invited username gets
a `write` share of that prefix. Members find shares with
`puter.kv.listShared()` at startup (and from the `kv.share.received`
notification while open), and every app merges the prefix with its local
copy using the commutative rules in `src/lib/merge.js`. Changes arrive
through `puter.events` subscriptions, with focus and a 60-second poll as
fallback. Removing a member or stopping collaboration is
`puter.kv.unshare()`; a member whose share stops working keeps the list
as a private copy. Each user pays for their own reads and writes.

Older SDKs, and deployments with KV shares turned off, fall back to linked
replicas: each member publishes a replica file in their own drive, a
manifest in the owner's drive lists the replica URLs, and joining is a
two-link handshake. Lists already collaborating that way stay on it; to
move one to username invites, stop collaborating and invite again. Known
limits of linked replicas: minted URLs live for a year, and a removed
member keeps read access to URLs they already hold until those expire.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
