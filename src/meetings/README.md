# Puter Meetings

**Live app:** [meetings.puter.com](https://meetings.puter.com/)

A Google Meet-style video meeting app built **entirely on [Puter.js](https://docs.puter.com)** — no backend servers, no frontend frameworks. Realtime communication runs over the **Puter Peer API** (WebRTC data channels with Puter-managed signaling and TURN relays), and audio/video flows peer-to-peer between participants.

## Features

- **Instant meetings** — start a meeting and get a shareable link/code.
  Once the app knows you (signed in, name entered once) **Start an instant
  meeting** drops you straight into the call, Meet-style — the green room
  is for checking how you look before others see you, and a brand-new
  meeting's host is alone in it. Devices come up on the way, under the same
  saved preferences, and everything the green room offered is in the
  meeting's settings
- **Persistent meeting links** — Meet-style `abc-defg-hij` codes that don't
  expire and cost nothing to mint: create a meeting for later, put the link
  in a calendar invite, and meet whenever. Behind every link is one record
  in one place — the **room directory**, a Puter Worker with a central
  key-value store (see [How it works](#how-it-works)) — so the link always
  says exactly one thing about what is running. **First to arrive hosts**: a
  signed-in Puter user who clicks Join while nothing is running is simply
  in the meeting, as its host — no "waiting for the host" for a host who
  could be them. Guests without a Puter account wait in a green-room lobby
  and join automatically the moment the meeting starts (or sign in and
  start it themselves)
- **The meeting outlives its host** — when whoever started it leaves, the
  remaining participants elect a new host between themselves and the call
  carries on uninterrupted; the link follows the host role. And when a
  link's meeting isn't running, anyone holding it can start the next one —
  there is no owner
- **Stateless links for other apps** — a calendar (or anything else) can mint
  a working meeting link with zero API calls: generate 12 random letters,
  build the URL, done. The room springs into existence when the first
  signed-in visitor clicks Join (see [Minting links from other apps](#minting-links-from-other-apps-stateless))
- **Your meetings, on the home screen** — inside the Puter desktop the home
  screen lists the day's meetings from the
  [Calendar](https://calendar.puter.com) app, Google Meet-style: a week strip
  to pick a day, what is still to come and what is over, a **Join** button on
  each, and the next meeting ahead when the day is empty — so nobody has to
  dig a link out of an email again (see
  [Your meetings, from Calendar](#your-meetings-from-calendar))
- **Green room** — camera/mic preview, device pickers, and name entry before joining (and before a first instant meeting, so the name gets chosen)
- **Group calls** — full-mesh audio/video between all participants
- **Bandwidth-adaptive video** — outgoing bitrate/resolution/framerate scale with call size, preferring smooth motion over resolution
- **Background blur & virtual backgrounds** — on-device person segmentation
  (MediaPipe selfie segmentation, WASM) feeds a WebGL2 compositor that
  upsamples the mask with a joint bilateral filter, so edges land on real
  image edges rather than the mask grid, blurs only background pixels so
  you never smear into your own backdrop, and light-wraps the background
  onto your outline: blur your room, or replace it with a bundled scene or
  your own image
- **Noise suppression** — on-device ML denoising (GTCRN, WASM) cuts
  keyboards, fans, and traffic on top of the browser's built-in
  filtering; on by default, toggleable in Settings
- **Screen sharing** — presentations get their own auto-pinned tile
- **Picture-in-picture** — float the meeting over other windows while you
  work in another tab: a mini stage with the tiles that matter (pinned
  presentation, whoever is talking) plus mic, camera and leave. The call
  never moves — the window is a second view of the same streams. It closes
  when you come back to the meeting tab, and in Chromium it opens again on
  its own the next time you switch away (automatic picture-in-picture).
  Inside the Puter desktop, where the app runs in a frame that browsers
  won't open such a window from, the desktop opens it for us
  (`puter.ui.requestPictureInPicture()`) and loads our `pip.html`, which
  reaches back into the meeting's frame for the same streams
- **In-call chat** — with unread badges and toasts
- **Reactions** — floating emoji, visible to everyone
- **Hand raising** — with a raised-hands section in the People panel
- **Active-speaker highlighting** — WebAudio level detection with hysteresis
- **Pinning & layouts** — auto grid + spotlight w/ filmstrip, animated transitions
- **Meeting info panel** — copy link/code; the host also sees how the link
  is doing (working, refreshing, can't be updated, in use by another
  meeting), fed by the directory's answer to every heartbeat
- **Device switching mid-call** — mic, camera, and speaker (`setSinkId`)
- **Dark & light themes** — follows the OS by default, one-click override
- **Responsive** — desktop side panels become mobile bottom sheets; touch-friendly controls
- **Keyboard shortcuts** — `⌘/Ctrl+D` mic, `⌘/Ctrl+E` camera, `Esc` closes panels
- **Join/leave/message sounds**, post-call screen with rejoin, and more

## Getting started

```bash
npm install
npm run dev        # http://localhost:6767
npm test           # vitest suite
npm run build      # production build in dist/
```

> **Joining needs no Puter account — or session.** A guest opens the link and
> is in the call: no popup, no CAPTCHA, nothing created on their behalf. They
> join with `puter.peer.connect(invite, { anonToken, turnGrant })` — an
> anonymous token that names them to the signaller for the session, and the
> host's **guest grant** (`puter.peer.createGuestGrant()`), which lets someone
> without a session use the Puter-managed TURN relays on the host's account.
> The host writes the grant next to the invite in the room directory, hands
> it to guests again in `WELCOME`, and renews it every half hour (`GRANT`), so
> a redial or a guest↔guest link hours into a meeting still gets a relay. A
> mint that fails is tried again after 5 s, then 15 s, then every minute —
> and at once when the browser comes back online — and while no grant is in
> force the host is told that guests without an account may not get in. Relay
> traffic guests send is metered to the host, at the host's own rate. Starting
> a meeting still asks for a sign-in: the host serves the room and pays for
> its relays (the directory itself needs no account — a room code is the
> capability, as the link already is). A guest who *is* signed in simply
> joins on their own account (`src/lib/account.js`).
>
> One-time links from older deploys have no room to carry a grant, so a guest
> without a session on one of those still gets a session the old way — Puter
> creates a full account for them via `signIn({ attempt_temp_user_creation:
> true })`, with nothing typed and no form shown.

## How it works

```
        room/control: host star              media: Puter peer mesh
        ┌──────────────────────┐          ┌──────────────────────┐
        │       Host A         │          │  A ◀━ puter.peer ━▶ B│
        │  puter.peer.serve()  │          │  ▲                ▲  │
        │  code = inviteCode   │          │  ┗━━━┓        ┏━━━┛  │
        └──────▲───────▲───────┘          │      ▼        ▼      │
   connect()  │       │  connect()       │          C           │
        ┌─────┴──┐  ┌──┴─────┐            └──────────────────────┘
        │ Guest B│  │ Guest C│       (B/C temp invite code relayed via A)
        └────────┘  └────────┘
```

1. **Persistent rooms** — peer invite codes can't be chosen or reused, so a
   meeting's shareable code is a stable room code (`abc-defg-hij`), and one
   level of indirection maps it to whatever invite is live *right now*: the
   **room directory**, a Puter Worker (`worker/rooms.js`, deployed at
   `puter-meetings-rooms.puter.work`) with the worker's own key-value store
   behind it. A room is one record there — `GET /v1/rooms/:code` says what is
   running (a live entry, or nothing), `POST` claims or renews it, `POST
   …/end` releases it — written and read in one place, judged fresh by one
   clock (the worker's: a client never compares its clock to anyone else's),
   with nothing to propagate, no edge cache, no copy that can lag another,
   and no account that has to own anything (`src/lib/rooms.js`). Guests poll
   it from the lobby (one ~60 ms read every few seconds; every couple of
   seconds while a meeting is being set up or is running but out of reach,
   and at once when a background tab comes back into view), then dial the
   invite it names. The host writes its invite the moment its server is up
   and **heartbeats** every 20 s on a timer that keeps its cadence in a
   hidden tab (a shared ticker `Worker` — Chrome runs a hidden page's own
   timers once a minute after a couple of minutes, and a host waiting alone
   is exactly the host most likely to switch tabs, `src/lib/timers.js`); an
   entry not renewed for 60 s is gone, so a host whose tab died holds nothing
   for long. A host's invite lives only as long as puter.peer's signaller
   socket, and the signaller mints a code per socket: when the socket dies (a
   signaller restart, a network blip) the invite dies with it while the call
   in progress carries on over its own transport, none the wiser. So the host
   follows the library's `reconnect` to the new code at once and, for as long
   as it hosts, dials its own invite every 15 s — told "Invalid invite code"
   outright it serves a fresh room on the spot, hearing nothing back twice,
   likewise — and every new code goes straight to the directory and to
   everyone in the call, so a link that would otherwise be quietly burned
   heals itself without touching the call (`src/net/session.js`). A guest in
   the lobby who dialed the old code writes it off for a minute and keeps
   reading; the new one is in the directory within seconds.
2. **The lease** — the record is a lease, not a lock. The first host to write
   claims the room under a **meeting secret** it chooses; every later write
   repeats it, and a write under another secret is refused (409 `held`)
   while the lease is fresh — *with the live entry*, so the loser joins that
   meeting instead of hosting a second one. That is how two people who click
   Join in the same breath end up in one meeting: the room is claimed
   *before* either serves (the directory shows it as "starting" for up to
   20 s), the second claim is told whose it is, and a claim that lands in the
   same instant as another is settled by a read-back — whoever's write stands
   holds the room, and every new holder checks again two seconds later,
   while it is still alone. The secret is the meeting's, not the host's: it
   travels to every participant in `WELCOME`, so when the host role moves,
   the successor simply carries the lease on (same record, same
   `startedAt`, term +1). Only the last participant to leave releases the
   room (a beacon on the way out of a closing tab); everyone else leaves the
   entry for the successor, or for the 60 s to take it. A host whose
   heartbeats are refused sees "In use by another meeting" in the info
   panel: alone, it moves over to that meeting on the same media; with
   people in its call it stays, keeps heartbeating, and takes the link back
   the moment the other meeting ends.
3. **Room topology** — the host creates the meeting with `puter.peer.serve()` and publishes its invite code under the room code. Guests join the room with `puter.peer.connect(invite)` and keep that connection to the host (`src/net/session.js`).
4. **Relay** — the host fans out chat, reactions, state, and stream metadata to the other guests (`FROM{id}` envelopes), and routes targeted guest↔guest Puter link invites (`TO{to}` → `FROM{id}`), validated by a small wire protocol (`src/lib/protocol.js`).
5. **Media** — audio/video/screen tracks are added to Puter-owned peer connections. Host↔guest media uses the existing room connection; guest↔guest media uses temporary `puter.peer.serve()` invite codes exchanged through the host, then renegotiates over that direct Puter data channel (`src/net/rtc.js`). A link whose network path dies mid-call (a Wi‑Fi switch, NAT rebinding, a lapsed TURN allocation) never *closes* — the data channel just stops delivering — so each link also watches its own transport and, once it is gone, is rebuilt on a fresh Puter connection: a guest dials the host again, the side that served a guest↔guest link serves it again, and the participant keeps their place in the roster while the tile shows *Reconnecting…*; chat that could not get through meanwhile is delivered once the link is back.
6. **Preferences** — name, theme, and device choices persist locally and sync through `puter.kv` for signed-in users (`src/lib/prefs.js`).

**The host role migrates.** All signaling goes through the host, but the meeting doesn't end when that host leaves: the survivors elect the one with the lowest participant id — among those with a Puter account while any is left, since only an account can mint guest grants; failing that, an anonymous guest takes over and the meeting carries on for everyone in it — it serves a fresh room for newcomers, and it floods a `HOST_CLAIM` across the mesh. Anyone who already has a direct link to the new host simply promotes that link to be their host link, so nothing is renegotiated and media never stops; anyone without one dials the invite the claim carries. The new host then writes the room's live invite to the directory under the meeting secret it was welcomed with — an anonymous host included — so the link keeps working for people still arriving. `term` counts migrations, and a claim is only honoured by a participant whose own host link has actually gone, so one guest losing touch with a healthy host can't tear the meeting apart.

The meeting only truly ends when the last participant leaves. After that the link is still live: anyone holding it can start the next session from the lobby — and anyone with a Puter account does so just by clicking Join; there is no owner. A visitor with no account waits instead: hosting takes an account, and the sign-in is a popup that browsers only allow from a click, so for them it sits on a "Start this meeting" button. And the lobby says what is actually going on: a meeting whose entry is fresh but whose invite cannot be dialed is *running* — the guest is told so ("The meeting is running… connecting you"), a dial that dropped quickly is tried once more after 5 s before the invite is written off, an "Invalid invite code" is written off at once (the host is already replacing it), a dial that never reached Puter's signaller at all — the guest's own network, or an outage there that hits the host just the same — is no verdict on the invite and is dialed again with backoff while the guest is told it is the connection service that cannot be reached, a dial the signaller took and the host answered whose transport never came up (ICE found no path: no relay reachable, a symmetric NAT, a corporate network) is the guest's own network, and they are told so — try another network or a phone hotspot, or have the host check that guests can use relays — rather than left "connecting" for something waiting cannot fix, and after 45 s out of reach the guest is told to ask the host to re-share the link — instead of "Waiting for the host" while the host sits right there. While a running meeting is out of reach the lobby polls every couple of seconds (the host's republish is about to land) for two minutes before settling back to its usual 4.5–6 s, and it polls the moment a tab that was in the background comes back into view, since browsers throttle a hidden tab's timers. A **Try again** button sits next to *Stop waiting* for as long as a running meeting is out of reach: it wipes what the lobby holds against every invite and dials at once, so a wrong guess on the lobby's part never leaves the guest with nothing to do but reload. Two people who click Join within a few seconds of each other both find nothing running — and the directory lets exactly one of them claim the room; the other is told whose meeting it is and dials it (see *The lease* above). Links from older deploys (raw invite codes) still join directly, with the old one-time semantics — their shareable code follows the host when the role moves.

## Minting links from other apps (stateless)

Any app can hand out working meeting links — calendar events, emails,
booking pages — **without talking to this app or to any API**. Mint an
*open room code*: 12 random lowercase letters grouped `abcd-efgh-ijkl`
(distinct from the app's own 10-letter codes), and wrap it in the meeting
URL:

```js
function mintMeetingLink() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const limit = 256 - (256 % letters.length); // rejection sampling — no modulo bias
  let code = '';
  while (code.length < 12) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    if (byte < limit) code += letters[byte % letters.length];
  }
  return `https://meetings.puter.com/#/m/${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}
```

Semantics, so you can set expectations in your UI:

- The link is inert until first use: nothing is created anywhere at mint
  time. A signed-in Puter user who opens it while nothing is running starts
  the meeting just by clicking Join; guests without an account wait in the
  lobby and join automatically once it starts.
- **Nobody owns the link.** Whoever starts the meeting — from Join, or from
  the lobby's "Start this meeting" button for someone who had to sign in
  first — holds the room for as long as that meeting runs (concurrent
  starters are settled by the directory: one hosts, the rest join). Any
  later session can be started by anyone holding the link.
- Letters must be crypto-random: the code's 56 bits are what keep links
  unguessable and collisions between uncoordinated minters negligible.
- One link per recurring event is fine — the code never expires.

## Your meetings, from Calendar

Inside the Puter desktop, the home screen's illustration gives way to
**Your meetings**: the calendar events that carry a meeting link, for the
day picked on a week strip — today by default. Each row shows the time, the
title, how many guests, and a **Join** button that opens the green room for
that link's room (a link to some other service opens in a new tab instead). A
running meeting is badged *Now*; finished ones slide down to *Earlier today*.
An empty day is never a dead end: it points at the next meeting anywhere
ahead, and one click jumps there.

The list comes from the Calendar app over its
[app-to-app API](https://github.com/HeyPuter/calendar.puter.com#app-to-app-api)
(`src/lib/calendar.js`): we launch the Calendar headless in service mode —
`puter.ui.launchApp({ name: 'calendar', args: { service: 'calendar-api' },
background: true })` — and ask it, over the `AppConnection` that comes back,
for `list` with `has: ['meeting']`. The Calendar identifies us from what the
desktop stamps on the window it launched, and our grant there is read-only
and *scoped*: `list`, over events that have a meeting link. The dentist
appointment never crosses the connection — the Calendar filters before it
answers, whatever we ask.

What keeps it cheap, and fast (`src/lib/agenda.js`, `src/ui/agenda.js`):

- **One read covers four weeks.** The first read asks for today's week and
  the three after it, so today, the next few clicks of the strip and the
  "next up" hint all come from one launch of the Calendar. Only a week
  outside that window costs another read, and only the first time.
- **The last answer paints first.** Launching another app takes a second or
  two, so the previous list is kept in `localStorage`, scoped to the
  account, and painted immediately with an *Updating…* note while the
  Calendar is asked again. Signing out clears it.
- **Fresh when it matters.** The list is re-read when the window comes back
  to the front and the list is more than a minute old — "I just added it in
  Calendar and switched back" — and on the refresh button; a failed read
  keeps the list on screen and says the update failed. A Calendar that can't
  be reached is retried with a doubling backoff, which the refresh button
  lifts.

On the open web there is no desktop to launch anything into, so the
illustration stays, with a line saying where the list lives. The rest of the
app is unchanged: nothing about a meeting depends on the calendar that
scheduled it.

## Project layout

```
src/
  lib/        pure logic: protocol, roster, layout math, codes, the room
              directory client and lease, prefs, the Calendar API client
              and the home screen's agenda logic, …
  net/        media devices, RTC media links, mesh session, audio levels
  ui/         views (home, prejoin, meeting) + tiles, panels, picture-in-picture,
              the "Your meetings" panel, …
  styles/     design tokens + per-view CSS (light/dark via CSS variables)
worker/       the room directory — a Puter Worker (rooms.js), deployed with
              `npm run deploy:worker` (`puter worker deploy`, @heyputer/cli)
tests/        vitest suites for the pure-logic modules, the worker (+ jsdom UI tests)
```

The directory worker is deployed once, under the name `puter-meetings-rooms`
(its URL is what `src/lib/rooms.js` points at; `VITE_ROOMS_ORIGIN` overrides
it for a local or staging deploy). Later deploys overwrite the file behind
the same name and URL. Its key-value store is the `sandbox-puter-meetings-rooms`
app's; `puter kv connect puter-meetings-rooms` opens a shell on it.

A push to `main` that changes `worker/` redeploys it through
`.github/workflows/deploy-meetings-worker.yml` (secrets `PUTER_API_TOKEN` and
`MEETINGS_WORKER_PATH`, the Puter file the worker serves from).

## Testing

536 tests cover the wire protocol, meeting-code parsing, persistent rooms
(code minting/normalization, the directory client, the lease — claim,
check, heartbeat, refusal, takeover, release — and the directory worker
itself, run against a stand-in for the Workers runtime), grid/spotlight layout
math, roster semantics, anonymous joining (guest grants minted, written to
the directory, renewed and carried on every dial), the lobby (a signed-in
visitor who finds nothing running claims and starts the meeting from Join, a
visitor without an account waits, a claim refused sends the visitor to the
meeting that got there first),
speaking-detection hysteresis, background-effect specs,
picture-in-picture (which tiles a postage-stamp window carries, the
window's own lifecycle, and the desktop-hosted window inside Puter), the Calendar API client (launch, handshake, idle
close, backoff) and the home screen's meeting list (day picking, read
windows, the local snapshot, and the panel itself under jsdom),
time formatting, the reactive store, DOM/theme helpers, local devices (a
toggle or a device pick that lands while an earlier one is still opening, a
camera or microphone that goes away mid-call, background effects), and the
meeting session
itself — mesh
formation (including simultaneous join waves), chat/state propagation, host
migration (takeover, promoted links, dial-in, split elections, the meeting
secret handed on so the successor carries the lease), a host healing its own
invite when the signaller drops it, a successor giving up a survivor it
never gets a link to, and leave handling run
against an in-memory mock of the Puter Peer API:

```bash
npm test
```

Camera/permission flows and the live Puter Peer API are exercised manually —
open two browser profiles, start a meeting in one, and join with the link in
the other.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
