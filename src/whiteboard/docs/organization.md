# Organizations

An organization gives a team centralized administration: members and teams, sharing and AI policy, a board directory, audit logs, reports, integrations, and APIs. Every rule is enforced by the organization's Puter worker, not only by the interface.

## Model

- **One worker per organization.** The account that sets up the organization deploys (or reuses) its collaboration worker and becomes the **account owner**: the primary administrator responsible for configuration, integrations, and the Puter plan that stores organization boards, audit logs, and files.
- **Unlimited members.** Membership is a record in the worker, not a seat. Members create shared boards on the organization's worker, where its policies apply.
- **Organization roles:** owner (one, the account owner), administrator, member, and guest. Only the owner appoints administrators; administrator API keys can never grant administration.
- **Board roles:** owner, facilitator, editor, commenter, and viewer. Guests from outside the organization hold one of these roles on specific boards, are marked as guests, and can have expiring access: **Participants** shows when each guest's access ends, or that it has ended, and the owner or a facilitator can **Renew access**, which starts the organization's guest period again. A board invitation link admits people outside the organization as guests where the policy allows guests; **Only members of the organization can join with this link** in the share dialog makes one that refuses them, so a copy forwarded outside lets no one in.

| Board role  | Content | Comments, reactions, votes | Manage participants          | Settings and governance               |
| ----------- | ------- | -------------------------- | ---------------------------- | ------------------------------------- |
| Owner       | Yes     | Yes                        | Yes, including facilitators  | Visibility, transfer, archive, delete |
| Facilitator | Yes     | Yes                        | Editors, commenters, viewers | Visibility and defaults               |
| Editor      | Yes     | Yes                        | No                           | No                                    |
| Commenter   | No      | Yes                        | No                           | No                                    |
| Viewer      | No      | No                         | No                           | No                                    |

Organization administrators can open and govern every board on the worker without being a participant. A guest made facilitator manages participants but cannot change who can open the board (its visibility and default roles); the share and settings dialogs show what the board's own organization allows, whichever organization the person viewing belongs to.

## Joining

- **Invitation links** (member, guest, or administrator) from Organization settings → People. They expire after 14 days by default and can be revoked. An administrator link works for one person.
- **Domain capture.** Add email domains in Policies and turn on domain capture. Internationalized domains can be written as they read (`münchen.de`); public email domains such as `gmail.com`, and suffixes anyone can register under such as `co.uk` or `github.io`, cannot be claimed, since anyone can have an address there. A person signs in with Puter, chooses **Verify your email**, and enters the six-digit code the worker emails them. Verified addresses in the organization's domains, or their subdomains (`hr.example.ca` counts as `example.ca`, as in Miro migrations), join as members automatically. A code expires after 15 minutes and allows five tries. Codes and wrong guesses are limited per person and per address, and, for people not yet in the organization, across it: 300 codes and 100 wrong guesses an hour, after which only accounts that already guessed wrong that hour are held back, so many accounts guessing at invented addresses cannot add up to a likely match, nor keep a newcomer with the right code out.
- **SCIM provisioning.** People provisioned by an identity provider are pending until they sign in and verify the same email, then inherit the provisioned role, teams, and status. The identity provider stays in charge of their role: domain capture and member invitation links never make a provisioned guest a member. Board access granted to a pending address (for example during a migration) moves to their account at that moment.
- **Site configuration.** A deployment can include `/organization.json` with `{ "server": "https://<worker>.puter.work" }`, so every visitor sees the organization without a link.

## Organization library

Members share templates from a board with **Share to organization library** in the command palette, and Miro migrations can save boards there as templates. Open **Organization library** from the library sidebar or the command palette to search it and start a new board from a template. A member's submission appears for everyone once an administrator approves it; administrators' submissions appear right away. The person who shared an item, and administrators, can remove it. Shared copies leave out comments and content hidden from the person sharing.

## Policies

