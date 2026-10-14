import { fontColorCss } from '../core/font-color.js';
import { fillColorCss } from '../core/fill-color.js';
/**
 * Formatting toolbar. Every button is a command on the editor context, so
 * the same actions are reachable from keyboard shortcuts and menus. Toggle
 * buttons reflect the active cell's style. Narrow windows show the common
 * controls first, with the complete toolbar available through its expander.
 */

import { el, fieldId } from './dom.js';
import { icon } from './icons.js';
import { openMenu, ariaKeyShortcuts } from './menu.js';
import { effectiveShortcut } from './custom-shortcuts.js';
import { MOD_KEY } from './dom.js';
import { cellName } from '../core/cell.js';
import { RTL_LEAD } from '../core/bidi.js';
import { CURRENCIES, FONTS, fontName, fontStack, formatValue, currencyDecimals, BORDER_STYLES, borderCss, ELAPSED_TIME_CODE, defaultAlign, AUTOMATIC_FORMAT, cellCurrency, currencyFormatLabel } from '../core/format.js';
import { openCustomFormatDialog } from './numfmtdialog.js';
import { customColorRows } from './colorpicker.js';
import { themeColorBlock } from './themes.js';
import { GROUP_BLOCKED_REASON } from '../core/sheet-group.js';

/* Presets built on the custom-format engine; matched by their code. */
/**
 * The Accounting preset's code for a currency: a padded layout, the label at the left, the number at the
 * right and a dash for zero. The US dollar keeps the bare $ the preset always had, so older files still match;
 * any other currency's label is quoted, as styleToNumFmt writes it, since a letter such as the H of CHF would
 * otherwise read as a date letter.
 */
export function accountingCode(cur = 'USD', dec = currencyDecimals(cur)) {
  const label = cur === 'USD' ? '$' : `"${currencyFormatLabel(cur)}"`;
  const digits = `#,##0${dec > 0 ? `.${'0'.repeat(dec)}` : ''}`;
  // The dash for zero is padded to the width of the decimals shown, "-"?? beside two places.
  return `_(${label}* ${digits}_);_(${label}* (${digits});_(${label}* "-"${'?'.repeat(dec)}_);_(@_)`;
}
export const ACCOUNTING_CODE = accountingCode('USD');
// A currency without a minor unit, the yen or the won, was given two decimals before it took its own; such a
// code is still the Accounting preset, so a cell saved with one is still shown as Accounting.
const ACCOUNTING_CODES = new Set(CURRENCIES.flatMap(([cur]) => [accountingCode(cur), accountingCode(cur, 2)]));
/** Whether a code is the Accounting preset's, in any currency on offer. */
export const isAccountingCode = (code) => ACCOUNTING_CODES.has(code);
export const FRACTION_CODE = '# ?/?';
// The Duration preset is the code a typed elapsed time takes on, so both read the same way.
export const DURATION_CODE = ELAPSED_TIME_CODE;
const coded = (code) => ({ patch: { fmt: 'custom', code, dec: null }, match: (s) => s.fmt === 'custom' && s.code === code });

// Each entry's sample is a value, shown the way the entry would show it when the menu opens (formatSample).
const SAMPLE_DAY = 46261; // 2026-08-27
const SAMPLE_TIME = 0.5729166666666666; // 13:45
export const FORMATS = [
  // The common formats in order. General clears the details of the format it removes too, so a leftover code, seconds or grouping cannot shape the next entry.
  { value: 'general', label: 'General', icon: 'text', sample: 1234.5, patch: { ...AUTOMATIC_FORMAT } },
  { value: 'number', label: 'Number', icon: 'number', sample: 1234.5, patch: { fmt: 'number' } },
  { value: 'currency', label: 'Currency', icon: 'currency', sample: 1234.5, patch: { fmt: 'currency' } },
  // The editor's fmt command puts the cell's currency, or the regional format's, into the code it applies (accountingCode).
  { value: 'accounting', label: 'Accounting', icon: 'accounting', sample: 1234.5, patch: { fmt: 'custom', code: ACCOUNTING_CODE, dec: null }, match: (s) => s.fmt === 'custom' && isAccountingCode(s.code) },
  { value: 'date', label: 'Short Date', icon: 'calendar', sample: SAMPLE_DAY, patch: { fmt: 'date', dateStyle: null }, match: (s) => s.fmt === 'date' && s.dateStyle !== 'medium' },
  { value: 'date-medium', label: 'Long Date', icon: 'calendar', sample: SAMPLE_DAY, patch: { fmt: 'date', dateStyle: 'medium' }, match: (s) => s.fmt === 'date' && s.dateStyle === 'medium' },
  { value: 'time', label: 'Time', icon: 'clock', sample: SAMPLE_TIME, patch: { fmt: 'time' } },
  { value: 'percent', label: 'Percentage', icon: 'percent', sample: 0.1235, patch: { fmt: 'percent' } },
  { value: 'fraction', label: 'Fraction', icon: 'number', sample: 1234.5, ...coded(FRACTION_CODE) },
  { value: 'scientific', label: 'Scientific', icon: 'number', sample: 1234.5, patch: { fmt: 'scientific' } },
  { value: 'text', label: 'Text', icon: 'text', sample: 'as typed', patch: { fmt: 'text', dec: null } },
  { value: 'duration', label: 'Duration', icon: 'clock', sample: 1.0625, ...coded(DURATION_CODE) },
  { value: 'datetime', label: 'Date and time', icon: 'clock', sample: SAMPLE_DAY + SAMPLE_TIME, patch: { fmt: 'datetime' } },
  { value: 'custom', label: 'Custom', icon: 'number', sample: '', patch: null, match: (s) => s.fmt === 'custom' },
];


/**
 * The colours the app writes into a style are hex, of 3, 4, 6 or 8 digits; anything else is not a colour the
 * swatches will show (5 or 7 digits the CSSOM rejects, which would leave a swatch showing the previous cell's colour).
 */
export const swatchColor = (value) => (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(value || '')) ? value : null);
/**
 * An entry's sample as the cell would show it: under the regional format, in the cell's currency or, on a cell
 * in none, the regional format's own, as the Currency and Accounting entries apply it. Built when the menu
 * opens, so a regional format switched mid-session shows its own marks, rather than fixed en-US strings.
 */
export function formatSample(entry, style) {
  if (typeof entry.sample !== 'number') return entry.sample;
  const cur = cellCurrency(style);
  const patch = entry.value === 'accounting' ? { fmt: 'custom', code: accountingCode(cur) } : { ...entry.patch, cur };
  return formatValue(entry.sample, patch).trim();
}


export function formatEntry(style) {
  const fmt = style.fmt || 'general';
  return FORMATS.find((f) => (f.match ? f.match(style) : f.value === fmt)) || FORMATS[0];
}

/** Font sizes are shown and typed in points; cells store CSS pixels (a point is 4/3 px). */
export const POINT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
export const ptToPx = (pt) => pt * 4 / 3;
/** A size in points to two decimals (sizes keep half points; the app's old 13px default is 9.75pt). */
export const pxToPt = (px) => Math.round(px * 75) / 100;
/** The sizes the menu offers, in pixels: the same list Larger font and Smaller font step along, so a stepped size is always shown checked. */
export const FONT_SIZES = POINT_SIZES.map(ptToPx);

/** How long a touch is held before it counts as a long press, as in the grid. */
const LONG_PRESS_MS = 500;

