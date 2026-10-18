/**
 * Page Layout ▸ Themes: the Themes gallery, the Colors and Fonts menus, the Create New Theme Colors and
 * Create New Theme Fonts dialogs, and the theme block of the Fill Color and Font Color palettes. The model
 * and its undoable step live in core/workbook-theme.js.
 */
import { el } from './dom.js';
import { openMenu } from './menu.js';
import { openModal, fieldAlert } from './modal.js';
import { FONTS, fontStack, fontKeyFor } from '../core/format.js';
import { sameFontColor } from '../core/font-color.js';
import {
  THEMES, COLOR_SCHEMES, FONT_SCHEMES, THEME_DIALOG_SLOTS, colorScheme, fontScheme,
  workbookTheme, applyGalleryTheme, applyWorkbookTheme, themeColorGrid, themedCellStyles, themedCellStylePatch,
} from '../core/workbook-theme.js';

const CUSTOM_COLORS_KEY = 'spreadsheet:themeColors';
const CUSTOM_FONTS_KEY = 'spreadsheet:themeFonts';
const HEX = /^#[0-9a-f]{6}$/i;

/** Colour and font schemes the person created, kept in this browser per user. */
function stored(key, valid) {
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(list) ? list.filter(valid).slice(0, 50) : [];
  } catch { return []; }
}
const validColors = s => s && typeof s.name === 'string' && s.name.trim() && Array.isArray(s.colors) && s.colors.length === 12 && s.colors.every(c => HEX.test(c));
const validFonts = s => s && typeof s.name === 'string' && s.name.trim() && typeof s.major === 'string' && typeof s.minor === 'string';
export const customColorSchemes = () => stored(CUSTOM_COLORS_KEY, validColors).map(s => ({ ...s, colors: s.colors.map(c => c.toLowerCase()) }));
export const customFontSchemes = () => stored(CUSTOM_FONTS_KEY, validFonts);
function remember(key, valid, entry) {
  const list = [entry, ...stored(key, valid).filter(s => s.name !== entry.name)].slice(0, 50);
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* no storage: the scheme still applies */ }
}

/** What the menus call a built-in scheme. The default theme, colours, fonts and effects keep the name
 * "Office" in workbook files, where other spreadsheet apps look for it; on screen they are "Default". */
export const schemeLabel = name => (name === 'Office' ? 'Default' : name);

const editing = ctx => !!ctx.grid?.editing && !ctx.grid.commitEdit?.();
const done = (ctx, changed) => { if (changed) ctx.grid?.focus?.(); };

/** A row of a scheme's colours as the Colors menu shows it: Text 2, Background 2 and the six accents. */
const strip = colors => el('span.theme-strip', { 'aria-hidden': 'true' },
  ...[1, 0, 3, 2, 4, 5, 6, 7, 8, 9].map(i => el('span', { style: { background: colors[i] } })));

/** Page Layout ▸ Themes: the gallery of themes. */
export function openThemesMenu(ctx, anchor) {
  if (editing(ctx)) return;
  const current = workbookTheme(ctx.wb);
  const tile = theme => {
    const colors = colorScheme(theme.colors).colors, fonts = fontScheme(theme.fonts);
    const checked = current.name === theme.name;
    return el('button.theme-tile', {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), tabindex: -1,
      'aria-label': `${schemeLabel(theme.name)} theme`, title: `${schemeLabel(theme.name)}\nColors: ${schemeLabel(theme.colors)} · Fonts: ${fonts.major} / ${fonts.minor}`,
      onclick: () => { menu.close(); done(ctx, applyGalleryTheme(ctx.wb, theme.name)); },
    },
    el('span.theme-tile-sample', { style: { background: colors[0], color: colors[1] }, 'aria-hidden': 'true' },
      el('span.theme-tile-aa', { style: { fontFamily: fontStack(fontKeyFor(fonts.major, { literal: true })) || '' } }, 'Aa'),
      el('span.theme-tile-bars', {}, ...[4, 5, 6, 7, 8, 9].map(i => el('span', { style: { background: colors[i] } })))),
    el('span.theme-tile-name', {}, schemeLabel(theme.name)));
  };
  const grid = el('div.theme-gallery', { role: 'group', 'aria-label': 'Themes', 'data-cols': 4 }, ...THEMES.map(tile));
  const menu = openMenu({
    anchor, label: 'Themes', minWidth: 360,
    items: [{ header: 'Built-In' }, { custom: grid }, { separator: true },
      { label: 'Reset to Default Theme', icon: 'reset', onSelect: () => done(ctx, applyGalleryTheme(ctx.wb, 'Office')) }],
    onClose: reason => { if (reason === 'select') ctx.grid?.focus?.(); },
  });
  (grid.querySelector('[aria-checked="true"]') || grid.querySelector('button'))?.focus();
  return menu;
}

