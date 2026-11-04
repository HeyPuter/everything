/**
 * Workbook themes (Page Layout ▸ Themes): twelve theme colours (two dark/light
 * pairs, six accents and the two hyperlink colours) and a heading/body font pair. Cells, rich text, whole
 * lines and the Normal font hold references to them (`{ theme, tint }` colours, `scheme: 'major'|'minor'`
 * fonts); applying a theme resolves every reference again, as one undoable step.
 *
 * The model is the workbook's own `colorPalette.theme` (index order: lt1, dk1, lt2, dk2, accent1–6,
 * hlink, folHlink, as SpreadsheetML numbers them), `fontTheme` (the DrawingML font scheme) and
 * `themeInfo` ({ name, colors, fonts }: the names the gallery shows). With no `themeInfo`, or one naming
 * the default colours, the app keeps its own default look for charts, table and cell styles.
 */
import { DEFAULT_COLOR_PALETTE, effectiveColorPalette, normalizeColorPalette, normalizeFontColor, tintRgb } from './font-color.js';
import { effectiveFontTheme, normalizeFontTheme } from './font-theme.js';
import { normalizeNormalFont, normalFontStyle } from './normal-font.js';
import { fontKeyFor } from './format.js';
import { DEFAULT_EFFECTS_NAME, effectScheme, readEffectSchemeName, writeEffectScheme } from './theme-effects.js';
import { t } from '../i18n/index.js';

export const THEME_SLOTS = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
/** The message keys of the names the colour tooltips give the theme slots, in index order. */
export const THEME_SLOT_LABELS = [
  'workbookTheme.slot.light1', 'workbookTheme.slot.dark1', 'workbookTheme.slot.light2', 'workbookTheme.slot.dark2',
  'workbookTheme.slot.accent1', 'workbookTheme.slot.accent2', 'workbookTheme.slot.accent3', 'workbookTheme.slot.accent4',
  'workbookTheme.slot.accent5', 'workbookTheme.slot.accent6', 'workbookTheme.slot.link', 'workbookTheme.slot.visitedLink',
];
/** What the colour tooltips call theme slot `index`: "Accent 1". */
export const themeSlotLabel = index => (THEME_SLOT_LABELS[index] ? t(THEME_SLOT_LABELS[index]) : '');
/** The Customize Colors dialog's names (message keys), in its order (dark before light), with the slot index each edits. */
export const THEME_DIALOG_SLOTS = [
  ['workbookTheme.dialogSlot.dark1', 1], ['workbookTheme.dialogSlot.light1', 0], ['workbookTheme.dialogSlot.dark2', 3], ['workbookTheme.dialogSlot.light2', 2],
  ['workbookTheme.dialogSlot.accent1', 4], ['workbookTheme.dialogSlot.accent2', 5], ['workbookTheme.dialogSlot.accent3', 6], ['workbookTheme.dialogSlot.accent4', 7],
  ['workbookTheme.dialogSlot.accent5', 8], ['workbookTheme.dialogSlot.accent6', 9], ['workbookTheme.dialogSlot.link', 10], ['workbookTheme.dialogSlot.visitedLink', 11],
];
export const DEFAULT_THEME_NAME = 'Office';

