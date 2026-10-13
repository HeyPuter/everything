/**
 * PDF color spaces converted to the document's RGB colors. ICC-based
 * spaces convert through their embedded profile, CalRGB, CalGray and Lab
 * through the color engine (icc/import.js), all into the RGB working
 * space. Device colors are characterized by the Default color spaces of
 * the resources, else by the file's output intent profile; otherwise RGB
 * numbers stay as they are and CMYK goes through the app's CMYK engine
 * (the working CMYK profile). Indexed, Separation and DeviceN go through
 * their base or alternate spaces. Separation colors carry their ink name
 * so the importer can make spot swatches.
 */
import { PDFDict, PDFStream, Name, Ref, strBytes } from './primitives.js';
import { compileFunction } from './functions.js';
import { cmykEngine } from '../../../lib/color.js';
import { iccImportSpace, labImportSpace, calImportSpace } from '../../icc/import.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

export function cmykToRgb01(c, m, y, k) {
  const r = cmykEngine.toRgb({ c: clamp01(c) * 100, m: clamp01(m) * 100, y: clamp01(y) * 100, k: clamp01(k) * 100 });
  return [r.r / 255, r.g / 255, r.b / 255];
}

export function rgbHex(rgb) {
  const h = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

const DEVICE = {
  gray: { kind: 'gray', n: 1, toRGB: (c) => [clamp01(c[0]), clamp01(c[0]), clamp01(c[0])], initial: [0] },
  rgb: { kind: 'rgb', n: 3, toRGB: (c) => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])], initial: [0, 0, 0] },
  cmyk: { kind: 'cmyk', n: 4, toRGB: (c) => cmykToRgb01(c[0], c[1], c[2], c[3]), initial: [0, 0, 0, 1] },
};
export const DEVICE_SPACES = DEVICE;
const PATTERN = { kind: 'pattern', n: 0, toRGB: () => [0, 0, 0], initial: [] };

const DEFAULT_NAMES = { gray: 'DefaultGray', rgb: 'DefaultRGB', cmyk: 'DefaultCMYK' };
const intentCache = new WeakMap();

/** The space of the file's output intent profile (or null). */
function outputIntentSpace(xref) {
  if (!xref?.catalog) return null;
  if (intentCache.has(xref)) return intentCache.get(xref);
  let space = null;
  try {
    let list = xref.catalog.get('OutputIntents');
    if (list instanceof Ref) list = xref.fetch(list);
    for (let oi of Array.isArray(list) ? list : []) {
      if (oi instanceof Ref) oi = xref.fetch(oi);
      let prof = oi instanceof PDFDict ? oi.get('DestOutputProfile') : null;
      if (prof instanceof Ref) prof = xref.fetch(prof);
      if (!(prof instanceof PDFStream)) continue;
      const bytes = prof.decoded();
      space = iccImportSpace(bytes, prof.dict.num('N', 4)) || null;
      if (space) break;
    }
  } catch {
    space = null;
  }
  intentCache.set(xref, space);
  return space;
}

/**
 * A device color space as the file characterizes it: the resources'
 * Default space, else the output intent profile when it has the same
 * number of components, else the plain device space.
 */
export function deviceSpace(xref, kind, resources, depth = 0) {
  const dict = resources?.get?.('ColorSpace');
  const def = dict instanceof PDFDict ? dict.get(DEFAULT_NAMES[kind]) : null;
  if (def && depth < 8) {
    const s = parseColorSpace(xref, def, null, depth + 1);
    if (s.n === DEVICE[kind].n && s.kind !== 'pattern') return s;
  }
  const oi = outputIntentSpace(xref);
  if (oi && oi.n === DEVICE[kind].n) return oi;
  return DEVICE[kind];
}

/**
 * Parse a color space (a name, an array, or a name looked up in the
 * resources' /ColorSpace dictionary). Returns a space object:
 *   { kind, n, toRGB(components) -> [r, g, b] (0..1), initial, decode?(i) range,
 *     spot?: { name, rgb } , base? (pattern underlying space) }
 */
