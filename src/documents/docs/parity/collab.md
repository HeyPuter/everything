# Co-authoring, sharing, version history and the Assistant: parity

What Documents offers for working together and for writing help, compared with the leading desktop
word processors. The design is in [collaboration.md](../collaboration.md).

## Implemented

**Share**
- Share button in the title bar (menu: Invite People…, Copy Link, Manage Access…, then the chrome's
  publishing and send-a-copy items), File → Share → Invite People…, the File view's Share page,
  Tools → Share…, Review → Collaborate → Share.
- Share dialog: invite Puter usernames or email addresses as *Can edit*, *Can comment* or *Can
  view*, with a message; copy a link with a chosen role; turn off earlier links; people with access
  with role changes and removal (owner); pending invitations; who is in the document now; Stop
  Sharing.
- Send a copy by email as a Word document or PDF from the person's Puter address (or download).
- Roles are enforced by the room server (Puter worker) and by the editor: viewers read only (the
  Editing/Viewing switch cannot override it), commenters can only add and answer comments (Review's
  protection guard in comments mode), with a notice bar explaining the role.

**Co-authoring**
- Real-time co-editing of the body: characters, run formatting, paragraph properties, paragraph
  splits and joins, lists, bookmarks and comment anchors merge per character; tables, styles,
  numbering definitions, page settings and header/footer/note stories as atomic registers; pictures
  and drawings added while shared are shared.
- Others' carets and selections in their colors with name flags; avatars of who is here in the
  title bar, a menu to go to someone's caret (Review → Co-authors, Tools → Co-authors).
- Per-person Undo/Redo: Undo takes back only your own changes.
- Offline: changes queue (kept across reloads) and are sent when the connection returns; the title
  bar says *Offline · N waiting*.
- The DOCX file stays the saved artifact, written by the owner's tab (AutoSave on or off); changes
  made while the owner is away are kept by the room and saved on the owner's next visit.
- Unsupported content (empty content controls) switches to one editor at a time with a notice and
  *Edit Now* when the editor leaves, instead of risking the document.
- Local evaluation without an account: Share in `playground.html` links tabs of the same browser.

**Version History**
- Pane (Review → Collaborate → Version History, File → Browse Version History, the File view's Info page,
  the title bar's document details) listing versions by day with who saved them;
  name/rename versions; Save a Version Now with a name.
- Open a version read-only beside the current document (both fit their width).
- Compare a version with the current document (the Review tab's Compare, run at once).
- Restore: exact file restore with a recovery version kept; in a shared document, one undoable
  change that everyone receives.

**Assistant**
- Assistant pane (Home → Assistant, Tools/View → Assistant, Cmd/Ctrl+Shift+I, a floating button at
  the page edge): ask questions about the document, draft, rewrite, summarize; suggestions for the
  selection (improve, fix grammar, shorten, summarize) and for the whole document.
- Explicit scope toggle (Selection / Whole document) with the word count of what is sent; nothing
  else is sent.
- Replies that are text show what they replace and apply only on request (Replace Selection, Insert
  Below, Insert After Selection, Insert at Cursor) as one undoable change; answers can be inserted
  or copied.
- Hidden when Puter AI is not available; the mock SDK answers in development and tests.

**AutoSave**
- The chrome's AutoSave switch drives `Doc` (cloud documents only); `w.autoSave({ enabled })` is
  provided as an alias. In shared documents only the writing tab saves.

## Approximated

- Latency: about one second between people on Puter rooms (request-based synchronization); the
  desktop products' push channels are faster. Local rooms between tabs are immediate.
- Concurrent structural edits of the same table keep one person's structure; concurrent edits of
  the same header or footer keep one version.
- Presence shows carets in the body only.
- Email invitations carry a link; there is no notification inside Puter for invitations by
  username (the owner shares the link, or the invitee opens it from the mail).

## Not implemented

- Document-level settings (Restrict Editing protection, document properties) are not synchronized
  live; the writing tab's are saved.
- Comment @mention notifications to people outside the document.
- Co-editing of documents that open read-only (preview-only features) — they cannot be shared for
  editing.
- "Track who changed what" attribution of every character (tracked changes still record authors
  when Track Changes is on).