const hexes = text => Object.freeze(text.split(' ').map(c => `#${c.toLowerCase()}`));
/** Colour schemes: the app's default (written and read under the theme name "Office"), then its own palettes. */
export const COLOR_SCHEMES = Object.freeze([
  { name: 'Office', colors: DEFAULT_COLOR_PALETTE.theme },
  { name: 'Harbor', colors: hexes('FFFFFF 000000 E9EEF2 1D3445 2B6CB0 E07A2E 3F9C6D C8A23A 7A5AA6 2F9FB4 1F6FD1 7A4FA0') },
  { name: 'Meadow', colors: hexes('FFFFFF 000000 EEF3E6 2E4A23 6BA539 2F8F7A C4B43A A3612E 5C7FB8 8A6BB0 3C7F2E 6E5A8F') },
  { name: 'Ember', colors: hexes('FFFFFF 000000 F6EEE6 4A2618 D2552B E39A2C 9C3D54 5E7C3A 3F6E8F 8C6D46 C2481E 7D4E6A') },
  { name: 'Lagoon', colors: hexes('FFFFFF 000000 E6F2F3 123E4A 1497A6 2C6FB7 5BB37F F2A541 E2675D 7B68B5 0F7F9E 6B5AA0') },
  { name: 'Orchard', colors: hexes('FFFFFF 000000 F4EEF2 3D2440 A23B72 D9673C 5D9E48 E2B33B 4C7CB3 7A5195 9B2F6A 5E4A85') },
  { name: 'Slate', colors: hexes('FFFFFF 000000 ECEDEF 2F3640 5B6B7F 8C9BAA 3E7CB1 C0763F 6F9F6A A8647A 2E6DA4 6E5F82') },
  { name: 'Canyon', colors: hexes('FFFFFF 000000 F3ECE4 4B3426 B5562F CF8F3A 8E7B4A 5E8C80 9A5A6E 6C6A8F A04A26 6F5A78') },
  { name: 'Aurora', colors: hexes('FFFFFF 000000 ECF0F7 23234A 3A5BD9 22A699 8F4FCF E0518F F0B23A 46A3E0 3550C8 8545B8') },
  { name: 'Blossom', colors: hexes('FFFFFF 000000 FBEFF2 4E2A3A E26D8F F2A365 9C7AC4 6CB2A6 D9C25A 7C93C9 C9507A 8D6AB0') },
  { name: 'Citrus', colors: hexes('FFFFFF 000000 F5F6E8 3A3F1E E8B21F 9CC23A F07A2F 3FA88A D9453E 5C80C7 3D8F2E 8A6A2E') },
  { name: 'Monochrome', colors: hexes('FFFFFF 000000 EFEFEF 3A3A3A 5E5E5E 7A7A7A 949494 ADADAD 474747 2B2B2B 3A3A3A 7A7A7A') },
]);

/** Heading/body pairs from faces the app can draw (each has a stack with fallbacks in format.js). */
export const FONT_SCHEMES = Object.freeze([
  { name: 'Office', major: 'Cambria', minor: 'Calibri' },
  { name: 'Ledger', major: 'Georgia', minor: 'Verdana' },
  { name: 'Plain', major: 'Arial', minor: 'Arial' },
  { name: 'Humanist', major: 'Corbel', minor: 'Corbel' },
  { name: 'Gazette', major: 'Rockwell', minor: 'Calibri' },
  { name: 'Studio', major: 'Century Gothic', minor: 'Century Gothic' },
  { name: 'Constant', major: 'Constantia', minor: 'Corbel' },
  { name: 'Signal', major: 'Tahoma', minor: 'Tahoma' },
  { name: 'Folio', major: 'Garamond', minor: 'Garamond' },
  { name: 'Bulletin', major: 'Trebuchet MS', minor: 'Trebuchet MS' },
  { name: 'Airy', major: 'Lato Light', minor: 'Lato' },
  { name: 'Broadsheet', major: 'Times New Roman', minor: 'Arial' },
  { name: 'Typewriter', major: 'Courier New', minor: 'Courier New' },
]);

/** The gallery: a theme is a colour scheme and a font scheme under one name. */
export const THEMES = Object.freeze([
  { name: 'Office', colors: 'Office', fonts: 'Office' },
  { name: 'Harbor', colors: 'Harbor', fonts: 'Ledger' },
  { name: 'Meadow', colors: 'Meadow', fonts: 'Humanist' },
  { name: 'Ember', colors: 'Ember', fonts: 'Gazette' },
  { name: 'Lagoon', colors: 'Lagoon', fonts: 'Studio' },
  { name: 'Orchard', colors: 'Orchard', fonts: 'Constant' },
  { name: 'Slate', colors: 'Slate', fonts: 'Signal' },
  { name: 'Canyon', colors: 'Canyon', fonts: 'Folio' },
  { name: 'Aurora', colors: 'Aurora', fonts: 'Bulletin' },
  { name: 'Blossom', colors: 'Blossom', fonts: 'Airy' },
  { name: 'Citrus', colors: 'Citrus', fonts: 'Broadsheet' },
  { name: 'Monochrome', colors: 'Monochrome', fonts: 'Plain' },
]);

