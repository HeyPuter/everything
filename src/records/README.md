# Records

**Live app:** [records.puter.com](https://records.puter.com/)

An open-source alternative to Airtable. Records is a relational database
that feels like a spreadsheet: tables of typed fields, records linked across
tables, and views that show the same data as a grid, board, calendar,
gallery, timeline, list or form. It runs on [Puter](https://puter.com) and
keeps everything in your own Puter cloud. No framework and no server of its
own: vanilla JavaScript, Vite and Puter.js.

> Records is in early development (alpha). Features may change and data
> could be lost, so do not rely on it for important work yet. Use **Download
> a backup** from the base menu to keep a copy.

## Features

- **Bases and tables.** Create bases from scratch, from templates (project
  tracker, content calendar, sales pipeline, inventory, event planning, bug
  tracker), from a CSV file, or from a backup. Star, rename, recolor,
  duplicate, trash and restore bases. Add, rename, describe, duplicate,
  reorder (drag the tabs) and delete tables.
- **27 field types.** Single line and long text, attachments, checkbox,
  single and multiple select, date (with optional time and time zone),
  phone, email, URL, number, currency, percent, duration, rating, barcode,
  link to another record, lookup, rollup, count, formula, autonumber,
  created and last modified time, created and last modified by, and button.
  Changing a field's type converts its values (text becomes options or
  linked records by name), and undo brings the old values back.
- **Linked records.** Links are two-way: linking a task to a project shows
  the task on the project. Lookups, rollups (sum, average, min, max, counts,
  unique values, join, all/any true, earliest and latest date) and counts
  read through links.
- **Formulas.** A spreadsheet-style language with 84 functions (logic,
  numbers, text, regular expressions, dates and working days, arrays),
  field references by name (stored by id, so renaming never breaks them),
  live validation and a function reference while you type.
- **Grid view.** Painted on a canvas, so it stays smooth with 100,000
  records. Select cells and ranges with the mouse or keyboard, edit in place,
  copy and paste to and from spreadsheets (new records and options are added
  as needed), fill handle and Ctrl/Cmd+D, resize, reorder, hide and freeze
  columns, drag rows, check rows for bulk actions, group up to three levels
  with collapsible groups, color rows, four row heights, and a summary bar
  (sum, average, median, min, max, range, standard deviation, counts,
  percentages, date ranges, file sizes).
- **More views.** Kanban (stack by a select, checkbox or single link; drag
  cards between stacks), calendar (drag records to other days, spans to an
  end date), gallery (cover images), timeline (drag and resize bars), list,
  and form (build a form, then fill it in to add records).
- **Every view** keeps its own filters (with and/or condition groups and
  date conditions like "within the past week"), sorts, field order, hidden
  fields and colors. Find in view (Ctrl/Cmd+F) highlights matches; quick
  search (Ctrl/Cmd+K) jumps to tables, views, records and other bases.
- **Records.** Expand any record to see and edit every field, step through
  the view with Ctrl/Cmd+Shift+, and ., leave comments, and see who created
  it and its recent changes (field, old and new value). Every record has a
  link.
- **Undo and redo** for every change, including field and table deletions.
- **Import and export.** Import CSV or TSV files as a base, a table, or new
  records in an existing table, with type detection and a preview. Download
  any view as CSV, print a view or a record, and download a whole base as a
  JSON backup.
- **Themes.** System (default), light and dark.
- **Everywhere.** Desktop, tablet and phone: the view list becomes a drawer,
  popovers become bottom sheets, records open full screen, and touch works
  (tap to select, tap again to edit, press and hold for menus, press and
  drag to move cards).
- **Accessibility.** Landmarks and a skip link, an ARIA grid whose active
  cell is announced (through `aria-activedescendant`, since the cells are
  painted), full keyboard support in menus, pickers and dialogs, visible
  focus, live announcements, reduced motion, and colors that meet WCAG AA
  contrast in both themes. Checked with axe in the tests.

## Where your data lives

All files go to the app's folder in your Puter cloud (`~/AppData/<app>/records/`):

- `index.json` lists your bases (name, color, starred, trash).
- `bases/<id>/base.json` holds a base's tables, fields and views.
- `bases/<id>/t/<table>/<n>.json` hold records, 2,000 per file, so a change
  rewrites one small file instead of the whole table.
- `bases/<id>/files/<attachment>/` hold attachments and their thumbnails.

Saves are batched (under a second after you stop typing) and kept under
Puter's write rate limit. Each change is first written to a journal in the
browser (IndexedDB), so closing the tab or going offline right after an edit
loses nothing: the journal is replayed the next time the base opens. When the
window regains focus, a base that another device saved is reloaded.

`puter.kv` is only used for small preferences, never for records or files.
Inside the Puter desktop (`puter.env === 'app'`) there is no sign-out, because
the session belongs to Puter. Profile pictures come from
`puter.auth.getProfilePicture()`.

## Performance

Measured in Chrome on a laptop with a 100,000-record table:

| | |
| --- | --- |
| Open the base | about 0.6 s |
| Repaint the grid while scrolling | 3 ms median, 5 ms at the 95th percentile |
| Sort by two fields | about 90 ms |
| Filter by text | about 15 ms |
| Edit a cell | about 12 ms |

Only visible cells are painted, sort keys are computed once per record,
computed fields are cached until the data changes, and view results are
memoized per change.

## Development

```sh
npm install
npm run dev     # http://records.puter.localhost:5261/
npm test        # Vitest with jsdom
npm run build   # checks dependency licenses, then builds into dist/
```

Add `?local` to the dev URL to use the app without a Puter account. Bases are
then kept in IndexedDB in that browser. It only works in development builds.

### Layout

- `src/data/` the model: field types (`fields.js`), the base and its
  operations with undo (`base.js`), computed fields (`compute.js`),
  formulas (`formula.js`), filtering, sorting and grouping (`query.js`),
  views (`views.js`), storage (`store.js`, `backend.js`, `journal.js`) and
  templates.
- `src/views/` the views: the canvas grid (`grid/`), kanban, calendar,
  gallery, timeline, list and form.
- `src/ui/` the app shell, home, base page, toolbar panels, field editor,
  cell editors and pickers, expanded record, import and export, menus,
  popovers and dialogs.

## Third-party code

- [Lucide](https://lucide.dev) (ISC) for icons.

`npm run check:licenses` fails the build if any installed package has a
license outside a reviewed list of open-source licenses.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
