# Design and Layout tabs: parity record

What the Design and Layout tabs offer compared with the leading desktop word processors, what is
approximated, and what remains. OOXML clauses and the supported subset for each feature are in
[conformance.md](../conformance.md).

## Design tab

### Implemented

| Command | Notes |
| --- | --- |
| Themes | 12 original themes (color, font and effect schemes) applied by rewriting the theme part (created with its relationship and content type when missing); Reset to Theme from Template; Save Current Theme (kept in this browser); Browse for Themes (.thmx or theme .xml). A new app document is linked to theme fonts and the default style set the first time it takes a theme or style set; imported documents keep their explicit fonts. |
| Style Sets | 8 original sets in a ribbon gallery and a More menu; Reset to the Default Style Set; Save as a New Style Set. Missing built-in styles are created; fonts and colors are written as theme references. One undo step. |
| Colors, Fonts, Effects | 14 color schemes, 12 font pairs and 5 effect schemes, each with a Customize dialog and live sample. Effect schemes change shapes that use the theme's styles. |
| Paragraph Spacing | No Paragraph Space, Compact, Tight, Open, Relaxed and Double presets on the Normal style, Style Set Default, and Custom Paragraph Spacing…. |
| Set as Default | New blank documents start from the saved theme and style set (and from Page Setup's default page settings). |
| Watermark | 12 presets (six texts, diagonal or horizontal), Custom Watermark (picture with scale and washout, or text with language, font, size, color, semitransparent and layout) and Remove Watermark. Stored as a behind-text, page-centered drawing in every header the pages use (default, first page and even pages), creating header parts only where needed. |
| Page Color | Colors, More Colors…, Fill Effects… (gradient, texture, pattern, picture) and Remove Fill Effect. |
| Page Borders | Box presets and Borders and Shading Options…, which opens the Borders and Shading dialog's page tab when that dialog is present. |
| Menu bar | Insert → Watermark…, Format → Theme and Background. |

Package-level changes (themes, colors, fonts, effects, watermarks and fill effects) edit only the parts they own and reopen the document in place, keeping zoom, scroll and selection. Undo past the editor's own history returns to the package from before the change; Redo reapplies it. A change that would leave the document read-only is refused.

### Approximated

- Gradient, texture and pattern page fills are saved as a picture background rather than native vector gradient or pattern fills; picture fills tile.
- Semitransparent text watermarks use a color blended toward white rather than true transparency.
- Typing history from before a theme or watermark change is not kept across it (the change itself undoes in one step).

### Remaining gaps

- No hover preview for themes or style sets; choices apply on click.
- Watermarks written by other apps in the older vector markup are not recognized or removed.
- Direct RGB text colors, app table designs and inserted shapes with explicit colors do not follow the theme.
- Imported themes whose color slots use system colors are rewritten as RGB when colors change.
- Menu sample cards name fonts that may not be loaded on the page, so they can show a fallback font.

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

## Hyphenation

### Implemented

- Layout → Hyphenation: None, Automatic, Manual… and Hyphenation Options… (hyphenate automatically, hyphenate words in capitals, hyphenation zone, limit consecutive hyphens); Tools → Hyphenation…; a "Do Not Hyphenate" paragraph item for the document context menu.
- Automatic hyphenation in the line breaker: a line that runs out inside a word breaks at the last point that fits, showing a hyphen on screen only (text, caret, copy and export are unchanged). The zone, the consecutive limit, the capitals option and per-paragraph or style `w:suppressAutoHyphens` are honored; numbers, URLs, words with symbols and text not tagged as English are not split.
- Break points come from an original rule-based English syllabifier with a short exception list; no third-party pattern data or dependency.
- Settings (`w:autoHyphenation`, `w:doNotHyphenateCaps`, `w:hyphenationZone`, `w:consecutiveHyphenLimit`) are read and written; a settings-only change leaves every other part byte-identical. One undo step.
- Manual hyphenation walks the words automatic hyphenation would split; choosing a point inserts a soft hyphen (one undo step each). Soft and nonbreaking hyphens render as before.

### Remaining gaps

- Break points are heuristic rather than dictionary-based, and only English is hyphenated.
- Table AutoFit minimum widths ignore automatic break points.
