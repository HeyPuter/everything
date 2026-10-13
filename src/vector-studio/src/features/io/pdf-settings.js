/**
 * PDF export settings: defaults, validation, summaries and the mapping to
 * the PDF writer's options. Kept free of the writer so presets load
 * without the export module.
 *
 *   General       compat '1.4'..'1.7', standard 'none'|'press'|'x1a'|'x4',
 *                 layers, thumbnails, viewAfter
 *   Compression   downsample 'none'|'average'|'bicubic', downsamplePpi,
 *                 downsampleAbove, imageCompression 'auto'|'jpeg'|'zip',
 *                 jpegQuality (0..1), compressArt
 *   Marks/Bleeds  marks { trim, registration, colorBars, pageInfo },
 *                 markType, markWeight, markOffset, useDocBleed, bleed
 *   Output        colorConversion 'none'|'convert', destination
 *                 ('cmyk:document' | 'cmyk:<profile id>' | 'rgb:<profile id>'),
 *                 profileInclusion 'include'|'none' (tag colors with ICC
 *                 profiles), spotsToProcess, outputIntent ('document' (the
 *                 destination, else the document's CMYK profile) | a CMYK
 *                 profile id)
 *
 * PDF/X standards fix what they require: PDF/X-1a (PDF 1.3) converts to
 * CMYK, flattens transparency and has no layers, ICC tags or security;
 * PDF/X-4 (PDF 1.6) keeps transparency and layers and tags colors.
 *   Advanced      textOutlines, overprint 'preserve'|'simulate'|'discard',
 *                 flatten, flattener (preset name)
 *   Security      requireOpen, openPassword, restrict, permissionsPassword,
 *                 printing 'none'|'low'|'high', changes, copy, accessibility
 */

export const PDF_DEFAULTS = Object.freeze({
  compat: '1.7',
  standard: 'none',
  layers: false,
  thumbnails: false,
  viewAfter: false,
  downsample: 'bicubic',
  downsamplePpi: 300,
  downsampleAbove: 450,
  imageCompression: 'auto',
  jpegQuality: 0.85,
  compressArt: true,
  marks: Object.freeze({ trim: false, registration: false, colorBars: false, pageInfo: false }),
  markType: 'roman',
  markWeight: 0.25,
  markOffset: 6,
  useDocBleed: true,
  bleed: Object.freeze({ top: 0, bottom: 0, left: 0, right: 0 }),
  colorConversion: 'none',
  destination: 'cmyk:document',
  profileInclusion: 'include',
  spotsToProcess: false,
  outputIntent: 'document',
  textOutlines: true,
  overprint: 'preserve',
  flatten: false,
  flattener: 'Medium Resolution',
  requireOpen: false,
  openPassword: '',
  restrict: false,
  permissionsPassword: '',
  printing: 'high',
  changes: 'any',
  copy: true,
  accessibility: true,
});

const ONE_OF = {
  compat: ['1.4', '1.5', '1.6', '1.7'],
  standard: ['none', 'press', 'x1a', 'x4'],
  profileInclusion: ['include', 'none'],
  downsample: ['none', 'average', 'bicubic'],
  imageCompression: ['auto', 'jpeg', 'zip'],
  markType: ['roman', 'japanese'],
  colorConversion: ['none', 'convert'],
  overprint: ['preserve', 'simulate', 'discard'],
  printing: ['none', 'low', 'high'],
  changes: ['none', 'assemble', 'fill', 'comment', 'any'],
};