// The names the app's own themes, colour schemes and font schemes go by on screen. Files keep the names above,
// which are the schemes' identity; a name the app does not know (a file's own theme) is shown as it is.
const SCHEME_NAME_KEYS = {
  Office: 'workbookTheme.scheme.office', Harbor: 'workbookTheme.scheme.harbor', Meadow: 'workbookTheme.scheme.meadow',
  Ember: 'workbookTheme.scheme.ember', Lagoon: 'workbookTheme.scheme.lagoon', Orchard: 'workbookTheme.scheme.orchard',
  Slate: 'workbookTheme.scheme.slate', Canyon: 'workbookTheme.scheme.canyon', Aurora: 'workbookTheme.scheme.aurora',
  Blossom: 'workbookTheme.scheme.blossom', Citrus: 'workbookTheme.scheme.citrus', Monochrome: 'workbookTheme.scheme.monochrome',
  Ledger: 'workbookTheme.scheme.ledger', Plain: 'workbookTheme.scheme.plain', Humanist: 'workbookTheme.scheme.humanist',
  Gazette: 'workbookTheme.scheme.gazette', Studio: 'workbookTheme.scheme.studio', Constant: 'workbookTheme.scheme.constant',
  Signal: 'workbookTheme.scheme.signal', Folio: 'workbookTheme.scheme.folio', Bulletin: 'workbookTheme.scheme.bulletin',
  Airy: 'workbookTheme.scheme.airy', Broadsheet: 'workbookTheme.scheme.broadsheet', Typewriter: 'workbookTheme.scheme.typewriter',
};
/** A theme, colour scheme or font scheme's name in the interface language ("Office" stays Office). */
export const schemeName = name => (Object.hasOwn(SCHEME_NAME_KEYS, name) ? t(SCHEME_NAME_KEYS[name]) : name);

export const colorScheme = name => COLOR_SCHEMES.find(s => s.name === name) || null;
export const fontScheme = name => FONT_SCHEMES.find(s => s.name === name) || null;
export const galleryTheme = name => THEMES.find(t => t.name === name) || null;

const NAME = /^[^\u0000-\u001f<>"]{1,64}$/;
const validName = value => typeof value === 'string' && NAME.test(value.trim()) ? value.trim() : null;

/** { name, colors, fonts }: the names of the theme and of its colour and font schemes; null when none is known. */
export function normalizeThemeInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  // The font scheme's name lives in fontTheme alone, so a file's theme and the app's model never disagree about it.
  for (const key of ['name', 'colors']) { const v = validName(raw[key]); if (v) out[key] = v; }
  // The effect scheme (Page Layout ▸ Effects), when it is one other than the default.
  if (effectScheme(raw.effects) && raw.effects !== DEFAULT_EFFECTS_NAME) out.effects = raw.effects;
  if (raw.ownNormal === true) out.ownNormal = true;
  return Object.keys(out).length ? out : null;
}

/** A file's theme names, with the app's own note (kept in its metadata) that it gave the workbook its Normal font. */
export function importedThemeInfo(fromFile, fromMeta, normalFont) {
  const meta = normalizeThemeInfo(fromMeta);
  const info = { ...(meta || {}), ...(normalizeThemeInfo(fromFile) || {}) };
  if (!(meta?.ownNormal && normalFont?.scheme === 'minor')) delete info.ownNormal;
  // The default theme ("Office" in files) is no choice of the workbook's: it stays unnamed, as a new one is.
  if (!info.ownNormal && ['name', 'colors'].every(key => info[key] == null || info[key] === DEFAULT_THEME_NAME)) return info.effects ? normalizeThemeInfo({ effects: info.effects }) : null;
  return normalizeThemeInfo(info);
}

