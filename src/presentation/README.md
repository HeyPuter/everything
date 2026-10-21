# Presentation

A full-featured, open-source alternative to Microsoft PowerPoint that runs in the browser, built with vanilla JavaScript and Vite. Create, edit, present, record, and export real .pptx files. Puter.js is the only backend.

Nobody has to sign in to work: the app opens straight into a new presentation, and Puter asks for a sign-in at the first action that needs the cloud, such as saving or opening a cloud file. The library of presentations has its own address, `#/home`, reached from the editor's back arrow.

## Run locally

Requires Node.js 22.18+ (Node.js 24 LTS recommended).

```sh
npm ci
npm run dev
```

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

The production build is a static application in `dist/`. Serve it over HTTPS, including from Puter hosting. No application server, API key, environment variable, or database setup is required. The official Puter SDK loads from `https://js.puter.com/v2/`.

## App branding

The root `icon.png` is the source for the UI icon, favicons, Apple touch icon,
and manifest icons in `public/`. To regenerate them with Python and Pillow:

```sh
python3 -m venv /tmp/presentation-icons-venv
/tmp/presentation-icons-venv/bin/pip install Pillow
/tmp/presentation-icons-venv/bin/python scripts/generate-icons.py
```

The icon's red-orange is represented by `#c44730`, with `#f08b73` for contrast
in dark mode. App accents are defined in `src/style.css`; the browser theme
follows the active accent. `index.html` and `public/manifest.json` use the
primary brand color for initial browser and app metadata.

## Features

