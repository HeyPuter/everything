<img src="./icon.png" alt="Spreadsheet icon" width="80" height="80" />

# Spreadsheet

An open-source alternative to Microsoft Excel: a fast, private spreadsheet app
built with vanilla JavaScript (no frameworks),
Vite, and [Puter.js](https://developer.puter.com) as the only backend. Files
are real `.xlsx` documents saved to your own Puter cloud, so they open in
Excel, Numbers, or LibreOffice and never live on anyone else's server.

Nobody has to sign in to work: the app opens straight into a new sheet, and
Puter asks for a sign-in at the first action that needs the cloud, such as
saving, opening a file, or the spreadsheet list (`#/home`, behind the back
arrow). Until then the edits stay in the tab (and in this browser's local
draft) and the status pill reads "Sign in to save".

## App identity

`icon.png` is the source for the UI logo and browser/install icons. The primary
brand color is forest green (`#356d49`), sampled from the icon, with lighter
green accents for dark mode. The install metadata lives in `public/manifest.json`.

After replacing the source icon, run `npm run icons` (requires ImageMagick) to
regenerate the PNG/ICO favicons, Apple touch icon, and standard/maskable install icons.

## Features

- **Formulas** with live recalculation: over 510 functions covering math and
  statistics (`SUM`, `AVERAGE`, `MEDIAN`, `STDEV`, `ROUND`, `SUMPRODUCT`,
  `LARGE`, `RANK`, `PERCENTILE`, `MODE`, `CORREL`, `SLOPE`, `FORECAST`,
  `SUBTOTAL`, `SKEW`, `KURT`, `TRIMMEAN`, `FREQUENCY`, `TREND`, `GROWTH`,
  `LINEST`, `AGGREGATE`, `MODE.MULT`, trigonometry), distributions (`NORM.DIST`, `NORM.INV`,
  `BINOM.DIST`, `POISSON.DIST`, `EXPON.DIST`, `T.DIST`, `T.TEST`, `CHISQ.DIST`,
  `CHISQ.TEST`, `F.DIST`, `F.INV`, `F.TEST`, `GAMMA.DIST`, `GAMMA.INV`,
  `BETA.DIST`, `BINOM.INV`, `HYPGEOM.DIST`, `NEGBINOM.DIST`, `WEIBULL.DIST`,
  `CONFIDENCE.NORM`, `PROB`, `PERCENTRANK.EXC`, `MARGINOFERROR`),
  conditionals (`SUMIF`, `SUMIFS`, `COUNTIF`, `COUNTIFS`, `AVERAGEIF`,
  `AVERAGEIFS`, `MAXIFS`), database functions over a criteria table (`DSUM`,
  `DAVERAGE`, `DCOUNT`, `DGET`, `DMAX`, ...), logic (`IF`, `IFS`, `AND`,
  `OR`, `IFERROR`, `SWITCH`), text (`CONCAT`, `TEXTJOIN`, `LEFT`, `MID`,
  `SUBSTITUTE`, `TEXT`, `TEXTBEFORE`, `REGEXMATCH`, `REGEXEXTRACT`,
  `REGEXREPLACE`, `ARRAYTOTEXT`, `ENCODEURL`), lookup (`VLOOKUP`, `HLOOKUP`,
  `XLOOKUP` with match and search modes, `XMATCH`, `LOOKUP`, `INDEX`,
  `MATCH`, `INDIRECT`, `OFFSET`), dates (`TODAY`, `DATE`, `EDATE`, `EOMONTH`,
  `WEEKDAY`, `DATEDIF`, `NETWORKDAYS`, `NETWORKDAYS.INTL`, `WORKDAY`,
  `WORKDAY.INTL`, `WEEKNUM`, `YEARFRAC`, `EPOCHTODATE`), finance (`PMT`,
  `IPMT`, `CUMIPMT`, `CUMPRINC`, `FV`, `PV`, `NPER`, `RATE`, `NPV`, `IRR`,
  `MIRR`, `XIRR`, `SLN`, `DDB`, `DB`, `VDB`, `RRI`, `PDURATION`), math and
  engineering (`CEILING.MATH`, `FLOOR.MATH`, `MMULT`, `MINVERSE`, `MDETERM`,
  `BASE`, `DECIMAL`, `DEC2BIN`, `HEX2DEC`, `BITAND`, `ROMAN`, `ARABIC`,
  `CONVERT` with unit prefixes, `ERF`, `ERFC`, the Bessel functions
  `BESSELJ`, `BESSELY`, `BESSELI`, and `BESSELK`, and complex numbers with
  `COMPLEX`, `IMSUM`, `IMPRODUCT`, `IMDIV`, `IMPOWER`, `IMABS`, `IMEXP`,
  `IMLN`, `IMCOSH`, `IMSEC`, ...), discount securities and Treasury bills (`DISC`, `INTRATE`,
  `RECEIVED`, `PRICEDISC`, `YIELDDISC`, `TBILLEQ`, `TBILLPRICE`,
  `TBILLYIELD`), coupon bonds (`PRICE`, `YIELD`, `DURATION`, `MDURATION`,
  `ACCRINT`, `ACCRINTM`, `PRICEMAT`, `YIELDMAT`, and the coupon dates and
  day counts `COUPPCD`, `COUPNCD`, `COUPNUM`, `COUPDAYBS`, `COUPDAYS`,
  `COUPDAYSNC`), and information (`ISBLANK`, `ISNUMBER`,
  `ISERROR`, `ISFORMULA`, `ISREF`, `ISEMAIL`, `ISURL`, `ISBETWEEN`,
  `FORMULATEXT`, `CELL`, `INFO`), and `FILTERXML(xml, xpath)` to pick values
  out of XML text. Array constants (`{1,2;3,4}`), `LET` and `LAMBDA`
  with `MAP`, `REDUCE`, `SCAN`, `BYROW`, `BYCOL`, and `MAKEARRAY` (a
  `LET`-bound lambda can call itself; `[name]` declares an optional
  parameter that `ISOMITTED` checks, `LAMBDA(x, x+1)(4)` calls one on
  the spot, and a built-in named without parentheses is passed as a
  function: `BYROW(A1:C9, MAX)`), `GROUPBY` and `PIVOTBY` summaries
  (`=GROUPBY(A2:A99, C2:C99, SUM)` groups a column and totals another,
  with headers, subtotals, sort order, and a filter as options; `PIVOTBY`
  crosses two fields; `PERCENTOF` gives shares), `TRIMRANGE` to drop the
  blank edges of a range, `REGEXTEST`, the operators as functions (`ADD`,
  `MINUS`, `MULTIPLY`, `DIVIDE`, `POW`, `EQ`, `GT`, ...), reference unions
  (`=SUM((A1:A9,C1:C9,E5))` adds every cell of every area; `AREAS` counts
  them and `INDEX(..., area_num)` picks one), a range built from two
  reference expressions (`=SUM(A1:INDEX(A:A, COUNTA(A:A)))`), the `@`
  implicit-intersection operator (and Excel's `SINGLE`) that Excel writes into
  saved formulas, single-value functions applied to every cell of a range
  (`=SUM(LEN(A1:A9))`, `=LEN(A1:A9)` spills), sheet and defined names in any
  script (`=Übersicht!A1`, `=合計*2`), named formulas and named functions (a
  defined name can hold a constant, an expression, or a `LAMBDA` called like
  a function: `=Double(4)`), `IMAGE(url)` pictures inside cells,
  `AI(prompt, [data])` answers from Puter's AI written into the cell (`#BUSY!`
  while it thinks; one question per distinct prompt, F9 asks again),
  `TRANSLATE(text, [from], [to])` (or `GOOGLETRANSLATE`) and
  `DETECTLANGUAGE(text)` through the same AI,
  `IMPORTRANGE("Budget", "Sheet1!A1:B10")` cells from another spreadsheet on
  your Puter drive spilled into place (`#BUSY!` while the file loads),
  `IMPORTDATA(url)` a CSV or TSV from the web, `IMPORTHTML(url, "table",
  2)` a table or list from a web page, and `IMPORTXML(url, "//item/title")`
  nodes picked by XPath, spilled into place (through Puter's fetch, so most
  addresses work),
  `QUERY(range, "select A, sum(C) where B > 5 group by A order by sum(C)
  desc limit 10 label sum(C) 'Total'")` in the Sheets query language (select,
  where with and/or/not, contains, starts with, like, matches, is null, group
  by with sum/avg/count/max/min, order by, limit, offset, label, and
  year/month/day/upper/lower/len),
  imported Excel relative defined names (including previous-row and
  previous-column offsets) that recalculate at each calling cell and retain
  their native definitions on export, cross-sheet references (`Budget!B4`,
  `'Q1 Data'!A1:A9`), 3D references across a run of sheets
  (`=SUM(Jan:Dec!B5)` adds B5 on every sheet from Jan to Dec, hidden ones
  included, and follows renamed sheets and inserted rows), whole column and row ranges, named ranges, percent
  literals, spreadsheet error values with plain-language explanations on
  hover and in the status bar (a `#NAME?` names the misspelled function or
  unknown name and suggests the closest real one — "There is no function
  called SUMM. Did you mean SUM?" — and a `#REF!` names the missing sheet),
  and cycle detection. Workbooks that explicitly enable iterative
  calculation recalculate circular formulas using their iteration limit and
  convergence tolerance; these settings and calculated values survive XLSX
  export and draft recovery. `NOW()` and `TODAY()` stay current.
- **Dynamic arrays**: `UNIQUE`, `FILTER`, `SORT`, `SORTBY`, `SEQUENCE`, `RANDARRAY`,
  `TRANSPOSE`, `FLATTEN`, `SPLIT`, `TEXTSPLIT`, `CHOOSECOLS`, `VSTACK`,
  `HSTACK`, `TAKE`, `DROP`, `EXPAND`, `WRAPROWS`, `WRAPCOLS`, `TOCOL`, `TOROW`,
  and plain range arithmetic (`=A1:A5*2`, `=IF(B1:B9>0,"yes","no")`) spill
  into the cells beside the formula; anything in the way shows `#SPILL!`
  until it is moved. `A1#` refers to everything an array formula at `A1`
  spilled (`=SUM(A1#)`, `=SORT(A1#)`), and grows and shrinks with it, down
  to the cell itself when a `FILTER` narrows to one row (saved
  as `ANCHORARRAY(A1)`, the form Excel uses). Array results nest inside other functions
  (`=SUM(FILTER(...))`, `=COUNTA(UNIQUE(...))`) and are written to `.xlsx`
  as array formulas.
- **Charts and images**: column, bar, line, area, pie, donut, scatter,
  combo (columns with a line, which can read against its own axis on the
  right when the two series differ in scale), histogram (with a chosen bin count),
  waterfall, radar, and bubble (a third column sizes the points) charts
  drawn from a range with detected headers and categories (hidden and
  filtered-out rows and columns are left out unless the chart's Include
  hidden cells option is on), stacked or 100% stacked, with optional value labels, axis titles, linear
  trendlines, a color of your choice per series, the legend below, above, or
  beside the plot, fixed axis bounds, gridlines that can be turned off,
  smooth curves for line and area charts, and axis and value labels in the
  data's currency, percent, or date format (large values read as K, M, B,
  and T), floating over the sheet; a chart's menu duplicates it, copies it to the clipboard as a picture, or downloads it as PNG or SVG. Drag to
  move, drag the corner to resize, double-click to edit, download as PNG or
  SVG; Ctrl/Cmd+Alt+O selects the next chart, image, or text box from the
  keyboard (the arrow keys nudge it, Delete removes it, Ctrl/Cmd+C copies it
  as a picture); charts follow inserted, deleted, and reordered rows and
  columns and are saved in the file. Excel line, scatter, clustered and stacked bar/column, and Pareto combo
  charts linked to worksheet ranges, including separate chart sheets, import with
  their theme colors, fonts, plot layout and axes; the series keep reading live cells
  across sheets, including non-adjacent source ranges. Date axes preserve calendar month/year intervals and rotated labels;
  scatter charts preserve numeric or ordinal X coordinates. Excel charts built from line or area and scatter layers retain
  their outlines and labels linked to cells, including hidden helper sheets and
  named formulas that position labels at the latest data points. Combined stacked-area,
  column and scatter charts preserve each group's stacking and curves, and export
  as editable native Excel charts. Numeric axes preserve built-in and custom display
  units and their labels through Excel export. Chart data tables preserve live
  formatted values, fonts, border options and series keys through native export,
  chart duplication and copying as a picture. Compact progress
  charts retain their percentage scales, plot borders, and individual bar colors. Excel's
  single-series pie and doughnut charts retain their slice colors, borders, hole size,
  rotation, and live category/value labels, including custom label fields and positioning.
  Native bubble charts retain each series' X, Y and size vectors, including embedded
  chart values, gradient fills, value labels, standard error/deviation, fixed and percentage
  error bars, and chart-relative text annotations. Sheet default column widths keep
  chart anchors and the surrounding cells aligned with the imported layout.
  Excel's newer ChartEx Pareto charts also import with live category
  totals, descending bars and a cumulative percentage axis. Transparent chart fills,
  plain filled decorative rectangles, numeric freeform vector groups, and embedded raster pictures retain their
  placement; pictures keep their size, rotation and mirroring.
  Pictures from your device, dropped onto the sheet, or pasted from the
  clipboard (a screenshot, an image copied from a page) float the same way
  (resized keeping their proportions, replaceable). `SPARKLINE(range, "line"
  | "column" | "bar" | "winloss")` draws a mini chart inside a cell. Text
  boxes (Insert → Text box, or the cell menu) float over the sheet the same
  way for titles, notes, and captions, with a font size, bold and italic,
  text and fill colors, alignment, and an optional border; double-click to
  edit, and they print where they sit.
- **Hierarchy, statistical, stock and surface charts**: Insert ▸ Charts also offers
  treemaps and sunbursts (each leading label column is a level of the hierarchy, blank
  parent cells repeat the label above; parents are named overlapping their boxes, in a
  banner, or not at all, and each top-level branch keeps one colour), box and whisker
  charts (exclusive or inclusive median quartiles, whiskers to 1.5 interquartile ranges,
  outlier and inner points, mean markers and a mean line, rows pooled by category),
  funnels, stock charts (High-Low-Close, Open-High-Low-Close with up/down bars, and both
  with volume columns on their own axis), 3-D surface, wireframe, contour and wireframe
  contour charts coloured in value bands set by the value axis's major unit, and exploded
  pie and doughnut, pie of pie and bar of pie charts. Each has its gallery tile and
  Change Chart Type page, Recommended Charts suggests them for data of their shape
  (price columns, nested labels, long columns of numbers, stage counts), and the Format
  pane sets their options. They round-trip through `.xlsx`: treemaps, sunbursts, box and
  whisker and funnel charts as extended chart parts (with a fallback note for older
  readers, and named sources read as other apps write them), stock and surface charts as
  classic chart parts.
- **Hyperlinks**: `HYPERLINK(url, label)` cells and typed web or email
  addresses are clickable (Ctrl/Cmd+click opens them, a popover shows where
  they go). Ctrl/Cmd+K inserts or edits a link to a web address, to a sheet
  and range, or to a named range (`#Sheet!A1`, the form Excel uses); a place
  link jumps there; Remove link (in the cell menu or the link dialog) leaves
  the text plain, a typed address included. Links round-trip through `.xlsx`. Copy link to this
  cell (or range, in the cell menu) puts an address on the clipboard that
  opens the file with those cells selected, on that sheet, for pasting into
  a chat or a document.
- **AI assistant**: a chat beside the sheet, open by default (the Ask AI
  button, View → AI assistant, or Ctrl/Cmd+J open and close it; closed, it
  stays closed on the next visit) where Puter's AI (Claude Opus 5.5) answers questions about the workbook
  and changes it: it reads cells, works figures out with the formula engine
  rather than guessing, and can write values and formulas, fill a column,
  format, sort, insert and delete rows and columns, add charts, tables,
  conditional formats, dropdowns, notes and sheets, freeze panes and size
  columns. Each tool call shows as a step in the reply, linked to the cells
  it touched, and cell references in a reply select their cells. A change
  that replaces or deletes data waits for Allow (or every change, or none,
  as chosen in the panel's menu); every change is an undo step, and a reply
  that changed the workbook ends with an Undo for all of its changes (only
  while nobody has edited since). Each message is sent with a short summary
  of the sheets and the selected cells, which the panel names; cell
  contents are treated as data, never as instructions, a formula it writes
  that fetches from the web waits for the file's Allow, and pictures in
  replies are never loaded. On a phone the panel is a sheet over the grid.
- **Automate (scripts)**: an Automate ribbon tab for JavaScript scripts with
  an `async function main(workbook)` that work on the workbook through a
  documented object model (worksheets, ranges, values and formulas, fills,
  fonts, alignment, borders, sizes, insert and delete, sort, fill, merge,
  hide, notes, links, tables and charts; Script Reference lists it all).
  The Code Editor pane beside the sheet has syntax colouring, line numbers,
  indentation that follows the code, closing brackets and quotes, bracket
  matching, Find and Replace, line comments, completions for the API, Run
  (Ctrl/Cmd+Enter) and Stop, and output whose errors link to their lines.
  Record Actions writes what you do (typing, formatting, borders, inserting
  and deleting, sorting, fill, sizes, sheets, tables) as a new script. All
  Scripts gathers the workbook's scripts, My Scripts (`.js` files kept on
  your drive, for any workbook) and samples, which also run straight from the
  ribbon: highlight duplicates, unhide everything, sum each column, a table of
  contents sheet, style the header row, remove blank rows. Script Button puts
  a button on the sheet that runs a script when clicked (Shift+click selects
  it). Everything a run changes is one undo step. Scripts run in a worker inside a sandboxed frame
  with an origin of its own and no network, so they reach the workbook and
  nothing else (not the page, your account or your files), and they are
  stopped after two minutes or when you press Stop; a script that came inside
  someone else's file runs only once you agree. Scripts are saved with the
  workbook, in `.xlsx` as a package part of their own that other programs
  leave alone.
- **AI help with formulas**: describe what a cell should calculate and Puter's
  AI writes the formula (the sheet's headers, a few sample rows, tables, and
  named ranges are explained to it, and the dialog says which cells were
  sent; you check it and insert it), or ask it to explain the
  formula in the active cell in plain language (Insert function menu and the
  cell menu). Ask AI about this data sends a question with the selected
  cells' values (or the sheet's data, up to 60 × 15) and shows the answer,
  which can be copied or written into a cell.
