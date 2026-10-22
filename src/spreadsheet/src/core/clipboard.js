import { rebaseWorkbookTarget } from './workbook-location.js';
import { mapNativeSparklineReferences } from './native-sparklines.js';
import { tokenize } from './formula/tokenizer.js';
import { conditionalFormulaFields, mapConditionalFormulas } from './conditional-scale.js';
import { isRangeSource } from './validation.js';
import { normalizeExternalWorkbooks, rebaseExternalWorkbooks, selectExternalWorkbooks, reindexExternalCell, savedExternalResult } from './external-workbooks.js';
import { conditionalFontStyle } from './style-values.js';
import { createBorderResolver, DISPLAY_BORDER_PRIORITY } from './shared-borders.js';
import { forEachRangeRecordAt } from './range-records.js';
import { readCopiedNativeSparklines } from './native-sparkline-paste.js';
import { VALIDATION_TYPES } from './validation.js';
import { RULE_TYPES } from './condformat.js';
import { normalizeFontColor, fontColorCss } from './font-color.js';
import { normalizeFillColor, fillColorCss } from './fill-color.js';
import { normalizeNativeFill, nativeFillEncoder, nativeFillDecoder, nativeFillOverridesNormal, nativeFillIsNone } from './native-fill.js';
import { normalizeRichText, richFontStyle, RICH_FONT_KEYS } from './rich-text.js';
import { numberFormatParts } from './format-layout.js';
/**
 * Rich clipboard: an HTML table for other apps (and for this app in another
 * tab), read back into cells. The table carries a JSON copy of the cells in
 * a data attribute so a paste between two spreadsheet tabs keeps formulas
 * and styles; tables from Excel, Sheets, or a web page are read from their
 * markup with the basic styling they carry.
 */

import { cellFromInput, safeLinkUrl, textUrl } from './workbook.js';
import { cellLayoutText, CELL_TEXT_INSET } from './textfit.js';
import { MAX_TEXT } from './cell.js';
import { fontStack, fontKeyFor, numFmtToStyle, styleToNumFmt, formatValue, dateTimeKind, borderCss, defaultAlign, layoutAlign, TYPED_ERRORS } from './format.js';
import { MAX_FORMAT_CODE_LENGTH, codeColor, codeLocale, unformatTextWithCode, unformatTimeWithCode } from './numfmt.js';
import { parseDelimited } from './tsv.js';
import { htmlTableRows } from './html-table.js';
import { RTL_LEAD } from './bidi.js';
import { readClipboardStyles } from './clipboard-css.js';
import { clipboardMarkupStamp, hasClipboardSnapshot } from './clipboard-integrity.js';
import { fixedArraySize } from './fixed-arrays.js';
import { prepareOfficeStrings } from './clipboard-html.js';

const MISSING_EXTERNAL_LINKS = 'The copied cells are missing their external workbook links. Copy the cells again.';
function copiedExternalLinksValid(formulas, links) {
  for (const formula of formulas) {
    let tokens; try { tokens = tokenize(formula); } catch { continue; }
    for (const token of tokens) for (const sheet of [token.sheet, token.sheetEnd]) {
      const index = /^\[([1-9]\d*)\]/.exec(sheet || '');
      if (index && !links?.books[Number(index[1]) - 1]) return false;
    }
  }
  return true;
}
const sparklineFormulas = snapshot => (snapshot?.groups || []).flatMap(group => [group.dateFormula, ...group.sparklines.map(s => s.formula)].filter(Boolean));

function copiedFormulas(cells, conditionalFormats, validations, nativeSparklines) {
  const formulas = (cells || []).flatMap(row => row.flatMap(cell => cell?.f == null ? [] : [cell.f]));
  for (const { rule } of conditionalFormats || []) for (const field of conditionalFormulaFields(rule)) formulas.push(rule[field]);
  for (const { rule } of validations || []) if (rule.type === 'formula' || rule.type === 'list' && isRangeSource(rule.source)) formulas.push(rule.source);
  formulas.push(...sparklineFormulas(nativeSparklines));
  return formulas;
}

const MAX_EMBED_CELLS = 5000;
const MAX_CLIPBOARD_CELLS = 200000; // matches the editor's copy limit
const TOO_LARGE = 'This table is too large to paste. Copy at most 200,000 cells.';
// Modern Excel errors are values in Office HTML, but remain ordinary text when
// typed into a cell or pasted without a spreadsheet type hint.
const OFFICE_ERRORS = new Set([...TYPED_ERRORS, '#SPILL!', '#CALC!', '#CONNECT!', '#BLOCKED!', '#UNKNOWN!', '#FIELD!', '#BUSY!', '#GETTING_DATA']);

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const ALIGNS = new Set(['left', 'center', 'right']);
const VERTICAL_ALIGNS = new Set(['top', 'middle', 'bottom']);
const cssNumber = (n, min, max) => (typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : null);
// Excel's 409pt limit in CSS pixels, shared by external HTML read/write.
const MAX_FONT_PIXELS = 409 * 4 / 3;
const ABSOLUTE_LENGTH_PIXELS = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };

/** Absolute CSS font sizes retain fractional pixels; relative units need source context. */
function fontPixels(value) {
  const match = /^\+?(\d*\.?\d+(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q)$/i.exec(value || '');
  if (!match) return null;
  const px = Number(match[1]) * ABSOLUTE_LENGTH_PIXELS[match[2].toLowerCase()];
  return px > 0 ? cssNumber(px, 0, MAX_FONT_PIXELS) : null;
}

/** Character CSS also serves inline runs, which must not acquire cell layout. */
function fontCss(s, clipboard) {
  const out = [];
  if (!s) return out;
  if (Object.hasOwn(s, 'bold')) out.push(`font-weight:${s.bold ? 'bold' : 'normal'}`);
  if (Object.hasOwn(s, 'italic')) out.push(`font-style:${s.italic ? 'italic' : 'normal'}`);
  const deco = [s.underline && s.underline !== 'none' && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco || Object.hasOwn(s, 'underline') || Object.hasOwn(s, 'strike')) out.push(`text-decoration:${deco || 'none'}`);
  if (typeof s.underline === 'string' && s.underline.startsWith('double')) out.push('text-decoration-style:double');
  const ink = fontColorCss(s.color);
  if (ink) out.push(`color:${ink}`);
  const size = cssNumber(s.size, 0, MAX_FONT_PIXELS);
  // Excel for Mac's HTML paste treats px as points and drops weight 600.
  // Physical point units and semantic bold preserve the same CSS appearance
  // while interoperating with both Excel and browser HTML readers.
  if (size) out.push(`font-size:${size * 3 / 4}pt`);
  // Excel can store a fallback from a CSS family list as the cell's font.
  // Transfer the requested family as data; web-page exports keep their stack.
  const family = fontStack(s.font, { fallbacks: !clipboard });
  if (family) out.push(`font-family:${family}`);
  return out;
}

/** Inline CSS for a cell's style. Values come from files and pasted data, so only well-formed ones are written. */
function cellCss(s, value, noWrap, clipboard, indentUnit) {
  // The spreadsheet's default is middle; Excel's is bottom. Carry even the
  // implicit default when copying, so a foreign destination cannot replace it.
  const vertical = VERTICAL_ALIGNS.has(s?.valign) ? s.valign : clipboard ? 'middle' : null;
  const out = vertical ? [`vertical-align:${vertical}`] : [];
  if (!s) return [...out, ...(noWrap ? ['white-space:nowrap'] : [])].join(';');
  out.push(...fontCss(s, clipboard));
  const bg = fillColorCss(s.bg);
  if (HEX_COLOR.test(bg)) {
    out.push(`background-color:${bg}`);
    // Office's explicit white fill must remain distinct from automatic paper
    // when the fragment is pasted into a sheet with colored defaults.
    if (bg === '#ffffff') out.push('mso-pattern:black none');
  }
  else if (s.bg === null || s.bg === 'transparent' || s.nativeFill && nativeFillIsNone(s.nativeFill.xml)) {
    out.push('mso-background-source:auto', 'mso-pattern:auto');
  }
  const indent = cssNumber(s.indent, 1, 250);
  // A web page shows Center Across Selection, Distributed, Justify and Fill at the side the grid draws them at. The
  // clipboard leaves them out: another spreadsheet would read the side as an alignment setting of its own.
  const shown = clipboard ? s.align : layoutAlign(s.align);
  const align = ALIGNS.has(shown) ? shown : indent ? (typeof value === 'string' && RTL_LEAD.test(value) ? 'right' : defaultAlign(value)) : null;
  if (align) out.push(`text-align:${align}`);
  if (indent && align !== 'center') out.push(`padding-${align === 'right' ? 'right' : 'left'}:${indent * indentUnit + CELL_TEXT_INSET}px`, `mso-char-indent-count:${indent}`);
  if (s.wrap) out.push('white-space:pre-wrap');
  // Spreadsheet cells do not wrap by default; HTML cells do. Explicitly
  // carry that default into Excel's fragment-aware table import as well.
  else if (noWrap || s.wrap === false) out.push('white-space:nowrap');
  for (const [key, side] of [['bt', 'top'], ['br', 'right'], ['bb', 'bottom'], ['bl', 'left']]) {
    if (s[key] === undefined) continue;
    const descriptor = s[`${key}Border`] || s;
    const edge = borderCss(descriptor);
    // Excel's HTML border weights are .5/1/1.5pt, not screen CSS widths.
    // In particular, its HTML paste reads 1px as medium (and 2px as thick).
    const width = clipboard ? edge.width === '2px' ? '1pt'
      : edge.width === '3px' ? '1.5pt' : '0.5pt' : edge.width;
    out.push(`border-${side}:${s[key] ? `${width} ${edge.style} ${HEX_COLOR.test(edge.color) ? edge.color : '#000000'}` : 'none'}`);
  }
  return out.join(';');
}

// Per-cell number-format hints stop at this size, like the editor's conditional
// looks. Native type hints remain present so large external pastes retain types.
const MAX_HINT_CELLS = 20000;

/**
 * The number format as Excel writes its own (every symbol escaped, a quote
 * as \0022), so Excel keeps 00123 as text and 2.00 with its decimals; this
 * app reads it back the same way. Empty for General.
 */
function numberFormatCss(s) {
  const code = s?.fmt && s.fmt !== 'general' ? styleToNumFmt(s) : 'General';
  if (code === 'General') return '';
  // Office HTML's number-format encoding uses exactly four hex digits,
  // without a CSS terminator. A following space or hex digit belongs to the code.
  const escaped = code.replace(/[^A-Za-z0-9]/gu, ch => ch === '"' ? '\\0022' : `\\${ch}`);
  return `mso-number-format:"${escaped}"`;
}

/** Excel's typed values require a bound x namespace. Bare x:str reads the
 * character markup; x:str="" is an explicit empty value, not the bare form.
 * An explicit value preserves text omitted/transformed by the visible markup.
 * NUL must be a numeric reference: Excel discards a literal NUL even here.
 * Excel uses one font for that value and discards its character runs. */
function typedAttributes(value, markupText = false) {
  if (typeof value === 'number') return Number.isFinite(value) ? ` x:num="${value}"` : '';
  if (typeof value === 'boolean') return ` x:bool="${value ? 'TRUE' : 'FALSE'}"`;
  if (typeof value === 'string') return markupText ? ' x:str' : ` x:str="${escapeHtml(value).replace(/\0/g, '&#0;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;')}"`;
  return '';
}

// The literal address of a HYPERLINK formula: =HYPERLINK("https://…","Q3 report"). An address worked out
// by a formula cannot be read without the workbook, and such a cell copies as its text alone, as before.
const HYPERLINK_ADDRESS = /^\s*HYPERLINK\s*\(\s*"((?:[^"]|"")*)"/i;

