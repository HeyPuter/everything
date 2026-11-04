# Wiki

**Live app:** [wiki.puter.com](https://wiki.puter.com/)

Docs, notes and databases for you and your team, on [Puter](https://puter.com).
Write with blocks, organize pages in a tree, track work in databases, and
share pages with people who can view, comment or edit them in real time. No
framework and no backend of its own: vanilla JavaScript, Vite and Puter.js.

## Features

- **Block editor.** Text, three heading levels, bulleted, numbered and to-do
  lists, toggles, quotes, callouts, code, dividers, tables, images, web
  bookmarks and subpages. Type `/` for the block menu and `@` to link
  another page. Markdown shortcuts (`#`, `-`, `1.`, `[]`, `>`, `"`, ` ``` `,
  `---`, `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`). Select text for
  the formatting bar (turn into, bold, italic, underline, strikethrough,
  code, link, text and highlight colors, comment).
- **Blocks you can move.** Drag the handle to reorder or nest blocks, or use
  the block menu (turn into, colors, duplicate, move, copy link, comment,
  delete). Escape selects the current block; arrows, Shift, Tab,
  Ctrl/Cmd+Shift+Up/Down, Ctrl/Cmd+D and Delete work on selected blocks.
  Undo and redo cover your own edits.
- **Pages.** Nested pages in the sidebar (drag to reorder or nest, F2 to
  rename), icons from a curated Lucide set in nine colors, color or image
  covers, full width and small text, page locking, favorites, recent pages
  on Home, templates (meeting notes, project brief, weekly plan, task
  board, reading list), and a trash with restore.
- **Databases.** Pages whose rows are pages. Properties: title, text,
  number, select, multi-select, status, date, checkbox, URL, email, phone,
  created and last edited time. Views: table (resizable columns, inline
  editing), board (grouped by a property, drag cards between columns),
  list, gallery and calendar, each with its own filters, sorts and visible
  properties, plus search.
- **Search.** Ctrl/Cmd+K searches titles and page text across every space,
  with snippets.
- **Comments.** Comment on a page or on a block (with the text it refers to),
  reply, resolve and reopen, edit or delete your own messages. Markers in
  the margin show blocks with open comments.
- **Sharing and live editing.** Share a page and everything under it. People
  you invite with a link join as editors, commenters or viewers; you can
  also open a space to anyone signed in who has the link, change roles and
  remove people. Edits merge as people type (Yjs), avatars show who is here
  and on which page, and the save status shows unsent changes.
- **Import and export.** Import Markdown files, export a page as Markdown or
  HTML, or print it to PDF.
- **Themes.** System (default), light and dark.
- **Everywhere.** Works with a mouse, a keyboard or a touch screen. Phones get
  a sidebar drawer and a block toolbar above the keyboard.
- **Accessibility.** Landmarks and a skip link, a tree with one tab stop for
  the page list, labelled text boxes per block, menus and dialogs with full
  keyboard support, visible focus, live announcements, reduced motion, and
  colors that meet WCAG AA contrast in both themes. Checked with axe in
  tests and in the browser.

## Where your data lives

- **Private pages** are files in the app's folder of your own Puter cloud:
  `wiki/tree.ywk` for the page tree, `wiki/pages/<id>.ywk` for each page,
  `wiki/pages/<id>.c.ywk` for its comments and `wiki/assets/<sha256>` for
  images. Each file is a Yjs document. Before a save, the app merges in what
  any other device saved since it last read the file, so two devices never
  overwrite each other. A copy in IndexedDB keeps unsaved edits through
  reloads and time offline.
- **Shared spaces** live on the account of the person who shared them. As in
  the Whiteboard app, each owner runs a small collaboration worker on their
  own Puter account (`worker/`, deployed with `puter.workers.create` the
  first time they share). Shared pages are stored as an edit log and
  checkpoints in the owner's KV and files. Invited people call that worker
  with a restricted credential that cannot act as their account, and the
  worker checks their role on every request. Live updates come through
  Puter events, with periodic synchronization as a fallback.
- **puter.kv** holds only small per-person lists: favorites, recent pages
  and the shared spaces you joined. Page content and files never go there.
- Inside the Puter desktop (`puter.env === 'app'`) there is no sign-out,
  because the session belongs to Puter. Your profile picture comes from
  `puter.auth.getProfilePicture()`.

## Development

```sh
npm install
npm run dev     # http://wiki.puter.localhost:5251/
npm test        # Vitest with jsdom
npm run build   # checks dependency licenses, then builds into dist/
```

Add `?local` to the dev URL to use the app without a Puter account. Pages
are then kept in IndexedDB in that browser, and sharing runs on a copy of
the real collaboration service inside the browser (`src/dev/local-collab.js`,
stored in localStorage). Open a second tab with `?local&as=bob` to be
someone else: paste an invitation link there (keeping `&as=bob`) to join a
space you shared and edit it together. It only works in development builds.

The collaboration worker is bundled into `public/worker/wiki-worker.js` by
`npx vite build --config vite.worker.config.js`. Rebuild it and commit the
bundle whenever code under `worker/` (or what it imports from `src/collab`)
changes. Owners' workers update themselves to the new build the next time
they open a shared space.

### Layout

- `src/data/` documents and storage: page tree (`tree.js`), blocks
  (`page.js`), rich text (`richtext.js`), databases (`database.js`),
  comments, Markdown, private storage (`personal.js`, `backend.js`), shared
  spaces (`shared.js`) and the workspace that ties them together.
- `src/editor/` the block editor, its formatting bar, touch bar and tables.
- `src/ui/` the app shell, sidebar, page view, database views, comments,
  sharing, search and dialogs.
- `src/collab/` and `worker/` the collaboration protocol, restricted
  credentials and the worker. Request authentication and the deployment
  flow are adapted from `src/whiteboard`.

## Third-party code

- [Yjs](https://github.com/yjs/yjs) (MIT) for documents that merge.
- [Lucide](https://lucide.dev) (ISC) for icons.

`npm run check:licenses` fails the build if any installed package has a
license outside a reviewed list of open-source licenses.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
