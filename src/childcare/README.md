# Childcare

**Live app:** [childcare.puter.com](https://childcare.puter.com/)

Free, open-source management for childcare centers, preschools, and family daycares. An open-source alternative to brightwheel, Procare, and HiMama.

It is built with vanilla JavaScript, Vite, and [Lucide](https://lucide.dev) icons. [Puter.js](https://docs.puter.com) is the only backend: there is no framework and no server of its own.

> **Early alpha.** Features may change and data could be lost. Please do not use it for real children's records or billing yet.

## Features

- **Home dashboard**
  - Who is here right now, with live staff-to-child ratios for every room.
  - Today's activity counts, plus rooms with children who have no entries yet.
  - Today's photos.
  - A "needs attention" list: children still napping, children not checked out after closing, children who have not arrived, allergy alerts, unread messages, expiring staff certifications, and overdue balances.
  - Upcoming birthdays and events.
- **Check-in**
  - One-tap check in and out, with the time recorded.
  - Check-out asks who is picking up, from the child's approved pickup list. Anyone not on the list is flagged.
  - Absences with reasons, and moving a child to another room.
  - Bulk check in and out, and correcting times afterwards.
  - Past days can be edited.
  - A **Staff** tab to clock staff in and out of rooms.
- **Kiosk mode** turns a tablet at the door into a sign-in station.
  - Families enter their 4-digit PIN and check their children in or out. Staff clock in the same way.
  - Leaving the kiosk can require the director's PIN.
- **Activities**
  - Pick children, or a whole room, and log for all of them at once. Photos are shared between the children in them.
  - Entry types: photo, meal or bottle, nap, diaper or potty, note, mood, kudos, learning observation (area, skill, progress), medication, health check, and incident.
  - Meal entries are prefilled from the week's menu.
  - Naps in progress can all be ended with one tap.
  - Any entry can be marked staff only.
- **Children**
  - A roster with enrollment status (enrolled, waitlist, inquiry, former), room, age, attendance today, allergies, and family.
  - Roster import and export as CSV.
  - Each child's page has:
    - a feed;
    - a printable **daily report** (arrival and departure, meals, naps with total sleep, diapers, notes, and photos);
    - profile and health details, with allergy warnings everywhere the child appears;
    - immunizations;
    - family and approved pickups, each with a kiosk PIN;
    - an attendance history with hours per month;
    - billing;
    - staff-only documents and notes.
- **Families**: a directory of parents, guardians, and approved pickups, with who can pick up, who to call in an emergency, who gets statements, and who uses the family app.
- **Rooms**: capacity and the required ratio for each room, with live counts and open spots.
- **Staff**
  - Rooms, contact details, and certifications with expiry warnings.
  - A weekly timecard, and invitations to the app.
- **Messages**
  - One private conversation per child, shared by the family and your staff, with photos and unread tracking.
  - Message several families at once, each in their own conversation.
  - Announcements for the whole school or for chosen rooms, with pinning.
- **Calendar**: events and closures by month, for everyone or for chosen rooms, with birthdays. Export it as an `.ics` file for any calendar app.
- **Menus**: a weekly menu that is easy to edit, copies the previous week, and prints.
- **Billing**
  - Tuition plans (weekly or monthly) with per-child prices.
  - Billing runs create a period's statements in one step and never bill a child twice for the same period.
  - Statements with line items, payments and credits, and balances. Payments are applied to the oldest statements first.
  - Receivables aging, payments collected by month, and CSV export.
- **Reports** that print cleanly and export to CSV:
  - sign-in sheets, attendance summary, absences;
  - staff hours, time clock, and certifications;
  - activity log, activities by room, meals served, incidents, and medications given;
  - allergies and medical needs, emergency contacts, family contacts, ages and birthdays, and immunizations;
  - room enrollment, and the waitlist;
  - balances and payments.
- **Family app**: when the director turns on staff and family access, families sign in with their own Puter accounts. They see only their own children:
  - today's status and the entries shared with them;
  - daily reports and photos;
  - messages, announcements, the calendar, and menus;
  - their statements.

  Families can report an absence and update health details. Each of these can be switched off in Settings.
- **Throughout the app**:
  - global search (`/` or Ctrl+K)
  - keyboard shortcuts (`?` lists them)
  - light, dark, and system themes
  - layouts for desktop, tablet, and phone
  - works offline and syncs when the connection returns
- **Demo**: explore a realistic sample center without signing in, as the director or as a family. Nothing is saved.

## Development

```sh
npm install
npm run dev      # http://childcare.puter.localhost:5173/
npm test         # unit tests (Vitest)
npm run build    # production build in dist/
```

Open `/?demo` for the director demo or `/?demo=family` for the family app, skipping the welcome screen.

## Architecture

```
src/
  main.js            boot: sign-in, invitations, demo, welcome screen
  app.js             shared runtime context and roles
  platform.js        Puter auth, environment, profile picture
  files.js           photos and documents: resizing, thumbnails, upload, cache
  team.js            staff and family access: worker deploy, worker backend, invitations
  core/              framework-free logic (unit tested)
    keys.js            KV key layout and partitions
    store.js           local-first store and sync engine
    backend.js         Puter KV and in-memory backends
    cache.js           IndexedDB snapshot cache
    attendance.js      check-in records, presence, ratios
    activities.js      activity types, logging, daily reports
    messages.js        conversations and unread state
    billing.js         accounts, aging, billing runs (integer cents)
    people.js          children, families, staff, rooms
    calendar.js        events by day, iCalendar export
    roster.js          roster CSV import and export
    sample.js          demo school
  ui/                app shell, router, dialogs, menus, search, charts
  views/             one module per screen, loaded on demand
public/worker/       school worker (deployed into the director's account by the app)
tests/               Vitest unit tests
```

### Storage design

Puter KV is backed by DynamoDB, so the layout follows DynamoDB practice: small items, writes that touch only what changed, prefix queries instead of scans, and no data that grows without bound in a single item.

| Key | Holds |
| --- | --- |
| `cc1:r:<collection>:<id>` | One record of a small collection (children, families, staff, rooms, statements...). A collection loads with one prefix `list`. |
| `cc1:r:activities:<day>:<id>` | One activity entry. A day loads with one prefix `list`. |
| `cc1:r:attendance:<day>:<id>` | One child's or staff member's day: `s-<childId>` or `t-<staffId>`, so two devices edit the same record instead of making duplicates. |
| `cc1:r:messages:<childId>:<id>` | One message in a family conversation. |
| `cc1:meta` | `{ collection: version }` for the small collections and settings. |
| `cc1:meta:d:<month>` | Versions of that month's day partitions. |
| `cc1:meta:m` | Versions of the conversations. |
| `cc1:settings`, `cc1:seq` | School settings, and statement numbers from an atomic `incr`. |

How it works:

- **Partitions:** activity logs, attendance, and messages grow every day, so they are split by day or by conversation. A screen loads only the partitions it shows.
- **Versions:** every write batch bumps the versions it touched with one atomic `incr`. KV bills by the size of the whole item, so the versions are spread over small items (one per month, one for conversations) rather than one item that keeps growing.
- **Sync:** on focus, and every 30 seconds with staff and families (two minutes alone), a device reads only the meta items it needs. It then re-reads only the collections and open partitions whose version moved.
- **Empty days are free:** a day that the meta says was never written is never listed. The feed and reports use this to skip empty days.
- **Inbox:** each conversation keeps a small summary record (last message and read times), so the inbox and unread badges never read the messages themselves.
- **Local first:** writes apply locally first, then go out in debounced batches with retry and backoff. An IndexedDB snapshot, including unsent writes and recently used partitions, makes the app open instantly and work offline.
- **Files:** photos and documents live in Puter's file system, never in KV, and records keep only a small reference. Photos are resized in the browser with `createImageBitmap` and `OffscreenCanvas`, and get a 480-pixel thumbnail for feeds. Downloaded files are cached in IndexedDB, because a file's path never changes once it is written.

### Staff and family access

Puter KV and files are private to each account, so a shared school runs through a [Puter worker](https://docs.puter.com/Workers/) in the **director's own account** (`public/worker/childcare-team-worker.js`).

- **Turning it on:** when the director turns on staff and family access, the app writes the worker to their drive and deploys it with `puter.workers.create`. It then copies the school's records and photos into it.
- **After that:** everyone reads and writes through `puter.workers.exec`, which forwards each person's own session.
- **Same layout:** the worker uses the same key layout, so the same store and sync engine run on top of it.
- **Roles:** the worker identifies the caller from their session, never from the request, and checks every request against their role:
  - **Director and admins** can do everything.
  - **Staff** work with classrooms, children, families, and messages. They cannot reach billing, tuition plans, settings, or colleagues' private details (notes, PINs, certifications), and cannot change which children a signed-up family member sees.
  - **Families** get only their own children's data. The children come from their family profile, read fresh on every request, so unlinking a child takes effect at once.
    - Staff notes, documents, other families' contact details, staff-only entries, and other children's photos never leave the worker.
    - What a family can write is merged field by field on the server: their own messages, absence reports, and the health fields the school allows.
- **Files:** uploads are multipart, not base64. A family can download a photo only through an entry it is allowed to see.
- **Server-side checks:** the worker stamps family messages with its own clock and the family member's real name, records who signed up itself, and checks kiosk PINs, so staff devices never hold PINs.
- **Invitations:**
  - Each invitation is tied to a family or staff profile.
  - The token is stored only as a SHA-256 hash, works once, and expires after 14 days.
  - An invitation stops working if the person who sent it is removed.
  - Joining always asks first, because it sends your Puter session to that school's server.
- **Updates:** when the app ships a newer worker build, the director's copy updates the next time they open the app.

### Performance notes

This is a forms, lists, and photos app, so the right tools are plain DOM, CSS, and a little SVG, not WebGL or WebAssembly. The heavy work is image processing, which runs on the browser's native decoders and `OffscreenCanvas`.

- Each screen is its own chunk, loaded on demand.
- Lucide icons are imported by name, so only the icons used are shipped.
- Live regions redraw at most once per animation frame, and only when the collections they show change.
- Photos load lazily with `IntersectionObserver` and thumbnails.
- Reports read the date ranges they need without keeping them in memory.
- All money is integer cents.

## Data and privacy

A school's data lives in the director's Puter account (KV and files). Staff and families reach it only through the school worker, which checks every request. The app has no server of its own.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