/**
 * The address a copied cell links to, as the grid draws it: a HYPERLINK
 * formula's own address, or text that is a web or mail address. Only what
 * `safeLinkUrl` admits is written out, and a link inside the workbook
 * ("#Sheet!A1") means nothing in another application, so it is left out.
 */
function cellLink(cell) {
  if (!cell) return null;
  let url = null;
  if (typeof cell.hyperlink === 'string' && cell.hyperlink) url = safeLinkUrl(cell.hyperlink);
  else if (typeof cell.f === 'string') {
    const m = HYPERLINK_ADDRESS.exec(cell.f);
    if (!m) return null;
    url = safeLinkUrl(m[1].replace(/""/g, '"'));
  } else if (typeof cell.v === 'string' && !cell.s?.nolink) {
    url = textUrl(cell.v);
  }
  return url && !url.startsWith('#') ? url : null;
}

/** The positions of an ascending list's members within [lo, hi], as [start, end), found by bisection. */
function positionsIn(sorted, lo, hi) {
  let a = 0;
  let b = sorted.length;
  while (a < b) { const m = (a + b) >> 1; if (sorted[m] < lo) a = m + 1; else b = m; }
  let c = a;
  let d = sorted.length;
  while (c < d) { const m = (c + d) >> 1; if (sorted[m] <= hi) c = m + 1; else d = m; }
  return [a, c];
}

/**
 * The merges of a copied block as HTML spans, keyed by "row,column" *within the block*: null for a cell
 * a span covers, { rowSpan, colSpan } for the cell that carries it. `rows` and `cols` are the sheet rows
 * and columns copied, ascending, so a merge spans only what was copied and a merge nothing of which was
 * is left out; one overlapping a span already placed is left out too. Bisection keeps a sheet of
 * thousands of merges from walking every copied line for each of them. Exported for tests.
 */
export function copyMergeSpans(merges, rows, cols) {
  return copyMergeLayout(merges, rows, cols).spans;
}

/** One geometry snapshot serves both native paste ranges and the HTML spans. */
export function copyMergeLayout(merges, rows, cols) {
  const spans = new Map();
  const ranges = [];
  const sources = [];
  let partial = false;
  if (!merges?.length || !rows?.length || !cols?.length) return { spans, ranges, sources, partial };
  for (const merge of merges) {
    const [r0, r1] = positionsIn(rows, merge.r1, merge.r2);
    const [c0, c1] = positionsIn(cols, merge.c1, merge.c2);
    if (r1 - r0 < 1 || c1 - c0 < 1) continue;
    if (r1 - r0 !== merge.r2 - merge.r1 + 1 || c1 - c0 !== merge.c2 - merge.c1 + 1) partial = true;
    if (r1 - r0 === 1 && c1 - c0 === 1) continue;
    let taken = false;
    for (let i = r0; i < r1 && !taken; i++) for (let j = c0; j < c1; j++) if (spans.has(`${i},${j}`)) { taken = true; break; }
    if (taken) continue;
    for (let i = r0; i < r1; i++) for (let j = c0; j < c1; j++) spans.set(`${i},${j}`, null);
    spans.set(`${r0},${c0}`, { rowSpan: r1 - r0, colSpan: c1 - c0 });
    ranges.push({ r1: r0, c1: c0, r2: r1 - 1, c2: c1 - 1 });
    sources.push({ ...merge });
  }
  return { spans, ranges, sources, partial };
}

/**
 * HTML for a block of cells, both rows × cols.
 * texts: displayed strings; cells: the copied cells (styles and formulas, as
 * Workbook.copyRange gives them);
 * values: optional computed values captured at copy time for values-only paste.
 * looks: optional per-cell conditional styling ({ bg, color, bold }) that
 * only shows in the HTML, so other apps see the colors on screen while the
 * embedded cells keep their real styles.
 * In the options: `styles` is the style each cell actually shows in — its
 * column's and row's defaults under its own, as Workbook.styleAt reads them —
 * so a cell in a column formatted as currency arrives in another app with that
 * format; `merges`, with `rows` and `cols` (the sheet lines copied), gives the
 * merged blocks their rowspan and colspan, so a merged title arrives in Word or
 * Excel as one cell rather than a title with empty cells beside it. The
 * `clipboard: false` emits a plain HTML table for a web-page export, leaving
 * unspecified wrapping to the page stylesheet and omitting clipboard boundaries.
 * `colorPalette` supplies the source workbook's indexed number-format colors.
 * Embedded cells retain the full stored rectangle; span geometry is carried
 * separately so private and foreign pastes can preserve the merged layout.
 */
