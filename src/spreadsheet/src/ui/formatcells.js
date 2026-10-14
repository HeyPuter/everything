import { fontColorCss, sameFontColor } from '../core/font-color.js';
import { fillColorCss } from '../core/fill-color.js';
/**
 * Format cells dialog (Ctrl/Cmd+Shift+F): number format, alignment, font,
 * borders, and fill for the selection in one place, with a preview of the
 * active cell. Only the fields that were changed are applied, as one undo
 * step.
 */

import { el, fieldId, isComposing } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { FORMATS, formatEntry, POINT_SIZES, ptToPx, pxToPt, FILL_COLORS } from './toolbar.js';
import { formatValue, currencyFormatLabel, currencyAffixes, currencyDecimals, FONTS, fontName, fontStack, fontKeyFor, borderCss, CURRENCIES, MAX_DECIMAL_PLACES, AUTOMATIC_FORMAT } from '../core/format.js';
import { formatWithCode, formatCodeError, codeColor } from '../core/numfmt.js';
import { BORDER_EDGES, readBorderEdges, penSignature } from './border-draft.js';
import { orientationControl } from './orientation.js';
import { lineStylePicker, edgeGlyph, presetGlyph } from './border-picker.js';
import { swatchGrid } from './swatch-grid.js';
import { themeColorGrid, workbookTheme } from '../core/workbook-theme.js';

const PANELS = [['number', 'Number'], ['align', 'Alignment'], ['font', 'Font'], ['border', 'Border'], ['fill', 'Fill'], ['protect', 'Protection']];
const CATEGORIES = FORMATS.filter((f) => f.value !== 'date-medium');
// The day the number-format menu samples too, so the two controls for the same setting show the same date.
const SAMPLE_DAY = FORMATS.find((f) => f.value === 'date').sample;
/** A line under the Number tab's options saying what the chosen category does. */
const CATEGORY_NOTES = {
  general: 'No particular format: numbers, dates and text show as they were entered.',
  number: 'Plain numbers, with a set count of decimals, an optional thousands separator and a style for negatives.',
  currency: 'Amounts with a currency label beside the digits.',
  accounting: 'Amounts with the currency label at the left edge of the cell, so the decimals line up down a column.',
  date: 'Day numbers shown as calendar dates. The style follows the regional format.',
  time: 'The time of day a value holds.',
  percent: 'The value multiplied by 100, with a percent sign.',
  fraction: 'Decimals shown as the closest simple fraction.',
  scientific: 'Numbers as a value between 1 and 10 times a power of ten, such as 1.23E+04.',
  text: 'Entries are kept exactly as typed, even ones that look like numbers or dates.',
  duration: 'Elapsed time in hours, minutes and seconds, counting on past 24 hours.',
  datetime: 'A calendar date and a time of day together.',
  custom: 'Write a format code of your own; the preview follows as you type.',
};
const DATE_STYLE_NAMES = [['iso', 'year first'], ['medium', 'written out'], ['long', 'written out in full']];
/**
 * The date styles, each shown as the date it produces. Built when the dialog opens, so the samples read
 * under the regional format in force as the number-format menu's do, rather than fixed en-US strings that
 * offered "Aug 27, 2026" on a cell that would show 27.08.2026. Where a regional format writes two of them
 * the same (French and 中文 write both out alike), each is named, so the rows stay tellable apart.
 */
function dateStyles() {
  const samples = DATE_STYLE_NAMES.map(([key]) => formatValue(SAMPLE_DAY, { fmt: 'date', dateStyle: key }));
  return DATE_STYLE_NAMES.map(([key, name], i) => [key,
    samples.indexOf(samples[i]) === samples.lastIndexOf(samples[i]) ? samples[i] : `${samples[i]} (${name})`]);
}

const isHex = (s) => /^#[0-9a-f]{6}$/i.test(s || '');

export const NEGATIVE_STYLES = [['minus', '-1,234.50'], ['red', '-1,234.50 in red'], ['paren', '(1,234.50)'], ['redparen', '(1,234.50) in red']];

/** The decimals a category shows when the style names none: the currency's own count, else two. */
const defaultDecimals = (category, cur) => (category === 'currency' ? currencyDecimals(cur) : 2);

/**
 * The format code for a number or currency shown with a negative style other than a plain minus. The
 * label sits on the side of the digits the regional format puts it, with that format's own spacing
 * (currencyAffixes), so this code's positive section is character for character what styleToNumFmt
 * writes for the same cell: asking for parentheses on negatives cannot move the symbol, which under
 * Deutsch turned a cell reading 1.234,50 € into €1.234,50.
 */
export function negativeCode({ category, dec, group, cur, neg }) {
  const d = dec == null ? defaultDecimals(category, cur) : Math.max(0, Math.min(MAX_DECIMAL_PLACES, dec));
  const digits = `${group === false ? '0' : '#,##0'}${d > 0 ? `.${'0'.repeat(d)}` : ''}`;
  const { prefix, suffix } = category === 'currency' ? currencyAffixes(cur) : { prefix: '', suffix: '' };
  const pos = `${prefix ? `"${prefix}"` : ''}${digits}${suffix ? `"${suffix}"` : ''}`;
  const body = neg === 'paren' || neg === 'redparen' ? `(${pos})` : `-${pos}`;
  return `${pos};${neg === 'red' || neg === 'redparen' ? '[Red]' : ''}${body}`;
}

/**
 * Read a code negativeCode produced back into its options, or null for any other code. The label is
 * taken from either side of the digits: this app writes it where the regional format puts it, and a
 * file from elsewhere carries the layout of the format it was saved under — a German Excel writes
 * #,##0.00" €";("#,##0.00" €"), which belongs under Currency with a negative style, not under Custom.
 */
