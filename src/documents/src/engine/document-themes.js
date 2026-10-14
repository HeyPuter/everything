/**
 * Document themes: original color schemes, font schemes and effect schemes, the themes that combine
 * them, and style sets that restyle the built-in paragraph styles in terms of the theme. All names,
 * palettes and pairings here were made for this project. Fonts are ones the canvas renderer can draw
 * (bundled faces or their reviewed metric-compatible substitutes, see font-availability.js).
 */

/** Color scheme slots in §20.1.4.1.10 (clrScheme) order. */
export const COLOR_SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
export const COLOR_SLOT_LABELS = {
  dk1: 'Text – Dark 1', lt1: 'Background – Light 1', dk2: 'Text – Dark 2', lt2: 'Background – Light 2',
  accent1: 'Accent 1', accent2: 'Accent 2', accent3: 'Accent 3', accent4: 'Accent 4', accent5: 'Accent 5', accent6: 'Accent 6',
  hlink: 'Hyperlink', folHlink: 'Followed Hyperlink',
};

const palette = (name, dk2, lt2, accents, hlink, folHlink, dk1 = '000000', lt1 = 'FFFFFF') =>
  Object.freeze({ name, colors: Object.freeze({ dk1, lt1, dk2, lt2, ...Object.fromEntries(accents.map((c, i) => [`accent${i + 1}`, c])), hlink, folHlink }) });

export const COLOR_SCHEMES = Object.freeze([
  palette('Paper', '1F2A44', 'EEF0F3', ['2F6FB3', 'D9822B', '3C9D5D', '8E5BB5', 'C8443F', '2A9BA3'], '1F63C6', '7A4FA0'),
  palette('Harbor', '15384F', 'E4EEF2', ['1B6A8C', '4FA3C7', 'E2A84B', '7DA35A', 'B85C4A', '5B6F8C'], '1B6A8C', '6E5A99'),
  palette('Meadow', '2E3B26', 'EEF2E6', ['5B8C32', 'A7C957', 'E0B14A', '3E7F6E', 'C46F3C', '8A6E4B'], '3F7A2A', '7C5E8E'),
  palette('Ember', '3A1F1A', 'F6ECE6', ['C0392B', 'E67E22', 'D4A20C', '8E3B5E', '6D4C41', 'D35F7A'], 'B03A2E', '7D3C98'),
  palette('Slate', '2B2F36', 'E9EBEE', ['4A5568', '718096', '2C7A7B', 'D69E2E', '805AD5', 'E53E3E'], '2B6CB0', '6B46C1'),
  palette('Orchard', '3B2340', 'F4EDF4', ['8E44AD', 'D35D90', 'F39C6B', '6AA84F', '3D85C6', 'B45F06'], '8E44AD', '5B3A70'),
  palette('Dune', '4A3B2A', 'F5EFE3', ['C08B4F', '8C6239', 'D9B26F', '6F8F72', 'A65D57', '5E7C99'], '8C6239', '6F5E8A'),
  palette('Aurora', '1C2541', 'E8F1F5', ['00A6A6', '3D5A80', '98C1D9', 'EE6C4D', 'F4B942', '7E5BEF'], '2E86AB', '7E5BEF'),
  palette('Granite', '333333', 'EDEDED', ['595959', '7F7F7F', 'A5A5A5', '404040', '262626', '8C8C8C'], '404040', '7F7F7F'),
  palette('Lagoon', '0B3C49', 'E0F4F1', ['0F9D8A', '37B6CE', 'F28C38', '3A6EA5', 'E56B6F', '9BC53D'], '0F7C9D', '6C5B7B'),
  palette('Citrus', '3D3B1E', 'FBF8E6', ['E6A817', '88B04B', 'F26B38', '2E9CCA', 'D64161', '6C5B7B'], 'C77C02', '6C5B7B'),
  palette('Midnight', '101A2E', 'E6E9F0', ['3E5C9A', '6C8EBF', 'C9A227', '8B3A62', '2E7D6B', 'A0522D'], '3E5C9A', '8B3A62'),
  palette('Rosewood', '41222A', 'F7ECEE', ['A23B5A', 'D98695', '5E8C7F', 'C49A3C', '6B5B95', '4F6D7A'], 'A23B5A', '6B5B95'),
  palette('Grayscale', '262626', 'F2F2F2', ['404040', '595959', '737373', '8C8C8C', 'A6A6A6', 'BFBFBF'], '262626', '595959'),
]);