export const TEXT_COLORS = [
  '#0b0b0b', '#4f4e4b', '#918f88', '#c22a2a', '#b45309', '#8a5a00',
  '#006300', '#0e7490', '#0a63f0', '#4a3aa7', '#9d174d', '#ffffff',
];

export const FILL_COLORS = [
  '#fde8e8', '#fdebd3', '#fef3c7', '#e3f5e1', '#dff3f6', '#e0ecff',
  '#ebe6fb', '#fbe4ef', '#f2f1ee', '#e7e6e1', '#c3c2b7', '#0b0b0b',
];

export function createToolbar(ctx, { ribbon = false, ribbonExtras = {} } = {}) {
  const root = el('div.toolbar', { role: 'toolbar', 'aria-label': 'Formatting', 'aria-orientation': 'horizontal' });

  // A button with a shortcut names it in its tooltip and, in the spelling aria-keyshortcuts takes, in that attribute, so it can be heard as well as read.
  const btn = (name, label, cmd, arg, extra = {}) => {
    const b = el('button.tb-btn', {
      type: 'button', html: icon(name, 18), 'aria-label': label, title: extra.title || (extra.shortcut ? `${label} (${extra.shortcut})` : label),
      'aria-keyshortcuts': ariaKeyShortcuts(extra.shortcut),
      'aria-pressed': extra.toggle ? 'false' : null, 'aria-haspopup': extra.menu ? 'menu' : null, tabindex: -1,
      // An object argument (the Percent and Currency buttons' { fmt, toggle }) is named by its text values, so data-arg reads "percent", not "[object Object]".
      dataset: { cmd, arg: arg != null && typeof arg === 'object' ? Object.values(arg).filter((v) => typeof v === 'string').join(' ') : arg ?? '' },
      onclick: () => ctx.run(cmd, arg),
    });
    // What the button runs, for the Quick Access Toolbar and the ribbon's own tabs (see command-catalog.js).
    b._command = { cmd, arg: extra.menu ? null : arg ?? null, label, glyph: name };
    // A shortcut of the person's own (Options ▸ Keyboard Shortcuts) is the one the tooltip names.
    if (!extra.title) b.addEventListener('pointerenter', () => {
      const keys = effectiveShortcut({ cmd, arg, shortcut: extra.shortcut });
      b.title = keys ? `${label} (${keys})` : label;
    });
    return b;
  };
  const sep = () => el('div.tb-sep', { role: 'separator', 'aria-orientation': 'vertical' });
  const group = (...kids) => el('div.tb-group', {}, ...kids);

  const undoBtn = btn('undo', 'Undo', 'undo', null, { shortcut: `${MOD_KEY}+Z`, title: `Undo (${MOD_KEY}+Z). Right-click for the history` });
  const redoBtn = btn('redo', 'Redo', 'redo', null, { shortcut: `${MOD_KEY}+Shift+Z`, title: `Redo (${MOD_KEY}+Shift+Z). Right-click for the history` });
  // Right-click (or long-press) lists the last steps; picking one undoes (or redoes) everything down to it.
  const historyMenu = (anchor, kind) => {
    // Undo and redo wait while a cell is being edited (the buttons are greyed for it); the history list, an
    // extra on a right-click or long press that a greyed button may still receive, waits with them.
    if (ctx.grid.editing) return;
    const labels = kind === 'undo' ? ctx.wb.undoLabels(12) : ctx.wb.redoLabels(12);
    if (!labels.length) return;
    openMenu({
      anchor, label: kind === 'undo' ? 'Undo history' : 'Redo history', minWidth: 220,
      items: [
        { header: kind === 'undo' ? 'Undo up to' : 'Redo up to' },
        ...labels.map((label, i) => ({ label: i ? `${label} (${i + 1} steps)` : label, onSelect: () => ctx.run(kind === 'undo' ? 'undoSteps' : 'redoSteps', i + 1) })),
      ],
      // After a choice the sheet takes focus back; after Escape or Tab the menu has put it on the button, and it stays there.
      onClose: (reason) => { if (reason === 'select') ctx.grid.focus(); },
    });
  };
  // In the quick access row, Undo carries an arrow beside it, opening the same history.
  const undoArrow = el('button.icon-btn.qat-btn.qat-arrow', {
    type: 'button', html: icon('chevD', 12, 2), 'aria-label': 'Undo history', title: 'Undo history', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: () => historyMenu(undoArrow, 'undo'),
  });
  // The history list is an extra on a right-click or long press; pressing the button itself undoes, so it announces no popup.
  for (const [b, kind] of [[undoBtn, 'undo'], [redoBtn, 'redo']]) {
    let press = null;
    let longPressAt = 0; // when a long press last opened the history
    // A long press on a touch screen arrives twice: from the press timer and as the browser's own contextmenu
    // for the same press. Whichever comes first opens the history; the other is dropped, as the grid does for
    // its cell menu (a second opening on the same button would only close the first).
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (press) { clearTimeout(press); press = null; longPressAt = Date.now(); }
      else if (Date.now() - longPressAt < LONG_PRESS_MS * 2) return;
      historyMenu(b, kind);
    });
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      press = setTimeout(() => { press = null; longPressAt = Date.now(); historyMenu(b, kind); }, LONG_PRESS_MS);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => { clearTimeout(press); press = null; });
  }

  const boldBtn = btn('bold', 'Bold', 'bold', null, { toggle: true, shortcut: `${MOD_KEY}+B` });
  const italicBtn = btn('italic', 'Italic', 'italic', null, { toggle: true, shortcut: `${MOD_KEY}+I` });
  const underlineBtn = btn('underline', 'Underline', 'underline', null, { toggle: true, shortcut: `${MOD_KEY}+U` });
  const strikeBtn = btn('strike', 'Strikethrough', 'strike', null, { toggle: true, shortcut: `${MOD_KEY}+5` });

  const colorBtn = el('button.tb-btn.tb-color', {
    type: 'button', 'aria-label': 'Text color', title: 'Text color', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => colorMenu(e.currentTarget, 'color', TEXT_COLORS),
  }, el('span', { html: icon('textColor', 18) }), el('span.color-bar'));
  const fillBtn = el('button.tb-btn.tb-color', {
    type: 'button', 'aria-label': 'Fill color', title: 'Fill color', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => colorMenu(e.currentTarget, 'bg', FILL_COLORS),
  }, el('span', { html: icon('fill', 18) }), el('span.color-bar'));

  // The colour buttons apply the colour last picked from their palettes (yellow fill and red text to begin with);
  // their arrows open the palettes.
  const lastColor = { color: '#ff0000', bg: '#ffff00' };
  // A theme colour picked from the palettes is kept as its reference, named as the palette names it.
  const lastName = { color: null, bg: null };
  const applyColorBtn = (kind) => {
    const b = el('button.tb-btn.tb-color.tb-color-apply', {
      type: 'button', tabindex: -1, onclick: () => ctx.run(kind, lastColor[kind]),
    }, el('span', { html: icon(kind === 'bg' ? 'fill' : 'textColor', 18) }), el('span.tb-pen-bar'));
    b.sync = () => {
      const c = lastColor[kind], css = typeof c === 'object' ? c.rgb : c;
      const name = `${kind === 'bg' ? 'Fill color' : 'Font color'} ${typeof c === 'object' ? lastName[kind] || css : c}`;
      b.setAttribute('aria-label', `Apply ${name.toLowerCase()}`); b.title = name;
      b.querySelector('.tb-pen-bar').style.backgroundColor = css;
    };
    b.sync();
    return b;
  };
  const colorApply = applyColorBtn('color');
  const fillApply = applyColorBtn('bg');

  // The border "pen": the color and style the next border command draws with.
  const pen = { color: null, style: 'thin' };
  const borderArg = (kind) => ({ kind, color: pen.color, style: pen.style });
  function borderColorMenu(anchor) {
    const swatches = el('div.swatches', { role: 'group', 'aria-label': 'Border colors', 'data-cols': 6 },
      el('button.swatch.none', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(!pen.color), 'aria-label': 'Default color', title: 'Default',
        onclick: () => { menu.close(); pen.color = null; ctx.run('borders', borderArg('restyle')); },
      }),
      ...TEXT_COLORS.map((hex) => el('button.swatch', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(pen.color === hex), 'aria-label': hex, title: hex,
        style: { background: hex }, onclick: () => { menu.close(); pen.color = hex; ctx.run('borders', borderArg('restyle')); },
      })));
    const extra = customColorRows({ current: pen.color, label: 'border color', onPick: (hex) => { menu.close(); pen.color = hex; ctx.run('borders', borderArg('restyle')); } });
    const menu = openMenu({ anchor, label: 'Border color', items: [{ custom: swatches }, ...extra.map((custom) => ({ custom }))] });
    (swatches.querySelector('[aria-checked="true"]') || swatches.querySelector('button'))?.focus();
  }
  const bordersBtn = el('button.tb-btn', {
    type: 'button', html: icon('borders', 18), 'aria-label': 'Borders', title: 'Borders', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => {
      const anchor = e.currentTarget;
      const st = ctx.style();
      // The pen picks up the active cell's border color and style.
      // In lower case, as the swatches are spelt: a colour from a file may be in upper case, and is the same colour.
      if (st.bt || st.bb || st.bl || st.br) { pen.color = st.bc ? String(st.bc).toLowerCase() : null; pen.style = st.bs || 'thin'; }
      openMenu({
        anchor, label: 'Borders', minWidth: 220,
        items: [
          { label: 'All borders', icon: 'borders', onSelect: () => ctx.run('borders', borderArg('all')) },
          { label: 'Outer borders', icon: 'borderOuter', onSelect: () => ctx.run('borders', borderArg('outer')) },
          { label: 'Inner borders', icon: 'borders', onSelect: () => ctx.run('borders', borderArg('inner')) },
          { label: 'Horizontal borders', icon: 'rows', onSelect: () => ctx.run('borders', borderArg('horizontal')) },
          { label: 'Vertical borders', icon: 'cols', onSelect: () => ctx.run('borders', borderArg('vertical')) },
          { separator: true },
          { label: 'Top border', icon: 'borderTop', onSelect: () => ctx.run('borders', borderArg('top')) },
          { label: 'Bottom border', icon: 'borderBottom', onSelect: () => ctx.run('borders', borderArg('bottom')) },
          { label: 'Left border', icon: 'borderLeft', onSelect: () => ctx.run('borders', borderArg('left')) },
          { label: 'Right border', icon: 'borderRight', onSelect: () => ctx.run('borders', borderArg('right')) },
          { separator: true },
          // Fixed-pen choices: a heavy or double line whatever the pen holds, in the pen's color.
          { label: 'Thick outside borders', icon: 'borderOuter', onSelect: () => ctx.run('borders', { kind: 'outer', style: 'thick', color: pen.color }) },
          { label: 'Bottom double border', icon: 'borderBottom', onSelect: () => ctx.run('borders', { kind: 'bottom', style: 'double', color: pen.color }) },
          { label: 'Thick bottom border', icon: 'borderBottom', onSelect: () => ctx.run('borders', { kind: 'bottom', style: 'thick', color: pen.color }) },
          { separator: true },
          { label: 'Border color…', icon: 'textColor', shortcut: pen.color || 'Default', onSelect: () => borderColorMenu(anchor) },
          { label: 'Border style…', icon: 'borderBottom', shortcut: BORDER_STYLES.find(([k]) => k === pen.style)?.[1] || 'Thin', onSelect: () => openMenu({
            anchor, label: 'Border style', minWidth: 180, focusChecked: true,
            items: BORDER_STYLES.map(([key, label]) => ({
              label, checked: pen.style === key, radio: true, style: { borderBottom: `${borderCss({ bs: key }).width} ${borderCss({ bs: key }).style} currentColor`, paddingBottom: '2px' },
              onSelect: () => { pen.style = key; ctx.run('borders', borderArg('restyle')); },
            })),
          }) },
          { separator: true },
          { label: 'No borders', icon: 'borderNone', onSelect: () => ctx.run('borders', 'none') },
          { label: 'More borders…', icon: 'sliders', onSelect: () => ctx.run('formatCells', 'border') },
        ],
      });
    },
  });
  const fontBtn = el('button.tb-btn.tb-font', {
    type: 'button', 'aria-label': 'Font', title: 'Font', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => {
      const current = ctx.style().font || 'default';
      const fonts = FONTS.some(([key]) => key === current) || !fontName(current) ? FONTS
        : [...FONTS, [current, fontName(current), fontStack(current)]];
      openMenu({
        anchor: e.currentTarget, label: 'Font', minWidth: 200, focusChecked: true,
        // One choice of several is a radio item, so a screen reader does not call a font a checkbox.
        items: fonts.map(([key, label, stack]) => ({
          label, checked: key === current, radio: true, style: stack ? { fontFamily: stack } : null,
          onSelect: () => ctx.run('font', key),
        })),
      });
    },
  }, el('span.tb-font-label', {}, 'Default'), el('span', { html: icon('chevD', 14, 2) }));
  const sizeBtn = el('button.tb-btn.tb-size', {
    type: 'button', 'aria-label': 'Font size', title: 'Font size', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => {
      const current = pxToPt(ctx.style().size || 13);
      const sizes = POINT_SIZES.includes(current) ? POINT_SIZES : [...POINT_SIZES, current].sort((a, b) => a - b);
      openMenu({
        anchor: e.currentTarget, label: 'Font size', minWidth: 140, focusChecked: true,
        items: [
          { label: 'Custom size…', icon: 'fontSize', onSelect: () => ctx.run('fontSize') },
          { separator: true },
          ...sizes.map((pt) => ({ label: String(pt), checked: pt === current, radio: true, onSelect: () => ctx.run('fontSize', ptToPx(pt)) })),
        ],
      });
    },
  }, el('span.tb-size-label', {}, '9.75'), el('span', { html: icon('chevD', 14, 2) }));
  const valignBtn = el('button.tb-btn', {
    type: 'button', html: icon('borderTop', 18), 'aria-label': 'Vertical align', title: 'Vertical align', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => {
      const current = ctx.style().valign || 'middle';
      const rot = ctx.style().rot || 0;
      openMenu({
        anchor: e.currentTarget, label: 'Vertical align', minWidth: 160, focusChecked: true,
        items: [
          { label: 'Top', icon: 'arrowUp', checked: current === 'top', radio: true, onSelect: () => ctx.run('valign', 'top') },
          { label: 'Middle', icon: 'borderTop', checked: current === 'middle', radio: true, onSelect: () => ctx.run('valign', 'middle') },
          { label: 'Bottom', icon: 'arrowDown', checked: current === 'bottom', radio: true, onSelect: () => ctx.run('valign', 'bottom') },
          { separator: true },
          { header: 'Text wrapping' },
          { label: 'Overflow', icon: 'chevR', checked: !ctx.style().wrap && !ctx.style().clip, radio: true, onSelect: () => ctx.run('wrapMode', 'overflow') },
          { label: 'Wrap', icon: 'wrap', checked: !!ctx.style().wrap, radio: true, onSelect: () => ctx.run('wrapMode', 'wrap') },
          { label: 'Clip', icon: 'x', checked: !ctx.style().wrap && !!ctx.style().clip, radio: true, onSelect: () => ctx.run('wrapMode', 'clip') },
          { separator: true },
          { header: 'Text rotation' },
          { label: 'None', checked: !rot, radio: true, onSelect: () => ctx.run('rotate', 0) },
          { label: 'Tilt up (45°)', checked: rot === 45, radio: true, onSelect: () => ctx.run('rotate', 45) },
          { label: 'Tilt down (−45°)', checked: rot === -45, radio: true, onSelect: () => ctx.run('rotate', -45) },
          { label: 'Rotate up (90°)', checked: rot === 90, radio: true, onSelect: () => ctx.run('rotate', 90) },
          { label: 'Rotate down (−90°)', checked: rot === -90, radio: true, onSelect: () => ctx.run('rotate', -90) },
          { label: `Custom angle…${rot && ![45, -45, 90, -90].includes(rot) ? ` (${rot}°)` : ''}`, onSelect: () => ctx.run('rotate', 'custom') },
        ],
      });
    },
  });
  const mergeBtn = btn('merge', 'Merge cells', 'merge', null, { toggle: true });
  const alignL = btn('alignLeft', 'Align left', 'align', 'left', { toggle: true });
  const alignC = btn('alignCenter', 'Align center', 'align', 'center', { toggle: true });
  const alignR = btn('alignRight', 'Align right', 'align', 'right', { toggle: true });
  const wrapBtn = btn('wrap', 'Wrap text', 'wrap', null, { toggle: true });
  const indentLess = btn('indentLess', 'Decrease indent', 'indent', -1);
  const indentMore = btn('indentMore', 'Increase indent', 'indent', 1);

  const fmtBtn = el('button.tb-btn.tb-fmt', {
    type: 'button', 'aria-label': 'Number format', title: 'Number format', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => {
      const anchor = e.currentTarget;
      const st = ctx.style();
      const current = formatEntry(st);
      // Only these formats group their digits; Automatic, Scientific and Plain text never do, and a custom code
      // (a preset included) says so itself. For the rest the toggle is greyed rather than turned into a Number format.
      const grouped = ['number', 'currency', 'percent'].includes(st.fmt);
      openMenu({
        anchor, label: 'Number format', minWidth: 250, focusChecked: true,
        items: [
          ...FORMATS.filter((f) => f.patch).map((f) => ({
            label: f.label, icon: f.icon, checked: current === f, radio: true,
            shortcut: formatSample(f, st), onSelect: () => ctx.run('fmt', f.patch),
          })),
          // A preset built on a custom code (Accounting, Fraction, Duration) is its own entry above; only a code of the user's own is "Custom".
          { label: `Custom format…${current.value === 'custom' && st.code ? ` (${st.code})` : ''}`, icon: 'number', checked: current.value === 'custom', radio: true, onSelect: () => openCustomFormatDialog(ctx) },
          { separator: true },
          // The currency named is the one Currency or Accounting would apply: the cell's own, or the regional format's on a cell in none.
          { label: `Currency symbol (${cellCurrency(st)})…`, icon: 'currency', onSelect: () => currencyMenu(anchor) },
          // The patch names grouping alone, so the format, its decimals and its currency stay as they are.
          { label: 'Thousands separator', icon: 'number', checked: grouped && st.group !== false, disabled: !grouped, onSelect: () => ctx.run('fmt', { group: st.group === false ? null : false }) },
        ],
      });
    },
  }, el('span.tb-fmt-label', {}, 'General'), el('span', { html: icon('chevD', 14, 2) }));

  function currencyMenu(anchor) {
    const cur = cellCurrency(ctx.style());
    openMenu({
      anchor, label: 'Currency', minWidth: 240, focusChecked: true,
      items: CURRENCIES.map(([code, name, symbol]) => ({
        label: `${name}`, shortcut: `${symbol} ${code}`, checked: code === cur, radio: true,
        onSelect: () => {
          // The decimals go with the currency when they are the current one's own (two for the dollar, none for
          // the yen), so the one chosen is written its own way; a number of them chosen apart from it stays.
          const st = ctx.style();
          const own = st.dec == null || (st.fmt === 'currency' && st.dec === currencyDecimals(st.cur));
          ctx.run('fmt', { fmt: 'currency', cur: code === 'USD' ? null : code, ...(own ? { dec: null } : {}) });
        },
      })),
    });
  }
  const pctBtn = btn('percent', 'Format as percent', 'fmt', { fmt: 'percent', toggle: true }, { toggle: true });
  const curBtn = btn('currency', 'Format as currency', 'fmt', { fmt: 'currency', toggle: true }, { toggle: true });
  const decLess = btn('decimalLess', 'Fewer decimal places', 'dec', -1);
  const decMore = btn('decimalMore', 'More decimal places', 'dec', 1);

  const fnBtn = btn('sigma', 'Insert function', 'functionMenu', null, { menu: true });
  const linkBtn = btn('link', 'Insert link', 'link', null, { shortcut: `${MOD_KEY}+K` });
  const chartBtn = btn('chartColumn', 'Insert chart', 'insertChart', null);
  const imageBtn = el('button.tb-btn', {
    type: 'button', html: icon('image', 18), 'aria-label': 'Insert image', title: 'Insert image', 'aria-haspopup': 'menu', tabindex: -1,
    dataset: { cmd: 'insertImage' },
    onclick: (e) => openMenu({
      anchor: e.currentTarget, label: 'Insert image',
      items: [
        { label: 'From this device…', icon: 'image', onSelect: () => ctx.run('insertImage') },
        ctx.flags?.()?.pick && { label: 'From Puter…', icon: 'folderOpen', onSelect: () => ctx.run('insertImagePuter') },
        { label: 'From a URL…', icon: 'external', onSelect: () => ctx.run('insertImageUrl') },
        { separator: true },
        { label: 'Place in Cell', icon: 'placeInCell', submenu: [
          { label: 'From this device…', icon: 'image', onSelect: () => ctx.run('insertImage', 'cell') },
          ctx.flags?.()?.pick && { label: 'From Puter…', icon: 'folderOpen', onSelect: () => ctx.run('insertImagePuter', 'cell') },
          { label: 'From a URL…', icon: 'external', onSelect: () => ctx.run('insertImageUrl', 'cell') },
        ].filter(Boolean) },
      ],
    }),
  });
  const sortBtn = el('button.tb-btn', {
    type: 'button', html: icon(ribbon ? 'sortFilter' : 'sortAsc', 18), 'aria-label': 'Sort and summarize', title: 'Sort and summarize', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => openMenu({
      anchor: e.currentTarget, label: 'Sort',
      items: [
        { label: 'Sort A to Z', icon: 'sortAsc', onSelect: () => ctx.run('sort', 'asc') },
        { label: 'Sort Z to A', icon: 'sortDesc', onSelect: () => ctx.run('sort', 'desc') },
        { separator: true },
        { label: ribbon ? 'Custom Sort…' : 'Sort range…', icon: 'sliders', onSelect: () => ctx.run('sortDialog') },
        // On the ribbon, Filter lives in Sort & Filter as well as on the Data tab.
        ribbon && { separator: true },
        ribbon && { label: 'Filter', icon: 'filter', checked: !!ctx.flags?.()?.filter, shortcut: `${MOD_KEY}+Shift+L`, onSelect: () => ctx.run('filter') },
        ribbon && { separator: true },
        { label: 'Subtotals…', icon: 'sigma', onSelect: () => ctx.run('subtotal') },
        { label: 'Create table…', icon: 'table', onSelect: () => ctx.run('insertTable') },
        { label: 'Remove duplicate rows…', icon: 'dedupe', onSelect: () => ctx.run('dedupe') },
        { label: 'Randomize range', icon: 'sortAsc', onSelect: () => ctx.run('shuffle') },
        { label: 'Remove empty rows', icon: 'rows', onSelect: () => ctx.run('removeEmptyRows') },
        { separator: true },
        { label: 'Pivot table…', icon: 'pivot', onSelect: () => ctx.run('pivot') },
        { label: 'Goal seek…', icon: 'sliders', onSelect: () => ctx.run('goalSeek') },
        { label: 'Solver…', icon: 'solver', onSelect: () => ctx.run('solver') },
        { label: 'Data analysis…', icon: 'dataAnalysis', onSelect: () => ctx.run('dataAnalysis') },
        { label: 'Column stats…', icon: 'chartColumn', onSelect: () => ctx.run('columnStats') },
      ],
    }),
  });
  const rowsBtn = el('button.tb-btn', {
    type: 'button', html: icon('rows', 18), 'aria-label': 'Rows', title: 'Insert or delete rows', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => openMenu({ anchor: e.currentTarget, label: 'Rows', items: rowItems(ctx) }),
  });
  const colsBtn = el('button.tb-btn', {
    type: 'button', html: icon('cols', 18), 'aria-label': 'Columns', title: 'Insert or delete columns', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => openMenu({ anchor: e.currentTarget, label: 'Columns', items: colItems(ctx) }),
  });
  const freezeBtn = el('button.tb-btn', {
    type: 'button', html: icon('pin', 18), 'aria-label': 'Freeze panes', title: 'Freeze rows and columns', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => {
      const sheet = ctx.wb.sheet(ctx.sheetId());
      const a = ctx.active();
      openMenu({
        anchor: e.currentTarget, label: 'Freeze panes', minWidth: 240,
        items: [
          { label: 'Freeze first row', icon: 'pin', checked: sheet.frozenRows === 1 && !sheet.frozenCols, onSelect: () => ctx.run('freeze', { rows: 1 }) },
          { label: 'Freeze first column', icon: 'pin', checked: sheet.frozenCols === 1 && !sheet.frozenRows, onSelect: () => ctx.run('freeze', { cols: 1 }) },
          { label: a.r || a.c ? `Freeze above and left of ${cellName(a.r, a.c)}` : 'Freeze at the active cell', icon: 'pin', disabled: !a.r && !a.c, onSelect: () => ctx.run('freeze', 'here') },
          { separator: true },
          { label: 'Unfreeze', icon: 'reset', disabled: !sheet.frozenRows && !sheet.frozenCols, onSelect: () => ctx.run('freeze', 'none') },
        ],
      });
    },
  });
  const filterBtn = btn('filter', 'Filter', 'filter', null, { toggle: true, title: 'Create or remove a filter' });
  // On the ribbon Conditional formatting opens a drop-down of quick rules; the bare toolbar opens the rules manager.
  const cfBtn = ribbon ? el('button.tb-btn', {
    type: 'button', html: icon('condFormat', 18), 'aria-label': 'Conditional formatting', title: 'Conditional formatting', 'aria-haspopup': 'menu', tabindex: -1,
    dataset: { cmd: 'condFormat', arg: '' }, onclick: (e) => ctx.run('condFormatMenu', e.currentTarget),
  }) : btn('highlighter', 'Conditional formatting', 'condFormat', null);
  const dvBtn = btn('validation', 'Data validation', 'validation', null);
  const clearBtn = btn('eraser', 'Clear formatting', 'clearFormat', null);
  const paintBtn = btn('paint', 'Paint format', 'paintFormat', null, { toggle: true, title: 'Paint format: copy this formatting, then select the cells to paint' });
  // A double-click keeps the painter on for several targets, until Escape.
  paintBtn.addEventListener('dblclick', () => ctx.run('paintFormat', 'sticky'));
  paintBtn.title = 'Paint format: copy this formatting, then select the cells to paint (double-click to paint several)';
  const stylesBtn = el('button.tb-btn', { type: 'button', html: icon(ribbon ? 'cellStyles' : 'sparkle', 18), 'aria-label': 'Cell styles', title: 'Cell styles: title, heading, total, input, good, bad, note…', 'aria-haspopup': 'menu', tabindex: -1, onclick: (e) => ctx.run('cellStylesMenu', e.currentTarget) });

  const verticalButtons = ribbon ? ['top', 'middle', 'bottom'].map((value, i) => btn(['valignTop', 'valignMiddle', 'valignBottom'][i], `${value[0].toUpperCase()}${value.slice(1)} align`, 'valign', value, { toggle: true })) : [];
  const fontSteps = ribbon ? [btn('fontGrow', 'Increase font size', 'fontStep', 1), btn('fontShrink', 'Decrease font size', 'fontStep', -1)] : [];
  const accountingBtn = ribbon ? btn('accounting', 'Accounting Number Format', 'fmt', FORMATS.find(f => f.value === 'accounting').patch) : null;
  const commaBtn = ribbon ? btn('comma', 'Comma Style', 'fmt', { fmt: 'number', group: true, dec: 2 }) : null;
  // The arrow beside the Accounting button: the same format in another currency, or the Number tab for the rest.
  const ACCOUNTING_CHOICES = [['USD', '$ English (United States)'], ['GBP', '£ English (United Kingdom)'], ['EUR', '€ Euro (€ 123)'], ['CNY', '¥ Chinese (PRC)'], ['CHF', 'CHF French (Switzerland)']];
  const accountingArrow = ribbon ? el('button.tb-btn.ribbon-split-arrow', {
    type: 'button', html: icon('chevD', 10, 2), 'aria-label': 'Accounting Number Format options', title: 'Accounting Number Format', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => openMenu({
      anchor: e.currentTarget, label: 'Accounting Number Format', minWidth: 230,
      items: [
        ...ACCOUNTING_CHOICES.map(([cur, label]) => ({ label, checked: ctx.style().code === accountingCode(cur), radio: true, onSelect: () => ctx.run('fmt', { fmt: 'custom', code: accountingCode(cur), dec: null }) })),
        { separator: true },
        { label: 'More Accounting Formats…', icon: 'formatCells', onSelect: () => ctx.run('formatCells', 'number') },
      ],
    }),
  }) : null;
  // The arrow beside Merge & Center: Merge Across (each row on its own), Merge Cells (without centring), Unmerge Cells.
  const mergeArrow = ribbon ? el('button.tb-btn.ribbon-split-arrow', {
    type: 'button', html: icon('chevD', 10, 2), 'aria-label': 'Merge options', title: 'Merge options', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => openMenu({
      anchor: e.currentTarget, label: 'Merge', minWidth: 200,
      items: [
        { label: 'Merge & Center', icon: 'merge', onSelect: () => ctx.run('merge') },
        { label: 'Merge Across', icon: 'rows', onSelect: () => ctx.run('mergeAcross') },
        { label: 'Merge Cells', icon: 'merge', onSelect: () => ctx.run('merge', 'plain') },
        { label: 'Unmerge Cells', icon: 'unmerge', onSelect: () => ctx.run('merge', 'unmerge') },
      ],
    }),
  }) : null;
  // The Orientation menu: the common angles, then the Alignment tab for any other.
  const orientationBtn = ribbon ? el('button.tb-btn', {
    type: 'button', html: icon('orientation', 18), 'aria-label': 'Orientation', title: 'Orientation', 'aria-haspopup': 'menu', tabindex: -1,
    onclick: (e) => {
      const rot = ctx.style().rot || 0;
      openMenu({
        anchor: e.currentTarget, label: 'Orientation', minWidth: 220, focusChecked: true,
        items: [
          { label: 'Angle Counterclockwise', checked: rot === 45, radio: true, onSelect: () => ctx.run('rotate', rot === 45 ? 0 : 45) },
          { label: 'Angle Clockwise', checked: rot === -45, radio: true, onSelect: () => ctx.run('rotate', rot === -45 ? 0 : -45) },
          { label: 'Rotate Text Up', checked: rot === 90, radio: true, onSelect: () => ctx.run('rotate', rot === 90 ? 0 : 90) },
          { label: 'Rotate Text Down', checked: rot === -90, radio: true, onSelect: () => ctx.run('rotate', rot === -90 ? 0 : -90) },
          { separator: true },
          { label: 'Format Cell Alignment…', icon: 'formatCells', onSelect: () => ctx.run('formatCells', 'alignment') },
        ],
      });
    },
  }) : null;
  const row = (...kids) => el('div.ribbon-row', {}, ...kids);
  const stack = (...kids) => el('div.ribbon-stack', {}, ...kids);
  const namedGroup = (label, ...kids) => el('div.tb-group.ribbon-group', { role: 'group', 'aria-label': label },
    el('div.ribbon-group-controls', {}, ...kids), el('span.ribbon-group-label', {}, label));
  if (ribbon) {
    root.classList.add('ribbon-home');
    const editing = ribbonExtras.editing || [];
    // The Home tab: Undo, Clipboard, Font, Alignment, Number, Styles, Cells, Editing.
    // Undo and Redo join the window's quick access toolbar when there is one, else open the Home tab.
    // There they are tab stops like AutoSave and Save beside them: this toolbar's roving tab stop no longer reaches them.
    if (ctx.quickAccess) {
      for (const b of [undoBtn, undoArrow, redoBtn]) b.tabIndex = 0;
      undoBtn.classList.add('qat-btn'); redoBtn.classList.add('qat-btn');
      // The Quick Access Toolbar places them (ui/quick-access.js), with whatever else the person put there.
      undoBtn.dataset.qat = 'undo'; undoArrow.dataset.qat = 'undo'; redoBtn.dataset.qat = 'redo';
      ctx.quickAccess.append(undoBtn, undoArrow, redoBtn);
    }
    root.append(
      ...(ctx.quickAccess ? [] : [namedGroup('Undo', stack(undoBtn, redoBtn)), sep()]),
      namedGroup('Clipboard', ...(ribbonExtras.clipboard || []).slice(0, 1), stack(...(ribbonExtras.clipboard || []).slice(1), paintBtn)),
      namedGroup('Font', stack(row(fontBtn, sizeBtn, ...fontSteps), row(boldBtn, italicBtn, underlineBtn, el('span.ribbon-divider'), bordersBtn, el('span.ribbon-divider'),
        el('span.tb-color-split', {}, fillApply, fillBtn), el('span.tb-color-split', {}, colorApply, colorBtn)))),
      namedGroup('Alignment',
        stack(row(...verticalButtons, el('span.ribbon-divider'), orientationBtn), row(alignL, alignC, alignR, el('span.ribbon-divider'), indentLess, indentMore)),
        el('span.ribbon-divider.tall'), stack(wrapBtn, el('span.ribbon-split.ribbon-merge-split', { role: 'group', 'aria-label': 'Merge & Center' }, mergeBtn, mergeArrow))),
      namedGroup('Number', stack(row(fmtBtn), row(el('span.ribbon-split', { role: 'group', 'aria-label': 'Accounting Number Format' }, accountingBtn, accountingArrow), pctBtn, commaBtn, el('span.ribbon-divider'), decMore, decLess))),
      namedGroup('Styles', cfBtn, ...(ribbonExtras.styles || []), stylesBtn),
      namedGroup('Cells', stack(...(ribbonExtras.cells || []))),
      namedGroup('Editing', stack(...editing.slice(0, 3)), sortBtn, ...editing.slice(3)),
    );
    // The existing formatting pickers keep their handlers, state and edit-target semantics.
    // Commands elsewhere on the ribbon are also available in the original menus.
    for (const [button, label] of [[paintBtn, 'Format Painter'], [wrapBtn, 'Wrap Text'], [mergeBtn, 'Merge & Center'],
      [cfBtn, 'Conditional Formatting'], [stylesBtn, 'Cell Styles'], [sortBtn, 'Sort & Filter'], [filterBtn, 'Filter']]) {
      button.classList.add('ribbon-labeled');
      button.append(el('span.ribbon-button-label', {}, label));
    }
    paintBtn.setAttribute('aria-label', 'Format Painter');
    // A button's name holds the words it shows, so speech input can say what is on screen (WCAG 2.5.3).
    sortBtn.setAttribute('aria-label', 'Sort & Filter'); sortBtn.title = 'Sort & Filter';
    // The palette buttons become the arrows of the split colour buttons.
    for (const button of [fillBtn, colorBtn]) { button.classList.add('tb-color-arrow'); button.append(el('span.tb-color-caret', { html: icon('chevD', 10) })); }
    // Borders and Orientation only open menus: they carry the same drop-down mark as the colour arrows beside them.
    for (const button of [bordersBtn, orientationBtn]) { button.classList.add('ribbon-menu-btn'); button.append(el('span.tb-color-caret', { html: icon('chevD', 10) })); }
    // The primary commands of Styles and Editing are large, label under the icon, as on a ribbon.
    for (const button of [cfBtn, stylesBtn, sortBtn]) button.classList.add('ribbon-large');
    for (const button of [cfBtn, stylesBtn, sortBtn]) button.innerHTML = button.innerHTML.replace(/width="18" height="18"/, 'width="32" height="32"');
  } else {
    root.append(
      group(undoBtn, redoBtn), sep(),
      group(fmtBtn, curBtn, pctBtn, decLess, decMore), sep(),
      group(fontBtn, sizeBtn, boldBtn, italicBtn, underlineBtn, strikeBtn), sep(),
      group(colorBtn, fillBtn, bordersBtn, paintBtn, stylesBtn), sep(),
      group(alignL, alignC, alignR, indentLess, indentMore, valignBtn, wrapBtn, mergeBtn), sep(),
      group(fnBtn, linkBtn, chartBtn, imageBtn), sep(),
      group(sortBtn, filterBtn, rowsBtn, colsBtn, freezeBtn, cfBtn, dvBtn, clearBtn),
    );
  }

  const worksheetGroups = [...root.children].slice(ribbon ? 1 : 2);
  const historySeparator = ribbon ? null : root.children[1];
  const cellButtons = [...root.querySelectorAll('.tb-btn')];
  // The expander shares the keyboard region but is positioned outside its scrolling content.
  const toolContent = el('div.toolbar-tool-content', { id: fieldId('formatting-tools') }, ...root.children);
  const tools = el('div.toolbar-tools', {}, toolContent);
  root.append(tools);
  const compactButtons = new Set([undoBtn, redoBtn, fmtBtn, boldBtn, italicBtn, fillBtn]);
  let narrow = false;
  let expanded = false;
  const expandBtn = el('button.tb-btn.tb-expand', {
    type: 'button', tabindex: -1, 'aria-expanded': 'false', 'aria-controls': toolContent.id,
    onclick: () => {
      // Resizing the chrome should not hide the cell someone was looking at, or jump back
      // to a selection they deliberately scrolled away from.
      const viewport = ctx.grid.viewport?.getBoundingClientRect();
      const active = ctx.active();
      const cell = ctx.grid.cellRect?.(active.r, active.c);
      const visible = viewport && cell && cell.right > viewport.left && cell.left < viewport.right
        && cell.bottom > viewport.top && cell.top < viewport.bottom;
      expanded = !expanded;
      refresh();
      if (visible) ctx.grid.scrollToActive?.();
    },
  });
  const chartTools = group(btn('chartColumn', 'Edit chart', 'editChart'), btn('copy', 'Copy chart as picture', 'copy'), btn('zoomIn', 'Fit chart to window', 'zoomFit'));
  chartTools.hidden = true;

  // Roving tabindex: one tab stop for the whole toolbar, arrows move inside.
  const buttons = () => [...root.querySelectorAll('.tb-btn')];
  const enabledButtons = () => buttons().filter((b) => !b.disabled && !b.closest('[hidden], [inert]'));
  function setTabStop(next) {
    for (const b of buttons()) b.tabIndex = b === next ? 0 : -1;
  }
  root.addEventListener('focusin', (e) => {
    if (enabledButtons().includes(e.target)) setTabStop(e.target);
  });
  root.addEventListener('keydown', (e) => {
    const list = enabledButtons();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === 'ArrowRight') next = list[(i + 1) % list.length];
    if (e.key === 'ArrowLeft') next = list[(i - 1 + list.length) % list.length];
    if (e.key === 'Home') next = list[0];
    if (e.key === 'End') next = list[list.length - 1];
    if (next) {
      e.preventDefault();
      setTabStop(next);
      next.focus();
    }
  });

  function colorMenu(anchor, kind, palette) {
    // Compared with the swatches in their lower case: a colour from a file may be spelt in upper case.
    const value = ctx.style()[kind];
    const current = value && typeof value === 'object' ? null : (kind === 'color' ? fontColorCss(value) : fillColorCss(value))?.toLowerCase();
    // A colour picked here becomes the one its button applies next.
    const pick = (hex, name = null) => {
      menu.close();
      if (swatchColor(typeof hex === 'object' && hex ? hex.rgb : hex)) { lastColor[kind] = hex; lastName[kind] = name; (kind === 'bg' ? fillApply : colorApply).sync(); }
      ctx.run(kind, hex);
    };
    // The palettes open on the theme's colours and their tints; the app's own colours follow as the standard row.
    const themeBlock = themeColorBlock(ctx.wb, { current: value, label: kind === 'bg' ? 'Theme fill colors' : 'Theme text colors', onPick: pick });
    const swatches = el('div.swatches', { role: 'group', 'aria-label': kind === 'bg' ? 'Fill colors' : 'Text colors', 'data-cols': 6 },
      el('button.swatch.none', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(!current), 'aria-label': kind === 'bg' ? 'No fill' : 'Default color',
        title: kind === 'bg' ? 'No fill' : 'Default', onclick: () => { menu.close(); ctx.run(kind, null); },
      }),
      ...palette.map((hex) => el('button.swatch', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(current === hex), 'aria-label': hex, title: hex,
        style: { background: hex }, onclick: () => pick(hex),
      })));
    const extra = customColorRows({ current, label: kind === 'bg' ? 'fill color' : 'text color', onPick: pick });
    const menu = openMenu({ anchor, label: kind === 'bg' ? 'Fill color' : 'Text color', items: [...themeBlock.map((custom) => ({ custom })), { header: 'Standard Colors' }, { custom: swatches }, ...extra.map((custom) => ({ custom }))] });
    // Swatches are the only items, so hand them keyboard focus; the menu walks the grid by its data-cols.
    const first = swatches.querySelector('[aria-checked="true"]') || swatches.querySelector('button');
    first?.focus();
  }

  function refresh() {
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const s = ctx.style();
    const set = (b, on) => b.setAttribute('aria-pressed', String(!!on));
    set(boldBtn, s.bold); set(italicBtn, s.italic); set(underlineBtn, s.underline); set(strikeBtn, s.strike);
    // The pressed alignment is the one the grid draws: given no alignment of its own, the shown value's
    // default (a spilled cell has no cell object, but shows a value all the same), and for text that
    // reads right to left, the right.
    const { r, c } = ctx.active();
    const value = ctx.wb.getValue(ctx.sheetId(), r, c);
    // On the ribbon, General alignment presses none of the three: only a chosen alignment shows.
    const align = ribbon ? s.align : s.align || (typeof value === 'string' && RTL_LEAD.test(value) ? 'right' : defaultAlign(value));
    set(alignL, align === 'left'); set(alignC, align === 'center'); set(alignR, align === 'right');
    set(wrapBtn, s.wrap);
    for (const b of verticalButtons) set(b, (s.valign || 'middle') === b.dataset.arg);
    const fmt = s.fmt || 'general';
    set(pctBtn, fmt === 'percent'); set(curBtn, fmt === 'currency');
    const entry = formatEntry(s);
    const formatLabel = entry.value === 'custom' ? (s.code || 'Custom') : entry.label;
    fmtBtn.querySelector('.tb-fmt-label').textContent = formatLabel;
    fmtBtn.title = `Number format: ${formatLabel}`;
    fmtBtn.setAttribute('aria-label', fmtBtn.title);
    const sizeLabel = String(pxToPt(s.size || 13));
    sizeBtn.querySelector('.tb-size-label').textContent = sizeLabel;
    // The name of a value-bearing button includes its visible value, so it can be spoken and heard.
    sizeBtn.setAttribute('aria-label', `Font size: ${sizeLabel}`);
    const fontLabel = fontBtn.querySelector('.tb-font-label');
    // A cell in the theme's body or heading font says so ("Calibri (Body)").
    const themeRole = fontName(s.font) && { minor: ' (Body)', major: ' (Headings)' }[s.scheme];
    fontLabel.textContent = (fontName(s.font) || 'Default') + (themeRole || '');
    fontLabel.style.fontFamily = fontStack(s.font) || '';
    fontBtn.setAttribute('aria-label', `Font: ${fontLabel.textContent}`);
    // Only as a colour, and only a hex one: `background` takes a url(), and a string smuggled into
    // a pasted cell style must not fetch anything when the cell is selected.
    colorBtn.querySelector('.color-bar').style.backgroundColor = swatchColor(fontColorCss(s.color)) || 'var(--ink)';
    const fill = swatchColor(fillColorCss(s.bg));
    fillBtn.querySelector('.color-bar').style.backgroundColor = fill || 'transparent';
    fillBtn.querySelector('.color-bar').classList.toggle('no-fill', !fill);
    // While a cell is being edited, undo and redo would act on the sheet behind the edit; they wait.
    const midEdit = ctx.grid.editing;
    undoBtn.disabled = midEdit || !ctx.wb.canUndo();
    undoArrow.disabled = undoBtn.disabled;
    redoBtn.disabled = midEdit || !ctx.wb.canRedo();
    // The right-click hint travels with the step named, since this tooltip replaces the one the button was built with.
    undoBtn.title = ctx.wb.canUndo() ? `Undo ${ctx.wb.undoLabel().toLowerCase()} (${MOD_KEY}+Z). Right-click for the history` : 'Nothing to undo';
    redoBtn.title = ctx.wb.canRedo() ? `Redo ${ctx.wb.redoLabel().toLowerCase()} (${MOD_KEY}+Shift+Z). Right-click for the history` : 'Nothing to redo';
    // The merge command unmerges when any selected range (Ctrl/Cmd+click adds them) holds a merge, and
    // merges every range that spans cells: the button says which, as the menus do, and waits when neither.
    const sheetId = ctx.sheetId();
    const ranges = ctx.ranges?.() ?? [ctx.range()];
    const merged = ranges.some((rg) => ctx.wb.mergesIn(sheetId, rg).length > 0);
    const multi = ranges.some((rg) => rg.r1 !== rg.r2 || rg.c1 !== rg.c2);
    set(mergeBtn, merged);
    set(filterBtn, !!ctx.wb.filterAt(sheetId, ctx.active().r, ctx.active().c));
    mergeBtn.disabled = midEdit || (!merged && !multi); // merging waits for the edit too
    if (mergeArrow) mergeArrow.disabled = midEdit;
    mergeBtn.title = merged ? 'Unmerge cells' : 'Merge cells';
    // On the ribbon the button is named by its label, Merge & Center, and says it is on by aria-pressed; the tooltip tells what a click does.
    mergeBtn.setAttribute('aria-label', ribbon ? 'Merge & Center' : merged ? 'Unmerge cells' : 'Merge cells');
    if (ribbon) mergeBtn.querySelector('.ribbon-button-label').textContent = 'Merge & Center';
    const editing = ctx.grid.editing;
    set(paintBtn, !!ctx.painting?.());
    for (const b of [sortBtn, rowsBtn, colsBtn, paintBtn]) b.disabled = editing;
    // Grouped sheets: sorting, filtering, freezing and the rules are for one sheet at a time; the buttons wait and say why.
    const grouped = !!ctx.wb.sheetGroup;
    for (const b of [sortBtn, filterBtn, freezeBtn, cfBtn, dvBtn]) {
      if (b.dataset.title == null) b.dataset.title = b.title;
      if (grouped) b.disabled = true; else if (b !== sortBtn) b.disabled = false;
      b.title = grouped ? `${b.dataset.title}: ${GROUP_BLOCKED_REASON}` : b.dataset.title;
    }
    // Dates, times, text and custom codes have no decimal places to step, so the buttons are greyed as the menus grey them.
    decLess.disabled = decMore.disabled = editing || ['date', 'time', 'datetime', 'text', 'custom'].includes(s.fmt);
    // Indenting and clearing formatting style the cell being edited, as Bold and the number formats do since
    // 212cec6, and the Format menu offers all three mid-edit: greying these out here said otherwise.
    indentLess.disabled = !(s.indent > 0);
    indentMore.disabled = s.indent >= 10;
    const chartSheet = ctx.wb.sheet(ctx.sheetId())?.kind === 'chart';
    const compact = narrow && !expanded && !chartSheet;
    for (const b of cellButtons) b.hidden = compact && !compactButtons.has(b);
    for (const group of worksheetGroups) {
      group.hidden = chartSheet || narrow && group.classList.contains('tb-sep') || compact && ![...group.querySelectorAll('.tb-btn')].some(b => !b.hidden);
    }
    // Separators have no stable neighbours when groups wrap; omit them in either narrow layout.
    if (historySeparator) historySeparator.hidden = narrow;
    chartTools.hidden = !chartSheet;
    // Appended only when missing: moving a node, even onto its own place, takes focus off the tool in it.
    if (chartSheet) { if (chartTools.parentNode !== root) root.append(chartTools); } else chartTools.remove();
    root.classList.toggle('toolbar-narrow', narrow);
    root.classList.toggle('toolbar-expanded', expanded && !chartSheet);
    if (!narrow || !expanded || chartSheet) tools.scrollTop = 0;
    if (narrow && !chartSheet) {
      if (expandBtn.parentNode !== tools) tools.append(expandBtn);
      expandBtn.setAttribute('aria-expanded', String(expanded));
      const label = expanded ? 'Show fewer formatting tools' : 'Show all formatting tools';
      expandBtn.setAttribute('aria-label', label);
      expandBtn.title = label;
      expandBtn.innerHTML = icon(expanded ? 'chevU' : 'more', 18);
    } else expandBtn.remove();
    const available = enabledButtons();
    const next = available.includes(focused) ? focused : available.find((b) => b.tabIndex === 0) || available[0];
    setTabStop(next);
    if (focused && !available.includes(focused)) next?.focus({ preventScroll: true });
  }

  const unsubscribe = ctx.subscribe(refresh);
  // Measure the toolbar itself, so a narrow editor in a split window or embedded view gets the
  // same treatment. A detached/hidden toolbar has no width yet and keeps its last layout.
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (!root.clientWidth) return;
    const next = !ribbon && root.clientWidth <= 640;
    if (next !== narrow) { narrow = next; refresh(); }
  }) : null;
  observer?.observe(root);
  refresh();
  return { el: root, refresh, destroy() { observer?.disconnect(); unsubscribe(); } };
}