export function cellsToHtml(texts, cells, looks = null, values = null, origin = null, { styles = null, merges = null, rows = null, cols = null, clipboard = true, mergeLayout = null, colorPalette = null, normalFill = null, indentUnit = 12, conditionalFormats = null, validations = null, nativeSparklines = null, externalWorkbooks = null, sourceWorkbook = null } = {}) {
  const total = texts.length * (texts[0]?.length || 0);
  const hints = total <= MAX_HINT_CELLS;
  const spans = mergeLayout?.spans ?? (merges && rows && cols ? copyMergeSpans(merges, rows, cols) : null);
  const appearance = (i, j) => {
    const look = looks?.[i]?.[j];
    const base = styles?.[i]?.[j] || cells?.[i]?.[j]?.s;
    // A table's coat (its band and header colours) lies under a cell's own fill, as on screen; a rule's fill lies over it.
    const fill = look?.bg && !(look.coat && nativeFillOverridesNormal(base, normalFill)) ? { bg: look.bg } : {};
    const style = look ? conditionalFontStyle({ ...(base || {}), ...fill, ...(look.color ? { color: look.color } : {}) }, look) : base;
    if (look) for (const key of ['bt', 'bb', 'bl', 'br']) if (look[key] !== undefined) {
      style[key] = look[key];
      style[`${key}Border`] = look[key] ? look[`${key}Border`] || { bs: look.bs, bc: look.bc } : null;
    }
    return style;
  };
  // CSS collapsed borders compare weight, without Excel's direct/style
  // precedence. Resolve transient PivotTable display edges before emitting
  // public paint; the embedded source cells still retain both original edges.
  const displayBorders = styles?.some(row => row?.some(style => style?.[DISPLAY_BORDER_PRIORITY]));
  const mergedAreas = displayBorders && spans ? [...spans].flatMap(([key, span]) => {
    if (!span) return [];
    const [r, c] = key.split(',').map(Number);
    return [{ range: { r1: r, c1: c, r2: r + span.rowSpan - 1, c2: c + span.colSpan - 1 } }];
  }) : [];
  const borderInputs = (r, c) => ({ style: styles?.[r]?.[c] || cells?.[r]?.[c]?.s,
    conditional: looks?.[r]?.[c]?.coat ? null : looks?.[r]?.[c], table: looks?.[r]?.[c]?.coat ? looks[r][c] : null });
  const resolveBorders = displayBorders ? createBorderResolver({ read: borderInputs,
    neighbor: (r, c, side) => {
      const rr = r + (side === 'bt' ? -1 : side === 'bb' ? 1 : 0), cc = c + (side === 'bl' ? -1 : side === 'br' ? 1 : 0);
      return rr >= 0 && rr < texts.length && cc >= 0 && cc < texts[rr].length ? [rr, cc] : null;
    },
    mergeAt: (r, c) => { let found; forEachRangeRecordAt(mergedAreas, r, c, record => { found = record.range; }); return found; },
  }) : null;
  const paintedAppearance = (r, c) => {
    const style = appearance(r, c);
    if (!resolveBorders) return style;
    const input = borderInputs(r, c), paint = resolveBorders(r, c, input.style, input.conditional, input.table);
    return { ...style, ...Object.fromEntries(['bt', 'bb', 'bl', 'br'].flatMap(side => [[side, !!paint[side]], [`${side}Border`, paint[`${side}Border`] || null]])) };
  };
  const trs = texts.map((row, i) => `<tr>${row.map((text, j) => {
    const span = spans?.get(`${i},${j}`);
    if (span === null) return ''; // a cell the span to its left or above covers
    const look = looks?.[i]?.[j];
    let style = paintedAppearance(i, j);
    if (span) {
      // HTML gives a spanning cell one border per side. A copy from Excel
      // uses the first corner's top/left and the opposite corner's bottom/right,
      // including when perimeter segments differ. Read the copied geometry
      // (hidden lines may have been omitted), without changing the private
      // cells that retain every underlying segment and covered-cell format.
      const corner = paintedAppearance(i + span.rowSpan - 1, j + span.colSpan - 1);
      style = { ...style };
      for (const key of ['bb', 'br']) {
        // A side neither corner states stays unstated, as an unmerged cell's does.
        if (corner?.[key] == null && !style[key]) continue;
        style[key] = !!corner?.[key];
        style[`${key}Border`] = corner?.[key] ? corner[`${key}Border`] || { bs: corner.bs, bc: corner.bc } : null;
      }
    }
    const original = String(text ?? '');
    const shown = cellLayoutText(original, style?.wrap);
    const cell = cells?.[i]?.[j], value = values?.[i]?.[j] ?? cell?.v ?? original;
    const parts = cell?.richText && numberFormatParts(value, { ...style, wrap: true }, cell.richText);
    const rich = parts?.some(part => part.rich) ? parts : null;
    const cssStyle = rich ? { ...style, bold: false, italic: false, underline: false, strike: false } : style;
    const css = [cellCss(cssStyle, value, clipboard || (!style?.wrap && shown !== original), clipboard, indentUnit),
      hints ? numberFormatCss(style) : ''].filter(Boolean).join(';');
    // Excel's typed text attribute retains line endings omitted from the visible
    // unwrapped label. The private payload likewise retains the original value.
    // Type information is semantic data even beyond the optional format-hint
    // budget: large copies must not silently convert text to numbers/formulas.
    // Bare x:str preserves rich character runs while still preventing text
    // such as "0042", "TRUE" or "=1+2" from being reinterpreted. Use it only
    // when the markup spells the exact stored value. HTML control whitespace
    // and custom-format substitutions still need the explicit value path.
    const markupText = rich && typeof value === 'string' && !/[\u0000-\u0009\u000b-\u001f]/.test(value)
      && rich.every(part => part.type === 'text' || part.type === 'break')
      && rich.map(part => part.type === 'break' ? '\n' : part.type === 'text' ? part.text : '').join('') === value;
    const typed = values || shown !== original ? typedAttributes(values ? values[i]?.[j] : cells?.[i]?.[j]?.v ?? original, markupText) : '';
    // Excel's HTML paste reads line breaks from the markup, not x:str's
    // value. Keep LF in a same-cell break; inactive breaks have no browser
    // layout. Excel for Mac may enable wrapping when pasting these breaks.
    const br = style?.wrap ? '<br style="mso-data-placement:same-cell">' : '<br style="display:none;mso-data-placement:same-cell">';
    // Excel's HTML reader collapses literal spaces even with pre-wrap/x:str.
    // Its space-run spans encode significant spaces as NBSP, then restore them
    // as ordinary spaces on paste. Keep a break opportunity inside each line.
    const markup = text => text.replace(/\r/g, '').split('\n').map(line => escapeHtml(line).replace(/ {2,}|^ +| +$/g, (spaces, at, text) => {
      const run = spaces.length > 1 && at + spaces.length < text.length ? '&nbsp;'.repeat(spaces.length - 1) + ' ' : '&nbsp;'.repeat(spaces.length);
      return `<span style="mso-spacerun:yes">${run}</span>`;
    })).join(br);
    let body = rich ? rich.map(part => {
      if (part.type === 'pad') return markup(' ');
      if (part.type === 'fill') return '';
      const s = { ...richFontStyle(style), ...part.s, ...(look?.color ? { color: look.color } : {}) };
      const font = fontCss(s, clipboard);
      const vertical = { superscript: 'super', subscript: 'sub', baseline: 'baseline' }[s.vertAlign];
      if (vertical) font.push(`vertical-align:${vertical}`);
      const css = font.join(';');
      // Excel's fragment-aware HTML reader needs semantic character tags to
      // distinguish weight/style changes. CSS-only runs can become one font.
      let text = part.type === 'break' ? br : markup(part.text);
      if (s.bold) text = `<b>${text}</b>`;
      if (s.italic) text = `<i>${text}</i>`;
      return `<span${css ? ` style="${escapeHtml(css)}"` : ''}>${text}</span>`;
    }).join('') : markup(original);
    // Match Excel's HTML: browsers see the selected format color, while
    // Office keeps the underlying font color and evaluates the format itself.
    const formatColor = !look?.color && style?.fmt === 'custom'
      ? codeColor(values?.[i]?.[j] ?? cells?.[i]?.[j]?.v ?? text, style.code, colorPalette) : null;
    if (formatColor) body = `<font color="${formatColor}" style="mso-ignore:color">${body}</font>`;
    // A linked cell travels as a link, as spreadsheet clipboards write one, so it arrives live in Word,
    // Gmail or Excel; the embedded cells still carry the formula, so a paste back here is unchanged.
    const link = body ? cellLink(cells?.[i]?.[j]) : null;
    const across = span ? `${span.rowSpan > 1 ? ` rowspan="${span.rowSpan}"` : ''}${span.colSpan > 1 ? ` colspan="${span.colSpan}"` : ''}` : '';
    return `<td${across}${typed}${css ? ` style="${escapeHtml(css)}"` : ''}>${link ? `<a href="${escapeHtml(link)}">${body}</a>` : body}</td>`;
  }).join('')}</tr>`).join('');
  // Only serialized formulas need supporting data. Large value-only copies
  // do not carry every external cache in the originating workbook.
  if (externalWorkbooks) {
    const small = total <= MAX_EMBED_CELLS, sparks = total <= MAX_CLIPBOARD_CELLS ? nativeSparklines : null;
    const selected = selectExternalWorkbooks(externalWorkbooks, copiedFormulas(small ? cells : null, small ? conditionalFormats : null, small ? validations : null, sparks));
    externalWorkbooks = selected.externalWorkbooks;
    if (externalWorkbooks) {
      const map = selected.mapFormula;
      if (small) {
        cells = cells?.map(row => row.map(cell => reindexExternalCell(cell, map)));
        conditionalFormats = conditionalFormats?.map(item => ({ ...item, rule: mapConditionalFormulas(item.rule, map) }));
        validations = validations?.map(item => ({ ...item, rule: item.rule.type === 'formula' || item.rule.type === 'list' && isRangeSource(item.rule.source)
          ? { ...item.rule, source: map(item.rule.source) } : item.rule }));
      }
      if (sparks) nativeSparklines = { ...sparks, groups: mapNativeSparklineReferences(sparks.groups, map) };
    }
  }
  // Resolve the saved source identities with the same base as the transferred
  // link graph. This changes URI spelling, not the referenced workbook.
  if (sourceWorkbook && cells) cells = cells.map(row => row.map(cell => {
    if (!cell?.externalResult?.context?.sources) return cell;
    const saved = savedExternalResult(cell);
    return saved ? { ...cell, externalResult: { ...saved, context: { ...saved.context,
      sources: saved.context.sources.map(target => rebaseWorkbookTarget(target, sourceWorkbook)) } } } : cell;
  }));
  const fills = nativeFillEncoder();
  const snapshotCells = cells && total <= MAX_EMBED_CELLS ? cells.map(row => row.map(cell => cell?.s?.nativeFill
    ? { ...cell, s: fills.style(cell.s) } : cell)) : null;
  const embed = snapshotCells ? ` data-spreadsheet-cells="${escapeHtml(JSON.stringify(snapshotCells))}"` : '';
  const fillMeta = Object.keys(fills.records).length ? ` data-spreadsheet-fills="${escapeHtml(JSON.stringify(fills.records))}"` : '';
  const rules = embed && Array.isArray(conditionalFormats) ? ` data-spreadsheet-rules="${escapeHtml(JSON.stringify(conditionalFormats))}"` : '';
  const sparkMeta = total <= MAX_CLIPBOARD_CELLS && nativeSparklines ? ` data-spreadsheet-sparklines="${escapeHtml(JSON.stringify(nativeSparklines))}"` : '';
  const validationMeta = embed && Array.isArray(validations) ? ` data-spreadsheet-validations="${escapeHtml(JSON.stringify(validations))}"` : '';
  const externalMeta = (embed || sparkMeta) && externalWorkbooks ? ` data-spreadsheet-external-workbooks="${escapeHtml(JSON.stringify(rebaseExternalWorkbooks(normalizeExternalWorkbooks(externalWorkbooks), sourceWorkbook)))}"` : '';
  const results = values && total <= MAX_CLIPBOARD_CELLS ? ` data-spreadsheet-values="${escapeHtml(JSON.stringify(values))}"` : '';
  // Where the block was copied from, so a paste into another tab shifts relative references as an in-app paste does.
  const from = embed && origin && Number.isInteger(origin.r) && Number.isInteger(origin.c) ? ` data-spreadsheet-origin="${origin.r},${origin.c}"` : '';
  const body = `<tbody>${trs}</tbody>`;
  const stamp = embed || results || sparkMeta ? ` data-spreadsheet-markup="${clipboardMarkupStamp(body)}"` : '';
  const table = `<table${embed}${fillMeta}${rules}${validationMeta}${sparkMeta}${externalMeta}${results}${from}${stamp}>${body}</table>`;
  // Excel for Mac drops fills without standard HTML clipboard boundaries.
  // Include the complete table so spans and private data describe the same
  // fragment; the browser supplies platform byte offsets.
  // A namespace on the table alone is ignored by Excel's HTML clipboard
  // reader. Bind the Office types on the document root, keeping the complete
  // table inside the fragment for browsers that expose only its contents.
  return clipboard ? `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><!--StartFragment-->${table}<!--EndFragment--></body></html>` : table;
}

// The CSS named colours, with Excel's windowtext and window (the system's text and background colours) as black and white.
const NAMED_COLORS = new Map();
for (const [, name, hex] of `aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000
  blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e
  coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b
  darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00
  darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f
  darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff
  firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520
  gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0
  khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080
  lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a
  lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0
  lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3
  mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585
  midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000
  olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee
  palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080
  rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57
  seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa
  springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3
  white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32 windowtext:000000 window:ffffff`.matchAll(/([a-z]+):([0-9a-f]{6})/g)) NAMED_COLORS.set(name, `#${hex}`);

