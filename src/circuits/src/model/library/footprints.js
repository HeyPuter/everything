// Footprint generators. Dimensions are given in millimetres for readability
// and converted to integer nanometres on output. Land patterns follow
// nominal-density practice: pads extend past the terminal toe, silkscreen
// keeps a solder-mask-safe gap from copper, and the courtyard encloses pads
// and body with a fixed margin.
//
// Orientation conventions (top view, +y up):
// - Two-terminal parts lie along x with pad 1 at -x (cathode / positive).
// - Dual-row packages (SOIC, DIP) have pin 1 at the top left and count
//   counter-clockwise; quad packages start at the top of the left side.
// - Headers run along y with pin 1 at the top.

import { mm } from '../../core/units.js';
import { arcToPoints } from '../../core/geom.js';

const SILK_W = 0.15;
const ASM_W = 0.1;
const CRT_W = 0.05;
const SILK_GAP = 0.15;
// Shorter fragments left between closely spaced pads only add clutter.
const MIN_SILK = mm(0.25);

const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (v) => String(Math.round(v * 100) / 100);

/** Surface-mount pad. */
export function smdPad(num, x, y, w, h, opts = {}) {
  const shape = opts.shape || 'roundrect';
  const p = { num: String(num), x: mm(x), y: mm(y), shape, w: mm(w), h: mm(shape === 'round' ? w : h), rot: 0, side: 'top' };
  if (shape === 'roundrect') p.radius = opts.radius ?? 0.25;
  if (opts.maskExpansion !== undefined) p.maskExpansion = mm(opts.maskExpansion);
  if (opts.noPaste) p.noPaste = true;
  return p;
}

/** Through-hole pad. `square` gives the rectangular pin-1 pad. */
export function thtPad(num, x, y, size, drill, opts = {}) {
  const shape = opts.shape || (opts.square ? 'rect' : 'round');
  const h = opts.h ?? size;
  return {
    num: String(num), x: mm(x), y: mm(y), shape,
    w: mm(size), h: mm(shape === 'round' ? size : h), rot: 0,
    side: 'thru', drill: mm(drill), plated: opts.plated ?? true,
  };
}

/** Axis-aligned half extents of a pad (rotation in quarter turns only). */
export function padHalf(p) {
  if (p.shape === 'round') return [p.w / 2, p.w / 2];
  const r = (((p.rot || 0) % 180) + 180) % 180;
  return r === 90 ? [p.h / 2, p.w / 2] : [p.w / 2, p.h / 2];
}

export function padBox(p, grow = 0) {
  const [hx, hy] = padHalf(p);
  return { minX: p.x - hx - grow, minY: p.y - hy - grow, maxX: p.x + hx + grow, maxY: p.y + hy + grow };
}

/**
 * First pair of differently numbered pads whose copper overlaps or touches on
 * a shared layer, as [numA, numB], or null. Such a footprint shorts its pins
 * together. Unnumbered pads, non-plated holes and pads at angles other than
 * quarter turns are not checked.
 */
export function overlappingPads(pads) {
  const boxes = pads.map((p) => padBox(p));
  const checked = (p) => p.num && p.plated !== false && (p.shape === 'round' || (p.rot || 0) % 90 === 0);
  const shareLayer = (a, b) => a.side === b.side || a.side === 'thru' || b.side === 'thru';
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const a = pads[i], b = pads[j];
      if (a.num === b.num || !checked(a) || !checked(b) || !shareLayer(a, b)) continue;
      const A = boxes[i], B = boxes[j];
      const touch = A.minX <= B.maxX && B.minX <= A.maxX && A.minY <= B.maxY && B.minY <= A.maxY;
      if (touch) return [pads[i].num, pads[j].num];
    }
  }
  return null;
}

/** Liang-Barsky: parameter interval of segment inside a box, or null. */
function segBoxInterval(x1, y1, x2, y2, b) {
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - b.minX, b.maxX - x1, y1 - b.minY, b.maxY - y1];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

function subtractInterval(list, [a, b]) {
  const out = [];
  for (const [s, e] of list) {
    if (b <= s || a >= e) { out.push([s, e]); continue; }
    if (a > s) out.push([s, a]);
    if (b < e) out.push([b, e]);
  }
  return out;
}

/**
 * Converts silkscreen polylines (mm) to line graphics, cutting away every
 * part that comes closer to a pad than the silk-to-copper gap.
 */
export function silkLines(polylines, pads, layer = 'topOverlay') {
  const w = mm(SILK_W);
  const keep = pads.map((p) => padBox(p, mm(SILK_GAP + SILK_W / 2)));
  const out = [];
  for (const pl of polylines) {
    for (let i = 0; i + 3 < pl.length; i += 2) {
      const x1 = mm(pl[i]), y1 = mm(pl[i + 1]), x2 = mm(pl[i + 2]), y2 = mm(pl[i + 3]);
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (!len) continue;
      let parts = [[0, 1]];
      for (const b of keep) {
        const hit = segBoxInterval(x1, y1, x2, y2, b);
        if (hit) parts = subtractInterval(parts, hit);
        if (!parts.length) break;
      }
      for (const [s, e] of parts) {
        if ((e - s) * len < MIN_SILK) continue;
        out.push({
          t: 'line', layer, w,
          x1: Math.round(x1 + (x2 - x1) * s), y1: Math.round(y1 + (y2 - y1) * s),
          x2: Math.round(x1 + (x2 - x1) * e), y2: Math.round(y1 + (y2 - y1) * e),
        });
      }
    }
  }
  return out;
}