| Policy                                  | Effect                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Email domains, domain capture           | Which verified addresses join automatically                                                                            |
| Members can create boards               | Whether members (not only administrators) create boards on the worker                                                  |
| Default board visibility                | Invited people only, or everyone in the organization                                                                   |
| Sharing outside the organization        | Not allowed, invited guests only, or guests and public links                                                           |
| Guest access and expiry                 | Whether guests can join, for how many days, and the highest board role they may have (a guest given more acts with it) |
| Public links                            | Whether a board can be opened by anyone signed in with its link                                                        |
| Restrict boards to organization members | Rejects every non-member, even with an invitation                                                                      |
| AI features                             | On or off overall, and separately for summaries, themes, and handwriting; optional model                               |
| Integrations                            | Google Workspace, Slack, Jira, embedded content, webhooks, Miro imports                                                |
| Retention and legal hold                | Audit log retention (30 to 3,650 days), recoverable period for deleted boards, and an organization-wide legal hold     |
| Scheduled reports                       | Weekly or monthly email of the administrative report                                                                   |
| Alerts                                  | Email and Slack alerts for public sharing, guest access, permission and ownership changes, and policy changes          |

Administrators can also place a legal hold on a single board from the Boards tab, which blocks deletion regardless of retention.

## Boards directory and search

Members see boards shared with them, or every board open to the organization, with search across board names and content and filters for space, team, activity (including empty boards), content type, date, and archive state (hidden, included, or only archived boards), sorted by last activity, creation, or name. The organization's spaces are listed under Organization boards in the library's sidebar, each opening the boards filed in it; deleting a space takes its boards out of it. Administrators see every board with ownership, sharing, size, guests, and session peaks, can find duplicates (same content or same name) and stale or empty boards, export the directory as CSV, and archive, restore, delete, transfer, or hold boards.

## Audit log

Every administrative, security, access, sharing, API, and board content event is recorded with time, actor, target, board, source address, and details. Examples: `org.created`, `policy.updated`, `user.joined`, `user.role.changed`, `user.deactivated`, `apikey.created`, `board.created`, `board.visibility.link`, `board.share.role` (default access for organization members or link holders, with `from` and `to`), `board.filed`, `board.guest.joined`, `board.role.changed`, `board.invite.created`, `board.transfer`, `board.archived`, `board.deleted`, `board.hold.placed`, `board.export`, `board.content.updated`, `board.content.restored`, `board.comment.created`, `board.migrated`, `ai.used`, `api.read`, `auth.apikey.failed` (a refused API key, with the `reason` and, for a key the worker knows, which key; at most 20 every ten minutes for keys it knows and 20 for ones it does not), `scim.user.updated`. An edit that adds more than 20 comment messages at once, as when threads are pasted, records the first 20 as one `board.comment.created` each and the rest as a single `board.comment.created` whose details give their `count`.

The Audit log tab filters by date, category, and action, and exports CSV or JSON. Each board also has an activity log, newest first, with older events a page at a time (Show older activity, or `cursor` on `GET /v1/boards/{room}/activity`). Records older than the retention period are removed in small batches unless a legal hold is on. A record (or a notification) that storage refuses to write is kept by the worker instance and written again before its next audit write or delivery, in order, rather than lost; an instance keeps up to 1,000 such records through an outage.

Audit queries return their date bounds and the worker's current time in `range` (`from`, `to`, and `now`, as Unix milliseconds). The console uses these bounds to keep pagination and exports within the same range, even when the device's clock differs from the worker's.

## Reports

The Overview tab reports active, inactive, deactivated, pending, and guest users; daily active users and the largest simultaneous session per day; boards created per week, active, stale, and empty boards; top owners and largest boards; external sharing (organization-visible boards, public links, boards with guests); and the largest sessions. Reports export as JSON and CSV, are available through the REST API, and can be emailed on a schedule.

## APIs

Create API keys in Organization settings → Security. Keys are shown once, can expire, and carry scopes: `scim`, `users:read`, `users:write`, `boards:read`, `boards:write`, `audit:read`, `reports:read`, `webhooks:write`. Send them as bearer tokens. The worker publishes an OpenAPI 3.1 description at `/v1/openapi.json`.