/** The red, green and blue channels (0–255) of an HSL colour: hue in degrees, saturation and lightness 0–1. */
function hslChannels(hue, s, l) {
  const h = ((hue % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const channel = (n) => { const k = (n + h / 30) % 12; return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255; };
  return [channel(0), channel(8), channel(4)];
}

/**
 * One CSS colour (a hex, an rgb() or hsl() call, or a name) as #rrggbb; null
 * for a fully transparent one, a keyword such as inherit, or anything else.
 */
function colorToken(t) {
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(t);
  if (m) return m[2] === '00' ? null : `#${m[1]}`;
  m = /^#([0-9a-f]{3})([0-9a-f])?$/.exec(t);
  if (m) return m[2] === '0' ? null : `#${m[1].replace(/./g, (ch) => ch + ch)}`;
  m = /^(rgb|hsl)a?\((.*)\)$/.exec(t);
  if (m) {
    // Channels are separated by commas or spaces and the alpha by a comma or a slash; a percentage scales to the channel's range.
    const parts = m[2].split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const number = (part, scale) => { const n = parseFloat(part); return Number.isFinite(n) ? (part.endsWith('%') ? (n / 100) * scale : n) : NaN; };
    if (parts.length === 4 && number(parts[3], 1) === 0) return null;
    const channels = m[1] === 'rgb' ? parts.slice(0, 3).map((part) => number(part, 255)) : hslChannels(number(parts[0], 360), number(parts[1], 1), number(parts[2], 1));
    if (channels.some((n) => !Number.isFinite(n))) return null;
    return `#${channels.map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')).join('')}`;
  }
  return NAMED_COLORS.get(t) || null;
}

/** The space-separated tokens of a CSS value, a function call kept whole with the spaces inside its parentheses. */
function cssTokens(t) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= t.length; i++) {
    const ch = t[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (!depth && (ch === undefined || ch === ' ' || ch === '\t' || ch === '\n')) { if (i > start) out.push(t.slice(start, i)); start = i + 1; }
  }
  return out;
}

/**
 * The colour a CSS value names, as #rrggbb, or null. A background shorthand
 * lists an image, a position and a repeat beside its colour, so a value of
 * several tokens is read for the first colour among them.
 */
function readColor(v) {
  if (!v) return null;
  const t = v.trim().toLowerCase();
  if (!t) return null;
  if (!/\s/.test(t)) return colorToken(t);
  for (const token of cssTokens(t)) { const color = colorToken(token); if (color) return color; }
  return null;
}

// Excel names its built-in formats in mso-number-format; the codes they stand for here.
// Percent is the two-decimal preset. Excel writes a zero-decimal percentage
// as the explicit code 0%, not this name.
const NAMED_FORMATS = {
  general: null, 'general number': null, percent: '0.00%', fixed: '0.00', standard: '#,##0.00', scientific: '0.00E+00',
  currency: '"$"#,##0.00', 'euro currency': '"€"#,##0.00',
  'yes/no': '"Yes";"Yes";"No"', 'true/false': '"True";"True";"False"', 'on/off': '"On";"On";"Off"',
  'short date': 'yyyy-mm-dd', 'medium date': 'mmm d, yyyy', 'long date': 'mmmm d, yyyy',
  'short time': 'h:mm', 'medium time': 'h:mm AM/PM', 'long time': 'hh:mm:ss', 'general date': 'yyyy-mm-dd hh:mm',
};

/**
 * The number format code in an mso-number-format value. Excel writes the
 * code as a CSS string with every symbol escaped (`0\.00`, `\#\,\#\#0`,
 * `\0022$\0022` for a quoted label) and its built-in formats by name
 * (Percent, Short Date). Null for General; any other code, one of letters
 * alone included (yyyy, mmm, dddd, hh), is the code it reads as.
 */
function msoNumberFormat(value) {
  let code = value;
  const quote = code[0] === '"' || code[0] === "'" ? code[0] : null;
  if (quote && code.length >= 2 && code.endsWith(quote)) code = code.slice(1, -1);
  // Native Excel writes "abc"0 as \0022abc\00220 and " " as
  // \0022 \0022. Treating these as CSS escapes consumes code characters.
  code = code.replace(/\\([0-9a-f]{4})|\\(.)/gi, (m, hex, ch) => (hex ? String.fromCharCode(parseInt(hex, 16)) : ch));
  // Office HTML has calendar markers that are not XLSX/TEXT directives.
  // [JPN] writes era-year e/ee as y/yy, while yyyy stays a Gregorian year.
  // Markers apply to their own section. Keep literals, padding/fill and other
  // bracket directives intact, including their embedded year letters.
  let japanese = false, hasJapanese = false, hasLocale = false;
  code = code.replace(/"[^"]*(?:"|$)|\\.|_.|\*.|\[[^\]]*\]|;|y+/gi, token => {
    if (token === ';') { japanese = false; return token; }
    if (/^\[\$[^\]]*-[^\]]+\]$/.test(token)) hasLocale = true;
    if (/^\[JPN\]$/i.test(token)) { japanese = hasJapanese = true; return ''; }
    if (/^\[HIJ\]$/i.test(token)) return 'B2';
    // These HTML hints do not override the extended LCID's calendar. Excel
    // also drops them when no locale/calendar tag accompanies the marker.
    if (/^\[(?:THA|TWN|ENG)\]$/i.test(token)) return '';
    return japanese && /^y{1,2}$/i.test(token) ? 'e'.repeat(token.length) : token;
  });
  if (hasJapanese && !hasLocale) code = `[$-411]${code}`;
  const name = code.trim().toLowerCase();
  if (Object.hasOwn(NAMED_FORMATS, name)) return NAMED_FORMATS[name];
  return code || null;
}

function styleFromElement(td, styles, spreadsheet = false) {
  const s = {};
  const decls = styles(td);
  readBorders(td, decls, s, spreadsheet);
  const prop = (name) => decls.get(name) ?? null;
  const weight = prop('font-weight');
  if ((weight && (weight === 'bold' || Number(weight) >= 600)) || (!weight && td.tagName === 'TH')) s.bold = true;
  else if (weight === 'normal' || (Number(weight) > 0 && Number(weight) < 600)) s.bold = false;
  if (prop('font-style') === 'italic') s.italic = true;
  else if (prop('font-style') === 'normal') s.italic = false;
  let deco = '';
  for (const [name, value] of decls) if (name === 'text-decoration' || name === 'text-decoration-line') deco = value;
  deco = prop('-spreadsheet-text-decoration') || deco;
  if (/underline/.test(deco)) s.underline = prop('-spreadsheet-underline-style') === 'double' ? 'double' : true;
  if (/line-through/.test(deco)) s.strike = true;
  if (/\b(?:none|underline|line-through)\b/.test(deco)) { s.underline ??= false; s.strike ??= false; }
  const color = /^(?:windowtext|canvastext)$/i.test(prop('color') || '') ? 'windowtext' : readColor(prop('color'));
  if (color) s.color = color;
  const bg = readColor(prop('background-color') || prop('background') || td.getAttribute('bgcolor'));
  // Excel's automatic pattern is a complete No fill override. CSS alone
  // incorrectly inherits the global td shading; the actual native cell uses
  // worksheet paper instead (verified against the independent XF-zero control).
  const noFill = prop('mso-background-source')?.trim().toLowerCase() === 'auto'
    && prop('mso-pattern')?.trim().toLowerCase() === 'auto';
  if (noFill) s.bg = null;
  else if (bg && (bg !== '#ffffff' || spreadsheet && prop('mso-pattern'))) s.bg = bg;
  const font = fontKeyFor(prop('font-family'));
  if (font) s.font = font;
  const size = fontPixels(prop('font-size'));
  if (size != null) s.size = size;
  const cssAlign = prop('text-align')?.trim().toLowerCase();
  // Excel's General means automatic placement, not the HTML align hint.
  // CSS auto is not an alignment value; native HTML paste uses the hint then.
  const align = (!cssAlign || cssAlign === 'auto' ? td.getAttribute('align')?.trim().toLowerCase() : cssAlign);
  if (ALIGNS.has(align)) s.align = align;
  const vertical = prop('vertical-align')?.trim().toLowerCase();
  if (VERTICAL_ALIGNS.has(vertical)) s.valign = vertical;
  const script = prop('-spreadsheet-run-vertical-align');
  if (script === 'super' || script === 'sub') s.vertAlign = script === 'super' ? 'superscript' : 'subscript';
  if (align !== 'center') {
    // Excel supplies the logical indent as well as CSS padding. The logical
    // value survives font and pixel-density differences between applications.
    const count = prop('mso-char-indent-count');
    if (count != null && /^\d+$/.test(count) && Number(count) <= 250) s.indent = Number(count);
    else if (count == null) {
      const padding = prop(align === 'right' ? 'padding-right' : 'padding-left');
      const px = padding?.match(/^(\d+(?:\.\d+)?)(px|pt)$/i);
      const width = px ? Number(px[1]) * (px[2].toLowerCase() === 'pt' ? 4 / 3 : 1) : 0;
      if (width >= 12 && width <= 3000) s.indent = Math.round(width / 12);
    }
  }
  const space = prop('white-space')?.toLowerCase();
  // An explicit normal declaration allows wrapping, even if the clipboard's
  // Office metadata was removed. The CSS reader leaves absent defaults absent.
  if (space === 'pre-wrap' || space === 'pre-line' || space === 'break-spaces' || space === 'normal') s.wrap = true;
  else if (space === 'nowrap' || space === 'pre') s.wrap = false;
  // Excel's number format, as a file's would be read: Text ("@") keeps 00123 and 1/2 as typed
  // instead of a number and a date; other codes become the closest named format or a custom one.
  // Google Sheets writes its format in an attribute of its own.
  const numberFormat = prop('mso-number-format');
  const numberStyle = numberFormat ? numFmtToStyle(msoNumberFormat(numberFormat)) : sheetsNumberFormat(td) || calcTextFormat(td);
  if (numberStyle) Object.assign(s, numberStyle);
  return Object.keys(s).length ? s : undefined;
}

/** Let CSS expand border shorthands and settle per-side overrides in declaration order. */
function readBorders(td, declarations, out, spreadsheet) {
  let css;
  for (const [name, value] of declarations) {
    if (!/^border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?$/.test(name)) continue;
    css ||= td.ownerDocument.createElement('span').style;
    css.setProperty(name, value);
  }
  if (!css) return;
  for (const [key, side] of [['bt', 'top'], ['br', 'right'], ['bb', 'bottom'], ['bl', 'left']]) {
    const style = css.getPropertyValue(`border-${side}-style`);
    const width = css.getPropertyValue(`border-${side}-width`);
    const color = css.getPropertyValue(`border-${side}-color`);
    if (!style && !width && !color) continue;
    const unit = /^(\d*\.?\d+)(px|pt|in|cm|mm)?$/.exec(width);
    const px = unit ? Number(unit[1]) * ({ pt: 4 / 3, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[unit[2]] || 1)
      : { thin: 1, medium: 3, thick: 5 }[width || 'medium'];
    // A zero blue/lightness component is not an alpha channel. Legacy
    // comma syntax has four components; modern alpha uses a slash.
    const transparent = color === 'transparent'
      || /^(?:rgba|hsla)\([^,]+,[^,]+,[^,]+,\s*0(?:\.0+)?%?\s*\)$/.test(color)
      || /^(?:rgb|hsl)a?\([^/]+\/\s*0(?:\.0+)?%?\s*\)$/.test(color);
    const visible = !!style && !['none', 'hidden'].includes(style) && px > 0 && !transparent;
    // Native Excel HTML serializes thin/medium/thick as .5/1/1.5pt.
    // Its point-weight thresholds differ from ordinary CSS pixel weights;
    // keep web tables and other units on the existing CSS interpretation.
    const weight = spreadsheet && unit?.[2] === 'pt'
      ? Number(unit[1]) < 1 ? 'thin' : Number(unit[1]) < 1.5 ? 'medium' : 'thick'
      : px <= 1.34 ? 'thin' : px < 3 ? 'medium' : 'thick';
    out[key] = visible;
    out[`${key}Border`] = visible ? {
      bs: ['double', 'dashed', 'dotted'].includes(style) ? style : weight,
      bc: readColor(color) || (!color || color === 'currentcolor' ? readColor(declarations.get('color')) : null),
    } : null;
  }
}

/**
 * Google Sheets' number format from data-sheets-numberformat, {"1":kind,"2":"pattern"}: the pattern is an
 * number-format code ("$"#,##0.00, d mmm, dddd); without one, kind 3 is percent, 5 a date, 6 a time and 7 both.
 * Null when there is none to read.
 */
function sheetsNumberFormat(td) {
  const raw = td.getAttribute('data-sheets-numberformat');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (typeof v[2] === 'string' && v[2]) return numFmtToStyle(v[2]);
    const code = { 3: '0%', 5: 'yyyy-mm-dd', 6: 'hh:mm', 7: 'yyyy-mm-dd hh:mm' }[v[1]];
    return code ? numFmtToStyle(code) : null;
  } catch { return null; }
}

/**
 * LibreOffice Calc's Text format, from sdnum="1033;0;@" (its language, then the format code): a cell so
 * formatted keeps 00123 and 1/2 as typed, as Excel's mso-number-format "@" does. Null for any other code,
 * whose spelling is Calc's own and whose number the cell's sdval already gives.
 */
function calcTextFormat(td) {
  const code = td.getAttribute('sdnum')?.split(';').slice(2).join(';');
  return code?.trim() === '@' ? numFmtToStyle('@') : null;
}