/** Page Layout ▸ Colors: the colour schemes, the person's own first, and Customize Colors…. */
export function openThemeColorsMenu(ctx, anchor) {
  if (editing(ctx)) return;
  const current = workbookTheme(ctx.wb);
  const row = scheme => el('button.menu-item.theme-scheme-item', {
    type: 'button', role: 'menuitemradio', tabindex: -1, 'aria-checked': String(current.colorsName === scheme.name
      && scheme.colors.every((c, i) => c === current.colors[i])),
    onclick: () => { menu.close(); done(ctx, applyWorkbookTheme(ctx.wb, { colors: { name: scheme.name, colors: scheme.colors } }, `Theme colors: ${schemeLabel(scheme.name)}`)); },
  }, strip(scheme.colors), el('span.menu-label', {}, schemeLabel(scheme.name)));
  const custom = customColorSchemes();
  const menu = openMenu({
    anchor, label: 'Colors', minWidth: 260,
    items: [
      ...(custom.length ? [{ header: 'Custom' }, ...custom.map(s => ({ custom: row(s) }))] : []),
      { header: 'Built-In' }, ...COLOR_SCHEMES.map(s => ({ custom: row(s) })), { separator: true },
      { label: 'Customize Colors…', icon: 'palette', onSelect: () => openCustomizeColorsDialog(ctx) },
    ],
    onClose: reason => { if (reason === 'select') ctx.grid?.focus?.(); },
  });
  (menu.menu.querySelector('[aria-checked="true"]') || menu.menu.querySelector('.theme-scheme-item'))?.focus();
  return menu;
}

/** Page Layout ▸ Fonts: heading/body pairs, each shown in its own faces, and Customize Fonts…. */
export function openThemeFontsMenu(ctx, anchor) {
  if (editing(ctx)) return;
  const current = workbookTheme(ctx.wb);
  const face = name => fontStack(fontKeyFor(name, { literal: true })) || '';
  const row = scheme => el('button.menu-item.theme-font-item', {
    type: 'button', role: 'menuitemradio', tabindex: -1,
    'aria-checked': String(current.major === scheme.major && current.minor === scheme.minor && (current.fontsName === scheme.name || scheme.name === 'Office')),
    'aria-label': `${schemeLabel(scheme.name)}: ${scheme.major}, ${scheme.minor}`,
    onclick: () => { menu.close(); done(ctx, applyWorkbookTheme(ctx.wb, { fonts: { ...scheme } }, `Theme fonts: ${schemeLabel(scheme.name)}`)); },
  },
  el('span.theme-font-aa', { 'aria-hidden': 'true', style: { fontFamily: face(scheme.major) } }, 'Aa'),
  el('span.theme-font-text', {}, el('span.theme-font-name', {}, schemeLabel(scheme.name)),
    el('span.theme-font-face', { style: { fontFamily: face(scheme.major) } }, scheme.major),
    el('span.theme-font-face', { style: { fontFamily: face(scheme.minor) } }, scheme.minor)));
  const custom = customFontSchemes();
  const menu = openMenu({
    anchor, label: 'Fonts', minWidth: 240,
    items: [
      ...(custom.length ? [{ header: 'Custom' }, ...custom.map(s => ({ custom: row(s) }))] : []),
      { header: 'Built-In' }, ...FONT_SCHEMES.map(s => ({ custom: row(s) })), { separator: true },
      { label: 'Customize Fonts…', icon: 'text', onSelect: () => openCustomizeFontsDialog(ctx) },
    ],
    onClose: reason => { if (reason === 'select') ctx.grid?.focus?.(); },
  });
  (menu.menu.querySelector('[aria-checked="true"]') || menu.menu.querySelector('.theme-font-item'))?.focus();
  return menu;
}

