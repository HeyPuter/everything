/**
 * Color spaces of imported files (PDF, EPS) through the color engine:
 * ICC-based spaces with their embedded profile, CIE-based spaces (Lab,
 * calibrated RGB and gray) and output intent profiles convert to the
 * RGB working space with the Color Settings' intent, instead of being
 * read as device colors.
 *
 * A space is what the PDF importer uses: { kind, n, toRGB(components) ->
 * [r, g, b] (0..1), initial, icc? }.
 */
import { parseProfile } from './parse.js';
import { modelFromProfile } from './transform.js';
import { transformBetween, profileHash, calibratedModel } from './profiles.js';
import { D50, labToXyz, adaptation, mul3, clamp01 } from './math.js';

/** Where imported colors go; the color feature keeps it in step with the Color Settings. */
export const importTarget = { rgb: 'srgb', intent: 'relative', bpc: true };

const KIND = { 1: 'gray', 3: 'rgb', 4: 'cmyk' };
const INITIAL = { 1: [0], 3: [0, 0, 0], 4: [0, 0, 0, 1] };

/** A space converting through `model`; `normalize` maps the file's component values to the model's 0..1 inputs. */
export function modelImportSpace(model, { kind = null, normalize = null, extra = {} } = {}) {
  const n = model.channels;
  const opts = { intent: importTarget.intent, bpc: importTarget.bpc };
  let t = null;
  const transform = () => (t ||= transformBetween(model, importTarget.rgb, opts) || transformBetween(model, 'srgb', opts));
  return {
    kind: kind || KIND[n] || 'rgb',
    n,
    initial: INITIAL[n] || new Array(n).fill(0),
    icc: true,
    ...extra,
    toRGB: (c) => {
      const tr = transform();
      if (!tr) return [0, 0, 0];
      // Exact: the importer caches colors, and tables would blur white and the primaries.
      const out = tr.convert(normalize ? normalize(c) : Array.from(c, clamp01));
      return [out[0], out[1], out[2]];
    },
  };
}

const spaceCache = new Map();
/**
 * The space of an ICC profile embedded in a file (`n` components), or null
 * when the data is not a usable profile with that many channels.
 */
export function iccImportSpace(bytes, n) {
  if (!bytes?.length) return null;
  const key = `${profileHash(bytes)}|${n}|${importTarget.rgb}|${importTarget.intent}|${importTarget.bpc}`;
  if (spaceCache.has(key)) return spaceCache.get(key);
  let space = null;
  try {
    const p = parseProfile(bytes);
    const model = modelFromProfile(p, `file:${profileHash(bytes)}`);
    if (model.channels === n && model.toPcs('relative')) {
      // Lab profiles take L* 0..100 and a*, b* -128..127 in files.
      const normalize = p.colorSpace === 'Lab ' ? (c) => [clamp01(c[0] / 100), clamp01((c[1] + 128) / 255), clamp01((c[2] + 128) / 255)] : null;
      space = modelImportSpace(model, { normalize, kind: p.colorSpace === 'Lab ' ? 'lab' : null, extra: { profileName: p.description } });
      if (p.colorSpace === 'Lab ') space.ranges = [[0, 100], [-128, 127], [-128, 127]];
    }
  } catch {
    space = null;
  }
  if (spaceCache.size > 32) spaceCache.delete(spaceCache.keys().next().value);
  spaceCache.set(key, space);
  return space;
}

/** CIE L*a*b* relative to a white point (PDF Lab spaces), with a*, b* ranges. */
export function labImportSpace(white = [0.9505, 1, 1.089], range = [-100, 100, -100, 100]) {
  const adapt = adaptation(white, D50);
  const model = {
    key: `lab:${white.join(',')}`,
    name: 'L*a*b*',
    colorSpace: 'Lab ',
    channels: 3,
    deviceClass: 'spac',
    version: 4,
    mediaWhite: D50.slice(),
    toPcs: () => (v) => mul3(adapt, labToXyz([v[0] * 100, v[1] * 255 - 128, v[2] * 255 - 128], white)),
    fromPcs: () => null,
    blackPoint: () => [0, 0, 0],
  };
  const normalize = (c) => [clamp01(c[0] / 100), clamp01((c[1] + 128) / 255), clamp01((c[2] + 128) / 255)];
  const space = modelImportSpace(model, { kind: 'lab', normalize });
  space.ranges = [[0, 100], [range[0], range[1]], [range[2], range[3]]];
  return space;
}

/** Calibrated RGB or gray (PDF CalRGB / CalGray). */
export function calImportSpace({ white, gamma, matrix, channels }) {
  return modelImportSpace(calibratedModel({ white, gamma, matrix, channels }));
}

/**
 * ICC profile data a PostScript file declares in DSC comments
 * (%%BeginICCProfile ... %%EndICCProfile, hex data on comment lines), or null.
 */
export function dscIccProfile(text) {
  const m = /%%BeginICCProfile:[^\r\n]*?(Hex|Binary)?[ \t]*\r?\n/i.exec(text);
  if (!m || /Binary/i.test(m[1] || '')) return null;
  const end = text.indexOf('%%EndICCProfile', m.index);
  if (end < 0) return null;
  const hex = text.slice(m.index + m[0].length, end).replace(/^%/gm, '').replace(/[^0-9a-f]/gi, '');
  if (hex.length < 264) return null;
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
