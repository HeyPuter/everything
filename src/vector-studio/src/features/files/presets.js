/**
 * New Document presets and the value parsing behind the New Document
 * dialog. Sizes are stored in points (1/72 in); `units` is the unit the
 * document opens with. Preset names are generic device and paper names.
 */
import { parseLength, parseNumber, UNITS } from '../../lib/units.js';

const mm = (v) => (v * 72) / 25.4;
const inch = (v) => v * 72;

export const CATEGORIES = [
  { id: 'recent', label: 'Recent' },
  { id: 'saved', label: 'Saved' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'web', label: 'Web' },
  { id: 'print', label: 'Print' },
  { id: 'film', label: 'Film & Video' },
  { id: 'art', label: 'Art & Illustration' },
];

export const PRESETS = {
  mobile: [
    { name: 'Phone', width: 390, height: 844, units: 'px' },
    { name: 'Phone Large', width: 430, height: 932, units: 'px' },
    { name: 'Phone Compact', width: 375, height: 667, units: 'px' },
    { name: 'Android Phone', width: 360, height: 800, units: 'px' },
    { name: 'Tablet', width: 820, height: 1180, units: 'px' },
    { name: 'Tablet Large', width: 1024, height: 1366, units: 'px' },
    { name: 'Android Tablet', width: 800, height: 1280, units: 'px' },
    { name: 'Watch', width: 198, height: 242, units: 'px' },
  ],
  web: [
    { name: 'Web', width: 1920, height: 1080, units: 'px' },
    { name: 'Web Large', width: 1440, height: 900, units: 'px' },
    { name: 'Web Medium', width: 1366, height: 768, units: 'px' },
    { name: 'Web Small', width: 1280, height: 800, units: 'px' },
    { name: 'Web Minimum', width: 1024, height: 768, units: 'px' },
    { name: 'Banner', width: 1200, height: 628, units: 'px' },
    { name: 'Social Post', width: 1080, height: 1350, units: 'px' },
    { name: 'Story', width: 1080, height: 1920, units: 'px' },
  ],
  print: [
    { name: 'Letter', width: 612, height: 792, units: 'in', colorMode: 'CMYK' },
    { name: 'Legal', width: 612, height: 1008, units: 'in', colorMode: 'CMYK' },
    { name: 'Tabloid', width: 792, height: 1224, units: 'in', colorMode: 'CMYK' },
    { name: 'A5', width: mm(148), height: mm(210), units: 'mm', colorMode: 'CMYK' },
    { name: 'A4', width: mm(210), height: mm(297), units: 'mm', colorMode: 'CMYK' },
    { name: 'A3', width: mm(297), height: mm(420), units: 'mm', colorMode: 'CMYK' },
    { name: 'Business Card', width: inch(3.5), height: inch(2), units: 'in', bleed: inch(0.125), colorMode: 'CMYK' },
    { name: 'Postcard', width: inch(6), height: inch(4), units: 'in', bleed: inch(0.125), colorMode: 'CMYK' },
  ],
  film: [
    { name: 'HD 720p', width: 1280, height: 720, units: 'px' },
    { name: 'HD 1080p', width: 1920, height: 1080, units: 'px' },
    { name: 'UHD 4K', width: 3840, height: 2160, units: 'px' },
    { name: 'Cinema 4K', width: 4096, height: 2160, units: 'px' },
    { name: 'Square Video', width: 1080, height: 1080, units: 'px' },
    { name: 'Vertical Video', width: 1080, height: 1920, units: 'px' },
  ],
  art: [
    { name: 'Square', width: 1080, height: 1080, units: 'px' },
    { name: 'Icon', width: 512, height: 512, units: 'px' },
    { name: 'Poster 18 x 24', width: inch(18), height: inch(24), units: 'in' },
    { name: 'Poster 24 x 36', width: inch(24), height: inch(36), units: 'in' },
    { name: 'Art Print 8 x 10', width: inch(8), height: inch(10), units: 'in' },
    { name: 'Art Print 11 x 14', width: inch(11), height: inch(14), units: 'in' },
    { name: 'Sketch', width: 1600, height: 1200, units: 'px' },
  ],
};

export const UNIT_OPTIONS = [
  { value: 'px', label: 'Pixels' },
  { value: 'pt', label: 'Points' },
  { value: 'pc', label: 'Picas' },
  { value: 'in', label: 'Inches' },
  { value: 'mm', label: 'Millimeters' },
  { value: 'cm', label: 'Centimeters' },
];

export const RASTER_OPTIONS = [
  { value: 72, label: 'Screen (72 ppi)' },
  { value: 150, label: 'Medium (150 ppi)' },
  { value: 300, label: 'High (300 ppi)' },
];

export const COLOR_MODE_OPTIONS = [
  { value: 'RGB', label: 'RGB Color' },
  { value: 'CMYK', label: 'CMYK Color' },
];

/** How several artboards are laid out in a new document. */
export const LAYOUT_OPTIONS = [
  { value: 'gridRow', label: 'Grid by Row' },
  { value: 'gridCol', label: 'Grid by Column' },
  { value: 'row', label: 'Arrange by Row' },
  { value: 'col', label: 'Arrange by Column' },
];

/**
 * Positions { x, y } of `n` artboards of size w x h: rows of `columns` (or
 * columns of `columns` when filling by column), one row, or one column;
 * `rtl` starts on the right.
 */
