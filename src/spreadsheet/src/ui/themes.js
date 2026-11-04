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
  workbookTheme, applyGalleryTheme, applyWorkbookTheme, themeColorGrid, themedCellStyles, themedCellStylePatch, themedCellStyleLabel, schemeName,
} from '../core/workbook-theme.js';
import { effectSchemeName } from '../core/theme-effects.js';
import { t } from '../i18n/index.js';

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
 * "Office" in workbook files, where other spreadsheet apps look for it; on screen they are "Default". The app's
 * other schemes are named in the interface language; a name of the person's own or a file's is shown as it is. */
export const schemeLabel = name => (name === 'Office' ? t('common.default') : effectSchemeName(schemeName(name)));

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
      'aria-label': t('themes.themeTile', { name: schemeLabel(theme.name) }),
      title: t('themes.themeTileTip', { name: schemeLabel(theme.name), colors: schemeLabel(theme.colors), major: fonts.major, minor: fonts.minor }),
      onclick: () => { menu.close(); done(ctx, applyGalleryTheme(ctx.wb, theme.name)); },
    },
    el('span.theme-tile-sample', { style: { background: colors[0], color: colors[1] }, 'aria-hidden': 'true' },
      el('span.theme-tile-aa', { style: { fontFamily: fontStack(fontKeyFor(fonts.major, { literal: true })) || '' } }, 'Aa'),
      el('span.theme-tile-bars', {}, ...[4, 5, 6, 7, 8, 9].map(i => el('span', { style: { background: colors[i] } })))),
    el('span.theme-tile-name', {}, schemeLabel(theme.name)));
  };
  const grid = el('div.theme-gallery', { role: 'group', 'aria-label': t('themes.themes'), 'data-cols': 4 }, ...THEMES.map(tile));
  const menu = openMenu({
    anchor, label: t('themes.themes'), minWidth: 360,
    items: [{ header: t('themes.builtIn') }, { custom: grid }, { separator: true },
      { label: t('themes.resetTheme'), icon: 'reset', onSelect: () => done(ctx, applyGalleryTheme(ctx.wb, 'Office')) }],
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
    onclick: () => { menu.close(); done(ctx, applyWorkbookTheme(ctx.wb, { colors: { name: scheme.name, colors: scheme.colors } }, t('themes.undo.colors', { name: schemeLabel(scheme.name) }))); },
  }, strip(scheme.colors), el('span.menu-label', {}, schemeLabel(scheme.name)));
  const custom = customColorSchemes();
  const menu = openMenu({
    anchor, label: t('themes.colors'), minWidth: 260,
    items: [
      ...(custom.length ? [{ header: t('common.custom') }, ...custom.map(s => ({ custom: row(s) }))] : []),
      { header: t('themes.builtIn') }, ...COLOR_SCHEMES.map(s => ({ custom: row(s) })), { separator: true },
      { label: t('themes.customizeColors'), icon: 'palette', onSelect: () => openCustomizeColorsDialog(ctx) },
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
    'aria-label': t('themes.fontSchemeItem', { name: schemeLabel(scheme.name), major: scheme.major, minor: scheme.minor }),
    onclick: () => { menu.close(); done(ctx, applyWorkbookTheme(ctx.wb, { fonts: { ...scheme } }, t('themes.undo.fonts', { name: schemeLabel(scheme.name) }))); },
  },
  el('span.theme-font-aa', { 'aria-hidden': 'true', style: { fontFamily: face(scheme.major) } }, 'Aa'),
  el('span.theme-font-text', {}, el('span.theme-font-name', {}, schemeLabel(scheme.name)),
    el('span.theme-font-face', { style: { fontFamily: face(scheme.major) } }, scheme.major),
    el('span.theme-font-face', { style: { fontFamily: face(scheme.minor) } }, scheme.minor)));
  const custom = customFontSchemes();
  const menu = openMenu({
    anchor, label: t('themes.fonts'), minWidth: 240,
    items: [
      ...(custom.length ? [{ header: t('common.custom') }, ...custom.map(s => ({ custom: row(s) }))] : []),
      { header: t('themes.builtIn') }, ...FONT_SCHEMES.map(s => ({ custom: row(s) })), { separator: true },
      { label: t('themes.customizeFonts'), icon: 'text', onSelect: () => openCustomizeFontsDialog(ctx) },
    ],
    onClose: reason => { if (reason === 'select') ctx.grid?.focus?.(); },
  });
  (menu.menu.querySelector('[aria-checked="true"]') || menu.menu.querySelector('.theme-font-item'))?.focus();
  return menu;
}