export const rectPts = (x1, y1, x2, y2) => [x1, y1, x2, y1, x2, y2, x1, y2, x1, y1];

/** Arc as a polyline in mm. */
export const arcPts = (cx, cy, r, a0, sweep) => arcToPoints(cx, cy, r, a0, sweep, 0.01);

/** A '+' sign polyline pair centred at (x, y), half size s (mm). */
export const plusPts = (x, y, s = 0.4) => [[x - s, y, x + s, y], [x, y - s, x, y + s]];

/**
 * Pin-1 dot (nm) placed beyond the pad on its outward side, measured from
 * the footprint origin.
 */
export function pin1Dot(p) {
  const [hx, hy] = padHalf(p);
  const off = mm(SILK_GAP + 0.1 + 0.1);
  if (Math.abs(p.x) >= Math.abs(p.y)) return [p.x + Math.sign(p.x || -1) * (hx + off), p.y];
  return [p.x, p.y + Math.sign(p.y || 1) * (hy + off)];
}

const roundOut = (v, q, up) => (up ? Math.ceil(v / q) : Math.floor(v / q)) * q;

/**
 * Assembles a footprint: silkscreen (clipped), assembly outline, courtyard.
 * body: {w, h, height, color, shape, x, y} in mm.
 */
export function finish({ name, description, pads, silk = [], dots = [], extra = [], body, margin = 0.25, assembly = true, dupPads = false }) {
  const graphics = silkLines(silk, pads);
  for (const [cx, cy] of dots) graphics.push({ t: 'circle', cx: Math.round(cx), cy: Math.round(cy), r: mm(0.1), w: 0, fill: true, layer: 'topOverlay' });
  graphics.push(...extra);
  let fb = null;
  if (body) {
    const bx = body.x || 0, by = body.y || 0;
    fb = { w: mm(body.w), h: mm(body.h), height: mm(body.height), color: body.color || '#222222', shape: body.shape || 'box' };
    if (bx) fb.x = mm(bx);
    if (by) fb.y = mm(by);
    if (assembly) {
      graphics.push({
        t: 'rect', layer: 'mech1', w: mm(ASM_W),
        x1: mm(bx - body.w / 2), y1: mm(by - body.h / 2), x2: mm(bx + body.w / 2), y2: mm(by + body.h / 2),
      });
    }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pads) {
    const b = padBox(p);
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
  }
  if (fb) {
    const bx = fb.x || 0, by = fb.y || 0;
    minX = Math.min(minX, bx - fb.w / 2); maxX = Math.max(maxX, bx + fb.w / 2);
    minY = Math.min(minY, by - fb.h / 2); maxY = Math.max(maxY, by + fb.h / 2);
  }
  const q = mm(0.05), m = mm(margin);
  const courtyard = {
    x1: roundOut(minX - m, q, false), y1: roundOut(minY - m, q, false),
    x2: roundOut(maxX + m, q, true), y2: roundOut(maxY + m, q, true),
  };
  graphics.push({ t: 'rect', layer: 'courtyard', w: mm(CRT_W), ...courtyard });
  const fp = { name, description, pads, graphics, courtyard };
  if (fb) fp.body = fb;
  if (dupPads) fp.dupPads = true;
  return fp;
}

// ---------------------------------------------------------------- two-terminal

/**
 * Two pads along x. C is the pad centre distance, padL the pad size along x.
 * polarized adds a marker bar beyond pad 1.
 */
function twoTerminal({ name, description, C, padL, padW, body, polarized = false, silk = 'outline', shape = 'roundrect', extraSilk = [] }) {
  const pads = [smdPad(1, -C / 2, 0, padL, padW, { shape }), smdPad(2, C / 2, 0, padL, padW, { shape })];
  const lines = [...extraSilk];
  const hw = body.w / 2 + 0.1, hh = body.h / 2 + 0.1;
  if (silk === 'outline') lines.push(rectPts(-hw, -hh, hw, hh));
  if (polarized) {
    const x = -Math.max(C / 2 + padL / 2 + 0.3, hw + 0.1);
    const y = Math.max(padW / 2, hh);
    lines.push([x, -y, x, y]);
  }
  return finish({ name, description, pads, silk: lines, body });
}

// L, W, pad length, pad width, pad centre distance
const CHIP = {
  '0201': [0.6, 0.3, 0.3, 0.32, 0.56],
  '0402': [1.0, 0.5, 0.55, 0.6, 1.0],
  '0603': [1.6, 0.8, 0.8, 0.95, 1.6],
  '0805': [2.0, 1.25, 1.0, 1.45, 1.9],
  '1206': [3.2, 1.6, 1.15, 1.8, 3.0],
  '1210': [3.2, 2.5, 1.15, 2.7, 3.0],
  '2010': [5.0, 2.5, 1.25, 2.7, 4.6],
  '2512': [6.3, 3.2, 1.4, 3.4, 5.8],
};
export const CHIP_SIZES = Object.keys(CHIP);

