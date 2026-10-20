# Puter Mail

For the composer review, shipped improvements, remaining Gmail gaps, and verification steps, see [Composer audit](docs/composer-audit.md).

For measured loading/search improvements, benchmark reproduction, and remaining limits, see [Performance report](docs/performance.md).

A fast, private email client for your [Puter](https://puter.com) account. It reads the mailbox that Puter's `emailrx` backend extension writes into your account, renders every message safely as plain text, and sends mail through the `useremailtx` extension from your `@puter.email` address.

## How it works

### Receiving

Incoming mail lands in your Puter account as raw RFC 822 files:

```
/<username>/.mail/objects/<YYYY-MM-DD>/<uuidv7>--<base64url subject>
```

Because uuid v7 and the date folders both sort chronologically as text, the app lists newest mail first without any metadata lookups. The uuid is also the id every flag is keyed on. The list requests the first 8 KiB through the SDK for sender, time, and preview (up to 64 KiB for long headers); actual bytes depend on the deployed server honoring that limit. Opening a message reads its complete MIME file, including embedded attachments, and reuses a bounded session cache. Attachment decoding waits until requested. A custom Range transport and partial-reader experiment were withdrawn after reported deployment failures; reduced attachment transfer is not yet verified.

Plain text that arrives as `format=flowed` (RFC 3676) -- which is how Thunderbird and Apple Mail wrap a message at 72 columns before sending -- is read back into paragraphs, so it wraps to the width of the pane rather than arriving as a ladder of fixed-width lines that break again on a phone. Quote depth is kept, a space-stuffed line is unstuffed, and the `-- ` separator stays where it is.

### Sending

Sending is one request to the `useremailtx` backend extension:

```
POST {puter.APIOrigin}/email/send
Authorization: Bearer <puter auth token>
Content-Type: message/rfc822

<the whole RFC822 message>
```

The endpoint takes a complete message and parses it server-side. It enforces that `From:` is `<your username>@puter.email`, which is the one address this app sends as and the one the dialog shows, then walks the To/Cc list one recipient at a time: a recipient on that domain is delivered internally, by writing the message into their `/<recipient>/.mail/objects/...` mailbox — the same place inbound mail lands — and everyone else is relayed over SMTP. Recipients are unrestricted; the sender's own address is not.

Because the endpoint wants a whole message rather than fields, the app composes MIME in the browser (`src/lib/compose.js`): CRLF line endings, RFC 2047 encoded words for a non-ASCII subject, base64 `text/plain; charset=utf-8` for the body, and header folding at 78 characters. A message with attachments becomes `multipart/mixed` — the text part first, then one base64 part per file, with the filename written as an RFC 2047 encoded word *and* an RFC 2231 `filename*` when it isn't ASCII. The reader takes either form, plus RFC 2231's numbered continuations, since a non-ASCII name from Gmail or Apple Mail arrives only as `filename*`. The tests round-trip every composed message through the same parser the app reads mail with.

Attachments come either from the device (`<input type="file">`, or dropped onto the dialog) or from your own Puter files (`puter.ui.showOpenFilePicker()`), and are capped at 18 MB in total: the whole message is posted as one request body, and base64 inflates it by 4/3, so that is a 24 MB message. The cap is checked in the dialog, so an oversized file is reported next to the file it is about rather than as a rejected POST after a long upload. Each file's chip is one node, built once and repainted as its own read lands: the list used to be thrown away and rebuilt on every change — and one of the changes is *another* file finishing, which happens on its own schedule while the writer is doing something else. A chip replaced under a pointer takes the click that had already begun on it, so pressing Remove on one file did nothing at all if a second file's read landed in the moment between the press and its release.

To and Cc address a message to any number of people, and are lists rather than lines of text to say so: each address entered becomes a chip of its own, so taking one name off a message of six is a click instead of an exercise in editing a comma-separated string without breaking the addresses either side of it. An address is ended by Enter, by a comma or semicolon, or by moving on; a pasted list is split on the spot, in any of the forms another client hands out (`a@b.co, c@d.co`, names and angle brackets, semicolons, or a mix), while a single pasted address is left as text so a half-typed one can still be corrected. Backspace on an empty field takes the last chip back into it — the same path as pressing that chip, so the two say the same thing — and pressing any chip takes *that* one back — an address you can see is wrong should not have to be typed again from nothing, which is all a red chip used to offer. A chip is one tab stop carrying both of the things there are to do with a recipient: Enter corrects it, Delete removes it, and the ✕ beside it is the pointer's way to the second. A chip that is not an address says so in words as well as in red — `not-an-address is not an email address. Press Enter to correct it, Delete to remove it.` — because a colour and an icon are nothing to a screen reader and not much of an explanation to anyone else. A comma inside a quoted name — `"Doe, Jane" <jane@example.com>` — belongs to the address and does not end it. On a phone the field asks for the keyboard an address is typed on: `inputmode="email"` for an `@` without a trip to the symbols layer, and capitalisation, autocorrect and spellcheck all off — left to their defaults they capitalised the first letter of every address, rewrote domains that looked misspelt, and underlined the rest in red. Not `type="email"`, because the field takes a whole list and names with angle brackets in them, and one address per box is not its shape. Duplicates collapse, and an entry that names no address is marked where it was entered rather than at the far end of a refused send. Underneath it is still the one comma-separated string that a draft stores and that the address-list parser reads, so nothing else in the app had to learn about chips.

A field that grew a row for every second recipient was a field that pushed the subject, the message being written and the Send button off the bottom of the dialog — eighteen names and the writer could not see the message at all. Past four addresses the rest go behind a `+14 more`, and the whole list opens again the moment the field is used: addressing a message is when the names matter and writing one is when they are in the way. An address that is not one is never behind the count — the field's whole answer to a mistyped address is to mark it where it was entered, and a mark nobody can see is not one — so the list opens as far as the last bad address however far down it is. Removing a name works while the next one is still being typed, too: a press on a control that belongs to this field is not leaving the field, so it neither ends the address being written nor rebuilds the chip out from under the click.

Typing into To or Cc completes against the addresses this app has already seen. There is no address book to build and none to sync: the header index that makes search affordable (`src/lib/search.js`) already holds the sender and recipients of every message the list has read — with the message's date beside them, and with the messages this account sent marked as such, since only their recipients are people it wrote to. `src/lib/contacts.js` asks that cache a second question, so a completion costs no read, no request, and no new storage; it is as complete as the browsing that has already happened, and a mailbox that has never been opened offers nothing rather than a wrong guess.

Who comes first is decided by three things in order. **Someone written to outranks someone who has merely written**, which is the signal that matters: a newsletter has sent you two hundred messages and is never who you meant to type, while an address you have sent to even once is one you chose. Then how often, then how recently. A match on the start of a name, an address, or a *domain* — typing a company name to reach the people at it — outranks a match in the middle of one.

**Nothing is highlighted until an arrow key highlights it.** Enter goes on meaning the address that was typed, never the address the app guessed, because guessing wrong here does not mistype a search — it sends a message to the wrong person. Down and Up walk the list, Enter or Tab takes the highlighted one, Escape puts the list away without closing the dialog, and a click never blurs the field on its way in. What lands in the field is the bare address, which is what a chip has always held and what a draft stores, so nothing downstream learned about completion. A chip whose address the book knows shows the person's name in place of it -- `ana@meridianlabs.example` is who to a machine and "Ana Petrova" is who to the person writing -- with the address in the tooltip and underneath, where the draft, the send and pressing the chip to correct it all still find it.

What a screen reader hears is the change, not the list. The field used to be one live region wrapped around everything in it — including the completion list — so every keystroke that offered six names read all six of them back on top of what the combobox was already saying. A line of its own now says the one thing worth hearing: `bo@example.com added. 2 recipients.`, `ana@example.com removed. 1 recipient.`, or `Already on the message.` where a duplicate collapsed and the field looks unchanged for it.

Replies carry `In-Reply-To` and `References`, so a conversation started here holds together in Gmail, Apple Mail, or whatever the recipient uses; the reference chain is trimmed to its most recent 20 entries, which is what RFC 5322 allows and what stops the header growing without bound. Reply all fills To from `Reply-To` (or `From`) and Cc from the remaining To and Cc, with the user's own address removed and duplicates collapsed — and because that first group is empty when the message is one you sent, Reply on a sent message answers the people it went to rather than mailing you. A forward gets a `Fwd:` subject, an empty recipient, the standard forwarded header block above the quoted text, and the original attachments, whose bytes are already decoded in the open message.

Sending and draft behavior:

- **No Bcc field.** The server writes *the same bytes* into every recipient's mailbox, so a `Bcc:` header would be delivered to — and readable by — everyone on the message. Rather than ship a Bcc that silently isn't blind, the app doesn't offer one.
- **Send stays where it can be pressed.** The footer sits outside the scrolling content, so it cannot cover the message or clip the editor’s focus ring. Recipient inputs and chips share a fixed control height; the row grows only when recipients need another line. Keyboard focus uses a row underline for addressing and an inset ring for the body.
- **A refused send says why on a line of its own.** The message used to be wedged into the button row between the attach controls and Discard. Most of what it ever says is an address — one long token with no space in it to break at — so it did not wrap: it ran out of its box and over the control that throws the draft away. It now has the full width of the dialog above the buttons, breaks anywhere it has to, and takes up no room at all when there is nothing to say.
- **Every address is validated before the message is posted**, and each one again as it is entered. The server validates too, but inside its delivery loop — a malformed address partway down the list throws only after the addresses above it have already been delivered. Checking the whole list up front prevents known invalid addresses from reaching the server’s delivery loop; server-side failures can still cause partial delivery.
- **Undo Send holds delivery for a configurable interval.** Settings → Writing offers 5, 10, 20, or 30 seconds, or immediate delivery. Undo restores the message and its attachments. Leaving the page during the interval cancels delivery and keeps the draft; the app does not attempt an unreliable unload-time send. The draft is removed only after delivery succeeds. A pending draft cannot be reopened and sent a second time in the same app session.
- **A send in flight is visible, and cannot be lost.** The Send button spins its icon and refuses a second press, and Discard is off for the duration — a message already on its way is not one to throw away underneath itself, and doing so left a failure afterwards with no draft to fall back to. Closing the dialog while waiting is fine, because closing keeps the draft; a failure that arrives after the dialog has gone is said in a toast rather than written to a status line that is no longer on the page.
- **The sent copy is filed by the client.** The extension writes only to the recipients' mailboxes, so once the POST succeeds this app writes the same bytes to `/<username>/.mail/sent/<YYYY-MM-DD>/<uuidv7>--<base64url subject>` — the naming rule `emailrx` uses, so the same listing code reads it, and a sibling of `objects/` so a sent copy never appears in the inbox. If that write fails the send still happened, and it is reported as a separate, quieter failure rather than as a failed send.

### Signature

**Settings → Signature** sets a signature once, and every message started after that carries it -- at the foot of a new message, and between the reply and the quoted text in an answer or a forward, which is where a mail client puts one. It is plain text, entered in a dialog that shows it under the same `-- ` separator it will be sent under (RFC 3676), which is what lets Thunderbird grey it out and mutt trim it from a quote; anything typed there can still be formatted in the editor once it is in a message. A resumed draft is not signed a second time: it holds whatever it was signed with when it was started. A new message closed with nothing in it but the signature leaves no draft behind, because nothing was written -- and neither does a reply, a forward or an address clicked in a body that is closed before a word is typed into it, which otherwise left a row in Drafts holding only the quote of a message nobody answered. The setting lives in a small per-account store (`src/lib/settings.js`), a pure function over an injectable storage like the drafts beside it.

### Formatting

The message body supports bold, italic, underline, strikethrough, five fonts, four sizes, seven text colours, highlighting, alignment, custom links, bulleted and numbered lists, quotes, and clear formatting. The header expands the composer for longer messages and minimizes it to a draft bar while you use the inbox. Restore returns to the same editor with its selection, undo history, and attachments intact. Reopening that draft from the inbox restores the existing composer instead of duplicating it. Tables and inline images remain outside the editor vocabulary; pasted screenshots become attachments.

**A message is still text.** `src/lib/richtext.js` converts the editor's markup both ways, and `htmlToText` is not a consolation prize — it is the `text/plain` part of every message sent from here, and for plenty of recipients it is the whole message. Bold and colour have no text equivalent and go; structure does and is kept: a list becomes `- item`, a quote becomes `> line`, and a link whose text is not its URL keeps the URL beside it in angle brackets. A formatted message goes out as `multipart/alternative` with the text part first, because the parts of an alternative run worst-to-best and a client shows the last one it understands.

**A message that was never formatted is still sent as plain text.** `hasFormatting` detects explicit formatting and custom links. Quoting alone does not require HTML because the plain-text part preserves it with `> ` prefixes. Every HTML message also contains a readable plain-text alternative.

**Custom links have an editor.** Select text and press ⌘/Ctrl+K or the link button to insert, edit, or remove a link. Web addresses and email addresses are validated before insertion. The browser retains its native Undo history. Bare URLs are still automatically linked when an HTML message is built.

**Pasted markup is not trusted.** A paste can carry a whole page of markup from anywhere, and it reaches the editor by way of `innerHTML`, so `cleanHtml` runs on the way in, again on every read, and once more over a draft coming back from storage. Like the reader's sanitizer it is an allowlist — of elements, of style properties, *and* of the value each property may take, because `font-family` is an ordinary property and `font-family: x; } body { display: none` is an ordinary attempt at breaking out of one. An element that is a block but has no control here (a heading, a table cell) becomes a `div` so its line break survives; an inline element it doesn't know is unwrapped to its words. A pasted screenshot has nowhere to go in a message with no inline images, so it becomes an attachment rather than nothing at all.

The toolbar is one tab stop, not eleven. Every control on it used to be its own, so getting from the subject line to the message with the keyboard meant eleven presses past buttons nobody was reaching for and eleven more coming back — for a strip whose every control is also a menu item or a ⌘ key. That is what `role="toolbar"` has always promised: Tab reaches the toolbar, ← and → move within it, Home and End reach the ends, and Tab again leaves for the message. The stop stays on whichever button was used last. A formatting menu opens inside the toolbar, so its items are within reach of the same key handling — the arrows there belong to the menu, which answers them itself.

The editor drives the selection through `document.execCommand`. It is deprecated, and it is also the only thing in the platform that knows what "make the selection bold" means — splitting the nodes a selection runs across, remembering a mark for the *next* character typed at a collapsed caret, and putting all of it on the browser's own undo stack so ⌘Z still works. Its font commands still emit `<font face size color>`, with `size` on the 1–7 scale from 1995, so each one is followed by a pass that rewrites those tags as `<span style>`. That pass moves the text out of the tag execCommand just made, which the platform reads as a removal — so it collapsed the selection, and choosing a font *ended* it: a size or a colour over the same words meant selecting them all over again, and there are three of these menus. The selection is measured as character offsets into the body before the rewrite and taken back over the same characters after it, so a font, a size and a colour stack on one selection. The toolbar describes the caret it is actually at. A drag that begins in the message can end anywhere — past the edge of the field, over the toolbar — and the field never hears the release, so it went on describing the selection before last and the next command applied to *that* one. The release is now heard wherever it happens, one listener per drag. Moving the caret programmatically says so too, which is how a draft and a reply are entered: opening a draft that ends in bold put the caret inside the bold, where the next character typed would be bold as well, under a Bold button reading off.

Each of the three menus marks what is in effect where the caret is, which means the position it reads has to be *inside* what was applied: an offset that falls exactly on the boundary between two runs of text belongs to the start of the second, not to the end of the first. They are the same position, and only one of them is inside the span the command just made — landing on the wrong one had the size menu answering Normal for a word that had just been made Huge. A collapsed caret is left exactly where the command left it: there the browser is holding a style for the next character typed, and a fresh range in the same place is not the same position to the platform. Every command is guarded: where `execCommand` is missing the editor degrades to a plain typing surface rather than throwing.

### Folders

Five folders, all of them plain directories beside each other under `.mail`, and all read by the same listing code:

```
/<username>/.mail/objects/    delivered mail, written by emailrx   -> Inbox
/<username>/.mail/sent/       your copy of what you send           -> Sent
/<username>/.mail/archive/    out of the inbox, still yours        -> Archive
/<username>/.mail/trash/      deleted, still recoverable           -> Trash
```

Starred filters inbox flags. Drafts are account-scoped local compose fields in `localStorage` (`src/lib/drafts.js`), with attachment bytes in a separate IndexedDB store (`src/lib/draftfiles.js`). Text saves on a short debounce, close, page hide, and backgrounding. Attachments save when the attachment list changes, survive reloads, and are removed after sending or discarding; Undo discard restores them. The visible status distinguishes saving, saved, and failed states. Storage failure warns before closing. These drafts are local to the browser, not synchronized across devices.

Trash carries the one action that applies to the whole folder: **Empty Trash now**, above its rows, lists the whole folder first so the confirmation names the real count rather than the page that happens to be loaded, then deletes every file in it with the meta line counting them down. It is the other thing undo cannot cover, so it confirms the way a single permanent delete does.

Rows can also be dragged onto a folder in the sidebar, which is the other way every desktop mail client has always moved mail: what is dragged is what a row action would act on -- the ticked rows if there are any, else the row under the pointer -- and the drop is the same move the buttons make, with the same Undo. Where a drop can land follows from where the rows are (Archive and Trash from the inbox, Trash from Sent, Inbox and Trash from Archive, Inbox and Archive from Trash), and the folders that will take the drop say so while it is in the air. Leaving Archive or Trash by a drag is a restore whatever it lands on, so the next Restore does not send the message back into the Trash it was dragged out of.

Archiving and deleting are `puter.fs.move()` calls between those folders. The day folder and the filename never change, so read and star flags — which are keyed on the filename — survive the move, and so does the newest-first ordering. It also makes undo exact: the reverse move puts the file back, which is why an archive or a delete offers "Undo" in a toast instead of asking for confirmation first. A permanent delete from Trash is the one thing undo cannot cover, so that one confirms — with a dialog of the app's own, because a Puter app runs in a cross-origin iframe and Chrome suppresses `window.confirm` there, answering "no" without showing anything. Restoring returns a message to the folder it came from, remembered per filename alongside the read and star flags.

### Conversations

A row is a conversation, not a message, and opening one stacks its messages under a single subject — the Gmail shape. It can be turned off under **Settings → Reading**, and turning it off makes every conversation one message long, which is the list this app had before threading: the same code path, grouping nothing.

**What belongs together.** `src/lib/thread.js` decides that with three rules, in order of how much each can be trusted:

1. A message that references another message in the folder joins it — unless the subject changed. Renaming a thread is how people split one, and Gmail treats it that way too.
2. Two messages that reference the *same* id join each other, even when the message they both answer was never delivered here. That is what threads a conversation whose beginning went to someone else, or is in another folder.
3. Where neither of those linked anything, one subject with a reply among its messages is a conversation. This catches the clients that drop `References` — and, just as importantly, does *not* catch two unrelated "Invoice" notices, because neither of those is a reply to anything. Rule 3 only ever looks at messages the headers left orphaned, so a proper reply to one of those two invoices joins its own target and drags nothing else in.

Reply and forward prefixes are stripped before subjects are compared, in the forms mail actually arrives in — `Re:`, `Fwd:`, `Re[2]:`, and the localised ones Outlook and Apple Mail emit. A mailing list tag is *not* stripped: a list rewrites the subject and the replying client disagrees with it about the order, so `Re: [dev] patch` and `[dev] Re: patch` are made to match, while `[ops]` and `[dev]` stay apart.

**Sent replies stay in the conversation.** The reader also finds related messages in Inbox, Sent, and Archive, including older pages. A successful send adds its saved copy to the open thread immediately, and so does a reply delivered while the conversation is open — it goes under what is being read, opened and marked read, where before it reached the row but not the reader until the conversation was closed and opened again; reopening from any of those folders recovers the same history. Whatever arrives under the reader is added to what is on screen rather than drawn over it: the messages already there keep their state (open or folded, a quote unfolded, the formatted view, the keyboard on whichever control had it), their files are not read a second time, and only the new messages get cards, put in their place in the stack. A message that was on its own gains the folds of one among several when the rest of its conversation turns up. Cross-folder matching uses message IDs and references, with a shared-correspondent fallback for headerless originals. Folder actions still apply to the messages in that folder, so archiving an Inbox conversation leaves Sent copies in Sent. History loads in the background, so the message clicked can be read at once; only the headers of messages whose subject could match are read. The three folders are asked through the catalogs the shell already keeps — one listing per folder, then answered from memory — and a folder's catalog is dropped whenever something is filed into it, sent into it, or changed in it from another device, so what is answered from memory is never older than the last change. Listing the folders afresh on every open cost a readdir per day folder of Inbox, Sent and Archive together, behind every click.

**Folder grouping reuses header reads.** A message id and its references live in the header block, which is inside the 8 KB head the list already reads per row for the sender and the preview line — and the header index (`src/lib/search.js`) keeps them, so a folder is grouped from the filesystem once and from the cache after that. What does change is *when* that read happens: a conversation cannot be drawn before it is known which messages are in it, so the reads for a page happen up front rather than as rows scroll past, with a static list skeleton after a brief delay while they do. On a folder that has been opened before, or searched, there is nothing to read and nothing to wait for.

Only two references are cached per message: the first, which is the conversation's root and is repeated by every message in it, and the last, which is that message's own parent. A `References` header can carry twenty ids of forty characters each, and the index has to fit in a single key-value entry — while root and parent are what actually do the linking, the root even where the middle of a thread was never delivered here.

**A conversation is inside one folder.** The folders are directories, and an action on a row has to apply to exactly what the row stands for: archiving a conversation archives every message in it, and one Undo puts all of them back. The cost of that is real and worth saying out loud — a reply you sent is filed in `sent/`, so it is in the Sent conversation rather than in the inbox one. Threading also only covers what has been listed, so "Load older messages" can bring the beginning of a conversation that is already on screen; the page is grouped against what is listed rather than appended beside it, and the row that was already there takes it in without moving.

**Flags belong to the conversation, files to the message.** A conversation is unread if any message in it is, and starred if any message is — so opening one marks all of it read, and one click on the row's star clears whichever message was carrying it. Starring from the row marks the newest message, which is the one the row is about; each message in the reader has its own star for when that is not what is wanted. Nothing about the flag store changed: it is still keyed on filenames, and a conversation is a question asked of it rather than a thing stored in it.

**Archiving or deleting from the reader can carry on to the next conversation.** It goes back to the list by default, as Gmail does; **Settings → Reading** switches it to opening the next conversation (or the previous one, at the end of the list), which is how a full inbox is worked through with one hand. Which conversation is next is decided before the move, while the row is still there to count from, and checked again after it.

**A folder can be read through without going back to the list.** The reader's toolbar carries the conversation's place in the list -- `3 of 42` -- and an arrow either way; `j` and `k` are the same two moves from the keyboard, as they are in Gmail's reader. The arrows follow whatever rows are on screen, so in a search they walk the results and in Starred the starred ones, and they stop at the ends rather than wrapping.

**The reader opens what you came for.** The newest message is expanded, along with up to five recent unread messages whose complete bytes are already cached; the rest are single lines — who wrote, the preview, the date — and a collapsed message's file is not read until it is opened, so a conversation of twenty downloads what is actually read rather than twenty messages. Reply, Reply all and Forward answer the newest message, which is the one an answer belongs under -- usually. The thing to answer is sometimes the question three messages up rather than the "thanks" under it, so every open message in a conversation carries a menu of its own, beside its date, with the same three for *that* message: the reply threads on its id and quotes its text. The menu also holds **Copy sender's address** -- the bare address onto the clipboard, which beats selecting exactly the part between the angle brackets -- **Show details** -- From, Reply-To, To, Cc, the full date, Subject, Message-ID and the attachments, as a table, for when the sender's name is not enough and View source is too much -- and **Download original (.eml)** -- the message as it arrived, the same bytes View source shows, under the subject's name -- which is how a message leaves this app for another one; a message on its own has that and nothing else there, since the block below already answers it. Each expanded message keeps everything the single message view ever had: the plain text default, its own attachments, and its own sandboxed HTML view. The sender's name is the control that opens and closes a message for the keyboard and a screen reader — a real button, so the menu beside the date and an Unsubscribe link beside the name are controls of their own rather than the children of one, which a screen reader would take for the button's label and never reach — while the whole header line does the same under the pointer.

One control in the toolbar opens every message in the conversation or folds every one to a line, and says which of the two it will do; it is absent on a conversation of one, where there is nothing to fold. On a phone that control, Print and View source sit behind one More button at the end of the toolbar -- nine buttons at a finger's size are wider than the screen -- and the rest of the toolbar stands as it does on a desktop.

The copy of the previous message that a reply carries at the end of itself is folded away behind a `···`, because in a conversation it is on screen twice. Only a trailing block is taken, and only when there is a message left in front of it — a message that is nothing but a quote is shown whole, since hiding it would leave nothing at all. A message opened on its own is not folded: there is nothing above it to repeat.

**Search still answers about messages.** A search result is the message that matched, not everything that message happens to be threaded with — three messages of one conversation carrying a word are three results. Answering with conversations would mean either reading the whole folder before the first result, or regrouping the list under the reader as the index filled; and "which message in here matched?" is a question the reader would then have to ask. Drafts are not threaded either: a draft is not in a conversation yet, and its row opens the dialog it came from.

### Permissions

Reading asks for one permission up front: read access to `/<username>/.mail`. The mail delivered to you in `objects/` is never modified, and nothing is ever deleted unless you delete it.

Sending, archiving, and deleting all need **write access to `/<username>/.mail`**. For sending, `/email/send` checks it before it looks at anything else in the request. The app does not ask on launch — the permission dialog prompts every time it is called, so asking up front would mean a dialog on every single launch. Instead it sends optimistically, and only when the server answers `403 Write access to … required` does it request `fs:/<username>/.mail:write` and retry the same message once. The retry is safe precisely because that check runs before any delivery, so a refusal can never have half-sent anything. The other 403 the endpoint returns — sending from an address that isn't yours — surfaces as an ordinary error instead of an unexplained consent dialog.

### Read and starred state

Flags belong to the account, not to a browser. Read/unread and starred are kept in `puter.kv` — app-scoped per user, so no filesystem permission and no prompt — with `localStorage` in front of it as a synchronous cache the list renders from immediately; the account store is read and written in the background, because a flag is a display detail and must never delay the list.

Both sides are the same shape: a message id mapped to *when* it last changed, in whole seconds, positive when the flag is on and negative when it was turned off. Keeping the "off" side is what lets "mark as unread" survive a merge with a device that still thinks the message is read — the merge is last-write-wins per id, so two devices reading different mail merge to both being read, and a tie keeps the flag on rather than losing a star. `mergeFlags()` is a pure function with tests, since two devices marking different messages read is the normal case, not an edge case.

Ids are the uuid v7 part of the filename rather than the whole name: it is already unique per message, and dropping the base64 subject makes the payload about a third of the size, which matters when the whole set has to fit in one key-value entry. Five thousand entries are kept, most-recently-changed first. If `puter.kv` is missing or unreachable the app carries on with local flags only.

A conversation's read and starred state is derived from its messages' rather than stored beside it, so nothing here changed when the list started grouping them.

### Search

Search covers the whole folder, not the rows on screen. Two things make that affordable: a filename carries the subject, so listing the date folders searches every subject in the mailbox with no message reads at all; and sender, preview line and attachment flag come from the same 8 KB head read the list already does per row, kept in an index (`src/lib/search.js`) keyed by filename in `localStorage`. The index is built once per account rather than once per search, is extended by ordinary browsing, and is used to fill in rows without a read at all — so a mailbox that has been searched once lists instantly afterwards.

While it is still being built, the meta line says what has actually been searched — `31 results · searching 98 of 210` — rather than implying a complete answer, and results appear as they are found. A subject-only query is complete the moment the folder has been listed, because the filenames are enough.

Field prefixes: `from:`, `to:`, `subject:`, `body:`, `before:` and `after:` with a date (`2026-08-01` or `2026/08/01`; `after:` includes the day named, `before:` excludes it, so the two together bracket a month), `has:attachment`, `is:unread`, `is:read`, `is:starred`, `is:unstarred`. Quoted phrases stay whole, every term has to match, and an unrecognised prefix -- or a date that is not one -- is searched as text rather than silently dropped. A date term is answered from the day folder a message is filed under, which every listed message has before anything is read, so a date query is complete the moment the folder is listed; where the header has been read its own date is preferred, because the folders are named in UTC. Full body search would mean downloading every message; headers plus the preview line cover the realistic case, and the UI says so instead of implying otherwise.

Results are messages rather than conversations — see [Conversations](#conversations) for why. Results use 60-row pages; the count covers all matches. Loaded folder conversations use windows of at most 300 rows, with controls to revisit earlier windows.

### Watching for new mail

The mailbox is watched, not polled. At launch the app subscribes to `fs:/<username>/.mail` with [`puter.events.onLocal()`](https://docs.puter.com/Events/onLocal/): one subscription covering every folder, costing nothing while nothing changes. When emailrx writes a message the app is told the path within a few hundred milliseconds, and `createMailbox().sync()` lists exactly what landed — normally one newest-first recursive `readdir` page, stopping at the newest known message; large folder lists and older SDKs use the root/day traversal — and prepends it. Nothing already on screen is rebuilt, so new rows appear without moving the scroll position, disturbing an open message, or clearing a search. Events are gathered for half a second before they are acted on, so a burst of mail is one listing rather than one per message.

The same subscription hears what your other devices do. A message archived, deleted or restored from another tab or another phone leaves its folder here the way it would have if the action had been taken here — its row goes, or its conversation shrinks — and the folder it went to is re-listed when it is next opened, or at once if it is on screen. A message put back into the inbox is listed, not announced: it is not new. The app tells its own writes from another device's by remembering the paths it has just written, because an event's `self` flag names the account rather than the tab, and the account's other tabs are exactly what the watch is for. A `gap` marker — the server saying it dropped something — re-lists every folder rather than trusting what is on screen. `src/lib/watch.js` is the reading of events as changes to folders; it touches neither the DOM nor the network.

A check that finds nothing says nothing: no toast, no re-render. When mail does arrive it shows up in three places — the rows themselves, the unread count in the document title, and, if it arrived while a message was open or the list was scrolled down, a "2 new messages" pill in the list toolbar rather than a jump. Desktop notifications are off until you turn them on in Settings, because `Notification.requestPermission()` has to be user initiated; they only fire while the window is not focused — which now includes a tab that is hidden, since events arrive whether or not the tab is visible. Clicking one is the reader asking to see it: one message opens, a handful go to the top of the inbox, and a search that was on screen is cleared first, since what arrived is in the folder and not necessarily in the results.

Where the subscription cannot be had — a Puter without the Events API, a server with it turned off, or a lapse the SDK could not reconnect from — the app falls back to what it did before: a visible tab looks every 60 seconds, a hidden one not at all, and every tick tries for the subscription again. Either way, a tab coming back into view or coming back online makes one check of its own, since a connection that slept with the laptop may have missed a delivery.

### The keyboard

Five shortcuts worked before there was a sheet to print them on, and they only worked while focus was inside the message list — so Compose had no key at all, and Archive had one that stopped working the moment a message was opened. The same shortcuts are now asked of the whole app.

`c` writes a message, `/` searches, `j` and `k` walk the list -- and, with a message open, read on to the older or the newer conversation -- and `g` followed by a folder's key goes there — `i` inbox, `s` starred, `t` sent, `d` drafts, `a` archive, `#` trash. A chord is namespaced by its first key, so those letters stay free to mean what they mean alone: `s` stars a message and `g s` opens Starred. A second key that names no folder ends the chord rather than falling through to whatever it does on its own.

With a message open, `r`, `a` and `f` press Reply, Reply all and Forward — the same functions the buttons call, so `a` does nothing on a message with nobody else on it, for the same reason the button is absent there. `s`, `u`, `e` and `#` apply to the open conversation the way they already applied to a focused row.

Three things decide when a key is a command rather than a character: it carries no ⌘, ⌃ or ⌥ (Shift is not one of those — `?` and `#` are typed with it); nothing is being typed into, which covers the search field, every compose field and the message body; and nothing is in front of the app. That last one is why the listener sits on the document rather than on the app frame — most of the time the keyboard is on nothing in particular, and a listener on the frame never hears a key pressed there — and why an open dialog or menu, both of which answer their own keys, silences it.

In the compose dialog, ⌘/Ctrl + Enter sends — and nothing else does. A bare Enter in To or Cc ends the address being typed and does nothing else; it used to fall through on an empty field to the form's own meaning for Enter, so a second press after entering an address, or one press after removing the last, sent the message. A bare Enter in the subject goes to the message, the way it does in every other mail client, rather than sending a message with nothing written in it. Sending is the one thing in this app nobody can take back, and it should not be a keystroke anyone arrives at by accident. Every field in that form except one already submitted on Enter, and the one that did not is the message — where Enter is a new line and always will be, and where the writer is standing when the message is finished. So the single most common thing anyone does in the dialog was the only one with no key: the way out of a finished message was to leave the keyboard, find the pointer, and come back. The chord presses the Send button rather than submitting the form, so a send already in flight is not started again by an impatient second press, and the completion list stands aside for it rather than reading it as "take the highlighted name".

`?` prints the whole list, and so does **Settings → Keyboard shortcuts**, because five shortcuts that nothing mentions are five shortcuts nobody uses. The sheet is built from the same constants the dispatcher reads, so it names the folders this account actually has.

### Links

Links in a plain text body are real links: `http`/`https` URLs, bare `www.` hosts, `mailto:` URLs, and bare addresses. `src/lib/linkify.js` returns *segments* rather than an HTML string, and the reader builds a text node or an anchor per segment — no mail-derived string is ever assigned to `innerHTML`, which is the one place the app's "mail is data, never markup" rule could have quietly stopped being true. Only those three schemes can come out of it, so a `javascript:` or `data:` URL in a body is text and nothing else. Trailing sentence punctuation and an enclosing bracket stay out of the URL, while a balanced one inside it (`…/Foo_(bar)`) is kept. An address becomes the same compose the Reply button uses, prefilled.

Flattening HTML no longer throws the hrefs away: where a link's text is not the URL, the URL is kept beside it in angle brackets, so an HTML mail whose only call to action was a button reading "Verify your email" is followable in the text view. Block elements end lines too, because a wall of text with URLs spliced into it is not readable.

Every link says where it goes. Hover or focus shows the full URL, and where the host as written is not the host the browser would connect to — a homograph, or userinfo smuggled in front of the real host — the real one is shown next to the link. `https://раypal.com/login` renders as what it is: a link to `xn--ypal-43d9g.com`. The same check runs inside the HTML view, where a link's text can claim anything.

### Printing

The reader's **Print** button prints the open conversation and nothing else: a print stylesheet takes away the frame, the list and every control, lets the message run the length of the paper rather than scroll inside a box, and writes each link's address after it, since a link on paper goes nowhere. Every message in the conversation is opened first, because a page with `···` lines standing for half the conversation is not the conversation. ⌘P prints the same page.

### Leaving a list

A message that names a way off its mailing list in `List-Unsubscribe` (RFC 2369) gets an **Unsubscribe** control beside its sender. Most of what a newsletter offers for this is a link at the foot of its HTML, which the text view flattens and the sanitizer may well have disarmed -- and the header is what the list actually honours. A `mailto:` there becomes a message from this app, prefilled with the subject and body the list asked for and shown before it goes, so the user sees exactly what is sent and from where; failing that, an `https:` URL opens as an ordinary link in a new tab with the host in the tooltip. Nothing is posted on the user's behalf: a one-click POST from the browser would be an opaque request whose outcome could not be reported, to a host the header chose. Anything in the header that is neither mail nor the web -- a `javascript:` URL, say -- is not a way out this app offers. Mail the user sent never shows one, whatever its headers say.

### The HTML view

Plain text is the default for every message and stays fully functional. When a message has a `text/html` part, the reader offers a second view of it, rendered only when asked for and only for that message:

- The frame is `<iframe sandbox srcdoc>` with **neither `allow-scripts` nor `allow-same-origin`**. Without scripts nothing in a message runs; without same-origin the frame is a unique opaque origin that cannot reach this app's storage or its Puter token. The only capabilities granted are `allow-popups` and `allow-popups-to-escape-sandbox`, so a link the reader clicks opens as an ordinary tab.
- A `Content-Security-Policy` inside the frame (`default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data:`) is what stops a tracking pixel: nothing loads unless it is named there, and remote images are only named once the reader presses **Show images**. That choice is remembered per sender, not globally. The frame is opened up by what the reader has allowed, never by what the app managed to detect — so a tracker the detector misses still does not load; detection only decides whether the reader is told anything is being held back. Detection covers the whole document, `<head>` stylesheets included, which is where a newsletter usually keeps its CSS.
- The markup is sanitized first anyway (`src/lib/sanitize.js`), because a typo in a sandbox attribute should not be the difference between a rendered newsletter and a disclosed token. It is an allowlist: an element or attribute it does not name does not survive; `script`, `iframe`, `object`, `embed`, `form`, `meta`, `link`, `svg` and friends are dropped with their contents, every `on*` attribute goes, and only `http`, `https` and `mailto` survive as links — with `target="_blank"` and `rel="noopener noreferrer"` applied by the sanitizer rather than copied from the message. A stylesheet that would fetch something remote has its `url()` neutered while remote content is refused, so CSS is held to the same rule as an `img`.
- Inline images referenced by `cid:` are rewritten to `data:` URLs from the MIME part that carries them, so a message's own images work with remote content still blocked. A part that claims to be anything other than an image is refused.
- The frame's height cannot be measured, precisely because there is no same-origin access to it, so it scrolls internally at a fixed height and can be dragged taller. A wide table scrolls inside the frame instead of dragging the page sideways.

### Safety model

- Plain text is the default view. HTML is rendered only when you ask for it, in a sandboxed frame that cannot run scripts, reach this app, or load remote content until you allow it.
- Markup is filtered on the way *out* too. What you paste into a message reaches the editor as HTML, so it goes through an allowlist first — of elements, of style properties, and of the value each property may take. A message you send carries no script, no stylesheet, no remote reference, and no link that isn't `http`, `https` or `mailto`, whatever the page you copied it from was carrying. Every message also goes out with a real plain-text part, so no recipient is handed markup as their only option.
- Attachments are listed with name and size, and are only decoded when you open one: an image is shown in place, in a dialog with the download beside it, and everything else is downloaded -- to the device, or into your own Puter files through the OS's save dialog. SVG is not previewed, because it is a document that can carry script rather than a picture, and a very large image is a download rather than a preview. The name is shown and saved with the invisible characters taken out, so an attachment cannot use a right-to-left override to read as `report.pdf` while being `report.exe`.
- Read/unread and starred state is kept in your account's key-value store, which no other app can read, plus a local cache. Nothing about your mail is sent anywhere else.
- The app writes only what you ask it to: the copy of a message you send, and the moves behind archive, delete and restore. Nothing in your mailbox is deleted unless you delete it from Trash yourself.

## Features

- Calendar invitation cards above the message body, from inline `text/calendar` parts or `.ics` attachments: event title, date and time with the sender's timezone, location, organizer, guests, meeting links, and the original invite download. All-day ranges, durations, recurring-event indicators, and cancellations are supported; RSVP sending and calendar synchronization are not implemented.
- Gmail-style interface: header search pill, collapsible folder sidebar with a Compose pill, rounded content card, single-line rows with bold unread and tinted read states, and a list-to-message reading flow
- Conversation view: one row per thread with its participants and message count, a reader that stacks the conversation oldest to newest with the newest and anything unread expanded, quoted replies folded away, and archive, delete, star and read/unread applying to the whole conversation with one Undo — grouped by `References` and `In-Reply-To` with a subject guard, from the same header read the rows already cost, and switchable off in Settings
- Compose and send from your `@puter.email` address, to any number of recipients on Puter or off — To and Cc hold one removable chip per address, split a pasted list, and mark anything that isn't an address as you enter it — with Reply, Reply all, and Forward — replies threaded with `In-Reply-To` and `References`, forwards carrying the original attachments
- Recipient completion from the addresses the app has already seen, ranked by who you have written to rather than who has written to you, out of the same header index that answers search — and offered rather than applied, so Enter still means the address you typed
- Undo send: a message is held for five seconds (or ten, or thirty, or not at all) with an Undo that brings it back intact, attachments included
- A signature set once under Settings and added to every new message, reply and forward, under the standard `-- ` separator
- Limited rich text in the body — bold, italic, underline, strikethrough, a few fonts and sizes, text colour, lists and quotes — sent as `multipart/alternative` so every recipient gets a real plain-text message too, and sent as plain text alone when nothing was formatted
- Attachments from your device or your Puter files, added by button or by drag and drop, with a removable chip per file and a size cap checked before sending
- Sign-in gate, permission flow, and a first-run onboarding tour
- Unsubscribe from a mailing list from beside the sender, out of the `List-Unsubscribe` header the list actually honours: by a prefilled message where the list takes mail, by the list's own page otherwise
- Clickable links in every message, with the real host shown where a link's text disagrees with where it goes, and addresses that open a prefilled compose
- Optional HTML rendering per message in a sandboxed, CSP-restricted frame, with remote images blocked until you allow them and inline `cid:` images inlined from the message itself
- Inbox, Starred, Sent, Archive, and Trash folders, with read and starred state synced to your account so it follows you between devices
- Every sent message filed in your own account, listed newest first by the same code that reads the inbox
- Archive and delete from a row, from the message toolbar, from the keyboard, or by dragging rows onto a folder, each with an Undo toast; Trash restores to where a message came from, deletes for good after a confirmation, or is emptied in one confirmed action
- Mark as read and mark as unread from a row, the message toolbar, the selection toolbar, or the keyboard, and mark everything on screen as read in one press — the whole folder, not just the loaded page — with Undo
- Multi-select with bulk archive, delete, and read/unread — and, once a page's rows are all ticked, the offer to select everything in the folder, so a bulk action covers the three hundred behind the sixty on screen
- Keyboard shortcuts across the whole app — `c` compose, `/` search, `j`/`k` through the list and from one open conversation to the next, `g` then a letter for a folder, `r`/`a`/`f` on an open message, and `x` `s` `u` `e` `#` on a row or a conversation — with `?` for the sheet that lists them
- Mail that appears as it lands, and folders that follow what your other devices do, over a filesystem subscription rather than polling — with an unread badge in the tab title, a non-intrusive new-mail pill, and opt-in desktop notifications
- Drafts that survive closing the dialog, a reload, or a lost tab: autosaved while you type as both text and markup, listed newest first in their own folder, reopened where you left off with the formatting intact, and cleared by sending or by an undoable Discard
- Search across the whole folder — sender, subject, preview, and field prefixes (`from:`, `to:`, `subject:`, `before:`, `after:`, `has:attachment`, `is:unread`, `is:starred`) — with honest progress while the index builds
- Attachment preview for images, download to the device or into your Puter files, view source, print, download a message as `.eml`, per-sender avatars
- A menu on every open message in a conversation, to reply to or forward that message rather than the newest
- Light, dark, and system theme (system is the default), and a compact density for anyone who reads a lot of mail
- Keyboard navigation (arrow keys, Enter, Escape) and screen-reader friendly markup

## Development

```sh
npm install
npm run dev       # start the Vite dev server
npm test          # run the vitest suite
npm run build     # production build into dist/
npm run preview   # preview the production build
```

No frameworks: the UI is plain DOM, styled with hand-written CSS, with [Lucide](https://lucide.dev) for icons and [Puter.js](https://docs.puter.com) as the only backend.

`puter.APIOrigin` is read at send time, so the app targets whichever backend the SDK is pointed at — `api.puter.com` in production, `api.puter.localhost:5101` in local development, with no change here.

## Project layout

```
src/
  lib/        pure logic, no DOM beyond a parser and no Puter:
                mime.js       RFC 822 / MIME parsing, address lists, bodies
                compose.js    MIME composition, reply recipients, validation
                richtext.js   the compose editor's HTML vocabulary, both ways
                mailbox.js    folder listing, paging, the new-mail check, moves
                watch.js      filesystem events under .mail, read as changes to folders
                thread.js     grouping a folder into conversations
                sanitize.js   the allowlist behind the HTML view
                linkify.js    links in a body, as segments rather than markup
                search.js     query parsing, matching, the header index
                contacts.js   the index read as an address book, and ranked
                drafts.js     the draft store
                settings.js   per-account preferences: signature, undo send, auto-advance, density
                readstate.js  read, starred, restore-origin, image consent
                format.js     display formatting
                sample.js     the test mailbox, over an in-memory fs
  ui/         DOM: shell, compose dialog, formatting editor, gate screens,
              onboarding, menus, modal, toast, theme, the shortcut sheet,
              the signature dialog
  styles/     design tokens, base components, app screens
tests/        vitest suites for every lib module, and for the shell, the
              compose dialog and folder search over the test mailbox
example.html  reference implementation of mail receiving on Puter
```

Everything in `lib/` is a pure function over strings, bytes, or an injected store, which is why the suite covers the parts that matter without a browser: MIME round-trips, the sanitizer's payload set, the rich text vocabulary in both directions, the linkifier's awkward cases, the flag merge, the search index, the contact ranking, and the mailbox listing against a fake filesystem. The shell is tested over `lib/sample.js`, an in-memory mailbox of realistic messages (quoted-printable, base64, encoded words, multipart, attachments including an image, an HTML newsletter carrying a script, a `javascript:` link, a tracking pixel and an inline image, and a three-message thread with the `Message-ID`/`References` chain a real client writes), so archiving, deleting and restoring run against a real listing rather than a stub, and the safe path and the grouping are both exercised for real.

## Populate a demo

After signing in and letting the mailbox load, run this in the browser console:

```js
await email.populateSampleData()
```

Available in development and production builds. Adds 16 fictional Northwind Studio
messages to the inbox, including a three-message conversation, an HTML newsletter
and a CSV attachment, then refreshes the inbox. Nothing is sent: the helper writes
MIME files through the existing mailbox filesystem and write-permission flow.
All fictional addresses use `.example`, and every message identifies itself as
sample content. Existing mail is preserved. The samples survive reloads and can be
archived or deleted normally. Each completed call adds a fresh batch; overlapping
calls share one operation. Returns `{ created, paths }`. On failure it rejects with
the number already saved; those files remain, and another call starts a fresh batch.

## License

This app, including all its contents, modules, and components, is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). Third-party libraries included in this app may be subject to their own licenses.