const fonts = (name, major, minor) => Object.freeze({ name, major, minor });
export const FONT_SCHEMES = Object.freeze([
  fonts('Noto', 'Noto Sans', 'Noto Sans'),
  fonts('Geometric', 'Montserrat', 'Open Sans'),
  fonts('Humanist', 'Source Sans Pro', 'Source Sans Pro'),
  fonts('Newsroom', 'Oswald', 'Source Sans Pro'),
  fonts('Poster', 'Bebas Neue', 'Open Sans'),
  fonts('Friendly', 'Karla', 'Karla'),
  fonts('Plain', 'Arial', 'Arial'),
  fonts('Clean Sans', 'Calibri', 'Calibri'),
  fonts('Serif and Sans', 'Cambria', 'Calibri'),
  fonts('Bookish', 'Cambria', 'Times New Roman'),
  fonts('Editorial', 'Times New Roman', 'Arial'),
  fonts('Typewriter', 'Courier New', 'Courier New'),
]);

/**
 * Effect schemes: the format scheme's three fill, line and effect styles (§20.1.4.1.14), which
 * shapes reach through their style references (fillRef, lnRef, effectRef).
 */
export const EFFECT_SCHEMES = Object.freeze([
  Object.freeze({ name: 'Flat', fills: ['solid', 'tint', 'shade'], lines: [6350, 12700, 19050], effects: [null, null, null] }),
  Object.freeze({ name: 'Soft Shadow', fills: ['solid', 'tint', 'shade'], lines: [9525, 12700, 19050], effects: [null, { blur: 38100, distance: 19050, alpha: 0.3 }, { blur: 57150, distance: 28575, alpha: 0.38 }] }),
  Object.freeze({ name: 'Gradient', fills: ['solid', 'gradient', 'gradient'], lines: [9525, 12700, 19050], effects: [null, null, { blur: 50800, distance: 19050, alpha: 0.3 }] }),
  Object.freeze({ name: 'Bold Outline', fills: ['solid', 'tint', 'shade'], lines: [19050, 28575, 38100], effects: [null, null, null] }),
  Object.freeze({ name: 'Raised', fills: ['solid', 'gradient', 'gradient'], lines: [12700, 19050, 25400], effects: [{ blur: 25400, distance: 12700, alpha: 0.25 }, { blur: 50800, distance: 25400, alpha: 0.35 }, { blur: 76200, distance: 38100, alpha: 0.4 }] }),
]);

const theme = (name, colors, fontScheme, effects) => Object.freeze({ name, colors, fonts: fontScheme, effects });
/** Themes: a color scheme, a font scheme and an effect scheme, by name. The first is the default. */
export const THEMES = Object.freeze([
  theme('Paper', 'Paper', 'Noto', 'Flat'),
  theme('Harbor', 'Harbor', 'Geometric', 'Soft Shadow'),
  theme('Meadow', 'Meadow', 'Humanist', 'Flat'),
  theme('Ember', 'Ember', 'Newsroom', 'Bold Outline'),
  theme('Slate', 'Slate', 'Plain', 'Flat'),
  theme('Orchard', 'Orchard', 'Serif and Sans', 'Gradient'),
  theme('Dune', 'Dune', 'Bookish', 'Soft Shadow'),
  theme('Aurora', 'Aurora', 'Friendly', 'Gradient'),
  theme('Granite', 'Granite', 'Editorial', 'Flat'),
  theme('Lagoon', 'Lagoon', 'Clean Sans', 'Soft Shadow'),
  theme('Citrus', 'Citrus', 'Poster', 'Bold Outline'),
  theme('Midnight', 'Midnight', 'Geometric', 'Raised'),
]);

export const colorScheme = name => COLOR_SCHEMES.find(s => s.name === name) || null;
export const fontScheme = name => FONT_SCHEMES.find(s => s.name === name) || null;
export const effectScheme = name => EFFECT_SCHEMES.find(s => s.name === name) || null;
export const themeByName = name => THEMES.find(t => t.name === name) || null;

/** A theme's resolved parts: { name, colors: {slot: hex}, fonts: { name, major, minor }, effects: scheme }. */
export function resolvedTheme(entry) {
  const t = typeof entry === 'string' ? themeByName(entry) : entry;
  if (!t) return null;
  return { name: t.name, colors: { name: colorScheme(t.colors).name, ...colorScheme(t.colors).colors }, fonts: fontScheme(t.fonts), effects: effectScheme(t.effects) };
}