/** Clean PDF settings. Old saved options ({ bleed: number }) still read. */
export function normalizePdf(v = {}) {
  const src = { ...v };
  if (typeof src.bleed === 'number') src.bleed = { top: src.bleed, bottom: src.bleed, left: src.bleed, right: src.bleed };
  const out = { ...PDF_DEFAULTS, ...src, marks: { ...PDF_DEFAULTS.marks, ...(src.marks || {}) }, bleed: { ...PDF_DEFAULTS.bleed, ...(src.bleed || {}) } };
  for (const [k, allowed] of Object.entries(ONE_OF)) if (!allowed.includes(String(out[k]))) out[k] = PDF_DEFAULTS[k];
  out.compat = String(out.compat);
  const num = (k, lo, hi) => {
    const n = Number(out[k]);
    out[k] = Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : PDF_DEFAULTS[k];
  };
  num('downsamplePpi', 9, 2400);
  num('downsampleAbove', 9, 4800);
  num('jpegQuality', 0.05, 1);
  num('markWeight', 0.05, 2);
  num('markOffset', 0, 72);
  for (const side of ['top', 'bottom', 'left', 'right']) out.bleed[side] = Math.max(0, Math.min(72, Number(out.bleed[side]) || 0));
  for (const k of ['layers', 'thumbnails', 'viewAfter', 'compressArt', 'useDocBleed', 'spotsToProcess', 'textOutlines', 'flatten', 'requireOpen', 'restrict', 'copy', 'accessibility']) out[k] = Boolean(out[k]);
  for (const k of ['openPassword', 'permissionsPassword', 'destination', 'outputIntent', 'flattener']) out[k] = String(out[k] ?? '');
  if (!/^(cmyk|rgb):/.test(out.destination)) out.destination = PDF_DEFAULTS.destination;
  if (out.downsampleAbove < out.downsamplePpi) out.downsampleAbove = out.downsamplePpi;
  return applyStandard(out);
}

export const PDF_STANDARDS = {
  none: 'None',
  press: 'Print production (output intent)',
  x1a: 'PDF/X-1a:2001',
  x4: 'PDF/X-4',
};

export const isPdfx = (v) => v.standard === 'x1a' || v.standard === 'x4';

/** Settings a standard fixes (in place). */
export function applyStandard(out) {
  if (out.standard === 'x1a') {
    out.colorConversion = 'convert';
    if (!out.destination.startsWith('cmyk:')) out.destination = 'cmyk:document';
    out.flatten = true;
    out.layers = false;
    out.thumbnails = false;
    out.profileInclusion = 'none';
  }
  if (out.standard === 'x4') {
    out.thumbnails = false;
    out.profileInclusion = 'include';
    if (Number(out.compat) < 1.6) out.compat = '1.6';
  }
  if (isPdfx(out)) {
    out.requireOpen = false;
    out.restrict = false;
  }
  return out;
}

/** Settings stored in presets: everything but the passwords. */
export function presetPdf(v) {
  const out = normalizePdf(v);
  out.openPassword = '';
  out.permissionsPassword = '';
  return out;
}

/** Whether the file will be encrypted. */
export const pdfEncrypted = (v) => (!v.standard || v.standard === 'none') && Boolean((v.requireOpen && v.openPassword) || v.restrict);

/** The PDF version written: PDF/X-1a:2001 is PDF 1.3; encryption needs 1.6 (AES). */
export function pdfVersion(v) {
  if (v.standard === 'x1a') return '1.3';
  return pdfEncrypted(v) && Number(v.compat) < 1.6 ? '1.6' : v.compat;
}

const yes = (b) => (b ? 'On' : 'Off');
const QUALITY = [[1, 'Maximum'], [0.85, 'High'], [0.7, 'Medium'], [0.5, 'Low'], [0.3, 'Minimum']];
export const JPEG_QUALITIES = QUALITY;
export const qualityLabel = (q) => (QUALITY.find(([v]) => Math.abs(v - q) < 0.01) || [q, `${Math.round(q * 100)}%`])[1];

/** A profile id as a label when no display name is at hand. */
const profileLabel = (id) => (id === 'document' ? 'document profile' : id.startsWith('icc:') ? 'loaded profile' : id);