- **Formula help while typing**: function-name autocomplete with descriptions
  (named ranges and tables included, and a table's columns once `Table[` is
  typed), a signature hint that tracks the current argument,
  colored reference highlights (structured references light up the table
  cells they name), click-to-insert references, point mode (the
  arrow keys pick a reference wherever the formula expects one, Shift extends
  it to a range), AutoSum with Alt+=, and the closing parentheses a typed
  formula leaves open are added on entry (`=SUM(A1:A5` becomes
  `=SUM(A1:A5)`), as Google Sheets does.
- **Editing** the way spreadsheets are expected to work: type to replace,
  F2 or double-click to edit in place, Enter and Tab that walk a selection,
  Ctrl/Cmd+Arrow to jump across data, Shift to extend, Ctrl/Cmd+A to select
  the block of data around the active cell (the whole sheet on a second
  press), Ctrl/Cmd+Enter to fill
  the whole selection, Ctrl/Cmd+D and R to fill down and right, a fill handle
  that continues numeric series and month, weekday, and quarter names (and
  double-clicks to fill alongside data; Ctrl/Cmd flips it to count a lone
  number up or repeat a series), a Fill series dialog (linear,
  growth, or date steps to a stop value), copy/cut/paste with relative
  reference adjustment (a cut leaves its cells in place until the paste moves
  them, in one undo step; pasting a table copied from Excel or Google Sheets keeps its
  formatting, links, typed values, and number formats), paste special (values only, formatting only, formulas
  only keeping the target's formatting, transposed, skipping blanks, as links back to the copied cells, inserted with the cells already there shifted down or right, column
  widths, or add, subtract, multiply, and divide into the numbers already
  there),
  insert and delete rows and columns with every formula on every sheet
  updated (a new row or column takes the formatting of the one above or to
  its left), insert or delete cells shifting the rest down, right, up, or left
  (references in the shifted band follow), and 200 levels of undo — fewer when the steps hold more cells
  between them than the memory allowed for them, so that a run of sorts over a large table cannot fill the
  tab (right-click Undo or Redo for the history and
  step back several actions at once). Drag a selection by its border to move it
  (references follow the moved cells; Alt copies instead), and drag a selected
  row or column header to reorder rows or columns (a move that would cut
  through a merged block, or land on part of one, is refused). Ctrl/Cmd+click adds
  cells, ranges, rows, or columns to the selection: formatting, clearing,
  hiding, deleting rows or columns, and fitting rows or columns to their
  content act on all of them at once, Enter and
  Tab walk the active cell through each of them in turn, and the
  status bar sums them together; Select cells in the cell menu picks every
  blank, formula, typed value, number, text, error, or noted cell in the data
  the same way. Typed dates are recognized in the
  common shapes (`2026-08-28`, `8/28/2026`, `8/28/26`, `28/8/2026`, `8/28`,
  `Aug 28, 2026`, `28 Aug 2026`, `28-Aug-26`, with an optional time, and with
  the month written in the regional format's language as well as English:
  `5. März 2026`, `15 mars 2023`, `2023年3月15日`), as are
  accounting negatives like `(1,234)`, elapsed times such as `25:30` or
  `100:00:30`, which are read as durations, and the error spellings `#N/A`,
  `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#NUM!` and `#NULL!`, which become
  error values (a leading apostrophe keeps them text); in a cell already formatted as a
  fraction, `1/2` is the fraction one half rather than January 2, and a whole
  number typed into a percent cell is that many percent (`5` is 5%, `0.5` is
  50%). Dates are stored as day counts from 30 December 1899
  without Excel's phantom 29 February 1900, as Google Sheets stores them, so
  serials from 1 March 1900 on match Excel's and the few before it are one
  day behind. Typing text suggests a
  matching value from the same column, selected so Enter keeps it. Date cells
  open a calendar on double-click or Alt+Down (Pick a date in the cell menu
  turns any cell into one). F4 cycles
  the `$` anchors of the reference at the caret. Ctrl/Cmd+` shows formulas
  instead of values (on a Mac, Ctrl+` and Ctrl+Space also work, since ⌘+`
  and ⌘+Space belong to the system); Ctrl/Cmd+G goes to a cell, range, or name; Ctrl/Cmd+'
  copies the formula from the cell above as written, its references unshifted
  (Ctrl/Cmd+D fills it down with them shifted); F9 recalculates. Ctrl/Cmd+[ and ]
  highlight a formula's precedents and a cell's dependents (also in the cell
  menu) to see where numbers come from and go, and Evaluate formula (cell
  menu) lists every part of a formula with the value it produces, innermost
  first.
- **Clipboard**: copies go out as tab-separated text and as an HTML table that
  keeps bold, colors, alignment, links, and the conditional-formatting and table
  colors showing on screen in other apps (and formulas and styles in
  another tab of this app). Range copies within the app also carry live
  conditional-format rules, including formatting-only, transposed and repeated
  pastes; values-only and formulas-only leave destination rules intact.
  Tables pasted from Excel, Sheets, or a web page arrive with their basic styling.
- **Find and replace** (Ctrl/Cmd+F; Ctrl+H, or Cmd+Shift+H on a Mac):
  matches in displayed text
  and formulas, highlighted in the grid; match case, entire cell, all sheets
  or only the selected range (one or the other; the range is taken by itself
  when one is selected), regular
  expressions (with `$1` groups in the replacement), replace one or all.
- **Formatting**: font family, bold, italic, underline, strikethrough, font
  size, horizontal and vertical alignment, indent, text rotation (tilted or
  vertical, rows grow to fit), text wrapping as overflow, wrap (with
  automatic row height), or clip, text and fill colors from a palette, a browser color picker, a hex
  field, or recent colors, borders (all, outer, inner, horizontal, vertical,
  or one side) in any color and thin, medium, thick, dashed, dotted, or
  double, merged cells (whole, horizontally, or vertically), a format painter, cell
  style presets (Title, Heading, Total, Input, Good, Bad, Neutral, Note, ...),
  and number formats (automatic, number, currency with a symbol picker (the
  yen and the won without decimals unless you add them),
  accounting, percent, fraction, scientific, date in three styles, time,
  duration, date and time, text) with adjustable decimals and a thousands
  separator toggle, plus custom spreadsheet format codes (`#,##0.0 "kg"`,
  `[h]:mm`, `0.0%;[Red](0.0%)`) with a live preview. A Format cells dialog
  (Ctrl/Cmd+Shift+F, or Ctrl+1 where the browser leaves it free) gathers
  number format, alignment, font, borders, and fill in one place and applies
  only what changed. It keeps one size on every tab; the Number tab says in a
  line what the chosen category does; the Border tab draws its line styles as
  the lines they make, with None, Outline and Inside presets and a diagram of
  the selection whose edges (and the buttons beside them) draw or remove a
  line; the Fill tab offers the theme's colours with their tints and the
  standard fills as palettes beside a large sample. Keyboard shortcuts
  (Ctrl/Cmd+Shift+1/2/3/4/5/6/~ for formats, Ctrl/Cmd+Shift+7 and _ for an
  outline border and no borders, Ctrl/Cmd+\ to clear formatting). Formatting
  more than 50,000 cells at once (Select all on a sheet of many rows) formats
  the cells that hold something and the empty cells up to 100 rows below and
  26 columns right of them, while that block stays under 50,000 cells; the
  other empty cells keep the default format instead of each becoming a stored
  cell that every save and scan would carry. Borders over such a selection follow
  the same rule, except that an outline, or one named side, is drawn on the
  selection's own edges however many rows it spans. A format applied to a whole
  column or row is kept on the line itself, so it holds for the rows the sheet
  has not reached yet: a value typed, pasted or filled into a formatted column
  takes its format wherever it lands, and the column keeps it through inserted,
  deleted and moved lines until Clear formats takes it away.
