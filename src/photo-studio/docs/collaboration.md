# Comments, shared documents and review links

Photo Studio has three related features:

- **Comments** (Window → Panels → Comments, the Comment tool on the Eyedropper slot, `I`): review threads pinned to a point or a dragged region of the canvas, with replies, @mentions, resolve and reopen, filters (open, resolved, mine, all) and a click on a pin number to zoom to it. They work in every document; local documents save them in `.photo` projects.
- **Invite to Edit…** (File menu): turns the open document into a shared document that several people edit live.
- **Share for Review…** (File menu): creates a link that opens the shared document in a review view (the image with zoom and pan, artboards and layer comps, comments and pins, no editing tools).

All three are registered at startup by `src/features/collab/index.ts`; everything else (Yjs, the room client, peer links, dialogs, the panel body and the tool) loads on first use, so the startup bundle grows by about 11 kB (under 4 kB compressed): the registrations, the comment model and the pins overlay.

The design follows the Whiteboard app in this repository (`src/whiteboard/docs/collaboration.md`), whose protocol, request signing, peer network and test fakes were ported to TypeScript and adapted to a raster editor.

## Where things live

| Module | Role |
| --- | --- |
| `src/collab/protocol.ts` | Roles, base64, SHA-256, ECDSA signatures, invitation links, peer topology, person colors |
| `src/collab/auth.ts`, `src/collab/api.ts` | Signed requests to a room worker; deploying the owner's worker |
| `src/collab/shared-project.ts` | The document as a Yjs document (writing editor steps, projecting back) |
| `src/collab/tile-index.ts`, `asset-codec.ts` | Content addresses of tiles and their deflated transport |
| `src/collab/order.ts` | Fractional order keys for layers |
| `src/collab/comments.ts`, `comment-store.ts`, `ycomments.ts`, `shared-comments.ts` | Comment model, validation and authorship rules; local and shared stores |
| `src/collab/client.ts` | Joining, synchronizing, the outbox, tile transfer, presence, peer edits |
| `src/collab/peers.ts` | WebRTC peer links (`puter.peer`) with signed tickets and packets |
| `src/collab/shared-history.ts` | The editor history of a shared document (per-person Undo) |
| `src/collab/server/` | The room worker (`service.ts`, `auth.ts`, entry `index.ts`), bundled by `npm run build:worker` into `public/worker/photo-studio-worker.js` |
| `src/features/collab/` | Commands, Comment tool, Comments panel, pins overlay, dialogs, top-bar status, presence overlay, review view |

## The shared document model

A Photo Studio document is an immutable snapshot whose pixels are 256-pixel immutable tiles. A shared document is a Yjs document with these top-level maps:

| Map | Contents |
| --- | --- |
| `doc` | Document settings (size, resolution, mode, guides, paths, channels, layer comps, slices, …): one atomic register per property |
| `layers` | Layer ID → map of `parent` (enclosing group), `order` (fractional key among siblings), `p:<property>` (one atomic register per layer property: name, visibility, opacity, blend mode, transform, style, text, vector, adjustment parameters, …), and for the tile grids `pixels`, `maskGrid`, `liveSource` and `liveMask` a placement register `g:<grid>` and a map `t:<grid>` of tile key → content hash |
| `assets` | Asset ID → type, size and content hashes of 4 MB chunks (placed images, embedded projects, footage, PSD resources) |
| `comments` | Thread ID → anchor, author, created, resolved and removed registers, and a map of messages |
| `meta` | Schema version |

Every editor history step is written as the difference between the document before and after it (`SharedProject.write`), so a step sends only what it changed. Merging:

- Edits to different layers, and to different properties of one layer, merge.
- The same property edited by two people at once keeps one value (last writer wins, the same everywhere). Text, shape, fill and adjustment parameters are such registers: concurrent changes to one text layer's text keep one person's version, not a mix.
- Painting merges per tile: two people painting on one layer in different 256-pixel tiles both keep their strokes; when they paint in the same tile at the same time, one person's version of that tile wins everywhere. Strokes crossing tile edges can therefore be cut at a tile edge in a conflict.
- After merging, a pixel layer's transform is set from its merged content, as the editor always keeps it.
- Layer order uses fractional keys, so concurrent moves of different layers merge; equal keys sort by layer ID. A layer moved into a group that someone else deleted moves to the top level; concurrent moves that would nest groups in each other are broken deterministically (the greatest ID in the cycle moves to the top level).
- A layer deleted by one person and edited by another stays deleted.
- Tile grids inside other registers (alpha channels, patterns, altered video frames) are atomic with that register.
- Each person's selection is their own and is never shared.

