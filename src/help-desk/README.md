# Help Desk

**Live app:** [help.puter.com](https://help.puter.com/)

An open-source help desk for answering customer requests as a team: a shared ticket inbox, a help center where customers find answers and send requests, macros, automations, service level targets and reports. It is an open-source alternative to Zendesk, Freshdesk and Intercom, and it runs on [Puter](https://puter.com), so every help desk's data lives in its owner's own Puter account.

> Help Desk is in early alpha. Expect changes, and do not rely on it for real customer support yet.

## Features

- **Tickets**: statuses (new, open, pending, on hold, solved, closed), priorities, types, groups and assignees, followers, CCs, tags and custom fields. Public replies and internal notes in a rich text composer with attachments. Merge, spam and trash with undo. Problem and incident linking. Every change is recorded in an event trail.
- **Workspace**: ticket tabs, Home with your work, Views with live counts, sorting, grouping, bulk edits and Play mode, global search with `field:value` filters, and in-app notifications for assignments, customer replies and mentions.
- **Collaboration**: invite agents with a link, administrator and agent roles, groups, presence ("is viewing", "is typing") on tickets, and live updates from the change feed.
- **Customers and organizations**: profiles, notes, time zones, CSV import and export, and organizations matched by email domain.
- **Help center**: a public, branded site with knowledge base articles, search, article feedback, a request form, "My requests", replies, solving and satisfaction ratings.
- **Automation**: macros, triggers (with email notifications to requesters), views, ticket fields, service level targets, and auto-close of solved tickets.
- **Reports**: created and solved trends, backlog, first reply and resolution times, satisfaction, SLA achievement, busiest hours, agents and tags.
- **Writing assistant**: optional AI summaries and reply drafting through Puter AI, run on the agent's own account and only on request.
- **Everywhere**: light, dark and system themes, keyboard shortcuts (press `?`), responsive layouts for desktop, tablet and phone, and careful accessibility.

## How it works

```
 agents (browser)                     customers (browser)
   │  puter.workers.exec()               │  fetch() or puter.workers.exec()
   ▼                                     ▼
 ┌──────────────────────────────────────────────────┐
 │  help desk server: a Puter worker in the owner's  │
 │  account (worker/index.js → src/server/*)         │
 └──────────────┬───────────────────────────┬────────┘
                │ me.puter.kv                │ me.puter.fs
        tickets, events, customers,     attachments
        settings, change feed
```

- **One backend, three hosts.** The route handlers in `src/server` run in the Puter worker each owner deploys, in the owner's own browser before any worker exists (a new help desk works right away, for one person), and in the tests. Turning on team access in Admin deploys the worker into the owner's account with `puter.workers.create()`. The worker bundle ships with the app (`public/worker/help-desk-worker.js`, built by `npm run build:worker`) and is updated automatically when the app has a newer build.
- **Key-value layout.** Everything for a desk lives under `hd:<desk>:` in the owner's store (see `src/shared/keys.js`). There are no secondary indexes, so each read path has its own key shape:
  - `t:<id>` holds a ticket.
  - `e:<id>:<time>` holds the ticket's events, read with one prefix listing.
  - `rt:<user>:<ticket>` indexes tickets by requester for "My requests".
  - `ue:<email>` and `od:<domain>` answer lookups by email and by domain.
  - Settings documents are small single entries.
  - Field updates use path updates, so two agents changing different fields at once both keep their change.
  - Files never go in the key-value store. Attachments are written to Puter files and served through the worker.
- **Change feed and local replica.** Every write takes a revision number with `kv.incr` and writes a `ch:<rev>` entry, which expires after 14 days, in the same batch as the records. The app keeps an IndexedDB replica of tickets, customers, organizations and article summaries. It polls `GET /sync?since=<rev>`, which costs one small read when nothing changed and is one batched `get` of exactly the new entries when something did. Views, counts, search and reports are therefore computed locally and are instant, even with large desks. Ticket tables are virtualized.
- **Email.** Trigger notifications are sent by the worker with `puter.email.sendTransactional()`, which requires the owner's Puter account to be on a paid plan. Every email links to the request in the help center, where the customer can reply.
- **Help center.** Anonymous visitors use plain `fetch()`, with rate limits per network. Signed-in Puter users go through `puter.workers.exec()` so their requests follow them. Requesters reach their requests through an unguessable link key.

The UI is plain JavaScript and CSS with no framework, using [Lucide](https://lucide.dev) icons (ISC).

## Development

```sh
npm install
npm run dev        # builds the worker bundle, then serves the app
npm test           # backend, replica and UI tests (Vitest + jsdom + axe-core)
npm run build      # license check, worker bundle and production build
```

- `index.html` is the real app and needs a Puter account.
- `mock.html` runs the whole app with an in-browser stand-in for the Puter SDK (`dev/mock-puter.js`). It includes the help desk server and the help center.
  - Add `?as=<name>` to act as another pretend user, `&env=app` to behave as inside the Puter desktop, and `&signedout` to start signed out.
  - In the console, `await __seed()` fills the open help desk with demo data.

## Project layout

```
src/server/     backend routes, ticket rules, KV helpers (runs in the worker and the browser)
src/shared/     model, key layout, rules (views, triggers, macros, SLA), HTML sanitizer
src/client/     API client, worker deploy, replica + IndexedDB cache, search
src/views/      agent screens (shell, home, views, ticket, customers, kb, reports, admin)
src/portal/     the public help center
src/ui/         DOM helpers, icons, menus, dialogs, editor, toasts, shortcuts
worker/         the Puter worker entry
tests/          Vitest suites
```

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