const CHIP_HEIGHT = {
  R: { '0201': 0.23, '0402': 0.35, '0603': 0.45, '0805': 0.5, '1206': 0.55, '1210': 0.55, '2010': 0.6, '2512': 0.6 },
  C: { '0201': 0.3, '0402': 0.5, '0603': 0.8, '0805': 1.25, '1206': 1.6, '1210': 1.6, '2010': 1.6, '2512': 1.6 },
  L: { '0201': 0.3, '0402': 0.5, '0603': 0.8, '0805': 0.9, '1206': 1.1, '1210': 1.6, '2010': 1.6, '2512': 1.6 },
  D: { '0201': 0.3, '0402': 0.4, '0603': 0.6, '0805': 0.8, '1206': 0.9, '1210': 1.0, '2010': 1.0, '2512': 1.0 },
};
const CHIP_COLOR = { R: '#1c1c1c', C: '#b9905a', L: '#3a3a3a', D: '#e8e8e8' };
const CHIP_KIND = { R: 'resistor', C: 'capacitor', L: 'inductor', D: 'diode or LED' };

/** Rectangular chip component (resistor, capacitor, inductor, chip LED). */
export function chip(size = '0603', kind = 'R', { color } = {}) {
  const d = CHIP[size];
  if (!d) throw new Error(`Unknown chip size ${size}`);
  const [L, W, padL, padW, C] = d;
  const k = CHIP_HEIGHT[kind] ? kind : 'R';
  const small = size === '0201' || size === '0402';
  return twoTerminal({
    name: `${k === 'D' ? 'D' : k}${size}`,
    description: `Chip ${CHIP_KIND[k]}, ${size} (imperial) package, ${fmt(L)} x ${fmt(W)} mm body`,
    C, padL, padW, polarized: k === 'D', silk: small ? 'none' : 'outline',
    body: { w: L, h: W, height: CHIP_HEIGHT[k][size], color: color || CHIP_COLOR[k] },
  });
}

// body L, body W, pad length, pad width, pad centre distance, height
const MOLDED = {
  'SOD-323': [1.7, 1.25, 0.6, 0.5, 2.3, 0.9],
  'SOD-123': [2.7, 1.6, 0.9, 1.2, 3.6, 1.15],
  SMA: [4.3, 2.6, 1.8, 1.7, 4.0, 2.3],
  SMB: [4.6, 3.6, 2.2, 2.3, 4.3, 2.3],
  SMC: [7.0, 5.9, 2.5, 3.3, 6.9, 2.4],
};
export const MOLDED_PACKAGES = Object.keys(MOLDED);

/** Molded two-terminal diode package. Pad 1 is the cathode. */
export function moldedBody(pkg = 'SOD-123') {
  const d = MOLDED[pkg];
  if (!d) throw new Error(`Unknown package ${pkg}`);
  const [L, W, padL, padW, C, h] = d;
  return twoTerminal({
    name: pkg, description: `Molded two-terminal package ${pkg}, pad 1 cathode`,
    C, padL, padW, polarized: true, body: { w: L, h: W, height: h, color: '#2a2a2a' },
  });
}

// d, height, pad centre distance, pad length, pad width
const ELEC_SMD = {
  '4x5.4': [4, 5.4, 3.4, 2.4, 1.6],
  '5x5.4': [5, 5.4, 4.0, 2.8, 1.6],
  '6.3x5.4': [6.3, 5.4, 4.8, 3.2, 1.6],
  '6.3x7.7': [6.3, 7.7, 4.8, 3.2, 1.6],
  '8x10.2': [8, 10.2, 6.2, 3.6, 2.0],
};
export const ELEC_SMD_SIZES = Object.keys(ELEC_SMD);

/** Surface-mount aluminium electrolytic capacitor. Pad 1 is positive. */
export function smdElectrolytic(size = '6.3x5.4') {
  const d = ELEC_SMD[size];
  if (!d) throw new Error(`Unknown size ${size}`);
  const [D, H, C, padL, padW] = d;
  const s = D / 2 + 0.1, c = Math.min(1.2, D / 4);
  const outline = [-s + c, s, s, s, s, -s, -s + c, -s, -s, -s + c, -s, s - c, -s + c, s];
  const px = -(C / 2 + padL / 2) - 0.1, py = padW / 2 + 1.2;
  return twoTerminal({
    name: `CAP-SMD-${size}`, description: `Surface-mount electrolytic capacitor, ${D} mm diameter, ${H} mm tall, pad 1 positive`,
    C, padL, padW, silk: 'none', extraSilk: [outline, ...plusPts(px, py)],
    body: { w: D, h: D, height: H, color: '#a8a8a8', shape: 'cylinder' },
  });
}

const IND_POWER = { '4x4': [4, 2.0, 3.0, 1.4, 3.6], '6x6': [6, 3.0, 4.4, 1.8, 5.2] };
export const IND_POWER_SIZES = Object.keys(IND_POWER);

