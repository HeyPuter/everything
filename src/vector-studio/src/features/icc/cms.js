/**
 * Color management for the app: which profile a document's RGB and CMYK
 * numbers are in, and the ICC transforms every conversion goes through
 * (Convert to CMYK/RGB, the Color panel's CMYK values, separations,
 * proofs, print simulation, PDF output and import).
 *
 * The display is treated as sRGB: the canvas draws a document's RGB
 * numbers as they are, and proofs map them through the device to sRGB.
 * Conversions use the Color Settings' rendering intent and black point
 * compensation unless a caller overrides them.
 */
import { colorSettings, documentCmykProfile, documentRgbSpace, profileLabel, cmykProfile, profileColors, blackPoint as pressBlackPoint } from '../prepress/color-management.js';
import { profileEntry, profileModel, transformBetween, listProfiles } from './profiles.js';
import { chainTransforms } from './transform.js';
import { pcsToSrgb, clamp01 } from './math.js';

export const DISPLAY_PROFILE = 'srgb';
const FALLBACK = { RGB: 'srgb', CMYK: 'coatedWeb', Gray: 'gray22' };

/** `id` when it names a usable profile of `kind`, else the built-in default of the kind. */
export function usableProfile(id, kind) {
  const e = profileEntry(id);
  if (e && e.kind === kind && profileModel(id)) return id;
  return FALLBACK[kind];
}

/** Profile of a document's RGB numbers. */
export function docRgbProfile(app, doc) {
  return usableProfile(documentRgbSpace(app, doc), 'RGB');
}

/** Profile of a document's CMYK numbers (and of its CMYK output). */
export function docCmykProfile(app, doc) {
  return usableProfile(documentCmykProfile(app, doc), 'CMYK');
}

/** Rendering intent and black point compensation from the color settings (with overrides). */
export function conversionOptions(app, overrides = {}) {
  const cs = colorSettings(app);
  return { intent: cs.intent, bpc: cs.bpc, ...overrides };
}

/** Name of a profile for menus and messages. */
export function profileDisplayName(id) {
  return profileEntry(id)?.name || profileLabel(id);
}

/** [[id, name]] of the profiles of a kind, for selects. `outputOnly` keeps those colors can be converted to. */
export function profileOptions(kind, opts = {}) {
  return listProfiles(kind, opts).map((e) => [e.id, e.source === 'embedded' ? `${e.name} (from a document)` : e.name]);
}

// ---- conversions ----

export function rgbToCmykTransform(app, doc, overrides) {
  return transformBetween(docRgbProfile(app, doc), docCmykProfile(app, doc), conversionOptions(app, overrides));
}

export function cmykToRgbTransform(app, doc, overrides) {
  return transformBetween(docCmykProfile(app, doc), docRgbProfile(app, doc), conversionOptions(app, overrides));
}

/** Document RGB (0..1) -> CMYK percentages { c, m, y, k } in the document's CMYK profile. */
export function rgbToCmyk(app, doc, rgb, overrides) {
  const t = rgbToCmykTransform(app, doc, overrides);
  const v = t ? t.convert(rgb) : [0, 0, 0, 1 - Math.max(...rgb)];
  return { c: v[0] * 100, m: v[1] * 100, y: v[2] * 100, k: v[3] * 100 };
}

/** CMYK percentages in the document's CMYK profile -> document RGB (0..1). */
export function cmykToRgb(app, doc, cmyk, overrides) {
  const t = cmykToRgbTransform(app, doc, overrides);
  const v = [cmyk.c / 100, cmyk.m / 100, cmyk.y / 100, cmyk.k / 100].map(clamp01);
  return t ? t.convert(v) : [0, 1, 2].map((i) => (1 - v[i]) * (1 - v[3]));
}

/** Convert values between two profile ids; null when either is unusable. */
export function convertValues(values, src, dst, opts = {}) {
  const t = transformBetween(src, dst, opts);
  return t ? t.convert(values) : null;
}

// ---- proofs ----

/**
 * The proof of a document on a device, as one transform from document
 * RGB to display RGB:
 *   device   { kind: 'cmyk' | 'rgb', id }
 *   intent, bpc   how document colors go to the device
 *   paper    show the device's paper (absolute colorimetric to the display)
 *   black    show the device's real black (no black point compensation)
 *   preserve RGB devices: show the numbers as the device would (no conversion)
 */
export function proofTransform(app, doc, { device, intent = 'relative', bpc = true, paper = false, black = false, preserve = false }) {
  const src = docRgbProfile(app, doc);
  if (device.kind === 'rgb') {
    const dev = usableProfile(device.id, 'RGB');
    const show = transformBetween(dev, DISPLAY_PROFILE, { intent: 'relative' });
    return preserve ? show : chainTransforms(transformBetween(src, dev, { intent, bpc }), show);
  }
  const dev = usableProfile(device.id, 'CMYK');
  const toDevice = transformBetween(src, dev, { intent, bpc });
  const show = transformBetween(dev, DISPLAY_PROFILE, paper ? { intent: 'absolute' } : { intent: 'relative', bpc: !black });
  return toDevice && show ? chainTransforms(toDevice, show) : null;
}

// ---- inks of a CMYK profile (separations preview) ----

const inkCache = new Map();
/**
 * How a CMYK profile's inks look, for showing plates over paper:
 * { paper, inks: [[r, g, b] x4], absorb, gain, blackRel, til, label }.
 * Press models give their own; for ICC profiles the solids, the 50% dot
 * gain and the black come from the profile's colorimetric tables.
 */
export function inkView(id) {
  const pid = usableProfile(id, 'CMYK');
  if (inkCache.has(pid)) return inkCache.get(pid);
  const model = profileModel(pid);
  let out;
  if (model.press) {
    const p = cmykProfile(model.press);
    const { paper, inks } = profileColors(model.press);
    out = { paper, inks, gain: p.gain, blackRel: pressBlackPoint(model.press), til: p.til };
  } else {
    const to = model.toPcs('relative');
    const from = model.fromPcs('relative') || model.fromPcs('perceptual');
    const color = (plates) => pcsToSrgb(to(plates));
    const inks = [0, 1, 2, 3].map((i) => color([0, 1, 2, 3].map((j) => (j === i ? 1 : 0))));
    // Dot gain: how much darker a 50% tint prints than half the solid, on the ink's strongest channel.
    const gains = [0, 1, 2, 3].map((i) => {
      const ch = inks[i].indexOf(Math.min(...inks[i]));
      const half = color([0, 1, 2, 3].map((j) => (j === i ? 0.5 : 0)))[ch];
      const area = (1 - half) / Math.max(1e-3, 1 - inks[i][ch]);
      return Math.max(0, Math.min(0.4, area - 0.5));
    });
    const richest = from ? from([0, 0, 0]) : [1, 1, 1, 1];
    out = { paper: [1, 1, 1], inks, gain: gains.reduce((a, b) => a + b, 0) / 4, blackRel: color(richest), til: Math.round(richest.reduce((a, b) => a + b, 0) * 100) };
  }
  out.absorb = out.inks.map((c) => c.map((v) => 1 - v));
  out.label = profileDisplayName(pid);
  out.id = pid;
  inkCache.set(pid, out);
  return out;
}
