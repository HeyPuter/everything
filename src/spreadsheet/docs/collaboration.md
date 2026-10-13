# Editing together

Several people can work in the same spreadsheet at once. Everyone sees the others' edits within a second or two, sees where each of them is (their selection outlined in their colour, with their name), and keeps their own Undo. The `.xlsx` file stays the durable copy its owner keeps: it is written back as people work, so it still opens anywhere.

Choose **Share**, then **Start editing together**. The first time, this deploys the owner's own collaboration server (a Puter Worker) to their account; then the workbook opens as a shared workbook. From the same dialog the owner copies an **invitation link** that lets people edit or only view (valid for seven days), invites people by their Puter username, changes anyone's access, removes them, or **stops editing together**. People open the link, sign in to Puter if they have not, and join. Opening the file again later, its owner joins the shared workbook automatically; members reopen the link (without the invitation part, it opens the workbook for members only).

The design follows the Whiteboard app in this repository (`src/whiteboard/docs/collaboration.md`): its worker per owner, signed requests with restricted credentials, the outbox, peer links for presence and test fakes were ported and adapted. The document model is different, for the reasons below.

## Where things live

| Module | Role |
| --- | --- |
| `src/collab/ops.js` | The operations a change carries, their validation (shared with the worker), where positions go through structural operations, and how two structural operations are transformed against each other |
| `src/collab/apply.js` | Applying operations to a workbook through its own code paths |
| `src/collab/replica.js` | One browser's copy: capturing local edits as operations, receiving the room's log, rebasing pending changes, per-person Undo |
| `src/collab/client.js` | Joining, loading, sending and fetching changes, the outbox, checkpoints, presence, events and peer links |
| `src/collab/outbox.js` | Unconfirmed changes kept in IndexedDB |
| `src/collab/protocol.js`, `auth.js`, `api.js`, `peers.js` | Roles, encodings, signatures and links; signed requests; deploying the worker; WebRTC peer links |
| `src/collab/server/` | The room worker (`service.js`, `auth.js`, entry `index.js`), bundled by `npm run build:worker` into `public/worker/spreadsheet-worker.js` (22 kB) |
| `src/collab/session.js` | Starting, finding and opening shared workbooks for the app |
| `src/ui/coauthor.js` | The people bar, the status, the Share dialog's Edit together part |

## The model: an ordered log of operations

The room keeps **one ordered log of changes**. Every browser applies the same changes in the same order, through the workbook's own code, and therefore holds the same workbook. A change is a list of operations of two kinds:

- **Registers**, which set state outright: a cell's content (value, formula, rich text, link), each of a cell's style properties separately, each row's or column's height, width, style and hidden state, each cell note, each sheet setting (merges, conditional formats, validation, tables, charts, filters, frozen panes, protection, print settings, …) and each workbook setting (defined names, theme, calculation options, …). Where two people write the same register, the later change in the log wins, in every browser.
- **Structure**, which the workbook replays itself: inserting, deleting and moving rows and columns, and renaming, deleting and moving sheets. Replaying them (rather than sending what they did) is what keeps someone else's concurrent formula correct: a formula typed at `C1` as `=SUM(A3:A5)` while someone inserted a row above is rewritten to `=SUM(A4:A6)` by the replay, exactly as the workbook rewrites every other formula.

Adding or duplicating a sheet sends the new sheet whole.

### Why not a CRDT

We considered the Whiteboard app's approach, a Yjs document of per-cell registers. A spreadsheet's positions are the problem: cells, formulas, merges, conditional formats, validation ranges, tables, charts, names and print areas all refer to rows and columns by number, and inserting a row renumbers all of them. A CRDT needs stable identities for rows and columns, and then every one of those features (and every formula reference) must be stored relative to those identities, which would mean reimplementing most of the workbook's structural code in a second representation. The order-based model instead lets the workbook remain the single implementation of what an edit does: the log decides the order, and the workbook does the rest, deterministically, in every browser. This is the approach spreadsheet services commonly take (an operation log ordered by a server, with operational transformation of positions).

### Capturing a change

The workbook knows nothing of sharing. `Replica` keeps a **shadow** of the state already shared (each sheet's cells, by identity and formula text, which is cheap since an edit replaces a cell object rather than changing it; and each setting's serialized value). After each undo step the workbook records, the sheets the step touched (`_changed` events, with the box a cell write covered) are compared with the shadow; what differs becomes register writes, and the shadow is brought up to date. Structural operations are intercepted where the workbook performs them (`_insert`, `_deleteLines`, `_moveLines`, `renameSheet`, `deleteSheet`, `moveSheet`): what changed before them is recorded first, then the operation itself, and what it did to formulas and ranges elsewhere is folded into the shadow without being sent, since everyone's replay does the same. Settings changed outside undo steps (Protect Workbook, calculation mode) become changes too.