export function parseColorSpace(xref, cs, resources, depth = 0) {
  if (depth > 8) return DEVICE.gray;
  if (cs instanceof Ref) cs = xref.fetch(cs);
  if (cs instanceof Name) {
    switch (cs.name) {
      case 'DeviceGray':
      case 'G':
        return deviceSpace(xref, 'gray', resources, depth);
      case 'CalGray':
        return DEVICE.gray;
      case 'DeviceRGB':
      case 'RGB':
        return deviceSpace(xref, 'rgb', resources, depth);
      case 'CalRGB':
        return DEVICE.rgb;
      case 'DeviceCMYK':
      case 'CMYK':
        return deviceSpace(xref, 'cmyk', resources, depth);
      case 'Pattern':
        return PATTERN;
      default: {
        const dict = resources?.get('ColorSpace');
        const named = dict instanceof PDFDict ? dict.get(cs.name) : null;
        if (named !== undefined && named !== null) {
          // Default color spaces (DefaultRGB...) apply only to device spaces; any other name is a resource.
          return parseColorSpace(xref, named, null, depth + 1);
        }
        return DEVICE.gray;
      }
    }
  }
  if (!Array.isArray(cs) || !cs.length) return DEVICE.gray;
  const fam = cs[0] instanceof Name ? cs[0].name : '';
  const arg = (i) => (cs[i] instanceof Ref ? xref.fetch(cs[i]) : cs[i]);
  switch (fam) {
    case 'DeviceGray':
    case 'G':
      return deviceSpace(xref, 'gray', resources, depth);
    case 'DeviceRGB':
    case 'RGB':
      return deviceSpace(xref, 'rgb', resources, depth);
    case 'DeviceCMYK':
    case 'CMYK':
      return deviceSpace(xref, 'cmyk', resources, depth);
    case 'CalGray':
    case 'CalRGB': {
      const d = arg(1);
      const gray = fam === 'CalGray';
      if (!(d instanceof PDFDict)) return gray ? DEVICE.gray : DEVICE.rgb;
      const g = d.get('Gamma');
      return calImportSpace({
        white: d.array('WhitePoint') || [0.9505, 1, 1.089],
        gamma: gray ? [typeof g === 'number' ? g : 1] : Array.isArray(g) ? g : [1, 1, 1],
        matrix: gray ? null : d.array('Matrix') || null,
        channels: gray ? 1 : 3,
      });
    }
    case 'ICCBased': {
      const s = arg(1);
      const d = s instanceof PDFStream ? s.dict : s instanceof PDFDict ? s : null;
      const n = d ? d.num('N', 3) : 3;
      // The embedded profile first; the alternate space or the component count when it is unusable.
      if (s instanceof PDFStream) {
        let bytes = null;
        try {
          bytes = s.decoded();
        } catch {
          bytes = null;
        }
        const icc = iccImportSpace(bytes, n);
        if (icc) return icc;
      }
      const alt = d?.get('Alternate');
      if (alt) {
        const a = parseColorSpace(xref, alt, resources, depth + 1);
        if (a.kind !== 'pattern') return a;
      }
      return n === 1 ? DEVICE.gray : n === 4 ? DEVICE.cmyk : DEVICE.rgb;
    }
    case 'Lab': {
      const d = arg(1);
      const white = (d instanceof PDFDict && d.array('WhitePoint')) || [0.9505, 1, 1.089];
      const range = (d instanceof PDFDict && d.array('Range')) || [-100, 100, -100, 100];
      return labImportSpace(white, range);
    }
    case 'Indexed':
    case 'I': {
      const base = parseColorSpace(xref, arg(1), resources, depth + 1);
      const hival = Math.max(0, Math.min(255, Math.floor(arg(2) || 0)));
      let lookup = arg(3);
      let bytes;
      if (lookup instanceof PDFStream) {
        try {
          bytes = lookup.decoded();
        } catch {
          bytes = new Uint8Array(0);
        }
      } else bytes = strBytes(typeof lookup === 'string' ? lookup : '');
      const table = [];
      const ranges = base.ranges || null;
      for (let i = 0; i <= hival; i++) {
        const comps = [];
        for (let k = 0; k < base.n; k++) {
          const v = (bytes[i * base.n + k] ?? 0) / 255;
          comps.push(ranges ? ranges[k][0] + v * (ranges[k][1] - ranges[k][0]) : v);
        }
        table.push(base.toRGB(comps));
      }
      return { kind: 'indexed', n: 1, hival, table, toRGB: (c) => table[Math.max(0, Math.min(hival, Math.round(c[0])))] || [0, 0, 0], initial: [0], base };
    }
    case 'Separation': {
      const name = arg(1) instanceof Name ? arg(1).name : 'Spot';
      const alt = parseColorSpace(xref, arg(2), resources, depth + 1);
      const fn = compileFunction(xref, arg(3));
      const toRGB = (c) => {
        if (name === 'None') return [1, 1, 1];
        if (name === 'All') return [1 - clamp01(c[0]), 1 - clamp01(c[0]), 1 - clamp01(c[0])];
        if (!fn) return [1 - clamp01(c[0]), 1 - clamp01(c[0]), 1 - clamp01(c[0])];
        return alt.toRGB(fn([clamp01(c[0])]));
      };
      const full = toRGB([1]);
      let cmyk = null;
      if (alt.kind === 'cmyk' && fn) cmyk = fn([1]).map(clamp01);
      return { kind: 'separation', n: 1, toRGB, initial: [1], spot: name === 'None' || name === 'All' ? null : { name, rgb: full, cmyk }, none: name === 'None', all: name === 'All' };
    }
    case 'DeviceN': {
      const names = (arg(1) || []).map((x) => (x instanceof Name ? x.name : ''));
      const alt = parseColorSpace(xref, arg(2), resources, depth + 1);
      const fn = compileFunction(xref, arg(3));
      const n = names.length || 1;
      const process = { Cyan: 0, Magenta: 1, Yellow: 2, Black: 3 };
      const toRGB = (c) => {
        if (fn) return alt.toRGB(fn(c.map(clamp01)));
        // Without a tint transform: process colorants as CMYK.
        const cmyk = [0, 0, 0, 0];
        names.forEach((nm, i) => {
          if (nm in process) cmyk[process[nm]] = c[i];
        });
        return cmykToRgb01(...cmyk);
      };
      const spots = names.filter((x) => !(x in process) && x !== 'None' && x !== 'All');
      return { kind: 'devicen', n, toRGB, initial: new Array(n).fill(1), names, spotNames: spots };
    }
    case 'Pattern': {
      const base = cs.length > 1 ? parseColorSpace(xref, arg(1), resources, depth + 1) : null;
      return { ...PATTERN, base };
    }
    default:
      return DEVICE.gray;
  }
}

/** Default Decode ranges of an image in a color space (per component [min, max]). */
export function defaultDecode(space, bpc) {
  if (space.kind === 'indexed') return [[0, 2 ** bpc - 1]];
  if (space.kind === 'lab') return space.ranges;
  return new Array(space.n).fill(0).map(() => [0, 1]);
}