- **Cell styles**: a gallery of built-in styles (Title, Heading, Total,
  Input, Good, Bad, Note and the rest), themed accent styles, and the
  workbook's own named styles. New Cell Style… makes one by example from the
  active cell; the Style dialog names it and chooses which parts of a format
  it holds (number, alignment, font, border, fill, protection), each shown
  with a summary, and Format… edits it in the Format Cells dialog. Applying a
  style changes only the parts it holds. Right-click a style (or press the menu
  key on it) to modify, duplicate or delete it; modifying a style reformats
  every cell that uses it, in one undo step, and a built-in style can be
  modified for one workbook and reset later. Merge Styles… copies the styles of
  another spreadsheet (from the Spreadsheets folder, Puter, or this device) and
  asks before replacing same-named ones. Named styles travel in .xlsx files as
  the file's own cell styles, with cells linked to them.
- **Conditional formatting**: highlight cells that are greater or less than,
  between, equal, contain, begin or end with text, are empty, are duplicates
  or unique, are in the top or bottom N, hold a date that is today, yesterday,
  in the last 7 days, this week, this month, in the past, and so on, or
  satisfy a custom formula
  (`=$C2>$B2`), paint a two- or three-color scale, draw data bars, mark
  values with an icon set (arrows, traffic lights, flags, stars, or checks at
  adjustable thresholds, beside or instead of the value), or band rows in
  alternating colors with a header (one click from the cell menu).
  Icon thresholds remain accurate when finite endpoints have a span larger
  than the numeric range, including mixed positive and negative values.
- **Data validation**: dropdown lists (literal values or a range, whose options
  read as the source cells show them, dates as dates and amounts with their
  symbol; shown as plain text or as colored chips with a fill of your choice per option), number
  ranges, text length, dates, custom formulas that see the value being
  typed, and checkbox cells, with strict rejection or an invalid marker, and
  an input message that appears beside the cell while it is selected.
  Insert checkbox and Insert dropdown are one click away in the cell menu.