/** Shielded surface-mount power inductor. */
export function inductorPower(size = '4x4') {
  const d = IND_POWER[size];
  if (!d) throw new Error(`Unknown size ${size}`);
  const [S, h, C, padL, padW] = d;
  return twoTerminal({
    name: `IND-${size}`, description: `Shielded power inductor, ${S} x ${S} mm`,
    C, padL, padW, body: { w: S, h: S, height: h, color: '#3a3a3a' },
  });
}

// ---------------------------------------------------------------- SOT packages

/** SOT-23 with 3, 5 or 6 pins. Pins 1..3 on the bottom row, left to right. */
export function sot23(pins = 3) {
  const pads = [];
  const y = pins === 3 ? 1.1 : 1.25, w = 0.6, h = 1.0;
  if (pins === 3) {
    pads.push(smdPad(1, -0.95, -y, w, h), smdPad(2, 0.95, -y, w, h), smdPad(3, 0, y, w, h));
  } else {
    const xs = [-0.95, 0, 0.95];
    xs.forEach((x, i) => pads.push(smdPad(i + 1, x, -y, w, h)));
    const top = pins === 5 ? [0.95, -0.95] : [0.95, 0, -0.95];
    top.forEach((x, i) => pads.push(smdPad(4 + i, x, y, w, h)));
  }
  const bw = 2.9, bh = pins === 3 ? 1.3 : 1.6;
  const hw = bw / 2 + 0.1, hh = bh / 2 + 0.1;
  return finish({
    name: pins === 3 ? 'SOT-23' : `SOT-23-${pins}`,
    description: `Small outline transistor package, ${pins} pins, 0.95 mm pitch`,
    pads, silk: [rectPts(-hw, -hh, hw, hh)], dots: [pin1Dot(pads[0])],
    body: { w: bw, h: bh, height: 1.1, color: '#222222' },
  });
}

/** SOT-223: three leads plus a wide tab. tab is the tab pad number. */
export function sot223({ tab = '4' } = {}) {
  const pads = [
    smdPad(1, -2.3, -3.15, 1.0, 2.0), smdPad(2, 0, -3.15, 1.0, 2.0), smdPad(3, 2.3, -3.15, 1.0, 2.0),
    smdPad(tab, 0, 3.15, 3.4, 2.0),
  ];
  return finish({
    name: 'SOT-223', description: `SOT-223 power package, tab is pad ${tab}`,
    pads, silk: [rectPts(-3.35, -1.85, 3.35, 1.85)], dots: [pin1Dot(pads[0])],
    body: { w: 6.5, h: 3.5, height: 1.8, color: '#222222' }, dupPads: tab !== '4',
  });
}

/** TO-252 (DPAK): pads 1 and 3 plus the tab as pad 2. */
export function dpak() {
  const pads = [smdPad(1, -2.28, -4.0, 1.2, 2.2), smdPad(3, 2.28, -4.0, 1.2, 2.2), smdPad(2, 0, 1.8, 6.0, 6.2)];
  return finish({
    name: 'TO-252', description: 'TO-252 (DPAK) power package, tab is pad 2',
    pads, silk: [rectPts(-3.4, -2.6, 3.4, 5.1)], dots: [pin1Dot(pads[0])],
    body: { w: 6.6, h: 6.1, height: 2.3, color: '#222222', y: 1.3 },
  });
}

// ---------------------------------------------------------------- dual row SMD

const SOP = {
  SOIC: { pitch: 1.27, C: 5.4, padL: 1.55, padW: 0.6, bodyW: 3.9, height: 1.75, lenAdd: -0.2 },
  TSSOP: { pitch: 0.65, C: 5.8, padL: 1.5, padW: 0.4, bodyW: 4.4, height: 1.2, lenAdd: 0.4 },
  MSOP: { pitch: 0.65, C: 4.4, padL: 1.45, padW: 0.42, bodyW: 3.0, height: 1.1, lenAdd: 0.4 },
  SSOP: { pitch: 0.65, C: 7.0, padL: 1.75, padW: 0.45, bodyW: 5.3, height: 2.0, lenAdd: 0.7 },
};
export const SOP_FAMILIES = Object.keys(SOP);

/**
 * Generic dual-row gull-wing package. Pin 1 top left, counter-clockwise.
 * epad > 0 adds an exposed pad numbered pins + 1.
 */
export function sop({ pins = 8, pitch = 1.27, C = 5.4, padL = 1.55, padW = 0.6, bodyW = 3.9, bodyL, height = 1.75, epad = 0, name, family = 'SOP' } = {}) {
  if (pins % 2) throw new Error('Pin count must be even');
  const n = pins / 2;
  const L = bodyL ?? Math.max(n * pitch - 0.2, n * pitch * 0.9);
  const pads = [];
  for (let i = 0; i < n; i++) pads.push(smdPad(i + 1, -C / 2, ((n - 1) / 2 - i) * pitch, padL, padW));
  for (let i = 0; i < n; i++) pads.push(smdPad(n + i + 1, C / 2, (i - (n - 1) / 2) * pitch, padL, padW));
  if (epad > 0) pads.push(smdPad(pins + 1, 0, 0, Math.min(epad, bodyW - 0.6), Math.min(epad * 1.3, L - 0.6), { shape: 'rect' }));
  const hw = bodyW / 2 + 0.1, hh = L / 2 + 0.1;
  return finish({
    name: name || `${family}-${pins}${epad > 0 ? '-EP' : ''}`,
    description: `${family} ${pins} pins, ${pitch} mm pitch, ${fmt(bodyW)} mm body width`,
    pads, silk: [rectPts(-hw, -hh, hw, hh)], dots: [pin1Dot(pads[0])],
    body: { w: bodyW, h: L, height, color: '#222222' },
  });
}

