# Teamchat

Team messaging on Puter: workspaces, public and private channels, threads,
direct messages, reactions, mentions, and file attachments. Vanilla
JavaScript (no frameworks), Vite, and [Puter.js](https://developer.puter.com)
as the only backend.

## Features

- **Workspaces**: create one, invite people with a link or code that expires
  (1, 7, or 30 days; replace or deactivate it anytime) or **by email**: the
  Invite dialog has an Invite link tab and an Email tab
  (addresses, an optional note, the mail composed and sent by the app's one
  shared email worker — see "Invitation emails" below), creating a workspace
  flows straight into inviting your teammates, and the sidebar keeps
  "Invite people" one row away for admins. Manage roles (owner, admin, member,
  guest), remove members, leave, delete. Admins can also invite a **guest**
  to a single channel: a channel-scoped invite (same link and code shape,
  same expiry and brute-force budget) that lands the joiner in that one
  channel with the guest role. Guests see only the channels they are in and
  the people they share one with, cannot browse, join, or create channels,
  invite anyone, or message strangers, all enforced by the worker on every
  route; they are labelled everywhere people appear, channels containing
  guests say so, and an admin can add them to more channels, make them a
  full member, or revoke their access from Workspace settings. Each workspace runs on a small server in its
  owner's own Puter account, created by the app the first time they need one.
- **Channels**: public channels anyone in the workspace can browse and join,
  private channels with invited members, topics (short, in the header) and
  descriptions (longer, in the details and the channel's intro), archive,
  delete. Creating a channel flows into adding people as a second step: a
  public channel offers "Everyone in the workspace" in one move or
  specific people, a private one takes specific people, and both
  are skippable; anyone in a public channel can bring workspace members
  in (guests stay an admin's call), and the same dialog sits behind "Add
  people" in the channel intro. New members
  land in the default channels. The header carries a star, the name and
  topic, a member button showing the faces of the last few people who spoke
  (no extra reads) with the member count, notifications, search in this
  channel, details, and a menu (details, copy link and name, star,
  notifications, edit, leave). Admins can limit posting in a channel to
  admins (an announcements channel: everyone reads and reacts, and the
  channel wears a megaphone in the sidebar) and set thread replies to
  everyone, admins only, or off, independently; both are enforced by the
  worker, and members keep editing and deleting their own older messages.
- **Direct messages**: one to one and group conversations (up to 9 people).
  The same set of people always maps to the same conversation.
- **Details**: clicking a channel or conversation name opens its details as
  a dialog with tabs: About (topic, visibility, creator,
  pins, bookmarks, search, files, copy link, leave), Members (searchable,
  with adding people or guests and the guest invite link), and Settings for
  admins and creators (name, posting rules, archive, delete), with star and
  notification controls on top. The route (`/details`) keeps it shareable
  and lets Back close it. Threads still open in the side panel.
- **Messages**: markdown-lite formatting (bold, italic, strike, inline code,
  code blocks, quotes, links), @mentions with autocomplete, editing in place
  (the message becomes a box with Save and Cancel where it sits; Enter
  saves, Escape cancels; ArrowUp in an empty composer edits your last
  message), delete,
  fenced code blocks with a language label, a copy button, folding past 20
  lines, and syntax highlighting for js/ts, json, html, css, sh, python,
  sql, diff, markdown, and yaml (the highlighter loads only when a block
  with a language hint is first shown; unknown hints render plain),
  emoji reactions with a full picker (search, categories, skin tones, a
  frequently used row, up to 24 different reactions per message),
  `:shortcode:` autocomplete and rendering in messages, an emoji button in
  the composer, larger rendering for emoji-only messages, `@channel`,
  `@here` (people active in the last five minutes) and `@everyone` (the
  default channel only) broadcasts that notify a whole channel, offered in
  the mention autocomplete with the number of people they reach and
  confirmed before sending (skippable in settings; admins can restrict
  broadcasting per channel, and it is admins-only in the default channel),
  link previews (a card with the site, title, description and a thumbnail
  under a message's first link; images preview directly; authors and admins
  can remove a card; off per workspace in settings), file attachments up to 10 MB with
  inline image previews (each under its file name, which folds the preview
  away and remembers that), a "+" menu at the start of the composer's row
  (upload from your computer, code snippet), drag and drop and paste to
  attach, and drafts:
  unsent text (and finished uploads) is kept per conversation on the
  device, so it is there after switching away, reloading, or closing the
  tab; a sidebar row with a draft wears a small pen, and a **Drafts & sent**
  view above the channel list gathers them with a preview and a delete,
  beside a Scheduled tab (what waits to go out) and a Sent tab (the newest
  messages you sent, from the search index, each opening in place). A formatting row above the
  box (bold, italic, strikethrough, link, quote, code, code block) wraps or
  unwraps the selection in the markdown the app already reads, with the
  usual shortcuts (`Cmd/Ctrl+B`, `I`, `Shift+X`, `Shift+C`, `Shift+Alt+C`,
  `Shift+9`, `Shift+U`); the "Aa" button hides and shows the row. Messages
  are capped at 4,000 characters, counted down in the composer. Hovering a
  message shows three quick reactions (the ones you use most, or done,
  seen, and thanks until then), add reaction, reply, save for
  later, and a menu (mark unread, remind me, get notified about replies,
  copy link and text, pin, save, edit, delete); with a message focused or
  under the pointer, `U`, `L`, `P`, `S`, `R`, `E`, and `Delete` do those
  directly, and the menu shows the keys. **Forward** (in the bar and the
  menu) posts a message to another channel or conversation as a quote with
  the author, a link back to the original, and its attachments, with an
  optional note on top; mentions inside the quote are made inert so nobody
  is pinged twice.
- **Threads**: reply to any message; the thread opens in a side panel on
  desktop and full screen on mobile, with reply counts on the parent. An
  "Also send to #channel" box under the reply posts the reply in the
  conversation too, with a link back to the thread.
- **Threads, Activity, Later, Drafts & sent**: Threads and Drafts & sent sit above the
  channel list; Activity and Later are rail items (and sidebar rows on a
  phone). Threads
  lists every thread you started, replied in, or follow, newest activity
  first with unread replies counted, each as a card: where it is and who
  is in it, the root message, the newest three
  replies with "Show N more replies" opening the thread, and a reply box
  of its own; Activity is an inbox of mentions
  (broadcasts included), replies in threads you follow, and reactions to
  your messages, filterable, each opening the message in context; Later
  holds messages you saved from their menu, with a done toggle. "Mark
  unread from here" on a message (or "Mark as unread" on a sidebar row)
  moves your read cursor back so the New divider and bolding return.
- **Send later and reminders**: the arrow next to Send schedules a message
  (in an hour, tonight, tomorrow at 9, Monday at 9, or a custom time in your
  zone); the Later view lists what is scheduled, where you can edit,
  reschedule, send now, or delete it before it goes out. "Remind me about
  this" on any message brings it back at the chosen time as an entry in
  Activity and a line in your own space linking to the message, with snooze
  and done. Delivery is honest: a Puter worker only runs while handling a
  request, so anything due is delivered by the first sync poll after its
  time from anyone with the workspace open — usually within 20 seconds (the
  safety-poll floor of the realtime section below; sooner with more than one
  tab open, and the message it writes then wakes every other tab through the
  same signal a live post does); the UI says "around 9:00" and explains what
  that depends on.
- **Pins and bookmarks**: pin any message in a channel, DM, or thread from
  its menu (up to 100 per conversation; the pinner or an admin unpins). A
  "3 pinned" bar above the messages expands to the list, the details dialog
  shows it too, and each entry opens the message in place. Channels carry
  up to 10 named bookmarks under the header (links, or attachments from the
  channel), curated by any member of the channel and reorderable.
- **Starred**: star a channel or conversation from the header, its sidebar
  row's menu, or the header menu, or drag its row onto the Starred section
  (and back out to remove the star); starred ones move to that section at
  the top of the sidebar, which is always there, saying what it is for
  while it is empty. Stars are kept in your own Puter account, so they
  follow you across devices without touching the workspace.
- **Directory**: a row above the channel list opens everyone in the
  workspace as cards (searchable by name, username, or title, each with a
  Message button and a profile card) and every channel you can see (with
  member counts, topics, and Join or Open), in the main column.
- **Custom sections**: group channels and conversations your own way in
  sidebar sections. Create one from the sidebar gear or a row's
  "Move to…" menu, move rows in from that menu or by dragging them onto the
  section (and back out onto Channels or Direct messages), rename or delete
  a section from its header. A row lives in one place: Starred, a section,
  or its default list. Sections are kept with your stars in your own Puter
  account, so they follow you across devices and nobody else sees them.
- **Manage my sidebar**: the gear beside the workspace name sorts channels
  and conversations alphabetically or by recent activity, hides muted ones
  (they come back while open or when they mention you), creates a section,
  and marks everything read. Sort and muted-row choices are kept on this
  device.
- **Find a conversation**: a filter box at the top of the sidebar narrows
  the lists as you type: channels you are in, public channels you could
  join, direct messages, and people you have not messaged yet (picking one
  opens the conversation), with "search messages for …" as the last row;
  Enter opens the first match, Escape clears.
- **Files & links**: a tab under every conversation's name (next to
  Messages) lists what was shared there, newest first, filterable to files,
  media, or links and by name, with a photo strip on top; each entry opens
  the file or link, or the message it came from. It reads the search index
  (`has:file` and `has:link` scoped to the conversation, each its own
  posting list), so it costs no extra storage and sees what the index
  knows; a page at a time, with "Load more" for older ones.
- **Search**: every channel and conversation you are in, from the box in the
  bar across the top (results appear as you type; `Cmd/Ctrl+K` puts the
  cursor there, the bar's arrows step back and forward through where you
  have been, and the clock beside them lists the conversations you opened
  most recently, kept on this device; an empty box drops down "Search in
  #channel" for the open conversation and your recent searches, each
  removable), with `in:#channel`, `in:@person`, `from:@person`,
  `has:file`, `has:link`, `before:` and `after:` filters, results grouped by
  conversation with the matched words marked, under tabs for Messages,
  Files (the same query, files only), Channels (names and topics you can
  see), and People (names, usernames, titles, with a Message button). Each result opens the message
  in place. Results only ever come from conversations the reader may see.
- **Jump to a date**: the day at the top of the viewport floats over the
  message list as a pill; it opens a menu (yesterday, last week, last
  month, the very beginning, a specific date, latest messages) that opens
  the conversation at the first message on or after that day. The date is
  turned into a sequence number by binary search over single-message reads
  (about thirteen for five thousand messages), so no index or route was
  added.
- **Permalinks**: "Copy link" on any message gives a link that opens the
  conversation scrolled to that message and highlighted, including replies
  inside a thread; history loads in both directions from there.
- **Unread state**: bold channels, mention badges, DM counts, a "New" divider
  where you left off, a jump pill when new messages land while you are
  scrolled up, a badge in the tab title, and, when unread rows are scrolled
  out of the sidebar, an "Unread mentions" / "Unreads" pill at that edge of
  the list that scrolls to the nearest one.
- **Workspace icon**: admins give the workspace a square image (cropped and
  downscaled in the browser, PNG when it fits so a logo keeps its transparent
  background), shown in place of the name's first letter on the rail, in the
  workspace menu and switcher, and in the sidebar's head on a phone; the
  letter shows until it loads, and when there is none.
- **Profiles**: a display name, title, and colour, plus an optional photo
  (cropped square and downscaled to 256 px in the browser, so no server
  ever resizes anything) shown everywhere an avatar appears, with initials
  as the fallback; and a status, an emoji with a few words and an expiry
  (an hour, four hours, today, this week, or never), shown next to the name
  in message rows, member cards, the sidebar, and the mention list.
- **Presence**: active, do not disturb (notifications paused), away (seen
  in the last day), or offline, derived from the heartbeat the poll already
  carries while the tab is in view and was touched in the last ten minutes
  (a huddle counts as company); a tab that closes says so, and the person is
  away within seconds rather than when the heartbeat lapses (unless another
  tab of theirs is still in view); sending a direct message to someone on do
  not disturb shows a quiet hint. Plus a
  typing line under the conversation ("Ana is typing", "Ana and Ben are
  typing", "Several people are typing") with a quiet marker on the sidebar
  row. It appears within one poll and fades a few seconds after they stop;
  the composer reports typing at most once every four seconds, once more
  on stopping, so the cost to the owner is bounded. Muted conversations
  show nothing, and the dots do not animate for people who asked for
  reduced motion.
- **Huddles**: a live call inside any channel you are in or any direct
  message: the headphones in the header start one
  (or join the one in progress, showing the faces in it and a count; pressed
  while you are in it, and clicking then leaves), `Cmd/Ctrl+Shift+H` does
  the same, and the details dialog carries the action too. While a huddle is
  on, its sidebar row wears headphones, a bar above the messages says who is
  in it and since when with a Join button, and the conversation gets a line
  when it starts and one saying how long it ran when the last person leaves.
  A huddle in a direct message rings: a toast with Join while the tab is in
  view, a browser notification (and a push, with the app closed) when it is
  not, an entry in Activity either way, all under the conversation's own
  notification setting; a channel's huddle only marks the row.
  In the huddle, a small window sits over the bottom of the sidebar wherever
  you go in the app: the people in it with a ring around whoever is
  speaking, the elapsed time, mute, camera, share your screen, and leave. It
  is audio first; when someone turns a camera or a screen on, the window
  grows into a tile grid (a shared screen leads), and you can size it
  yourself. On a phone it is a bar above the message box (the conversation,
  the others' faces, the clock, mute, leave) that covers nothing, and Larger
  opens the window. One huddle at a time; joining another leaves the first, after
  asking. Without a microphone (or permission for one) you can still join
  and listen. Up to 20 people per huddle. Media goes directly between the
  people in it over Puter's Peer API (see *Huddles* under Architecture);
  the workspace's server only keeps who is in which huddle.
- **Notifications**: optional browser notifications while the tab is in the
  background, with a setting per channel and conversation (All messages,
  Mentions only, Nothing) and a mute switch, from the sidebar row's menu
  (right-click or the kebab, opened where the pointer is: details, copy
  link and name, star, "Notify you about" with all
  new posts, just mentions, or mute, read state, leave), the conversation header, or the details
  dialog; a muted conversation is dimmed, never bold, and left out of the tab
  title. Threads can be followed and unfollowed (authors and repliers follow
  by default), with unread replies counted on the parent. Quiet hours and
  "pause for 30 minutes / an hour / until tomorrow" silence everything
  without losing unread state, and the message preview in notifications
  can be turned off. Defaults are unchanged: mentions and direct messages.
- **Shared channels**: an admin shares a channel with
  another workspace from its details ("Share with another workspace": a
  link or code that expires, replaceable, revocable, like a guest invite);
  an admin of the other workspace opens the link, picks which of their
  workspaces to add it to and what to call it there, and the channel
  appears in that workspace's sidebar under **External connections**,
  with live unread state and notifications. Their
  members join it from there and take part as usual (messages, threads,
  reactions, files, pins, mentions, search inside the channel, save for
  later, send later, reminders) while seeing nothing else of the host
  workspace; everyone is labelled with their workspace's name (in message
  rows, member lists, profile cards, and beside direct messages), the
  header wears a pill naming the other side, and a line above the composer
  says which workspaces read the channel. Channel details carry a
  **Workspaces** card (channel owner, each connected workspace with how
  many of its people are in, Remove for the host's admins, Share link) and
  each workspace names the channel for itself. Direct messages with people
  met in a shared channel work across the two workspaces. Either side ends
  it: the host's admins disconnect a workspace from the channel, the
  partner's admins remove the channel from theirs; Workspace settings lists
  every shared channel. Guests cannot be part of it (a member made a guest
  leaves the shared channels they were in), and people from a
  connected workspace can never be promoted or added to other channels;
  one of them the host's admins remove stays out (their channel says so)
  until restored from the members dialog, whatever their workspace says.
- **Integrations**: admins create incoming webhooks bound to one channel
  (post with a single `curl`, our `{ text }` shape or a blocks/attachments
  payload) and bot tokens that may post to, read, and react in the channels
  they are added to, with scopes kept to those three. Messages from
  integrations wear an APP tag under the integration's own name and colour
  and can never be attributed to a member. Tokens are shown once, stored
  only as a hash, rate-limited to 60 calls a minute, and can be rotated or
  revoked.
- **Theme**: system (default), light, or dark; applied before first paint and
  kept in your Puter account, so it follows you across devices.
- **Installable, offline, and reachable when closed**: a service worker
  precaches the app shell (versioned per build, with a "new version ready,
  reload" prompt), so the installed app opens without a network and shows
  the last page of recently opened conversations read-only, marked as saved
  on this device. Messages written offline wait in an outbox (IndexedDB,
  attachment bytes included), survive a reload, and send in order when the
  connection returns; every send carries a client id the worker
  deduplicates on, so a retry after a lost response never posts twice.
  Push notifications for mentions and direct messages arrive with the app
  closed, respecting mute, per-conversation levels, quiet hours, pause, and
  the preview preference; on iPhone and iPad, installing is what enables
  them. Install from settings (or the browser's own prompt).
- **Rail**: a narrow column at the left edge, with the
  workspace mark (its menu), Home, DMs, Activity, Files (everything shared
  in the channels and conversations you are in, the same list as a
  conversation's Files & links tab but across the workspace, each row
  saying where it was shared), and Later, and at the
  bottom a "new" menu, a theme toggle, and your avatar (status, pause
  notifications, settings, sign out). Home shows the channel sidebar; DMs,
  Activity, and Later swap it for a list pane (direct messages with the
  last line said and an Unreads switch; the activity inbox; saved items)
  and open what you pick beside it, with the pane kept in the route
  (`#/ws/:ref/dms/c/:conv`) so a reload or Back lands in the same place.
  Unread DMs and activity are badged on the rail. On phones the rail hides
  and the sidebar keeps its Activity and Later rows.
- **Keyboard shortcuts**: `Cmd/Ctrl+/` opens a searchable list of every
  shortcut in the side panel. Beyond the search, message, and
  formatting keys: `Alt+Up/Down` steps through conversations in sidebar
  order and `Alt+Shift+Up/Down` through unread ones, `Cmd/Ctrl+Shift+K`
  starts a message, `Shift+T`, `M`, `S`, `D` with `Cmd/Ctrl` open Threads,
  Activity, Later, and DMs, `Cmd/Ctrl+[` and `]` step through history,
  `Cmd/Ctrl+.` closes the side panel, `Shift+Esc` marks everything read
  (after a confirmation), and `Cmd/Ctrl+Shift+Y` opens your status.
- **App-like and accessible**: rail plus three panes on desktop, drawer-free
  two-screen flow on phones, safe-area aware, keyboard navigable (roving lists,
  focus-trapped dialogs, menus with arrow keys, Escape closes the side panel),
  landmarks for the sidebar, conversation, and panel, live regions for new
  messages, reduced-motion support, 4.5:1 text contrast in both themes.
- Signing out is hidden when the app runs inside Puter (`puter.env === 'app'`).

## Architecture

A team chat app needs data that many users read and write. Puter's key-value
store and filesystem are strictly per user, so Teamchat uses
[Puter Serverless Workers](https://docs.puter.com/Workers/) as the shared
backend, and it keeps Puter's user-scoped, user-pays model by giving **every
workspace owner their own worker, in their own account**: the first time a
user creates a workspace, the app copies the worker bundle it ships
(`public/worker/teamchat-worker.js`) to their drive and calls
`puter.workers.create()`. That worker's KV and filesystem hold every
workspace the user owns; the owner's Puter allowance pays for storage and
execution. Nothing runs under the app developer's account.

Members reach a workspace through its owner's worker with
`puter.workers.exec()`, which forwards the signed-in user's Puter session.
The worker identifies the caller with `user.puter.auth.getUser()` and
authorizes every request against workspace membership; only the account the
worker runs in may create workspaces on it. Nothing about identity is trusted
from request bodies.

```
Alice's browser ──exec()──> Alice's worker (teamchat-x7k2q9pw1a.puter.work)
Bob's browser   ──exec()──>   me.puter.kv   Alice's workspaces, all data
                              me.puter.fs   attachments
Bob's browser   ──exec()──> Bob's worker (teamchat-m3r8t2vq0z.puter.work)
                              ...           Bob's workspaces

each browser ── puter.kv ──> the user's own account: profile, preferences,
                             workspace list, which worker is theirs
```

A workspace is therefore addressed by **reference**, `{wsId}@{server}`, where
`server` is the worker's puter.work name (`abc123def0@teamchat-x7k2q9pw1a`).
Routes, invite links (`#/join/teamchat-x7k2q9pw1a/XXXX-XXXX-XXXX`), and the
user's workspace list all carry it, so a link alone is enough to find a
workspace and no directory is needed anywhere.

### What lives where

| In the user's own account (`puter.kv`, one document `tcu:me`) | In a workspace owner's worker (`me.puter.kv`) |
| --- | --- |
| profile card (name, title, avatar color, status, photo version), starred conversations and custom sidebar sections per workspace | a copy of each member's card, per workspace |
| the photo itself, in the user's drive (`teamchat/avatar.jpg`) | a copy of the photo per worker (`teamchat-avatars/{uuid}` in the owner's drive), paid for by the owner like attachments |
| preferences (theme, notifications, Enter sends) | workspaces, channels, members, messages, files |
| workspace list: `[{ ref, name, icon }]` | invite codes, read cursors, mention counts, presence |
| | the workspace's icon (`teamchat-icons/{ws}` in the owner's drive), its version on the workspace document |
| the user's own worker: `{ name, url, path, build }` | `tc:config`: who owns this worker |

The list in the user's account is a cache: at boot the app asks each worker
it knows which workspaces the user is in and reconciles (removed or deleted
workspaces drop out, renames propagate). The profile is pushed to every
worker the user has a workspace on when it changes, and sent along with
create and join so a newcomer's card is right from the first message.

Photos follow the same rule: the user's drive holds the canonical copy and
every worker they have a workspace on gets its own copy, uploaded when the
photo changes and when the user first arrives at a worker, so a workspace's
avatars are served by its own worker to its own members (membership is
checked) and nothing depends on a URL into someone else's account. The
duplication is deliberate: a photo is small, and the alternative, a public
URL in the user's drive, would tie every workspace's rendering to an
account it does not control.

### Keeping workers up to date

Every owner runs a copy of the worker, so shipping a fix means updating many
deployments. `npm run build:worker` hashes the worker's source into a build
id, compiles it into the bundle, and writes it in the bundle's first line.
The worker reports its build in `/health` and `/api/me`; when an owner opens
the app and their worker's build differs from the one the app ships, the app
overwrites the worker's source file in their drive (Puter redeploys at the
same URL) and the workspace continues on the new code. Members of a
workspace whose owner has not opened the app lately keep talking to the
older build, so route changes must stay backward compatible for a while.

The puter.js runtime a worker calls into is baked in at that same deploy and
does not move on its own — only a source redeploy picks up a new one. Any
edit under `worker/` changes the build id, so it redeploys every owner's
worker on their next visit and refreshes its runtime along with the code.
`/health` reports the baked-in puter.js as `runtime`.

### Trade-offs of per-owner workers

- A workspace's data physically belongs to its owner, so the data is made
  portable: any admin can **export** the whole workspace (a paged, resumable
  `GET /api/ws/:ws/export`; the list of conversations it walks is kept in
  the worker under a token the cursor names, never taken from the cursor,
  so an export can only ever read its own workspace) into their own Puter drive as `messages.json`
  plus plain HTML pages and the attachment bytes; an export can be
  **imported** onto another account's worker with ids intact (a
  conversation whose id is already in use on the receiving worker gets a
  fresh one, and direct messages are re-derived from the new workspace, so
  an import never writes into another workspace's history); and an owner
  can **transfer** a workspace by nominating an admin, whose app then
  copies it onto their own server with their own session, carries every
  member across without re-joining, and marks the old copy as moved. The
  old copy stays read-only (writes answer 423 with the new reference; old
  refs are followed, and so are old invite links for the members carried
  across, while someone new is told to ask for a fresh invite, the copy
  having minted its own) until its owner deletes it, so an interrupted
  transfer never loses anything. Deleting the owner's Puter
  account still deletes their workspaces, which is why Workspace settings
  asks owners with a team and no second admin to name one.
- Creating the first workspace takes a few seconds (deploy) instead of
  milliseconds.
- There is no central place to hotfix: fixes roll out as owners open the app.
- In exchange: no shared infrastructure, no developer bill, nothing to keep
  running, and abuse costs the abuser.

A single shared worker (the original design) still works: deploy the bundle
yourself, open it with `PUT /api/server { open: true }`, and point the app at
it with `?worker=https://my-teamchat.puter.work` or `VITE_WORKER_URL`. A
`?worker=` link is honoured for `https` puter.work hosts only, since it is
remembered and given the user's session from then on; a host elsewhere is
the operator's to set at build time.

Because `puter.workers.exec()` attaches the caller's Puter session to
whatever URL it is given, the app only ever calls hosts it has reason to
trust: any `*.puter.work` worker (that is the design: members talk to the
workspace owner's worker) and the shared worker it was configured with. A
route, invite link, or `movedTo` reference naming any other host is refused
rather than followed (`src/lib/refs.js`).

### Storage layout (inside a worker)

Every read is a direct `get` of a known key. `kv.list()` is never used
(the test suite asserts this), so nothing scans and nothing needs an index.

| Key | Holds |
| --- | --- |
| `tc:config` | `{ owner, open }`: the account this worker runs in, and whether others may create workspaces here |
| `tc:user:{uuid}` | a member's card (name, title, color) and the ids of their workspaces on this worker |
| `tc:ws:{id}` | workspace: name, owner, invite code, `channels{}`, `members{}`, `former{}` (the last hundred people who left, by name, so their messages keep an author) |
| `tc:ws:{id}:u:{uuid}` | one member's state: joined channels, DMs, read cursors, mention counts, notification settings, unread thread replies |
| `tc:ws:{id}:act` | activity: per-conversation `{seq, ts, lastAuthor, overlayTs}` (once the map holds over a thousand entries, a poll drops the thread entries quiet for a month, a hundred at a time; a reply writes one back), presence, version stamps, who is typing, and the huddles in progress (`h.{conv}`: who started it and when, each participant's heartbeat and peer invite) |
| `tc:invite:{code}` | `{ ws, exp }`, or `{ ws, ch, role, exp }` for a channel-scoped code: `guest` (a guest invite) or `connect` (a share link for another workspace) |
| `tc:connect:{id}`, `tc:connect:{id}:partner` | one connection between two workspaces sharing a channel: the host's record `{ ws, ch, partner, name, secret }` and the partner's `{ ws, ch, ref, rch, secret }`; two keys since both may live on one worker |
| `tc:conv:{conv}:seq` | the message counter |
| `tc:conv:{conv}:b:{n}` | message block *n*: `{ m: [...], x: {overlays} }` |
| `tc:file:{id}` | attachment metadata; bytes live in `me.puter.fs` |
| `tc:hook:{id}`, `tc:bot:{id}` | an integration: workspace, channel(s), name, colour, scopes, and the SHA-256 of its token's secret |
| `tc:ws:{id}:idx:m{yyyymm}:{n}` | search index, one month's bucket, shard *n* (of 64): `{ word: [postings] }` |
| `tc:ws:{id}:idx:meta` | the index's counters and months: `{ c, folded, failed, months }` |
| `tc:ws:{id}:idx:log:{s}` | log segment *s*: the postings of 50 messages waiting to be folded into the shards |
| `tc:ws:{id}:idx:walk` | while the index is being rebuilt: the direct messages the walk may read, so the conversation list a step brings back is held to the workspace's own |
| `tc:ws:{id}:idx:{n}` | the index from before month buckets (one shard set for all time), read alongside the log until the workspace is rebuilt |
| `tc:ws:{id}:pins:{conv}` | pinned messages of a conversation: `{ items: [{ seq, by, ts }] }`, capped at 100 |
| `tc:ws:{id}:u:{uuid}:inbox` | the member's activity inbox, a ring of `{ k, c, s, by, ts }` capped at 300, appended from the mention, reply, and reaction paths |
| `tc:ws:{id}:u:{uuid}:threads` | threads the member is in: `{ [threadId]: { c, s, at } }`, capped at 300 |
| `tc:ws:{id}:u:{uuid}:saved` | saved for later: `{ items: [{ c, s, ts, done }] }`, capped at 200 |
| `tc:ws:{id}:sched` | the due queue, a map by id of scheduled messages and reminders; `act.nd` holds the earliest due time |
| `tc:ws:{id}:ev:s{n}` | change-signal shard *n* (of 4): `{ t: <ms> }`, written whenever something a subscriber should wake for happens (see "Realtime" below); carries no topic, member, or kind of change, only a bucket and a timestamp |
| `tc:ws:{id}:ev:r{n}:k{k}` | ring shard *n* (of 8), slot *k* (of 16): one sealed change entry `{ n, g, d, e }` (see "Ring entries" below) |
| `tc:ws:{id}:ev:o{n}` | ping shard *n* (of 8): `{ t }`, for changes no ring entry carries |
| `tc:ws:{id}:evn` | the ring shards' entry counters, `{ s0..s7 }` |

Reaction keys are emoji shortcodes (`tada`, `wave-tone3`), validated in the
worker against the table in `src/shared/emoji-codes.js` before they become
overlay paths; the eight original icon reactions stay valid and still render.
The emoji tables are generated from GitHub's gemoji database by
`node scripts/build-emoji.mjs` and committed.

### Messages: blocks, a counter, and a pointer

Each conversation (channel, DM, or thread) has one integer counter and a
series of fixed-size block documents holding 50 messages each.

1. **Counter.** Posting does `seq = kv.incr('tc:conv:{conv}:seq')`. The
   increment is atomic, so concurrent senders get unique, ordered numbers with
   no read-modify-write.
2. **Blocks.** The message goes into block `floor((seq - 1) / 50)` with
   `kv.add(blockKey, { m: [message] })`, an atomic array append on a nested
   path. Two senders landing in the same block cannot clobber each other. The
   next block is created ahead of time while the current one fills.
3. **Pointer.** The head block index is derived from the counter, so a reader
   knows exactly which key holds the newest messages: read the counter, then
   the head block (plus the previous one if the head is short). Paging back is
   one `get` per 50 messages, forever, with no listing.
4. **Overlays.** Edits, deletes, reactions, and thread counts never rewrite the
   array. They are path updates into the block's `x` map:
   `kv.update(block, { 'x.s42.t': text })`,
   `kv.incr(block, { 'x.s42.rc': 1 })`. Clients merge `x` over `m` when
   rendering. A 4,000-character text cap keeps the worst-case block well under
   the 400 KB value limit.
5. **Threads** are conversations with id `{conv}_t{seq}`, and **DMs** have a
   deterministic id derived from the workspace id and the sorted member uuids
   (conversations from before the id carried the workspace are still found
   through the member documents), so both reuse the
   exact same code path.

### Search: an inverted index in month buckets, fed by a log

`kv.list()` is never used, so search cannot scan; it reads an index. Every
word of a message (lowercased, accents stripped, stopwords dropped, the
first 24 distinct words) is hashed into one of 64 shards of the month the
message was posted in, `tc:ws:{id}:idx:m{yyyymm}:{n}`, which hold
`{ word: [postings] }` with a posting of `{conv}:{seq}:{ts}`. Bucketing by
month is what bounds the cost: the store bills a write by the size of the
whole document it lands in, so appending one posting to a shard holding the
workspace's entire history would cost that history every time. A month's
shard holds a month.

Postings reach the shards through a log. Posting a message is one atomic
increment of the index counter (`tc:ws:{id}:idx:meta`) and one `kv.add` of a
small entry `{ posting, tokens }` to the current log segment
(`tc:ws:{id}:idx:log:{s}`, 50 messages per segment); that is the whole cost
of indexing a message to the owner. The first message of a segment creates
the next segment ahead of time and folds the segment completed two segments
ago (the one just completed may still have an append in flight) into the
month shards: each shard touched is written once for all 50 messages,
oldest segment first, and the segment is deleted once `meta.folded` has
advanced past it. Editing logs only the new words, deleting logs nothing.
Each word's list is capped at its newest 2,000 postings per month (and a
shard that still grows too large lowers its own cap), a safety net rather
than the working limit it was before. A shard write that fails is counted
in `meta.failed`, which every search answer carries, so an index that is
quietly losing writes is visible to admins instead of silent.

A query reads the meta document (alongside the membership check), the
unfolded log segments (at most four small documents: what was posted since
the last fold), and one shard per query word (at most six) from the newest
month with postings, then the month before, two months per hop, until its
page is full or it has spent four hops; a cursor names the month to resume
from, so a rare word deep in a long history is found over "Load more" rather
than in one unbounded call. A `before:` or `after:` filter skips the months
it rules out, so a search aimed at last spring starts there rather than
paging back to it. Candidates are intersected per month, deduped
across sources, filtered to what the caller may read (private channels they
are not in, other people's direct messages), sorted newest first, and only
then are the blocks holding the page fetched: at most 12 block reads per
hop. The log's entries can be from any month (an edit logs its new words
under the message's original timestamp), so what the log yields waits until
the months read have reached its month before it is examined, which keeps
the pages in order with no gaps or repeats; and its words count toward each
month's intersection, so a message whose words are split between the log
and a shard is still found by a query for all of them. Each fetched message
is checked against the query again, so stale postings left by edits and
deletes never surface.

Every message is also indexed under its author's pseudo-token (`_by:{uuid}`),
so "everything I sent" (the Sent tab, or `from:@me` with no words) reads one
posting list instead of scanning; with words in the query the author is
checked on the fetched message instead. The `_file`, `_link`, and `_by:`
pseudo-tokens are indexed once more scoped to the conversation
(`_file@{conv}`, threads under their parent), so the Files & links tab of one
channel, or `from:@ana in:#ops`, reads a list that is about that
conversation alone rather than the workspace's newest few thousand filtered
down to it.

Workspaces indexed before month buckets existed keep their old shard set
(`tc:ws:{id}:idx:{n}`), which a query reads alongside the log (its postings
span every month, so it is treated the same way), with scoped pseudo-tokens
falling back to the workspace-wide ones, until an admin rebuilds from
Workspace settings: a resumable pass that first drops the old index a
couple of months per step, then walks every conversation's blocks a few at a
time and writes straight into the month shards. Messages posted meanwhile
reach the shards through the log as always. Workspaces created before search
existed have no index and only find messages posted since, until rebuilt.
New workspaces and the sample workspace are indexed from the start.

### Offline, the outbox, and push

`dist/sw.js` is emitted by a Vite plugin with the build's asset list and a
version hash: hashed assets are served cache-first, navigations network-first
with the cached shell as the offline fallback, the Puter SDK
stale-while-revalidate so the app can boot offline, and API traffic
(`puter.workers.exec`) is left alone. The app stores each workspace's
bootstrap and the newest page of every conversation it opens in IndexedDB
and reads them back only when the network is gone, marking them stale.

The outbox is an IndexedDB store of unsent messages, blobs included. Each
message carries a client id (`cid`); the worker keeps it on the record and,
before writing, looks for the same id from the same sender in the newest two
blocks, answering with the existing message instead of a second one. That
makes the outbox's retries, and the composer's own retry, safe.

Push keeps to the per-owner model: each owner's worker generates its own
VAPID key pair on first use and keeps it in the owner's KV (`tc:config.vapid`),
signs its pushes with it, and encrypts payloads per RFC 8291 with WebCrypto;
nothing runs under the app developer's account. A device subscribes per
workspace (`POST /api/ws/:ws/push`, up to five devices per member), sending
its quiet hours, pause, and preview choice along so the worker can respect
them while the app is closed. Pushes go out from the request that writes a
mention or direct message, to at most 50 recipients per post (a broadcast
beyond that reaches people through the in-app badge), after checking each
recipient's mute and level for that conversation; a 404/410 from the push
service drops the subscription. Because browsers allow one application
server key per origin, a device subscribed to several workspaces on
different workers is re-subscribed with the key of whichever worker it
opens; pushes from the others resume when it opens them again. Plain channel
messages are never pushed, even at "All messages": that level governs
in-app notifications while the tab is open.

### Realtime: a poll woken by change events

The data plane is still polling: `GET /api/ws/:id/sync?since=ts` stays the
one source of truth, and nothing about its answer has changed. The worker
reads the activity doc (with the workspace, for membership, and the
caller's own member doc, for what they may see) and returns only entries
newer than `since`: which conversations advanced (unread bolding, mention
badges, and "fetch what is new" for the open conversation), who is present
(heartbeat every 30 seconds from a tab in view that was touched in the last
ten minutes, so a tab left open on a second screen neither reads "Active
now" for hours nor writes for nobody; measured against the worker's clock,
which every answer carries, not the device's; a tab in view sends its first
one with the bootstrap, so a member is present the moment the workspace
opens, and a closing tab leaves the word `off` beside its last heartbeat
with a keepalive `DELETE .../presence`, believed after five seconds so a
reload does not flicker), and version stamps that tell the client to
refetch the workspace doc or its own member doc when something structural
changed. An entry names who last wrote where and who is typing to whom, so
a poll carries only the caller's channels and direct messages and the
public channels they may browse; nothing about a direct message or a
private channel reaches anyone outside it. Three KV reads per poll (the
activity and member documents side by side, once the workspace has said who
is asking), the heartbeat's write awaited before the answer goes; small
deltas keep egress low. Typing rides along: `t.{conv}.{uuid}` is written by
the composer at most once every four seconds while someone types (and
removed when they send or stop), and the poll returns only entries fresher
than eight seconds, so a closed tab cannot leave a stuck indicator and a
quiet workspace sends nothing extra. A poll that finds the typing map grown
past twenty entries removes the long-expired ones, so it cannot accumulate
one key per member per conversation forever.

What changed is *when* a tab polls. Puter Events lets an account subscribe
to a change on a key-value region and be told about it over the same
session socket the app already holds; Teamchat uses that only to decide when
to poll sooner, never as a second source of truth, so a missed or duplicate
delivery is harmless. On every write worth waking up for — a message, an
edit, a delete, a reaction, a pin, an unfurl, a huddle starting, joining, or
ending, opening a direct message with someone, `bumpWorkspace`, a member
poked, the first write of a typing burst — the worker also writes a tiny
`{ t }` document to one to four **shard** keys, `tc:ws:{id}:ev:s0`..`s3`
(`src/shared/events.js`), batched into one call. A shard names nothing but a
bucket: never a conversation, a member, or a kind of change. Presence
heartbeats, typing refreshes after the first, and routine pruning never
signal — those keep to the cadence below on their own.
The worker only pays for a signal once the platform can actually deliver
one: nothing is written at all on a user-scoped worker (no app identity of
its own — nobody could ever subscribe to it, own mode or a handle), nor
while a cached verdict says `events.enabled` itself is off in this region
(the one refusal that blocks even the owner's own subscription; every other
refusal only ever blocks members, so it keeps signalling for the owner's
sake). Typing's `first` flag degrades gracefully across client versions: a
client too old to send it is treated as sending `first: true` on every
write, which an old client's own composer already rate-limits to one write
per few seconds per conversation, so it costs no more than that; a new
client marks only the burst's first write, and the worker takes anything
but an explicit `first: false` as one to signal on.

Two ways to watch a region, since the store lives in the worker's own
account (the one that deployed it — not necessarily whoever created a given
workspace: a shared worker, see below, can host workspaces created by other
accounts) and everyone else is a different account watching someone
else's data:

- **The owner** subscribes directly to their own namespace
  (`kv:<appUid>:tc:ws:{id}:ev:s{n}`) — no handle, no consent, and no extra
  platform flag beyond Events being on. As soon as that is true in the
  owner's region, their own tabs get the fast cadence.
- **Every other member** subscribes through a **KV share handle**: a region
  another account can grant a watch over. The worker mints one per member
  the first time it can (at join, and lazily at bootstrap), caches it on the
  member's own document, and never re-mints it (minting is rate-limited per
  owner account). This needs the owner's one-time consent — a bounded grant,
  `manage:kv-share:<owner>:<app>:tc:ws`, covering every workspace they will
  ever own — offered as a dismissible toast the first time the platform gives
  a definite answer that consent is still missing; while nothing has probed
  it yet, the question is left open for a later change to the workspace
  rather than spending the session's one chance on an answer that was never
  really given. Declining is remembered (`tcu:me`, `prefs.evConsent`), and
  the toast is never shown again — but Workspace settings says which of
  these states the workspace is in, in a **Live updates** row that carries
  the same switch, so an owner who waved the toast away can still turn it
  on later. The worker takes a member's handle back whenever their
  membership ends — removed, leaving, an external seat ending, a workspace
  deleted (a bounded batch of handles per request there) — so they stop
  receiving even the opaque shard pings and the slot they held frees for
  someone still here. Where the platform refuses (an older build, a
  withdrawn consent, the mint/revoke budget the two share), the grant stands
  until the owner revokes it from an actual Puter session, and while it
  stands it still says nothing but "a shard changed".

All of this needs the worker to run as the same Puter app as the tab talking
to it. A worker deployed from the app itself does; one deployed from the
Puter GUI or the CLI with a user token runs as an auto-created
`sandbox-<name>` app instead, and then every tab falls back to polling. A
share handle is bound to the app whose namespace it shares, so the worker
reads the caller's own token before minting and skips a member whose app
does not match, rather than spending one of the owner's live-handle slots on
a handle that can never be used — freed only once the owner revokes it.

However a tab is subscribed, a delivery (including a `gap` marker, which by
contract means "something happened, re-read") means exactly one thing: poll
soon, floored at 2 seconds so a burst of writes collapses into a single
poll. With a healthy subscription — this tab's own, *and*, for every shared
channel it has open, a healthy one on that host too (see "Shared channels"
below) — the classic 4-second cadence is replaced by a 20-second
floor-of-last-resort; a hidden tab still polls every 30 seconds regardless,
ignores deliveries outright, and drops its subscription after 60 seconds
continuously hidden, since a delivery a hidden tab ignores is one the
member's own account still paid for. Coming back into view re-applies
whatever the last bootstrap said, not only what was actually torn down: a
handle rotated or a region turned off while the tab was away is not left
standing as a subscription to a subject that is gone, and a backoff a tab is
still waiting out survives the hide, so a region with the feature off is not
asked again on every hide/show cycle. While someone is typing in the
conversation on screen the client polls every two seconds instead, exactly
as before.

Presence is the one exception, and deliberately so: a tab in view already
writes a heartbeat every thirty seconds whether or not anything else
changed, and signalling each one would be a KV write for nothing anyone is
actually waiting on, so presence heartbeats are never signalled. With a
healthy subscription everything else got faster, some of it by a wide
margin; presence alone did not, since it still rides the same poll it
always has — someone going active or away, a do-not-disturb toggle, a
member's tab arriving now takes up to 20 seconds to show up in someone
else's tab rather than the old 4, the same floor-of-last-resort every other
change gets as its worst case. The degradation detector has nothing to say
about it: it watches for changes of a kind the worker always signals
turning up on a plain poll with nothing delivered in between, and a
presence change was never one of those, so none of this looks like a
subscription gone quiet — it is one working exactly as intended.

The one failure mode events can't announce is a subscription that looks
live but has gone quiet — a shard past its ~50-watcher fidelity ceiling, a
grant revoked from the Puter GUI, a region where dispatch is off — so the
client watches for it itself: three consecutive safety polls (not poked, not
signal-driven) that turn up a change of a kind the worker always signals
fall back to the classic cadence for five minutes, then try again; any real
delivery resets the count. Every piece of this is feature-detected and
falls back to exactly today's polling with nothing else changed: no
`puter.events` in the SDK, Events or KV share handles off in the platform
region, no owner consent, a worker with no app identity of its own (a
user-scoped deployment), an app-uid mismatch, an old worker talking to a new
client (no `events` key) or the reverse (an unknown key, ignored) — every
row of that matrix ends the same way, polling exactly as it does today.

### Ring entries

A client whose bootstrap carries a `ring` block reads changes from events
instead of polling for them. The worker seals each conversation change
(a message, an edit, a reaction, a pin, a link card, a deletion, a reply's
count on its root, someone starting to type) into an entry and writes it,
with one counter `incr` and one batched `set`, to a slot of every ring shard
its audience falls in (8 shards for a public channel, the members' shards
for a private channel or DM). The tab watches its own shard
(`r{rs}:*`, with `includeValue`) and `o{rs}` instead of `s{n}`. Entries
apply straight to the open window, the activity stamps and typing, so a
change costs no request. `o{n}` is written only for what entries do not
carry (workspace and member documents, huddles, a mention's count), and
those still poll.

- **Keys.** Each conversation's root key is `HMAC(secret, ws, conv, ke,
  access)`. The secret lives in `tc:config.evs`, `access` is a private
  channel's member list, and `ke` is a workspace epoch bumped when someone
  loses access some other way (removed, made a guest, a guest or external
  leaving a public channel, a connection ending). The bootstrap hands out keys
  only for what the caller can read. Entries are AES-GCM under a key derived
  from the root and tagged with an opaque id, so other members on the shard
  see only that something changed and when.
- **Order and gaps.** Entries are numbered per shard. A missing number
  waits `RING_GRACE_MS`, then polls. So does a gap marker, or a value Events
  left out (over 16 KB, or over 128 matching subscriptions). The sync answer's
  `rn` says where numbering stands. Every entry is idempotent.
- **Scale.** 8 shards keep about 75 tabs on each at 300 members with two
  tabs each, under the 128 subscriptions past which values are dropped.
- **Compatibility.** `s{n}` is still written for every change, so tabs from
  before ring entries work unchanged. Without a `ring` block (an older
  worker or host), the client uses `s{n}` as before.

### Broadcast mentions

`@channel`, `@here` and `@everyone` are resolved in the worker at post time:
the channel's members (a public channel's from one member-document read per
workspace member, the same cost as listing them), those with a heartbeat in
the last five minutes, or the whole workspace. The message stores only the
kind (`bc`), never the expanded list, so a block stays small and a member
who joins later still sees it rendered as a mention. Fan-out bumps each
recipient's mention counter and appends to their activity inbox in parallel
batches, and pokes everyone with one multi-path write of the activity
document per fifty people; it is bounded by the workspace member cap of
500, which is the documented ceiling (about four writes per recipient).

### Scheduled delivery without a clock

A worker has no cron and no background timer, so a scheduled message or a
reminder is materialised by somebody's request: the sync poll. The queue
is one document per workspace, `tc:ws:{id}:sched`, a map by id, and the
earliest due time is kept as `nd` in the activity document the poll
already reads, so a poll that finds nothing due (nearly all of them) does no
extra work at all. When one has passed, the poll claims each due entry with
an atomic increment of its claim counter (only the poll that took it from
zero to one delivers, so two polls racing cannot both send), delivers it,
removes it, and recomputes `nd`. A scheduled message is delivered through
the same `postMessage` path as a live one, as its author, so mentions
notify, counters move, threads count, and the index is written; if the
author can no longer post there (removed, channel deleted or made
admin-only) the entry is dropped rather than sent elsewhere. A reminder
becomes an inbox entry and a line in the member's own space pointing back
at the message, and a reminder about a deleted message never fires.

Delivery is therefore bounded by whoever polls next, not by a clock: with
events healthy (see "Realtime" below) that is the 20-second safety floor,
worst case; the message a delivery writes then signals like any other post,
so every other open tab learns of it at once rather than waiting out its own
next poll.

### Huddles: media between the people, a roster on the worker

A huddle is a call, and a worker cannot carry one: it runs only while it
answers a request. So the audio and video of a huddle never touch the
worker. They go directly between the browsers of the people in it over
[Puter's Peer API](https://docs.puter.com/Peer/), which gives every
participant a WebRTC connection with the signalling and TURN relays taken
care of (the relays are metered to each person's own account, keeping the
user-pays model). The worker keeps only the roster:
`act.h[conv] = { by, at, m: { [uuid]: { at, j, inv, s } } }` in the activity
document the poll already reads, so the members of a conversation learn
about a huddle in progress there with the same poll that brings presence
and typing (a roster carries the invite codes its participants serve, so
only the conversation's own members are sent it), and
`src/shared/huddle.js` describes the shape for both sides.

Nobody hosts. Every participant runs a peer server of their own
(`puter.peer.serve()`) and posts its invite code to
`POST /api/ws/:ws/conv/:conv/huddle`, which takes the seat (starting the
huddle when nobody is in it, and posting the "started" line) and answers
with the roster. The newcomer then dials everyone listed
(`puter.peer.connect(invite)`); beyond that, when two participants both
know of each other and hold no link, the one with the greater id dials,
which also settles which connection stays when both dialled at once. Each
side's hello names the server it serves, so a second connection from an
account whose link is up, from a server other than the link's, is that
account's seat moving (to another tab, or served anew) and replaces the
link, while a goodbye on a link to one server means nothing once the
roster lists that account under another. The result is a full mesh, so
whoever leaves, the others stay connected, and there is no host to
migrate. Identity comes from the signaller, not from
the wire: a server learns who connected from `event.user.uuid`, a dialler
learns whose server answered from `conn.owner.uuid`, and a link carries
nothing until that account is one of the direct message's people or, in a
channel, a member of the conversation's workspace. On
each link the Puter data channel carries a small JSON protocol (hello,
state, signal, bye), and `src/lib/rtc.js` puts the mic, camera, and screen
tracks on the `RTCPeerConnection` under it, renegotiating over that same
channel (the "perfect negotiation" pattern, with the dialled side polite).
A link whose transport dies while the channel still looks open is noticed
by its connection state and dialled again.

The seat is kept by a heartbeat: the same `POST` every 15 seconds. A
participant not heard from for 90 seconds has left (their tab closed, their
network went), and the poll that notices takes them off the roster (longer
than a minute because a browser slows the timers of a tab hidden for a few
minutes to one wake-up a minute unless it holds a WebRTC connection, which
someone alone in a huddle does not; a tab coming back into view re-posts
its seat at once); when
nobody live is left, the same poll ends the huddle and posts the "ended"
line, claiming it first with an atomic increment kept beside the roster
(under the huddle's start stamp, so it outlives the entry's removal) so two
polls noticing together write it once. `DELETE .../huddle` leaves at once, and a
closing tab sends it on `pagehide` as a keepalive request, so the browser
lets it finish after the page. One seat per account, held by one tab: each
post names the tab (`sid`) and whether it is the join or a heartbeat, a
join takes the seat from another tab of the same account, and that tab's
next heartbeat is refused (`replaced`) rather than taking the seat back,
so the tab that joined last keeps it whichever beats first, and a leave
gives up only the leaving tab's own seat. Starting a huddle in a direct message
also writes an Activity entry for the others and sends them a push, under
the conversation's notification setting, so a call reaches someone whose
app is closed. Shared channels work the same way: the roster lives on the
channel's host, and the client routes the calls there like every other
write.

### Guests: a third rung

A guest is a member with `role: 'guest'` whose member document lists only
the channels they were invited to or added to. The rule is enforced where
data is returned, not only where actions are taken: `resolveConv` treats
every channel like a private one for a guest, so reads, posts, pins,
threads, search, inbox and the rest fall out of one check; the bootstrap
returns only their channels (never a channel's own invite code) and only
the members they share a channel with (a private channel's list, or one
member-document read per workspace member for a public channel, once per
bootstrap); a direct message involving a guest requires everyone in it
to share a channel with that guest, in both directions; a file is served to
a guest only if it was shared (attached or bookmarked) somewhere they can
read, which the file's record keeps track of; and a guest cannot rename,
re-topic, or re-bookmark the channel they are in. A broadcast, like a plain
mention, reaches only people who can read where it was posted.

### Shared channels: one channel, two workers

A channel shared with another workspace keeps living where it was created:
on its host workspace's worker, in its owner's account. The partner
workspace holds an **entry** for it (`channels[id].shared = { ref, ch, conn,
host }`: the host's reference, the channel's id there, the connection, the
host's name), with its own name, and its members take part on the host as
**external** members, a fourth role beside owner, admin, member, and guest.
An external member is a guest with a label: the same rule (`isLimited`)
scopes what they read to the channels they are in and the people in those,
their card carries `org: { ref, name }`, they cannot be given a role or
added to another channel, and the host's `/api/me` never lists the host
among their workspaces.

The two workers never talk to each other; the clients carry everything,
and a **connection** is what makes the host believe them:

1. The host's admin mints a share code (`POST .../channels/:ch/connect/invites`),
   a channel-scoped invite with `role: 'connect'`, same alphabet, expiry,
   and brute-force budget as any invite; `/api/join` refuses it, so a share
   link can never make a guest.
2. The partner's admin opens `#/connect/:server/:code`. Their app previews
   it (`GET /api/connect/preview`) and, on accept, calls the host
   (`POST /api/connect/accept` with the partner's reference and name),
   which mints a connection id and a 32-symbol secret and returns them
   once; the app then stores them on the partner's worker
   (`POST /api/ws/:ws/channels/shared`), which creates the entry. Accepting
   again for the same workspace renews the secret on the same connection.
3. A partner member joins the entry on their own worker
   (`POST .../channels/:ch/join`), which records it and hands back an
   **attestation**: `{ conn, uuid, kind: 'join', exp }` signed with the
   secret (HMAC-SHA256, ten minutes). The client presents it to the host
   (`POST /api/connect/join`), which checks the signature against the
   connection's secret and the uuid against the Puter identity of whoever
   is calling, then makes them an external member of that channel. A token
   is therefore only ever good for the person it names, for a few minutes.
4. The client then bootstraps and polls the host as that external member,
   beside its own workspace (`src/lib/store.js`, "shared channels"): one
   extra small read per poll for the host's owner, the cost of having
   another workspace in your channel. What the host says is folded into
   the store under local ids (the entry's id for the channel and its
   threads, `h_` plus the host's id for a direct message there), so the
   conversation UI reads a shared channel exactly as it reads a local one,
   and every write is routed back to the host by `store.hostOf()`. Activity,
   Threads, Later, and files inside the channel ask the host alongside.
   Direct messages on the host are carried this way for an external member
   only; someone who is a member of both workspaces has theirs in the host
   itself, and messaging a host member from the partner opens them there.

External membership **expires after a day** unless renewed: the host answers
`reattest` and the client silently gets a fresh attestation from its own
worker, which only signs for people who are still members there and still
in the channel. Someone removed from the partner workspace, or made a guest
there, loses their seat at once: the partner's worker answers the admin's
removal with a signed revocation per shared channel (`kind: 'revoke'`),
which the admin's app carries to each host (`POST /api/connect/revoke`);
the host ends the seat as a disconnect would and remembers the word for as
long as a join token lives, so a token signed before the removal seats
nobody. A host the app never reaches lets the seat lapse within a day, as
the attestation runs out; a cooperative client leaves the host at once. The other
way round, the partner keeps vouching: an external member the host's admins
remove is remembered (`ws.removed`, admins' eyes only) and `/api/connect/join`
answers `removed` to them until an admin restores them
(`DELETE /api/ws/:ws/removed/:uuid`) or they join the host in their own
right; their client shows the channel as closed to them and asks again on
its usual schedule, so a restore takes on its own. Either
side ends the connection: the host's admins with
`DELETE .../channels/:ch/connections/:conn`, the partner's admins with a
disconnect attestation (`POST /api/connect/disconnect`) followed by
removing the entry. Both let the partner's people go from the channel (and
from the host workspace, once they are in no shared channel there); what
they wrote keeps their name and their workspace's label, from the card of
people who left that the workspace keeps (`former`). The
partner's name and reference are what it says of itself, shown as such and
verified by nothing; the secret passes once through the accepting admin's
browser; a stolen secret lets its holder join the channel as themselves,
labelled with the partner, the way a leaked guest invite would, and
disconnecting revokes it.

Deliberately not done: pushes for shared channels (a device subscribes per
workspace, and a partner's members are not the host's), workspace-wide
search across hosts (search inside the channel works), and integrations
bound to a partner's entry (they are set up on the host). A workspace
exports its connections as they are and imports a copy unshared.

### Link previews, carefully

The browser cannot read another origin's `<meta>` tags, so the workspace's
worker fetches the page, which makes previews the one feature where the
owner's worker reaches the open internet. The sender's client asks for the
preview right after posting (`POST .../messages/:seq/unfurl`), so sending
stays fast; the result is stored on the message's overlay (`x.sN.uf`), so
it is computed once and identical for every reader, and it disappears with
the message. Guards: http and https only; loopback, private, link-local,
multicast, and `.local`/`.internal` hosts are refused, redirects are
followed by hand (at most three) with the same check at every hop, and no
caller header or cookie is forwarded. Budget: a five second timeout, the
body read only until `</head>` or 200 KB, at most 30 previews per member
and 300 per workspace every ten minutes, and a cache per URL
(`tc:unfurl:{sha256(url)}`, seven days; failures an hour) so a link shared
in five channels is fetched once. Links inside code spans and code blocks
are never unfurled.

Thumbnails are not hotlinked: a hotlinked image would leak every reader's
address to the target, so the worker stores a copy of images under 300 KB
in the owner's drive and serves it to members through
`GET /api/ws/:ws/unfurl-image/:hash`. That costs the owner a little storage
and protects readers, which is the trade the README recommends and the
settings switch explains. One limit is worth knowing: the runtime offers no
DNS resolver, so a public hostname that resolves to a private address
cannot be detected; the guards work on the URL and on every redirect.

### Invite security

Invite codes are 12 symbols from a 32-letter alphabet (2^60 possibilities),
generated with `crypto.getRandomValues`. Every guess needs a signed-in Puter
account, each account gets 8 failed attempts per 10 minutes before the join
route answers 429 without touching storage, codes expire (7 days by default,
admins choose 1, 7, or 30 when replacing one), and missing, expired, and
replaced codes all fail identically. An admin can also deactivate the
workspace link outright (`PUT /api/ws/:ws { revokeInvite: true }`): the code
dies and no new one exists until they mint it.

### Invitation emails: one shared sender

Workspace workers can never send email — outbound mail is a capability only
the app's developer holds, which is a platform security feature, not a gap.
So invitation emails go through **one** shared worker, `worker/email.js`,
deployed once by the developer (`npm run deploy:email-worker`, which runs
`puter worker deploy worker/email.js teamchat-email`; the client finds it at
`EMAIL_WORKER_URL` in `src/config.js`). The app calls it with
`puter.workers.exec()`, which forwards the signed-in sender's Puter token:
the worker's own token authorizes the send, the sender's pays for it, so the
developer never foots a spammer's bill. It is deployed by hand, not
auto-updated like workspace workers, so picking up a new puter.js runtime
means bumping `WORKER_VERSION` and re-running `npm run deploy:email-worker`.

It is not a relay. The caller hands over the *parts* of an invitation —
kind (`workspace`, `guest`, or `connect`), server, code, names, an optional
note — never a message or a URL. Subject, both bodies, and the one link are
composed in the worker; the link's origin must be somewhere the app actually
lives (puter.com, `*.puter.site`/`work`/`com`, or localhost in development)
or it falls back to the canonical app URL, names and the note are clamped
and HTML-escaped, newlines cannot reach a subject, recipients are capped at
10 per request and 100 per sender per UTC day (counted in the worker's own
KV under a SHA-256 of the sender's id — no addresses are stored anywhere),
and a caller with no Puter session gets 401. The invite dialog's Email tab,
the guest invite dialog, and the share-channel dialog all send through it;
when the worker is unreachable the UI says to copy the link instead, and
in the mock (`/mock.html`) sends are recorded to `__mock.emails()` rather
than delivered.

### Known limits

- Workspace members and channels live in one document, which is comfortable
  to several hundred members. Past that the members map should be sharded.
- Deleting a workspace removes its head blocks and the directory holding its
  attachments' bytes; deep tail blocks of very long conversations and the
  attachments' small metadata keys are left behind (they cost nothing to
  keep and are unreachable).
- Presence and notifications depend on polling cadence; expect a few seconds
  of latency.
- Search matches whole words, not prefixes or phrases, and a word that
  appears in more than 2,000 messages in one month only finds that month's
  newest 2,000. A rare word deep in a long history takes a few "Load more"
  steps: each call reads at most eight months back (a `before:` filter
  starts the count at the month it names).
- Indexing runs inside the request that posts the message; every fiftieth
  message also folds a log segment into the shards, so that one send takes
  a little longer than the rest.
- The worker revokes a member's KV share handle (see "Realtime" above)
  whenever their membership ends. When the platform refuses the revoke (an
  older build, a withdrawn consent, the mint/revoke budget), the grant stands
  until the owner takes it back from an actual Puter session, and someone
  removed goes on learning "a shard had activity at this time" (nothing more:
  no content, no conversation, no participant) until they do.
- The platform caps live handles per app namespace and per plan (its
  rate-limits page has the numbers); revoking frees the slot, so the
  ceiling tracks an owner's current members across their workspaces rather
  than everyone who ever joined. Past it, minting answers 409 and those
  members fall back to polling — graceful, but real.

## API (worker routes)

All routes except `/health`, `/webhook/:token`, and `/bot/:token/...`
require a Puter session (via `puter.workers.exec`). The token routes take
no session: the token is the credential (`tch_{id}_{secret}` for webhooks,
`tcb_{id}_{secret}` for bots; only a hash of the secret is stored, compared
in constant time), each token is limited to 60 calls a minute, and bodies
over 16 KB are refused before anything is read from storage. Errors are
`{ error, code, message }`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness and build id (no session needed) |
| GET/PUT | `/api/server` | build, ownership, `open` flag, and (owner only) events consent status; PUT accepts `{ open }` and `{ events: true }` |
| GET/PUT | `/api/me` | the caller's card (name, title, color, status) and workspace list on this worker |
| POST/DELETE | `/api/me/avatar` | upload or remove the caller's photo on this worker (PNG, JPEG, WebP, up to 300 KB) |
| GET | `/api/ws/:ws/members/:uuid/avatar` | a member's photo, for members of the workspace |
| POST | `/api/workspaces`, `/api/workspaces/sample` | create a workspace, or the demo (owner only) |
| POST | `/api/join` | join with an invite code (body may carry the caller's profile card) |
| GET/PUT/DELETE | `/api/ws/:ws` | bootstrap (carries `events` when a change-event subscription is available), rename, rotate invite, `unfurl` on/off, delete |
| GET/POST/DELETE | `/api/ws/:ws/icon` | the workspace's icon; admins upload (PNG, JPEG, WebP, up to 300 KB) or remove it |
| GET | `/api/ws/:ws/sync` | activity delta, presence heartbeat, who is typing |
| DELETE | `/api/ws/:ws/presence` | the tab is closing: its person is away from now |
| GET/POST/DELETE | `/api/ws/:ws/push/key`, `/api/ws/:ws/push` | this worker's VAPID public key; register or remove this device's push subscription |
| POST | `/api/ws/:ws/conv/:conv/typing` | "I am typing here" (`{ first: true }` on the burst's first write, or `{ stop: true }`), one path write |
| POST/DELETE | `/api/ws/:ws/conv/:conv/huddle` | take or keep (every 15 s) a seat in the conversation's huddle under one's peer `invite`, starting it when nobody is in it; leave it, the last one out ending it |
| POST/DELETE | `/api/ws/:ws/members/:uuid[/role]` | roles, remove, leave |
| POST/PUT/DELETE | `/api/ws/:ws/channels[/:ch]` | create, edit (name, topic, description, `postPolicy`, `threadPolicy`, `broadcast`, `bookmarks`), archive, delete |
| POST | `/api/ws/:ws/channels/:ch/join`, `.../leave`, `.../members` | membership (admins add guests to public channels) |
| POST/DELETE | `/api/ws/:ws/channels/:ch/invites` | admins: mint or revoke the channel's guest invite |
| POST/DELETE | `/api/ws/:ws/channels/:ch/connect/invites` | admins: mint or revoke the link that shares the channel with another workspace |
| GET | `/api/connect/preview` | what a share code leads to (`code`), for the admin deciding to accept |
| POST | `/api/connect/accept` | a partner's admin accepts a share code for their workspace (`code`, `partner: { ref, name }`): mints the connection and returns its secret once |
| POST | `/api/connect/join` | join the shared channel on its host with an attestation from one's own worker (`conn`, `token`, optional `profile`) |
| POST | `/api/connect/disconnect` | the partner ends the connection with a disconnect attestation (`conn`, `token`) |
| POST | `/api/connect/revoke` | the partner's word that one of its people is out (removed, or made a guest): a revocation attestation (`conn`, `token`) naming them; the host ends their seat in the shared channel |
| DELETE | `/api/ws/:ws/channels/:ch/connections/:conn` | host admins: disconnect a workspace from the channel |
| DELETE | `/api/ws/:ws/removed/:uuid` | host admins: let someone they removed from the shared channels come back through their workspace |
| POST | `/api/ws/:ws/channels/shared` | partner admins: record a connection as an entry for the host's channel (`ref`, `ch`, `conn`, `secret`, `name`, `host`) |
| POST | `/api/ws/:ws/channels/:ch/attest` | a signed attestation towards the host for the caller (`kind`: `join`, or `disconnect` for admins) |
| GET | `/api/ws/:ws/guests` | admins: guests and the channels they see |
| GET | `/api/ws/:ws/export` | admins: the archive, a page of blocks per call, resumable by cursor |
| POST | `/api/workspaces/import`, `/api/ws/:ws/import`, `.../import/file`, `.../import/finish` | recreate a workspace from an archive on this worker (owner only), then its messages, files, and open it |
| POST | `/api/ws/:ws/transfer`, `.../transfer/begin`, `.../transfer/cancel`, `.../transfer/complete` | owner nominates an admin; the nominee's app freezes writes for the move (`sid` names the session; renewed with the same call), lets them go if the move fails, and marks the copy as moved to a new reference |
| GET | `/api/ws/:ws/channels/:ch/members` | who is in a channel |
| POST | `/api/ws/:ws/dms` | open a direct message |
| GET/POST | `/api/ws/:ws/conv/:conv/messages` | read a page (`before`, `after`, `from`/`to`), post |
| PUT/DELETE | `/api/ws/:ws/conv/:conv/messages/:seq` | edit, delete |
| POST | `/api/ws/:ws/conv/:conv/messages/:seq/reactions` | toggle a reaction |
| POST/DELETE | `/api/ws/:ws/conv/:conv/messages/:seq/unfurl` | build (or remove) the message's link preview |
| GET | `/api/ws/:ws/unfurl-image/:hash` | a preview's stored thumbnail, members only |
| POST | `/api/ws/:ws/conv/:conv/read` | move the read cursor |
| PUT | `/api/ws/:ws/conv/:conv/notify` | the caller's `level`, `mute`, and (threads) `follow` |
| GET/POST/DELETE | `/api/ws/:ws/conv/:conv/pins[/:seq]` | list (with messages), pin, unpin |
| GET | `/api/ws/:ws/inbox`, `/api/ws/:ws/threads`, `/api/ws/:ws/saved` | the Activity, Threads, and Later lists, with messages attached |
| POST | `/api/ws/:ws/inbox/read` | clear the Activity badge |
| POST | `/api/ws/:ws/saved` | save (`conv`, `seq`), toggle `done`, or `remove` |
| POST | `/api/ws/:ws/scheduled`, `/api/ws/:ws/reminders` | schedule a message (`conv`, `text`, `attachments`, `dueAt`), set a reminder (`conv`, `seq`, `dueAt`, `note`) |
| GET/PUT/DELETE | `/api/ws/:ws/scheduled[/:id]` | the caller's pending items; edit `text`, `dueAt`, or `sendNow`; delete |
| GET | `/api/ws/:ws/search` | search (`q`, `in`, `from`, `has`, `before`, `after`, `cursor`) |
| POST | `/api/ws/:ws/search/reindex` | admins: build the index over existing history, one bounded step per call |
| POST/GET/DELETE | `/api/ws/:ws/files[/:id]` | upload, download; the uploader removes a file nothing names yet (picked into the box and taken out before sending) |
| GET/POST | `/api/ws/:ws/webhooks`, `/api/ws/:ws/bots` | admins: list integrations, create one (the token is in the response and nowhere else) |
| POST/DELETE | `/api/ws/:ws/webhooks/:id/rotate`, `/api/ws/:ws/webhooks/:id` (and `bots`) | rotate or revoke; `PUT /api/ws/:ws/bots/:id` changes channels and scopes |
| POST | `/webhook/:token` | **no session**: post `{ text }` (or a blocks/attachments payload, as JSON or as the `payload=` field of a form-encoded body) to the webhook's channel |
| GET/POST | `/bot/:token/channels/:ch/messages`, `POST .../messages/:seq/reactions` | **no session**: a bot's channels, within its scopes |

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
```

`npm run dev` builds the worker bundle first (the app serves it from
`public/worker/`, which is git-ignored) and then starts Vite. Two ways to run
the UI:

- **`/mock.html`** runs the real worker code in the page against a
  localStorage-backed fake KV, with no Puter account needed. It fakes
  `puter.kv`, `puter.fs`, `puter.workers`, and `puter.peer` (real
  `RTCPeerConnection`s between tabs, signalled over a `BroadcastChannel`, so
  two mock users can huddle; `?fakemic=1` stands in a tone and a canvas for
  the microphone and camera, so no device permission is needed), so each mock user deploys
  their own fake worker exactly as a real user would, and every fake worker
  sees its own slice of the store. Tabs share the store: open
  `/mock.html?as=alice` and `/mock.html?as=bob` side by side, create a
  workspace as alice, paste the invite as bob, and watch messages, presence,
  and unread state flow. `?reset=1` wipes everything; `?env=app` simulates
  running inside Puter; `?shared=1` runs the single-shared-worker mode.
- **`/index.html`** uses the live Puter SDK: sign in, create a workspace, and
  a real worker is created in your Puter account.

To populate the app for a demo, sign in and wait for it to load, then run
this in the browser console (available in development and deployed builds):

```js
await teamchat.populateSampleData()
```

This creates and opens a new **Northwind Studio** sample workspace with six
fictional teammates, six channels, message history, threads, reactions, and
direct messages. It returns the workspace's `id`, `name`, and `sample` flag.
Each completed call creates a fresh workspace; existing workspaces are left
intact. The data persists across reloads. Delete it through the sample
workspace's settings when finished. On `/mock.html`, it uses local mock
storage; with the live SDK, it creates the sample in your account, deploying
your workspace worker if needed. Normal workspace limits still apply.

The test suite boots the worker against the same fake runtime and covers the
routes end to end (block boundaries, concurrent senders, permissions, server
ownership, profile seeding, threads, mentions and read cursors, DMs, files,
search and its index, the sample workspace), plus units for block math, ids,
references and invite parsing, formatting and escaping, search tokenizing
and query parsing, time grouping, and routing.

## Deploying

After changing the root `icon.png`, run `npm run build:icons` (requires
ImageMagick's `magick` command) and commit the generated files in `public/`.
This updates the favicon, sign-in and splash artwork, notification icon,
Apple touch icon, and manifest icons, including the padded maskable version.

There is nothing to deploy but the static app:

```bash
npm run build               # worker bundle -> public/worker/, app -> dist/
```

`dist/` is fully static with relative paths and includes the worker bundle,
so it can be hosted anywhere, including Puter's own hosting
(`puter.hosting`). Users create their own workers from it; when you ship a
new build, owners' workers update themselves the next time those owners open
the app (see *Keeping workers up to date*).

The one exception is invitation email: the shared sender is deployed once,
by the developer, under the account that holds the email capability
(see *Invitation emails: one shared sender*):

```bash
npm run deploy:email-worker # puter worker deploy worker/email.js teamchat-email
```

Without it the app still works — the email tab and "Or email it" rows
simply report that email is unavailable and point at the copyable link.

### Optional: one shared worker

To run a single worker everyone creates workspaces on instead:

```bash
npm run build:worker        # -> public/worker/teamchat-worker.js
npm install -g @heyputer/cli
puter login
puter worker deploy public/worker/teamchat-worker.js my-teamchat
```

Then, signed in as the deploying account, `PUT https://my-teamchat.puter.work/api/server`
with `{ "open": true }` (through `puter.workers.exec`), and build the app
with `VITE_WORKER_URL=https://my-teamchat.puter.work` or open it once with
`?worker=https://my-teamchat.puter.work` (remembered in localStorage;
`?worker=` clears it). To ship changes, overwrite the same file; do not
create a second worker, or callers end up split across two stores.

Events signalling (see "Realtime" above) keys `own` mode on the *deploying*
account, not on whoever created a given workspace here: a workspace's creator
gets `mode: 'own'` only when they are also who this worker was deployed as;
every other workspace creator on a shared worker gets a KV share handle like
any other member. `puter worker deploy` from the CLI signs in as a user, so
the worker gets its own `sandbox-my-teamchat` app rather than the app the site
runs as, and no tab gets events at all there (see "Realtime" above). Workspace
settings says so for the owner now, in its **Live updates** row: the worker
and the tab are running as different apps, and the two have to match. A worker
whose token carries no app at all — no `sandbox-` one either — gets its own
sentence there. Either way what fixes it is a worker deployed from Teamchat
itself: a worker's app identity is settled once, when it is created, so
overwriting the file it runs will never change it.

---

Powered by [Puter](https://developer.puter.com).

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