export function negativeStyleFor(code) {
  const m = /^(?:"([^"]*)")?(#,##0|0)(?:\.(0+))?(?:"([^"]*)")?;(\[Red\])?(-|\()(?:"([^"]*)")?(#,##0|0)(?:\.(0+))?(?:"([^"]*)")?(\))?$/.exec(code || '');
  if (!m) return null;
  const [, pre, digits, decs, post, red, open, pre2, digits2, decs2, post2, close] = m;
  if (pre !== pre2 || post !== post2 || digits !== digits2 || decs !== decs2 || (open === '(') !== (close === ')')) return null;
  // One side or the other, never both: a currency format writes its label on a single side of the digits.
  if (pre != null && post != null) return null;
  // Higher precision stays in the custom-code editor; numeric controls
  // cannot represent it without truncating the imported format.
  if ((decs?.length || 0) > MAX_DECIMAL_PLACES) return null;
  // The label is matched without the spacing the side it sits on carries, so the same currency is read
  // whichever regional format wrote the code. Prefer distinct labels for new formats; still recognize
  // older codes that used the currency picker's short, sometimes shared symbols.
  const sym = (pre ?? post) == null ? null : (pre ?? post).trim();
  const cur = sym == null ? null : CURRENCIES.find(([code]) => currencyFormatLabel(code).trim() === sym)?.[0]
    || CURRENCIES.find(([, , symbol]) => symbol === sym)?.[0];
  if (sym != null && !cur) return null;
  return {
    category: sym == null ? 'number' : 'currency', dec: decs ? decs.length : 0, group: digits === '#,##0', cur: cur || 'USD',
    neg: open === '(' ? (red ? 'redparen' : 'paren') : red ? 'red' : 'minus',
  };
}

/** The number-format fields a chosen category and its options produce. */
export function numberPatch({ category, dec, group, cur, dateStyle, code, neg = 'minus' }) {
  const entry = CATEGORIES.find((f) => f.value === category) || CATEGORIES[0];
  // Every detail of the previous format goes (seconds included), so none is left to shape a later entry.
  const base = { ...AUTOMATIC_FORMAT };
  if (entry.value === 'general' || entry.value === 'text') return { ...base, ...entry.patch };
  if ((entry.value === 'number' || entry.value === 'currency') && neg && neg !== 'minus') return { ...base, fmt: 'custom', code: negativeCode({ category: entry.value, dec, group, cur, neg }) };
  if (entry.value === 'custom') return { ...base, fmt: 'custom', code: code || '0' };
  if (entry.patch?.fmt === 'custom') return { ...base, ...entry.patch };
  const out = { ...base, ...entry.patch };
  if (['number', 'currency', 'percent', 'scientific'].includes(entry.value)) {
    out.dec = dec == null ? null : Math.max(0, Math.min(MAX_DECIMAL_PLACES, dec));
    out.group = group === false ? false : null;
  }
  if (entry.value === 'currency') out.cur = cur && cur !== 'USD' ? cur : null;
  if (entry.value === 'date' || entry.value === 'datetime') out.dateStyle = dateStyle && dateStyle !== 'iso' ? dateStyle : null;
  // The dialog has no seconds control: a cell that shows them keeps them under Time and Date and time; every other category clears them.
  if (entry.value === 'time' || entry.value === 'datetime') delete out.sec;
  return out;
}

/**
 * `style` and `onApply` drive the dialog over a style that belongs to no cell (a named cell style's Format…): the
 * dialog starts from that style, as one cell with its edges, and hands its result ({ patch, border | borders })
 * to `onApply` instead of formatting the selection. `title` names the dialog then.
 */