- A file library (`#/home`) with search, sorting, import, cloud open, rename, download, and confirmed deletion. Dropping a `.pptx` file anywhere on the window opens it, from the library or the editor. Presentations opened from elsewhere on the Puter drive (the desktop, "Open with", the Open dialog) are listed beside the Presentations folder with the folder they live in, and are followed by their file id when they are moved or renamed.
- A menu bar (File, Edit, View, Insert, Format, Arrange, Slide, Tools, Slide Show, Help) with the shortcuts beside its items, a ribbon (Home, Insert, Draw, Design, Transitions, Animations, Slide Show, Record, Review, View, plus contextual tabs for shapes, pictures, tables, charts, SmartArt, media, equations, and master views), and a Format pane. Phones fold the menus into the File options button.
- New presentations open on a Title Slide (or a blank slide, a preference under Appearance), and two five-slide starter decks are built on real layouts.
- Add, duplicate, hide, and delete slides, and reorder them by dragging their thumbnails along the navigator or from the slide menu. Hidden slides are marked in the navigator and skipped when presenting and printing.
- Insert tables of any size, type into their cells in place (Tab moves to the next cell), add and remove rows and columns around the current cell, and switch the header row and banding; the grid follows the table when it is resized. Font, size, bold, italic, underline, strikethrough, color, alignment, and vertical placement from the toolbar, the Format menu, or the panel apply to the current cell, which can also take a fill of its own.
- Insert text boxes, twenty shapes (rectangles, rounded rectangles, circles, triangles, diamonds, polygons, stars, hearts, clouds, speech bubbles, and block arrows), lines and arrows, and PNG/JPEG images; a picture wider or taller than 2560 pixels is scaled down to that size as it comes in, when that makes it smaller. Shapes and pictures take a border with a color, width, and dash style, and a rounded rectangle its corner radius; lines take arrowheads at either end. Pictures can be replaced, made transparent, lightened or darkened, cropped by percentage, and flipped, as can shapes. A slide takes a background image behind everything else. Dropping an image onto the editor inserts it on the current slide; a file held over the window says which of the two letting go will do.
- Cut, copy, and paste objects with the keyboard, the Edit menu, or a right-click menu, within a slide, across slides, and across presentations; pasting a picture or text copied from another app inserts it. Right-click menus on objects, the slide, and the navigator's thumbnails; objects can be brought to the front or sent to the back.
- Links on objects (Ctrl+K, the Insert menu, the right-click menu, or the panel) to a web address or to a slide; linked text reads as a link, and the links work while presenting. Only web, mail, and phone addresses open; any other address an imported file carries is shown in the panel and left alone.
- Find and replace (Ctrl+F, Ctrl+H) across every slide, including table cells, with a match count, matching case, replacing one match or all, and matched objects marked on the canvas.
- Select several objects with Shift-click, a marquee drawn across the canvas, or Ctrl+A, then move, copy, delete, reorder, or align and distribute them together, format their text together from the toolbar, the Format menu, or the keyboard, or group and ungroup them. A single object aligns to the slide.
- Double-click text on the canvas to edit, or use the format panel. Move objects with a pointer or arrow keys. Resize from any edge or corner handle or with numeric fields (images keep their proportions unless Shift is held; Shift keeps other objects' proportions), and rotate with the handle above the object (Shift turns in 15° steps) or the rotation field. While an object is moved or resized its edges and center snap to the slide's edges and center and to other objects' edges and centers, with a guide line showing what they met; Alt drags freely.
- Text formatting from the toolbar, the Format menu, the format panel, or the keyboard: fifteen font families, size, bold, italic, underline, strikethrough, text color, left / center / right / justified alignment, top / middle / bottom placement, bulleted and numbered lists with nested levels (Tab and Shift+Tab while editing, or the Format menu), line spacing, and the space before and after paragraphs. While editing, alignment, lists, and spacing apply to the paragraphs the selection touches. Any shape takes text: double-click it and type. While editing, select part of the text and bold, italic, underline, strikethrough, color, size, and font apply to that part alone, from the keyboard, the toolbar, or the panel, and the file keeps the mixed runs; text that already mixes formats keeps them through an edit. Fill, a drop shadow, object ordering, and image alternative text.
- Embed a supplied TrueType or OpenType font from File → Embed font, with confirmation of embedding rights. The font must match an authored family in the presentation and permit editing. Native font parts retain the full face bytes, survive export and object clipboard transfer, and support undo/redo.
- Slide transitions: see Desktop-editor features below.
- Several slides at once: Shift-click a thumbnail to select the range from the current slide, Ctrl-click to add or remove one, or Ctrl+A in the navigator for all. Selected slides duplicate, hide, move, drag, and delete together; Delete in the navigator removes them.
- Widescreen (16:9 or 16:10) or standard (4:3) slides from the File menu, with the content of every slide scaled to fit the new size, proportions kept and centered, when asked.
- Speaker notes, undo/redo, print-to-PDF through the browser, and the current slide or every slide downloaded as PNG images (all slides arrive in a ZIP). Presentation mode has keyboard and swipe navigation, fullscreen, a panel with the speaker notes and the next slide from the toolbar, next/previous navigation with N/P, an elapsed-time counter, a black or white screen (B / W), and typing a slide number followed by Enter to jump to it.
- The slide fits the window, or zooms from 25% to 400% with the footer control, Ctrl+= and Ctrl+-, Ctrl and the wheel, a pinch, or the View menu; Ctrl+0 fits it again. The zoom carries over to the next presentation.
- System appearance by default, with persistent light and dark overrides. Presentation artwork keeps its authored colors.
- Local recovery drafts in IndexedDB, separated by Puter account. Guest drafts remain local until saved to an account; the presentation the app opens with gets a draft only once it is edited.
- Explicit first cloud save followed by debounced autosave. A guest's save button reads "Sign in to save" and opens Puter's sign-in before the save; sign-ins the SDK performs on its own are picked up too. Writes are serialized, first saves deduplicate names, and failed saves retain the local draft. Save a copy to Puter (Ctrl/⌘+Shift+S) stores the presentation under a new name and continues in the copy; inside the Puter desktop, Puter's Save dialog chooses its folder too. Ctrl/⌘+O opens Puter's Open dialog.
- Before writing over a file, a save checks that it is as the presentation last saw it. A file saved from another tab or device since asks whether to replace it, open the other version, or save a copy; a file renamed or moved elsewhere is followed by its id; a deleted one offers to save the edits as a new file. Autosave holds off until the question is answered.
- A failed autosave shows in the save status ("Offline" or "Not saved to Puter") and is retried after 8 seconds, then at doubling intervals up to five minutes, and as soon as the connection returns. Leaving the editor saves a Puter file's pending edits first; when that save fails or finds a conflict, the person can keep editing, try again, or leave with the edits kept in a recovery draft.
- Puter desktop integration: a presentation launched with the app (a double-click, "Open with") is the first screen, without a blank deck before it; files and images dragged in from the desktop or a folder window open or land on the slide; the window title follows the presentation; and the window's close button saves pending edits first, or asks whether to save a presentation never saved to Puter. The app environment never shows or invokes logout, and downloads use Puter's Save dialog there.

## Desktop-editor features

The full plan and status are in [docs/roadmap.md](docs/roadmap.md).

- **Layouts and masters.** Eleven built-in layouts with placeholders that show prompts while empty; New Slide and Layout galleries drawn from the deck's own masters; Reset; quick-insert buttons in empty content placeholders; Slide Master, Notes Master, and Handout Master views.
- **Themes.** Twenty-two original themes, each a real theme with its own master and layouts, four variants each, custom colors and fonts, effect schemes, background styles, a Format Background pane (solid, gradient, picture, texture, pattern), themes applied to selected slides, and `.thmx` import and export.
- **Animations.** Entrance, emphasis, exit, and motion-path effects (including drawn paths), effect options, sounds, triggers, Animation Painter, and an Animation Pane with a timeline. Written to the file's timing tree and played in slide shows.
- **Transitions.** Forty-nine transitions in subtle, exciting, and dynamic-content groups, including 3-D effects and Morph (objects, words, or characters), with effect options, duration, sounds, and advance timing.
- **Slide shows.** Presenter View with an audience window, Set Up Slide Show (speaker, window, or kiosk), custom shows, Rehearse Timings, live subtitles, pen, highlighter, laser, and a full set of show shortcuts.
- **Record.** Per-slide narration with an optional camera bubble, retakes, a live camera object, and export to video.
- **Insert.** Tables, pictures, screenshots, photo albums, shapes, icons, SmartArt, charts with a data sheet, slide, section, and summary zooms, links, action buttons, comments, text boxes, header and footer, WordArt, date and time, slide numbers, equations, symbols, video, audio, embedded files, reused slides, and slides from an outline.
- **Charts and SmartArt.** Thirty-one chart types with embedded workbooks, Chart Design and Format tabs; forty-one SmartArt layouts with a Text Pane, SmartArt Design and Format tabs, and Convert to SmartArt.
- **Formatting.** Font, Paragraph (with tabs), Bullets and Numbering, and Columns dialogs; a Format pane with every fill, line, and effect type, including 3-D; shape, WordArt, and picture style galleries; picture corrections, color, and artistic effects; Change Shape, Edit Points, and Merge Shapes; Replace Fonts and Paste Special.
- **Draw.** Pens, pencils, and highlighters you can customize, lasso select, stroke and point erasers, Ink to Shape, Ink to Text, Ink to Math, ink replay, and a ruler.
- **Views.** Normal, Outline View, Slide Sorter with sections, Notes Page, and Reading View; rulers, gridlines, guides, and a Grid and Guides dialog; zoom.
- **Review.** Threaded comments with mentions, a spelling pane, AutoCorrect, thesaurus, translation, an accessibility checker with one-click fixes and a reading-order pane, Compare, and Always Open Read-Only.
- **File.** Export to PDF (slides, notes, handouts, or outline), PNG, JPEG, MP4, WebM, animated GIF, RTF or text outline, and `.potx`; a Print dialog with handouts and preview; Properties; Compress Pictures; a file-size report.
- **Start screen.** Describe a presentation and the AI drafts it; start from any theme; a library with pinned and recent presentations.

## AI assistant

**Ask AI** in the top bar, View → AI assistant, an object's right-click menu, or Ctrl/⌘+J opens a chat beside the slide in which Puter's AI (Claude Opus 5.5, through `puter.ai.chat`) answers questions about the presentation and changes it. It reads the deck through tools — an outline of every slide, one slide's objects with their ids, positions, text and formats, and a search — and changes it through others: adding, copying, moving, hiding, and deleting slides; adding text boxes, shapes, lines, and tables; rewriting text (each paragraph keeping its formatting), filling table cells, formatting text, restyling, arranging and deleting objects; speaker notes, backgrounds, transitions, find and replace, and the palette.

- Each message carries a short snapshot of the deck, the current slide, and the selection, which the chip above the message box names. Replies stream in, each tool call is a line linked to what it touched, and "slide 3" in a reply goes to that slide.
- Every change is one step in the editor's undo history, and a reply that changed the deck ends with an Undo for its own changes only, which turns off once anything else has changed the deck. A change that deletes slides or objects waits for Allow; the panel's menu can ask before every change, or never.
- The deck's text is data, never instructions: the model is told so, replies are rendered node by node with pictures never loaded and links to web and mail addresses only, and the tools neither fetch anything nor open links.
- Messages and the slides the assistant reads are sent to Puter's AI service. The chat belongs to the open presentation and is not saved; the panel's width, approval mode, and whether it is open are kept in localStorage.

## Storage and privacy

Cloud presentations are ordinary `.pptx` files written through `puter.fs.write` under `Presentations/`. Files opened elsewhere are saved back to their existing path. Presentation data is never stored in `puter.kv`. This application does not use KV at all.

Local recovery files use IndexedDB. Theme preference, the assistant panel's settings, and the list of presentations opened from elsewhere on the drive (paths and file ids, per account) use localStorage. Clearing browser data removes local drafts. The page must have loaded before offline editing is available; this is not an offline-installable PWA. Unsaved work remains local until the user chooses Save. Imported files are parsed in the browser and are not uploaded automatically.

Speaker notes are included in exported PPTX files, although hidden on the presentation canvas. Do not put information in notes that should not travel with the file.

## PPTX compatibility

The locally maintained engine in [`lib/pptx`](lib/pptx) owns the native document model. Editing does not rebuild an imported deck from a simplified JSON representation, so unsupported package parts can remain in the exported file. The local renderer in [`lib/pptx-preview`](lib/pptx-preview) produces previews displayed as SVG images, never as live imported HTML. Both libraries are absorbed source, maintained here with no upstream syncing; their MIT notices and original revisions are recorded in [`lib/README.md`](lib/README.md).

Both libraries are pre-1.0. Preview fidelity is approximate: fonts may be substituted, complex layouts can differ, and 3-D bevels and some picture effects are drawn approximately. Collaborative editing is not implemented. Equations and zoom objects are stored as pictures that keep their source for re-editing here, so other editors show them but cannot edit them. The canvas text editor keeps the formatted runs of the text it edits and formats a selection on its own, while the format panel's Content field keeps each paragraph's settings and the formatting its text starts with. PDF output uses the browser preview renderer.

Imports are limited to 200 MB, 300 slides, 12,000 ZIP entries, and 200 MB of declared decompressed archive data. Password-encrypted presentations and legacy `.ppt` files are not supported. Keep the original file when editing complex imported decks.

Automatic date/time fields use the document's opening date and refresh when presenting or printing. Their numbered formats follow language-dependent format mappings, including alternate calendars. Regional punctuation and month names come from the browser's locale data and may differ from other applications. Viewing and refreshing preserve the authored field language, ID and cached text in the exported document; unknown field types keep their cached display text. Editing adjacent text on the canvas, in the Content panel, or in a table cell preserves an untouched live field. Replacing the field's value turns it into literal text. Character formatting preserves live fields in text boxes and table cells; a formatting selection inside a field applies to the entire field.

## Tests

`npm run typecheck` checks the library source. Vitest also runs the inherited XML, OPC, and PresentationML unit tests, and exercises real PPTX save/load cycles, slide relationships, chart preservation, notes, preview escaping, archive guards, history branching, filename normalization, and the Puter storage boundary.

Playwright tests run the application at desktop, tablet, and phone sizes. They cover editing, native PPTX downloads, import, keyboard presentation navigation, recovery after reload, cloud success/failure, system/dark appearance, Puter app logout rules, and axe accessibility checks. Puter is mocked at the SDK boundary for deterministic tests. Real account authorization and production Puter integration still require a manual signed-in smoke test.

CI runs unit tests, the production build, and Chromium browser tests. Browser traces are retained on failure.

## Dependency review

See [DEPENDENCY_REVIEW.md](DEPENDENCY_REVIEW.md) and [third-party notices](public/THIRD_PARTY_NOTICES.txt). Third-party components retain their respective licenses.

## License

This app, including all its contents, modules, and components, is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). Third-party libraries included in this app may be subject to their own licenses.