| Endpoint                                                             | Scope                        | Purpose                                                                                                        |
| -------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /v1/audit`                                                      | `audit:read`                 | Audit events, newest first, filterable; `format=ndjson` for SIEM ingestion, paging with `cursor`               |
| `GET /v1/users`, `GET /v1/users/{uuid}`                              | `users:read`                 | Users; `format=csv`                                                                                            |
| `PATCH /v1/users/{uuid}`                                             | `users:write`                | Role (member or guest) and status (active or deactivated)                                                      |
| `GET/POST /v1/teams`, `PATCH/DELETE /v1/teams/{id}`                  | `users:read` / `users:write` | Teams and membership                                                                                           |
| `GET /v1/boards`                                                     | `boards:read`                | Directory with the same filters as the interface, in pages of up to 1,000 (`limit`, `offset`) with the `total` |
| `GET /v1/boards/duplicates`                                          | `boards:read`                | Possible duplicates                                                                                            |
| `GET /v1/boards/{room}`                                              | `boards:read`                | Board metadata and members                                                                                     |
| `PATCH /v1/boards/{room}`                                            | `boards:write`               | Transfer ownership, archive, restore, delete, legal hold, visibility                                           |
| `GET /v1/boards/{room}/activity`                                     | `audit:read`                 | Board activity log                                                                                             |
| `GET /v1/reports`, `/v1/reports/users.csv`, `/v1/reports/boards.csv` | `reports:read`               | Reports                                                                                                        |
| `GET/POST /v1/webhooks`, `DELETE /v1/webhooks/{id}`                  | `webhooks:write`             | Webhook subscriptions; creating one also needs `audit:read`, since deliveries carry audit events               |
| `/scim/v2/Users`, `/scim/v2/Groups`                                  | `scim`                       | SCIM 2.0 provisioning, including `ServiceProviderConfig`, `ResourceTypes`, and `Schemas`                       |

SCIM users are matched by `userName` (the work email). The extension `urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User` carries `role` (`member` or `guest`) and read-only `license`, `puterUsername`, and `linked`. `PUT` and `PATCH` support `active`, names, `externalId`, roles, and `userName` or work email changes (the record moves to the new address, so verifying it later links the same person; an address another person has is refused with `409 uniqueness`); `DELETE` deactivates a linked user or removes a pending one. A provisioned person's address belongs to the identity provider: they cannot verify a different one themselves. Provisioning a deleted user's address again links the same account, unless both carry an `externalId` and the two differ, as when an address is given to someone new: the deleted account then stays deactivated, and the address starts a new pending record for whoever verifies it. As in the admin console, only a SCIM key the account owner created can deactivate, reactivate, or delete an administrator. Groups map to teams, including add and remove member operations.

## Webhooks

Create a webhook in Organization settings → Integrations, or with `POST /v1/webhooks` and a body of `{ "url": "https://…", "events": ["board", "user.role"] }`. The address must be public HTTPS; redirects are not followed and each delivery waits up to 5 seconds. `events` lists event names or prefixes (`board` matches `board.created`, `board.guest.joined`, and so on); `["*"]` subscribes to everything. Event names are the audit actions listed above. The signing secret is shown once, when the webhook is created. A webhook stops delivering once the administrator who made it, or the API key it was made with, no longer administers the organization.

Each delivery is a `POST` with this body:

```json
{
  "id": "2026-10-09T15:04:05.123Z:3f2a9c",
  "event": "board.guest.joined",
  "created": "2026-10-09T15:04:05.123Z",
  "data": {
    "id": "2026-10-09T15:04:05.123Z:3f2a9c",
    "time": "2026-10-09T15:04:05.123Z",
    "category": "access",
    "action": "board.guest.joined",
    "actor": { "uuid": "…", "username": "dee" },
    "target": { "type": "board", "id": "…", "name": "Discovery workshop" },
    "board": "…",
    "details": {},
    "ip": "203.0.113.7",
    "userAgent": "Mozilla/5.0 …"
  }
}
```

and these headers: `X-Whiteboard-Event` (the event), `X-Whiteboard-Delivery` (the event `id`, the same on every retry, for deduplication), and `X-Whiteboard-Signature: sha256=<hex HMAC-SHA256 of the raw body with the secret>`. Verify the signature over the raw bytes before parsing, for example in Node.js:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const expected =
  "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
const ok =
  signature.length === expected.length &&
  timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
```

