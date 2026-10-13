/**
 * PDF color spaces converted to the document's sRGB colors. Device and
 * calibrated spaces map directly (ICC-based spaces by their component
 * count or alternate space), CMYK goes through the app's CMYK engine (so
 * color settings apply), Lab through XYZ, and Indexed, Separation and
 * DeviceN through their base or alternate spaces. Separation colors carry
 * their ink name so the importer can make spot swatches.
 */
import { PDFDict, PDFStream, Name, Ref, strBytes } from './primitives.js';
import { compileFunction } from './functions.js';
import { cmykEngine } from '../../../lib/color.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

export function cmykToRgb01(c, m, y, k) {
  const r = cmykEngine.toRgb({ c: clamp01(c) * 100, m: clamp01(m) * 100, y: clamp01(y) * 100, k: clamp01(k) * 100 });
  return [r.r / 255, r.g / 255, r.b / 255];
}

export function rgbHex(rgb) {
  const h = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

function labToRgb(L, a, b, white = [0.9505, 1, 1.089]) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const g = (t) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = white[0] * g(fx);
  const Y = white[1] * g(fy);
  const Z = white[2] * g(fz);
  const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
  return lin.map((v) => clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
}

const DEVICE = {
  gray: { kind: 'gray', n: 1, toRGB: (c) => [clamp01(c[0]), clamp01(c[0]), clamp01(c[0])], initial: [0] },
  rgb: { kind: 'rgb', n: 3, toRGB: (c) => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])], initial: [0, 0, 0] },
  cmyk: { kind: 'cmyk', n: 4, toRGB: (c) => cmykToRgb01(c[0], c[1], c[2], c[3]), initial: [0, 0, 0, 1] },
};
export const DEVICE_SPACES = DEVICE;
const PATTERN = { kind: 'pattern', n: 0, toRGB: () => [0, 0, 0], initial: [] };

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
      case 'CalGray':
        return DEVICE.gray;
      case 'DeviceRGB':
      case 'RGB':
      case 'CalRGB':
        return DEVICE.rgb;
      case 'DeviceCMYK':
      case 'CMYK':
        return DEVICE.cmyk;
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
    case 'CalGray':
    case 'G':
      return DEVICE.gray;
    case 'DeviceRGB':
    case 'CalRGB':
    case 'RGB':
      return DEVICE.rgb;
    case 'DeviceCMYK':
    case 'CMYK':
      return DEVICE.cmyk;
    case 'ICCBased': {
      const s = arg(1);
      const d = s instanceof PDFStream ? s.dict : s instanceof PDFDict ? s : null;
      const alt = d?.get('Alternate');
      if (alt) {
        const a = parseColorSpace(xref, alt, resources, depth + 1);
        if (a.kind !== 'pattern') return a;
      }
      const n = d ? d.num('N', 3) : 3;
      return n === 1 ? DEVICE.gray : n === 4 ? DEVICE.cmyk : DEVICE.rgb;
    }
    case 'Lab': {
      const d = arg(1);
      const white = (d instanceof PDFDict && d.array('WhitePoint')) || [0.9505, 1, 1.089];
      const range = (d instanceof PDFDict && d.array('Range')) || [-100, 100, -100, 100];
      return { kind: 'lab', n: 3, toRGB: (c) => labToRgb(c[0], c[1], c[2], white), initial: [0, 0, 0], ranges: [[0, 100], [range[0], range[1]], [range[2], range[3]]] };
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
