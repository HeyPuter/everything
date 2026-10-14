# Canvas engine: tables, styles, text and page formatting

Documents now open on a best-effort basis when they contain features outside the
editable subset. Supported content uses the canvas renderer; unsupported content
is approximated where possible. These documents open read-only, and **Download
.docx** returns the unchanged original. Search, selection, copying and zoom remain
available. Supported documents continue to open for editing. See the
[preview behavior and gaps](conformance.md#best-effort-opening-and-read-only-previews).

Temporary rich-text content controls in imported templates now display their
prompts and retain their original wrappers until edited. Click a prompt to
select it, then type or paste its replacement. New text uses the control's input
formatting; editing removes the temporary wrapper, and Undo restores it. Text
mode, find/replace and plain-text copy/paste remain available. Try **Temporary
content controls sample** in the local playground. Locked, persistent, data-bound
and other form controls remain unsupported; see the [declared subset](conformance.md#temporary-inline-content-controls).

Use **Clear direct paragraph formatting** beside the paragraph-style controls to
restore style-based alignment, spacing, indents, tabs, borders, fill, outline
level and pagination. It also removes directly applied numbering: a style's list
returns if it was overridden or suppressed, while a directly applied list ends
if the style has none. Paragraph styles and all text/paragraph-mark formatting
remain intact.

The action covers the current paragraph or every selected paragraph in one undo
step. A selection ending at the next paragraph's start excludes that paragraph.
The toolbar button is keyboard accessible; no application quit shortcut is
assigned. Try **Clear paragraph formatting sample** in the local playground.
See the [paragraph reset subset](conformance.md#clear-direct-paragraph-formatting-iteration).

Use **Clear direct text formatting** beside the character-style controls, or
**Ctrl/Cmd+Space**, to restore the selected text's style inheritance. It keeps
paragraph and character styles, links, lists and table structure. Direct run
properties, including font and language declarations, are removed. Selected
paragraph marks and empty paragraphs are included; the next paragraph is excluded
when the selection ends at its start.

With a caret in existing text, the reset applies to future typing. It does not
change existing text or create an undo entry until you type. A selection or empty
paragraph reset is one undo step. Try **Clear text formatting sample** in the local
playground. See the [supported reset behavior](conformance.md#clear-direct-text-formatting-iteration).

Use **Find and replace** or **Ctrl/Cmd+F** to search document text, including table
cells. **Enter** finds the next match; **Shift+Enter** finds the previous one.
Navigation wraps, and **Escape** returns to the document. **Match case** and
**Whole words** narrow the search. Formatting boundaries do not interrupt a match;
paragraphs, tabs, breaks and pictures do.

**Replace** changes the selected match and moves to the next. **Replace all**
changes the original matches in one undo step. New text takes the first matched
character's formatting; leave Replace with empty to delete matches. Search and
replacement are literal, so `$&`, brackets and other punctuation stay unchanged.
The **Find and replace sample** includes styles, links, bookmarks and continued
tables. See the [matching rules and limits](conformance.md#find-and-replace-iteration).

Use **Edit paragraph style → Style line spacing** to set a reusable multiple,
exact height or minimum height. **Inherit** removes the style's line-spacing
override while keeping its before/after spacing. Changes flow through styles
based on it and apply in table cells; direct paragraph formatting stays in effect.
Undo restores spacing and selection. Imported styles that specify a rule while
inheriting the amount keep that declaration until you choose another setting.
The **Style line spacing sample** covers these cases and continued tables.
See the [shared-style spacing record](conformance.md#shared-style-line-spacing-iteration).

Use **Line spacing options** beside the preset menu to choose a custom multiple,
an exact point height or a minimum point height. Minimums grow to fit text and
pictures; exact heights can clip their contents. **Inherit from style** removes
the direct line-spacing override while retaining before/after paragraph spacing.
Point values use 0.05 pt steps; custom multiples round to the nearest 1/240 line.
Mixed selections remain unchanged until edited, and undo restores formatting and
selection. The **Line spacing sample** in the local playground covers styles,
clipping, mixed text and repeated table headers. See the
[spacing subset and compatibility notes](conformance.md#custom-paragraph-line-spacing-iteration).

Use **Row height** with the caret in a table, or text selected across rows, to
choose **Automatic** or a minimum in points. Content can grow beyond a minimum.
The setting covers every selected row, including rows spanned by merged cells;
mixed values remain unchanged until edited. **Inherit from table style** removes
the direct override. Undo restores the height and selection. Oversized repeated
headers roll back so you can correct the value. Try the **Row heights sample**
in the local playground. Exact heights remain unsupported; table-style height
inheritance is an engine extension outside the file format's defined behavior. See the
[height subset and compatibility notes](conformance.md#table-row-height-iteration).

Use **Indents and tabs → Leader** to fill a tab gap with dots, dashes, a line or
middle dots, or choose **None** to remove the leader while retaining the stop.
Imported legacy Heavy leaders display as underscores. Leaders follow the tab's
text formatting and its field alignment, including inherited stops. They remain
one tab character for editing, copying and saving. Changes undo in one step.
The **Tab leaders sample** in the local playground includes a contents list,
prices, rich formatting and continued tables. See the
[supported subset and limitations](conformance.md#custom-tab-leader-iteration).

Use **Justify** or **Ctrl/Cmd+J** to align paragraphs to both text margins.
Spaces between words expand; the paragraph's final line retains natural spacing.
Paragraph styles also offer **Justified** alignment. Imported soft-line-break
compatibility settings are preserved. The **Justification sample** in the local
playground includes inherited formatting, soft breaks, mixed text and repeated
table headers. See the [supported subset](conformance.md#justified-paragraph-iteration)
for tab, script and browser limitations.

Use **Cell margins** with the caret in a table, or text selected across cells,
to adjust the space between each cell's text and its edges. Enter points for
each side, use **No padding** for explicit zero, or **Inherit all** to restore
the table/style margins. Mixed values remain unchanged until edited. Larger
margins can wrap text and add pages; settings that cannot fit roll back so you
can correct them. Undo restores padding, text placement and selection. Try the
**Cell margins sample** in the local playground for inherited settings, merged
cells and repeated headers. See the [margin subset and limitations](conformance.md#table-cell-margin-iteration).

Use **Cell borders** with the caret in a table, or text selected across cells,
to change each side's pattern, width and color. Presets apply to every selected
cell: **Box each cell**, **Bottom only**, **No borders** and **Inherit all**.
No borders suppresses shared edges; Inherit restores the cell-style/table setting.
Mixed sides remain unchanged until edited. Undo restores borders and selection.
Open the **Cell borders sample** in the local playground for inherited and themed
borders, shared-edge conflicts, merged cells and repeated headers. Border edits
preserve text placement; wide strokes use the existing cell margins. See the
[border subset and limitations](conformance.md#table-cell-border-iteration).

Use **Cell shading** with the caret in a table, or text selected across cells,
to choose a color, No fill, Automatic foreground or Inherit from table. No fill
clears inherited shading; Inherit removes the direct override. The fill covers
cell margins and follows merged cells, page continuations and repeated headers.
Undo restores the previous colors and selection. Open the **Cell shading sample**
in the local playground for themes, style resets and layered paragraph fills.
See the [shading subset and limitations](conformance.md#flat-table-cell-shading-iteration).

Use **Cell alignment** with the caret in a table, or text selected across cells,
to align their contents at the top, center or bottom. **Inherit from table style**
removes the direct override. Paragraph alignment and spacing remain intact;
undo restores the previous placement. Open the **Cell alignment sample** in the
local playground for inherited settings, merged cells and repeated headers.
For a cell that continues across pages, each page's existing text aligns within
that fragment; short content stays on its original page. See the declared
[alignment subset and limitations](conformance.md#table-cell-vertical-alignment-iteration).

Select one or more paragraphs and use **Paragraph borders** to choose Box,
All borders, Bottom only or No borders, or edit each side's pattern, width,
distance and color. Matching border sets join adjacent paragraphs, with an
optional divider. Paragraph styles expose the same controls plus inheritance.
The **Paragraph borders sample** in the account-free playground covers inherited
borders, patterns, shading, page continuation and repeated table headers.
Borders reserve vertical space; edits that cannot fit the page or cell roll back.
See [the conformance record](conformance.md#paragraph-border-iteration) for the
supported patterns, independent fixture source and remaining layout limits.

Select text and use **Strikethrough** or **Double strikethrough** to select a form;
press the active button to clear it. Both controls report mixed selections and
apply to future typing. **Style strikethrough** exposes Single on/off, Double
on/off and Inherit. Character-style Single follows the existing toggle rules;
Double uses ordinary inheritance. An explicit off declaration clears its own
form; changing an ancestor later to the other form can reveal that formatting.
Try the **Strikethrough sample** in the local playground. See the conformance
record for the declared cross-form precedence and double-stroke geometry policy.

Ordinary trailing spaces stay on the preceding line by default and do not affect
paragraph alignment or AutoFit demand. Imported `wrapTrailSpaces` and
`ulTrailSpace` settings control wrapping and trailing underlining and remain
read-only. The preview bounds overflowing spaces at the writing edge while
preserving every character for keyboard editing and DOCX saving. Try the
**Trailing spaces sample** in the account-free playground; see the declared
subset and preview limitations in [the conformance record](conformance.md).

See [the conformance record](conformance.md) for the current specification subset, validation workflow, corrections and remaining gaps.

This branch replaces the previous engine with original code; its license has not yet been selected. There is no dependency on a third-party document engine, an AGPL runtime, or a document-engine binary. ZIP handling uses the existing MIT-licensed `fflate` package. Text is measured and painted by Canvas 2D using the bundled, unmodified Noto Sans variable font (OFL-1.1).

## Kerning

**Kerning** adjusts the spacing of letter pairs such as AV. Enter the smallest
font size to kern, or zero to turn it off. Thresholds accept half-point steps
from 0–1638.5 pt; the text keeps its original font size. Paragraph and character
styles expose **Style kerning from (pt)**, with empty **Inherit** and explicit zero
**Off**. Superscript/subscript use the stored font size for the threshold, before
their display transform.

Open **Kerning sample** (`public/fixtures/kerning.docx`) for default-off, below/at/
above-threshold text, inherited values, zero resets, numbering, scripts and tables.
Measurement and painting explicitly select the same Canvas kerning mode; text
with no inherited declaration now uses no kerning instead of the browser's
automatic setting. Existing documents can therefore wrap differently from older
preview versions. Carets, selection, AutoFit and pagination use the new advances.

Canvas font-kerning support is required. Punctuation-only kerning suppression and
legacy ANSI kerning pairs reject before editing. Zero uses a declared
compatibility convention; see the conformance record for its evidence and limits.
Exact native shaping, font substitution and layout remain outside this preview.

## Contextual paragraph spacing

**Contextual paragraph spacing** suppresses a paragraph's before/after spacing
when its neighbor uses the same paragraph style. It retains the stored spacing
values. Select one or more paragraphs and use the toolbar toggle; mixed selections
show a mixed state. Paragraph styles offer **On**, **Off**, and **Inherit**.

Open **Contextual spacing sample** (`public/fixtures/contextual-spacing.docx`) to
try direct and inherited flags, numbering, empty paragraphs and repeated table
headers. Each flagged side subtracts its spacing from the ordinary collapsed
gap, down to zero. For example, 10 pt after a flagged paragraph and 12 pt before
an unflagged paragraph leave 2 pt between paragraphs of the same style.

Different style IDs remain distinct even when one inherits from the other.
Tables and cell boundaries interrupt adjacency. The imported
`allowSpaceOfSameStyleInTable` compatibility flag disables this suppression inside
cells; its value is preserved, with no settings control. The companion
`public/fixtures/contextual-table-spacing.docx` demonstrates that behavior.
Carets, selections, keeps and pagination follow the resulting gaps; undo and
save/reopen retain direct overrides and shared declarations. Automatic and
line-unit paragraph spacing remain unsupported.

## Text width

**Text width** stretches or compresses the letters in selected text, an empty
paragraph or future typing. Enter a whole percentage from 1 to 600; 100% restores
normal widths. Font height and added character spacing stay unchanged. Paragraph
and character style dialogs expose the same percentage; leave it empty to inherit.

Open **Text width sample** (`public/fixtures/text-width.docx`) to try inherited
widths, explicit resets, scripts, spacing, tabs, numbering and repeated headers.
Wrapping, AutoFit, caret placement, selection and decorations use the displayed
widths. The model and DOCX retain the original font size. Edits that would make a
character wider than its paragraph or reverse negatively spaced advances roll
back. Inline pictures require 100% text width; picture sizing stays in the picture
controls. This is the declared Canvas preview policy, not exact native rendering.

## Character spacing

**Character spacing** expands or condenses selected text, an empty paragraph or
future typing. Enter positive points to expand, negative points to condense, or
zero for normal spacing. The range is −1584 to 1584 pt in 0.05 pt steps; practical
values depend on the font and available width. Paragraph and character styles
accept the same values; leave their field empty to inherit.

Open **Character spacing sample** (`public/fixtures/character-spacing.docx`) to try
direct and inherited spacing, explicit resets, scripts, tabs, numbering and
repeated table headers. Canvas measurement and painting use native letter spacing,
so wrapping, AutoFit, carets, selections and decorations follow the same advances.
Spacing stays an absolute point distance when script glyphs shrink. Stored font
size is unchanged. Edits that reverse character advances or make a single
character wider than its paragraph roll back.

This feature requires Canvas 2D letter-spacing support. Active `fitText` manual
widths and nonzero spacing on inline pictures reject before editing. Set spacing
to zero before inserting a picture. Exact native shaping and layout remain outside
the supported subset.

## Baseline shifts

**Baseline shift** raises or lowers selected text, an empty paragraph or future
typing without changing its stored font size. Use positive point values to raise,
negative values to lower and zero to reset. The range is −200 to 200 pt in
half-point steps. Paragraph and character style dialogs also accept shifts; leave
the field empty to inherit.

Open **Baseline shift sample** (`public/fixtures/baseline-shifts.docx`) to try mixed
baselines, styles, scripts, underlines, highlights, tabs and repeated headers.
Shifted glyphs and decorations share caret and line geometry. Changes that would
make a line too tall for the page roll back. Inline-picture positioning remains
unsupported; set the shift to zero before inserting a picture.

## Superscript and subscript

**Superscript** and **Subscript** format selected text, an empty paragraph or future
typing. They are mutually exclusive; press the active button again to return to
baseline. The font-size field and DOCX retain the original point size. Paragraph
and character style dialogs also support these positions and **Inherit**.

The **Superscript and subscript sample** (`public/fixtures/script-text.docx`)
includes formulas, inherited formatting, underlines, highlighting, tabs, numbering
and repeated table headers. The existing Noto fonts supply the display scales and
baseline offsets. Wrapping, AutoFit, caret geometry and pagination follow those
measurements. Script formatting on inline pictures remains unsupported and
rejects before editing; return to baseline before inserting a
picture. Exact native layout and font substitution are not claimed.

## Text highlighting

**Text highlight** applies one of the 16 OOXML highlight colors or **No highlight**
to selected text, an empty paragraph or future typing. No highlight reveals any
supported shading underneath. Imported flat run shading follows style inheritance
and theme mappings. Highlighting preserves line/page geometry, selection and
undo, including in repeated headers and behind transparent inline pictures.

Use **Highlight sample** (`public/fixtures/text-highlights.docx`) in the playground.
Highlights use direct formatting only; the engine does not apply them from
defaults, named styles or numbering definitions. Unsupported active declarations
and patterned/nil run shading reject before editing. There is no shading dialog;
see the conformance record for the supported subset and remaining gaps.

## Text colors

**Text color** applies an RGB color or Automatic to selected text or future typing.
Automatic chooses black or white for the visible highlight, shading, page or cell
background. Paragraph and character style dialogs accept a six-digit RGB value,
`auto`, or an empty field
to inherit. Imported theme colors, mappings, tint/shade, underlines and list-label
colors render while their source declarations remain preserved. Explicit color
edits replace those declarations with RGB or Automatic. Color changes preserve
line breaks, page count, caret positions and undo history.

The independent **Text color sample** is `public/fixtures/text-colors.docx`.
Theme editing, alternate DrawingML color spaces and decorative
underlines remain outside the supported subset; see the conformance record.

## Try it

```sh
npm ci
npm run dev
```

Open `http://localhost:5173/playground.html` for a local editor with no account or cloud SDK. Choose **Two paragraphs** or **Across pages**. A downloadable two-paragraph DOCX, generated independently using python-docx, is linked from the page.

1. Open the sample DOCX with **Open .docx**.
2. Click within the first paragraph and type.
3. Select across paragraphs using dragging, Shift+click, or Shift+arrow keys.
4. Apply **Bold**, then **Undo** and **Redo**.
5. Download the DOCX and reopen it in the playground.
6. Open that download in an installed desktop DOCX editor and inspect the text and bold formatting. This last step is manual; automated checks here use an independent DOCX parser instead.
7. Choose **Across pages**, select across the page boundary, edit, and undo. Zoom is available from 50% to 200%.

### Tables

Open **Table sample** (`public/fixtures/tables.docx`). The fixed-width table has
unequal columns, inherited italic text, shaded header cells, multiple paragraphs,
an empty cell and a tall row that flows across pages.

Use **Insert table** at a caret outside a table, then choose rows and columns
(or Insert Table…, Draw Table, Convert Text to Table… and Quick Tables from the
same drop-down). The **Table Design** and **Table Layout** tabs, the Table menu
and the table context menu hold the full table tools (styles and style options,
borders with a pen, insert/delete/merge/split, sizes, alignment, sort, formulas
and properties); see [the tables parity notes](parity/tables.md).
**Table actions** adds or deletes rows/columns, deletes the table, or inserts a
body paragraph before/after it. In fixed layout, inserting a column shares the
existing width and deleting a column reduces the table width. In AutoFit, a new
column starts with automatic width; other width preferences remain in place. These actions undo in one step.

Click a cell to type. Enter adds a paragraph within that cell. Tab and Shift+Tab
move between cells; Tab from the last cell adds a row. **Insert tab** inserts a
literal tab within the text. Escape then Tab leaves the editor. Arrow keys use
the cell's column when moving up/down. Text mode exposes cells as consecutive
paragraphs; semantic table announcements remain future work.

Backspace and Delete protect cell boundaries. A selection across cells can format
or replace their text; replacement retains every cell and inserts text in the
first selected region. Use **Table actions** to remove structure. Empty cells
always retain a paragraph. **Keep table row together** controls selected rows;
oversized rows still split across pages. Undo/redo restores text, structure,
formatting, selection and layout. Download/reopen and Puter save/reload preserve
the table. Dashed guides for borderless cells are preview-only.

Open **AutoFit sample** (`public/fixtures/autofit-tables.docx`) to try columns
that respond to cell text and font changes. **Table actions → Fit to contents**
uses content demand; **Fit to page** requests 100% of the page text width.
**Table properties** edits AutoFit/fixed layout, automatic/inch/percentage table
width, alignment, left indent and each column's preferred width. These widths
are preferences: AutoFit may adjust them to accommodate text. The preview keeps
its measured widths separate from the DOCX's stored preferences. Applying unchanged
settings does not create an undo step; invalid geometry leaves the document intact.

Open **Merged cells sample** (`public/fixtures/merged-cells.docx`) for staggered
horizontal spans in fixed and AutoFit tables. Select text in neighboring cells
within one row, then choose **Table actions → Merge cells in row**. All cell
paragraphs and their formatting remain, and the first cell supplies the cell
appearance. **Split into grid cells** splits along existing grid lines, retaining
all text in the first cell and creating empty cells for the remaining columns.
Both actions restore text, structure and selection with Undo.

New rows copy merged-cell spans. Adding a column inserts after the active cell;
merged cells in other rows expand if they cross that position. Deleting columns
removes the grid columns covered by the active cell. Cells only partly crossed
by that deletion shrink and retain their content. Table properties always edits
grid columns, even when several columns belong to one merged cell. Tab visits
actual cells and arrow navigation follows the cell bounds.

Open **Vertical cells sample** (`public/fixtures/vertical-cells.docx`) for cells
spanning rows, including rectangles that also span columns. **Merge with cell
below** joins the active cell with the next cell covering the same grid columns;
it can extend an existing merge. All paragraphs move into the top cell, preserving
their formatting. **Split into grid cells** restores individual cells throughout
the rectangle and keeps the text in the top-left cell. Split a vertical merge
before using horizontal merge across its boundary.

Tab skips continuation cells. Arrow navigation and clicking use the full merged
box. **Insert row below** inserts after the active cell's final row; inserting
beside another merge extends that merge when the new row lies inside it. Deleting
the top row promotes the merged text into the remaining cell. **Delete row**
removes the active cell's starting row; **Keep table row together** applies to all
rows covered by the selected merged cells.

Open **Flowing tables sample** (`public/fixtures/vertical-pages.docx`) for vertical
merges spanning pages, overlapping merges with different font sizes, inherited
row keeps, AutoFit and a row whose minimum height exceeds a page. Each merged
cell's text flows independently; its border and fill continue through all covered
rows and pages. Row keeps apply to individual rows. An oversized kept row starts
on a fresh page and then flows as needed. Minimum row heights can also span pages.

Clicking an empty continuation fragment selects the nearest text in that cell,
which can be on another page. Arrow keys continue through the same merged cell
before moving outside its full rectangle. Editing, splitting, row insertion,
column changes and inherited font changes repaginate these tables and undo in
the usual way. The row-height allocation is an original approximation; page
breaks and whitespace can differ from other DOCX consumers.

Open **Table headers sample** (`public/fixtures/table-headers.docx`) for repeated
multi-row headers in fixed and AutoFit tables. Select text in the last row to
include, then choose **Table actions → Repeat rows through selection**. The
header includes all leading rows through that selection, extended to cover any
vertical merge. **Remove repeated headers** clears the region. Both actions undo.

Header copies appear at the top of later table pages. Click and edit any copy;
the caret stays on that page while all copies update. The document stores the
header text once. Inserting a row inside the header extends it; inserting at the
header/body boundary creates a body row. The whole header must fit a page and
leave room for body lines. Vertical merges across that boundary are unsupported;
include the entire merge in the header or split it first.

The engine supports fixed-width and AutoFit tables with horizontal and vertical
spans, repeated headers, automatic/minimum row heights, cell vertical alignment,
margins, borders and flat shading. Nested tables, conditional styles and exact
row heights remain unsupported; imports using them show an error before editing.
See the conformance record for precise limits.

### Inline pictures

Open **Inline images sample** (`public/fixtures/inline-images.docx`) to try pictures
mixed with text, transparent PNGs, shared media, repeated table headers and AutoFit.
**Insert image** accepts a local PNG or JPEG. A new picture starts at its decoded
pixel dimensions and is reduced to accommodate the paragraph and page. Click the
picture, or select its single object position with Shift+arrow, then use **Image
properties** to change its dimensions in inches and alt text. Keep proportions
is enabled initially and remains locked for imported aspect-ratio locks.

**Cropped images sample** (`public/fixtures/cropped-images.docx`) includes source
crops, transparent outsets and `a14:useLocalDpi` metadata. Image properties has
four crop percentages: positive values trim a source edge, and negative values
add transparent space. The frame keeps its size. **Reset crop** restores the full
source image. Crop edits and reset support undo/redo and never modify media bytes.
Offsets use signed 32-bit DrawingML values in 0.001% steps and must leave a positive source
width and height. A viewport outside the bitmap is transparent but remains selectable.

**Flipped images sample** (`public/fixtures/flipped-images.docx`) demonstrates
horizontal and vertical mirroring. Use **Flip horizontally** and **Flip vertically**
in Image properties independently or together. Flips mirror the cropped result,
including transparent outsets, while keeping the frame and text layout fixed.
Crop percentages continue to refer to original source edges. Reset crop leaves
the flip settings intact. Image bytes are preserved through editing and export.

**Rotated images sample** (`public/fixtures/rotated-images.docx`) covers arbitrary
angles combined with cropping, flips, transparency and table headers. Use
**Rotation (degrees)** in Image properties: positive angles turn clockwise;
negative values turn counterclockwise. Crop and flips apply first. The control
accepts −360 through 360, rounded to 1/60,000 degree; reopened values are shown
between 0 and 360. Width/height remain the unrotated dimensions, while layout
reserves enough additional space to contain every corner. The reservation keeps
the original frame width even when a quarter turn makes the painted image
narrower. Existing extra spacing is preserved. Rotations that cannot fit the
paragraph/page leave the document and history unchanged.

Imported rotations require zero-origin transforms, matching inner/outer dimensions
when present, and nonnegative extra extents that contain the rotated corners.
Other geometry rejects before editing. A picture with an explicit nonrotating
fill has its rotation control disabled. Selection covers the full reserved
rectangle, including transparent space. The conformance record documents this
subset and the difference between this authoring policy and native layout fidelity.

Pictures wrap as single inline objects and contribute their height to the line.
Text alignment, paragraph spacing and pagination apply to the containing line.
Changing the surrounding font does not resize the picture. Delete or Backspace
removes a selected picture; undo/redo restores its data, metadata and selection.
Typing on either side remains ordinary text. Plain-text copy uses the description
or `[Image]`; it does not copy image data. Text mode represents each picture with
one object character. Dedicated semantic image announcements remain future work.

Images decode before the editor enables saving. Unsupported drawings or damaged
bitmaps show an error and retain the original DOCX for download. Oversized edits
roll back. Effects, floating/wrapped pictures, vector/animated
formats, linked images, destination fill offsets and DrawingML extensions
other than the reviewed `useLocalDpi` flag are not supported yet.
Limits are 10 MB per image, 8,192 pixels per side, 16 megapixels, dimensions up to
22 inches and 50 MB / 64 megapixels of image assets in one editing session. Geometry must also
fit the paragraph and page. Original media bytes and unrelated parts are retained.

### Document outline

Open **Outline sample** (`public/fixtures/outline-levels.docx`) to try nested,
empty, numbered and table-cell headings across pages. **Document outline** in the
toolbar opens a keyboard-accessible list with preview page numbers. Choose an
entry to move the caret to that source paragraph. Repeated table headers appear
once; empty headings and image descriptions remain identifiable.

**Outline level** sets Level 1–9 or **Body text** for the selected paragraphs
without changing their appearance, pagination or list numbering. **Use style
level** removes a direct outline declaration and restores inheritance. **Edit
paragraph style → Style outline level** changes a custom style and its descendants;
choose **Inherit** to remove the declaration. Mixed selections are shown explicitly.

Built-in Heading1 through Heading9 styles have fixed outline levels.
Their level controls are disabled; choose a different
paragraph style or create a custom style to change the level. New documents include
levels for Heading 1 and Heading 2. Enter follows the configured next style, and
all outline edits support undo/redo and DOCX save/reopen. The outline dialog does
not generate a table of contents or reorder document content.

### Paragraph styles

Open **Style sample** (`public/fixtures/styles.docx`). Use **Paragraph style** to
apply a style to the current paragraph or selected paragraphs. Mixed selections
show **Mixed styles**. Direct text and paragraph formatting stays in place.

Use **Edit paragraph style** (pencil) to change its name, base, following style,
font size, bold/italic/underline, alignment, spacing and pagination flags. Changes
apply to every paragraph using that style, including derived styles. **Inherit**
removes a declaration so its parent or the document defaults determine the value.
**New paragraph style** (plus) creates a style based on the selected paragraph's
style and applies it to the selection. These actions have accessible names and
keyboard activation. Each action is one undo step.

Enter at the end of a heading uses its following paragraph style; splitting in
the middle keeps the heading style. New documents include Normal, Heading 1 and
Heading 2. Download/reopen preserves style references and shared definitions,
including direct overrides, inherited lists and imported character styles.
Heading outline levels and navigation are described above; see the conformance
record for the complete limits.

### Character styles

Open **Character style sample** (`public/fixtures/character-styles.docx`). Select
text, then choose **Character style** to apply an existing definition. **Default
characters** removes the explicit reference, retaining direct formatting and
allowing document defaults to apply. Different references show **Mixed character
styles**. A choice at a caret affects future typing; a choice in an empty
paragraph is saved on its paragraph mark.

Use **New character style** to create and apply a definition, or **Edit character
style** to change its name, base, font size, bold, italic or underline. Shared
edits update all uses and derived character styles, preserving direct overrides.
New documents include Emphasis and Strong. Paragraph and table styles set bold
and italic explicitly. Character styles can reverse the inherited value; their
On/Off options show whether they keep or reverse it for this document's defaults.
Direct formatting remains in effect. Use **Style inheritance sample** to try a
document with bold/italic defaults and mixed paragraph, table and character styles.

Typing and Enter carry character references forward. Choose **Default
characters** to return to unstyled typing. Undo restores the previous text,
reference and pending typing choice. Download/reopen retains shared definitions,
styled empty paragraphs and direct overrides. Plain-text clipboard does not
carry character styles.

### Page setup and breaks

Open `public/fixtures/page-settings.docx` or download **Page sample** in the
playground. Its landscape A4 pages have asymmetric margins and explicit breaks.
Use **Page setup** for paper size, portrait/landscape, custom dimensions, margins
and gutter (in inches). Apply is one undo step and keeps your text selection.
Unchanged imported measurements remain exact.

Insert a **Page break** with the toolbar or Ctrl/Cmd+Enter; Shift+Enter inserts a
manual line break. Both remain inside the current paragraph. Backspace/Delete
can remove them. **Start paragraph on new page** changes paragraph pagination, including
an explicit override of a style-inherited setting. Download/reopen and Puter
save/reload use the same page settings as the preview.

### Bullets and numbering

Open **List sample** (`public/fixtures/numbering.docx`). It includes inherited
numbering, nested items, a separate sequence starting at seven, bullets and an
ordinary paragraph that explicitly disables inherited numbering.

Use **Bulleted list** or **Numbered list** on selected paragraphs. The same button
removes that list kind. **Increase indent**/**Decrease indent**, or
Alt+Shift+Right/Left, change list levels. **Restart numbering at 1** starts a
separate sequence for the remaining contiguous items at that level or deeper.
Enter continues a list; Enter on an empty item or Backspace at the start removes
its list formatting. Undo restores the labels, geometry and text selection.

Labels are generated separately from editable text. Click a label to put the
caret at the start of its item. Wrapped lines align at the continuation indent.
Download/reopen preserves instance references, levels, restarts and original
style definitions. Text mode and plain-text clipboard currently omit labels.

### Keep paragraphs and lines together

Open **Pagination sample** (`public/fixtures/paragraph-pagination.docx`). Its
short pages make the rules visible: two headings stay with the following body,
an eight-line paragraph stays together, and the last paragraph avoids single
lines at page boundaries. Use **Keep with next paragraph**, **Keep lines together**
and **Widow and orphan control** to change selected paragraphs. Pressed icons
mean on; a dashed border indicates mixed values. Mouse and keyboard activation
preserve the text selection. Undo and redo restore both formatting and pagination.

The sample initially has four pages. Select both headings and turn off keep-with-next
to return them to the first page and reduce the document to three pages. Download
and reopen to check the result. Widow/orphan control defaults on unless a style
or direct property disables it. Authored page breaks take precedence. Paragraphs
or chains too large for a page start on a fresh page and then split.

### Indents and tab stops

Open **Indent/tab sample**, or `public/fixtures/indents-tabs.docx`, then use the
ruler icon (**Indents and tabs**). Set left/right indents, a first-line or hanging
indent, custom left/center/right/decimal stops, and default tab spacing in inches.
Blank mixed fields remain unchanged. Apply is one undo step, including a changed
document-wide default interval; opening and applying unchanged values preserves
exact imported distances and redo history.

**Increase indent** and **Decrease indent** move selected paragraphs by half an
inch while preserving their different indents. Press **Tab** or use **Insert tab**
to insert a real tab character. **Shift+Tab**, or **Escape** then **Tab**, leaves the
editor input. Decimal tabs currently align on a period; bar tabs remain unsupported.
Leader controls are described above. Download/reopen preserves supported geometry, style
inheritance, inherited clears and document defaults.

### Paragraph formatting scenario

Open `public/fixtures/paragraph-formatting.docx`, independently generated with python-docx. It starts as two pages in this preview. The first paragraph inherits centered alignment, 1.5× line spacing, 6pt before and 18pt after from a paragraph style. The second uses the Normal style.

Select both paragraphs: different values appear as **Mixed**. Set center alignment and double line spacing; text moves onto additional pages. Undo the spacing change to restore two pages, then redo. Set before/after spacing to 12pt/18pt, download, and reopen. Confirm the text, formatting, page count, click placement, and selection are retained. Paragraph changes are one undo transaction and keep the original text selection.

`/mock.html` runs the full app with its existing local Puter mock. The ordinary app entry uses the new editor with the existing Puter document/save/navigation model.

## Modules and contracts

| Module | Responsibility |
| --- | --- |
| `src/engine/model.js` | Table structure, cell edits, paragraphs, text runs, selection, text/paragraph formatting, transactions and bounded undo/redo history. |
| `src/engine/styles.js` | Plain paragraph/character style definitions, hierarchy and mark resolution, direct-override precedence and shared edits. |
| `src/engine/formatting.js` | Shared format defaults and supported-property validation. |
| `src/engine/numbering.js` | List counters, generated definitions and geometry precedence. |
| `src/engine/docx-numbering.js` | Numbering part parsing and preservation-aware appending. |
| `src/engine/list-layout.js` | Generated label metrics, alignment and suffix placement. |
| `src/engine/tables.js` | Cell ownership, document block projection and fixed/AutoFit column sizing. |
| `src/engine/intrinsic-widths.js` | Cell content measurements for AutoFit, independent of mutation and XML. |
| `src/engine/docx-tables.js` | Table subset validation, style geometry and preservation-aware table shells. |
| `src/engine/docx.js` | Bounded ZIP loading, namespace-aware XML parsing, supported-content validation, preservation and export. |
| `src/engine/page-settings.js` | Validated single-section settings in integer twips and pixel geometry. |
| `src/engine/paragraph-geometry.js` | Indent and tab validation, exact distances and paragraph edges. |
| `src/engine/line-builder.js` | Incremental font shaping and aligned tab fields with source-mapped geometry. |
| `src/engine/layout.js` | Line wrapping, measured lines, caret stops, hit testing, selection rectangles. |
| `src/engine/pagination.js` | Synchronized table row fragments, page placement, keep chains, widow/orphan look-ahead and explicit-break precedence. |
| `src/engine/table-headers.js` | Header measurement and repeated page projections, with one canonical source copy. |
| `src/engine/images.js` | Inline object boundaries, raster metadata limits and browser bitmap decoding. |
| `src/engine/docx-images.js` | Supported DrawingML picture structure, image relationships and media serialization. |
| `src/engine/canvas-editor.js` | Painting, pointer/keyboard interaction, native text input and composition bridge. |
| `src/views/editor.js` | Supported toolbar controls and document storage integration. |
| `src/views/style-editor.js` | Shared paragraph/character definition dialog with type-appropriate controls. |
| `src/playground.js` | Local sample/open/download harness. |

Positions are UTF-16 offsets in paragraphs joined by a single newline (`\n`). Inside runs, `\t` is a tab, `\v` represents a manual line break and `\f` a manual page break; the codec serializes these as XML elements, never illegal XML control characters. A picture run uses one `U+FFFC` object position with separate picture metadata; the codec writes DrawingML, not a text placeholder. Immutable binary assets are separate from runs and history snapshots. Navigation and editing boundaries are grapheme-aware, with pictures kept separate from adjacent combining marks. This is deliberately a small initial position model: future comments, multiple stories, and collaborative editing will require stable anchors and explicit position mapping. Do not pretend current numeric positions remain valid after arbitrary edits.

The native textarea presents all three break kinds as readable newlines, preserving one-to-one offsets. Native reconciliation preserves unchanged breaks and their original kinds; newly typed plain-text newlines create paragraphs. Canvas is a visual projection. Composition updates preview the document, then commit one undo transaction. Plain-text clipboard operations use the same model. Text mode exposes the native textarea for accessible editing; it does not communicate rich formatting to a screen reader. Automated composition events are not a substitute for testing real OS input methods and assistive technology.

## DOCX preservation

- Unedited files preserve every ZIP entry's uncompressed bytes; the ZIP container itself may be recompressed.
- Paragraph style changes keep inherited run properties out of direct formatting. Shared style edits update only the requested declarations in the styles part. The model and package export accept style and table state alongside paragraph, page and numbering state.
- Edited files retain unrelated package parts and serialize paragraph changes to `word/document.xml`. Changing the default tab interval updates `word/settings.xml`, creating its part/relationship/content type if absent.
- Original paragraph/run properties are retained, with explicit overrides for supported formatting changes.
- Alignment, spacing, pagination flags, indents and custom tabs resolve through document defaults, paragraph style inheritance and direct formatting. Spacing attributes inherit independently. Edits write only changed properties and retain the original style references and unrelated properties.
- Unedited paragraphs retain their XML structure, except stale `lastRenderedPageBreak` cache hints removed after an edit. New split paragraphs receive no duplicate paragraph IDs (`w14:paraId`).
- The codec supports the standard transitional WordprocessingML namespace and conventional `word/document.xml` package location.
- Unsupported table and drawing forms, fields, comments, tracked content, unsupported numbering forms, multiple sections, protected documents, and other unsupported inline/block structures are rejected before a save handler is attached. Imported raster images decode before save attachment. Failed imported copies remain recoverable; they are never automatically written over the source.

## Current limits

This is a functional prototype, not feature-complete relative to the previous editor:

- Editing covers fixed-width table structure and cell text, paragraph/character styles, paragraphs, text, tabs, bold, italic, single underline, font size, paragraph alignment/spacing, indents and custom/default tab stops, keep-with-next, keep-lines and widow/orphan control, bullets and numbering, page setup and manual breaks, plain-text clipboard, undo and redo.
- Page preview uses saved single-section dimensions, margins and gutter, and Noto Sans with run-specific sizes and a real italic face. Letter, A4, Legal and custom sizes are supported. Imported fonts and other unsupported formatting remain preserved without faithful preview. See the conformance record for page defaults, application limits and rejected structures.
- The toolbar offers left/center/right/justified alignment, preset/custom line-spacing multiples, exact/minimum point heights, and before/after spacing in points. Choosing a line-spacing preset replaces an imported point height with a multiple; Line spacing options can also restore inheritance. Mixed properties are shown individually. A selection ending at the start of another paragraph excludes that paragraph; a caret formats its current paragraph, including empty ones. Splits inherit the paragraph format; merges use the first paragraph's format.
- Line-spacing multiples use each line’s maximum run ascent/descent from the Noto font tables. Adjacent after/before gaps collapse to the larger value. Before-spacing that cannot fit with its first line is suppressed at a new page; trailing after-spacing does not create blank pages. The terminal-break paragraph-mark and leading-break before-spacing compatibility flags are implemented; the tab compatibility flags are implemented as well. Keep-with-next chains, keep-lines and widow/orphan control use measured line heights. Other compatibility flags and font fallback remain future work.
- Paragraph spacing is limited to 0–600pt; line spacing to 0.5–5× or 6–600pt. DOCX spacing uses twentieths of a point and multiples use 240ths of a line. Contextual spacing is supported as described above. Justified/distributed alignment and effective automatic or line-unit before/after spacing are rejected before editing.
- Canvas measurement delegates shaping to the browser. Ligature caret precision, bidirectional layout, broad script coverage and exact native pagination are unfinished.
- Each input event is an undo transaction; consecutive ordinary typing is not yet grouped into words.
- The entire document is laid out and repainted after each edit. There is a 200-page preview limit, a 100,000-character limit, a 20MB compressed input limit, and a 50MB expanded ZIP limit. These bounds are not a performance guarantee for large documents.
- Text imports, templates, links, review features and the old engine-specific toolbar actions are not connected to this engine. App-authored helpers remain in the repository for future porting. Inline PNG/JPEG pictures use the original engine's separate image path.
- No browser-PDF export, collaborative editing, or complete mobile/assistive-technology support is claimed.

## Validation

```sh
npm run check:licenses
npm test
npm run test:browser
npm run build
```

Browser tests use a fresh headless Google Chrome instance by default. To use Playwright's open-source Chromium build instead:

```sh
npx playwright install chromium
PLAYWRIGHT_CHANNEL=chromium npm run test:browser
```

The suite starts its own development server on port 5189 so another app on the
usual Vite port cannot be mistaken for this editor. Set `PLAYWRIGHT_PORT` to use
another free port; an occupied port fails rather than reusing an unknown server.

The browser suite covers canvas editing, cross-paragraph bold and paragraph formatting, mixed toolbar values, spacing-driven repagination, undo/redo, download/reopen, input composition events, text mode, and Puter mock save/reload. It saves screenshots and the downloaded DOCX in `test-results/`.

For an independent format check, install `python-docx` in a separate environment and run:

```sh
python tools/verify-canvas-docx.py --generate-fixture
python tools/verify-canvas-docx.py test-results/canvas-opens-DOCX-edits-on-b373c-es-and-reopens-its-download/edited.docx
```

The generator overwrites the sample fixture. It is not a runtime dependency.

Generate the separate formatting fixture with `python tools/verify-canvas-docx.py --generate-formatting-fixture`. Check its edited browser download with `python tools/verify-canvas-docx.py --paragraph-formatting <path-to-formatted.docx>`.

The OOXML spacing implementation follows the attribute inheritance and spacing-unit definitions in the [Open XML SDK `SpacingBetweenLines` reference](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.spacingbetweenlines?view=openxml-3.0.1). It uses the format specification, not another editor's source.

## Next iterations

1. Strengthen composition, screen-reader interaction, and caret behavior at soft wraps.
2. Replace global offsets with mapped anchors before introducing persistent annotations.
3. Reassess picture import compatibility (clipping extents and differing inner/outer dimensions) and image editing affordances against the specs; retain explicit rejection until their layout behavior is implemented.
4. Extend style compatibility, including linked-style behavior, additional decorations and remaining outline/TOC semantics.

Keep each iteration backed by a small input fixture, editing scenario, undo check, and independent DOCX round trip. The dependency policy in `AGENTS.md` prohibits AGPL and unavailable-source engine binaries.

Generate the independent page fixtures with `python tools/verify-canvas-docx.py --generate-page-fixture`. Run the browser suite followed by `npm run check:conformance` to check the edited page document and the default/compatibility break fixtures.

Generate the independent indent/tab fixture with `python tools/verify-canvas-docx.py --generate-indent-fixture`. Browser acceptance exports `indents-tabs.docx`; `npm run check:conformance` independently checks the indents, tabs, clears, default interval and retained content.

Generate the independent pagination fixture with `python tools/verify-canvas-docx.py --generate-pagination-fixture`. Browser acceptance exports `pagination.docx`; conformance validation checks direct overrides, inherited styles, text and retained formatting.

Generate the independent list fixture with `python tools/verify-canvas-docx.py --generate-numbering-fixture`. Browser acceptance exports `numbering.docx` and `new-lists.docx`; conformance validation checks their definitions, references, starts, levels and text.

Generate the independent style fixture with `python tools/verify-canvas-docx.py --generate-styles-fixture`. Browser acceptance exports `styles.docx` and `new-styles.docx`; conformance validation checks shared definitions, references, direct overrides, inherited lists, following styles and text.

Generate the independent character-style fixture with `python tools/verify-canvas-docx.py --generate-character-styles-fixture`. Browser acceptance exports `character-styles.docx` and `new-character-styles.docx`; conformance validation checks reference changes, shared declarations, composition text, direct overrides and styled empty paragraphs.

Generate the independent table fixture with `python tools/verify-canvas-docx.py --generate-tables-fixture`. Browser acceptance exports `tables.docx` and `new-tables.docx`; conformance validation checks their cell contents, boundaries, widths, table styles, row pagination and retained formatting.

Generate the independent AutoFit fixture with `python tools/verify-canvas-docx.py --generate-autofit-fixture`. Browser exports `autofit-tables.docx` and `new-autofit-tables.docx` cover content edits, sizing preferences, fitting, layout changes, indentation and save/reopen.

Generate the independent merged-cell fixture with `python tools/verify-canvas-docx.py --generate-merged-cells-fixture`. Browser exports `merged-cells.docx` and `new-merged-cells.docx` cover horizontal merging/splitting, span-aware column/row operations, formatting, sizing and DOCX preservation.

Generate the independent vertical-cell fixture with `python tools/verify-canvas-docx.py --generate-vertical-cells-fixture`. Browser exports `vertical-cells.docx` and `new-vertical-cells.docx` cover vertical and rectangular merges, splitting, row extension, undo, inherited formatting, preserved continuation XML and fixed/AutoFit save/reopen.

Generate the flowing-table fixture with `python tools/verify-canvas-docx.py --generate-vertical-pages-fixture`. Browser exports `vertical-pages.docx` and `new-vertical-pages.docx` cover imported and newly authored merges across pages, mixed typography, inherited/direct row keeps, continuation-row insertion and minimum row heights taller than a page. Geometry regressions check text containment, non-overlapping fragments, cell-local arrow movement, blank-fragment clicks, heading keeps and undo/save/reopen.

Generate the repeated-header fixture with `python tools/verify-canvas-docx.py --generate-table-headers-fixture`. Browser exports `table-headers.docx` and `new-table-headers.docx` cover inherited/direct flags, ignored noncontiguous flags, merged headers, editing on a repeated page, structural undo, boundary insertion and save/reopen. Independent validation checks that display copies never become extra stored rows or text.

Generate the inline-picture fixture with `python tools/verify-canvas-docx.py --generate-inline-images-fixture`. Browser exports `inline-images.docx` and `new-inline-images.docx` cover imported and newly inserted PNG/JPEG media, size/description edits, adjacent typing, repeated headers, undo/redo and save/reopen. A corrupt-pixel browser regression verifies rejection before save attachment. Independent checks cover DrawingML extents, positions, descriptions, relationships and retained media bytes.

Generate the crop fixture with `python tools/verify-canvas-docx.py --generate-cropped-images-fixture`. Browser exports `cropped-images.docx` and `new-cropped-images.docx` cover crop controls, reset, transparent outsets, resizing with local-DPI extensions, invalid geometry, undo/redo and save/reopen. Pixel tests check sampled colors and the outset position within the fixed frame. Independent checks inspect source percentages, untouched spellings, compression metadata, extents and unchanged binary/package parts.

Generate the flip fixture with `python tools/verify-canvas-docx.py --generate-flipped-images-fixture`. Browser exports `flipped-images.docx` and `new-flipped-images.docx` cover imported and authored flips, source crop order, asymmetric outsets, repeated headers, absent transforms, deletion undo and save/reopen. Four-color pixel checks distinguish horizontal, vertical and combined reflections. Independent verification checks exact flags, untouched crop/extension metadata, frame dimensions and source bytes.

Generate the rotation fixture with `python tools/verify-canvas-docx.py --generate-rotated-images-fixture`. Browser exports `rotated-images.docx` and `new-rotated-images.docx` cover signed/arbitrary angles, crop/flip order, extra extents, repeated headers, absent transforms, resize, deletion undo and save/reopen. Pixel checks measure visible rotated bounds and independently transformed source quadrants. Python verification derives corner padding independently and checks angle spellings, unchanged base dimensions, media bytes and package parts.

Generate the outline fixture with `python tools/verify-canvas-docx.py --generate-outline-fixture`. Browser exports `outline-levels.docx` and `new-outline-levels.docx` exercise inheritance, body overrides, clear-to-style, built-in heading rules, Unicode/empty/table headings, keyboard navigation, undo and save/reopen. Canvas pixel comparisons verify that level edits do not alter appearance or pagination; independent checks verify resolved declarations and preserve fonts, numbering and package parts.