export function soic(pins = 8, opts = {}) {
  const f = SOP.SOIC;
  return sop({ ...f, bodyL: pins / 2 * f.pitch + f.lenAdd, pins, family: 'SOIC', ...opts });
}
export function tssop(pins = 14, opts = {}) {
  const f = SOP.TSSOP;
  return sop({ ...f, bodyL: pins / 2 * f.pitch + f.lenAdd, pins, family: 'TSSOP', ...opts });
}
export function msop(pins = 8, opts = {}) {
  const f = SOP.MSOP;
  return sop({ ...f, bodyL: pins / 2 * f.pitch + f.lenAdd, pins, family: 'MSOP', ...opts });
}
export function ssop(pins = 20, opts = {}) {
  const f = SOP.SSOP;
  return sop({ ...f, bodyL: pins / 2 * f.pitch + f.lenAdd, pins, family: 'SSOP', ...opts });
}

// ---------------------------------------------------------------- quad packages

/** Pads around a square: left side top to bottom, then bottom, right, top. */
function quadPads(pins, c, pitch, padL, padW) {
  if (pins % 4) throw new Error('Pin count must be a multiple of 4');
  const k = pins / 4;
  const pads = [];
  for (let i = 0; i < k; i++) {
    const off = ((k - 1) / 2 - i) * pitch;
    pads.push(smdPad(i + 1, -c, off, padL, padW));
  }
  for (let i = 0; i < k; i++) {
    const off = ((k - 1) / 2 - i) * pitch;
    pads.push(smdPad(k + i + 1, -off, -c, padW, padL));
  }
  for (let i = 0; i < k; i++) {
    const off = ((k - 1) / 2 - i) * pitch;
    pads.push(smdPad(2 * k + i + 1, c, -off, padL, padW));
  }
  for (let i = 0; i < k; i++) {
    const off = ((k - 1) / 2 - i) * pitch;
    pads.push(smdPad(3 * k + i + 1, off, c, padW, padL));
  }
  return pads;
}

/** Quad flat no-lead package with optional exposed pad (numbered pins + 1). */
export function qfn({ pins = 32, size = 5, pitch = 0.5, epad = 3.1, padL = 0.8, padW, height = 0.9 } = {}) {
  const pw = padW ?? Math.min(pitch * 0.5, 0.35);
  const pads = quadPads(pins, size / 2 - 0.05, pitch, padL, pw);
  const inner = size / 2 - 0.45;
  if (epad > 0) {
    const e = Math.min(epad, 2 * (inner - 0.2));
    pads.push(smdPad(pins + 1, 0, 0, e, e, { shape: 'rect' }));
  }
  const s = size / 2 + 0.1;
  return finish({
    name: `QFN-${pins}-${fmt(size)}x${fmt(size)}`,
    description: `Quad flat no-lead, ${pins} pins, ${fmt(size)} x ${fmt(size)} mm, ${pitch} mm pitch${epad > 0 ? ', exposed pad' : ''}`,
    pads, silk: [rectPts(-s, -s, s, s)], dots: [pin1Dot(pads[0])],
    body: { w: size, h: size, height, color: '#222222' },
  });
}

/** Low-profile quad flat package with gull-wing leads. */
export function qfp({ pins = 32, size = 7, pitch = 0.8, padL = 1.5, padW, height = 1.6 } = {}) {
  const pw = padW ?? Math.round(pitch * 0.55 * 100) / 100;
  const pads = quadPads(pins, size / 2 + 0.75, pitch, padL, pw);
  const s = size / 2 + 0.1;
  return finish({
    name: `LQFP-${pins}-${fmt(size)}x${fmt(size)}`,
    description: `Low-profile quad flat package, ${pins} pins, ${fmt(size)} x ${fmt(size)} mm body, ${pitch} mm pitch`,
    pads, silk: [rectPts(-s, -s, s, s)], dots: [pin1Dot(pads[0])],
    body: { w: size, h: size, height, color: '#222222' },
  });
}

// ---------------------------------------------------------------- through hole

