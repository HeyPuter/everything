# Live co-editing, sharing, version history and the Assistant

Documents lets several people edit one document at the same time. The DOCX file stays the saved
artifact: a shared document is a room that holds the document as it was shared and every change
since, and one browser tab (the owner's) writes the file. The design follows the Whiteboard and
Photo Studio apps in this repository (`src/whiteboard/docs/collaboration.md`,
`src/photo-studio/docs/collaboration.md`): Yjs (MIT) documents, a room service that the owner
deploys as a Puter Worker, signed requests, an outbox, presence and per-person Undo.

## Where things live

| Module | Role |
| --- | --- |
| `src/collab/shared-doc.js` | The document model as a Yjs document: encoding, reading back, writing a local change as a minimal set of shared operations |
| `src/collab/text-diff.js` | A bounded shortest-edit-script diff for the changed stretch of a body |
| `src/collab/binding.js` | Binds a `CanvasEditor` to the shared document: local transactions out, remote updates in, selection carried through, per-person Undo, roles, the single-editor fallback |
| `src/collab/client.js` | A person's connection: the Yjs document, the outbox (IndexedDB), roster and status |
| `src/collab/transports.js` | `MemoryHub` (unit tests), `BroadcastRoom` (tabs of one browser: the playground and browser tests), `WorkerTransport` (a room on the owner's Puter worker) |
| `src/collab/server/service.js`, `server/auth.js`, `server/index.js` | The room service and the worker entry (`npm run build:worker` → `public/worker/documents-worker.js`) |
| `src/collab/protocol.js`, `auth.js`, `api.js` | Roles, encodings, signatures, links, colors; signed requests and worker deployment |
| `src/collab/live.js` | A live session for an open document: sharing, joining, presence painting, which tab saves, access management |
| `src/views/collab.js`, `share-dialog.js` | Share dialog, avatars in the title bar, notices |
| `src/views/version-history.js` | Version History pane and the read-only version beside the document |
| `src/views/assistant-pane.js`, `src/lib/assistant.js` | The Assistant pane |
| `dev/collab-dev-server.mjs` | The same room service inside the Vite dev server for `/mock.html` and the browser tests |

Yjs and the room client load only when a document is shared or opened from an invitation; the
editor's startup bundle carries the Share dialog and the small protocol helpers.

## The shared document

The editor's model (`src/engine/model.js`) keeps the body as paragraphs of runs, and a position is
a UTF-16 offset in the paragraphs joined by `\n`. The shared document mirrors that:

| Yjs type | Contents |
| --- | --- |
| `body` (`Y.Text`) | Every body paragraph's characters followed by one paragraph mark (`\n`), the last paragraph included, so a model position is the same index in the shared text. Text characters carry their run's properties as attributes `r:<property>` (JSON values; values equal to the defaults are left out). A mark carries the paragraph's properties as `p:<property>` (style, format, list, cell membership, section break, id …). |
| | Zero-width markers kept in paragraph arrays with an `offset` (bookmarks, comment anchors, editing-permission ranges, field markers) ride on the character at their offset as `m:<array>:<id>`; text typed before a marker moves it, and a marker duplicated by concurrent edits keeps its first place. |
| | Objects that must stay separate runs (pictures, equations, fields, note references, symbols) carry a unique `u` attribute, so two pictures side by side never merge into one run. |
| `parts` (`Y.Map`) | Atomic registers (JSON) per table, style definition, numbering abstract and instance, page setting and edited header/footer/note story, plus track-changes state. |
| `comments` (`Y.Map`) | One register per comment (its own type, so a comment-only participant's change can be told apart). |
| `assets` (`Y.Map`) | Pictures and drawings added after sharing: `<id>#` holds the description, `<id>` the bytes. Assets of the shared file are in its base file, which everyone opens. New asset ids get the client's id appended, so two people inserting pictures at once never collide. |
| `meta` (`Y.Map`) | Schema, editing mode (`shared` or `single`), and in single-editor mode the lock and the model snapshot. |

**Writing local changes.** Every story transaction the editor runs (`StorySession.run`: typing,
commands, paste, Undo of untracked edits) is followed, in a microtask, by a diff between the
shared document's current reading and the editor's model, written as one Yjs transaction:
untouched paragraphs at both ends are skipped by comparing their JSON; inside the changed stretch a
character diff (O(ND), at most 2000 differences, else delete-and-insert) yields insertions and
deletions; characters kept whose attributes changed are reformatted, one Yjs `format` per run of
equal changes. So:

- typing and deleting are character operations, and two people typing in one paragraph merge;
- splitting a paragraph inserts a mark and joining two deletes one, so text someone else types into
  a paragraph while it is split stays where they typed it;
- bold from one person and italic from another on the same words both apply (separate attributes);
- setting a paragraph property formats one mark; two people changing the same property of one
  paragraph keep one value (Yjs's deterministic winner);
- tables, styles, list definitions and page settings are atomic registers: concurrent edits to
  different tables or styles merge; to the same table, the last structural change wins while the
  text people typed in its cells stays (cells are body paragraphs).

**Reading remote changes.** An update from someone else is applied to the Yjs document (after this
person's pending changes are written, so the diff never mistakes their text for a deletion), the
model is rebuilt from it and validated by constructing a `TextDocument` (which checks that tables,
blocks and lists fit together), and the body, tables, styles, numbering, page settings, comments
and stories are replaced in the open editor without entering its Undo history and without the
protection guard or format tracking (they are someone else's edits). The caret and selection are
carried through as Yjs relative positions taken just before the update. During IME composition,
remote updates wait and are applied when the composition ends.

**Concurrent structural conflicts.** When two structural changes merge into something the editor
cannot show (two people restructuring one table at once), the last valid state stays on screen,
the notice bar says so, and the next change by an editor writes their valid model back over the
merged state for everyone.

**Single-editor mode.** Content the shared text cannot hold character by character (empty
content controls, whose runs have no text) switches the document to one editor at a time instead
of risking it: the person holding the lock edits normally and their whole model is published as a
snapshot (`meta.snapshot`); everyone else sees the document read-only with a notice naming the
holder, and gets **Edit Now** once the holder has left. When the content becomes shareable again
the holder's next change publishes it as shared text and everyone edits again.

## Undo

Undo and Redo in a shared document use a Yjs `UndoManager` that tracks only this person's
transactions (typing groups within 0.6 s). Undo takes back your own change and leaves everyone
else's in place; the caret returns to where the change was. The title bar's Undo button and list
mirror these stacks.

## Rooms, roles and transport

**Puter rooms.** Sharing a document saved to Puter deploys (once) or updates the owner's room worker
with `puter.workers.create`, keeps its address in the owner's app KV, creates a room holding the
original file (zipped from the opened package, so everyone's picture ids match) and the initial
Yjs state, and remembers the room for the file so the owner's next visit rejoins it. Requests are
signed as in the Whiteboard and Photo Studio apps: the browser mints a restricted Puter token that
can only read an identity file with its public key and signs the worker origin, file path and body
digest; the worker validates the token with Puter (`fs.stat` with strong consistency) and the
signature.

The worker keeps, in the owner's KV and files: room metadata, members (`owner`, `editor`,
`commenter`, `viewer`, `removed`), invitation links (hashed tokens, seven days), invitations by
Puter username, a numbered edit log with checkpoints every 100 updates, presence entries (30 s),
and the base file. It enforces roles on every request, independently of the interface:

- viewers cannot commit;
- commenters' commits may change only the `comments` map and comment anchors in the body (the
  worker applies the update to a scratch copy and compares everything else);
- updates may touch only the known top-level types; a commit that builds on edits the worker does
  not have is refused (409) and retried after a synchronization;
- only the owner invites, changes roles, removes people, turns off links and stops sharing.

Changes travel by commit requests; others' changes and the roster arrive with synchronization
requests, every second while others are here, every three seconds when alone, and at once after a
commit or a caret move. (The worker-based peer links of the Whiteboard app, which lower latency
further, are not used yet.)

**Local rooms.** A document that is not on Puter (the playground) can be shared between tabs of the
same browser over `BroadcastChannel`: the sharing tab holds the state and the file, and tabs that
join ask for them. Roles come from the link and each tab enforces them; there is no server. This is
for evaluating co-editing without an account and for the browser tests.

**Roles in the editor.** Viewers get the editor's view-only mode (the Editing/Viewing switch cannot
turn editing back on) and a notice. Commenters edit through the Review tab's protection guard in
comments mode (`protectionGuard({ edit: 'comments' })`), which refuses every change but comments,
plus a notice; it composes with the document's own Restrict Editing guard.

**Offline.** Every local change is queued in IndexedDB (memory where unavailable) before it is sent
and kept until the room accepts it; the title bar shows *Offline · N waiting*; changes go out when
the connection returns, also after a reload of the same room in this browser (Yjs updates are
idempotent, so a change delivered twice is harmless). Changes refused for good (access removed)
are dropped and the person is told.

## Saving the file

One tab writes the DOCX file: an owner's tab that has the file, the one with the lowest session id
when the owner has several open (presence entries say which tabs can write). It autosaves as usual
(`Doc`, AutoSave on or off in the title bar) after its own edits and after others'. Every other
tab's `Doc` stops saving (`setSaving(false)`): their edits reach the file through the room, so they
are never "unsaved". When the owner is away the room keeps the changes and the owner's next visit
saves them. Version snapshots continue to be taken by the writing tab and record who saved them.

When sharing stops or access is removed, the document stays open as the person's own copy, with
**Save a Copy** to keep it.

## Share dialog

Share (title bar, File → Share → Invite People…, the File view's Share page, Tools menu) opens one dialog:

- **Invite people**: Puter usernames (invitation by name: they open the link once signed in) or
  email addresses (a mail from the person's own Puter address with a link that admits them), with
  *Can edit*, *Can comment* or *Can view* and an optional message.
- **Share a link**: what people with the link can do, Copy Link, and Turn Off Earlier Links.
- **People with access**: members with their role (change or remove, owner only), who is here now,
  pending invitations.
- **Send a copy by email**: the document as a Word file or a PDF, attached to a mail from the
  person's Puter address (the Calendar app's `puter.email.send` approach: permission asked once on
  `forbidden`), or downloaded instead.
- **Stop Sharing** (owner).

Sharing starts with the first invitation or link; until then nothing leaves the device. A document
must be saved to Puter first (the dialog saves it).

## Version History

File → Browse Version History, the File view's Info page or the title bar's document details
open a pane listing the saved versions (`lib/versions.js`: one every ten minutes of editing, newest
30 kept), grouped by day, each with the account that saved it and an optional name, kept beside the
snapshot as `<snapshot>.json`. A document in the app folder keeps its snapshots under
`Documents/.versions/<name>/`; one elsewhere on the drive (inside the Puter desktop, Save puts a new
document where the user chooses) under `Documents/.versions-by-id/<tag>/`, named after the file's id,
which follows it through renames and moves. **Save a Version Now** asks for an optional name. A version opens
read-only beside the document in its own read-only canvas (both fit their width while it is open);
**Compare** runs the Review tab's Compare with the version as the original and the open document as
the revised one; **Restore**:

- in a shared document, restores the version's body, tables, styles, lists, page setup and comments
  as one change everyone receives, which Undo takes back;
- otherwise replaces the saved file exactly, after keeping a recovery version of the current one,
  and reopens it (as File → Info's Restore does).

## Assistant

The Assistant pane (its button in the title bar beside Comments, the Tools or View menu,
Cmd/Ctrl+Shift+I, or the small button at the bottom right of the pages) is a conversation with Puter's AI about and for this document,
consistent with the Spreadsheet and Presentation apps' assistant panels. Above the box the person
chooses what goes with a message, *Selection* or *Whole document*, and the line under it says how
many words that is; nothing else is sent. Suggestions in an empty conversation run the writing
assistant's actions (`lib/ai.js`: improve, fix grammar, shorten, summarize) or common requests
(summarize, list main points, suggest improvements, draft an introduction).

Replies are read as text for the document or as an answer. Text shows as a suggested replacement
(with the passage it replaces) or suggested text, and lands only when applied — *Replace
Selection*, *Insert Below*, *Insert After Selection* or *Insert at Cursor* — as one model
transaction that Undo (or the reply's own Undo) takes back; in a shared document it is shared like
any edit. Applying checks that the selected passage has not changed since the request. Without
Puter's AI (the playground) the pane, its buttons and menu items are not offered.

## Limits and known gaps

- Concurrent changes to the same table's structure keep one person's structure (atomic register);
  concurrent creation of new list definitions with the same numbering id keeps one definition.
- Header, footer and note stories are atomic per story: two people editing one header at once keep
  one person's version.
- Document-level settings outside the model (Restrict Editing's protection, review settings,
  document properties) are not shared live; the writing tab saves its own.
- Transport is request-based (about one second of latency on Puter); the Whiteboard app's WebRTC
  peer links are not used yet. Puter event notices are not used either.
- Remote carets are painted in the body only (not in headers, footers or notes).
- Version details (author, name) exist only for versions saved by this version of the app.
- Local (BroadcastChannel) rooms enforce roles in each tab only and need the sharing tab to stay open
  for new tabs to join.

## Tests

- `tests/collab-shared-doc.test.js`: mapping round trips, markers, concurrent typing, splits with
  concurrent typing, bold + italic merges, separate pictures, unsupported content, randomized
  convergence of three simulated people (25 seeds × 30 edits, random delivery order).
- `tests/collab-fixtures.test.js`: real documents from `tests/fixtures` round-trip through the
  shared document unchanged (paragraphs, tables, numbering, styles, comments) and validate.
- `tests/collab-binding.test.js`: the binding on a story session with an in-process hub: joining,
  concurrent typing with carets kept, per-person Undo/Redo, presence through edits, viewer and
  commenter enforcement (client and server check), the offline outbox, single-editor mode.
- `tests/collab-service.test.js`: the room service with an in-memory Puter: invitations and roles,
  role enforcement on commits, presence and incremental synchronization, stopping.
- `tests/collab-features.test.js`: Assistant prompts and replies, mail sending with the permission
  retry, version details.
- `tests/browser/collab.spec.js`: two tabs typing at once converge and Undo is per person; a
  view-only link; two Puter accounts (mock SDK + dev room server) with a comment-only invitation;
  restoring a named version; the Assistant applying and undoing a rewrite.