/**
 * The format of a number LibreOffice Calc wrote with sdnum="1031;0;#.##0,00 [$€-407]" (its language, then
 * the code), as this app's style: the code in Excel's spelling, its decimal and group marks those of that
 * language. Calc spells date and time words in the language too (TT.MM.JJJJ in German), and has codes of its
 * own (NNNN for a weekday, Q for a quarter): a code with letters is read only in English, and only without
 * those. Null for any other code, and for General.
 */
function calcNumberStyle(td) {
  const [language, , ...rest] = (td.getAttribute('sdnum') || '').split(';');
  const code = rest.join(';').trim();
  if (!code || code === '@' || code.length > MAX_FORMAT_CODE_LENGTH || !/^\d+$/.test(language)) return null;
  const english = (Number(language) & 0x3ff) === 0x09;
  let decimal = '.', group = ',';
  try {
    const parts = new Intl.NumberFormat(codeLocale(`[$-${Number(language).toString(16)}]`) || 'en-US').formatToParts(12345.6);
    decimal = parts.find((p) => p.type === 'decimal')?.value || '.';
    group = parts.find((p) => p.type === 'group')?.value || ',';
  } catch { /* a language Intl does not know reads as English */ }
  let excel = '';
  for (const token of code.match(/"[^"]*"?|\[[^\]]*\]?|\\.|_.|\*.|[\s\S]/g)) {
    if (token.length > 1) {
      if (/^\[(?:~|NatNum|DBNum)/i.test(token)) return null;
      excel += token;
    } else if (token === decimal) excel += '.';
    else if (token === group) excel += ',';
    else if (/\p{L}/u.test(token) && (english ? /[NQW]/i.test(token) : !/^e$/i.test(token))) return null;
    else excel += token;
  }
  return numFmtToStyle(excel);
}

/**
 * The typed value behind a cell's displayed text, when the source app wrote
 * one: Excel's x:num (the full-precision number), x:bool and x:str (text, however it
 * reads; the attribute carries the text itself when the display differs, as
 * with leading spaces), Google Sheets' data-sheets-value ({"1":3,"3":n} for
 * a number, {"1":2,"2":"t"} for text, {"1":4,"4":b} for a boolean).
 * Undefined when the text must speak for itself.
 */
function typedValue(td, styles, spreadsheet = false, text = '', emptyStrings) {
  if (!td.hasAttributes() && !spreadsheet) return undefined;
  const num = td.getAttribute('x:num');
  if (num != null && num.trim() !== '') { const n = Number(num); return Number.isFinite(n) ? n : undefined; }
  const str = td.getAttribute('x:str');
  if (str != null) return str || (emptyStrings?.has(td) ? '' : null); // bare x:str reads markup
  const bool = td.getAttribute('x:bool');
  if (bool != null && /^(true|false)$/i.test(bool.trim())) return bool.trim().toLowerCase() === 'true';
  const sheets = td.getAttribute('data-sheets-value');
  if (sheets) {
    try {
      const v = JSON.parse(sheets);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (v[1] === 3 && typeof v[3] === 'number' && Number.isFinite(v[3])) return v[3];
        if (v[1] === 2 && typeof v[2] === 'string') return v[2];
        if (v[1] === 4 && typeof v[4] === 'boolean') return v[4];
      }
    } catch { /* not Sheets' JSON: the text speaks for itself */ }
  }
  // LibreOffice Calc writes a number's own value as sdval beside the text it shows. A logical value is a 1 or 0
  // to Calc, shown TRUE or FALSE, which stays the logical value it reads as.
  const sdval = td.getAttribute('sdval');
  if (sdval != null && sdval.trim() !== '' && Number.isFinite(Number(sdval))) {
    const n = Number(sdval), shown = text.trim().toUpperCase();
    return (shown === 'TRUE' && n === 1) || (shown === 'FALSE' && n === 0) ? n === 1 : n;
  }
  // Office HTML distinguishes General alignment from explicit alignment.
  // With General, the HTML align attribute describes the value's automatic
  // placement: left is text, right is numeric, center is Boolean/error. Some
  // Excel clipboard writers omit x:str, so reparsing that text would lose
  // leading zeros or turn a literal formula/date/Boolean into another type.
  // Explicit CSS alignment is presentation only and cannot identify a type.
  // A bare x:num still identifies numeric content and takes precedence.
  const decls = styles(td);
  const alignment = decls.get('text-align')?.toLowerCase();
  const hint = td.getAttribute('align')?.trim().toLowerCase();
  // Native Excel HTML has no explicit error attribute: automatic centering
  // distinguishes error values from the same words stored as text. Explicit
  // CSS centering is only presentation, and x:str above always wins.
  if (num == null && (alignment === 'general' || alignment === 'auto') && hint === 'center') {
    const error = text.trim().toUpperCase();
    if (OFFICE_ERRORS.has(error)) return { error };
  }
  // Native Office documents can omit the default left hint on text cells.
  // Outside that dialect, missing HTML alignment says nothing about type.
  if (num == null && (alignment === 'general' || alignment === 'auto')
    && (hint === 'left' || spreadsheet && hint == null)
    && decls.get('direction')?.toLowerCase() !== 'rtl'
    && !td.closest('[dir="rtl" i]')) return null;
  return undefined;
}

const collapsed = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * The address of a cell that is one link — a single <a href> around all of
 * its text — when it is a web or mail address. Pasted markup is untrusted:
 * only the attribute is read, and only what safeLinkUrl accepts is kept.
 * In-page anchors (#top) mean nothing in a workbook and are left out.
 */
function linkOf(td) {
  const anchors = td.getElementsByTagName('a');
  if (anchors.length !== 1) return null;
  const href = anchors[0].getAttribute('href');
  if (!href) return null;
  const label = collapsed(anchors[0].textContent);
  if (!label || label !== collapsed(td.textContent)) return null;
  const url = safeLinkUrl(href);
  return url && !url.startsWith('#') ? url : null;
}

// Code and styling inside a cell are not its text.
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
// Elements that start and end a line of the cell's text.
const BLOCK_TAGS = new Set(['DIV', 'P', 'PRE', 'LI', 'TABLE', 'TR']);
const CELL_GAP = '\u0001';

/** Lines trimmed with their whitespace collapsed as in HTML; the cells of a nested table a tab apart; trailing blank lines dropped. */
function normalizeCellText(raw) {
  const lines = raw.replace(/\u00a0/g, ' ').split('\n').map((line) => (line.includes(CELL_GAP)
    ? line.split(CELL_GAP).map(collapsed).join('\t').replace(/\t+$/, '')
    : collapsed(line)));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}

/**
 * The text of a cell: <br> and block edges break lines, a table inside the
 * cell reads row by row with its cells a tab apart, and other whitespace
 * follows the element's white-space mode. Deferred layout separators never
 * become trailing cell data. The walk is iterative because pasted markup may
 * nest deeper than the call stack allows.
 */
// A line break stays a line break: Office (and this app's export) writes one a browser hides, display:none with
// mso-data-placement:same-cell, for a new line within a cell that does not wrap.
const hiddenContent = (node, styles) => node.tagName !== 'BR'
  && (node.hasAttribute('hidden') || styles(node).get('display')?.trim().toLowerCase() === 'none');

function cellText(td, styles) {
  const out = [];
  const runs = [], fonts = new WeakMap();
  // Plain clipboard cells cannot have character-level differences. Keep
  // their large-table path free of extra style parsing and run allocations.
  const rich = !!td.firstElementChild;
  const baseFont = rich ? richFontStyle(styleFromElement(td, styles)) : null;
  const fontAt = node => {
    if (!fonts.has(node)) fonts.set(node, { ...baseFont, ...richFontStyle(styleFromElement(node, styles)) });
    return fonts.get(node);
  };
  let font = baseFont;
  const append = (text, characterFont = font) => { out.push(text); if (rich) runs.push({ text, s: characterFont }); };
  let lineStart = true, space = false, block = false, gaps = 0;
  let spaceFont = baseFont;
  const deferSpace = () => { if (!space) spaceFont = font; space = true; };
  const flush = () => {
    if (block) { append('\n'); lineStart = true; }
    if (gaps) append('\t'.repeat(gaps));
    else if (space && !lineStart) append(' ', spaceFont);
    block = space = false; gaps = 0;
  };
  const boundary = () => { space = false; gaps = 0; if (!lineStart) block = true; };
  const newline = () => {
    space = false; gaps = 0; flush(); append('\n'); lineStart = true;
  };
  const collapsedText = raw => {
    // Source line wrapping is ordinary HTML whitespace, not an entered cell
    // newline. Keep pending spaces across inline nodes, trimming at line edges.
    // NBSP and other Unicode separators are content, not collapsible HTML
    // whitespace. Only an explicit Office space-run changes NBSP into spaces.
    const text = raw.replace(/[\t\n\r\f ]+/g, ' ');
    if (!text || text === ' ') { if (text && !lineStart && !block && !gaps) deferSpace(); return; }
    if (text.startsWith(' ') && !block && !gaps) deferSpace();
    flush();
    const content = text.replace(/^ +| +$/g, '');
    if (content) { append(content); lineStart = false; }
    space = text.endsWith(' ');
    if (space) spaceFont = font;
  };
  const text = node => {
    if (rich) font = fontAt(node.parentElement);
    const declarations = styles(node.parentElement);
    const mode = declarations.get('white-space')?.toLowerCase();
    const preserve = mode === 'pre' || mode === 'pre-wrap' || mode === 'break-spaces';
    let raw = node.data.replace(/\r\n?/g, '\n');
    // Office uses NBSP within a space-run to represent significant ordinary
    // spaces. Its source can still wrap/indent the run, which collapses in HTML.
    if (declarations.get('mso-spacerun')?.toLowerCase() === 'yes') {
      if (!preserve) raw = raw.replace(/[\t\n\r\f ]+/g, ' ');
      raw = raw.replace(/\u00a0/g, ' ');
      if (raw) { flush(); append(raw); lineStart = raw.endsWith('\n'); }
    } else if (preserve) {
      if (raw) { flush(); append(raw); lineStart = raw.endsWith('\n'); }
    } else if (mode === 'pre-line') {
      const lines = raw.split('\n');
      lines.forEach((line, i) => { if (i) newline(); collapsedText(line); });
    } else collapsedText(raw);
  };
  const leave = tag => {
    if (tag === 'TD' || tag === 'TH') { space = false; gaps++; }
    else if (BLOCK_TAGS.has(tag)) boundary();
  };
  const parents = [];
  let node = td.firstChild;
  while (node) {
    let descend = false;
    if (node.nodeType === 3) text(node);
    // Content the page hides inside a cell (a sort key, a screen-reader label) is not its text.
    else if (node.nodeType === 1 && !SKIP_TAGS.has(node.tagName) && !hiddenContent(node, styles)) {
      if (node.tagName === 'BR') {
        if (rich) font = fontAt(node);
        newline();
      }
      else {
        if (BLOCK_TAGS.has(node.tagName)) boundary();
        if (node.firstChild) descend = true; else leave(node.tagName);
      }
    }
    if (descend) { parents.push(node); node = node.firstChild; continue; }
    while (!node.nextSibling && parents.length) { node = parents.pop(); leave(node.tagName); }
    node = node.nextSibling;
  }
  const result = out.join('');
  // Office HTML uses a lone NBSP as an empty-table-cell placeholder. Typed
  // text attributes are read separately and retain an actual one-NBSP value;
  // NBSP within text or a longer run is meaningful content.
  return { text: result === '\u00a0' ? '' : result, runs };
}

/**
 * The table a wrapper table holds in its only cell, when that cell holds
 * nothing else: mail clients and web pages frame content in such tables,
 * and the framed table is the one meant.
 */
/**
 * Google Sheets copies a single cell as a span carrying the cell's value and format (data-sheets-value), not as a
 * table: that span as a one-cell table, or null when the markup is anything else.
 */
function sheetsCellTable(doc) {
  const span = doc.querySelector('[data-sheets-root]');
  if (!span || span.tagName === 'TABLE' || !span.hasAttribute('data-sheets-value') || span.querySelector('table')) return null;
  const table = doc.createElement('table'), td = doc.createElement('td');
  for (const { name, value } of span.attributes) td.setAttribute(name, value);
  td.append(...span.childNodes);
  table.append(doc.createElement('tr'));
  table.firstChild.append(td);
  span.replaceWith(table);
  return table;
}

function wrappedTable(table) {
  const rows = htmlTableRows(table);
  if (rows.length !== 1) return null;
  let cell = null;
  for (const child of rows[0].children) {
    if (child.tagName !== 'TD' && child.tagName !== 'TH') continue;
    if (cell) return null;
    cell = child;
  }
  const inner = cell?.querySelector('table');
  return inner && collapsed(cell.textContent) === collapsed(inner.textContent) ? inner : null;
}

const scalarSetting = (value) => value == null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value));

