# Design and Layout tabs: parity record

What the Design and Layout tabs offer compared with the leading desktop word processors, what is
approximated, and what remains. OOXML clauses and the supported subset for each feature are in
[conformance.md](../conformance.md).

## Layout tab

### Implemented

| Command | Notes |
| --- | --- |
| Margins gallery | Normal, Narrow, Moderate, Wide and Mirrored presets with pictures; the last custom margins applied from Page Setup are offered again (stored on this device); Custom Margins… opens Page Setup. |
| Orientation | Portrait and Landscape; the margins turn with the page. |
| Size | Letter, Legal, Executive, Tabloid, Statement, A3–A6, B5 (JIS) and two envelopes in the current orientation; More Paper Sizes… opens Page Setup. |
| Columns | One, Two, Three, Left and Right presets; Line Between; More Columns… opens a dialog with presets, 1–12 columns, per-column widths and spacing, equal widths, a line between, a live preview and Apply to (whole document, this section, this point forward, selected text). Choosing columns with text selected puts that text in its own continuous section. |
| Breaks | Page, Column and Text Wrapping (a line break that clears floating pictures), and Next Page, Continuous, Even Page and Odd Page section breaks, each with a description. Odd/even sections start on a page of that parity with an empty page between when needed. Show/Hide ¶ labels section breaks. |
| Page Setup dialog | Page tab: paper size and custom size, orientation, margins, gutter and gutter position, multiple pages (normal, mirror margins, two pages per sheet, book fold, reverse book fold). Layout tab: section start, different odd and even pages, different first page, header and footer distances, vertical alignment, Line Numbers… and Borders…. A live preview, Apply to (whole document, this section, this point forward, selected text — every section a selection covers) and Set As Default for new documents. One undo step. |
| Line Numbers, Hyphenation | Ribbon menus in the Page Setup group, supplied by the line-numbering and hyphenation modules (see below). |
| Indent and Spacing boxes | Indents follow the measurement unit chosen on the View tab (inches or centimeters); spacing is in points. |
| Menu bar | Insert → Break (page, column and the four section breaks), Format → Document… and Columns…, File → Page Setup…. |

### Approximated

- **Two pages per sheet** shows each reading page as half the sheet; printing does not impose two pages on one sheet. Book fold keeps the existing reading-page display.
- **Different first page** and **different odd and even pages** take effect at once and are saved, but are not part of undo.
- Vertical alignment combined with columns or continuous sections stays a read-only approximation; an edit that needs it is rolled back with a message.

### Remaining gaps

- Next-column section breaks cannot be inserted, and documents that use them open read-only.
- Paper source and printer settings are kept but not editable; there is no printer-specific paper list.
- Page Setup does not offer the document grid (character and line pitch).
- Line numbering and hyphenation gaps are listed in their sections below.

## Line numbers

### Implemented

- Layout → Line Numbers: None, Continuous, Restart Each Page, Restart Each Section, Suppress for Current Paragraph and Line Numbering Options… (start at, from text — automatic or a distance, count by, numbering restart). Also Format → Line Numbers, a "Suppress Line Numbers" document context-menu item when the section is numbered, and Page Setup → Layout → Line Numbers….
- Per-section `w:lnNumType` read, edited (this section or the whole document) and written; per-paragraph and style `w:suppressLineNumbers`.
- Numbers are painted right-aligned in the margin at the chosen distance (automatic is a quarter inch), on each line's baseline, in the "line number" character style when the document has one. Every count-by line is labelled; counting restarts per page, per section or runs on, column by column.

### Approximated and remaining gaps

- Only body lines count: table cells, framed paragraphs, headers, footers, footnotes and text boxes are neither counted nor labelled.
- The label font does not change line height; right-to-left, vertical and document-grid sections get no special handling.
- The PDF text layer omits line numbers (they appear in the page images).
- The paragraph style dialog has no suppress control.
