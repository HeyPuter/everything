/**
 * Print settings: defaults and validation, shared by the Print dialog, the
 * print output and print presets (kept small so presets load without the
 * print module).
 */
import { DEFAULT_PRINT } from './print-layout.js';

export const PRINT_DEFAULTS = Object.freeze({
  ...DEFAULT_PRINT,
  which: 'all',
  range: '',
  ignoreArtboards: false,
  skipBlank: false,
  layers: 'printable',
  useDocBleed: false,
  copies: 1,
  collate: true,
  reverse: false,
  markType: 'roman',
  mode: 'composite',
  emulsion: 'up',
  image: 'positive',
  color: 'color',
  spotToProcess: false,
  overprintBlack: false,
  skipPlates: [],
  textMode: 'text',
  colorHandling: 'browser',
  printerProfile: 'document',
  intent: 'relative',
  bitmap: false,
  bitmapPpi: 300,
  overprints: 'discard',
  flattener: 'Medium Resolution',
});

const ONE_OF = {
  media: null,
  orientation: ['auto', 'portrait', 'landscape'],
  scaling: ['none', 'fit', 'custom', 'tile'],
  layers: ['printable', 'visible', 'all'],
  markType: ['roman', 'japanese'],
  mode: ['composite', 'separations'],
  emulsion: ['up', 'down'],
  image: ['positive', 'negative'],
  color: ['color', 'gray'],
  textMode: ['text', 'outlines'],
  colorHandling: ['browser', 'proof'],
  intent: ['perceptual', 'saturation', 'relative', 'absolute'],
  overprints: ['discard', 'simulate'],
};

/** Clean print settings (for presets: no artboard choice). */
export function normalizePrint(v = {}) {
  const out = { ...PRINT_DEFAULTS, ...v, bleed: { ...DEFAULT_PRINT.bleed, ...(v.bleed || {}) }, marks: { ...DEFAULT_PRINT.marks, ...(v.marks || {}) } };
  for (const [k, allowed] of Object.entries(ONE_OF)) if (allowed && !allowed.includes(out[k])) out[k] = PRINT_DEFAULTS[k];
  for (const k of ['scale', 'mediaW', 'mediaH', 'offsetX', 'offsetY', 'overlap', 'markWeight', 'markOffset', 'copies', 'bitmapPpi']) {
    const n = Number(out[k]);
    out[k] = Number.isFinite(n) ? n : PRINT_DEFAULTS[k];
  }
  out.copies = Math.max(1, Math.min(999, Math.round(out.copies)));
  out.bitmapPpi = Math.max(36, Math.min(1200, Math.round(out.bitmapPpi)));
  for (const k of ['collate', 'reverse', 'ignoreArtboards', 'skipBlank', 'useDocBleed', 'spotToProcess', 'overprintBlack', 'bitmap']) out[k] = Boolean(out[k]);
  out.skipPlates = Array.isArray(out.skipPlates) ? out.skipPlates.map(String) : [];
  delete out.which;
  delete out.range;
  return out;
}

const yes = (b) => (b ? 'On' : 'Off');

/** Summary lines of print settings (print presets). */
export function printSettingsSummary(v) {
  const marks = Object.entries(v.marks || {}).filter(([, on]) => on).map(([k]) => ({ trim: 'trim', registration: 'registration', colorBars: 'color bars', pageInfo: 'page information' })[k]);
  return [
    ['Copies', `${v.copies}${v.copies > 1 ? (v.collate ? ', collated' : ', not collated') : ''}${v.reverse ? ', reverse order' : ''}`],
    ['Media', v.media === 'artboard' ? 'Defined by artboard' : v.media === 'custom' ? `${Math.round(v.mediaW)} × ${Math.round(v.mediaH)} pt` : v.media.toUpperCase()],
    ['Orientation', v.orientation],
    ['Print layers', { printable: 'Visible & printable', visible: 'Visible', all: 'All' }[v.layers]],
    ['Scaling', { none: 'Do not scale', fit: 'Fit to page', custom: `${v.scale}%`, tile: `Tile at ${v.scale}%` }[v.scaling]],
    ["Printer's marks", marks.length ? `${marks.join(', ')} (${v.markType})` : 'None'],
    ['Bleed', v.useDocBleed ? 'Document bleed' : ['top', 'bottom', 'left', 'right'].map((k) => `${Math.round(v.bleed[k] * 100) / 100}`).join(' / ') + ' pt'],
    ['Mode', v.mode === 'separations' ? 'Separations (host-based)' : `Composite ${v.color === 'gray' ? 'grayscale' : 'color'}`],
    ['Emulsion / image', `${v.emulsion === 'down' ? 'Down' : 'Up'} / ${v.image === 'negative' ? 'Negative' : 'Positive'}`],
    ['Spot colors to process', yes(v.spotToProcess)],
    ['Overprint black', yes(v.overprintBlack)],
    ['Text', v.textMode === 'outlines' ? 'Outlines' : 'Text'],
    ['Color handling', v.colorHandling === 'proof' ? `Simulate press (${v.printerProfile})` : 'Browser and printer'],
    ['Print as bitmap', v.bitmap ? `${v.bitmapPpi} ppi` : 'Off'],
    ['Overprints', v.overprints === 'simulate' ? 'Simulate' : 'Discard'],
    ['Flattener preset', v.flattener],
  ];
}