Projection (`SharedProject.project`) turns the Yjs state back into an editor document, reusing unchanged layers, and is validated with the same `validateDocument` that checks `.photo` files before the editor shows it.

Tiles are addressed by the SHA-256 of their bytes (`TileIndex`). They are uploaded deflated before the edit that refers to them; identical tiles (flat areas, duplicated layers) are stored and sent once. Both the worker and the browsers inflate with a size cap and check the hash, so no one can store other bytes under a tile's address. Large initial states are uploaded the same way: the owner uploads every tile and the Yjs state (in 4 MB chunks), and a joiner downloads the state and then the tiles it needs in batches of 24. (We chose this over sending a `.photo` file for the joiner: tiles then deduplicate across versions, and any tile Undo needs later can be fetched by its address.)

## History and Undo

A shared tab's history is a `SharedHistory`. Each step is written into the Yjs document and recorded by a Yjs `UndoManager` that tracks only this browser's edits. Undo and Redo apply to the person's own steps: undoing a step restores what that step changed unless someone else changed the same property or tile since, and never removes other people's work. Steps that change only the person's selection (Select All, Deselect) stay in their history and undo locally. The History panel therefore lists the person's own steps; edits by others appear in the document without steps. Starting to share clears the tab's earlier Undo steps. Remote edits arriving during a brush stroke, a transform, an open dialog or live text are shown once that finishes, so an unfinished local edit never overwrites them. Comments never enter Undo.

## The room worker

Sharing deploys a Puter Worker to the owner's account (`puter.workers.create`, once; later shares reuse it and update it when the bundled build changes; its address is kept in the owner's app KV). An invitation link never deploys or updates a worker. The worker stores, in the owner's KV and files:

| Key / file | Contents |
| --- | --- |
| `ps:<room>:meta` | Owner, name, room signing keys, initial state chunks, closed flag |
| `ps:<room>:member:<user>` | Role (`owner`, `editor`, `commenter`, `viewer`, `removed`), join time, optional access expiry |
| `ps:<room>:invite:<sha256(token)>` | Invitation role, review flag, creator, expiry (7 days by default; 1 to 30) |
| `ps:<room>:named:<username>` | Invitation by Puter username |
| `ps:<room>:seq`, `ps:<room>:log:<n>` | Numbered edit log (Yjs updates; large ones as files) |
| `ps:<room>:cp` | Checkpoint (full state file) every 100 edits |
| `ps:<room>:presence:<session>` | Peer ticket (90 s) |
| `ps:<room>:ev:signal` | Change notice (carries no data) |
| `photo-studio/shared/<room>/assets/<hash>.txt` | Deflated tiles and asset chunks (2 GB per document) |

Requests (`join`, `sync`, `commit`, `asset.put`, `asset.get`, `presence`, `leave`, `members`, `invite`, `invite-user`, `revoke-invites`, `role`, `stop`, `events`) are signed as in the Whiteboard app: the browser never sends its app session to a worker; it mints a restricted Puter token that can only read a small identity file with its public key, and signs the worker origin, the file path and the body digest. The worker validates the token with Puter (`fs.stat` with strong consistency, an unshared file owned by the caller) and checks the signature.

The worker enforces roles on every request, independently of the interface:

- Viewers cannot commit or upload.
- Commenters can commit only changes to the `comments` map: the worker tries each commit on a scratch copy of the document and refuses it when any other shared type changed.
- Commits to one room are checked one at a time. A refused commit only ever touches the scratch copy (which is then rebuilt); the worker's loaded document, which synchronization sends and checkpoints are written from, receives a commit only after it is accepted and logged.
- Editors and owners can change `doc`, `layers`, `assets` and `comments`, nothing else.
- Comment changes are checked for authorship (`checkCommentChange`): new threads and messages must be the committer's own, under their account ID and their authenticated Puter username; only authors edit or remove their messages (owners may remove any); nothing is removed outright (removal is a marker); resolving is recorded in the resolver's own name; limits of 500 threads, 100 messages per thread and 4,000 characters per message.
- A commit that builds on edits the worker does not have is refused (409) and retried after a synchronization; one refused for good (role changed, invalid data) is dropped together with later queued edits, and the tab opens the shared state again.
- An invitation (link or username) admits only people who are not members yet. For a member it changes nothing: it never raises a role the owner lowered or lifts an access expiry the owner set, and an expired or revoked link does not stop a current member.
- Only the owner manages access: invitation links (with role and expiry), invitations by username, role changes, access expiry, removal, revoking links, and Stop Sharing.