export function openFormatCellsDialog(ctx, { panel = 'number', style: draftStyle = null, onApply = null, title = 'Format Cells' } = {}) {
  if (ctx.grid?.editing && !draftStyle) ctx.grid.commitEdit();
  const style = draftStyle || ctx.style();
  const selection = draftStyle ? { r1: 0, r2: 0, c1: 0, c2: 0 } : ctx.range?.() || { r1: 0, r2: 0, c1: 0, c2: 0 };
  const value = draftStyle ? null : ctx.wb.getValue(ctx.sheetId(), ctx.active().r, ctx.active().c);
  const current = formatEntry(style);
  const negative = style.fmt === 'custom' ? negativeStyleFor(style.code) : null;
  const state = {
    category: negative ? negative.category : current.value === 'date-medium' ? 'date' : current.value,
    dec: negative ? negative.dec : style.dec ?? null,
    group: negative ? negative.group : style.group !== false,
    cur: negative ? negative.cur : style.cur || 'USD',
    dateStyle: style.dateStyle || 'iso',
    // The cell's own code, kept when the Number category can also show it, so Custom shows it too.
    code: style.fmt === 'custom' ? style.code || '' : '',
    neg: negative ? negative.neg : 'minus',
  };
  const select = (label, options, value, onchange, listSize = null) => {
    const sel = el('select.select', { 'aria-label': label, size: listSize, onchange: () => onchange(sel.value) }, options.map(([v, text]) => el('option', { value: v, selected: String(v) === String(value) }, text)));
    return el(`label.field${listSize ? '.fc-list' : ''}`, {}, el('span.field-label', {}, label), el('div.select-wrap', {}, sel));
  };
  const checkbox = (label, checked, onchange) => {
    const id = fieldId('fc');
    const input = el('input', { type: 'checkbox', id, checked, onchange: () => onchange(input.checked) });
    return el('label.find-option', { for: id }, input, el('span', {}, label));
  };
  const numberInput = (label, value, min, max, onchange) => {
    const input = el('input.input', { type: 'number', min, max, step: 1, value: value ?? '', 'aria-label': label, oninput: () => {
      // A value past the limits is clamped; the field shows the value the preview and Apply use.
      let v = input.value === '' ? null : Number(input.value);
      if (v != null && (v < min || v > max)) { v = Math.max(min, Math.min(max, v)); input.value = String(v); }
      onchange(v);
    } });
    return el('label.field', {}, el('span.field-label', {}, label), input);
  };

  /* ---- Number ---- */
  const preview = el('div.numfmt-preview', { 'aria-live': 'polite' });
  const sample = value == null || value === '' ? 1234.5 : value;
  // A style without its own count shows two places in every category, percent included, except a currency without a minor
  // unit (the yen shows none), so the field reads what the preview and Apply use.
  const decField = numberInput('Decimal places', state.dec ?? defaultDecimals(state.category, state.cur), 0, MAX_DECIMAL_PLACES, (v) => { state.dec = v == null ? v : Math.max(0, Math.min(MAX_DECIMAL_PLACES, Math.round(v))); refreshNumber(); });
  const decInput = decField.querySelector('input');
  const groupField = checkbox('Thousands separator', state.group, (v) => { state.group = v; refreshNumber(); });
  const curField = select('Currency', CURRENCIES.map(([code, name, symbol]) => [code, `${name} (${symbol})`]), state.cur, (v) => { state.cur = v; refreshNumber({ syncDec: true }); });
  const dateField = select('Date style', dateStyles(), state.dateStyle, (v) => { state.dateStyle = v; refreshNumber(); });
  const negField = select('Negative numbers', NEGATIVE_STYLES, state.neg, (v) => { state.neg = v; refreshNumber(); }, 4);
  // A malformed code ('"', '[', 'E+') would blank every number: Apply refuses it and says why beside the field.
  const codeErrorId = fieldId('fc-code');
  const codeError = el('p.field-error', { id: codeErrorId, hidden: true, role: 'alert' });
  const codeInput = el('input.input', { type: 'text', value: state.code, placeholder: '#,##0.00 "kg"', 'aria-label': 'Format code', spellcheck: false, autocomplete: 'off', 'aria-describedby': codeErrorId, oninput: () => {
    state.code = codeInput.value;
    // A changed code is no longer the one refused: the mark and the message go until the next Apply.
    codeError.hidden = true;
    codeInput.removeAttribute('aria-invalid');
    refreshNumber();
  } });
  const codeField = el('label.field.fc-code', {}, el('span.field-label', {}, 'Format code'), codeInput, codeError, el('span.field-hint', {}, 'Sections positive;negative;zero, digits 0 # ?, %, dates like d mmm yyyy'));
  const categorySel = select('Category', CATEGORIES.map((f) => [f.value, f.label]), state.category, (v) => { state.category = v; refreshNumber({ syncDec: true }); }, CATEGORIES.length);
  categorySel.classList.add('fc-category');
  // `syncDec` after a Category or Currency change: a cell with no count of its own follows the new
  // category's default, so the field is rewritten to keep reading what the preview and Apply use.
  // The field's own edits never resync it, so clearing it to mean "the default" stays possible.
  function refreshNumber({ syncDec = false } = {}) {
    const c = state.category;
    if (syncDec && state.dec == null) decInput.value = String(defaultDecimals(c, state.cur));
    decField.hidden = !['number', 'currency', 'percent', 'scientific'].includes(c);
    groupField.hidden = !['number', 'currency', 'percent'].includes(c);
    curField.hidden = c !== 'currency';
    negField.hidden = !['number', 'currency'].includes(c);
    dateField.hidden = c !== 'date' && c !== 'datetime';
    codeField.hidden = c !== 'custom';
    categoryNote.textContent = CATEGORY_NOTES[c] || '';
    const patch = numberPatch(state);
    let text;
    try { text = c === 'custom' && formatCodeError(state.code) ? '' : formatValue(sample, { ...style, ...patch }); } catch { text = ''; }
    preview.textContent = text ? `Preview: ${text}` : 'Preview';
    preview.style.color = text && patch.fmt === 'custom' && patch.code ? codeColor(sample, patch.code, ctx.wb.colorPalette) || 'var(--ink)' : 'var(--ink)';
    if (['number', 'currency'].includes(c)) for (const option of negField.querySelector('select').options) {
      const example = formatWithCode(-1234.5, negativeCode({ ...state, neg: option.value }));
      const red = option.value === 'red' || option.value === 'redparen';
      option.textContent = `${example}${red ? ' in red' : ''}`;
      option.style.color = red ? '#ff0000' : 'var(--ink)';
    }
  }
  const categoryNote = el('p.fc-category-note');
  const numberPanel = el('div.fc-panel.fc-number', {}, categorySel,
    el('div.fc-number-options', {}, preview, decField, curField, groupField, negField, dateField, codeField, categoryNote));

  /* ---- Alignment ---- */
  const align = { align: style.align || '', valign: style.valign || 'middle', wrap: style.wrap ? 'wrap' : style.clip ? 'clip' : 'overflow', indent: style.indent || 0, rot: style.rot || 0, shrink: !!style.shrink };
  const rotationField = numberInput('Rotation (degrees, -90 to 90)', align.rot, -90, 90, (v) => {
    align.rot = Math.max(-90, Math.min(90, v || 0)); orientation.update(align.rot);
  });
  rotationField.querySelector('.field-label').textContent = 'Degrees';
  const rotationInput = rotationField.querySelector('input');
  const orientation = orientationControl(align.rot, value => {
    align.rot = value; rotationInput.value = String(value); refreshAppearance();
  });
  const shrinkField = checkbox('Shrink to fit', align.shrink, value => { align.shrink = value; });
  const shrinkInput = shrinkField.querySelector('input');
  const alignPanel = el('div.fc-panel.fc-align', {},
    el('fieldset.fc-align-fields', {}, el('legend', {}, 'Text alignment'),
      select('Horizontal', [['', 'Automatic (numbers right, text left)'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']], align.align, (v) => { align.align = v; }),
      select('Vertical', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], align.valign, (v) => { align.valign = v; }),
      select('Text wrapping', [['overflow', 'Overflow into empty cells'], ['wrap', 'Wrap onto several lines'], ['clip', 'Clip at the cell edge']], align.wrap, (v) => { align.wrap = v; }),
      numberInput('Indent', align.indent, 0, 10, (v) => { align.indent = Math.max(0, Math.min(10, Math.round(v || 0))); }), shrinkField),
    el('fieldset.fc-orientation', {}, el('legend', {}, 'Orientation'), orientation.node, rotationField,
      el('button.btn.btn-ghost', { type: 'button', disabled: true, title: 'Stacked vertical text is not supported' }, 'Vertical text')));

  /* ---- Font ---- */
  const font = { font: style.font || 'default', size: style.size || 13, bold: !!style.bold, italic: !!style.italic, underline: !!style.underline, strike: !!style.strike, color: style.color || '', auto: !style.color || style.color === 'windowtext' };
  // A size or font the lists do not carry (from an imported file, say) is listed as the cell has it,
  // so the tab reports the cell rather than the first entry, and picking that entry is a change.
  const sizePt = pxToPt(font.size);
  const sizes = POINT_SIZES.includes(sizePt) ? POINT_SIZES : [...POINT_SIZES, sizePt].sort((a, b) => a - b);
  const fonts = FONTS.some(([key]) => key === font.font) ? FONTS : [...FONTS, [font.font, fontName(font.font) || font.font]];
  const colorInput = el('input.chart-color-input', { type: 'color', value: isHex(fontColorCss(font.color)) ? fontColorCss(font.color) : '#0b0b0b', 'aria-label': 'Text color', oninput: () => { font.color = colorInput.value; font.auto = false; autoColor.querySelector('input').checked = false; } });
  // Unchecking a none or automatic box with the swatch untouched means the colour the swatch shows;
  // an empty colour would read as none or automatic again, and Apply would change nothing.
  const autoColor = checkbox('Automatic color', font.auto, (v) => { font.auto = v; if (!v && (!font.color || font.color === 'windowtext')) font.color = colorInput.value; });
  const { alert: fontError, refuse: refuseFont, clear: clearFontError } = fieldAlert('fc-font');
  const resolveFont = value => fonts.find(([, label]) => label.toLowerCase() === value.trim().toLowerCase())?.[0]
    || fontKeyFor(value, { literal: true });
  const fontNameInput = el('input.input', { type: 'text', 'aria-label': 'Font name', autocomplete: 'off', spellcheck: false, maxlength: 255,
    value: fonts.find(([key]) => key === font.font)?.[1] || fontName(font.font) || 'Default', oninput: () => {
      const key = resolveFont(fontNameInput.value);
      if (key) { font.font = key; fontList.value = key; }
    } });
  const fontField = select('Font', fonts.map(([key, label]) => [key, label]), font.font, value => {
    font.font = value; fontNameInput.value = fonts.find(([key]) => key === value)?.[1] || ''; clearFontError();
  }, 8);
  const fontList = fontField.querySelector('select');
  fontField.insertBefore(fontNameInput, fontField.querySelector('.select-wrap'));
  for (const option of fontList.options) option.style.fontFamily = fontStack(option.value) || '';

  // Sizes are shown and typed in points (1 to 409); the draft keeps pixels.
  const sizeInput = el('input.input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Font size', autocomplete: 'off', value: String(sizePt),
    oninput: () => {
      const text = sizeInput.value.trim(), size = Number(text);
      if (/^\d+(?:\.\d+)?$/.test(text) && size >= 1 && size <= 409) { font.size = size === sizePt ? font.size : ptToPx(size); sizeList.value = String(size); }
    } });
  const sizeField = select('Size', sizes.map(size => [size, String(size)]), sizePt, value => {
    font.size = Number(value) === sizePt ? (style.size || 13) : ptToPx(Number(value)); sizeInput.value = value; clearFontError();
  }, 8);
  const sizeList = sizeField.querySelector('select');
  sizeField.insertBefore(sizeInput, sizeField.querySelector('.select-wrap'));
  const fontStyleField = select('Font style', [['regular', 'Regular'], ['italic', 'Italic'], ['bold', 'Bold'], ['bolditalic', 'Bold Italic']],
    font.bold ? font.italic ? 'bolditalic' : 'bold' : font.italic ? 'italic' : 'regular', value => {
      font.bold = value.includes('bold'); font.italic = value.includes('italic');
      boldCheck.querySelector('input').checked = font.bold; italicCheck.querySelector('input').checked = font.italic;
    }, 4);
  const fontStyleList = fontStyleField.querySelector('select');
  const syncFontStyle = () => { fontStyleList.value = font.bold ? font.italic ? 'bolditalic' : 'bold' : font.italic ? 'italic' : 'regular'; };
  const boldCheck = checkbox('Bold', font.bold, value => { font.bold = value; syncFontStyle(); });
  const italicCheck = checkbox('Italic', font.italic, value => { font.italic = value; syncFontStyle(); });
  const fontPanel = el('div.fc-panel.fc-font', {},
    el('div.fc-font-choices', {}, fontField, fontStyleField, sizeField),
    el('div.check-group', {}, boldCheck, italicCheck,
      checkbox('Underline', font.underline, (v) => { font.underline = v; }),
      checkbox('Strikethrough', font.strike, (v) => { font.strike = v; })),
    el('div.row', {}, el('label.chart-color', {}, colorInput, el('span', {}, 'Text color')), autoColor), fontError);


  /* ---- Border ---- */
  // Pick a line and a colour, then click a preset, an edge of the diagram or a button beside it: each click
  // draws that edge with the chosen line, or takes it off when it already wears that line. Nothing changes
  // until OK, and the edges no click touched are left as the cells have them.
  const border = { style: style.bs || 'thin', color: style.bc || '', auto: !style.bc };
  const originalEdges = readBorderEdges(draftStyle ? { styleAt: () => style, mergesIn: () => [] } : ctx.wb, ctx.sheetId?.(), selection);
  let edges = new Map(originalEdges), customEdges = false, baseBorder = null;
  const edgeActions = new Map(), edgeButtons = new Map();
  const currentPen = () => ({ style: border.style, color: border.auto ? null : border.color || null });
  const action = kind => ({ kind, ...currentPen(), perSide: true });
  function syncEdgeButtons() {
    for (const [kind, button] of edgeButtons) {
      const edge = edges.get(kind);
      button.setAttribute('aria-pressed', String(edge.on));
      button.disabled = edge.disabled;
    }
  }
  function paintEdge(kind) {
    const edge = edges.get(kind);
    if (edge.disabled) return;
    customEdges = true;
    const remove = edge.on === true && penSignature(edge.pen) === penSignature(currentPen());
    edgeActions.set(kind, { ...action(kind), remove });
    edges.set(kind, { ...edge, on: !remove, pen: remove ? null : currentPen() });
    syncEdgeButtons(); refreshAppearance();
  }
  function presetEdges(kind) {
    customEdges = true;
    if (kind === 'none') {
      baseBorder = { kind: 'none' }; edgeActions.clear();
      for (const [key, edge] of edges) edges.set(key, { ...edge, on: false, pen: null });
    } else for (const key of kind === 'outer' ? ['top', 'bottom', 'left', 'right'] : ['horizontal', 'vertical']) {
      const edge = edges.get(key);
      if (!edge.disabled) { edgeActions.set(key, action(key)); edges.set(key, { ...edge, on: true, pen: currentPen() }); }
    }
    syncEdgeButtons(); refreshAppearance();
  }
  // The line samples are drawn in the colour they will paint.
  const syncPenColor = () => { lineStyles.style.color = border.auto ? '' : border.color || ''; };
  const borderColor = el('input.chart-color-input', { type: 'color', value: isHex(border.color) ? border.color : '#0b0b0b', 'aria-label': 'Border color', oninput: () => { border.color = borderColor.value; border.auto = false; autoBorder.querySelector('input').checked = false; syncPenColor(); } });
  const autoBorder = checkbox('Default color', border.auto, (v) => { border.auto = v; if (!v && !border.color) border.color = borderColor.value; syncPenColor(); });
  const lineStyles = lineStylePicker({ label: 'Line style', value: border.style, onChange: (v) => { border.style = v; } });
  const presets = el('div.fc-border-presets', { role: 'group', 'aria-label': 'Border presets' },
    [['none', 'None', 'Take every border off'], ['outer', 'Outline', 'Draw the outside edges'], ['inner', 'Inside', 'Draw the lines between cells']].map(([kind, label, title]) => el('button.fc-preset', {
      type: 'button', title, disabled: kind === 'inner' && edges.get('horizontal').disabled && edges.get('vertical').disabled
        || kind === 'outer' && ['top', 'bottom', 'left', 'right'].every(key => edges.get(key).disabled),
      onclick: () => presetEdges(kind),
    }, el('span.fc-preset-glyph', { html: presetGlyph(kind) }), el('span.fc-preset-label', {}, label))));
  for (const [kind, label] of BORDER_EDGES) edgeButtons.set(kind, el('button.fc-edge', {
    type: 'button', 'aria-label': `${label} border`, title: label, 'aria-pressed': String(edges.get(kind).on),
    disabled: edges.get(kind).disabled, html: edgeGlyph(kind), onclick: () => paintEdge(kind),
  }));
  const diagonal = (kind, label) => el(`button.fc-edge.fc-edge-diagonal.fc-edge-${kind}`, {
    type: 'button', 'aria-label': `${label} border`, disabled: true, title: 'Diagonal borders are not supported', html: edgeGlyph(kind),
  });
  // The diagram: the edges of the selection drawn around a sample of its cells, with a button for each edge
  // beside the line it draws (top, between rows and bottom on the left; left, between columns and right below).
  const diagramSlot = el('div.fc-diagram-box');
  const diagram = el('div.fc-diagram', {},
    el('div.fc-diagram-rows', { role: 'group', 'aria-label': 'Row edges' }, ['top', 'horizontal', 'bottom'].map(k => edgeButtons.get(k))),
    diagramSlot,
    diagonal('diagonalUp', 'Diagonal up'),
    el('div.fc-diagram-cols', { role: 'group', 'aria-label': 'Column edges' }, ['left', 'vertical', 'right'].map(k => edgeButtons.get(k))),
    diagonal('diagonalDown', 'Diagonal down'));
  const borderPanel = el('div.fc-panel.fc-border', {},
    el('fieldset.fc-group.fc-border-line', {}, el('legend', {}, 'Line'),
      el('span.field-label', {}, 'Style'), lineStyles,
      el('span.field-label', {}, 'Color'),
      el('div.fc-color-row', {}, el('label.chart-color', {}, borderColor, el('span', {}, 'Border color')), autoBorder)),
    el('div.fc-border-edges', {},
      el('span.field-label', {}, 'Presets'), presets,
      el('span.field-label', {}, 'Border'), diagram,
      el('p.field-hint', {}, 'Pick a line, then click a preset, an edge of the diagram or a button beside it. An edge that already has that line comes off.')));

  /* ---- Fill ---- */
  // The theme's colours and their tints, the standard fills, or any other colour; the sample shows the pick.
  const fill = { bg: style.bg || '', none: !style.bg };
  const fillCss = fillColorCss(fill.bg);
  const pickFill = (value) => {
    fill.bg = value; fill.none = false; noFill.querySelector('input').checked = false;
    const css = fillColorCss(value);
    if (isHex(css)) fillColor.value = css.toLowerCase();
    syncFillSwatches(); refreshAppearance();
  };
  const fillChosen = (value) => !fill.none && !!fill.bg && (typeof value === 'object'
    ? typeof fill.bg === 'object' && sameFontColor(fill.bg, value)
    : typeof fill.bg === 'string' && fill.bg.toLowerCase() === value);
  const fillColor = el('input.chart-color-input', { type: 'color', value: isHex(fillCss) ? fillCss : '#fef3c7', 'aria-label': 'Fill color', oninput: () => { fill.bg = fillColor.value; fill.none = false; noFill.querySelector('input').checked = false; syncFillSwatches(); } });
  const noFill = checkbox('No fill', fill.none, (v) => { fill.none = v; if (!v && !fill.bg) fill.bg = fillColor.value; syncFillSwatches(); });
  const themeFills = swatchGrid({ label: 'Theme fill colors', cols: 10, isChosen: fillChosen, onPick: pickFill,
    colors: themeColorGrid(workbookTheme(ctx.wb).colors).flat().map(cell => ({ value: cell.color, css: cell.color.rgb, label: cell.label })) });
  const standardFills = swatchGrid({ label: 'Standard fill colors', cols: 12, isChosen: fillChosen, onPick: pickFill,
    colors: FILL_COLORS.map(hex => ({ value: hex, css: hex, label: hex })) });
  const syncFillSwatches = () => { themeFills.sync(); standardFills.sync(); };
  const fillPanel = el('div.fc-panel.fc-fill', {},
    el('div.fc-fill-colors', {},
      el('span.field-label', {}, 'Background color'), noFill,
      el('span.fc-swatch-head', {}, 'Theme colors'), themeFills,
      el('span.fc-swatch-head', {}, 'Standard colors'), standardFills,
      el('label.chart-color', {}, fillColor, el('span', {}, 'Custom color…'))));
  // Protection: Locked (every cell is, until unchecked) and Hidden (the formula), which take effect once the sheet is protected.
  const prot = { locked: style.locked !== false, hidden: style.formulaHidden === true };
  const protectPanel = el('div.fc-panel.fc-protection', {},
    checkbox('Locked', prot.locked, (v) => { prot.locked = v; }),
    checkbox('Hidden', prot.hidden, (v) => { prot.hidden = v; }),
    el('p.field-hint', {}, 'Locking cells or hiding formulas has no effect until you protect the sheet (Review ▸ Protect sheet).'));

  // These are draft previews, never workbook edits. Number formatting and
  // appearance changes remain one existing applyFormat command on submission.
  const appearances = new Map();
  // The border diagram shows a sample per cell of the selection's shape (one, a row or a column of two, or
  // two by two), so the lines between cells have cells to run between.
  const sampleRows = selection.r2 > selection.r1 ? 2 : 1, sampleCols = selection.c2 > selection.c1 ? 2 : 1;
  for (const [key, label, p] of [['align', 'Alignment', alignPanel], ['font', 'Font', fontPanel], ['border', 'Border', borderPanel], ['fill', 'Fill', fillPanel]]) {
    if (key === 'border') {
      const samples = el('div.fc-border-samples', { style: { gridTemplateColumns: `repeat(${sampleCols}, 1fr)`, gridTemplateRows: `repeat(${sampleRows}, 1fr)` } },
        Array.from({ length: sampleRows * sampleCols }, () => el('span.fc-border-sample')));
      const box = el('div.fc-appearance.fc-border-interactive.sheet-paper', { 'aria-label': `${label} preview` }, samples);
      for (const [kind, edgeLabel] of BORDER_EDGES) box.append(el(`button.fc-border-hit.fc-border-hit-${kind}`, {
        type: 'button', 'aria-label': `Preview: ${edgeLabel} border`, disabled: edges.get(kind).disabled, tabIndex: -1,
        onclick: () => paintEdge(kind),
      }));
      diagramSlot.append(box);
      appearances.set(key, { box, text: samples, samples: true });
      continue;
    }
    const text = el('span.fc-preview-text');
    const box = el('div.fc-appearance.sheet-paper', { 'aria-label': `${label} preview` }, text);
    p.append(el('fieldset.fc-preview', {}, el('legend', {}, 'Preview'), box));
    appearances.set(key, { box, text });
  }
  function refreshAppearance() {
    shrinkInput.disabled = align.wrap === 'wrap';
    shrinkInput.title = shrinkInput.disabled ? 'Turn off wrapping to shrink text' : '';
    let text, sectionColor;
    const formatted = { ...style, ...numberPatch(state) };
    try {
      text = state.category === 'custom' && formatCodeError(state.code) ? '' : formatValue(sample, formatted);
      sectionColor = formatted.fmt === 'custom' ? codeColor(sample, formatted.code, ctx.wb.colorPalette) : null;
    } catch { text = ''; }
    for (const [key, preview] of appearances) {
      const { box, text: node, samples } = preview;
      if (samples) for (const cell of node.children) cell.textContent = text;
      else node.textContent = text;
      box.style.backgroundColor = fill.none ? 'var(--surface)' : fillColorCss(fill.bg) || 'var(--surface)';
      node.style.color = sectionColor || (font.auto ? fontColorCss('windowtext') : fontColorCss(font.color));
      node.style.fontFamily = fontStack(font.font) || 'var(--font)';
      // The diagram's samples keep to the cells they sit in; the other previews show the size chosen.
      node.style.fontSize = samples ? `${Math.min(font.size, 16)}px` : `${font.size}px`;
      node.style.fontWeight = font.bold ? '600' : '400';
      node.style.fontStyle = font.italic ? 'italic' : 'normal';
      node.style.textDecorationLine = [font.underline && 'underline', font.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
      if (!samples) {
        const horizontal = align.align || (typeof sample === 'number' ? 'right' : 'left');
        box.style.justifyContent = { left: 'flex-start', center: 'center', right: 'flex-end' }[horizontal];
        box.style.alignItems = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[align.valign];
        node.style.textAlign = horizontal;
        node.style.whiteSpace = align.wrap === 'wrap' ? 'pre-wrap' : 'pre';
        node.style.overflow = align.wrap === 'overflow' ? 'visible' : 'hidden';
        node.style.paddingLeft = `${align.indent * 12}px`;
        if (align.shrink && align.wrap !== 'wrap' && node.scrollWidth > 0) {
          const css = getComputedStyle(box);
          const room = box.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0) - align.indent * 12;
          const radians = Math.abs(align.rot) * Math.PI / 180;
          const extent = node.scrollWidth * Math.cos(radians) + font.size * 1.2 * Math.sin(radians);
          if (room > 0 && extent > room) node.style.fontSize = `${font.size * room / extent}px`;
        }
        node.style.transform = align.rot ? `rotate(${-align.rot}deg)` : '';
      }
      // The diagram shows the edges as drafted, else as the selection has them; the other previews show the
      // drafted edges once there are any, else the active cell's own.
      const shown = customEdges ? edges : key === 'border' ? originalEdges : null;
      for (const [side, flag, kind] of [['Top', 'bt', 'top'], ['Bottom', 'bb', 'bottom'], ['Left', 'bl', 'left'], ['Right', 'br', 'right']]) {
        const draft = shown?.get(kind);
        const enabled = draft ? draft.on !== false : style[flag];
        const paint = borderCss(draft ? { bs: draft.pen?.style || 'dotted', bc: draft.pen?.color } : style[`${flag}Border`] || style);
        box.style[`border${side}Width`] = enabled ? paint.width : '1px';
        box.style[`border${side}Style`] = enabled ? paint.style : 'solid';
        box.style[`border${side}Color`] = enabled ? paint.color || 'var(--ink)' : 'var(--grid)';
      }
      for (const [kind, cls, variable] of [['horizontal', 'fc-preview-inside-rows', '--preview-horizontal'], ['vertical', 'fc-preview-inside-cols', '--preview-vertical']]) {
        const edge = key === 'border' ? shown.get(kind) : null;
        box.classList.toggle(cls, !!edge && edge.on !== false && !edge.disabled);
        const paint = borderCss({ bs: edge?.pen?.style || 'dotted', bc: edge?.pen?.color });
        box.style.setProperty(variable, `${paint.width} ${paint.style} ${paint.color || 'var(--ink)'}`);
      }
    }
  }

  /* ---- Tabs ---- */
  const panels = { number: numberPanel, align: alignPanel, font: fontPanel, border: borderPanel, fill: fillPanel, protect: protectPanel };
  let active = panels[panel] ? panel : 'number';
  const tabId = fieldId('format-tabs');
  for (const [key, p] of Object.entries(panels)) {
    p.id = `${tabId}-${key}-panel`;
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', `${tabId}-${key}`);
  }
  const tabs = el('div.seg.fc-tabs', { role: 'tablist', 'aria-label': 'Formatting categories' }, PANELS.map(([key, label]) => el('button.seg-btn', {
    type: 'button', role: 'tab', id: `${tabId}-${key}`, dataset: { key }, 'aria-selected': String(key === active),
    'aria-controls': panels[key].id, tabindex: key === active ? 0 : -1,
    onclick: () => { active = key; syncTabs(); },
  }, label)));
  function syncTabs() {
    for (const b of tabs.children) {
      b.setAttribute('aria-selected', String(b.dataset.key === active));
      b.tabIndex = b.dataset.key === active ? 0 : -1;
    }
    for (const [key, p] of Object.entries(panels)) p.hidden = key !== active;
    tabs.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    refreshAppearance();
  }
  tabs.addEventListener('keydown', (e) => {
    const current = [...tabs.children].indexOf(e.target);
    if (current < 0) return;
    if (isComposing(e) || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      panels[active].querySelector('select, input')?.focus();
      return;
    }
    let next;
    if (e.key === 'ArrowRight') next = (current + 1) % PANELS.length;
    else if (e.key === 'ArrowLeft') next = (current + PANELS.length - 1) % PANELS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = PANELS.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    active = PANELS[next][0];
    syncTabs();
    tabs.children[next].focus();
  });

  /** What changed, as a style patch (null clears a field) plus an optional border action. */
  function collect() {
    const patch = {};
    const numberNow = numberPatch(state);
    const numberBefore = numberPatch({ category: negative ? negative.category : current.value === 'date-medium' ? 'date' : current.value, dec: negative ? negative.dec : style.dec ?? null, group: negative ? negative.group : style.group !== false, cur: negative ? negative.cur : style.cur || 'USD', dateStyle: style.dateStyle || 'iso', code: style.fmt === 'custom' ? style.code || '' : '', neg: negative ? negative.neg : 'minus' });
    if (JSON.stringify(numberNow) !== JSON.stringify(numberBefore)) Object.assign(patch, numberNow);
    if ((align.align || null) !== (style.align || null)) patch.align = align.align || null;
    // A style may store a default outright (valign middle, the default font, size 13): the same look, so not a change.
    if ((align.valign === 'middle' ? null : align.valign) !== (style.valign === 'middle' ? null : style.valign || null)) patch.valign = align.valign === 'middle' ? null : align.valign;
    const wrapBefore = style.wrap ? 'wrap' : style.clip ? 'clip' : 'overflow';
    if (align.wrap !== wrapBefore) { patch.wrap = align.wrap === 'wrap' ? true : null; patch.clip = align.wrap === 'clip' ? true : null; }
    if ((align.indent || null) !== (style.indent || null)) patch.indent = align.indent || null;
    if (align.shrink !== !!style.shrink) patch.shrink = align.shrink ? true : null;
    if ((align.rot || null) !== (style.rot || null)) patch.rot = align.rot || null;
    if ((font.font === 'default' ? null : font.font) !== (style.font === 'default' ? null : style.font || null)) patch.font = font.font === 'default' ? null : font.font;
    if ((font.size === 13 ? null : font.size) !== (style.size === 13 ? null : style.size || null)) patch.size = font.size === 13 ? null : font.size;
    for (const k of ['bold', 'italic', 'underline', 'strike']) if (font[k] !== !!style[k]) patch[k] = font[k] ? true : null;
    const colorNow = font.auto ? (style.color ? 'windowtext' : null) : font.color || null;
    if (colorNow !== (style.color || null)) patch.color = colorNow;
    const bgNow = fill.none ? null : fill.bg || null;
    if (bgNow !== (style.bg || null)) patch.bg = bgNow;
    if (prot.locked !== (style.locked !== false)) patch.locked = prot.locked ? null : false;
    if (prot.hidden !== (style.formulaHidden === true)) patch.formulaHidden = prot.hidden ? true : null;
    if (customEdges) return { patch, border: null, borders: [...(baseBorder ? [baseBorder] : []), ...edgeActions.values()] };
    return { patch, border: null };
  }

  const submit = (e) => {
    e?.preventDefault();
    // A custom format without a code would apply the code 0; the Number tab comes up to show the field that needs one.
    if (state.category === 'custom' && !state.code.trim()) {
      codeError.textContent = 'Enter a format code';
      codeError.hidden = false;
      codeInput.setAttribute('aria-invalid', 'true');
      active = 'number';
      syncTabs();
      codeInput.focus();
      return;
    }
    // Invalid text must not silently apply the previous valid draft. Bring the field into view,
    // even if the user left the Font tab after typing it. Existing imported sizes remain untouched.
    const family = resolveFont(fontNameInput.value);
    const sizeText = sizeInput.value.trim(), size = Number(sizeText);
    const badSize = String(sizePt) !== sizeText && (!/^\d+(?:\.\d+)?$/.test(sizeText) || size < 1 || size > 409);
    if (!family || badSize) {
      active = 'font'; syncTabs();
      return refuseFont(!family ? fontNameInput : sizeInput, !family ? 'Enter a font name of up to 255 characters.' : 'Enter a size from 1 to 409 points. Decimals are supported.');
    }
    clearFontError();
    const out = collect();
    // A custom code about to be applied must be one the cells can show; the field is brought into view to say why not.
    const problem = out.patch.fmt === 'custom' && state.category === 'custom' ? formatCodeError(state.code) : null;
    if (problem) {
      codeError.textContent = problem;
      codeError.hidden = false;
      codeInput.setAttribute('aria-invalid', 'true');
      active = 'number';
      syncTabs();
      codeInput.focus();
      return;
    }
    modal.close();
    if (onApply) onApply(out);
    else if (Object.keys(out.patch).length || out.border || out.borders?.length) ctx.run('applyFormat', out);
  };
  // Fields on a hidden tab would otherwise fail the browser's own check silently, with nowhere to show its bubble.
  const content = el('form.fc-form', { onsubmit: submit, novalidate: true },
    tabs,
    numberPanel, alignPanel, fontPanel, borderPanel, fillPanel, protectPanel,
    el('div.row.row-end', { style: { marginTop: '14px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  content.addEventListener('input', refreshAppearance);
  content.addEventListener('change', refreshAppearance);
  let previewResize = null;
  // Over a style, the dialog that asked keeps the focus when this one closes.
  const modal = openModal({ title, content, wide: true, className: 'format-cells', onClose: () => { previewResize?.disconnect(); if (!draftStyle) ctx.grid?.focus?.(); } });
  if (typeof ResizeObserver === 'function') {
    previewResize = new ResizeObserver(refreshAppearance);
    for (const { box } of appearances.values()) previewResize.observe(box);
  }
  syncTabs();
  refreshNumber();
  refreshAppearance();
  if (matchMedia('(min-width: 640px)').matches) tabs.querySelector('[aria-selected="true"]').focus();
  return modal;
}