const nextName = (prefix, taken) => { let n = 1; while (taken.includes(`${prefix} ${n}`)) n++; return `${prefix} ${n}`; };

/** Create New Theme Colors: the twelve colours, a sample, a name; Save applies them to the workbook. */
export function openCustomizeColorsDialog(ctx) {
  if (editing(ctx)) return;
  const start = workbookTheme(ctx.wb).colors.slice();
  const colors = start.slice();
  const preview = el('div.theme-colors-preview', { 'aria-hidden': 'true' });
  const paintPreview = () => preview.replaceChildren(
    el('div.theme-preview-page', { style: { background: colors[0], color: colors[1] } },
      el('div.theme-preview-text', {}, 'Text'),
      el('div.theme-preview-bars', {}, ...[4, 5, 6, 7, 8, 9].map(i => el('span', { style: { background: colors[i], height: `${40 + i * 6}%` } }))),
      el('div.theme-preview-links', {}, el('span', { style: { color: colors[10] } }, 'Hyperlink'), ' ', el('span', { style: { color: colors[11] } }, 'Followed'))),
    el('div.theme-preview-page', { style: { background: colors[3], color: colors[2] } },
      el('div.theme-preview-text', {}, 'Text'),
      el('div.theme-preview-bars', {}, ...[4, 5, 6, 7, 8, 9].map(i => el('span', { style: { background: colors[i], height: `${40 + i * 6}%` } })))));
  const inputs = THEME_DIALOG_SLOTS.map(([label, index]) => {
    const input = el('input.theme-color-input', { type: 'color', value: colors[index], 'aria-label': label,
      oninput: () => { colors[index] = input.value.toLowerCase(); paintPreview(); } });
    return { input, index, row: el('label.theme-color-row', {}, el('span', {}, label), input) };
  });
  const taken = customColorSchemes().map(s => s.name);
  const name = el('input.input', { type: 'text', value: nextName('Custom', taken), maxlength: 64, 'aria-label': 'Name', spellcheck: false });
  const { alert, refuse } = fieldAlert('theme-colors');
  const submit = e => {
    e?.preventDefault();
    const title = name.value.trim();
    if (!title || /[<>"\u0000-\u001f]/.test(title)) return refuse(name, 'Type a name without < > or "');
    if (COLOR_SCHEMES.some(s => s.name === title)) return refuse(name, 'A built-in color scheme has that name');
    remember(CUSTOM_COLORS_KEY, validColors, { name: title, colors });
    modal.close();
    done(ctx, applyWorkbookTheme(ctx.wb, { colors: { name: title, colors } }, `Theme colors: ${title}`));
  };
  const reset = () => { start.forEach((c, i) => { colors[i] = c; }); for (const { input, index } of inputs) input.value = colors[index]; paintPreview(); };
  paintPreview();
  const content = el('form.theme-colors-dialog', { onsubmit: submit },
    el('div.theme-colors-body', {},
      el('fieldset.theme-colors-fields', {}, el('legend', {}, 'Theme colors'), ...inputs.map(i => i.row)),
      el('div.theme-colors-sample', {}, el('span.field-label', {}, 'Sample'), preview)),
    el('label.field', {}, el('span.field-label', {}, 'Name'), name, alert),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: reset }, 'Reset'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Save')));
  const modal = openModal({ title: 'Create New Theme Colors', content, initialFocus: inputs[0].input, wide: true, onClose: () => ctx.grid?.focus?.() });
  return modal;
}

/** Create New Theme Fonts: a heading and a body face from the fonts the app draws, and a name. */
export function openCustomizeFontsDialog(ctx) {
  if (editing(ctx)) return;
  const current = workbookTheme(ctx.wb);
  const names = [...new Set([current.major, current.minor, ...FONTS.filter(f => f[2]).map(f => f[1])])];
  const select = (label, value) => el('select.select', { 'aria-label': label }, ...names.map(n => el('option', { value: n, selected: n === value }, n)));
  const heading = select('Heading font', current.major), body = select('Body font', current.minor);
  const sample = el('div.theme-fonts-sample', { 'aria-hidden': 'true' });
  const paint = () => sample.replaceChildren(
    el('div', { style: { fontFamily: fontStack(fontKeyFor(heading.value, { literal: true })) || '', fontSize: '20px' } }, 'Heading'),
    el('div', { style: { fontFamily: fontStack(fontKeyFor(body.value, { literal: true })) || '' } }, 'Body text body text body text. Body text body text.'));
  heading.onchange = paint; body.onchange = paint; paint();
  const taken = customFontSchemes().map(s => s.name);
  const name = el('input.input', { type: 'text', value: nextName('Custom', taken), maxlength: 64, 'aria-label': 'Name', spellcheck: false });
  const { alert, refuse } = fieldAlert('theme-fonts');
  const submit = e => {
    e?.preventDefault();
    const title = name.value.trim();
    if (!title || /[<>"\u0000-\u001f]/.test(title)) return refuse(name, 'Type a name without < > or "');
    if (FONT_SCHEMES.some(s => s.name === title)) return refuse(name, 'A built-in font scheme has that name');
    const scheme = { name: title, major: heading.value, minor: body.value };
    remember(CUSTOM_FONTS_KEY, validFonts, scheme);
    modal.close();
    done(ctx, applyWorkbookTheme(ctx.wb, { fonts: scheme }, `Theme fonts: ${title}`));
  };
  const content = el('form', { onsubmit: submit },
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, 'Heading font:'), heading),
      el('label.field', {}, el('span.field-label', {}, 'Body font:'), body)),
    el('div.field', {}, el('span.field-label', {}, 'Sample'), sample),
    el('label.field', {}, el('span.field-label', {}, 'Name'), name, alert),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Save')));
  const modal = openModal({ title: 'Create New Theme Fonts', content, initialFocus: heading, onClose: () => ctx.grid?.focus?.() });
  return modal;
}

/**
 * The theme block at the top of a colour palette: ten theme colours over their five tints.
 * `current` is the cell's colour (a reference is matched by slot and tint); `onPick`
 * receives the colour reference.
 */
export function themeColorBlock(wb, { current = null, onPick, label = 'Theme colors' }) {
  const grid = themeColorGrid(workbookTheme(wb).colors);
  const swatches = el('div.swatches.swatches-theme', { role: 'group', 'aria-label': label, 'data-cols': 10 },
    ...grid.flat().map(cell => el('button.swatch', {
      type: 'button', role: 'menuitemradio', tabindex: -1,
      'aria-checked': String(!!current && typeof current === 'object' && sameFontColor(current, cell.color)),
      'aria-label': cell.label, title: `${cell.label} (${cell.color.rgb})`,
      style: { background: cell.color.rgb }, onclick: () => onPick(cell.color, cell.label),
    })));
  return [el('div.menu-header', {}, 'Theme Colors'), swatches];
}

/** The Cell Styles menu's Themed Cell Styles: the accents at 20%, 40% and 60%, and full, in the theme's colours. */
export function themedCellStyleItems(wb, onPick) {
  const styles = themedCellStyles();
  const order = [20, 40, 60, 0].flatMap(pct => styles.filter(s => (pct ? s.key.endsWith(`-${pct}`) : !s.key.includes('-'))));
  const grid = el('div.themed-cell-styles', { role: 'group', 'aria-label': 'Themed Cell Styles', 'data-cols': 6 },
    ...order.map(def => {
      const { patch } = themedCellStylePatch(def.key, wb);
      return el('button.menu-item.cell-style-item.themed-cell-style', { type: 'button', role: 'menuitem', tabindex: -1, title: def.label, onclick: () => onPick(def.key) },
        el('span.cell-style-sample.sheet-paper', { style: { color: patch.color.rgb, background: patch.bg.rgb } }, def.label));
    }));
  return [{ header: 'Themed Cell Styles' }, { custom: grid }];
}