/** The names a theme1.xml part gives its theme and colour scheme (the font scheme's is in fontTheme). */
export function readThemeInfo(xml) {
  if (typeof xml !== 'string') return null;
  const attr = (tag) => {
    const open = xml.match(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>`))?.[0];
    const m = open && /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(open);
    return m ? (m[1] ?? m[2]).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") : null;
  };
  return normalizeThemeInfo({ name: attr('theme')?.replace(/ Theme$/, ''), colors: attr('clrScheme'), effects: readEffectSchemeName(xml) });
}

const escapeAttr = v => String(v).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
/** Name the theme and its colour scheme in a theme1.xml part (its colours and fonts are written elsewhere). */
export function writeThemeInfo(xml, info) {
  const theme = normalizeThemeInfo(info);
  if (!theme || typeof xml !== 'string') return xml;
  const rename = (text, tag, value) => value == null ? text : text.replace(new RegExp(`(<(?:[\\w.-]+:)?${tag}\\b[^>]*?\\bname\\s*=\\s*)(?:"[^"]*"|'[^']*')`), `$1"${escapeAttr(value)}"`);
  const named = rename(rename(xml, 'theme', theme.name ? (theme.name === DEFAULT_THEME_NAME ? 'Office Theme' : theme.name) : null), 'clrScheme', theme.colors);
  return theme.effects ? writeEffectScheme(named, theme.effects) : named;
}

/** The workbook's theme as the gallery shows it: names, the twelve colours and the heading and body faces. */
export function workbookTheme(wb) {
  const info = normalizeThemeInfo(wb?.themeInfo) || {};
  const fonts = effectiveFontTheme(wb?.fontTheme);
  return {
    name: info.name || DEFAULT_THEME_NAME,
    colorsName: info.colors || (normalizeColorPalette(wb?.colorPalette)?.theme ? null : DEFAULT_THEME_NAME),
    fontsName: fonts.name || DEFAULT_THEME_NAME,
    effectsName: info.effects || DEFAULT_EFFECTS_NAME,
    colors: effectiveColorPalette(wb?.colorPalette).theme,
    major: fonts.major.latin.typeface, minor: fonts.minor.latin.typeface,
  };
}

/** Whether the workbook's colours were chosen as a theme other than the default: the app's own charts, table and
 * cell style presets then take the theme's colours. Otherwise they keep the app's look. */
export function themedColors(wb) {
  const info = normalizeThemeInfo(wb?.themeInfo);
  return info?.colors && info.colors !== DEFAULT_THEME_NAME ? effectiveColorPalette(wb.colorPalette).theme : null;
}

/** The five variations the palette offers below a theme colour, by the colour's lightness. */
export function themeTints(hex) {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const l = (Math.max(...rgb) + Math.min(...rgb)) / 2;
  if (l <= 0) return [0.5, 0.35, 0.25, 0.15, 0.05];
  if (l >= 1) return [-0.05, -0.15, -0.25, -0.35, -0.5];
  if (l < 0.2) return [0.9, 0.75, 0.5, 0.25, 0.1];
  if (l > 0.8) return [-0.1, -0.25, -0.5, -0.75, -0.9];
  return [0.8, 0.6, 0.4, -0.25, -0.5];
}

export const tintLabel = tint => !tint ? '' : t(tint > 0 ? 'workbookTheme.tintLighter' : 'workbookTheme.tintDarker', { pct: Math.round(Math.abs(tint) * 100) });

/** A theme colour reference resolved against `colors` (the twelve), as styles hold it. */
export function themeColor(index, tint = 0, colors = DEFAULT_COLOR_PALETTE.theme) {
  const base = colors[index] || DEFAULT_COLOR_PALETTE.theme[index];
  return normalizeFontColor({ theme: index, base, rgb: tint ? `#${tintRgb(base.slice(1), tint)}` : base, ...(tint ? { tint } : {}) });
}

/** The theme block of a colour menu: ten columns (Light 1, Dark 1, Light 2, Dark 2, Accent 1–6), the
 * theme colour itself over its five variations. Each cell: { index, tint, color, label }. */
export function themeColorGrid(colors) {
  const columns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const rows = [columns.map(index => ({ index, tint: 0 }))];
  const tints = columns.map(index => themeTints(colors[index]));
  for (let k = 0; k < 5; k++) rows.push(columns.map((index, j) => ({ index, tint: tints[j][k] })));
  return rows.map(row => row.map(({ index, tint }) => ({ index, tint, color: themeColor(index, tint, colors),
    label: tint ? t('workbookTheme.slotTint', { slot: themeSlotLabel(index), tint: tintLabel(tint) }) : themeSlotLabel(index) })));
}

/** Re-resolve a colour reference against new theme colours; anything else is returned as it is. */
export function rethemeColor(value, colors) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.theme)) return value;
  const base = colors[value.theme];
  if (!base || base === value.base) return value;
  return themeColor(value.theme, value.tint || 0, colors) || value;
}