- **Tables**: turn a range into a named table (Create table in the cell
  menu) with a styled header row, banded rows in one of seven colors, filter
  buttons, and an optional totals row of `SUBTOTAL` formulas. Formulas can
  use structured references the way Excel writes them: `Sales[Amount]`,
  `[@Qty]*[@Price]` for the same row, `Sales[[#Headers],[Price]]`,
  `Sales[#All]`, `Sales[[Qty]:[Price]]`, and the tables of an Excel file open
  as tables, so its structured references keep working. Legacy non-array calculated
  columns retain implicit row intersections in scalar calculations while aggregates
  keep their column ranges. Typing, pasting, or filling that reaches past a
  table's last row extends it, whether it starts on that row or below it (as does Tab from its last cell,
  or dragging the corner handle), a formula typed into an empty column fills the whole
  column and carries into rows added later (a calculated column) — including the empty column beside the
  table, which the formula draws into it — charts,
  conditional formats, and validation rules that end at the table's last
  row grow with it, renaming
  a table or a column header rewrites every formula that used the old name, and converting back to a range turns the
  references into plain cell addresses (which is also how they are written
  into the `.xlsx` for other programs, with the originals kept in the meta
  sheet). The name box lists tables and jumps to one (`Sales`, or
  `Sales[Amount]` for a column), and a chart's range or a dropdown's list
  source can name a table or a table column, so both keep up as it grows.
- **Data tools**: filters with per-column value menus, search, sort, fill
  color, conditions (greater than, between, contains, begins with, empty,
  ...), and a custom formula written for the first data row (`=B2*C2>10`);
  a multi-key Sort dialog with header detection, text in dictionary order
  (accented letters beside their base letters), case-sensitive ordering,
  sorting by fill color (rows with a color on top or at the bottom), and
  sorting columns left to right as well as rows; subtotals (a `SUBTOTAL`
  row under each run of a column's values and a grand total, with the detail
  rows grouped to collapse, removable again in one click); randomize the order of the
  selected rows; remove duplicate rows (choosing which columns must match)
  or empty rows;
  split text to columns on a detected or chosen separator, or with Text to
  Columns (Data menu and ribbon): any mix of separators with repeated ones
  counted once and a choice of text qualifier, or fixed widths picked on a
  clickable ruler, a live preview where each column is read as values, kept
  as typed text or skipped, and a destination cell; trim whitespace,
  change case, and convert text to numbers; and pivot tables that summarize
  a range by rows, columns, and Sum, Count, Average, Max, or Min onto a new
  sheet as live `SUMIFS`/`COUNTIFS` formulas (over a table, they name its
  columns and follow it as it grows), with an optional filter field whose
  value sits in a dropdown cell above the table — pick a value, or "(All)",
  and the whole table re-filters; Goal seek, which finds the
  input value that makes a formula reach a wanted result; and Column stats,
  a profile of a column (counts, sum, average, median, spread, the most
  frequent values, and a distribution).
- **Solver** (Data ▸ Analyze, the Data menu, or the palette): make a formula
  cell as large or as small as it can be, or equal to a value, by changing
  variable cells (several ranges) subject to constraints (`<=`, `=`, `>=`,
  whole numbers, 0/1 and all different), with three methods: Simplex LP
  for linear models (a bounded two-phase simplex that cannot cycle, with a
  check that the model really is linear), GRG Nonlinear for smooth models
  (gradients measured through the sheet's own recalculation, optionally from
  many starting points) and Evolutionary for models built on IF, lookups or
  rounding; integer constraints go through branch and bound. Options cover
  precision, scaling, time and iteration limits, integer optimality,
  convergence, derivatives, population, mutation rate and a random seed. The
  solve runs in the background with a Stop button; the result can be kept
  or the original values restored, saved as a scenario, and reported on new
  sheets (Answer; Sensitivity with reduced costs, shadow prices and allowable
  ranges, or reduced gradients and Lagrange multipliers; Limits). Keeping a
  solution is one undo step. The model is saved with the sheet in hidden
  defined names, so it travels in .xlsx files, follows inserted rows and
  columns, and can also be saved to and loaded from a range of cells.
- **Data Analysis** (Data ▸ Analyze): a list of statistical tools, each
  with its own dialog — Anova (single factor, two-factor with and without
  replication), Correlation, Covariance, Descriptive Statistics (with a
  confidence level and kth largest and smallest), Exponential Smoothing,
  F-Test for variances, Fourier Analysis, Histogram (with Pareto order,
  cumulative percentage and a chart), Moving Average, Random Number
  Generation (uniform, normal, Bernoulli, binomial, Poisson, patterned and
  discrete, with a seed), Rank and Percentile, Regression (multiple X
  columns, residuals, standardized residuals, residual, line fit and normal
  probability plots, a chosen confidence level, constant zero), Sampling,
  t-Tests (paired, equal and unequal variances) and a two-sample z-Test.
  Inputs grouped by columns or rows with optional labels are checked with
  clear messages; results (and their charts) go to a range, a new sheet or a
  new spreadsheet as one undo step, computed with the same statistics as the
  sheet functions (`LINEST`, `T.DIST`, `F.DIST`…).