/*
 * Style sets. Each style lists the properties a set manages; a property left out is cleared, so
 * applying a set always gives the same look. Colors name theme slots (with an optional WordprocessingML
 * tint or shade byte), fonts name the theme's heading (major) or body (minor) font, sizes are points,
 * spacing is points, and a border is { side, color, size (eighths of a point), space (points) }.
 */
const quote = { font: 'minor', italic: true, color: { theme: 'text1', tint: 'A6' }, before: 10, after: 10, indent: 0.6, align: 'center' };
const set = (name, description, styles) => Object.freeze({ name, description, styles: Object.freeze(styles) });
export const STYLE_SETS = Object.freeze([
  set('Default', 'Theme fonts, accent-colored headings', {
    Normal: { font: 'minor' },
    Title: { font: 'major', size: 26, after: 6, color: { theme: 'text1' } },
    Subtitle: { font: 'minor', size: 15, after: 12, color: { theme: 'text1', tint: 'A6' } },
    Heading1: { font: 'major', size: 20, bold: true, before: 12, after: 6, color: { theme: 'accent1', shade: 'BF' } },
    Heading2: { font: 'major', size: 16, bold: true, before: 9, after: 4.5, color: { theme: 'accent1', shade: 'BF' } },
    Heading3: { font: 'major', size: 14, bold: true, before: 8, after: 4, color: { theme: 'accent1', shade: '80' } },
    Quote: quote,
  }),
  set('Crisp', 'Compact headings with a rule under the title', {
    Normal: { font: 'minor', size: 11, after: 8, line: 1.08 },
    Title: { font: 'major', size: 28, after: 10, color: { theme: 'text2' }, border: { side: 'bottom', color: { theme: 'accent1' }, size: 12, space: 4 } },
    Subtitle: { font: 'minor', size: 13, after: 10, color: { theme: 'accent1' }, spacing: 0.5 },
    Heading1: { font: 'major', size: 16, bold: true, before: 18, after: 6, color: { theme: 'accent1' } },
    Heading2: { font: 'major', size: 13, bold: true, before: 12, after: 4, color: { theme: 'accent1' } },
    Heading3: { font: 'major', size: 12, bold: true, before: 10, after: 2, color: { theme: 'text2' } },
    Quote: { ...quote, align: 'left', color: { theme: 'accent1' } },
  }),
  set('Classic', 'Black headings in the body font', {
    Normal: { font: 'minor', size: 12, after: 10, line: 1.15 },
    Title: { font: 'major', size: 26, bold: true, after: 12, align: 'center' },
    Subtitle: { font: 'major', size: 14, italic: true, after: 12, align: 'center' },
    Heading1: { font: 'major', size: 16, bold: true, before: 18, after: 6 },
    Heading2: { font: 'major', size: 13, bold: true, before: 12, after: 4 },
    Heading3: { font: 'major', size: 12, bold: true, italic: true, before: 10, after: 4 },
    Quote: { ...quote, color: { theme: 'text1' } },
  }),
  set('Banner', 'Uppercase titles with letter spacing', {
    Normal: { font: 'minor', size: 11, after: 10, line: 1.15 },
    Title: { font: 'major', size: 30, caps: true, spacing: 3, after: 12, color: { theme: 'accent1' } },
    Subtitle: { font: 'major', size: 12, caps: true, spacing: 2, after: 14, color: { theme: 'text2' } },
    Heading1: { font: 'major', size: 15, caps: true, spacing: 1, before: 20, after: 8, color: { theme: 'accent1' } },
    Heading2: { font: 'major', size: 13, caps: true, before: 14, after: 6, color: { theme: 'accent2' } },
    Heading3: { font: 'major', size: 12, bold: true, before: 10, after: 4, color: { theme: 'text2' } },
    Quote: { ...quote, color: { theme: 'accent1' } },
  }),
  set('Minimal', 'Light weights and generous space', {
    Normal: { font: 'minor', size: 11, after: 12, line: 1.25 },
    Title: { font: 'major', size: 32, after: 18, color: { theme: 'text1', tint: 'BF' } },
    Subtitle: { font: 'minor', size: 14, after: 18, color: { theme: 'text1', tint: '8C' } },
    Heading1: { font: 'major', size: 18, before: 24, after: 8, color: { theme: 'text1', tint: 'BF' } },
    Heading2: { font: 'major', size: 14, before: 18, after: 6, color: { theme: 'text1', tint: 'BF' } },
    Heading3: { font: 'major', size: 12, italic: true, before: 12, after: 4, color: { theme: 'text1', tint: 'A6' } },
    Quote: { ...quote, color: { theme: 'text1', tint: '8C' } },
  }),
  set('Accent Bar', 'Headings over a colored rule', {
    Normal: { font: 'minor', size: 11, after: 8, line: 1.1 },
    Title: { font: 'major', size: 28, bold: true, after: 8, color: { theme: 'accent1' } },
    Subtitle: { font: 'minor', size: 13, after: 12, color: { theme: 'accent2' } },
    Heading1: { font: 'major', size: 15, bold: true, before: 18, after: 8, color: { theme: 'text2' }, border: { side: 'bottom', color: { theme: 'accent1' }, size: 18, space: 2 } },
    Heading2: { font: 'major', size: 13, bold: true, before: 12, after: 4, color: { theme: 'accent1' } },
    Heading3: { font: 'major', size: 12, bold: true, before: 10, after: 2, color: { theme: 'accent2' } },
    Quote: { ...quote, align: 'left', color: { theme: 'text2' }, border: { side: 'left', color: { theme: 'accent1' }, size: 24, space: 8 } },
  }),
  set('Centered', 'Centered titles and headings', {
    Normal: { font: 'minor', size: 12, after: 10, line: 1.15 },
    Title: { font: 'major', size: 30, after: 6, align: 'center', color: { theme: 'text2' } },
    Subtitle: { font: 'minor', size: 14, after: 16, align: 'center', color: { theme: 'accent1' } },
    Heading1: { font: 'major', size: 17, bold: true, before: 18, after: 8, align: 'center', color: { theme: 'accent1' } },
    Heading2: { font: 'major', size: 14, before: 12, after: 6, align: 'center', color: { theme: 'accent1' } },
    Heading3: { font: 'major', size: 12, bold: true, before: 10, after: 4, align: 'center', color: { theme: 'text2' } },
    Quote: quote,
  }),
  set('Bold Contrast', 'Heavy dark headings, airy body', {
    Normal: { font: 'minor', size: 11, after: 10, line: 1.2 },
    Title: { font: 'major', size: 34, bold: true, after: 8, color: { theme: 'text2' } },
    Subtitle: { font: 'major', size: 14, bold: true, after: 14, color: { theme: 'accent2' } },
    Heading1: { font: 'major', size: 20, bold: true, before: 20, after: 8, color: { theme: 'text2' } },
    Heading2: { font: 'major', size: 15, bold: true, before: 14, after: 6, color: { theme: 'accent2' } },
    Heading3: { font: 'major', size: 12, bold: true, caps: true, before: 12, after: 4, color: { theme: 'text2' } },
    Quote: { ...quote, italic: false, bold: true, color: { theme: 'accent2' } },
  }),
]);
export const styleSetByName = name => STYLE_SETS.find(s => s.name === name) || null;

/** The paragraph styles style sets manage, with what a missing one is created as. */
export const STYLE_SET_STYLES = Object.freeze({
  Normal: { name: 'Normal' },
  Title: { name: 'Title', basedOn: 'Normal', next: 'Normal', keep: true },
  Subtitle: { name: 'Subtitle', basedOn: 'Normal', next: 'Normal', keep: true },
  Heading1: { name: 'heading 1', basedOn: 'Normal', next: 'Normal', keep: true, outline: 0 },
  Heading2: { name: 'heading 2', basedOn: 'Normal', next: 'Normal', keep: true, outline: 1 },
  Heading3: { name: 'heading 3', basedOn: 'Normal', next: 'Normal', keep: true, outline: 2 },
  Quote: { name: 'Quote', basedOn: 'Normal', next: 'Normal' },
});

/** Watermark texts offered in the gallery. */
export const WATERMARK_TEXTS = Object.freeze(['CONFIDENTIAL', 'DO NOT COPY', 'DRAFT', 'SAMPLE', 'URGENT', 'ASAP', 'PERSONAL', 'INTERNAL', 'FINAL']);
