# PDF Editor

<img src="icon.png" alt="PDF Editor icon" width="96" />

A focused, framework-free PDF web app for Puter. Built with vanilla JavaScript, Vite, PDF.js, pdf-lib, and Lucide. Warm neutral surfaces and red accents reflect the app icon.

## Run

Use Node.js 24 LTS (Node 22.12+ also works).

```sh
npm ci
npm run dev
```

## Build and test

```sh
npm test
npx playwright install chromium webkit firefox
npm run test:e2e
npm run build
npm run preview
```

Deploy all of `dist/` to a static host, including `pdfjs/`, `fonts/`, and `THIRD_PARTY_NOTICES.txt`. `pdfjs/standard_fonts/` includes the Liberation Sans fonts (GPL v2 with a font exception); their corresponding source ships beside them in `pdfjs/standard_fonts/liberation-source/`, so deploy that directory too. Relative asset paths support deployment in a subdirectory. There is no server component, database, API secret, or environment configuration. The only backend integration is Puter.js, loaded from `https://js.puter.com/v2/`.

GitHub Actions runs unit tests, a production build, and Chromium desktop/mobile, WebKit, and Firefox integration checks. The browser suite uses a deterministic Puter boundary mock, not a real cloud account; actual account sign-in, permissions, cloud file picker behavior, and storage quota must also be exercised in the target Puter app.

## Features

The workspace follows the layout of desktop PDF editors (Adobe Acrobat was the reference; all icons and artwork are original): a title bar with the menus and the document tab; tool sets (Tools, Edit, Comment, Export, Fill & Sign) with Find text or tools, undo/redo, Download, Print, and Save; a tools pane listing every tool and then holding the chosen tool's commands; floating quick tools beside the page and floating page and zoom controls; and navigation panels opened from a rail on the right (Pages, Outline, Comments, Attachments, Layers, Signatures, Accessibility check). Pages scroll continuously (or one page, or two side by side), and the page under the middle of the view becomes the page being edited.

- **Organize pages:** a grid of every page with multi-select, drag to reorder, rotate, duplicate, extract, insert (blank, from a PDF, pictures), and delete. **Combine files** puts PDFs and pictures, in a chosen order, into a new PDF. **Batch process** applies the same steps (rotate, watermark, page numbers, Bates numbers that continue across files, flatten, remove hidden information, OCR, reduce size, password) to many PDFs and downloads the results in a ZIP.
- **Redact a PDF:** mark selected text, dragged areas, whole pages, or Find text and redact (words, phone numbers, email addresses, card numbers, SSNs, dates), then apply: text, image pixels, drawings, links, comments, and fields under each mark are removed from the file, not covered; optionally remove hidden information (metadata, scripts, attachments, hidden text and layers, and more), also available on its own.
- **Scan & OCR:** recognize English text on scanned pages on the device (Tesseract), adding an invisible text layer that makes them searchable and selectable; pages that already have text are skipped.
- **Export a PDF:** Word (.docx), Excel (.xlsx), PowerPoint (.pptx), RTF, HTML, and plain text, with headings, lists, tables, columns, running headers and footers, and pictures; and pages as PNG or JPEG.
- **Use a certificate:** sign or certify with a digital ID (a .pfx/.p12 file, or a new self-signed ID downloaded as .p12), appended as an incremental update so earlier signatures stay valid; validate every signature (integrity, certificate chain and validity, changes after signing, timestamps, certification level) in the Signatures panel, with a status bar above the pages and a warning before an edit would invalidate a signature.
- **Prepare a form:** add text, date, check box, radio button, dropdown, list box, button, and signature fields by dragging; move, resize, and edit their properties; detect fields on flat forms; set tab order.
- **Add comments:** sticky notes, highlight/underline/strikethrough, text box and callout comments, pencil drawings, shape comments (rectangle, oval, line, arrow, cloud), and stamps; select drawn comments to move, restyle, reply to, or set their review status; export and import comments as XFDF, and a comment summary.
- **Compare files:** two versions side by side with insertions, deletions, replacements, formatting and picture changes, and added, removed, or moved pages, plus a report PDF.
- **Prepare for accessibility:** a full accessibility check with fixes (autotag, title, language, alternate text, field descriptions, tab order, bookmarks from headings). **PDF standards:** check PDF/A compliance and save as PDF/A.
- **Measure:** distances, perimeters, and areas at a chosen unit and scale, saved as labelled comments.
- Headers and footers with Bates numbering, watermarks, and page numbers can be removed again; Document details shows the fonts and edits the initial view (layout, panel, page, magnification, title); View offers Read mode, Full screen, Read out loud, and the Hand tool (or Space-drag).

