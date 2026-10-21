# Notes

A free-form digital notebook on [Puter](https://puter.com): notebooks,
sections and pages, note containers you can place anywhere on the page,
tags, ink, tables, pictures, recordings and search. No framework and no
backend of its own, just Puter.js and Vite.

The window has a title bar, a ribbon (File, Home, Insert, Draw, View, Help
and a contextual Table tab), a navigation rail, a sections pane, a pages
pane and the page canvas.
All icons and artwork are original or from Lucide.

## Features

- **Notebooks, sections, section groups and pages.** Colored section tabs,
  nested section groups, pages with up to two levels of subpages that
  collapse and expand. Drag pages to reorder them (drag right to make a
  subpage) or onto a section to move them; drag sections between groups.
  Everything is also reachable from the keyboard and right-click menus:
  rename (F2 or double-click), color, Move or Copy, Copy Link, Delete.
- **Free-form pages.** Click anywhere to start a note container. Drag its
  top bar to move it, drag its right edge to set its width, Escape selects
  it, Delete removes it. The page grows as you write. Each page has a title
  and an editable date and time.
- **Formatting.** Font and size, bold, italic, underline, strikethrough,
  subscript, superscript, highlight and font colors, bullets and numbering
  with styles, indent, alignment, moving paragraphs up and down, copying
  formatting from one place to another, clearing formatting and paragraph
  styles (headings 1 to 6, page title, citation, quote, code, normal).
  "* " and "1. " start lists.
- **Tags.** To-dos, important items, questions, definitions and more than
  twenty others, with Ctrl/Cmd+1 to 9 shortcuts (Ctrl/Cmd+1 adds a to-do,
  marks it done, then removes it). A tag summary pane lists every tagged
  note by tag, section, page, date or text, lets you check off to-dos and
  creates a summary page.
- **Insert.** Tables (grid picker, contextual Table tab with insert,
  delete, select, borders, header row, shading, alignment, sort and convert
  to text; Tab adds rows), file attachments, PDF pages placed on the page
  as pictures with the file attached, pictures (paste, drop or pick;
  resizable, with alt text), screenshots, links to the web or to other
  pages and sections, equations (LaTeX with live preview), date and time
  stamps, shapes, horizontal lines, audio and video recordings, and page
  templates (meeting notes, to-do list, weekly planner, project overview,
  lecture notes, journal, recipe).
- **Draw.** Pens and highlighters with pressure, custom color and
  thickness, shape recognition (lines, ellipses, rectangles and triangles
  you draw become neat shapes), a stroke eraser, a lasso to move or delete
  ink and containers together, shapes (Shift constrains), and a spacing tool
  that pushes everything below a line down or pulls it up.
- **View.** Show or hide the navigation and page list, a reading view
  (text size, font, spacing, page theme and read-aloud with word
  highlighting), a full-page view, page colors, rule lines and grids, a
  light page in dark mode, zoom (buttons, Ctrl/Cmd+wheel, 100%, page width)
  and opening another window.
- **Search.** Search titles and text across all notebooks, a notebook, a
  section or the page, with highlighted snippets; Find on Page (Ctrl/Cmd+F)
  highlights matches without touching the note. Recent Notes lists pages
  by when they were edited.
- **Password-protected sections.** Pages, page titles, pictures,
  attachments and deleted pages of a protected section are encrypted
  (AES-GCM with a PBKDF2-derived key) before they are written; the password
  is never stored. Sections lock again after 10 minutes without use or with
  Lock All (Ctrl+Alt+L). Search, Recent Notes and Find Tags skip locked
  sections, and protected pages keep no page versions.
- **History.** Undo and redo for typing, moves, ink and page settings.
  Page Versions keeps earlier versions to preview and restore. Deleted
  pages, sections and notebooks stay in Deleted Notes for 60 days.
- **Share and export.** Publish a read-only link to a page (1 day to 1
  year, revocable), copy a link to a page, email a page, export a page as
  HTML, Markdown or text, print or save as PDF, export a section as HTML,
  and back up a notebook to a single .json file. Import Markdown, HTML,
  text and notebook backups.
- **Assist.** Summarize a page, find action items, suggest questions,
  rewrite or proofread a selection and ask questions about the page, using
  AI through the user's Puter account.
- **Dictate** into a note where the browser supports speech recognition.
- **Command search** (Alt+Q) finds and runs any command by name.
- **Key hints.** Press and release Alt to put letters on the ribbon tabs,
  then on the commands of the chosen tab, and type them to run commands
  without a mouse.
- **Themes.** System (default), light and dark.
- **Responsive.** Desktop and tablet use the panes side by side; phones get
  one level at a time (sections, pages, page) with a bottom bar and a
  scrolling ribbon.

## Keyboard

Ctrl on Windows and Linux, Cmd on Apple devices. Help > Keyboard
Shortcuts lists them all.

| Action | Shortcut |
| --- | --- |
| New page / subpage | Ctrl+Alt+N / Ctrl+Shift+Alt+N |
| New section | Ctrl+Alt+T |
| Make subpage / promote | Ctrl+Alt+] / Ctrl+Alt+[ |
| Search notebooks / find on page | Ctrl+E / Ctrl+F |
| Headings 1 to 6 / Normal | Ctrl+Alt+1 to 6 / Ctrl+Alt+0 |
| Tags | Ctrl+1 to 9, Ctrl+0 removes |
| Link | Ctrl+K |
| Date / time / both | Alt+Shift+D / T / F |
| Move paragraph | Alt+Shift+Up / Down |
| Indent / outdent | Tab / Shift+Tab, Alt+Shift+Right / Left |
| Zoom in / out | Ctrl+Alt+= / Ctrl+Alt+- |
| Full Page View | F11 |
| Lock all protected sections | Ctrl+Alt+L |
| Collapse the ribbon | Ctrl+F1 |
| Move between regions | F6 |
| Ribbon key hints | Alt (press and release) |
| Move a selected container | Arrow keys (Shift for 1 px) |

## Storage

Everything is a file in the app's folder of the user's Puter cloud
(`puter.fs`, relative paths); `puter.kv` is not used.

```
notes/library.json          notebook order
notes/notebooks/<id>.json   sections, section groups, page titles and order
notes/pages/<id>.json       page content: containers, ink, page settings
notes/versions/<id>.json    earlier versions of a page
notes/assets/<id>           pictures, attachments, recordings
notes/published/<id>.json   read-only snapshots behind shared links
notes/trash.json            Deleted Notes
```

Saves are debounced per file and retried on failure; the cloud icon in the
title bar shows the save state and syncs on click. Notebooks changed on
another device are picked up when the window regains focus.

Page content is HTML limited to an allowlist (`src/lib/sanitize.js`); every
paste, import, stored page and shared snapshot is sanitized before it
reaches the page.

## Inside a Puter app

When `puter.env` is `app`, the user is already signed in and the account
menu has no Sign Out item. On a website, a sign-in screen offers Continue
with Puter.

## Development

```sh
npm install
npm run dev        # http://localhost:5231
npm test           # vitest + jsdom
npm run build      # runs the license check first
```

`npm run dev` and open `http://localhost:5231/?local` to try the app with a
browser-only store (IndexedDB) instead of a Puter account. That mode exists
only in development builds.

## Third-party code

| Package | License | Use |
| --- | --- | --- |
| [lucide](https://lucide.dev) | ISC | Icons |
| [perfect-freehand](https://github.com/steveruizok/perfect-freehand) | MIT | Ink stroke outlines |
| [temml](https://temml.org) | MIT | LaTeX to MathML for equations |
| [pdfjs-dist](https://mozilla.github.io/pdf.js/) | Apache-2.0 | Rendering PDF pages for printouts (loaded on demand) |

`npm run check:licenses` rejects any dependency outside a reviewed set of
open-source licenses.

## License

This app, including all its contents, modules, and components, is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). Third-party libraries included in this app may be subject to their own licenses.