/** Dual in-line package. Pin 1 top left, counter-clockwise. */
export function dip({ pins = 8, rowSpacing = 7.62, pitch = 2.54, drill = 0.8, pad = 1.6 } = {}) {
  if (pins % 2) throw new Error('Pin count must be even');
  const n = pins / 2;
  const x = rowSpacing / 2;
  const pads = [];
  for (let i = 0; i < n; i++) pads.push(thtPad(i + 1, -x, ((n - 1) / 2 - i) * pitch, pad, drill, { square: i === 0 }));
  for (let i = 0; i < n; i++) pads.push(thtPad(n + i + 1, x, (i - (n - 1) / 2) * pitch, pad, drill));
  const sx = x - pad / 2 - 0.3, sy = (n * pitch) / 2 + 0.2;
  const notch = 0.6;
  const silk = [
    [-notch, sy, -sx, sy, -sx, -sy, sx, -sy, sx, sy, notch, sy],
    arcPts(0, sy, notch, 180, 180),
  ];
  const bodyW = rowSpacing - 1.27;
  return finish({
    name: `DIP-${pins}${rowSpacing > 10 ? '-W' : ''}`,
    description: `Dual in-line package, ${pins} pins, ${fmt(rowSpacing)} mm row spacing`,
    pads, silk, body: { w: bodyW, h: n * pitch + 0.8, height: 4.5, color: '#222222' }, margin: 0.5,
  });
}

/** Pin header: `rows` parallel rows of `cols` pins along y. Pin 1 top left. */
export function header({ rows = 1, cols = 4, pitch = 2.54, drill = 1.0, pad = 1.7 } = {}) {
  const pads = [];
  let num = 1;
  for (let j = 0; j < cols; j++) {
    const y = ((cols - 1) / 2 - j) * pitch;
    for (let i = 0; i < rows; i++) {
      const x = (i - (rows - 1) / 2) * pitch;
      pads.push(thtPad(num, x, y, pad, drill, { square: num === 1 }));
      num++;
    }
  }
  const hx = (rows * pitch) / 2, hy = (cols * pitch) / 2;
  const p1 = pads[0];
  const mx = -hx - 0.3, my = p1.y / 1e6;
  return finish({
    name: `HDR-${rows}x${pad2(cols)}-${pitch.toFixed(2)}`,
    description: `Pin header, ${rows} x ${cols}, ${pitch} mm pitch`,
    pads, silk: [rectPts(-hx, -hy, hx, hy), [mx, my + pitch / 2, mx, my - pitch / 2]],
    body: { w: rows * pitch, h: cols * pitch, height: 2.5, color: '#202020' },
  });
}

/** Wire-to-board connector, single row, pins along x. Pin 1 at the left. */
export function wireToBoard({ pins = 2, pitch = 2.0 } = {}) {
  const big = pitch >= 2.5;
  const drill = big ? 1.0 : 0.75, pad = big ? 1.7 : 1.3;
  const pads = [];
  for (let i = 0; i < pins; i++) pads.push(thtPad(i + 1, (i - (pins - 1) / 2) * pitch, 0, pad, drill, { square: i === 0 }));
  const hx = ((pins - 1) * pitch) / 2 + (big ? 2.45 : 1.95);
  const y1 = big ? -2.35 : -1.7, y2 = big ? 3.4 : 2.8;
  return finish({
    name: `CONN-${pitch.toFixed(1)}-1x${pad2(pins)}`,
    description: `Wire-to-board connector, ${pins} pins, ${pitch} mm pitch, vertical`,
    pads, silk: [rectPts(-hx - 0.1, y1 - 0.1, hx + 0.1, y2 + 0.1)],
    body: { w: 2 * hx, h: y2 - y1, height: big ? 7.0 : 6.0, color: '#f0f0e8', y: (y1 + y2) / 2 },
  });
}

/** Screw terminal block, single row. */
export function terminalBlock({ pins = 2, pitch = 5.08 } = {}) {
  const pads = [];
  for (let i = 0; i < pins; i++) pads.push(thtPad(i + 1, (i - (pins - 1) / 2) * pitch, 0, 2.6, 1.3, { square: i === 0 }));
  const hx = ((pins - 1) * pitch) / 2 + pitch / 2;
  return finish({
    name: `TB-1x${pad2(pins)}-${pitch.toFixed(2)}`,
    description: `Screw terminal block, ${pins} positions, ${pitch} mm pitch`,
    pads, silk: [rectPts(-hx - 0.1, -4.1, hx + 0.1, 4.1)],
    body: { w: 2 * hx, h: 8, height: 10, color: '#3a7bd5' },
  });
}

/** Single-row through-hole parts (TO-220, trimmer). */
function inline({ name, description, pins = 3, pitch = 2.54, drill = 0.8, pad = 1.6, padH, silk, body, shape }) {
  const pads = [];
  for (let i = 0; i < pins; i++) {
    pads.push(thtPad(i + 1, (i - (pins - 1) / 2) * pitch, 0, pad, drill, { square: i === 0, shape: i === 0 ? 'rect' : shape, h: padH }));
  }
  return finish({ name, description, pads, silk, body });
}

/** TO-220, vertical, three leads. The metal tab faces +y. */
export function to220() {
  return inline({
    name: 'TO-220-3', description: 'TO-220 three-lead power package, vertical mount, tab at the back',
    pitch: 2.54, drill: 1.1, pad: 1.8, padH: 2.6, shape: 'oval',
    silk: [rectPts(-5.2, -2.1, 5.2, 2.7), [-5.2, 1.4, 5.2, 1.4]],
    body: { w: 10.2, h: 4.6, height: 15.5, color: '#222222', y: 0.3 },
  });
}