What each person's view holds is never shared: zoom, the selection, where a sheet is scrolled to, split windows, Page Layout view, the active sheet, and the height of rows sized to fit their contents (each screen measures its own).

### Ordering and rebasing

The worker accepts a commit only on top of its latest record (`base` must equal the head). A change made here is applied at once and kept as **pending**. When someone else's change arrives first:

1. the pending changes are taken back with the workbook's exact undo steps;
2. the other change is applied;
3. each pending change is transformed to apply after it: cell positions and row/column keys move through the structural operations (`ops.js`), formulas, links and positional settings are carried through them by running the structural operation in a scratch workbook holding the pending values (so the workbook's own rewriting applies, `Replica._sandbox`), and where both wrote one register the pending change keeps it (it lands later);
4. the pending changes are applied again and sent in their new form.

Two structural operations made at once are transformed against each other: insertions at the same row put the earlier one first; a deletion around an insertion is split so the inserted rows survive; overlapping deletions delete each line once; a move whose block was broken up is dropped; the later of two renames (or two moves) of one sheet stands; operations on a sheet someone deleted vanish.

Because every browser ends up applying the same operations in the same order, convergence does not depend on the transforms being perfect: they decide what a concurrent edit means, the order decides that everyone agrees on it. The tests run random sessions of three people (cells, formulas, styles, row and column insertions and deletions, moves, merges, widths, notes, hidden rows, cell shifts, clears, sorts, names, sheet additions, deletions, renames and moves, Undo and Redo, at random synchronization points) and check that everyone, and a newcomer replaying the log, end with identical workbooks.

### Undo takes back only your own changes

The workbook's own Undo would put back whole sheets, including other people's edits. In a shared workbook each change keeps its **inverse**: the values it replaced, and the opposite structural operation (an insertion's inverse is a deletion; a deletion's inverse re-inserts the lines and writes back what was on them, the settings it changed and the formulas it turned to `#REF!`; deleting a sheet is undone by putting it back whole). Every change that arrives from someone else afterwards transforms the stored inverses (positions move, formulas are rewritten), and any register someone else wrote since is dropped from them: Undo takes back only what you did, only where nobody has changed it since. Undoing is an ordinary change, shared with everyone; its own inverse becomes the Redo. Each Undo applies exactly one step; one whose every effect was overwritten by others is used up without changing anything.

## Offline and recovery

Every pending change is kept in IndexedDB (`spreadsheet-collab`, one record per room: the revision the changes apply on top of, and the changes). Without a connection the status says **Offline · N changes waiting**; work continues locally. When the connection returns (or the tab becomes visible again) the browser fetches what others did, rebases its changes on it and sends them. After a reload, opening the shared workbook loads the checkpoint at or before the saved revision, applies the log up to it, puts the saved changes back on top, and rebases them through the rest. A change the worker refuses for good (access removed, invalid) is taken back with the later ones, which may build on it, and the person is told.

One tab per shared workbook keeps the outbox; two tabs of the same shared workbook in one browser each send their own changes while open, but only the latest one's unsent changes survive closing both while offline.

## The room worker

`npm run build:worker` bundles `src/collab/server` (it does not include the spreadsheet engine: the worker orders, checks and stores, browsers compute). `npm run build` runs it first. Sharing deploys or updates the owner's worker with `puter.workers.create()`; only a worker recorded in the owner's private app KV is ever updated, and invitation links never deploy anything.

| Key / file | Contents |
| --- | --- |
| `ss:<room>:meta` | Owner, name, room signing keys, the initial state file, the owner's file, closed flag |
| `ss:<room>:member:<user>` | Role (`owner`, `editor`, `viewer`, `removed`), join time, optional expiry |
| `ss:<room>:invite:<sha256(token)>` | Invitation role, creator, expiry (7 days by default) |
| `ss:<room>:named:<username>` | Invitation by Puter username |
| `ss:<room>:claim:<rev>` | Who claimed a log position (atomic `incr`: the first claimant owns it) |
| `ss:<room>:log:<rev>` | The record: author, session, time, changes (large ones in a file) |
| `ss:<room>:cp`, `ss:<room>:cps` | The latest checkpoint and the last 50 |
| `ss:<room>:presence:<session>` | Peer ticket and where the person is (90 s) |
| `ss:<room>:ev:signal` | Change notice (carries no data) |
| `spreadsheet/shared/<room>/…` | Initial state, checkpoints (gzipped JSON), large records |

Requests (`create`, `join`, `load`, `sync`, `commit`, `checkpoint`, `presence`, `leave`, `members`, `invite`, `invite-user`, `role`, `revoke-invites`, `stop`, `events`) are signed as in the Whiteboard app: the browser never sends its app session to a worker; it mints a restricted Puter token that can only read a small identity file with its public key, and signs the worker's origin, the file path and the body digest. The worker validates the token with Puter (`fs.stat` with strong consistency of an unshared file owned by the caller) and checks the signature.

The worker enforces roles on every request, independently of the interface:

- Viewers cannot commit or write checkpoints (the browser also takes a viewer's edit back at once and says so).
- Every change is validated (`validateChange`): known operation types only, cell keys inside the grid, only shared settings, sane ranges, size limits.
- A commit not on top of the latest record is answered with the records it missed, for the browser to rebase on; positions are claimed atomically, so two worker instances cannot both accept a commit at the same position. A position claimed but never written (a commit that failed half way) is filled with an empty record after 20 seconds.
- Invitations admit only people who are not members; they never raise a role the owner lowered.
- Only the owner manages access, and only the worker's owner creates rooms on it.

Accepted commits return a receipt signed with the room key, binding the room, the revision, the change's digest and its author; peers apply a change sent over a peer link only with a valid receipt and only in the log's order.

## Checkpoints and the file

The worker does not run the spreadsheet, so checkpoints come from browsers: the editor with the lowest session among those present writes one (the whole workbook at a revision, while it has nothing pending, so its state is the room's) after every 50 revisions or a minute after the last one. Joining loads the latest checkpoint and the log after it. Saving (**Ctrl+S**, leaving, or 15 seconds after the last change in the owner's browser) delivers what is pending and writes a checkpoint with the workbook as `.xlsx`; the worker writes it over the owner's file, and the owner's browser writes the file itself when the worker could not. The file is therefore always a recent state of the shared workbook and opens anywhere; version history keeps working for it.

## Presence

Each person shares their sheet, their selection, their active cell and whether they are typing. It travels over signed WebRTC peer links when they are available (immediately, at most 20 times a second) and with each check-in to the worker otherwise (every few seconds while others are here). The title bar shows everyone's initials in their colour (white text on each colour meets 4.5:1), with their name and location on hover; a click goes to where they are, and the list button lists everyone with their location. On the grid, each person's selection is outlined in their colour with their active cell, and a flag with their name shows while they move or type, then shrinks to a small tab so it does not cover the cells. The sheet tabs carry a dot per person on that sheet. The status beside the name says **Live · Saved**, **Syncing…**, **Offline · N changes waiting**, **View only** or **Not connected**.

## Limits and known gaps

- Concurrent edits of the same register keep one value: two people typing in one cell keep the later entry; two people changing the same sheet setting at once (for example both adding a conditional format to one sheet) keep the later list.
- A structural operation's transform can lose intent in rare combinations: a move whose block someone else broke up is dropped; a pending change whose formulas refer to tables that exist only in the shared state is rewritten without them.
- The workbook's engine must behave identically in every browser; an engine update while people are in a room should reach everyone (they share one app build). A browser whose copy diverged recovers by reopening the workbook.
- Comments are shared per sheet as one register (concurrent new threads on one sheet keep one side's list).
- Presence positions are each sender's; during a concurrent structural change a selection may be shown one row off until the sender moves.
- Puter Workers may not allow writing to the owner's absolute file path; then the owner's browser writes the file when it next saves.
- Room size is not load-tested against the hosted Puter service; the peer topology (full mesh up to eight, relays beyond) is the Whiteboard app's.

## Tests

- `tests/collab-model.test.js`: the merge model with an in-memory room: concurrent edits to different and to the same cells, value and format together, style properties, row and column insertions and deletions against edits and each other, formulas through insertions, sheet renames against formulas typed meanwhile (both orders), sheet additions, moves and deletions, widths, merges and freezing, names, per-person Undo with remote edits interleaved (and of deletions of rows and sheets), viewers, a long offline session, and random three-person sessions.
- `tests/collab-sessions.test.js`: two and three browsers against the real worker service with an in-memory Puter: joining with invitations, edits both ways, ordering, viewer enforcement in the worker, outsiders, presence, the offline outbox across a reload, checkpoints and the `.xlsx` write-back, role changes and removal, stopping, and a second worker instance.
- `tests/collab-protocol.test.js`: change validation, position mapping and structural transforms, links, colours, packing, signatures, topology, presence sanitizing, and worker permission checks (room creation, invitation expiry and revocation, invitations by username, malformed and stale commits, forged signatures).