Accepted commits return a receipt signed with the room key, binding the update hash, the room and the committer.

## Live transport and presence

Change notices: the worker writes `ps:<room>:ev:signal` after each commit; the owner subscribes with `puter.events.onLocal()` and others through KV event handles the worker requests for them. A notice prompts a synchronization and a check-in. Browsers also synchronize every 4 seconds without live links (every 20 with them), when the tab becomes visible and when the browser comes back online.

Peer links use `puter.peer.serve()` / `connect()` (WebRTC, Puter-managed TURN). Each session checks in with the worker for a 90-second ticket signed with the room key; peers exchange tickets and answer a challenge signed with their session key and bound to the connection's transport certificates. Up to eight sessions link to each other; larger rooms link through two relays per group of up to 32. Every packet is signed. Over these links travel:

- **Edits**: small updates (up to 48 kB) right after the worker accepted them, with the worker's receipt; receivers verify the receipt and the hash before applying, so a refused edit never spreads. Larger ones send a notice instead.
- **Presence** (at most 20 a second, on an unordered channel without retransmits): the pointer, tool, active layer bounds, selection bounds and view (center and zoom). Other people's cursors with their names and tools, their active layers (long dashes) and selections (short dashes) are drawn in their colors over the canvas.

The top bar shows a status chip (Connected, Syncing…, Offline · N pending, Disconnected, and Comment only or View only for those roles) and avatars; clicking either opens the people popover: everyone with access, who is here and with which tool, **Follow** (adopt that person's view until you move yours), and for the owner Invite to Edit, Share for Review, Copy Link and Stop Sharing.

## Offline and recovery

Every local change goes into an outbox in IndexedDB (`photo-studio-collab`), with the deflated bytes of the tiles it needs, before it is sent. Delivery merges queued updates into batches, uploads their tiles first, and removes them once the worker accepts. Without a connection the chip shows how many changes are waiting; they are sent when the connection returns, and also after a reload: opening the document again in this browser replays its outbox. Closing a tab with undelivered changes asks first. Clearing site data removes undelivered changes.

When access ends (removed, expired, sharing stopped), the tab keeps the document as a local copy with its comments and says so.

## Review view

A review link (Share for Review…) gives comment or view access and opens the review view: the tools panel and options bar give way to a header with the document name, an artboard list (zoom to an artboard), a layer comp list (shows a comp in this browser only), Fit and 100% buttons and, for commenters, a Comment button; the dock shows only the Comments panel. Reviewers need a Puter account and sign in: the worker can only check access for authenticated people, and an anonymous link would let anyone holding it read the document and post comments under no name. We did not ship unsigned review links for that reason.

## Comments in local documents

Local documents keep comments outside the history (so Undo never removes a comment) and write them into the `.photo` project on every save (`projectExtras` in `serialization.ts`); unsaved comment changes mark the document as unsaved. Opening a project validates them. Pins are an overlay and never appear in exports; View → Show → Comments hides them. When a local document is shared, its comments move to the shared document under the owner's name.

## Limits and known gaps

- Same-tile concurrent painting keeps one person's tile (see above); concurrent edits of one text layer's text keep one version.
- Comment anchors are document coordinates: a crop or canvas resize does not move them.
- History states before sharing are not kept; a joiner's History starts empty.
- The edit log is never compacted beyond checkpoints; documents are limited to 2 GB of stored tiles and assets.
- Notifications for @mentions are not sent outside the document.
- The 8-session mesh and relay groups are a topology, not a measured capacity; large rooms and real-network behavior still need testing against the hosted Puter service.

## Tests

- `tests/collab-project.test.ts`: the Yjs model (round trip, merges, per-tile conflicts, order, cycles, private selections).
- `tests/collab-sessions.test.ts`: two and three simulated people against the real worker service with an in-memory Puter (`tests/collab-helpers.ts`, ported from the Whiteboard tests): joining, merging, three-way order, the offline outbox across a reload, server-side roles, comment threads, per-person Undo, peer edits and presence, access management, tile integrity and a second worker instance.
- `tests/collab-protocol.test.ts`, `tests/collab-comments-file.test.ts`: links, signatures, topology, colors, the tile codec, the comment model and authorship rules, comments in projects.
- `tests/browser/collab.spec.ts`: two browser contexts with a stand-in Puter.js forwarding to the worker service in the test process (`tests/browser/collab-harness.ts`, used only by tests): invite, join, paint in one and see it in the other, presence, a comment pin in one and a reply and resolution in the other.