export function artboardPositions(n, w, h, { layout = 'gridRow', spacing = 20, columns = 0, rtl = false } = {}) {
  const per = columns > 0 ? Math.round(columns) : Math.max(1, Math.ceil(Math.sqrt(n)));
  const cells = [];
  for (let i = 0; i < n; i++) {
    if (layout === 'row') cells.push([i, 0]);
    else if (layout === 'col') cells.push([0, i]);
    else if (layout === 'gridCol') cells.push([Math.floor(i / per), i % per]);
    else cells.push([i % per, Math.floor(i / per)]);
  }
  const maxCol = Math.max(0, ...cells.map((c) => c[0]));
  return cells.map(([c, r]) => ({ x: (rtl ? maxCol - c : c) * (w + spacing), y: r * (h + spacing) }));
}

export const PREVIEW_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'pixel', label: 'Pixel' },
];

/** Limits on artboard size, artboard count and bleed (sizes in user units). */
export const LIMITS = { minSize: 1, maxSize: 16383, maxArtboards: 1000, maxBleed: 72 };

/** "8.5 x 11 in" for a preset card. */
export function sizeLabel(p) {
  const u = UNITS[p.units] ? p.units : 'pt';
  const f = UNITS[u].factor;
  const d = u === 'px' || u === 'pt' ? 0 : u === 'mm' ? 0 : 2;
  const fmt = (v) => String(Number((v / f).toFixed(d)));
  return `${fmt(p.width)} x ${fmt(p.height)} ${u}`;
}

export function presetKey(p) {
  return `${p.name}|${Math.round(p.width * 100)}|${Math.round(p.height * 100)}|${p.units}`;
}

/**
 * Parse the raw dialog strings into document settings. Lengths accept unit
 * suffixes and arithmetic; bare numbers use `units`. Returns
 * { ok: true, value } or { ok: false, field, message }.
 */
export function parsePresetForm(raw) {
  const units = UNITS[raw.units] ? raw.units : 'pt';
  const fail = (field, message) => ({ ok: false, field, message });
  const name = String(raw.name ?? '').trim();
  if (!name) return fail('name', 'Enter a name for the document.');
  const len = (s) => parseLength(String(s ?? ''), units);
  const width = len(raw.width);
  const height = len(raw.height);
  const range = `between ${LIMITS.minSize} pt and ${LIMITS.maxSize} pt (227 in)`;
  if (!Number.isFinite(width) || width < LIMITS.minSize || width > LIMITS.maxSize) return fail('width', `Width must be ${range}.`);
  if (!Number.isFinite(height) || height < LIMITS.minSize || height > LIMITS.maxSize) return fail('height', `Height must be ${range}.`);
  const artboards = parseNumber(String(raw.artboards ?? '1'));
  if (!Number.isInteger(artboards) || artboards < 1 || artboards > LIMITS.maxArtboards) return fail('artboards', `Number of artboards must be a whole number from 1 to ${LIMITS.maxArtboards}.`);
  const bleed = {};
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const s = raw.bleed?.[side];
    const v = s === '' || s == null ? 0 : len(s);
    if (!Number.isFinite(v) || v < 0 || v > LIMITS.maxBleed) return fail(`bleed-${side}`, `Bleed must be between 0 and ${LIMITS.maxBleed} pt (1 in).`);
    bleed[side] = v;
  }
  const ppi = Number(raw.rasterResolution ?? 72);
  const rasterResolution = Number.isFinite(ppi) && ppi >= 72 && ppi <= 2400 ? ppi : 72;
  const previewMode = raw.previewMode === 'pixel' ? 'pixel' : 'default';
  const colorMode = raw.colorMode === 'CMYK' ? 'CMYK' : 'RGB';
  const value = { name, width, height, units, artboards, bleed, colorMode, rasterResolution, previewMode };
  if (artboards > 1) {
    const spacing = raw.spacing === '' || raw.spacing == null ? 20 : len(raw.spacing);
    if (!Number.isFinite(spacing) || spacing < 0 || spacing > LIMITS.maxSize) return fail('spacing', `Spacing must be between 0 and ${LIMITS.maxSize} pt.`);
    const columns = raw.columns === '' || raw.columns == null ? 0 : parseNumber(String(raw.columns));
    if (!Number.isInteger(columns) || columns < 0 || columns > LIMITS.maxArtboards) return fail('columns', 'Enter a whole number of columns (0 picks one).');
    value.layout = LAYOUT_OPTIONS.some((o) => o.value === raw.layout) ? raw.layout : 'gridRow';
    value.spacing = spacing;
    value.columns = columns;
    value.rtl = Boolean(raw.rtl);
  }
  return { ok: true, value };
}

/** Orientation of a size. Squares count as portrait. */
export function orientationOf(w, h) {
  return w > h ? 'landscape' : 'portrait';
}

/** Swap width and height to match an orientation. */
export function withOrientation(size, orientation) {
  const { width, height } = size;
  if (orientationOf(width, height) === orientation || width === height) return size;
  return { ...size, width: height, height: width };
}

/** Prepend a settings record to a list stored in prefs (recent/saved), deduped by key. */
export function pushPreset(list, preset, max = 12) {
  const key = presetKey(preset);
  const out = [preset, ...(Array.isArray(list) ? list : []).filter((p) => p && presetKey(p) !== key)];
  return out.slice(0, max);
}