/** The first "Custom 1", "Custom 2", … not yet taken: the name a new scheme starts with. */
const nextName = (taken) => { let n = 1; while (taken.includes(t('themes.customName', { n }))) n++; return t('themes.customName', { n }); };

/** Create New Theme Colors: the twelve colours, a sample, a name; Save applies them to the workbook. */
export function openCustomizeColorsDialog(ctx) {
  if (editing(ctx)) return;
  const start = workbookTheme(ctx.wb).colors.slice();
  const colors = start.slice();
  const preview = el('div.theme-colors-preview', { 'aria-hidden': 'true' });
  const paintPreview = () => preview.replaceChildren(
    el('div.theme-preview-page', { style: { background: colors[0], color: colors[1] } },
      el('div.theme-preview-text', {}, t('themes.previewText')),
      el('div.theme-preview-bars', {}, ...[4, 5, 6, 7, 8, 9].map(i => el('span', { style: { background: colors[i], height: `${40 + i * 6}%` } }))),
      el('div.theme-preview-links', {}, el('span', { style: { color: colors[10] } }, t('themes.previewHyperlink')), ' ', el('span', { style: { color: colors[11] } }, t('themes.previewFollowed')))),
    el('div.theme-preview-page', { style: { background: colors[3], color: colors[2] } },
      el('div.theme-preview-text', {}, t('themes.previewText')),
      el('div.theme-preview-bars', {}, ...[4, 5, 6, 7, 8, 9].map(i => el('span', { style: { background: colors[i], height: `${40 + i * 6}%` } })))));
  const inputs = THEME_DIALOG_SLOTS.map(([key, index]) => {
    const label = t(key);
    const input = el('input.theme-color-input', { type: 'color', value: colors[index], 'aria-label': label,
      oninput: () => { colors[index] = input.value.toLowerCase(); paintPreview(); } });
    return { input, index, row: el('label.theme-color-row', {}, el('span', {}, label), input) };
  });
  const taken = customColorSchemes().map(s => s.name);
  const name = el('input.input', { type: 'text', value: nextName(taken), maxlength: 64, 'aria-label': t('common.name'), spellcheck: false });
  const { alert, refuse } = fieldAlert('theme-colors');
  const submit = e => {
    e?.preventDefault();
    const title = name.value.trim();
    if (!title || /[<>"\u0000-\u001f]/.test(title)) return refuse(name, t('themes.badName'));
    if (COLOR_SCHEMES.some(s => s.name === title)) return refuse(name, t('themes.builtInColorsName'));
    remember(CUSTOM_COLORS_KEY, validColors, { name: title, colors });
    modal.close();
    done(ctx, applyWorkbookTheme(ctx.wb, { colors: { name: title, colors } }, t('themes.undo.colors', { name: title })));
  };
  const reset = () => { start.forEach((c, i) => { colors[i] = c; }); for (const { input, index } of inputs) input.value = colors[index]; paintPreview(); };
  paintPreview();
  const content = el('form.theme-colors-dialog', { onsubmit: submit },
    el('div.theme-colors-body', {},
      el('fieldset.theme-colors-fields', {}, el('legend', {}, t('themes.themeColors')), ...inputs.map(i => i.row)),
      el('div.theme-colors-sample', {}, el('span.field-label', {}, t('themes.sample')), preview)),
    el('label.field', {}, el('span.field-label', {}, t('common.name')), name, alert),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: reset }, t('common.reset')),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.save'))));
  const modal = openModal({ title: t('themes.createColors'), content, initialFocus: inputs[0].input, wide: true, onClose: () => ctx.grid?.focus?.() });
  return modal;
}

/** Create New Theme Fonts: a heading and a body face from the fonts the app draws, and a name. */
export function openCustomizeFontsDialog(ctx) {
  if (editing(ctx)) return;
  const current = workbookTheme(ctx.wb);
  const names = [...new Set([current.major, current.minor, ...FONTS.filter(f => f[2]).map(f => f[1])])];
  const select = (label, value) => el('select.select', { 'aria-label': label }, ...names.map(n => el('option', { value: n, selected: n === value }, n)));
  const heading = select(t('themes.headingFont'), current.major), body = select(t('themes.bodyFont'), current.minor);
  const sample = el('div.theme-fonts-sample', { 'aria-hidden': 'true' });
  const paint = () => sample.replaceChildren(
    el('div', { style: { fontFamily: fontStack(fontKeyFor(heading.value, { literal: true })) || '', fontSize: '20px' } }, t('themes.sampleHeading')),
    el('div', { style: { fontFamily: fontStack(fontKeyFor(body.value, { literal: true })) || '' } }, t('themes.sampleBody')));
  heading.onchange = paint; body.onchange = paint; paint();
  const taken = customFontSchemes().map(s => s.name);
  const name = el('input.input', { type: 'text', value: nextName(taken), maxlength: 64, 'aria-label': t('common.name'), spellcheck: false });
  const { alert, refuse } = fieldAlert('theme-fonts');
  const submit = e => {
    e?.preventDefault();
    const title = name.value.trim();
    if (!title || /[<>"\u0000-\u001f]/.test(title)) return refuse(name, t('themes.badName'));
    if (FONT_SCHEMES.some(s => s.name === title)) return refuse(name, t('themes.builtInFontsName'));
    const scheme = { name: title, major: heading.value, minor: body.value };
    remember(CUSTOM_FONTS_KEY, validFonts, scheme);
    modal.close();
    done(ctx, applyWorkbookTheme(ctx.wb, { fonts: scheme }, t('themes.undo.fonts', { name: title })));
  };
  const content = el('form', { onsubmit: submit },
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, t('themes.headingFontLabel')), heading),
      el('label.field', {}, el('span.field-label', {}, t('themes.bodyFontLabel')), body)),
    el('div.field', {}, el('span.field-label', {}, t('themes.sample')), sample),
    el('label.field', {}, el('span.field-label', {}, t('common.name')), name, alert),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.save'))));
  const modal = openModal({ title: t('themes.createFonts'), content, initialFocus: heading, onClose: () => ctx.grid?.focus?.() });
  return modal;
}

/**
 * The theme block at the top of a colour palette: ten theme colours over their five tints.
 * `current` is the cell's colour (a reference is matched by slot and tint); `onPick`
 * receives the colour reference.
 */
export function themeColorBlock(wb, { current = null, onPick, label = t('themes.themeColors') }) {
  const grid = themeColorGrid(workbookTheme(wb).colors);
  const swatches = el('div.swatches.swatches-theme', { role: 'group', 'aria-label': label, 'data-cols': 10 },
    ...grid.flat().map(cell => el('button.swatch', {
      type: 'button', role: 'menuitemradio', tabindex: -1,
      'aria-checked': String(!!current && typeof current === 'object' && sameFontColor(current, cell.color)),
      'aria-label': cell.label, title: t('themes.swatchTip', { label: cell.label, rgb: cell.color.rgb }),
      style: { background: cell.color.rgb }, onclick: () => onPick(cell.color, cell.label),
    })));
  return [el('div.menu-header', {}, t('themes.themeColorsHeader')), swatches];
}

/** The Cell Styles menu's Themed Cell Styles: the accents at 20%, 40% and 60%, and full, in the theme's colours. */
export function themedCellStyleItems(wb, onPick) {
  const styles = themedCellStyles();
  const order = [20, 40, 60, 0].flatMap(pct => styles.filter(s => (pct ? s.key.endsWith(`-${pct}`) : !s.key.includes('-'))));
  const grid = el('div.themed-cell-styles', { role: 'group', 'aria-label': t('themes.themedCellStyles'), 'data-cols': 6 },
    ...order.map(def => {
      const { patch } = themedCellStylePatch(def.key, wb);
      const label = themedCellStyleLabel(def);
      return el('button.menu-item.cell-style-item.themed-cell-style', { type: 'button', role: 'menuitem', tabindex: -1, title: label, onclick: () => onPick(def.key) },
        el('span.cell-style-sample.sheet-paper', { style: { color: patch.color.rgb, background: patch.bg.rgb } }, label));
    }));
  return [{ header: t('themes.themedCellStyles') }, { custom: grid }];
}