- No sign-in needed to work: the app opens straight into a blank PDF. Open local files, drop a PDF anywhere, edit, download, and print, all without an account. Puter asks for a sign-in at the first action that needs the cloud: saving, opening a cloud file, or the library, which lives at `#library` (the back arrow in the editor).
- Open local files, drop a PDF anywhere, open a blank PDF, or try the built-in sample from the library. Pictures become PDFs too: choose or drop PNG and JPEG files (several at once) and each lands on its own Letter or A4 sheet, turned to match and fitted to the page; phone photos are set upright from their EXIF orientation. The Page menu inserts pictures as pages after the current page.
- Password-protected PDFs open after asking for their password (RC4 and AES-128/256 encryption from any writer; files that only restrict permissions open directly). A protected file keeps its own passwords, permissions, and encryption when downloaded, saved, extracted, or split, whichever of its passwords opened it. User access follows the document’s permissions for content editing, comments, forms, page assembly, copying, and printing. Select the Protected badge to view permissions and unlock owner access; changing or removing existing protection requires the permissions password. Low-resolution-only printing is limited to 150 dpi through File → Print. Protect a PDF from the File menu with a password to open and, optionally, a permissions password that limits printing, copying, commenting and form filling, or editing without it. Downloads and saves are then encrypted with AES-256, the header shows a lock while a password or restriction applies, and the File menu changes or removes it. Merging a protected PDF asks for its password too.
- Puter library with search, sorting, download, rename, duplicate, and confirmed delete.
- Comments panel: a Comments tab beside Pages lists every sticky note and markup in the PDF by page, with its text, author, date, and color; choosing one goes to its page and opens the note or selects the highlight. The tab shows the count.
- Outline (bookmarks) panel: PDFs with an outline get an Outline tab beside Pages, a folding tree whose items jump to their pages, with arrow-key navigation and the current page marked. Add a bookmark for the current page from the Page menu; rename or remove any bookmark from its right-click or long-press menu in the Outline tab. Deleting a page redirects bookmarks and internal links that target it to the next page (the previous page when deleting the last one), preserving nested bookmarks and destinations to surviving pages.
- High-fidelity PDF.js rendering, selectable text, lazy thumbnails, fit-width, fit-page, and 25–400% zoom with zoom buttons, keyboard shortcuts, and Ctrl / Command + wheel or trackpad pinch zooming around the pointer, page navigation, and find with a match count that steps match by match across pages, highlighting every hit on the page and the current one in orange (Enter and Shift+Enter move between matches).
- Selection properties live in a fixed right sidebar, or a bottom dock on smaller screens. Text, images, shapes, highlights, notes, and crop actions share this area; text formatting stays in the contextual toolbar, and move/resize handles stay on the page.
- Use Select to pick up and drag text, images, and shapes. Click a text box to select it and double-click to edit, or use Text to add or edit words directly on the page. Changes are kept when you click away, select another object, or save; no Apply or Add text button is needed. Click blank page or workspace to deselect. Adjacent fragments form one editable line while retaining mixed fonts and colors; compatible aligned lines form paragraphs that reflow as you type or change their width. Adjust paragraph width by dragging, with arrow keys, or by entering a width in points. Move text, adjust its size and color, change bold or italic (Noto Sans faces), underline, and strikethrough from the selected text’s toolbar, drag its outline while typing, cancel with Escape, or finish with Ctrl / Command Enter.
- Highlight selected text across lines, or choose Area to highlight scanned content. Underline and strikethrough are text formatting controls beside Bold and Italic; their lines stay attached when text moves, resizes, or changes, including after export and reopen. Existing highlight, underline, and strikethrough annotations from other editors remain selectable, recolorable, and deletable.
- Sticky notes: choose Note and click the page to leave a comment as a native Text annotation with a popup that other readers open beside its icon. Click a note in Select to read it with its author and time, change its text or color, or delete it, including notes from other editors.
- Headers and footers (Insert menu): text in any of the six corner and center positions along the top and bottom edges, with {page}, {pages}, {date}, {title}, and {file} filled in per page, upright on rotated pages and tagged as pagination artifacts.
- Watermarks and page numbers (Insert menu): stamp a translucent text watermark, diagonal or horizontal, in three sizes with a chosen color and opacity across all pages, the current page, or a range; number pages in any corner or centered at the top or bottom, in formats such as `Page 1 of 9` with a chosen start number and size. Both read upright on rotated pages, are tagged as pagination artifacts for assistive technology, and remain ordinary text that the Text tool can revise or remove.
- Add freehand drawing, rectangles, ellipses, lines, arrows, and check marks or crosses for ticking boxes on scanned forms (a click places one, a drag sizes it; Shift keeps shapes regular and snaps lines to 45 degrees), and PNG/JPEG images. Select supported existing images to move, resize, or delete them after export and reopen, with live drag previews, corner handles, numeric dimensions, and optional proportion locking.
- Links: click a web or in-document link in Select to edit its destination. Open link and Go to linked page are separate, explicit actions; a right-click or long-press menu also offers editing, copying, and removal. Editing preserves the link’s bounds and appearance and supports undo/redo. Protected PDFs offer link options while respecting editing permissions. Script and local-file addresses are never followed but can still be corrected or removed. Insert → Link… then drag over text or an area (or place one at the page center from the keyboard) to link it to a web address, email, phone number, or a page of the PDF.
- Stamps (Insert menu): APPROVED, REVIEWED, COMPLETED, FINAL, DRAFT, CONFIDENTIAL, VOID, SIGN HERE, or any short text in a chosen color, placed in the middle of the page as one vector object that is selected right away for moving, resizing, or recoloring.
- Sign PDFs: draw a signature with a mouse, pen, or finger, type your name in a script font, or upload a PNG/JPEG. The signature lands in the middle of the page, selected, ready to drag and resize, upright on rotated pages. Drawn and typed signatures become single vector objects that stay editable; signatures made in a session can be reused, and, only when you tick "Remember", drawn and typed ones are kept in this browser.
- Fill AcroForm text fields, checkboxes, choices, and radio groups directly on the page in Select, with the Fill forms dialog as an alternative. Checkbox groups whose boxes carry their own export values tick one box at a time and save the chosen value. Shared widgets stay synchronized; field drafts support Undo/Redo and commit on save, download, navigation, or tool changes.
- Print (File menu or Ctrl / Command P) prepares every page, the current page, or a typed range at printer resolution, one page per sheet with landscape pages on landscape sheets, and hands them to the browser's print dialog; the browser's own print command still prints the page on screen.
- File, Edit, View, Page, and Insert menus under the title, laid out like the neighboring Documents and Spreadsheet apps, with keyboard navigation and shortcuts shown beside the items. On phones the menus fold into one Menu button.
- Crop pages (Page menu): drag over the part of the page to keep, then crop that page or every page with the same margins, or type exact margins in points; the content stays in the file and Remove crop shows the full page again. Margins follow the page as displayed, so one crop fits rotated pages too.
- Rotate pages either way, reorder, insert, duplicate, delete, and merge pages (Insert pages from PDF… takes all or a range of another PDF's pages and puts them after the current page, at the end, or at the beginning), and extract the current page or a page range such as `1-3, 5` into a new, smaller PDF. In the pages panel, drag a thumbnail with a mouse or pen to reorder pages, and use each thumbnail's menu button or right-click menu to rotate, move, insert after, extract, or delete that page while staying on the page you are reading. The Page menu can also turn every page at once, and any page can be downloaded as a PNG picture at 144 dpi with its annotations. File → Download pages as images… saves all or chosen pages as PNG or JPEG at 72, 144, or 300 dpi, several at once in a ZIP, behind a progress dialog that can cancel the export.
- Split PDF (File menu): every page as its own PDF, every N pages, or new parts before chosen pages, downloaded together as one ZIP with each part named after its page range.
- Flatten (File menu): form fields and comments become fixed page content so every reader shows them the same way and nobody can change them; links stay clickable, and the step is undoable. Filled fields keep their values; notes, highlights, and other markups are drawn from their appearances, with missing standard note and markup appearances generated when supported. Fields and comments that cannot be drawn safely stay in the PDF and are reported as unflattened. Hidden and NoView annotations are removed without drawing. Page copying stops if an unflattenable field would be orphaned.
- Reduce file size (File menu): pictures are shrunk to the resolution they are shown at (100, 150, or 220 dpi) and saved as JPEG with their transparency kept as a soft mask, uncompressed streams are deflated, page thumbnails and objects left behind by earlier edits are dropped, and the result is one undoable step that reports the old and new sizes. Text, drawings, and form fields stay sharp; stencil masks, 1-bit scans, tiny pictures, and pictures under optional content are left untouched.
- Document details (File menu) show the page count, file size, dates, and the producing software, and let you edit the title, author, subject, and keywords stored in the PDF. Imported forms are flattened with an explicit explanation before merging or extracting.
- Transactional edits, bounded undo/redo, dirty-state tracking, leave protection, and real PDF exports.
- Explicit Save to Puter, Save a copy, and Save to another folder. Originals are not overwritten until Save is explicitly chosen. New files use Puter's atomic name deduplication. Without a session the Save button reads "Sign in to save", and leaving unsaved work offers Keep editing, Leave without saving, or Sign in and save.
- Dark page colors (View menu) invert the page, its thumbnails, form fields, and text drafts for reading at night, remembered on the device; printing and downloads are unaffected.
- System theme by default, persistent light/dark overrides, responsive layout, keyboard shortcuts, labeled controls, native modal focus handling, reduced-motion handling, and live feedback.
- Puter desktop launch/open events and close protection. No sign-out option or sign-out call in `puter.env === 'app'`.

## Privacy and storage

PDF parsing, rendering, and editing run on the device. Local files are uploaded only when the user chooses a cloud save. A local download is always available without signing in. Device preferences store only the theme and the dark page colors choice in localStorage, plus drawn and typed signatures when "Remember drawn and typed signatures on this device" is ticked in the signature dialog; uploaded signature images are never stored. Passwords typed to open or protect a PDF are kept in memory for the open document only and are never stored. PDF contents, history, file metadata, and auth tokens are not stored in localStorage or `puter.kv`. **There are no KV calls.**

Cloud PDFs are ordinary blobs written with `puter.fs.write` in `PDF Editor/`, relative to the user's application-specific Puter AppData folder. Files opened through a Puter picker can save to the selected path. The file library lists the app folder, so files saved elsewhere are accessed with Open from Puter. No public sharing links are created.

Saving is explicit, not automatic. In-session undo is limited to 25 snapshots and approximately 100 MB of retained history, with at least one snapshot retained. Undo and Redo shortcuts run in order even during page redraws; saving or downloading waits for queued history to finish. Reloading the tab discards unsaved work; the browser close prompt is best effort, especially on mobile. Saving in several tabs uses last-writer-wins for an explicitly opened path. A cloud failure keeps local edits available for retry or download.

## Editing and engine boundaries

PDF.js uses Apache 2.0; pdf-lib uses MIT. The PDF.js standard-font substitutes include Liberation Sans under the GPL v2 with a font exception; the build ships their source and notices (see below). See [the engine and license review](docs/ENGINE_AND_LICENSES.md) for the rationale, MuPDF's AGPL/commercial tradeoff, the age of pdf-lib's release, the fontkit notice-packaging caveat, and how the GPL font redistribution requirement is met.

The Text tool edits supported PDF text commands, including text added by this app and text inside shared Form XObjects. The inline editor also supports dragging, keyboard movement, and X/Y coordinates in PDF points for existing and new text. Moving text alone preserves its original glyph commands and spacing. Replacements remove the original glyphs from active page content and preserve neighboring positions, graphics, color, and transforms. Existing fonts are reused when their encodings contain the replacement characters; otherwise a matching standard font, Noto Sans, or Noto Sans KR is used. Korean replacements and new text use bundled Noto Sans KR regular or bold faces when the source subset lacks the characters; the replacement typeface can differ from the original. Korean fallback text does not yet support italic. Compatible text commands are grouped into editable lines and paragraphs. Paragraphs reflow within an adjustable column width and retain explicit line breaks, mixed formatting, and their layout after export and reopening; text that cannot be grouped remains editable per command. Vertical writing, Type 3 fonts, text clipping, alternate ActualText, inline-image content streams, and some uncommon structures are not editable yet. Unsupported text is left intact.

Deleting text with the Text tool is not redaction; use Redact a PDF, which removes the content under its marks (fonts are not re-subset, so a font can still hold the glyphs of removed characters, and the gap left in a line shows the width of what was removed). OCR recognizes English only. Certificate signatures are appended to the file as it is; any later edit here rewrites the file and invalidates them (the editor asks first). Revocation (OCSP/CRL) is not checked, and signers are trusted only through certificates the reader trusts explicitly. Highlights remain editable PDF annotations. Supported shapes and drawings remain selectable, movable, resizable, and deletable after reopening. The selected path panel edits existing fill and stroke colors and stroke width. Each complete painted PDF path is an editing unit; new freehand strokes are saved as one connected path. Pattern colors, complex clipping, optional content, and graphics-state masks are not supported for path editing yet. Image editing changes individual image XObject placements, including occurrences inside shared Form XObjects. Partially clipped images, stencil images, inline images, optional-content images, and images under complex clipping or graphics-state soft masks are not editable yet. Images inside an enclosing clipping frame stay within that frame. Editing signed documents invalidates signatures. Password-protected PDFs are decrypted on the device once the password is known; the working copy is plain and encrypted again on download or save, with the file's original key and passwords unless the protection was changed. Revision-6 encrypted permission blocks are validated before opening. Accessibility follows the security revision: revision 2 shares its copy permission, revisions 3–5 have a separate accessibility permission, and revision 6 always allows accessibility. Certificate (public-key) security and uncommon crypt filters are not supported. Existing PDF scripts and document-triggered navigation are not executed. New text uses Noto Sans (regular, bold, italic, or bold italic) and supports Latin, Greek, and Cyrillic; Korean text uses Noto Sans KR (regular or bold). Files are capped at 100 MB and 1,000 pages; images at 20 MB. Complex or very large PDFs can still exceed a device's memory budget, especially during saving.

Modern evergreen browsers are required by PDF.js 6. The automated suite runs Chromium desktop and mobile viewports, plus targeted Firefox and WebKit integration checks; it does not certify every native-browser or assistive-technology interaction. PDF text is exposed to assistive technology, but reading order depends on source PDF structure. Autotagging adds a basic tag tree (headings, paragraphs, lists, figures, links, artifacts) without changing how pages look; reading order follows the content order, and tables are not recognized, so tagged output should still be reviewed before it is called PDF/UA compliant. The PDF/A check covers the rules that matter most in practice, not every clause a dedicated validator checks.

## Branding

The source artwork is `icon.png`. Run `npm run icons` with ImageMagick 7 installed to
regenerate the favicons, Apple touch icon, and 192/512 px app icons in `public/`.
`public/manifest.json` defines the app metadata. The warm red brand color is
`#bf3f3f`, with a lighter `#ef9290` accent in dark mode.

## Structure

- `src/main.js`: document launch (a blank PDF on open), the library at `#library`, account and sign-in, theme.
- `src/editor.js`: PDF.js view, editor tools, forms, page operations, saves.
- `src/pdf-worker.js` and `src/core/outline-transport.js`: PDF.js worker entry and overflow-safe bookmark transfer, including the main-thread fallback.
- `src/core/document.js`: pure PDF operations, validation, transaction history.
- `src/form-layer.js` and `src/core/form-draft.js`: inline form controls, geometry, and draft history.
- `src/core/text-edit.js`: source text parsing, glyph mapping, and native text replacement.
- `src/core/image-edit.js`, `src/core/path-edit.js`, and `src/image-layer.js`: native image and path occurrence editing, live previews, pointer and keyboard transforms.
- `src/text-selection.js` and `src/core/highlight.js`: text alignment, selection geometry, and editable PDF highlights.
- `src/lib/puter.js`: isolated Puter boundary.
- `src/lib/ui.js`: DOM helpers, dialogs, Lucide icons, feedback.
- `src/lib/menu.js`: popover menus and the menu bar.
- `src/print.js`: page rendering for the browser's print command.
- `src/core/pages.js`: page ranges and page extraction.
- `src/core/signature.js` and `src/signature-dialog.js`: signature geometry, outlines, and the signature dialog.
- `src/page-organizer.js`: drag reordering of page thumbnails.
- `src/core/notes.js`: sticky note annotations.
- `src/outline.js` and `src/core/outline-edit.js`: the outline (bookmarks) tree and its editing.
- `src/core/comments.js` and `src/comments.js`: the comments list gathered from PDF.js annotations.
- `src/core/image-pages.js`: pictures fitted onto pages, paper choice by locale, and JPEG EXIF orientation.
- `src/core/split.js`: splitting into parts and a stored ZIP writer.
- `src/core/flatten.js`: flattening of form fields and annotation appearances.
- `src/core/compress.js` and `src/image-codec.js`: file-size reduction (image downsampling through PDF.js and the canvas, stream deflation, and unreferenced-object sweeping).
- `src/core/links.js`: link annotations to web addresses or pages.
- `src/core/stamp.js` and `src/stamp-dialog.js`: vector stamps built from the text font's outlines.
- `src/core/crop.js`: page cropping by reader-frame margins.
- `src/core/page-marks.js`: watermarks and page numbers drawn upright on the page.
- `src/core/security.js`: the PDF standard security handler (unlocking and AES-256 protection); `src/unlock-dialog.js` and `src/protect-dialog.js` ask for and set passwords.
- `tests/`: unit, integration, and accessibility tests.
- `docs/ENGINE_AND_LICENSES.md`: engine choice, licensing, and limitations.

## Keyboard shortcuts

| Action               | Shortcut                          |
| -------------------- | --------------------------------- |
| Open PDF or pictures | Ctrl / Command O                  |
| Save to Puter        | Ctrl / Command S                  |
| Download PDF         | Ctrl / Command Shift S            |
| Undo                 | Ctrl / Command Z                  |
| Redo                 | Ctrl / Command Shift Z, or Ctrl Y |
| Find                 | Ctrl / Command F                  |
| Find next / previous | Ctrl / Command G, with Shift; F3  |
| Print                | Ctrl / Command P                  |
| Zoom in / out        | Ctrl / Command + / -              |
| Fit width            | Ctrl / Command 0                  |
| Previous / next page | Alt Left / Right                  |

The text/highlight/shape tools also offer a keyboard-accessible placement action. Freehand drawing requires a pointer. Use Tab to move through form fields on the page, or open Fill forms. Enter applies a single-line field; Ctrl / Command Enter applies multiline fields. Escape restores the current field’s value before the draft. Saving and navigation apply all pending field changes.

With an image, shape, or drawing selected, drag its body to move it or a corner to resize it. Arrow keys move it 1 pt in screen directions; Shift moves it 10 pt. Delete/Backspace removes it. Escape cancels a pending transform, or closes the object controls when no transform is pending. Object dimensions are in PDF points.

- `src/shell/`: the tools pane, the tool icons, and the workspace stylesheet; `src/page-stack.js`: continuous and two-page views; `src/organize-view.js`: Organize pages.
- `src/core/redact.js`, `src/core/sanitize.js`, `src/core/content-filter.js`, `src/core/image-redact.js`, `src/core/glyph-metrics.js`: redaction and removing hidden information.
- `src/core/ocr.js` and `src/ocr-engine.js`: on-device OCR and the invisible text layer (assets are served from `ocr/`).
- `src/core/export-*.js` and `src/core/ooxml-zip.js`: Word, Excel, PowerPoint, RTF, HTML, and text export.
- `src/core/digital-signature.js` with `asn1.js`, `x509.js`, `cms.js`, `pkcs12.js`, `pdf-incremental.js`: certificate signatures; `src/signatures-panel.js` and `src/digital-id-dialog.js` for the UI.
- `src/core/form-create.js`, `src/core/form-detect.js`, `src/form-designer.js`: Prepare a form.
- `src/core/annotations.js` (with `annotation-appearance.js` and `annotation-xfdf.js`) and `src/annotation-layer.js`: comments drawn as annotations, replies, review status, XFDF.
- `src/core/compare.js` and `src/compare-view.js`: Compare files. `src/core/accessibility.js`, `src/core/autotag.js`, `src/accessibility-report.js`: accessibility. `src/core/pdfa*.js`: PDF/A.
- `src/core/batch.js`, `src/core/measure.js`, `src/core/attachments.js`, `src/core/initial-view.js`, `src/core/page-mark-removal.js`: batch processing, measuring, attachments, the initial view and fonts, and removing page marks.

## License

This app, including all its contents, modules, and components, is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). Third-party libraries included in this app may be subject to their own licenses.
