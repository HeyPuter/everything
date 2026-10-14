# Tables: desktop word-processor parity

What the table tools cover, what is approximated, and what is still missing.
OOXML details and the supported subset are in
[conformance.md](../conformance.md#table-tools-structure-table-styles-and-formulas-2026-10-13).

## Implemented

**Insert → Table**
- Size grid (10 × 8) with a live "columns × rows" label, plus a quick rows/columns
  form for sizes past the grid.
- Insert Table… dialog: columns, rows, fixed column width (automatic or a width),
  AutoFit to contents, AutoFit to window, with a live sketch; "Remember these
  settings" keeps the choice for this browser.
- Draw Table (pen): draw an outline on the page for a one-cell table of that size;
  inside a table, a horizontal stroke adds a row through the crossed cells and a
  vertical stroke adds a column line through them. Eraser: click a line between
  two cells to merge them. Escape ends either tool.
- Convert Text to Table… (paragraphs, tabs, commas or another character; the
  column count is read from the text and can be raised; AutoFit choices).
- Quick Tables: Calendar (current month), Tabular List, Double Table, Matrix, With
  Subheads — original content, each with a library style.

**Table Design**
- Table Style Options: Header Row, Total Row, Banded Rows, First Column, Last
  Column, Banded Columns, saved as `w:tblLook`.
- Table Styles gallery: 47 original styles in Plain, Grid and List families with
  seven accent colors, drawn with the engine's own region resolution; More shows
  every style by family, Modify Table Style…, Clear and New Table Style….
  Styles are real `styles.xml` table styles, so other word processors show them
  too. Alt+click applies a style without clearing direct cell formatting.
- Shading (palette on the arrow; the button opens the cell shading dialog).
- Borders: Border Styles (ready pens), Line Style, Line Weight, Pen Color, the
  Borders drop-down (Bottom, Top, Left, Right, No Border, All, Outside, Inside,
  Inside Horizontal, Inside Vertical, Diagonal Down, Diagonal Up, View Gridlines,
  Borders and Shading…), and
  the Border Painter (click cell edges to paint with the pen). Choosing an edge
  that already has the pen removes it, as in desktop word processors.

**Table Layout**
- Select (Cell, Column, Row, Table) as real cell blocks; dragging from one cell
  into another also selects a rectangle of cells. View Gridlines toggles the
  dashed edges of borderless cells (screen only). Properties.
- Draw Table, Eraser.
- Delete (Cells…, Columns, Rows, Table); Insert Above, Below, Left, Right (as many
  as are selected); Insert Cells… (group launcher); Paragraph Before/After.
- Merge Cells (any rectangle), Split Cells… (rows × columns; merges a multi-cell
  selection first), Split Table.
- AutoFit (Contents, Window, Fixed Column Width), Height and Width spinners,
  Distribute Rows, Distribute Columns, Keep Together and the row height dialog.
- Alignment: 3 × 3 grid (horizontal + vertical at once, with the current one
  shown pressed), Text Direction (horizontal → 90° → 270°), Cell Margins, and the
  vertical alignment dialog as launcher.
- Data: Sort… (up to three keys, text/number/date, ascending/descending, header
  row, case sensitivity), Repeat Header Rows, Convert to Text…, Formula… (live
  result preview, number formats, paste function).
- Table Properties: one dialog with Table, Row, Column, Cell and Alt Text
  sections (preferred widths, alignment, indent, text wrapping None/Around,
  default cell margins, row height exactly/at least, allow row to break, repeat
  header, column width with previous/next, cell width, vertical alignment, wrap
  text, title and description); Apply is one undo step.

**Mouse and keyboard**
- Drag column borders (two neighbouring columns trade width; the right edge
  widens the table) and row borders (minimum height), with a guide line and a
  measurement label.
- Move handle (top-left): click selects the table; drag drops it before another
  paragraph. Resize handle (bottom-right): scales columns and rows.
- "+" marks in the left gutter (between rows) and above the table (between
  columns) insert a row or column there.
- Tab in the last cell adds a row. On a block of cells, Delete clears the cells'
  contents; Backspace removes selected whole rows, columns or the table, and opens
  Delete Cells for any other block.

**Menus**
- `extendMenu('table')` provides the classic Table menu (Draw Table, Insert ▸,
  Delete ▸, Select ▸, Merge/Split, Split Table, AutoFit and Distribute ▸, Repeat
  Header Rows, Convert ▸, Sort…, Formula…, View Gridlines, Table Properties…);
  `extendMenu('insert')` adds Table….
- `contextMenuItems('table')`: Insert ▸, Delete ▸, Merge Cells, Split Cells…,
  Borders ▸, Cell Alignment ▸, AutoFit ▸, Text Direction ▸, Table Properties….

## Approximations

- Character formatting on a block that is not whole rows is applied cell by cell
  (`setRunFormat`/`setParagraphFormat`); other text commands (paste, styles,
  lists) still use the text range from the first cell.
- Drawing a horizontal line adds a whole new row (merging the other cells down)
  rather than cutting the cell at the exact drawn height; the new row starts at
  its automatic height.
- Shift cells left/right writes omitted grid cells (`gridAfter`); later column
  insertion in such tables is still refused by the existing engine rule.
- The thumbnails draw borders without the full conflict resolution of the page.
- Diagonal borders are drawn as a line of the border's width and color (dotted and
  dashed patterns approximated); compound styles draw as one line.
- Formula directions stop at the first cell without a leading number (a header
  such as "Q1" stops `ABOVE`); empty cells directly beside the formula are skipped.
- Moving a table by its handle places it in the text flow; floating tables keep
  their position.

## Gaps

- Modify Table Style edits library and document-made styles only; styles that came
  with an opened document can be applied to their own tables but are not offered
  for other tables or for editing.
- Splitting several cells without merging them first; converting text inside a
  table cell; converting nested tables to text.
- Formula bookmarks, `R1C1` references and general (`\*`) formats.
- The rulers do not yet show table column markers; dragging uses an on-page guide.
- Table cell spacing, right-to-left tables and tracked structural changes remain
  unsupported (see the table property coverage notes).