/** TO-92 with leads formed to a 2.54 mm pitch. */
export function to92() {
  const r = 2.4;
  const a0 = -30, sweep = 240;
  const end0 = [r * Math.cos(a0 * Math.PI / 180), r * Math.sin(a0 * Math.PI / 180)];
  const end1 = [r * Math.cos((a0 + sweep) * Math.PI / 180), r * Math.sin((a0 + sweep) * Math.PI / 180)];
  return inline({
    name: 'TO-92', description: 'TO-92 three-lead package, inline leads at 2.54 mm pitch',
    pitch: 2.54, drill: 0.8, pad: 1.5,
    silk: [arcPts(0, 0, r, a0, sweep), [end1[0], end1[1], end0[0], end0[1]]],
    body: { w: 4.8, h: 3.8, height: 4.8, color: '#222222', y: 0.3 },
  });
}

/** Single-turn trimmer potentiometer, three inline pins. */
export function trimmer() {
  return inline({
    name: 'POT-TRIM-3', description: 'Trimmer potentiometer, three inline pins at 2.54 mm',
    pitch: 2.54, drill: 0.8, pad: 1.6,
    silk: [rectPts(-3.4, -3.5, 3.4, 3.5), arcPts(0, 0.8, 1.5, 0, 360)],
    body: { w: 6.6, h: 6.8, height: 4.9, color: '#2f5fd0' },
  });
}

/** Radial electrolytic capacitor. Pad 1 (square) is positive. */
export function radialCap({ d = 5, pitch = 2.0, height = 11, drill = 0.8, pad = 1.6 } = {}) {
  const pads = [thtPad(1, -pitch / 2, 0, pad, drill, { square: true }), thtPad(2, pitch / 2, 0, pad, drill)];
  const r = d / 2 + 0.15;
  const k = (d / 2) * 0.55;
  return finish({
    name: `CAP-RAD-${fmt(d)}x${fmt(height)}`,
    description: `Radial electrolytic capacitor, ${fmt(d)} mm diameter, ${fmt(pitch)} mm lead spacing, pad 1 positive`,
    pads, silk: [arcPts(0, 0, r, 0, 360), ...plusPts(-k - 0.4, k + 0.4, 0.4)],
    body: { w: d, h: d, height, color: '#1e2a5a', shape: 'cylinder' },
  });
}

/** Axial part (resistor, diode) lying flat. polarized marks pad 1 (cathode). */
export function axial({ pitch = 10.16, bodyL = 6.3, bodyD = 2.5, drill = 0.8, pad = 1.6, polarized = false, name, color } = {}) {
  const pads = [thtPad(1, -pitch / 2, 0, pad, drill, { square: polarized }), thtPad(2, pitch / 2, 0, pad, drill)];
  const hx = bodyL / 2 + 0.1, hy = bodyD / 2 + 0.1;
  const silk = [rectPts(-hx, -hy, hx, hy), [-pitch / 2, 0, -hx, 0], [hx, 0, pitch / 2, 0]];
  if (polarized) silk.push([-hx + 0.6, -hy, -hx + 0.6, hy], [-hx + 0.8, -hy, -hx + 0.8, hy]);
  return finish({
    name: name || `AXIAL-${fmt(pitch)}`,
    description: `Axial lead part, ${fmt(pitch)} mm lead spacing, ${fmt(bodyL)} x ${fmt(bodyD)} mm body${polarized ? ', pad 1 cathode' : ''}`,
    pads, silk, body: { w: bodyL, h: bodyD, height: bodyD, color: color || (polarized ? '#1a1a1a' : '#c8b28a'), shape: 'box' },
  });
}

/** HC-49 low-profile crystal, through hole. */
export function crystalHC49() {
  const pads = [thtPad(1, -2.44, 0, 1.5, 0.8), thtPad(2, 2.44, 0, 1.5, 0.8)];
  const r = 2.3, cx = 3.2;
  const silk = [
    arcPts(-cx, 0, r, 90, 180), arcPts(cx, 0, r, -90, 180),
    [-cx, r, cx, r], [-cx, -r, cx, -r],
  ];
  return finish({
    name: 'HC49-S', description: 'HC-49 low-profile crystal, 4.88 mm lead spacing',
    pads, silk, body: { w: 11, h: 4.6, height: 3.5, color: '#c0c0c0' },
  });
}

/** Surface-mount crystal or oscillator: '3225' (four pads) or '5032' (two pads). */
export function crystalSMD(size = '3225') {
  if (size === '5032') {
    return twoTerminal({
      name: 'XTAL-5032-2P', description: 'Surface-mount crystal, 5.0 x 3.2 mm, two pads',
      C: 3.8, padL: 1.8, padW: 2.4, body: { w: 5.0, h: 3.2, height: 1.0, color: '#d0d0d0' },
    });
  }
  const pads = [smdPad(1, -1.1, -0.8, 1.4, 1.2), smdPad(2, 1.1, -0.8, 1.4, 1.2), smdPad(3, 1.1, 0.8, 1.4, 1.2), smdPad(4, -1.1, 0.8, 1.4, 1.2)];
  return finish({
    name: 'XTAL-3225-4P', description: 'Surface-mount crystal or oscillator, 3.2 x 2.5 mm, four pads',
    pads, silk: [rectPts(-1.7, -1.35, 1.7, 1.35)], dots: [pin1Dot(pads[0])],
    body: { w: 3.2, h: 2.5, height: 0.8, color: '#d0d0d0' },
  });
}