/** A style with its theme colours and theme fonts resolved against `theme` ({ colors, major, minor }); the
 * same object when nothing in it changes. */
export function rethemeStyle(style, theme) {
  if (!style || typeof style !== 'object') return style;
  let out = style;
  const set = (key, value) => { if (value !== out[key]) { if (out === style) out = { ...style }; out[key] = value; } };
  if (theme.colors) {
    if (style.color && typeof style.color === 'object') set('color', rethemeColor(style.color, theme.colors));
    if (style.bg && typeof style.bg === 'object') set('bg', rethemeColor(style.bg, theme.colors));
  }
  if (theme.fonts && (style.scheme === 'major' || style.scheme === 'minor')) {
    const key = fontKeyFor(theme.fonts[style.scheme], { literal: true });
    if (key && key !== style.font) set('font', key);
  }
  return out;
}

const rethemeRuns = (runs, theme) => {
  if (!Array.isArray(runs)) return runs;
  let changed = false;
  const out = runs.map(run => {
    const s = run?.s ? rethemeStyle(run.s, theme) : run?.s;
    if (s === run?.s) return run;
    changed = true;
    return { ...run, s };
  });
  return changed ? out : runs;
};

function themeState(wb) {
  return { colorPalette: wb.colorPalette, fontTheme: wb.fontTheme, themeInfo: wb.themeInfo ?? null, normalFont: wb.normalFont };
}

function setThemeState(wb, state) {
  wb.colorPalette = state.colorPalette;
  wb.fontTheme = state.fontTheme;
  wb.themeInfo = state.themeInfo;
  if (wb.normalFont !== state.normalFont) {
    wb.normalFont = state.normalFont;
    wb.normalStyle = normalFontStyle(wb.normalFont);
    wb.cellDefaultStyle = wb.nativeDefaultCellFormat ? { ...wb.normalStyle, ...wb.nativeDefaultCellFormat.style } : wb.normalStyle;
  }
}

/** The DrawingML font scheme for a heading/body pair, keeping the current scheme's script fonts. */
function fontThemeFor(name, major, minor, current) {
  const base = effectiveFontTheme(current);
  const slot = (key, face) => ({ ...base[key], latin: { typeface: face } });
  return normalizeFontTheme({ name, major: slot('major', major), minor: slot('minor', minor) });
}

/** The size of the Normal font a theme's body face gives a workbook that has none: close to the 13px the
 * app draws unformatted cells at, so choosing a theme changes their face and not their size. */
const DEFAULT_NORMAL_POINTS = 10;

/**
 * Apply a theme, a colour scheme, a font scheme or an effect scheme, as one undoable step:
 *   { name?, colors?: { name, colors: [12 hex] }, fonts?: { name, major, minor }, effects?: name }
 * Every theme colour reference in cells, rich text, whole-line formats, table styles and the Normal font is
 * resolved again; cells bound to the heading or body font take the new face, and so does the Normal font
 * (which unformatted cells use). Returns true when anything changed.
 */