A delivery that fails (no answer within 5 seconds, or a status other than 2xx) is retried about 1, 2, 4, 8, and 16 minutes later, six attempts in all, then dropped. Retries are sent as the worker handles requests, so their timing is approximate, and deliveries can arrive out of order: order events by `created` (or `id`, which sorts by time) and ignore a `X-Whiteboard-Delivery` already seen. Every event also remains in the audit log and its export, and can be sent to a SIEM ([Sentinel](sentinel/README.md)).

## Integrations

Administrators turn each integration on or off in Organization settings → Integrations. The worker enforces the Google Workspace, embedded content, and Miro settings for everyone on the organization's boards, guests included.

- **Google Workspace:** embeds of Docs, Sheets, Slides, Forms, Drawings, Calendar, and Drive files and folders; Google Sheets imported as editable tables that can be refreshed from the sheet later; a Google Doc's outline imported as sticky notes; and Google Slides imported as frames. Imports need the file shared with “Anyone with the link” or published to the web, and work without a Puter sign-in. Single sign-on depends on the Puter platform; see [Puter platform requirements](puter-platform-requirements.md). SCIM provisioning works with Google Workspace automation.
- **Slack:** add an incoming webhook URL (`https://hooks.slack.com/…`). Security alerts go to it when “Also post alerts to Slack” is on, and, while Slack is on, a board's owner or an administrator can connect a board to its own channel, which receives @mentions on that board with a link to it. Messages are in English, then French.
- **Jira Cloud:** enter the site (`team.atlassian.net`), the integration account's email and API token, and the project key. On an organization board, **Send to Jira** creates one issue of type Task per selected task (summary, description, and due date) and links it on the board; **Refresh Jira status** copies each issue's status back and moves the task's status to To do, In progress, or Done with Jira's status category. Refusals show Jira's own reason. Credentials stay in the worker; guests cannot use the connection, and queries are limited to the configured project.
- **Webhooks and the REST API:** see above.
- **Microsoft Sentinel:** see [Sentinel integration](sentinel/README.md).
- **Miro:** migrate boards with owners, member roles, and a validation report; see the README.

Links to other tools work as follows. Video and design tools (YouTube, Vimeo, Loom, Figma, Miro), Microsoft Forms, and public Office files open live on the board. Meeting links (Google Meet, Zoom, Microsoft Teams), chat (Slack, Teams), knowledge and project tools (Confluence, Jira, Notion, Trello, Asana), and file and code hosts (Dropbox, GitHub, GitLab) become link cards, since those sites do not allow their pages to be shown inside another site. Boards do not depend on any meeting: they persist and keep their sharing before, during, and after one.

Mentions, replies, and task assignments are kept for 90 days by the worker hosting the board they are about, which lists them to anyone signed in (`notifications.list` and `notifications.read`), member or not. The library's **Notifications** gathers them from the organization's worker and from the workers of the ten most recently used shared boards in the person's library, asked at once, newest first, so guests, people invited to someone's personal board, and members of another organization see them too. Its unread count adds up every worker's and is asked again at most once a minute, when the library is shown or its window comes back into view; from a board, **Notifications** in More tools or command search asks only when opened, as nothing polls; a worker that does not answer leaves the others listed, and **Mark all as read** marks each. Signed-in people without an organization find **Notifications** with their board library once they have a shared board; the email choice is an organization setting and is offered only within one.

Mention, reply, and task assignment emails and board channel posts name the board and link to it: a task's link shows its object, and a comment's opens its discussion, at the object it is pinned to if any. The worker learns the app's address from the organization owner's and administrators' browsers when they use it, so links appear once one of them has opened the organization in the app.

## Platform limits

Organization records use the account owner's Puter KV and storage, subject to [Puter's rate limits and quotas](https://docs.puter.com/rate-limits-and-quotas/). Transactional email (verification codes, notifications, alerts, reports) requires the account owner to be on a paid Puter plan.