/** Summary lines of PDF settings. `names` gives display names of the destination and output intent profiles. */
export function pdfSummary(v, names = {}) {
  const marks = Object.entries(v.marks).filter(([, on]) => on).map(([k]) => ({ trim: 'trim', registration: 'registration', colorBars: 'color bars', pageInfo: 'page information' })[k]);
  return [
    ['Compatibility', `PDF ${pdfVersion(v)}`],
    ['Standard', PDF_STANDARDS[v.standard] || 'None'],
    ['Layers from top-level layers', yes(v.layers && Number(v.compat) >= 1.5)],
    ['Page thumbnails', yes(v.thumbnails)],
    ['View after saving', yes(v.viewAfter)],
    ['Image downsampling', v.downsample === 'none' ? 'Off' : `${v.downsample === 'bicubic' ? 'Bicubic' : 'Average'} to ${v.downsamplePpi} ppi above ${v.downsampleAbove} ppi`],
    ['Image compression', v.imageCompression === 'jpeg' ? `JPEG, ${qualityLabel(v.jpegQuality)} quality` : v.imageCompression === 'zip' ? 'ZIP' : 'Automatic'],
    ['Compress text and line art', yes(v.compressArt)],
    ["Printer's marks", marks.length ? `${marks.join(', ')} (${v.markType})` : 'None'],
    ['Bleed', v.useDocBleed ? 'Document bleed' : `${['top', 'bottom', 'left', 'right'].map((k) => v.bleed[k]).join(' / ')} pt`],
    ['Color conversion', v.colorConversion === 'convert' ? `To ${v.destination.startsWith('rgb:') ? 'RGB' : 'CMYK'} (${names.destination || profileLabel(v.destination.slice(v.destination.indexOf(':') + 1))})` : 'None'],
    ['Color profiles', v.profileInclusion === 'include' ? 'Included (ICC-based colors)' : 'Not included'],
    ...(v.standard !== 'none' ? [['Output intent', names.outputIntent || (v.outputIntent === 'document' ? 'Destination profile' : profileLabel(v.outputIntent))]] : []),
    ['Spot colors', v.spotsToProcess ? 'Converted to process' : 'Kept as spot inks'],
    ['Text', v.textOutlines ? 'Converted to outlines' : 'Standard fonts'],
    ['Overprint', { preserve: 'Preserve', simulate: 'Simulate', discard: 'Discard' }[v.overprint]],
    ['Flatten transparency', v.flatten ? v.flattener : 'Off'],
    ['Security', pdfEncrypted(v) ? `AES 128-bit${v.requireOpen && v.openPassword ? ', password to open' : ''}${v.restrict ? ', restricted' : ''}` : 'None'],
  ];
}

/**
 * Warnings for the Summary pane. ctx: hasSpots, hasTextOutlines, hasText,
 * hasRgb (RGB artwork or images), outputProfile { kind, deviceClass,
 * version } of the output intent, bleed (any side > 0).
 */
export function pdfWarnings(v, { hasSpots = false, hasTextOutlines = true, hasText = true, hasRgb = true, outputProfile = null, bleed = true } = {}) {
  const w = [];
  if (pdfEncrypted(v) && Number(v.compat) < 1.6) w.push('Password protection uses AES, so the file is written as PDF 1.6.');
  if (v.layers && Number(v.compat) < 1.5) w.push('Layers need PDF 1.5 or later; they are left out.');
  if (isPdfx(v)) {
    const name = PDF_STANDARDS[v.standard];
    if (v.standard === 'x1a') {
      if (hasRgb) w.push(`${name} allows only CMYK and spot colors: RGB colors and images are converted to CMYK.`);
      w.push(`${name} allows no transparency: transparent artwork, opacity masks, effects and images with transparency are flattened.`);
    }
    if (hasText && !hasTextOutlines) w.push(`Text is written with a standard font that is not embedded; ${name} requires embedded fonts, so the file will not conform. Convert the text to outlines first.`);
    if (outputProfile && outputProfile.kind !== 'CMYK') w.push(`The output intent must be a CMYK printing profile; ${name} files describe the press they are made for.`);
    if (v.standard === 'x1a' && outputProfile?.version?.startsWith?.('4')) w.push(`${name} needs a version 2 ICC output profile; this one is version 4.`);
    if (!bleed) w.push('There is no bleed: artwork that touches the trim edge may show a white sliver after trimming.');
    w.push(`${name} files carry no security, page thumbnails or links.`);
  }
  if (v.standard === 'press' && (v.requireOpen || v.restrict)) w.push('Print production files cannot be password protected; security is off.');
  if (v.restrict && !v.permissionsPassword) w.push('Without a permissions password, nobody can lift the restrictions later.');
  if (hasSpots && v.spotsToProcess) w.push('Spot colors will be converted to process colors.');
  if (v.textOutlines && !hasTextOutlines) w.push('Text is written with a standard font because outlines are not available.');
  if (v.flatten) w.push('Transparent artwork is rasterized at the flattener preset’s resolution.');
  return w;
}