function validEmbeddedValue(value) {
  return scalarSetting(value) || (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof value.error === 'string');
}

const COLOR_KEYS = ['color', 'bg', 'bc'];
const BORDER_KEYS = ['btBorder', 'bbBorder', 'blBorder', 'brBorder'];
const validBorderSetting = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).every(([key, v]) => (key === 'bs' || key === 'bc') && (v == null || typeof v === 'string'));

/**
 * The embedded cell held to what a typed entry may be, with colour settings
 * that are not hex colours dropped. A cell keeps no more text than a file
 * can store, and a formula longer than the file format allows or nested deeper than
 * the parser follows stays the text it reads as, as when it is typed. The
 * grid and toolbar write colours into element styles as they are, so a
 * pasted `url(…)` there would fetch on every selection; files already hold
 * their colours to the same rule. A format code longer than the file format allows,
 * which costs milliseconds a cell to show, goes too: the cell reads as General.
 */
function cleanEmbeddedCell(cell) {
  if (!cell) return cell;
  let out = cell;
  if (typeof cell.f === 'string' && cellFromInput(`=${cell.f}`)?.f == null) {
    out = { ...out, v: `=${cell.f}`, f: null };
    delete out.array;
  }
  // The cut lands on a character boundary: an emoji straddling the limit is dropped whole, not left as half a pair.
  if (typeof out.v === 'string' && out.v.length > MAX_TEXT) out = { ...out, v: out.v.slice(0, MAX_TEXT).replace(/[\uD800-\uDBFF]$/, '') };
  if (!out.s) return out;
  const s = { ...out.s };
  if (s.nativeFill != null) s.nativeFill = normalizeNativeFill(s.nativeFill);
  for (const key of COLOR_KEYS) if (key in s && s[key] !== null) {
    const color = key === 'color' ? normalizeFontColor(s[key]) : key === 'bg' && typeof s[key] === 'object' ? normalizeFillColor(s[key]) : typeof s[key] === 'string' && HEX_COLOR.test(s[key]) ? s[key] : null;
    if (color) s[key] = color; else delete s[key];
  }
  for (const key of BORDER_KEYS) if (s[key] && typeof s[key] === 'object') {
    s[key] = { ...s[key] };
    if (s[key].bc != null && !HEX_COLOR.test(s[key].bc)) delete s[key].bc;
  }
  if (typeof s.code === 'string' && s.code.length > MAX_FORMAT_CODE_LENGTH) { delete s.code; if (s.fmt === 'custom') delete s.fmt; }
  return { ...out, s: Object.keys(s).length ? s : undefined };
}

function validEmbeddedCell(cell) {
  if (cell === null) return true;
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return false;
  if (!validEmbeddedValue(cell.v)) return false;
  if (cell.f != null && typeof cell.f !== 'string') return false;
  if (cell.hyperlink != null && (typeof cell.hyperlink !== 'string' || cell.hyperlink.length > MAX_TEXT)) return false;
  if (cell.array != null && (typeof cell.f !== 'string' || !fixedArraySize(cell.array))) return false;
  // Cell styles contain scalar settings, side borders or validated color references, and never keys
  // named like a member every object inherits (toString, constructor, ...),
  // which trip up code that looks style keys up in plain objects. Let the
  // existing formatters and CSS handle their supported values as usual.
  return cell.s == null || (typeof cell.s === 'object' && !Array.isArray(cell.s)
    && Object.entries(cell.s).every(([k, v]) => !(k in Object.prototype) && (scalarSetting(v)
      || k === 'color' && !!normalizeFontColor(v) || k === 'bg' && !!normalizeFillColor(v)
      || k === 'nativeFill' && !!normalizeNativeFill(v) || BORDER_KEYS.includes(k) && validBorderSetting(v))));
}

/** Optional rule snapshots use the same trust boundary and style checks as cells. */
function copiedConditionalFormats(table, height, width) {
  const raw = table.getAttribute('data-spreadsheet-rules');
  if (raw == null) return null;
  const point = (n, max) => Number.isInteger(n) && n >= 0 && n < max;
  const range = (g, h, w) => g && point(g.r1, h) && point(g.r2, h) && g.r1 <= g.r2
    && point(g.c1, w) && point(g.c2, w) && g.c1 <= g.c2;
  try {
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || items.some(item => !item || !range(item.range, height, width)
      || !point(item.source?.r, 1048576) || !point(item.source?.c, 16384)
      || !range(item.rule?.range, 1048576, 16384) || !RULE_TYPES.some(type => type.value === item.rule.type)
      || !validEmbeddedCell({ v: null, s: item.rule.style })
      || Object.entries(item.rule).some(([key, value]) => key in Object.prototype
        || !['range', 'style'].includes(key) && (!scalarSetting(value) || typeof value === 'string' && value.length > MAX_TEXT)))) return null;
    return items.map(item => {
      const rule = { ...item.rule, style: cleanEmbeddedCell({ v: null, s: item.rule.style }).s || {} };
      for (const key of ['color1', 'color2', 'headerColor', 'barColor', 'barBorderColor', 'barNegativeColor', 'barNegativeBorderColor', 'barAxisColor']) {
        if (rule[key] != null && !HEX_COLOR.test(rule[key])) delete rule[key];
      }
      return { rule, range: item.range, source: item.source, ...(item.nativeDuplicates === true ? { nativeDuplicates: true } : {}) };
    });
  } catch { return null; }
}

function copiedValidations(table, height, width) {
  const raw = table.getAttribute('data-spreadsheet-validations');
  if (raw == null) return null;
  const point = (n, max) => Number.isInteger(n) && n >= 0 && n < max;
  const range = (g, h, w) => g && point(g.r1, h) && point(g.r2, h) && g.r1 <= g.r2
    && point(g.c1, w) && point(g.c2, w) && g.c1 <= g.c2;
  const setting = v => scalarSetting(v) && (typeof v !== 'string' || v.length <= MAX_TEXT);
  try {
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || items.some(item => !item || !range(item.range, height, width)
      || !range(item.rule?.range, 1048576, 16384) || !VALIDATION_TYPES.some(type => type.value === item.rule.type)
      || item.rule.type === 'formula' && typeof item.rule.source !== 'string'
      || item.rule.type === 'list' && typeof item.rule.source !== 'string' && !Array.isArray(item.rule.source)
      || Object.entries(item.rule).some(([key, value]) => key in Object.prototype || (key !== 'range'
        && !(key === 'source' && Array.isArray(value) ? value.every(setting)
          : key === 'colors' && value && typeof value === 'object' && !Array.isArray(value)
            ? Object.values(value).every(v => typeof v === 'string' && HEX_COLOR.test(v)) : setting(value)))))) return null;
    return items.map(({ rule, range }) => ({ rule, range }));
  } catch { return null; }
}

/** A copy token is usable only while its accompanying table is unchanged. */
export function isOwnHtmlClipboard(html, copyId) {
  if (!copyId || !html || typeof DOMParser === 'undefined') return false;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let table = doc.querySelector('table');
    if (!table) return false;
    for (let inner = wrappedTable(table); inner; inner = wrappedTable(inner)) table = inner;
    return table.getAttribute('data-spreadsheet-copy') === copyId && hasClipboardSnapshot(table);
  } catch { return false; }
}

// Excel discards NUL characters/references in rendered external HTML.
// Explicit Office string values are protected separately before this pass.
// The browser instead replaces them with U+FFFD, losing the distinction from
// an actual replacement character and preventing numeric text from parsing.
// Leave raw-text elements and comments intact: their contents do not decode
// character references, and a CSS number-format literal may contain one.
function withoutHtmlNullReferences(html) {
  return html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)(?=[\s/>])[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|&#(?:0+(?!\d);?|x0+(?![0-9a-f]);?)|\0/gi,
    token => token[0] === '&' || token === '\0' ? '' : token);
}

/**
 * Parse pasted HTML. Returns { cells } when the table came from this app
 * (formulas and styles intact, plus optional copied `values`), { rows } of { text, style } for other
 * tables, { error } when the expanded table exceeds the copy limit, or null when there is no table to read.
 */