- **Data form** (Data → Form, or Data → Data Tools → Form): a list or table
  one record at a time, its header row naming the fields and calculated
  columns shown read-only. Step through records with the slider, the arrow
  keys or Page Up/Down; edits are written when you move on (one undo step per
  record) and Restore puts the record back; New adds a record under the list
  (growing a table, carrying a plain list's formulas down), Delete removes one
  after asking, and Criteria finds records by field (`>100`, `<>0`, `=Smith`,
  text that begins with what you type, `*` and `?` wildcards) with Find Prev
  and Find Next.
- **Edit links** (Data → Edit links, or Data → Queries & Connections → Edit
  Links): every link to another workbook with its source file, kind, update
  mode and status. Update Values reads the source again from your Puter drive
  and refreshes the cached cells the formulas read; Change Source points a
  link at another file (picked on the drive), Open Source opens it, Check
  Status looks for every source (and its sheets), and Break Link turns every
  formula that reads a link into its current value, dropping the link and
  renumbering the rest, in one undo step. Startup Prompt chooses whether
  opening the book offers to update its links, updates them, or leaves them
  (kept in the `.xlsx` as the workbook's update-links setting).
- **Layout**: frozen rows and columns (from the menus, or by dragging the
  bars at the corner of the headers), hidden rows and columns, row and
  column groups with an outline gutter (collapse and expand one or all,
  nested, Alt+Shift+Right/Left); Auto Outline builds nested row and column
  groups from the summary formulas (`SUM`, `SUBTOTAL`, `AVERAGE` and the like
  beside the cells they total), Clear Outline removes them, and Outline
  Settings puts summary rows above or below their detail and summary columns
  left or right of it (saved in .xlsx files) and can set summary lines in bold
  automatically (Data → Outline), column and row resizing (drag, double-click to fit,
  or an exact size), zoom from 10% to 400% (presets from the status bar, or
  View ▸ Zoom with 200%, 100%, 75%, 50%, 25%, Fit selection or a percentage of your own),
  optional gridlines, zero values
  that can be hidden per sheet, notes on cells, and colored sheet tabs. The
  row and column headers can be hidden, a focus mode hides the toolbar and
  formula bar, the app can go full screen (all in the View menu), and spelling
  is checked while typing text (never inside formulas; Tools menu).
- **Page breaks**: Page Layout ▸ Breaks inserts a manual page break above and
  left of the selected cell (whole rows or columns break on their own axis),
  removes the one beside it, or resets them all, each an undo step; the cell
  menu offers the same in Page Break Preview, where manual breaks are solid
  lines and automatic ones dashed, a break drags to another row or column (an
  automatic one dragged becomes manual, one dragged off the print area goes),
  and the print area's edges drag to resize it. Printing and PDF start a new
  page at every manual break (fit-to-pages settings decide the axis they
  fit), breaks follow rows and columns as they are inserted, deleted or moved,
  and they are saved as the worksheet's native row and column breaks. View ▸
  Page Breaks (or a print preview) shows them in Normal view as dashed lines.
- **Sheet background**: Page Layout ▸ Background tiles a picture behind the
  cells on screen (a cell's fill covers it, and it never prints); Delete
  Background takes it away. It is kept as the worksheet's native background
  picture.
- **Custom Views**: View ▸ Custom Views keeps the workbook's present view
  under a name, with or without its page setup and its hidden rows, columns
  and filters, and Show brings it back: each sheet's zoom, selection, scroll
  position, frozen panes or split, Normal, Page Layout or Page Break Preview,
  gridlines, headings and zeros, which sheets are hidden, and the sheet in
  front, with the edits among those one undo step. Views are saved in the
  file as native custom workbook and sheet views.
- **Sheet views**: View ▸ Sheet View ▸ New starts a temporary view of the
  sheet in which you filter for yourself while everyone else keeps the
  default view (the headings take a tint and the sheet tab an eye); Keep
  names it so it stays with the workbook, Exit goes back to the default
  view, the Sheet View menu switches between the sheet's views, and Options
  renames, duplicates or deletes them. Files and drafts always hold the
  default view's filters with the named views beside them, the view you are
  in is remembered on this device for that file, and sorting (which moves
  the rows themselves) still applies to everyone.
- **SmartArt graphics**: Insert ▸ Illustrations ▸ SmartArt opens a gallery of
  37 diagram layouts in seven categories (list, process, cycle, hierarchy,
  relationship, matrix and pyramid: block and bullet lists, steps, chevrons,
  a timeline, cycles, hub and spokes, organization charts and trees,
  overlapping circles, a target, a balance, an equation, quadrants and
  pyramids), each shown drawn by the same engine that draws the diagram. A
  diagram is an outline: the Text Pane beside the sheet edits it as a
  bulleted list (Enter adds an item, Tab and Shift+Tab demote and promote it,
  Alt+Shift+Up/Down moves it, Backspace joins lines, several pasted lines
  become several items), and the layout works out every shape, connector and
  text size again from it, fitting like shapes to one size and following the
  diagram's resizing; with a range of cells selected, a new diagram takes its
  outline from them. The SmartArt Design tab adds shapes after, before, above
  or below the one picked, promotes, demotes and moves it, turns the diagram
  Right to Left, switches to another layout keeping the text, and offers 31
  colour schemes and six styles drawn from the workbook's theme (so a new
  theme recolours every diagram), Reset Graphic and Convert to Shapes (a group
  of ordinary shapes and text boxes). The Format tab gives a shape picked in
  the diagram its own fill, outline and text colour, makes it larger or
  smaller, or changes it to another shape. Every change is one undo step
  (typing in one item undoes together); diagrams arrange, group, print and
  export to PDF like other objects, read their text out as alt text unless
  given their own, sync between people editing together, and are saved in an
  `.xlsx` as a group of ordinary shapes any spreadsheet program shows, with
  the diagram kept for this app to edit again. A diagram another program
  saved opens with the shapes that program drew, its outline in the Text Pane,
  and is redrawn with the nearest layout once changed.
- **Arranging objects**: charts, pictures, shapes, text boxes, WordArt,
  slicers, timelines and controls stack in an order of their own. Page
  Layout ▸ Arrange (and a chart's Format tab, and the object menu) brings
  them forward or to the front, sends them backward or to the back, aligns
  them left, centre, right, top, middle or bottom, distributes three or more
  evenly, groups, ungroups and regroups them (a group moves, orders and
  aligns as one, and is saved as a native group), and rotates or flips
  pictures, shapes and text boxes by quarter turns; Snap to Grid and Snap to
  Shape line up objects as they are dragged (Alt places one freely).
  Shift- or Cmd/Ctrl-click selects several objects, which then drag, nudge
  with the arrow keys and delete together. The Selection Pane lists every
  object on the sheet, front first and groups with their members, with an
  eye to hide or show each (Show All, Hide All), a double-click or F2 to
  rename one, and rows that drag to restack; hidden objects do not print,
  and names, hidden state and order travel in the `.xlsx`.
- **Multiple sheets**: add, rename, duplicate, reorder, color, hide, protect,
  and delete sheets from the tab bar, the Insert menu's Sheet submenu, or the
  palette, or copy one to another spreadsheet (a
  new file named after the sheet, or one already in `Spreadsheets/`, which
  gets the sheet after its own); Ctrl/Cmd+PgUp/PgDn or Alt+Up/Down
  (Option+Up/Down on a Mac) switch sheets, the
  mouse wheel scrolls the tab strip when the tabs overflow it, and a focused
  tab answers the arrow keys, Home and End, F2 to rename it, and Shift+F10 or
  the Menu key to open its menu.
  Renaming a sheet rewrites the references that point at it, and deleting
  one turns them into `#REF!` references (a defined name that
  pointed at the sheet stays listed and reads `#REF!`; only names scoped to
  the sheet go with it). A protected
  sheet refuses changes with a notice until it is unprotected, and protected
  ranges (with a description of why) do the same for a few cells on an
  otherwise open sheet; a row, column or block of cells inserted or moved
  inside such a range is refused too, as deleting one out of it is, so a
  protected block cannot be broken up by a line nobody may then fill (an
  insertion that only moves the whole range still goes through).
  Protecting a sheet is an undo step of its own, as the
  gridlines and zero-value switches are, so Ctrl/Cmd+Z after one takes back
  that setting and not the edit before it.
- **Grouped sheets**: Shift-click a sheet tab to group every sheet from the
  one in view to it, Ctrl-click (⌘-click on a Mac) to add or drop one sheet,
  or right-click a tab → Select All Sheets. The title shows **[Group]**, and
  what you type, format, clear, fill or paste, the rows and columns you insert
  or delete, and the column widths and row heights you set land on the same
  cells of every grouped sheet, as one undo step (each sheet keeps its own
  formatting when only values are typed). Edit → Fill → Across Worksheets
  copies the selection to the other grouped sheets (all, contents only, or
  formats only); Hide and Delete act on the whole group. Commands that belong
  to one sheet (tables, charts, sorting, filters, conditional formatting,
  validation, notes, freezing) are greyed out and say why until the sheets are
  ungrouped, by clicking a tab outside the group or with Ungroup Sheets.
- **AutoCorrect** (Tools → AutoCorrect Options, or Review → Proofing): as a
  word ends in a cell or the formula bar (never in a formula), listed text is
  replaced — (c) → ©, (tm) → ™, -- → –, -> → →, and common typos such as
  teh → the, keeping the case it was typed in — TWo INitial CApitals and
  words typed with caps lock on are fixed, days get a capital, and so does
  the first word after a full stop (abbreviations such as e.g. and etc. are
  exceptions you can edit, and the first word of a cell is left as typed).
  Ctrl/Cmd+Z straight after a correction puts the word back; a last word
  corrected as the entry is committed is an undo step of its own. The list,
  the exceptions and an optional `\alpha` → α math-symbols rule are kept for
  your account.
- **Spelling, thesaurus and translation** (Review → Proofing and Language, or
  the Tools menu): F7 checks the text cells of the selection, or of the whole
  sheet from the active cell round to it, against English word lists from
  SCOWL (American or British, loaded the first time they are needed). Each
  word not in the dictionary is shown in its sentence with the nearest
  suggestions, to Change or Change All (one undo step), Ignore Once or Ignore
  All, Add to Dictionary (your own dictionary, kept for your account and
  editable), or add to AutoCorrect; words in capitals, words with digits and
  web, email and file addresses are skipped unless you say otherwise.
  Shift+F7 opens the Thesaurus pane on the active cell's word: its meanings
  with synonyms and antonyms from Puter's AI, a click to look any of them up,
  and Insert to put one in place of the word. The Translator pane translates
  typed text or the selected cells (as `TRANSLATE()` does) and puts the result
  in the active cell or back into the cells it came from, in one step.
- **Templates**: start from a monthly budget, an expense tracker with a
  donut chart, an invoice, a to-do list with checkboxes and priorities (the
  last three built on tables), a
  loan calculator with an amortization schedule, a grade book, a weekly
  schedule, a project timeline drawn with conditional formatting, a monthly
  calendar, or a habit tracker, each with live formulas and blue input cells.
- **Files**: every document is an `.xlsx` in `Spreadsheets/` on your Puter
  drive, autosaved a moment after each change; if the file was written from
  elsewhere in the meantime (another device or tab), you are asked whether to
  overwrite it or reload theirs (a file merely renamed or moved elsewhere, its
  contents unchanged, is not taken for one that changed). Document details (File menu) lists the
  file's location, size, last save, and per-sheet counts. Open `.xlsx`, `.xls`, `.csv`
  (comma, semicolon, tab, or pipe separated, detected, or named by a leading
  `sep=;` line as Excel reads it), `.tsv`, and `.ods`
  files from your device (or drop one anywhere on the app, over a dialog
  included) or from Puter (delimited text opens with its columns fitted to the
  data); a file is read by its bytes, so comma-separated text saved as
  `.xlsx` opens as text and a workbook named `.csv` as the workbook it is,
  while a `.csv`, `.tsv` or `.txt` that is not a workbook is delimited text
  whatever its first cell says (`ID;Preis`, `<table`, `<?xml`).
  Import a file into the open spreadsheet — as new sheets, in place of the current sheet, appended
  below its rows, or starting at the selected cell; download or export as `.xlsx`, `.ods`, `.csv`, and `.tsv` (a sheet, a
  selection, or a table), as a web page (an `.html` table keeping the
  formatting), or save as PDF;
  print the sheet, a selection, or every sheet (the browser's own Print
  command prints the sheet too, not the app), portrait or landscape, on
  Letter, A4, Legal, A3, or Tabloid paper with narrow, normal, or wide
  margins, fit to the page width (a sheet wider than the page is scaled
  down, text and all, rather than cut short), at actual size, or at a chosen percentage,
  or fit to a chosen number of pages wide and tall. Imported XLSX print
  areas, paper orientation, scale, fit settings, exact margins, centering,
  gridlines, and header/footer text are retained in native XLSX records.
  The print dialog shows the pages as they will print beside its choices
  (paper, orientation, scale, margins, centring, breaks, gridlines, headings,
  title, header and footer), page by page, and follows every change.
  It starts with the sheet's saved page setup and offers
  custom margins and separate pages for nonadjacent print areas,
  with your own header and footer text on every page (`&[Page]`, `&[Pages]`,
  `&[Date]`, `&[Time]`, `&[Tab]`, and `&[File]` fill in the page number and
  count, date, time, sheet, and file name, `&L`/`&C`/`&R` start the left,
  center, and right parts, and the footer reads "Page 1 of 3" unless you
  write your own), optional gridlines, row and column
  headers, frozen rows repeated on every page (in a printed selection too,
  when it starts at them), printing from the first used
  cell (a blank form's fills and borders count as used, though a column or row filled, or ruled with a single border side, to the sheet's edge prints only as far as the data), the pictures of `IMAGE()` cells, the tick boxes of checkbox cells, and charts and images placed over the cells where they sit on screen
  (beside or below the data too); conditional formatting
  and table styling print as they show on screen. The home list sorts by last
  modified, name, or size, searches the names without their extensions, keeps
  its "2 min ago" times current, and files opened from elsewhere on the drive are
  kept in a "Recently opened" strip on this device. Inside the Puter desktop the app registers for
  "Open with" so double-clicking a spreadsheet opens it here.
- **Regional formats**: pick how numbers and dates are written and read
  (account menu): `1.234,50` and `28.8.2026` in German, day-first dates in
  British English, and so on. Typed values, the general format, custom
  format codes (month and weekday names included, unless a `[$-407]`-style
  locale tag in the code names another language), CSV export
  (`;`-separated where the decimal mark is a comma), `NUMBERVALUE`
  without separators of its own, `FIXED` and `DOLLAR`, and the text that
  `VALUE` or a criterion such as `">1.500"` reads as a number all follow;
  formulas keep a period for decimals. The Currency and Accounting formats take the
  regional format's own currency on a cell that has none (pounds in British
  English, euros in German, yen in Japanese), the number-format menu's
  samples and Format cells' date styles show each format the way the sheet would, and an amount written the way any
  regional format shows it (`US$1,234.50`, `1 234,50 kr`, `1.234,50 €`,
  `USD 1,234.50`) reads back as that currency when typed, pasted or imported.
  A Currency cell exports and copies with its label on the side of the digits the
  regional format puts it (`#,##0.00 €` under Deutsch, `"$"#,##0.00` under English
  (United States)), and a written-out or long date with that format's own order and
  language tag (`[$-809]d mmm yyyy` under English (United Kingdom)), so the sheet
  opens in Excel the way it reads here.
  Formulas whose results are written in the regional format (`TEXT`, `DOLLAR`,
  `FIXED`) are recalculated when it changes, as F9 recalculates them.
- **Design**: grouped Home, Insert, Page Layout, Formulas, Data, Review, View and
  Automate ribbon tabs reuse the existing commands and formatting controls. Arrow keys
  navigate tabs; Down enters a group, and double-clicking a tab collapses the
  ribbon. Overflow controls keep commands reachable in narrow windows.
  Unsupported ribbon features are disabled. The original menus remain available.
  A formula bar keeps Apply/Cancel beside the name box, and a status-bar slider
  changes worksheet zoom. The formula bar
  expands to several lines for long formulas (Alt+Enter adds a line), sheet
  tabs, and a status bar that sums the selection (with min and max) and
  explains an error in the active cell; right-click it to choose what it shows,
  each choice listed with its current value, the menu staying open while you switch several. Works on desktop, tablet, and phone
  (tap to select, tap again to edit, long-press for the menu). Light, dark,
  and system themes, applied before first paint. Dark mode changes the app
  controls while the spreadsheet keeps its white paper background and colors.
- **Sheet names as you type**: the formula autocomplete lists the other
  sheets beside functions, named ranges, and tables; accepting one inserts
  `Sheet!` (quoted when the name needs it) ready for the cell reference.
- **References across sheets while typing**: with a formula open and a
  reference expected, clicking another sheet's tab (or Ctrl/Cmd+PgUp/PgDn)
  shows that sheet with the edit still alive; clicking or arrowing there
  inserts `Sheet2!B3`-style references, and Enter or Escape returns to the
  cell.
- **Replace formulas with values**: the Formula menu (right-click) or the
  palette freezes the selection's formulas into the values they show,
  spilled array results included, keeping formatting and links; errors are
  left in place.
- **Negative numbers**: Format cells offers negatives as -1,234.50, in red,
  in parentheses, or both for Number and Currency, and any custom format
  code's section colors ([Red], [Blue], …) color the cell text.
- **Image from URL**: Insert → Image from URL fetches a PNG, JPEG, GIF, WebP,
  or SVG through Puter and places it on the sheet like an uploaded picture.
- **Pictures in cells**: Insert ▸ Image ▸ Place in Cell (from your device,
  Puter or a URL) makes a picture the cell's value, fitted inside the cell in
  proportion and aligned by the cell's alignment. It moves, sorts (after the
  values), filters, copies and undoes with its cell; `=A1` shows it, `TYPE`
  answers 128 and `ISNUMBER`/`ISTEXT` say no. Right-click ▸ Edit Alt Text… gives
  it a description (`IMAGE(url, "alt text", sizing)` does the same for a
  formula's picture), and Place over Cells lifts it out to float; a floating
  picture's menu or Picture Format ▸ Place in Cell puts it back into the cell
  under its corner. A pasted picture offers both in its Paste Options. In
  .xlsx they are the standard in-cell rich values (local images with their alt
  text, and `IMAGE()` results from the web as web images), so other programs
  show them too. The accessibility check lists cell pictures with no alt text.
- **Pictures of cells**: Paste Special ▸ Picture pastes a picture of the copied
  range; Paste Special ▸ Linked Picture pastes one that keeps showing those
  cells (values, number formats, fills, fonts, borders, merged cells and cell
  pictures, without gridlines) as they change, follows inserted rows and
  renamed sheets, and shows its reference (`=Sheet1!$A$1:$C$5`) in the formula
  bar, where typing another range retargets it; double-click goes to the
  cells. Saved to .xlsx as a picture of the cells naming its range, so it stays
  linked elsewhere.
- **Picture Format**: a selected picture brings its own tab. Corrections
  (brightness and contrast presets previewed on the picture, or exact values
  in Picture Corrections), Color (grayscale), Transparency, Reset Picture and
  Reset Picture & Size; Picture Styles (white or black frames, a thin border,
  drop shadow, rounded corners, oval); Alt Text; Arrange; and Size: Crop with
  eight handles (drag or arrow keys) and aspect-ratio presets, the picture
  staying where it is on the sheet, plus exact height and width with Lock
  aspect ratio. All of it prints, copies, undoes and round trips through
  .xlsx as DrawingML (brightness/contrast, grayscale, alpha, outline, preset
  shape and shadow).
- **CSV encodings**: imported text files are read as UTF-8 (with or without a
  BOM), as UTF-16 when a byte-order mark says so, and as Windows-1252 when the
  bytes are not valid UTF-8, so accented names survive files from older
  Windows programs.
- **Import from URL**: File → Import from URL fetches a .csv, .tsv, .xlsx, or
  .ods from a web address through Puter and adds its sheets to the open
  spreadsheet (the format is read from the address or sniffed from the bytes).
- **Editing together**: Share → Start editing together lets several people
  work in one spreadsheet at once. Everyone sees the others' edits within a
  second or two (cell values and formulas, formatting, inserted, deleted and
  moved rows and columns, added, renamed, moved and deleted sheets, settings)
  without overwriting each other: changes go through one ordered log, and a
  formula typed while someone inserted rows above it is rewritten as the
  workbook rewrites its own. Each person's initials sit beside Share (a click
  goes to where they are), their selection is outlined on the grid in their
  colour with their name, and the sheet tabs show who is on which sheet. The
  owner hands out invitation links that let people edit or only view (enforced
  by the owner's own collaboration server, a Puter Worker, not only by the
  interface), invites people by username, changes or removes access, and can
  stop at any time. Undo takes back only your own changes, and leaves alone
  what others changed since. Edits made offline wait on the device (through
  a reload too) and merge when the connection returns; the status says Live,
  Syncing or Offline with what is waiting. The .xlsx file stays the copy the
  owner keeps: it is written back as people work, so it opens anywhere. See
  [docs/collaboration.md](docs/collaboration.md).
- **Send by email**: File → Share → Send a copy emails the workbook as it is
  now to up to 20 addresses, with a subject and a message, from the signed-in
  user (replies go to them): as an .xlsx, as a PDF of the whole workbook, the
  sheet or the selection (built in the app, laid out on each sheet's paper and
  orientation, scaled to the page width or split across pages), or the sheet
  or selection as .csv. The copy leaves out Show Changes' record of earlier
  cell values, as every download does. Send a link shares the file with each
  address (Can view or Can edit; someone without a Puter account is invited)
  and emails them a link that opens it; the owner of a live workbook sends an
  invitation into it. The Share dialog offers Email a link too. Addresses are
  checked as they are typed, attachments are capped at 7 MB, the dialog shows
  what is attached and how large it is, and after a partial failure it keeps
  just the addresses that were not reached. Mail goes through the app's own
  email worker (`src/workers/email-worker.js`, adapted from the Calendar
  app's), called with the user's Puter session and billed to them; it
  composes every message itself, accepts only workbook attachments it
  recognizes and links to the app, sends each person a message of their own,
  and caps how much one user can send a day. No credential is ever put in a
  request.
- **Threaded comments with @mentions**: typing @ in a comment or reply lists
  the people who can be mentioned (the members of a live workbook, the people
  the file is shared with, the workbook's other commenters), narrowed as you
  type; a Puter username or an email address can be typed in full. A posted
  comment keeps whom it mentions, shows them highlighted, and carries them in
  .xlsx threaded comments (each comment's mentions list against the
  workbook's people). Anyone mentioned who cannot open the workbook is offered
  a share first (Can view or Can edit), then each is emailed the comment, its
  cell and a link that opens the workbook at that cell (a Puter user known by
  username at their Puter mailbox). Whoever has the workbook open sees a
  mention of them as it arrives, and on opening it the mentions they have not
  seen yet, with a button that goes to the comment. A comment that mentions
  someone can also assign its thread to them: the card says who it is
  assigned to, resolving the thread marks it done, and the person is told it
  is theirs (the assignment travels in the app's own file and live
  workbooks, not in .xlsx).
- **Version history**: File → Version history lists snapshots of the file
  kept under `Spreadsheets/.versions/<name> ~<file id>/` — one is written on
  its own about every 10 minutes of saving, and any can be saved by hand with a
  label. Restore brings a snapshot back (the current state is kept as a
  version first); unlabeled snapshots beyond 30 are pruned, labeled ones stay.
  The history belongs to the file, not to its name: renaming or moving it,
  in the app or on the Puter desktop, keeps the history with it, and the next
  snapshot brings the folder back to the name in use. A history left behind by
  a file deleted or renamed outside the app before it was kept that way is set
  aside, its snapshots kept, when another file takes that name, so no file
  lists or restores a stranger's snapshots.
- **Show Changes**: Review → Show Changes (also File → Show changes, and
  Show Changes on the cell menu for the selected cells) opens a pane listing
  the recent edits newest first: who made each one (the signed-in Puter
  user), when, where, and what the cell held before and after, formulas shown
  as formulas. A paste or fill is one card that opens onto the cells it
  changed; rows and sheets inserted or deleted, and undo and redo, are listed
  by name. A click selects the cells. The list narrows to the sheet shown and
  to the selection or a typed range, and older edits load on demand. The
  record keeps the last 1,000 edits (up to 100 cells listed each) and travels
  with the file in the app's own sidecar part and in drafts, but not in a
  downloaded or exported copy, so what cells used to say stays with the file
  on your drive; it is not part of undo, and Clear empties it after asking.
  In a shared workbook each person's edits are listed under their own name.
  The pane links on to Version history.
- **Nothing lost**: unsaved edits are also copied to the browser's local
  storage moments after they are made. If a tab closes while offline or a
  save fails, opening the file again offers to restore those changes (or
  discard them and keep the file as it is); when the file was saved since,
  what it holds is kept as a version before the older edits replace it. A
  draft the file already holds is dropped quietly. Edits made while that offer waits are kept beside it, and
  when a later open finds both — under the file's own name, or under one a
  rename elsewhere gave it — the later edits are offered and the earlier
  draft moves to the home screen's **Unsaved spreadsheets** list, so neither is
  lost. The status pill says when a book is too large for the
  browser to keep a copy of. A file renamed elsewhere while it is open is
  followed to its new name, and one deleted elsewhere asks whether to save
  it as a new file, put it back, or keep editing. A file changed elsewhere
  asks whose version wins, a save made in the very second this tab last saw
  the file included: modification times are whole seconds, so the file itself
  is read back before such a save is overwritten. Leaving the editor with
  that undecided is not
  refused: the leave dialog offers to go, with the edits kept on this
  device and offered again on the next open.
  Spreadsheets that never completed their first cloud save can be recovered
  from the home screen's **Unsaved spreadsheets** list, including while offline,
  and so can the edits kept for a file deleted since — also when another
  spreadsheet has been saved under its name meanwhile, which neither takes
  those edits for its own nor writes over them.
  Local drafts, print settings, and recently opened file lists are scoped to the signed-in
  Puter account. Older, unscoped browser records are retained but are not
  automatically offered to an account because their owner cannot be verified.
- **Copy several ranges**: ranges added with Ctrl/Cmd+click copy together
  when they line up — the same rows side by side, or the same columns one
  under another — and paste as one block.
- **Copy what you see**: copying or cutting a range that spans hidden or
  filtered-out rows (or hidden columns) takes only the visible cells, so a
  filtered list pastes as the rows on screen.
- **Menu bar**: File, Edit, View, Insert, Format, Data, Tools, and Help sit
  under the document title, above the toolbar, and hold every action with its
  shortcut (submenus for paste special, freeze, group, number formats,
  alignment, borders, cell styles, and the like). Hovering another title while
  a menu is open switches to it, Left and Right arrows do the same, and toggles
  such as gridlines or bold show their current state.
- **Search the menus**: Ctrl/Cmd+Shift+P (or Alt+/, or the search button in
  the top bar) opens a command palette listing every action by name with its
  shortcut: type a few letters ("freeze", "pivot", "currency"), arrow to the
  one you mean, Enter runs it. Opened with nothing typed, the actions you used
  last come first.
- **Options** (File → Options, Tools → Options, the account menu, or
  Ctrl/Cmd+,): one dialog with a search box over its sections that finds any
  option by a word of its name. General: theme, regional format, whether the
  app opens on the start screen, and the font, size, sheet count and view a new
  workbook starts with, and the name written on your comments and changes
  (your Puter account's unless you choose another). Formulas: this workbook's
  calculation mode and iterative calculation (saved with the workbook, and
  labelled as such), how new workbooks calculate, and the error checking rules.
  Editing: where Enter moves (down, right, up, left, or nowhere), a fixed
  decimal point, editing in the cell or the formula bar, AutoComplete, Flash
  Fill offered as you type, carrying a list's formats and formulas onto a new
  row, how two-digit years are read, the fill handle and dragging cells, a
  warning before a drag replaces data, the Paste and Auto Fill Options buttons,
  and a warning before a command changes very many cells. View: formula bar,
  status bar, sheet tabs, scroll bars, headers on new sheets, comment and note
  indicators (with hover, without, or none) and showing or hiding all objects.
  Proofing (AutoCorrect, spelling), Save (AutoSave by default, how soon unsaved
  edits are copied into the browser), Accessibility (a stronger selection,
  reduced motion) and Privacy (AI features on or off). Changes apply at once and
  follow your Puter account to other devices.
- **Quick Access Toolbar**: the row beside the title holds AutoSave, Save, Undo
  and Redo, and any other command: right-click a ribbon button → Add to Quick
  Access Toolbar, tick common commands in the toolbar's own arrow menu, or pick
  from every command in File → Options → Quick Access Toolbar, where they can
  be reordered. It can sit below the ribbon and show command names, and is kept
  for your account.
- **Customize the ribbon** (File → Options → Customize Ribbon, or right-click
  the ribbon): show or hide tabs, rename and reorder them, and build tabs and
  groups of your own holding any commands, on your own tabs or the built-in
  ones; Restore Defaults puts the ribbon back.
- **Keyboard shortcuts of your own** (File → Options → Keyboard Shortcuts):
  every command with the keys that run it, searchable by name or keys. Press a
  new combination to give a command a shortcut; the dialog says which command
  it would be taken from and refuses chords the browser or typing needs. Built-in
  shortcuts can be turned off or moved, and the menus, the palette and the
  ribbon's tooltips show the keys in force.
- **Accessibility**: the grid is a real `role="grid"` with the active cell
  exposed through `aria-activedescendant`, every selection change is
  announced through a live region, menus and dialogs trap focus and close on
  Escape (which also dismisses a notice at the foot of the screen, as does the
  close button of one that offers an action), the home list marks itself busy
  while it loads and then says how many spreadsheets it found or what a search
  matched, a sign-in that is waiting on Puter says so in a line of its own,
  toolbar buttons expose pressed
  state and have 44px touch targets (as do a notice's Undo and Dismiss; the
  smaller controls of the bars, such as
  the menu titles, the sheet tab's options button and the zoom controls, get
  40px touch zones too),
  the screen shown while a spreadsheet is opened or a file imported says what
  it is waiting for through a live region rather than a spinner alone,
  reduced motion is respected, colors meet WCAG contrast in both themes (a
  chart's series take the theme's own palette, keep it in Windows High
  Contrast, where they are the picture, and print on white paper whatever the
  screen theme).

## How it is built

```
src/
  core/               pure logic, no DOM
    cell.js           A1 notation
    refs.js           reference parsing and rewriting (copy, insert, delete, rename)
    formula/          tokenizer, parser, evaluator, the function library, and
                      LAMBDA values (lambda.js)
    format.js         input parsing, display formatting, named number formats
    numfmt.js         spreadsheet number format codes (custom formats, TEXT())
    workbook.js       the document model: sheets, cells, lazy evaluation, undo,
                      spilled arrays, merges, notes, names, filters, rules,
                      validations, charts and images, links, groups, protection,
                      moving and reordering
    charts.js         chart model and the data read from a range
    chart-special.js  hierarchies, box statistics, stock columns and surface bands for charts
    tables.js         tables and structured references (Table1[Column])
    subtotal.js       subtotal rows and their outline groups
    auto-outline.js   Auto Outline, Clear Outline and outline styles from summary formulas
    custom-cell-styles.js  the workbook's named cell styles: parts, applying, merging
    importrange.js    IMPORTRANGE, IMPORTDATA, IMPORTHTML, IMPORTXML helpers
    formula/query.js  the QUERY language: parser and executor
    aiformula.js      prompts for the AI formula helper and reading formulas from replies
    change-history.js the record of recent edits behind Show Changes
    pivot.js          pivot tables as live formulas
    clipboard.js      HTML tables for and from the system clipboard
    selection.js      selection and keyboard navigation rules
    search.js         find and replace
    condformat.js     conditional formatting rules
    validation.js     data validation rules
    textfit.js        word wrapping for row auto-fit
    io.js             .xlsx / .csv import and export through SheetJS
    sample.js         the sample budget
    templates.js      the template workbooks (invoice, to-do list, loan, ...)
  lib/
    puter.js          every call to the Puter SDK
    doc.js            the open document: save, autosave, rename, export, drafts, version snapshots
    drafts.js         unsaved edits kept in the browser until the file holds them
    versions.js       version history snapshots under Spreadsheets/.versions
    recent.js         recently opened files (KV), for the home screen
    session.js        sign-in state (nobody, or who) and settings
  ui/                 grid, toolbar, formula bar, sheet tabs, the menu bar
                      (menubar.js), popover menus with submenus (menu.js), the
                      command palette (palette.js), dialogs,
                      chart rendering (chartsvg.js), the color picker, and the
                      fill-series, sort, pivot, validation, and version-history dialogs
  views/              home (file list), editor, gate (SDK error, sign-in for a cloud file)
  vendor/xlsx.mjs     SheetJS Community Edition 0.20.3 (Apache-2.0), vendored
  vendor/words-en.js  English word lists for the spelling checker, from SCOWL
                      (MIT AND BSD; generated by dev/generate-word-lists.py)
```

The grid is virtualized: only the cells in view exist in the DOM, headers
follow the scroll with a transform, and selection, fill preview, formula
reference highlights, and the in-cell editor are overlays inside the same
scrolling canvas.

Evaluation is lazy with a cache that is dropped whole on every change, so
rendering a screen of cells computes exactly what those cells depend on.
Cycles are detected and reported as `#CYCLE!` instead of hanging. Formulas
that can produce an array are found statically from their syntax tree and
settled sheet-wide before any cell is read, so blank cells know which spill
covers them.

### Storage on Puter

| Where | What | Why |
|---|---|---|
| FS `Spreadsheets/<name>.xlsx` | each document, whole | a real file the user owns; opens anywhere |
| `Spreadsheets/.versions/<name> ~<file id>/*.xlsx` | version history snapshots | one per ~10 minutes of saving, 30 unlabeled kept; the id keeps the history with the file through any rename |
| KV `spreadsheet:settings:v1` | theme and regional format (this browser's storage without a session) | tiny, hot, one read at boot |
| FS `Spreadsheets/Scripts/<name>.js` | My Scripts, the user's own scripts | plain files the user can see; usable in any workbook |
| KV `spreadsheet:script-trust:v1:<sha256>` | scripts from files the user has agreed to run | asked once per script, on every device |
| KV `spreadsheet:pref:<name>` | AutoCorrect settings, the custom dictionary, spelling and translation choices (also kept in this browser, per account) | follow the account to another device |

Files are never stored in KV. The XLSX exporter supplements SheetJS Community
Edition with native cell styles (fonts, colors, borders and alignment), blank
formatted cells, row/column defaults, table styles, frozen panes, tab colors,
and sheet views. Row heights use points and column widths use the exported
Normal font, so Excel gets the same geometry. Standard charts keep native
DrawingML series linked to worksheet cells. Images and text boxes also have
native drawing records; imported SVG artwork and complex chart layouts are
rendered as pictures during browser export.

Imported dashboards retain nested charts, linked KPI text, the active sheet,
and sheet zoom. PivotChart plots omit the trailing total when the file's point
count excludes it, and retain overlapping bars and value labels. Embedded
in-cell pictures remain image values through references and lookups and save
as native Excel rich values. Excel data-model pivots remain saved result cells;
refreshing their model or operating Excel slicers is not supported.

A very-hidden sheet named `_puter_meta` keeps JSON for the app's original
style overrides and inheritance, editable chart/image models, conditional
formatting, row/column groups, protection, and other settings. Other apps
ignore this sheet; this app reads it back. From a file another program wrote,
the frozen panes, tab colours, gridlines setting, sheet protection, row and
column groups, default row heights, solid cell fills, borders, alignment, custom table styles, and fonts
(family, bold, italic, underline, strikethrough, size, and colour) are read from
the file itself, including custom indexed color palettes, the sidecar's own record winning where both exist.
Calibri workbooks keep fractional font sizes and compact text spacing, with a
bundled Carlito fallback for systems without Calibri and ChromeOS Caladea for
systems without Cambria. Original font names remain intact in native exports. Tables explicitly styled
as None retain their cell formatting without an added table theme.
Imported sheets retain their native default vertical alignment on blank cells
and new entries, including when sheets with different defaults are combined.
Excel formula
and cell-comparison conditional formats import with their priority, stop rules,
fills and borders, including relative named references used by Gantt schedules.
Text contains, does-not-contain, starts-with and ends-with rules, nonblank-cell rules,
and data bars with numeric or minimum/maximum bounds also import,
including bars that hide their numeric value. All 17 standard three-, four- and
five-icon families import and export natively, with number, percent, percentile
and formula boundaries, exclusive comparisons, reversed order and icon-only
display. Their boundaries remain editable and survive copies and range moves;
the grid and print use shared vector icons. Office extension/custom icon sets
are not supported yet. Other native
conditional-format types are not read yet. Imported rules survive saves through
the app's sidecar. For newly saved files, supported native rule edits, deletions,
additions and priority changes take precedence over stale conditional-format
metadata; unchanged rules keep their editable app settings. Native color-scale
and data-bar thresholds retain lowest/highest value, number, percent and percentile
types through copies and saves, with editable threshold types in the manager.
Partial cuts and range moves carry conditional formats, including visible-cell
selections, and keep dependent conditional formulas linked to moved cells.
The manager accepts comma-separated apply-to areas and edits compatible adjacent
pieces together, including imported multi-area rules.
Unlabelled, unlinked Excel form checkboxes over empty cells
import as editable checkbox cells, retaining their checked state and square
appearance. Linked, labelled, macro-driven and mixed-state form controls are
not converted. These checkboxes survive saves in this app's sidecar rather
than being exported as native Excel form controls. Values, formulas (with cached results; spilled arrays
as legacy array formulas; newer functions carry the `_xlfn.` prefix Excel
expects, and files from Excel have it stripped on the way in), number formats including custom codes, hyperlinks,
column widths, row heights, hidden rows, columns, and sheets, merged cells,
notes (as comments), named ranges, and the autofilter range with its
conditions are all standard
`.xlsx` and round-trip with any spreadsheet program. A formula this app
cannot read (`=1+`, shown as `#ERROR!`) is saved as the text `=1+` under the
cell's own number format rather than as a formula, so Excel opens the file
without a repair prompt; the sidecar carries the formula and this app restores
it on opening (the same goes for `.ods` with its settings block). A formula in
another program's file that reaches into another workbook (`[1]Sheet1!A1`)
keeps the value that file cached, as there is no other workbook to read here,
and is never written back as a formula; the sidecar keeps its text.

When the app runs inside the Puter desktop (`puter.env === 'app'`) the
desktop owns the session, so no sign-out is offered and exports go through
Puter's own save dialog instead of a browser download.

## Analytics

The production page loads Plausible for pageviews and four value events. Create matching
custom event goals under the site's Plausible settings → Goals:

| Event | When it fires | Properties |
| --- | --- | --- |
| `Spreadsheet Edited` | First successful data change in an editor session, including typing, pasting or AI-made changes | None |
| `Spreadsheet Saved` | A cloud write completes, including autosaves and Save a copy | `method`: `manual`, `auto` or `copy` |
| `Spreadsheet Exported` | A browser download starts or Puter's save picker completes, including selection and chart exports | `format`, `method`: `browser` or `puter` |
| `AI Interaction` | A nonempty AI answer arrives; sidebar chats count once after the completed exchange | `feature`; sidebar replies also report whether they `changed` the workbook |

AI features are `assistant`, `formula`, `translate`, `detect-language`, `ask-data`,
`explain-formula` and `generate-formula`. Failed, cancelled, empty or truncated sidebar
replies do not count. An unchanged save does not count. Browser exports measure the download
being started, since the page cannot tell whether the user saved it to disk.

No spreadsheet contents, filenames, paths, prompts, replies or account identifiers are
included in custom event properties. Analytics failures never block app actions.
The development mock and phone harness omit the tracking script. Tests use a stubbed
`plausible` function rather than sending events to the live site.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run build      # production build in dist/
npm run preview    # serve dist/
```

Two dev harnesses (not part of the production build):

- `/mock.html` runs the whole app against an in-memory mock of the Puter SDK
  (`dev/puter-mock.js`), so no Puter account is needed. Add `?env=app` to
  simulate the Puter desktop or `?signedout` to start without a session.
- `/dev/phone.html` shows the mock app in phone- and tablet-sized frames.

In `/mock.html`, editing together runs against a room worker inside the page
(`dev/collab-mock.js`); `window.__collabDemo.addPerson('maria')` adds a
simulated collaborator to the shared workbook that is open, whose `RoomClient`
can then edit and move about. `npm run build:worker` bundles the room worker
into `public/worker/spreadsheet-worker.js` (part of `npm run build`).

Email in `/mock.html` runs the real email worker inside the page
(`dev/email-mock.js`): nothing is sent, and each message it would send is
kept in `window.__mailbox` and logged. Addresses at `bounce.test` fail and
addresses at `optout.test` have opted out. `npm run deploy:email-worker`
deploys the worker as `spreadsheet-email` (done once, by the app owner).

### Tests

`tests/` covers the formula tokenizer, parser, and evaluator, the whole
function library (including dynamic arrays and spilling), reference
rewriting for copy/insert/delete/rename, input parsing, number formatting
and format codes, the workbook model (undo/redo, transactions, structural
edits, moving and reordering, fill, sort, sheets, merges, notes, names,
links, filters, conditional formatting, validation, charts), the rich
clipboard, chart data and SVG output, find and replace, autocomplete
context, `.xlsx` and `.csv` round trips through SheetJS, selection and
keyboard navigation, the document controller against a mocked Puter, the
print table, and the grid's DOM behavior under jsdom.

## Deploying

`dist/` is fully static and built with relative paths, so it can be hosted
anywhere, including Puter's own hosting. The app talks to Puter directly from
the browser; there is no server.

---

Powered by [Puter](https://developer.puter.com).

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