/** Round through-hole LED (3 or 5 mm). Pad 1 (square) is the cathode, on the flat side. */
export function ledTHT(d = 5, { color = '#e8e8e8' } = {}) {
  const big = d >= 5;
  const pads = [thtPad(1, -1.27, 0, big ? 1.8 : 1.6, big ? 0.9 : 0.8, { square: true }), thtPad(2, 1.27, 0, big ? 1.8 : 1.6, big ? 0.9 : 0.8)];
  const r = d / 2 + 0.5, flat = -(d / 2 + 0.2);
  // Arc from the bottom end of the flat, around the right side, to its top end.
  const th = Math.acos(flat / r) * 180 / Math.PI;
  const yFlat = Math.sqrt(r * r - flat * flat);
  const silk = [arcPts(0, 0, r, -th, 2 * th), [flat, -yFlat, flat, yFlat]];
  return finish({
    name: `LED-${d}MM`, description: `${d} mm round LED, 2.54 mm lead spacing, pad 1 cathode`,
    pads, silk, body: { w: d, h: d, height: big ? 8.6 : 5.3, color, shape: 'cylinder' },
  });
}

/** 6 x 6 mm tactile switch. Pads sharing a number are connected inside the part. */
export function tactile({ smd = false } = {}) {
  const pads = smd
    ? [smdPad(1, -4.0, 2.25, 1.6, 1.4), smdPad(1, 4.0, 2.25, 1.6, 1.4), smdPad(2, -4.0, -2.25, 1.6, 1.4), smdPad(2, 4.0, -2.25, 1.6, 1.4)]
    : [thtPad(1, -3.25, 2.25, 2.0, 1.0), thtPad(1, 3.25, 2.25, 2.0, 1.0), thtPad(2, -3.25, -2.25, 2.0, 1.0), thtPad(2, 3.25, -2.25, 2.0, 1.0)];
  const s = smd ? 3.2 : 3.1;
  return finish({
    name: `SW-TACT-6x6-${smd ? 'SMD' : 'THT'}`,
    description: `6 x 6 mm tactile push button, ${smd ? 'surface mount' : 'through hole'}`,
    pads, silk: [rectPts(-s, -s, s, s), arcPts(0, 0, 1.75, 0, 360)],
    body: { w: smd ? 6.2 : 6, h: smd ? 6.2 : 6, height: 5.0, color: '#303030' }, dupPads: true,
  });
}

/** Mounting hole. pad = 0 makes a non-plated hole; otherwise a plated ring. */
export function mountingHole({ drill = 3.2, pad = 0 } = {}) {
  const plated = pad > drill;
  const size = plated ? pad : drill;
  const p = thtPad(1, 0, 0, size, drill, { plated });
  const r = size / 2 + 0.3;
  return finish({
    name: `MH-${fmt(drill)}-${plated ? 'PTH' : 'NPTH'}`,
    description: `Mounting hole, ${fmt(drill)} mm ${plated ? `plated, ${fmt(pad)} mm ring` : 'non-plated'}`,
    pads: [p], silk: [arcPts(0, 0, r, 0, 360)], margin: 0.25, assembly: false,
  });
}

/** Single round test pad. */
export function testPoint({ d = 1.5 } = {}) {
  const p = smdPad(1, 0, 0, d, d, { shape: 'round', noPaste: true });
  return finish({
    name: `TP-${fmt(d)}`, description: `Test point, ${fmt(d)} mm round pad`,
    pads: [p], silk: [arcPts(0, 0, d / 2 + 0.25, 0, 360)],
  });
}

/** Fiducial: bare copper dot with a wide solder mask opening. */
export function fiducial({ d = 1.0, opening = 2.0 } = {}) {
  const p = smdPad(1, 0, 0, d, d, { shape: 'round', maskExpansion: (opening - d) / 2, noPaste: true });
  return finish({
    name: `FID-${fmt(d)}`, description: `Fiducial mark, ${fmt(d)} mm copper, ${fmt(opening)} mm mask opening`,
    pads: [p], margin: (opening - d) / 2 + 0.25, assembly: false,
  });
}

/** 12 mm magnetic buzzer, through hole. Pad 1 is positive. */
export function buzzer12() {
  const pads = [thtPad(1, -3.8, 0, 1.6, 0.8, { square: true }), thtPad(2, 3.8, 0, 1.6, 0.8)];
  return finish({
    name: 'BUZZER-12MM', description: '12 mm round buzzer, 7.6 mm lead spacing, pad 1 positive',
    pads, silk: [arcPts(0, 0, 6.15, 0, 360), ...plusPts(-3.8, 2.4, 0.4)],
    body: { w: 12, h: 12, height: 9.5, color: '#1a1a1a', shape: 'cylinder' },
  });
}