export function rowItems(ctx) {
  const range = ctx.range();
  const n = range.r2 - range.r1 + 1;
  const s = n === 1 ? '' : 's';
  return [
    { label: `Insert ${n} row${s} above`, icon: 'arrowUp', onSelect: () => ctx.run('insertRows', 'above') },
    { label: `Insert ${n} row${s} below`, icon: 'arrowDown', onSelect: () => ctx.run('insertRows', 'below') },
    { separator: true },
    { label: n === 1 ? `Delete row ${range.r1 + 1}` : `Delete rows ${range.r1 + 1} to ${range.r2 + 1}`, icon: 'trash', danger: true, onSelect: () => ctx.run('deleteRows') },
    { separator: true },
    { label: n === 1 ? 'Resize row…' : `Resize ${n} rows…`, icon: 'rows', onSelect: () => ctx.run('resizeRows') },
  ];
}

export function colItems(ctx) {
  const range = ctx.range();
  const n = range.c2 - range.c1 + 1;
  const s = n === 1 ? '' : 's';
  return [
    { label: `Insert ${n} column${s} left`, icon: 'chevL', onSelect: () => ctx.run('insertCols', 'left') },
    { label: `Insert ${n} column${s} right`, icon: 'chevR', onSelect: () => ctx.run('insertCols', 'right') },
    { separator: true },
    { label: n === 1 ? 'Delete column' : `Delete ${n} columns`, icon: 'trash', danger: true, onSelect: () => ctx.run('deleteCols') },
    { label: 'Fit to content', icon: 'cols', onSelect: () => ctx.run('autofit') },
    { label: n === 1 ? 'Resize column…' : `Resize ${n} columns…`, icon: 'cols', onSelect: () => ctx.run('resizeCols') },
  ];
}