export function applyWorkbookTheme(wb, { name, colors, fonts, effects } = {}, label = t('workbookTheme.undo.theme')) {
  const before = themeState(wb);
  const info = { ...(normalizeThemeInfo(wb.themeInfo) || {}) };
  const after = { ...before };
  if (name) info.name = name;
  if (effects && effectScheme(effects)) info.effects = effects;
  let nextColors = null, nextFonts = null;
  if (colors) {
    const list = effectiveColorPalette({ theme: colors.colors }).theme;
    const isDefault = list.every((c, i) => c === DEFAULT_COLOR_PALETTE.theme[i]);
    const palette = normalizeColorPalette(wb.colorPalette) || {};
    after.colorPalette = isDefault && !palette.indexed ? null : normalizeColorPalette({ ...palette, theme: list });
    info.colors = colors.name || 'Custom';
    nextColors = list;
  }
  if (fonts) {
    const office = fontScheme(DEFAULT_THEME_NAME);
    const isDefault = fonts.major === office.major && fonts.minor === office.minor;
    after.fontTheme = isDefault ? null : fontThemeFor(fonts.name || 'Custom', fonts.major, fonts.minor, wb.fontTheme);
    nextFonts = { major: fonts.major, minor: fonts.minor };
    // The Normal font is bound to the body face. A workbook the app made has none of its own until a theme
    // gives it one; going back to the default font scheme then gives the app's default look back.
    const normal = wb.normalFont;
    if (normal && (normal.scheme === 'minor' || info.ownNormal)) {
      if (isDefault && info.ownNormal) { after.normalFont = null; delete info.ownNormal; }
      else after.normalFont = normalizeNormalFont({ ...normal, name: fonts.minor, scheme: 'minor' });
    } else if (!normal && !isDefault) {
      after.normalFont = normalizeNormalFont({ name: fonts.minor, sz: DEFAULT_NORMAL_POINTS, scheme: 'minor' });
      info.ownNormal = true;
    }
  }
  after.themeInfo = normalizeThemeInfo(info);
  const theme = { colors: nextColors, fonts: nextFonts };
  if (after.normalFont && after.normalFont === before.normalFont && nextColors && after.normalFont.color) {
    const color = rethemeColor(after.normalFont.color, nextColors);
    if (color !== after.normalFont.color) after.normalFont = normalizeNormalFont({ ...after.normalFont, color });
  }

  // The cells, lines and tables whose stored formats name the theme, before and after.
  const swaps = [];
  for (const sheet of wb.sheets) {
    for (const [key, cell] of sheet.cells) {
      const s = rethemeStyle(cell.s, theme), richText = rethemeRuns(cell.richText, theme);
      if (s !== cell.s || richText !== cell.richText) swaps.push({ sheetId: sheet.id, kind: 'cell', key, before: { s: cell.s, richText: cell.richText }, after: { s, richText } });
    }
    for (const field of ['colStyles', 'rowStyles']) for (const [i, st] of sheet[field] || []) {
      const s = rethemeStyle(st, theme);
      if (s !== st) swaps.push({ sheetId: sheet.id, kind: field, key: i, before: st, after: s });
    }
    for (const table of sheet.tables || []) if (table.customStyle) {
      let changed = false;
      const custom = Object.fromEntries(Object.entries(table.customStyle).map(([region, st]) => {
        const s = rethemeStyle(st, theme); if (s !== st) changed = true; return [region, s];
      }));
      if (changed) swaps.push({ sheetId: sheet.id, kind: 'table', key: table.id, before: table.customStyle, after: custom });
    }
  }
  const sameState = Object.keys(before).every(k => JSON.stringify(before[k]) === JSON.stringify(after[k]));
  if (sameState && !swaps.length) return false;

  const place = (which) => {
    for (const swap of swaps) {
      const sheet = wb.sheet(swap.sheetId);
      if (!sheet) continue;
      const value = swap[which];
      if (swap.kind === 'cell') {
        const cell = sheet.cells.get(swap.key);
        if (!cell) continue;
        // A new cell object, as every other step writes: undo snapshots tell changed cells by identity.
        const next = { ...cell, s: value.s, richText: value.richText };
        if (next.s === undefined) delete next.s;
        if (next.richText === undefined) delete next.richText;
        sheet.cells.set(swap.key, next);
      } else if (swap.kind === 'table') {
        const table = sheet.tables.find(t => t.id === swap.key);
        if (table) sheet.tables = sheet.tables.map(t => t === table ? { ...t, customStyle: value } : t);
      } else if (sheet[swap.kind]?.has(swap.key)) sheet[swap.kind].set(swap.key, value);
    }
  };
  const run = (state, which) => { setThemeState(wb, state); place(which); wb._changed('structure'); };
  run(after, 'after');
  wb._push({ label, undo: () => run(before, 'before'), redo: () => run(after, 'after'), snapshotCells: swaps.length });
  return true;
}

/** Apply a gallery theme by name: its colours and fonts. */
export function applyGalleryTheme(wb, name) {
  const theme = galleryTheme(name);
  if (!theme) return false;
  const colors = colorScheme(theme.colors), fonts = fontScheme(theme.fonts);
  return applyWorkbookTheme(wb, { name: theme.name, colors: { name: colors.name, colors: colors.colors }, fonts: { ...fonts }, effects: theme.effects || DEFAULT_EFFECTS_NAME }, t('workbookTheme.undo.namedTheme', { name: schemeName(theme.name) }));
}