export function parseHtmlClipboard(html, plainText) {
  if (!html || typeof DOMParser === 'undefined') return null;
  const emptyStrings = new WeakSet();
  const parseDocument = (source, normalizeText = false, unchanged = null) => {
    const { html: marked, marker } = prepareOfficeStrings(source, normalizeText);
    const prepared = normalizeText ? withoutHtmlNullReferences(marked) : marked;
    if (unchanged && prepared === source) return unchanged;
    const document = new DOMParser().parseFromString(prepared, 'text/html');
    if (marker) for (const td of document.querySelectorAll(`[${marker}]`)) {
      if (td.getAttribute(marker) === 'nul') td.setAttribute('x:str', td.getAttribute('x:str').replace(/\r([01])/g, (_, code) => code === '0' ? '\0' : '\r'));
      else emptyStrings.add(td);
      td.removeAttribute(marker);
    }
    return document;
  };
  let doc;
  try { doc = parseDocument(html); } catch { return null; }
  let table = doc.querySelector('table') || sheetsCellTable(doc);
  if (!table) return null;
  for (let inner = wrappedTable(table); inner; inner = wrappedTable(inner)) table = inner;
  // Unsigned older copies and metadata left behind by another application
  // still have usable HTML, but cannot safely restore formulas or old values.
  const snapshot = hasClipboardSnapshot(table);
  // Office spreadsheet HTML is a rendered table, whereas its accompanying
  // TSV is independent of column width. In particular, HTML can contain
  // overflow hashes or expanded fill in place of the copied cell's text.
  const spreadsheet = doc.documentElement.getAttribute('xmlns:x') === 'urn:schemas-microsoft-com:office:excel'
    || [...doc.querySelectorAll('meta[name]')].some(meta => meta.getAttribute('name').toLowerCase() === 'progid'
      && meta.getAttribute('content')?.toLowerCase() === 'excel.sheet');
  // Include decimal/hex C1 prefixes as well as NUL and zero-padded references.
  // The source tokenizer checks the complete numeric value before changing it.
  if (!snapshot && /[\0\r]|&#(?:0|1[2-5]|x[089])/i.test(html)) {
    doc = parseDocument(html, true, doc);
    table = doc.querySelector('table') || sheetsCellTable(doc);
    if (!table) return null;
    for (let inner = wrappedTable(table); inner; inner = wrappedTable(inner)) table = inner;
  }
  const readValues = (height, width) => {
    if (!snapshot || height * width > MAX_CLIPBOARD_CELLS) return null;
    try {
      const values = JSON.parse(table.getAttribute('data-spreadsheet-values') || 'null');
      if (Array.isArray(values) && values.length === height && values.every((row) =>
        Array.isArray(row) && row.length === width && row.every(validEmbeddedValue))) return values;
    } catch { /* Older or malformed snapshots still have usable cells or text. */ }
    return null;
  };
  const readSparklines = (height, width) => {
    if (!snapshot || height * width > MAX_CLIPBOARD_CELLS) return null;
    try { return readCopiedNativeSparklines(JSON.parse(table.getAttribute('data-spreadsheet-sparklines') || 'null'), height, width); }
    catch { return null; } // Malformed optional metadata leaves visible HTML intact.
  };
  // Link IDs are workbook-relative. Invalid supporting data must never leave
  // a private formula accidentally bound to the destination's same-numbered link.
  let externalWorkbooks = null;
  if (snapshot && table.hasAttribute('data-spreadsheet-external-workbooks')) {
    try {
      externalWorkbooks = normalizeExternalWorkbooks(JSON.parse(table.getAttribute('data-spreadsheet-external-workbooks')));
      if (!externalWorkbooks || !copiedExternalLinksValid(externalWorkbooks.books.flatMap(book => book.names.map(name => name.ref)), externalWorkbooks)) throw new Error('Missing supporting data');
    } catch { return { error: 'The copied external workbook links are invalid. Copy the cells again.' }; }
  }
  const embedded = snapshot && table.getAttribute('data-spreadsheet-cells');
  let embeddedResult;
  if (embedded) {
    try {
      let cells = JSON.parse(embedded);
      if (table.hasAttribute('data-spreadsheet-fills')) {
        const fills = nativeFillDecoder(JSON.parse(table.getAttribute('data-spreadsheet-fills')));
        if (!Array.isArray(cells) || cells.some(row => !Array.isArray(row))) throw new Error('Invalid copied cells');
        cells = cells.map(row => row.map(cell => cell?.s?.nativeFill ? { ...cell, s: fills.style(cell.s) } : cell));
      }
      const width = Array.isArray(cells?.[0]) ? cells[0].length : 0;
      // Paste expects a nonempty rectangle of valid cells. Malformed metadata
      // must not break the editor or replace the table's visible text.
      if (Array.isArray(cells) && width && cells.every((row) =>
        Array.isArray(row) && row.length === width && row.every(validEmbeddedCell))
        && cells.every((row, r) => row.every((cell, c) => !cell?.array
          || r + cell.array.rows <= cells.length && c + cell.array.cols <= width))) {
        if (cells.length * width > MAX_CLIPBOARD_CELLS) return { error: TOO_LARGE };
        const values = readValues(cells.length, width);
        const at = /^(\d{1,7}),(\d{1,5})$/.exec(table.getAttribute('data-spreadsheet-origin') || '');
        const origin = at ? { r: Number(at[1]), c: Number(at[2]) } : null;
        const conditionalFormats = copiedConditionalFormats(table, cells.length, width);
        const validations = copiedValidations(table, cells.length, width);
        const nativeSparklines = readSparklines(cells.length, width);

        const formulas = copiedFormulas(cells, conditionalFormats, validations, nativeSparklines);
        if (!copiedExternalLinksValid(formulas, externalWorkbooks)) return { error: MISSING_EXTERNAL_LINKS };
        embeddedResult = { ...(externalWorkbooks ? { externalWorkbooks } : {}), ...(nativeSparklines ? { nativeSparklines } : {}), ...(validations ? { validations } : {}), ...(conditionalFormats ? { conditionalFormats } : {}), cells: cells.map((row) => row.map(cleanEmbeddedCell)), ...(values ? { values } : {}), ...(origin ? { origin } : {}) };
      }
    } catch { /* fall through to the markup */ }
  }
  // Ordinary private snapshots need no second cell/style read. When spans
  // exist, their signed markup supplies the merge geometry for cross-tab paste.
  if (embeddedResult && !table.querySelector('td[rowspan], td[colspan], th[rowspan], th[colspan]')) return embeddedResult;
  const rows = [];
  const merges = [];
  const displaySpans = [];
  const styles = embeddedResult ? null : readClipboardStyles(doc);
  // Google Sheets draws its gridlines with a page rule (td {border: 1px solid #cccccc}) and writes a border a cell
  // really has on the cell itself, so a cell copied from it takes only the border declarations of its own.
  const sheetsGridlines = !snapshot && !!(doc.querySelector('google-sheets-html-origin') || table.hasAttribute('data-sheets-root'));
  const cellStyles = !styles || !sheetsGridlines ? styles : (el) => {
    const all = styles(el);
    if (![...all.keys()].some((name) => name.startsWith('border'))) return all;
    const own = new Set([...(el.getAttribute('style') || '').matchAll(/(?:^|;)\s*(border[a-z-]*)\s*:/gi)].map((m) => m[1].toLowerCase()));
    return new Map([...all].filter(([name]) => !name.startsWith('border') || own.has(name)));
  };
  const tableRows = [];
  // Excel's saved HTML can represent a run of rows with one TR. These are
  // separate worksheet rows, with repeated formatting but only one value.
  // Bound the expanded shape before allocating any cell data.
  const compactRows = !snapshot && /mso-xlrowspan\s*:/i.test(html);
  for (const tr of htmlTableRows(table)) {
    const raw = compactRows ? styles(tr).get('mso-xlrowspan') : null;
    const count = /^\+?\d+$/.test(raw || '') ? Math.max(1, Number(raw)) : 1;
    if (tableRows.length + count > MAX_CLIPBOARD_CELLS) return { error: TOO_LARGE };
    for (let i = 0; i < count; i++) tableRows.push({ tr, repeated: count > 1, blank: i > 0 });
  }
  const groupEnds = new Map();
  tableRows.forEach(({ tr }, i) => groupEnds.set(tr.parentElement, i + 1));
  // Carry occupied columns forward only through rows that actually exist.
  // This also bounds hostile row spans and keeps rowspan=0 within its row group.
  const rowSpans = new Map();
  // Markup-derived text can be refined by TSV. An explicit x:str marker also
  // makes empty markup a stored empty string; General alignment alone does not.
  const bare = new Map();
  const anchors = [];
  for (const [r, { tr, repeated, blank }] of tableRows.entries()) {
    const row = [];
    for (const [c, end] of rowSpans) {
      if (end > r) row[c] = { text: '', style: undefined };
      else rowSpans.delete(c);
    }
    let c = 0;
    for (const td of tr.children) {
      if (td.tagName !== 'TD' && td.tagName !== 'TH') continue;
      while (row[c]) c++;
      // The DOM clamps colspan to 1–1000; the raw attribute can request billions of cells.
      const span = td.colSpan;
      // A display-only overflow/blank span occupies HTML columns without
      // merging the corresponding worksheet cells. Excel's combined token
      // retains vertical layout too; the colspan-only token ignores rowspan.
      const ignore = !snapshot ? (styles(td).get('mso-ignore') || '').toLowerCase().split(/[\s,]+/) : [];
      const display = repeated || ignore.includes('colspan') || ignore.includes('colspan-rowspan');
      // Include empty rows and span placeholders in the pasted rectangle.
      // Check before creating cells so a small table cannot amplify into an unbounded allocation.
      if (tableRows.length * (c + span) > MAX_CLIPBOARD_CELLS) return { error: TOO_LARGE };
      const groupEnd = groupEnds.get(tr.parentElement);
      const end = repeated || ignore.includes('colspan') ? r + 1
        : td.rowSpan === 0 ? groupEnd : Math.min(r + td.rowSpan, groupEnd);
      for (let i = 1; i < span; i++) if (row[c + i]) return { error: 'This table contains overlapping merged cells.' };
      if (span > 1 || end > r + 1) (display ? displaySpans : merges).push({ r1: r, c1: c, r2: end - 1, c2: c + span - 1 });
      const content = embeddedResult || blank ? { text: '', runs: [] } : cellText(td, styles);
      const { text } = content;
      // Verified value-only snapshots may have crossed a DOM serialization,
      // which writes their originally bare markers as x:str="". Their captured
      // values still take precedence, as they did before syntax preservation.
      const typed = embeddedResult || blank ? undefined : typedValue(td, styles, spreadsheet, text, snapshot ? undefined : emptyStrings);
      row[c] = { text, style: embeddedResult ? undefined : styleFromElement(td, cellStyles, spreadsheet) };
      // Uniform inline formatting is a cell format. Only differences need a
      // character-run list, preserving the existing plain-cell representation.
      if (content.runs.length) {
        // An explicit string can replace the displayed characters entirely.
        // Excel applies the first character's font to that replacement value.
        const fontRuns = typeof typed === 'string' && typed !== text ? content.runs.slice(0, 1) : content.runs;
        const common = {};
        for (const key of RICH_FONT_KEYS) {
          // Only fonts supported by the ordinary cell renderer can be lifted
          // out of runs. A uniform superscript or double underline is still
          // character formatting, even when it covers the whole value.
          if (!['font', 'size', 'bold', 'italic', 'underline', 'strike', 'color'].includes(key)) continue;
          const value = fontRuns[0].s?.[key];
          if (key === 'underline' && typeof value !== 'boolean') continue;
          if (value !== undefined && fontRuns.every(run => JSON.stringify(run.s?.[key]) === JSON.stringify(value))) common[key] = value;
        }
        if (Object.keys(common).length) row[c].style = { ...row[c].style, ...common };
        const rich = normalizeRichText(content.runs.map(run => {
          const s = { ...run.s };
          for (const key of Object.keys(common)) delete s[key];
          return { text: run.text, s };
        }), text);
        if (rich) row[c].richText = rich;
      }
      if (!embeddedResult && !blank) anchors.push([r, c]);
      if (typed !== undefined && (typed !== null || text !== '' || td.hasAttribute('x:str'))) row[c].value = typed === null ? text : typed;
      // The format Calc showed its number through, for a number whose shown text reads as no number here.
      const calcStyle = typeof typed === 'number' && td.hasAttribute('sdnum') ? calcNumberStyle(td) : null;
      if (calcStyle) row[c].numberStyle = calcStyle;
      if (typed === null) bare.set(row[c], td.hasAttribute('x:str'));
      const link = !embeddedResult && !blank && td.firstElementChild ? linkOf(td) : null;
      if (link) row[c].link = link;
      for (let i = 0; i < span; i++) {
        if (i) row[c + i] = { text: '', style: undefined };
        if (end > r + 1) rowSpans.set(c + i, end);
      }
      c += span;
    }
    rows.push(Array.from(row, (cell) => cell || { text: '', style: undefined }));
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (!width) return null;
  if (embeddedResult) {
    // A malformed private shape must not let a span reach beyond its cells.
    if (rows.length !== embeddedResult.cells.length || width !== embeddedResult.cells[0].length) return { error: 'The copied cells and merged ranges have different dimensions.' };
    return { ...embeddedResult, ...(merges.length ? { merges } : {}) };
  }
  // Every row spans the table's width, short rows and empty <tr> elements
  // alike, so a paste clears those cells rather than retaining old destination data.
  for (const row of rows) while (row.length < width) row.push({ text: '', style: undefined });
  // HTML borders belong to the complete spanning TD. Spreadsheet borders
  // belong to the individual perimeter cells, including covered positions.
  // Private snapshots already carry that geometry and returned above.
  for (const m of displaySpans) {
    const source = rows[m.r1][m.c1].style;
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) {
      const style = { ...source };
      // The TD's fill/font applies throughout its display rectangle. Borders
      // belong only to the perimeter, not every formerly covered cell.
      for (const key of ['bt', 'bb', 'bl', 'br']) if (Object.hasOwn(style, key)) {
        style[key] = false; style[`${key}Border`] = null;
      }
      rows[r][c].style = style;
    }
    rows[m.r1][m.c1].style = source;
  }
  for (const m of [...merges, ...displaySpans]) {
    const source = { ...rows[m.r1][m.c1].style };
    for (const [key, horizontal, fixed] of [['bt',true,m.r1],['bb',true,m.r2],['bl',false,m.c1],['br',false,m.c2]]) {
      if (!Object.hasOwn(source, key)) continue;
      for (let n = horizontal ? m.c1 : m.r1; n <= (horizontal ? m.c2 : m.r2); n++) {
        const cell = rows[horizontal ? fixed : n][horizontal ? n : fixed];
        cell.style = { ...cell.style, [key]: source[key],
          [`${key}Border`]: source[key] ? { ...(source[`${key}Border`] || { bs:source.bs, bc:source.bc }) } : null };
      }
    }
    const anchor = rows[m.r1][m.c1];
    if (m.r2 > m.r1 && Object.hasOwn(source,'bb')) { anchor.style.bb = false; anchor.style.bbBorder = null; }
    if (m.c2 > m.c1 && Object.hasOwn(source,'br')) { anchor.style.br = false; anchor.style.brBorder = null; }
  }
  if (spreadsheet && !snapshot && typeof plainText === 'string' && plainText !== '') {
    const plain = parseDelimited(plainText, '\t', { maxRows: rows.length, maxColumns: width, strict: true });
    if (plain?.length === rows.length && plain.every(row => row.length === width)) {
      // A merged range has one value. Nonempty covered positions indicate
      // that the two representations cannot describe the same cell geometry.
      const positions = anchors.length === rows.length * width ? null : new Set(anchors.map(([r, c]) => r * width + c));
      const matches = !positions || plain.every((row, r) => row.every((text, c) => positions.has(r * width + c) || text === ''));
      if (matches) for (const [r, c] of anchors) {
        const cell = rows[r][c];
        cell.text = plain[r][c];
        if (bare.has(cell)) {
          if (cell.text !== '' || bare.get(cell)) cell.value = cell.text;
          else delete cell.value;
        }
      }
    }
  }
  const values = readValues(rows.length, width);
  // Values this app captured at copy time are the cells' own: 00123 stays text, a number keeps its precision,
  // and a text marked with a bare x:str gets back the spaces the markup collapsed.
  if (values) rows.forEach((row, i) => row.forEach((cell, j) => {
    const v = values[i][j];
    // A verified value-only snapshot can recover HTML's NUL replacement and
    // CR/CRLF normalization, including copies parsed and serialized by a DOM.
    // Only restore values that agree after those specific transformations.
    const htmlNormalized = typeof v === 'string' && /[\0\r]/.test(v) && typeof cell.value === 'string'
      && cell.value.replace(/\r\n?/g, '\n') === v.replace(/\0/g, '\uFFFD').replace(/\r\n?/g, '\n');
    if ((cell.value === undefined || bare.has(cell) || htmlNormalized) && typeof v !== 'object') cell.value = v;
  }));
  for (const [r, c] of anchors) {
    const cell = rows[r][c];
    if (spreadsheet && !snapshot && (cell.value === undefined || bare.has(cell)) && cell.style?.fmt === 'custom') {
      // An untyped number such as 1212 must not become text "12" merely
      // because the code also has an @@ text section. Only invert text.
      const text = bare.has(cell) || cell.text.startsWith('=') || typeof cellFromInput(cell.text, cell.style)?.v === 'string';
      if (text) {
        const value = unformatTextWithCode(cell.text, cell.style.code);
        if (value !== undefined && value !== cell.text) cell.value = value;
      }
    }
    // Text format identifies a literal string. Excel copies formula results,
    // so an untyped Office display beginning with '=' is also text, not code.
    if (cell.value === undefined && cell.text !== '' && (cell.style?.fmt === 'text' || spreadsheet && cell.text.startsWith('='))) cell.value = cell.text;
  }
  const nativeSparklines = readSparklines(rows.length, width);
  if (nativeSparklines) {
    if (!copiedExternalLinksValid(sparklineFormulas(nativeSparklines), externalWorkbooks)) return { error: MISSING_EXTERNAL_LINKS };
    // Sparse native groups are independent of the smaller full-cell snapshot.
    // Derive scalar cells from the verified HTML, then use the ordinary cell
    // paste path for atomic native metadata, merges, tiling and paste specials.
    const cells = rows.map(row => Array(row.length).fill(null));
    for (const { i, j, cell } of cellsFromHtmlRows(rows)) cells[i][j] = cell;
    return { cells, nativeSparklines, ...(externalWorkbooks ? { externalWorkbooks } : {}), ...(values ? { values } : {}), ...(merges.length ? { merges } : {}) };
  }
  return { rows, ...(values ? { values } : {}), ...(merges.length ? { merges } : {}) };
}

