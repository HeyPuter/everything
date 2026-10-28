# Calendar

A modern, minimal calendar web app. Vanilla JavaScript (no framework), built with
Vite, and backed entirely by **[Puter.js](https://developer.puter.com/)** for
authentication and storage — no server of your own to run, and every user's data
lives in their own Puter storage.

<p align="center"><em>Month · Week · Day · List views, with light &amp; dark themes.</em></p>

## Screenshots

<p align="center">
  <img src="public/screenshots/screenshot-month.png" width="82%" alt="Month view with color-coded events" />
</p>
<p align="center">
  <img src="public/screenshots/screenshot-week.png" width="49%" alt="Week view with overlapping events and a live time indicator" />
  <img src="public/screenshots/screenshot-editor.png" width="49%" alt="Event editor with recurrence and reminders (dark theme)" />
</p>
<p align="center">
  <img src="public/screenshots/screenshot-day.png" width="49%" alt="Day view timeline" />
  <img src="public/screenshots/screenshot-search.png" width="49%" alt="Search across all your events" />
</p>
<p align="center">
  <img src="public/screenshots/screenshot-import-export.png" width="62%" alt="Import and export as iCalendar or JSON (dark theme)" />
</p>

<p align="center"><em>…and fully responsive on mobile</em></p>
<p align="center">
  <img src="public/screenshots/screenshot-mobile-agenda.png" width="30%" alt="Agenda list on mobile" />
  <img src="public/screenshots/screenshot-mobile-day.png" width="30%" alt="Day view on mobile (dark theme)" />
  <img src="public/screenshots/screenshot-mobile-editor.png" width="30%" alt="Editing an event on mobile" />
</p>

## Features

- **Four views** — Month, Week, Day, and a grouped List/agenda, each tuned for the
  screen size it runs on.
- **Full event management** — create, edit, duplicate, and delete events with title,
  time or all-day, location, description, and a nine-color palette.
- **Recurring events** — daily, weekly (any weekdays), monthly (by date or weekday),
  yearly, or a custom interval, ending never / on a date / after N occurrences. Each
  occurrence renders individually; edit or delete *this event*, *this and following*,
  or the *entire series*, with per-occurrence exceptions.
- **Overlap-aware week/day grid** — concurrent events are laid out side by side, with
  a live "now" indicator and click-to-create on any time slot. Drag an event to
  reschedule it, or drag its top/bottom edge to resize (snapped to quarter-hours).
- **Search** — a command-palette overlay (header button, `/`, or ⌘/Ctrl‑K) finds
  events by title, location, or description and jumps straight to them.
- **Reminders** — attach one or more "notify me N before" reminders to a timed
  event; a scheduler fires a browser notification ahead of each occurrence.
- **Public holidays** — pick a country (or let the browser's time zone pick one)
  and the month, week and agenda views gain a quiet, read-only holiday layer.
  Computed from rules rather than fetched, so every year works offline and
  nothing is written to your storage. See [Public holidays](#public-holidays).
- **Clock changes** — the days the clocks go forward or back are marked, for
  whatever zone the browser is in: correct in New York, Berlin and Sydney
  alike, and silent in Tokyo. Derived from the zone itself, never a table of
  dates. See [Clock changes](#clock-changes).
- **Import &amp; export** — back up every event to an iCalendar (`.ics`) or JSON file,
  and import events from an `.ics`/`.json` file. Recurring series round-trip via
  `RRULE`/`EXDATE`, including per-occurrence exceptions.
- **Context menus** — right-click an event or an empty slot. Uses Puter's native
  `puter.ui.contextMenu` inside the Puter desktop, with a pixel-matched,
  keyboard-navigable fallback for standalone web deployments.
- **Guest suggestions from your address book** — inside the Puter desktop, typing a
  name into an event's guest field suggests people from the
  [Contacts](https://contacts.puter.com) app, so you don't have to remember anyone's
  email address. See [Contacts integration](#contacts-integration).
- **Emailed invitations with self-serve RSVP** — every guest gets a personal
  Yes / No / Maybe link; saving an event offers to mail it to them, with the event
  attached as an `.ics`. Answers come back into the calendar on their own. Guests
  need no Puter account, and no calendar of their own. See
  [Invitations &amp; RSVP](#invitations--rsvp).
- **Booking links (Calendly-style)** — share a link that lets anyone book time
  with you. You set the meeting length, weekly hours, buffers, notice and
  booking window; the page offers only slots your calendar is actually free
  for, in the visitor's own time zone. Bookings land on your calendar as
  events, both sides get confirmation email, and either side can cancel with
  notice. See [Booking links](#booking-links).
- **Meeting links (Google Meet-style)** — one click in the event editor puts a
  [Puter Meetings](https://meetings.puter.com) video-call link on the event.
  It shows as **Join meeting** on the details card, rides along in invitation
  emails and the attached `.ics`, and never expires — one link serves a whole
  recurring series. See [Meeting links](#meeting-links).
- **An API other apps can use** — inside the Puter desktop, another app can read and
  write the user's events over an `AppConnection` instead of keeping a calendar of
  its own. See [App-to-app API](#app-to-app-api).
- **Categories** — toggle event colors on and off from the sidebar, and rename any
  of them: the pencil on a row turns “Violet” into “Family”, in the sidebar and in
  every color picker. The color itself, and everything keyed on it, is untouched.
  The list sits at the foot of the sidebar, under the booking links.
- **A sidebar that folds** — **Booking links** and **Categories** each fold away
  from their own heading, and the fold is remembered per user. A shut heading
  still reports what its section is doing: how many categories the filter is
  hiding, how many links are no longer taking bookings.
- **Responsive** — a sidebar drawer and bottom tab bar on mobile; a full three-pane
  layout on desktop.
- **Themable** — automatic (OS), light, or dark; plus Monday/Sunday week start and
  12/24-hour time. Preferences are persisted per user.
- **Keyboard shortcuts** — `t` today · `y`/`m`/`w`/`x`/`d`/`a` switch views (year, month,
  week, 4 day, day, list) · `n` new event · `/` or `⌘`/`Ctrl`‑`K` search · `←`/`→` navigate ·
  `Esc` closes whatever is open.
- **Accessible & fast** — semantic roles, focus management, reduced-motion support,
  and a compact, dependency-free bundle.

## Powered by Puter.js

Puter is the only backend. It is loaded from the CDN in `index.html`:

```html
<script src="https://js.puter.com/v2/"></script>
```

| Concern | Puter API |
| --- | --- |
| Sign-in / sign-out / current user | `puter.auth` |
| Event & settings storage | `puter.kv` (one key per event under `cal:evt:`, settings under `cal:settings`) |
| Right-click menus | `puter.ui.contextMenu` (with a local fallback) |
| Guest suggestions from Contacts | `puter.ui.launchApp` + [`AppConnection`](https://docs.puter.com/Objects/AppConnection/) |
| Serving the calendar to other apps | `puter.ui.parentApp()` + the same `AppConnection` |
| Guest RSVP links + booking pages | `puter.workers.create` (a worker per user, in their own account) |
| Emailing invitations | `puter.workers.exec` + `puter.email.sendTransactional` (billed to the sender) |
| Reading the user's mailbox | `puter.email.list` / `puter.email.get` (parsed messages, no MIME code of our own) |
| Answering an invitation by email | `puter.email.send` from the user's own `@puter.email` address |
| Noticing mail while the app is closed | `puter.events.onPersistent` + `puter.events.handlers` (a handler published against the app) |

There is no API key to manage — Puter uses a "user pays" model, so each signed-in
user's events are stored in and billed to their own account.

## Contacts integration

Inside the Puter desktop, the guest field reads the user's own address book from
the [Contacts](https://github.com/HeyPuter/contacts) app rather than keeping its
own. `src/js/contacts.js` launches Contacts in service mode — no UI, and
`background: true` so the desktop never puts a window on screen — then talks to it
over the `AppConnection` that `puter.ui.launchApp` returns:

```js
const contacts = await puter.ui.launchApp({
  name: 'contacts',
  args: { service: 'contacts-api' },
  background: true,
})
contacts.postMessage({ $: 'contacts-api', v: 1, id: '1', method: 'list', params: { limit: 1000, offset: 0 } })
```

Contacts only answers apps on its own allowlist, and identifies the caller from
the app name the desktop stamps on the window it launched — so this works because
we really are `calendar`, not because we say we are. That grant is read-only:
suggesting someone as a guest is no reason to be able to rename or delete them,
and the calendar has never written a contact.

Launching another app is the expensive part, so the client does it as rarely as
it can. It reads the directory — names, addresses, and companies, nothing else,
paged so a big address book arrives whole — keeps that snapshot in `localStorage`
scoped to the account, and matches locally — one entry per address, so two people
who share a mailbox are offered once rather than as two rows that add the same
guest. Most sessions therefore launch nothing at all. Signing out clears the
snapshot along with the offline calendar and closes the service window. The rest
of the read API is available through the same client (`search`, `get`) for
anything that needs live data.

**Keeping it current.** A cached address book is only as good as its
invalidation, and this one cannot rely on being told: Contacts' `changed` notice
comes from the instance *we* launched, which is a different process from the
window the user edits their contacts in. So the snapshot is re-read at the
moments where a stale copy would be felt, none of them in the typing path — when
the calendar opens or is brought back to the front, when the event editor opens,
when the guest field is focused while empty, and after a query finds nobody or
the user types in an address we have never seen. Reads are throttled, an old
snapshot keeps answering until a fresh one lands, and the field re-renders when
it does. An *empty* snapshot is trusted for only a minute rather than an hour —
"nobody yet" is the answer most likely to change, because a brand-new user is
usually about to import their address book. Suggestions come off the snapshot
rather than the connection, so a Contacts app that is briefly unreachable costs
nothing.

This is strictly an enhancement. On the open web there is no desktop to launch
anything into, and Contacts may not be installed or reachable; in every one of
those cases the guest field is exactly what it was before — type an email address
and press Enter. `background` needs a Puter desktop that supports it; an older one
ignores the flag and shows a window, which Contacts then hides itself.

## Invitations &amp; RSVP

A guest usually has no Puter account, so they cannot be handed a key to the host's
`puter.kv`. Two serverless [Workers](https://docs.puter.com/Workers/) close that
gap — deployed by different people, on purpose:

| Worker | Source | Deployed | Runs in the account of |
| --- | --- | --- | --- |
| RSVP endpoint | `src/workers/rsvp-worker.js` | by the app, on the host's first event with guests | the **host** — `cal-<username>.puter.work`, one per user |
| Email sender | `src/workers/email-worker.js` | by you, once, by hand | the **app owner** — `calendar-email.puter.work`, one for everyone |

**Answering.** The RSVP worker mints each guest an unguessable capability URL
(`/rsvp/<token>`) and stores only its hash, so a leak of that worker's storage
yields no working link. Opening one lands on `public/rsvp.html` — hosted with the
app, not by the worker — which renders the invitation from the worker's JSON API;
`/rsvp/<token>/accept` (and `decline`, `maybe`) answer in one click straight from
an email. Answers are pulled back and merged into the host's calendar by
`src/js/rsvp-links.js`.

**Sending.** `src/js/invites.js` hands those links to the email worker through
[`puter.workers.exec()`](https://docs.puter.com/Workers/exec/), which forwards the
signed-in user's Puter token. That token is what the worker bills: **the host pays
for their own invitations**, never the app owner, even though the app owner's
worker is what authorizes the send.

Saving an event with guests asks whether to mail them, and on a yes the send
waits until the RSVP worker has minted every guest a link — a second or two on an
ordinary save, longer on the first one ever, which has to deploy that worker
first. The question is put at save time rather than when the mail goes out,
because by then the host has closed the editor and moved on. Anything other than
pressing **Send** — Escape, the backdrop, **Don't send** — sends nothing, and the
details card's **Email invitations** button covers everything afterwards: a guest
added later, an event that moved, a plain resend. The worker refuses to send a
guest an invitation it has already sent them, so a second press, a second device,
or a retry costs nothing.

Dragging or resizing an invited event offers the same update email after the
save succeeds. Undo before pressing Send prevents that offer from sending.
Edits to individual recurring occurrences also mark invitations as needing an
update; local colors and reminders do not. Booked appointments retain their
separate schedule and the warning that moving them does not notify the guest.

Every invitation names its host. The mail's Reply-To and the .ics `ORGANIZER` are
the signed-in account's email — what the guest's calendar shows as the organizer
(Google Calendar files an event without one under
`unknownorganizer@calendar.google.com`) and where their mail client's own RSVP
buttons answer. Puter withholds that address until the user allows the app to
read it, so a send that doesn't know it asks — on a press of **Email
invitations**, never from the after-save send, which the editor has just asked
for — and if there is still no address, nothing is sent and the toast says why.

**Cancelling.** Deleting an event whose guests were emailed asks one more
question — **Send cancellation emails?** — because to those guests the event is
still on until someone says otherwise. A yes mails each previously-invited guest
(including one removed from the list after being emailed) a notice with a
`METHOD:CANCEL` .ics, which is what lets their calendar retract the copy the
invitation installed. The same rule as sending applies: nothing goes out without
a press. Deleting one occurrence offers a cancellation for that occurrence
only, using the series UID and the original slot's `RECURRENCE-ID`; the other
occurrences remain on guests' calendars. Deleting **This and following events**
offers a cancellation from that original slot onward (`RANGE=THISANDFUTURE`),
preserving earlier occurrences. Deleting from the first slot cancels the whole
series. An Undo pressed before
answering prevents the cancellation email; after a cancellation has been sent,
guests need a new invitation to tell them the event is back on.

Editing **This and following events** offers one confirmation for both halves:
previously invited guests receive an update shortening the original series, and
guests on the future events receive the new schedule with its own RSVP links.
Undo before sending, including while the new links are being prepared, prevents
those pending notifications.

**Removing guests.** Saving a guest-list change offers **Notify removed guests?**
for people who previously received an invitation. Send withdraws only their
invitations; the event remains scheduled for everyone else. A guest added back
before sending is excluded. Removing guests from **This and following events**
withdraws their invitations from that occurrence onward, preserving earlier
occurrences. Failed deliveries keep their invitation records; successful full
removals clear only those guests' records so adding them again offers a fresh
invitation. Updates for remaining guests are offered separately after this choice.

Because that worker is app-owned and reachable by any signed-in Puter user, it is
not a relay: callers hand it an *event*, never a message. It composes the subject
and body itself, escapes everything the host typed, and puts no clickable link in
the mail except the guest's own `*.puter.work` RSVP URL (a cancellation carries no
link at all) — with per-request and per-user-per-day recipient caps on top. Its
storage holds only hashes: no address, event id, or title ever lands in the app
owner's account.

### Deploying the email worker

Invitations are the one feature that needs a deploy step of its own. With the
[Puter CLI](https://docs.puter.com/cli/):

```bash
npm install -g @heyputer/cli
puter login
npm run deploy:email-worker   # puter worker deploy src/workers/email-worker.js calendar-email
curl https://calendar-email.puter.work/health   # {"ok":true,"version":"11","runtime":"2.6.2+63f857ce3"}
```

The version in `/health` is `WORKER_VERSION` from the source — bump it in any
deploy that changes behavior, and check it after deploying. A deployment older
than `4` has no `/cancellations` route: deleting an invited event then reports
that the email service needs an update, and sends nothing. Older than `11` has
no `/replies`, so answering a mail-received invitation reports the same thing
when `puter.email.send` cannot carry the reply itself.

`runtime` is the puter.js build Puter baked into the worker at deploy time; it
only changes when the source is redeployed. When puter.js changes under the
worker (as `email.send` becoming `email.sendTransactional` did), bump
`WORKER_VERSION` and redeploy, then check `runtime` moved. Bump
`RSVP_WORKER_VERSION` in `src/js/rsvp-links.js` too: the app rewrites each
user's RSVP worker on their next visit and verifies it over `/admin/ping`.

If sending ever comes back `sign_in_required` from a signed-in browser, open
`/whoami` through `puter.workers.exec()`: it reports whether the session reached
the worker at all (`sawAuthHeader`), which context property it was bound to, and
whether the caller could be pinned to a person — names and booleans only, never a
token or an address. That distinguishes a browser/transport problem from a
runtime that moved the caller somewhere this worker doesn't look yet.

Re-running it replaces the code at the same URL. Forking this calendar? Deploy the
worker under a name of your own and point `EMAIL_WORKER_URL` in `src/js/invites.js`
at it. Until something answers there, a press reports that the invitation service
is unavailable — and the copy-the-links buttons carry on exactly as before, so
nothing else about the app depends on this worker existing.

## Mailbox invitations

Every Puter account has a mailbox — `<username>@puter.email`, stored as raw
messages under `~/.mail`. Connect it and an invitation that arrives there shows
up on the calendar: the message is read where it lands, its iCalendar attachment
parsed, and the event added — or held back, depending on who sent it.

**It runs while the calendar is closed.** `src/workers/mail-handler.js` is a
published [events handler](https://docs.puter.com/Events/handlers/). The app
subscribes once, with `puter.events.onPersistent()`, to
`fs:~/.mail/objects/**:add`, and Puter runs that handler in the app's events
worker whenever mail arrives — no tab open, no polling. The handler reads the
message with [`puter.email.get()`](https://docs.puter.com/Email/get/), which
parses it for us, keeps the calendar attachments, and writes a small record into
the user's own key-value store. It never writes an event: every decision about
the calendar is made in the app, where the contacts, the settings and the
recurrence engine are.

The subscription is a queue (`queue: true`), so each message is handled once
and retried if the run never finishes or fails for a temporary reason; the
handler throws with `retry: true` for those, and swallows anything else. The
page never registers the handler in-page, so an open calendar tab declines each
delivery and the events worker runs it right away.

**Only people you have already dealt with.** An invitation is added
automatically when the sender is *authenticated* — delivered inside Puter, or
carrying a DKIM signature aligned with its From domain — and *known*, meaning
you have interacted with them before: they are in your address book, on one of
your own events, someone whose invitation you accepted previously, or **someone
you have emailed from your Puter mailbox** (read once a day from the sent
folder, bounded, and kept as a list of addresses at `cal:mail:corr`).

Known but unauthenticated lands in the sidebar's **Invitations** list with
**Add**, **Ignore** and **Block**. A sender you have never interacted with shows
**nowhere at all** — no row, no toast, no count. The record is still stored, so
nothing is lost, but you have to ask to see it: the Mailbox invitations dialog
has a switch, off by default, for "Show invitations from people I haven't
interacted with". The one exception is a cancellation or a proposed new time
for an event already on the calendar: that concerns your own data, so it is
shown — a cancellation with no button to act on it unless it comes from the
event's organizer. A `@puter.email` address counts as authenticated but never as
known on that basis alone; anyone can register a username.

Who the sender is comes from the message's own `From` header, never from the
iCalendar file: an `ORGANIZER` line is just text the sender typed, so treating it
as identity would let anyone borrow the trust of whoever they name. For the same
reason a matching UID is not permission to change an event — an update only
applies when it comes from the sender whose invitation created it.

**What each iTIP method does.** `REQUEST` creates or updates the event, matched
by iCalendar UID; an update needs a higher `SEQUENCE`, or a newer `DTSTAMP` at
the same one, and keeps your own answer. A recurring invitation keeps its `RRULE`
and `EXDATE`s, and an update naming one occurrence (`RECURRENCE-ID`) changes only
that occurrence. `CANCEL` withdraws the event or the
occurrence, but only when the sender is the organizer the stored event already
names. `REPLY` updates one guest's Yes / No / Maybe on an event you host, and
only for the address that sent it. `PUBLISH` adds a plain event with no RSVP.
`COUNTER` is never applied — a proposed new time is shown for you to decide on.
`REFRESH` and `DECLINECOUNTER` are ignored. One of your own invitations coming
back through a guest's Puter mailbox is recognized and dropped silently.

**Nothing from a message is ever rendered as markup.** The HTML part is never
read at all; the handler keeps an allowlist of iCalendar properties and
parameters and caps everything it stores — message size, attachments considered,
events, line count and the length of every field. A URL from a message is shown
as text, never as a link. Two daily budgets apply, one for messages scanned and a
much smaller one for invitations recorded, so a mailbox full of newsletters
cannot crowd out the afternoon's meetings; records expire on their own.

Outlook writes time zones as `TZID="Eastern Standard Time"` and Thunderbird as
`TZID=/mozilla.org/…/America/New_York`. Since `VTIMEZONE` blocks are dropped,
`src/js/windows-zones.js` maps both spellings back to IANA names before a time is
resolved; an unrecognized zone falls back to floating local time, as it always
did.

**Answering by email.** An event that arrived by mail offers to send a real iTIP
`REPLY` to its organizer when you press Yes, No or Maybe — and only when you then
press **Send**. It goes out with
[`puter.email.send()`](https://docs.puter.com/Email/) from your own
`<username>@puter.email` (which needs write access to `~/.mail`, asked for the
first time you send one), carrying a `text/calendar; method=REPLY` attachment. It
uses the UID the organizer assigned and answers as the address they invited,
which is what lets their calendar match it to a participant. Where that cannot
carry it — an external recipient on a free plan, or an older server — the shared
email worker's `/replies` route sends it instead, composing the message itself
the way it composes every other one.

**Catching up.** `fs:` subjects keep no log, so anything that arrived while the
subscription was suspended — or before you connected — is found with
[`puter.email.list()`](https://docs.puter.com/Email/list/), newest first, down to
the last message already seen. That same scan is what runs when the calendar
cannot subscribe in the background at all: without an app identity, or without
`events:background`, the feature keeps working while the calendar is open and
says so rather than pretending.

### Deploying the mail handler

Like the email worker, this needs a deploy step of its own — a handler is
published once, by the app owner, against the app.

```bash
PUTER_TOKEN=<a token for the account that owns the app> \
PUTER_APP_UID=<the app's uid> \
npm run publish:mail-handler
```

The first publish stands up the app's events worker, which is a standing per-app
cost. The script is idempotent: it compares the source hash against what is
already published and does nothing when they match. The handler name carries its
contract version (`calendar-mail-v2`), so a client never binds to a handler whose
record shape it does not understand — change the shape, change the version, and
older clients simply report that the handler is not deployed. Users see that as a
line in the Mailbox invitations dialog; nothing else about the app is affected.

## Booking links

The sidebar's **Booking links** section is a Calendly-style scheduler: create a
link ("30 minute meeting"), share it, and anyone — no Puter account — can book
one of your free slots.

**What the link looks like.** `https://calendar.puter.com/#/<username>/<slug>`
— "Intro call" on nj's calendar is shared as `calendar.puter.com/#/nj/intro-call`.
The first segment names the per-user worker that serves the page
(`cal-<username>.puter.work`, minus its prefix); the second is the page's slug,
made from its title. The link is derived, not registered: `index.html`
recognises the route and hands the visitor to the guest page (`book.html`)
before the calendar itself loads, and the guest page rebuilds the worker's
address from those same two words — there is no directory to keep up, nothing
central to go down, and no server in the path but the host's own worker. Both
halves are settled once and never move: a worker cannot be renamed (so changing
your username changes nothing, for links already sent or new ones), and a slug
outlives the title it came from, because re-slugging a renamed page would break
every link already sent. Worker names are global across Puter, so a host whose
name is taken gets `<username>-<4 hex>`; pages created before slugs, and titles
with no Latin letters to slug (Cyrillic, CJK, emoji), keep their random hex ids.
The worker's own `https://cal-<username>.puter.work/book/<slug>` links — the form
every link took before this — still redirect to the same page.

**What the host controls.** Each link is a page with a title, duration,
location and description; weekly hours (any number of intervals per day, in a
time zone you pick); how far ahead people may book (up to 90 days), a minimum
notice, buffers before/after meetings, a per-day cap, slot increments, and a
color for the events it creates. Links can be switched off without being
deleted.

**Your name and face on the page.** Guests see you by your username unless you
say otherwise: the editor's **Your name** field sets the name shown on every one
of your booking links, and in the emails the worker sends — it is a calendar
setting, so it follows you across devices, and left blank it is your username
again. A page can also lead with your Puter profile picture,
switched on per link (the editor previews exactly what guests would get). It is
opt-in: a page saved before the switch existed never starts showing it, because
its link is already out there. The app publishes a copy small enough to belong
in a config the worker reads on every request — rescaling one that isn't — and
the worker only serves it to the pages that asked, as inline image data or not
at all.

**Where availability comes from.** The same per-user worker that serves RSVP
links serves the booking API. The app pushes it the page configs plus a merged
list of *busy* intervals derived from your calendar — timed events and
out-of-office blocks count as busy; declined events and ordinary all-day events
(birthdays, holidays) count as free, like Google's default transparency. The
worker computes slots from your weekly hours minus busy time, existing
bookings, buffers, notice and the horizon — in your time zone, DST included —
and the guest page (`public/book.html`, hosted with the app) renders them in
the *visitor's* time zone. The slot math runs once, in the worker: the grid a
guest sees and the validator that accepts their booking are the same function,
so they cannot drift apart.

**Booking.** The guest picks a slot, leaves a name/email/optional note, and the
worker records the booking. `puter.kv` has no transactions, so the write order
is what settles a race: the booking is *reserved* before availability is
checked, which means every request's check runs against a store that already
holds its own reservation — and two overlapping bookings then cannot both
survive. Two guests racing for one slot end with exactly one confirmed; the
other is told the time was just taken and gets a fresh grid. (Two presses
landing in the very same instant can both be asked to pick again — a free slot
offered twice rather than one slot sold twice.) Pressing *Schedule* a second
time after a reply goes missing is recognised as the same booking, not reported
as a conflict.

The worker emails the guest a confirmation (with an `.ics` and a private,
capability-URL cancel link — only its hash is stored, like RSVP tokens) and
emails you a heads-up; both mails are sent from your own account, best-effort
and capped per day, and the page only claims a mail was sent when it actually
was. The booking then appears on your calendar as a normal event — guest
attached, colored by the page — within about half a minute of being made while
the app is open, and straight away when you come back to its window. Nothing in
the app announces a booking (it happened elsewhere), so that check is the only
thing that can, which is why it runs often enough to matter and why a window
that has fallen behind another one re-reads the calendar rather than waiting for
a restart.

**Cancelling.** The event's details card shows *Booked via "…"* and offers
**Cancel booking**, which frees the slot and attempts to email the guest. The
result says when no cancellation email was sent, including delivery failures.
Deleting the
event some other way is caught by a safety net: a confirmed future booking
whose event stays missing for ten minutes is cancelled with notice (the grace
period is what keeps a delete followed by Undo from firing a cancellation you
didn't mean). Guests cancel from their link any time before the meeting starts;
the freed time is offerable again immediately — the worker holds the booking
record itself, so it doesn't wait for your app to sync — the event leaves your
calendar on the next sync, and you get an email.

Because the booking page is public — that is its point — the worker also caps
new bookings per page per day, so a hostile visitor can neither fill your
calendar unbounded nor drain your email allowance.

## Meeting links

**Add Puter Meetings link** in the event editor attaches a video-meeting link
to an event, Google Meet-style: one click and the link is there — on the
details card as **Join meeting**, in invitation emails as a `Join` line, and
in the event's exported `.ics` as its `URL` property, which is where other
calendars read a joinable link from.

There is no API behind that click.
[Puter Meetings](https://meetings.puter.com) publishes a stateless recipe for
other apps: an *open room code* is 12 crypto-random lowercase letters
(`abcd-efgh-ijkl`) wrapped in `https://meetings.puter.com/#/m/<code>`, and
nothing is created anywhere until someone opens the link and starts the
meeting (`src/js/meetings.js` is the entire client). That gives meeting links
properties the calendar leans on:

- **Minting is local, instant, and free.** It works on the open web, offline,
  and without the Meetings app installed — and a link discarded before saving
  simply never existed, so there is nothing to release or clean up.
- **First to start it, owns it.** The first Puter account to press *Start this
  meeting* in the link's lobby claims the room permanently (concurrent
  starters race safely). Practically: start your own meetings — early guests
  wait in the lobby and join automatically the moment you do.
- **The link never expires**, so it keeps working across sessions: the same
  link hosts next week's occurrence of a recurring event.

Removing a link from an event only detaches it — a link that may already be
in guests' hands keeps working (attach a fresh one if you want a clean
slate). The link lives on the series master, like the guest list: editing a
single occurrence can't give it a different link.

The other direction exists too: inside the Puter desktop, the Meetings app's
home screen lists the day's meetings from this calendar — with a Join button
on each — by asking the [app-to-app API](#app-to-app-api) for events that
have a meeting link (`list` with `has: ['meeting']`), and nothing else.

## Public holidays

Pick a country in the account menu and the calendar grows a holiday layer:
`Independence Day` on the 4th, and `Independence Day (observed)` on the Friday
before when the 4th is a Saturday. Ten countries ship today — the United States,
United Kingdom, Canada, Australia, Germany, France, Netherlands, Spain, India and
Japan. Clicking a holiday opens the same details card an event gets — the full
name, the date, the country, and why a substitute or bridge day is one — with
Close as its only head action and a *Change country…* button that jumps to the
picker. Nothing to edit, nothing to delete.

**Computed, not fetched, not stored.** `src/js/holidays.js` derives holidays from
a rule set at render time. That one decision is what makes the feature cheap
everywhere else: there is no data to sync, no `puter.kv` write, nothing to
reconcile when you change country or scroll to a year you have never opened, no
holiday to edit by accident, nothing that leaks into an `.ics` export as if it
were yours, and no reminder that can fire on one. Every year works offline —
past, future, whatever the calendar is scrolled to — because the rules *are* the
data. The cost is about 4 KB gzipped.

A rule resolves to one day per year in one of four shapes, and `from` / `to`
bound it to a range of years, which is how a holiday that was introduced, moved,
renamed or abolished is modelled — data, not a special case:

```js
{ name: 'Independence Day', month: 7, day: 4, observe: true }  // fixed date
{ name: 'Thanksgiving Day', month: 11, nth: 4, dow: 4 }        // nth weekday (-1 = last)
{ name: 'Good Friday', easter: -2 }                            // days from Easter
{ name: 'Vernal Equinox Day', on: (year) => …, observe: true } // anything else
```

Weekend substitution is per-rule, not per-country, because the distinction is
real: Australia Day moves to the Monday, and Anzac Day, four days later in the
same list, does not. A substitute is added *beside* the real date rather than
replacing it — 25 December is Christmas Day whichever day it lands on. Three
strategies cover the ten countries: the US Friday-before/Monday-after rule, the
Commonwealth "next free weekday" (which is why Christmas and Boxing Day on a
weekend take the Monday *and* the Tuesday), and Japan's Sunday bump — plus
Japan's 国民の休日, where an ordinary day caught between two holidays becomes one
itself, the rule behind September's Silver Week.

### Clock changes

The "daylight saving" request usually arrives as two dates — "March 8th and
November 1st" — and two dates would be wrong within the year: they are the US
dates for 2026 only (2027 is the 14th and the 7th), three weeks early for
Berlin, the wrong way round for Sydney, and a fiction in Tokyo. `src/js/dst.js`
stores no dates at all. It scans a year of the browser's own zone for the
midnights at which the UTC offset differs from the day before, bisects each to
the minute, and hands the views one read-only all-day item per change —
`Clocks go forward` / `Clocks go back` — on the local day it happens. Its
details card says when (`at 2:00 AM · 2:00 AM becomes 3:00 AM`), by how much
and what it does to the day's length, in terms of the clocks rather than of
"daylight saving", which is also correct for the one-off offset changes a
country legislates now and then. Off where the clocks never move, and a toggle
in the account menu turns it off anywhere else.

Two *different* holidays land on one day now and then, for the same reason a
movable feast needs a rule at all: Ascension sweeps a five-week window across
the fixed dates, so it sits on Labour Day in 2008 and on France's VE Day in
1997, 2059, 2070, 2081 and 2092, and Easter Monday sits on Anzac Day in 2011
and 2095. Both are listed on those days, as every printed calendar for them
does — a day is not a slot with room for one holiday.

**What it deliberately does not do.** Coverage is national only: no states,
provinces or Länder. A half-populated subdivision calendar is worse than none —
you would trust the absence of a holiday the app simply never knew about. So the
UK list is England &amp; Wales (Scotland and Northern Ireland differ), Germany is
bundesweit only, and India ships the three gazetted holidays observed nationwide.
Diwali, Holi and the Eids are lunar or lunisolar: their dates come from an
ephemeris, and for the Islamic ones from a local moon sighting, so no rule can
derive them and the module does not pretend otherwise — add them as `on:` rules
bounded by year if you need them.

Nor is history unlimited. Japan's list is right from 2000, when the second of
the Happy Monday moves landed: before that Sports Day was 10 October rather
than a Monday, and before 1989 the Emperor's Birthday was 29 April, not 23
December. Every other country's list holds from the 1970s, with the one-off
years — the 2019 Japanese enthronement, Tokyo 2020's shuffled summer, the
Platinum Jubilee, a state funeral and a coronation — carried as dated rules.

Holidays are ordinary all-day items, and the booking engine already treats those
as free time (Google's default transparency for them), so sharing a booking link
does not stop anyone reserving your Boxing Day. They are also left out of the
mini-calendar and year-view dots, where a dot means "you have something on" —
which a public holiday, by itself, does not.

To add a country, add one entry to `COUNTRIES` in `src/js/holidays.js` and a case
to `tests/holidays.test.js`. Nothing else needs to change.

## App-to-app API

The calendar answers the same kind of connection it makes: other Puter apps can
read and write the user's events instead of keeping a calendar of their own.
Contacts uses it to put a birthday on the calendar and to show what is coming up
with the person on screen.

**How a caller connects.** Inside the Puter desktop, launch the calendar in
service mode and talk to the connection you get back:

```js
const calendar = await puter.ui.launchApp({
  name: 'calendar',
  args: { service: 'calendar-api' },
  background: true, // no window on screen; older desktops ignore this
});

calendar.on('message', (msg) => {
  if (msg.$ !== 'calendar-api') return;
  if (msg.type === 'ready') {
    // msg.methods lists what this app is allowed to call
    calendar.postMessage({
      $: 'calendar-api',
      v: 1,
      id: '1',
      method: 'search',
      params: { guest: 'ada@analytical.co', from: Date.now(), to: Date.now() + 7 * 864e5 },
    });
  }
  if (msg.id === '1' && msg.ok) console.log(msg.result.events);
});
```

A service-mode instance mounts no UI, and starts no reminder scheduler, RSVP
sync or address-book client — it is one caller's question answered, not a second
calendar running in the background. It closes itself after a few idle minutes,
and closing the connection closes it immediately. Pass `background: true` to the
launch as well: the Puter desktop creates and shows an app's window *before* the
app's own code runs, so without it a service window briefly appears on screen no
matter how early the app hides itself.

**Methods.** One reply per request, matched on `id`: `{ ok: true, result }` or
`{ ok: false, error: { code, message, details? } }`.

| Method | Params | Result |
| --- | --- | --- |
| `ping` | — | `{ app, methods, time }` |
| `list` | `{ from?, to?, has?, limit? }` | `{ events, total, from, to }` |
| `search` | `{ query?, guest?, from?, to?, has?, limit? }` | `{ events, total, from, to }` |
| `get` | `{ id }` | `{ event }` |
| `create` | `{ event }` | `{ event }` |
| `update` | `{ id, patch }` | `{ event }` |
| `delete` | `{ id }` | `{ deleted: true, id, scope }` |

Events only, on purpose: tasks, out-of-office blocks, colors and settings are the
calendar's own business. `search` needs at least a `query` (matched against
title, location, description and the people on the event) or a `guest` (one
address or several — the organizer counts, since an invitation someone sent you
is as much "an event with them" as one you sent). Both reads take `has`, a field
name or several from `meeting`, `location`, `description`, `guests`,
`reminders`, `organizer`: only events that *have* every one — present and
non-empty — come back. `has: ['meeting']` is the day's video calls, `has:
['location']` the places to be; the calendar filters before anything crosses
the connection, and an unknown name is a `bad_request` that lists the known
ones rather than a filter quietly ignored. The calendar also posts
`{ type: 'changed' }` whenever events change, so a caller holding an answer knows
to ask again — and only then. Reading is silent, however often we re-read the
calendar ourselves to answer you (see **Freshness**), and so are the tasks,
settings and colors this API doesn't serve. A caller can therefore treat every
notice as worth acting on.

**Time, not storage.** A caller asks about a window and gets occurrences back: a
recurring series is expanded, per-occurrence edits are applied, and cancelled
occurrences simply aren't there. Nobody outside this app has to learn what a
recurrence rule, an exdate or an override is to find out when the standup is.
Both reads take `from`/`to` (defaulting to the next 31 days) and cap a window at
400 days, since expansion cost scales with it.

**Ids are handles.** An occurrence comes back as `<seriesId>::<recurrenceId>`,
and that id can go straight back into `update` or `delete`, where it means *this
occurrence* — the same choice the app's own scope dialog offers, without a dialog
to negotiate over a wire. A stored event's id means the event, and for a series
master that is the whole series; `scope` in a delete's reply says which happened.
`recurrence`, `guests`, `reminders` and the rest are writable; ids, timestamps,
`exdates`/`overrides` and the calendar's own `ooo`/`declined` states are not.

**Freshness.** Every request is answered from a calendar that was read from the
cloud within the last few seconds; an older one is re-read first. The process
serving you is not necessarily the one the user is editing in — a service
instance can stay open for minutes while they move a meeting in their own
window, and nothing tells us about it. A burst of requests shares one read, and
if that read fails while we already hold a calendar you get it rather than an
error.

**Who may call it.** The API is closed by default. `ALLOWED_CALLERS` in
[`src/js/api/protocol.js`](src/js/api/protocol.js) maps an app name to the
methods it may use, and an app with no entry gets no listener at all. Today:

```js
contacts: ['ping', 'search', 'create', 'update', 'delete'],
meetings: { methods: ['ping', 'list'], has: ['meeting'] },
```

Contacts is granted what it uses and nothing more: it never lists a whole
calendar and never opens an event by id, so it cannot. Write access at all is
granted on one condition, which Contacts meets: the caller puts the change in
front of the user before making it, and `delete` is there so that Undo works.

A grant can also be *scoped* — the object form pins a `has` filter (the same
names `list` and `search` accept) to everything the caller does. [Puter
Meetings](https://meetings.puter.com) shows the day's video calls on its home
screen with a Join button, which takes `list`; nothing about that needs the
dentist appointment, so its grant reaches only events that carry a meeting
link. A scope is applied server-side from the caller's identity: reads return
nothing outside it however they are phrased, an event outside it is
`not_found` by id, and a create that would fall outside it is refused. The
`ready` notice carries `scope` so a caller can see the slice it was given.

The caller's identity comes from the `puter.source_app.name` launch parameter,
which the Puter desktop stamps onto the app window from the *calling process*: an
app cannot claim to be Contacts, and cannot set that parameter for a window it did
not launch. Worth being plain about the limit of that: the iframe/postMessage
model gives a child window no way to cryptographically verify its parent, so these
checks hold inside a genuine Puter desktop session — the environment they are
written for — and are not a defence against a page that embeds this app itself and
forges launch parameters. The API is never served outside `puter.env === 'app'`.

## Getting started

```bash
npm install
npm run dev      # start the Vite dev server (http://localhost:5173)
npm run build    # production build into dist/
npm run preview  # preview the production build
npm test         # run the unit tests once
npm run coverage # run tests with a coverage report
```

Open the app and click **Sign in** to use your free Puter account.

## Project structure

```
index.html                 # entry; loads puter.js + the app
src/
  main.js                  # bootstrap: auth flow, store init, app mount
  styles/                  # design tokens, base primitives, layout, views
  js/
    app.js                 # controller: shell, navigation, views, shortcuts
    store.js               # data layer over puter.kv (injectable backend)
    date-utils.js          # dependency-free date math & formatting
    holidays.js            # public holidays, computed from rules (no network)
    event-layout.js        # column layout for overlapping events
    modal.js               # event editor (incl. guests + contact suggestions)
    sidebar.js             # mini-calendar + category filters
    category-dialog.js     # renaming a category (a label, never the color key)
    context-menu.js        # puter.ui.contextMenu + fallback
    contacts.js            # the Contacts app's address book, over AppConnection
    rsvp-links.js          # the host's RSVP worker: deploy, links, answer sync
    invites.js             # emailing those links, via the shared email worker
    mailbox.js             # ~/.mail: permissions, the events subscription, rescan
    mail-intake.js         # detected invitations: trust policy, tray, iTIP handling
    mail-reply.js          # answering an emailed invitation by email (iTIP REPLY)
    mail-dialog.js         # connect, policy, blocked senders
    windows-zones.js       # Windows/Mozilla TZID names -> IANA
    booking.js             # booking links: configs, busy-time push, booking pull
    booking-dialog.js      # the booking-link editor (hours, rules, share URL)
    meetings.js            # Puter Meetings links, minted statelessly (no API)
    colors.js  icons.js  dom.js  toast.js  auth.js
    api/                   # the calendar, served to other apps
      protocol.js          #   wire format + who may call what
      methods.js           #   the operations, transport-free
      server.js            #   dispatch over one AppConnection
    views/                 # month, week, day, agenda (+ shared timegrid)
  workers/                 # serverless Puter Workers (not part of the bundle)
    rsvp-worker.js         #   deployed per user: guest RSVP + booking endpoint
    email-worker.js        #   deployed once by the app owner: sends invitations
    mail-handler.js        #   published events handler: reads arriving mail
scripts/
  publish-mail-handler.mjs # publishes that handler against the app
public/
  rsvp.html                # the guest-facing RSVP page the links land on
  book.html                # the guest-facing booking page (Calendly-style)
tests/                     # Vitest unit tests
```

## Testing

Unit tests (Vitest + jsdom) cover the pure logic that is easiest to get wrong and
most important to keep correct:

- `date-utils` — arithmetic, week/month boundaries, ranges, and formatting.
- `event-layout` — overlap clustering and column assignment.
- `store` — event normalization, range queries, filtering, and persistence against
  an in-memory stand-in for `puter.kv`.
- `holidays` — Easter, weekend substitution and the year bounds, checked against
  independently known dates, plus the overlay where it meets the store and views.
- `mail-handler` — the published handler, run the way the events worker runs it,
  over parsed messages from `puter.email.get`: Google, Outlook and Apple
  invitation shapes, cancellations, replies, and malformed input.
- `mail-intake` — who counts as known, what each iTIP method does, and what is
  hidden rather than shown.

```bash
npm test
```

## Deploying

`npm run build` produces a static `dist/` you can host anywhere, including
[Puter hosting](https://developer.puter.com/). The context menu automatically uses
Puter's native menu when the app runs inside the Puter GUI and the styled fallback
everywhere else.

Two pieces live outside that bundle, both deployed once by hand: the email worker
that sends invitations (`npm run deploy:email-worker` — see
[Deploying the email worker](#deploying-the-email-worker)) and the events handler
that reads arriving mail (`npm run publish:mail-handler` — see
[Deploying the mail handler](#deploying-the-mail-handler)). The RSVP worker needs
nothing from you; the app deploys it into each user's own account.

## Populate a demo

After signing in and letting the calendar load, run this in the browser console:

```js
await calendar.populateSampleData()
```

Available in development and production builds, including the local demo. Creates
20 fictional events (including a weekday focus series and an all-day launch week)
and five tasks around the current week, then opens this week. Dates use local time.
The records persist through the normal calendar store; existing events, tasks,
category filters and saved preferences are preserved. No invitations are sent and
sample events have no reminders. Offline writes follow the normal read-only gate.
Each completed call adds a fresh batch; overlapping calls share one operation.
Returns `{ events, tasks, eventIds, taskIds }`. Sample descriptions/notes identify
the records, which can be removed with the regular event/task controls. On failure,
the promise rejects with the saved counts; completed writes remain, and retrying
starts a fresh batch. If a category is hidden, its sample events stay hidden too.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