/* ---------- Theme-aware looks for the app's own presets ---------- */

const ACCENT_FOR_TABLE = { blue: 4, red: 5, green: 6, purple: 7, orange: 9, gray: 3 };

/** A built-in table look in the theme's colours (header in the accent, bands and totals in its tints), or the
 * app's own look when the workbook keeps the default theme. */
export function themedTableLook(key, look, wb) {
  const colors = themedColors(wb);
  if (!colors || !look || key === 'none') return look;
  const index = key === 'light' ? 2 : ACCENT_FOR_TABLE[key];
  if (index == null) return look;
  const accent = colors[index];
  const tint = t => `#${tintRgb(accent.slice(1), t)}`;
  if (key === 'light') return { ...look, header: accent, headerText: colors[1], band: tint(0.5), total: accent };
  const rgb = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16));
  const light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.62;
  return { ...look, header: accent, headerText: light ? colors[1] : colors[0], band: tint(0.8), total: tint(0.6) };
}

/** The theme's six accents for chart series, or null for the app's own series colours. */
export function themedSeriesColors(wb) {
  return themedColors(wb)?.slice(4, 10) || null;
}

/** The themed cell styles: each accent full, and at 20%, 40% and 60% over white. `label` is the style's name as cells
 * and files store it (Excel's built-in name, so it stays English); themedCellStyleLabel is what the gallery shows. */
export function themedCellStyles() {
  const out = [];
  for (let n = 1; n <= 6; n++) {
    for (const pct of [20, 40, 60]) out.push({ key: `accent${n}-${pct}`, label: `${pct}% - Accent${n}`, accent: n, tint: 1 - pct / 100, group: 'Themed Cell Styles' });
    out.push({ key: `accent${n}`, label: `Accent${n}`, accent: n, tint: 0, group: 'Themed Cell Styles' });
  }
  return out;
}

/** What the gallery calls a themed cell style ({ accent, tint } of themedCellStyles): "20% - Accent1" / "20% - 着色 1". */
export const themedCellStyleLabel = def => (def.tint
  ? t('workbookTheme.themedStyleTint', { pct: Math.round((1 - def.tint) * 100), n: def.accent })
  : t('workbookTheme.themedStyleAccent', { n: def.accent }));

/** A themed cell style as a style patch against the workbook's colours (references, so it follows the theme). */
export function themedCellStylePatch(key, wb) {
  const def = themedCellStyles().find(s => s.key === key);
  if (!def) return null;
  const colors = effectiveColorPalette(wb?.colorPalette).theme, index = def.accent + 3;
  const bg = themeColor(index, def.tint, colors);
  // Light tints carry Dark 1 text; the 60% tint and the full accent carry Light 1 text.
  const ink = def.tint > 0.5 ? themeColor(1, 0, colors) : themeColor(0, 0, colors);
  return { label: def.label, patch: { bg, color: ink } };
}

/** The app's heading, title and total presets in theme colours when a theme is chosen: Text 2 for the ink, Accent 1
 * for the rules under headings, the heading face for the title. Other presets, and every preset under the default
 * theme, are the app's own. */
export function themedPreset(preset, wb) {
  const colors = themedColors(wb);
  if (!preset || !colors) return preset;
  const accent = colors[4], text2 = themeColor(3, 0, colors);
  const rule = (b, t) => ({ ...b, color: t ? `#${tintRgb(accent.slice(1), t)}` : accent });
  const theme = workbookTheme(wb);
  switch (preset.key) {
    case 'title': return { ...preset, patch: { ...preset.patch, color: text2, font: fontKeyFor(theme.major, { literal: true }), scheme: 'major' } };
    case 'heading': return { ...preset, patch: { ...preset.patch, color: text2 }, borders: preset.borders?.map(b => rule(b, 0)) };
    case 'subheading': return { ...preset, patch: { ...preset.patch, color: text2 }, borders: preset.borders?.map(b => rule(b, 0.5)) };
    case 'total': return { ...preset, borders: preset.borders?.map(b => rule(b, 0)) };
    default: return preset;
  }
}