/** Whether a style shows a number in some format of its own, rather than as General or as text. */
const formatsNumbers = (s) => !!s?.fmt && s.fmt !== 'general' && s.fmt !== 'text';

/**
 * Whether the date or time a cell's text parsed to names the same day of the year, or time of day, as a
 * typed serial: the text left the year out, as Sheets' "2 Jan" or "Jan-24" does, or the date, as "12:00" does.
 */
function namesSameMoment(serial, cell) {
  const kind = dateTimeKind(cell.s, cell.v);
  if (!kind) return false;
  const probe = { fmt: 'custom', code: kind === 'time' ? 'hh:mm:ss' : kind === 'date' ? 'mm-dd' : 'mm-dd hh:mm:ss' };
  return formatValue(serial, probe) === formatValue(cell.v, probe);
}

/**
 * Cells (for Workbook.setCells) from parsed HTML rows. The text is read as
 * typed input over the destination's style plus the pasted one; a cell
 * carrying a typed `value` keeps that value, with the number format the
 * text implies (12.3% stays a percent at full precision); one that is a
 * `link` becomes a native hyperlink on that value. With `values` (Paste
 * special → Values only) a cell is what it showed and no more: a link gives
 * its text alone and text that reads as a formula stays text.
 */
export function cellsFromHtmlRows(rows, existingStyleAt, { values = false } = {}) {
  const out = [];
  rows.forEach((row, i) => row.forEach(({ text, style, value, link, richText, numberStyle }, j) => {
    const prev = existingStyleAt?.(i, j);
    const base = style ? { ...(prev || {}), ...style } : prev;
    let cell = link && !values ? { v: text, f: null, s: base ? { ...base } : undefined }
      : cellFromInput(text, base, { typed: false });
    if (value === undefined && !link && text !== '' && style && (style.fmt === 'custom' || style.fmt === 'time')) {
      // External clock displays are expressed in the source format's units.
      // An explicit raw value (including literal text) always takes priority.
      const serial = unformatTimeWithCode(text, styleToNumFmt(style));
      if (serial !== undefined) cell = { v: serial ?? text, f: null, s: { ...base } };
    }
    if (values && cell?.f != null) cell = { v: text, f: null, s: base ? { ...base } : undefined };
    if (value !== undefined) {
      // A number keeps the format its text implies when the text is that number, rounded ("12.3%" for
      // 0.12345), or names the same day or time of day without the rest ("2 Jan" for 45293, as Sheets
      // shows a d mmm cell): the serial stays, shown as a date. Text that read as something else (" 1/2",
      // a date, for 0.5) formats nothing; text and booleans take the style as it stands.
      const number = typeof value === 'number';
      const implied = number && typeof cell?.v === 'number' && cell.s
        && Math.abs(cell.v - value) <= Math.max(Math.abs(value) * 0.01, 0.01);
      const dated = number && !implied && typeof cell?.v === 'number' && !formatsNumbers(base) && namesSameMoment(value, cell);
      // A number whose shown text reads otherwise here takes the format its source named (LibreOffice's sdnum).
      const named = number && !implied && !dated && numberStyle && !formatsNumbers(base) ? { ...(base || {}), ...numberStyle } : null;
      const s = implied || dated ? cell.s : named || (base ? { ...base } : undefined);
      // Text a number's own format made, "Tuesday" or "Q1 2024", with no format here to show the number
      // by, stays the text it reads as rather than the bare serial 45293.
      const wordy = number && !implied && !dated && typeof cell?.v === 'string' && !formatsNumbers(s);
      // An explicitly typed empty string is a stored value (ISBLANK is false),
      // unlike an untyped empty HTML cell, which clears the destination.
      if (!wordy) cell = value == null ? (s ? { v: null, f: null, s } : null) : { v: value, f: null, s };
    }
    // Text on several lines wraps, as lines added with Alt+Enter do, so the row can show them all.
    if (cell && cell.f == null && typeof cell.v === 'string' && cell.v.includes('\n') && cell.s?.wrap == null) cell = { ...cell, s: { ...(cell.s || {}), wrap: true } };
    if (cell && link && !values) cell.hyperlink = link;
    if (cell && !values && richText) {
      const runs = normalizeRichText(richText, cell.f != null && link ? text : cell.v);
      if (runs) cell.richText = runs;
    }
    out.push({ i, j, cell });
  }));
  return out;
}
