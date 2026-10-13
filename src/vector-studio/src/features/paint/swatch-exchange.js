/**
 * Swatch interchange files: a compact binary swatch exchange format of our
 * own (.vswx) for colors, color groups and gradients, and CSS custom
 * properties (.css) for web work.
 *
 * Binary format (all numbers big-endian):
 *
 *   header   'VSWX' (4 bytes), version u16 (1), flags u16 (0), entry count u32
 *   entry    type u8, then its fields:
 *     1 color      name, kind u8 (0 process, 1 global, 2 spot), model u8
 *                  (0 RGB, 1 CMYK, 2 Gray, 3 Lab), the model's components
 *                  as f32 (RGB 0..1 x3; CMYK 0..1 x4; Gray 0..1 x1 where 1
 *                  is white; Lab L 0..100, a, b x3), then the color as
 *                  sRGB bytes r g b (what it looks like on screen)
 *     2 group start  name (entries up to the matching group end belong to it)
 *     3 group end    no fields
 *     4 gradient   name, shape u8 (0 linear, 1 radial), angle f32 (degrees),
 *                  aspect f32, stop count u16, then per stop: offset f32,
 *                  midpoint f32, opacity f32, sRGB bytes r g b
 *   name     u16 byte length + UTF-8 bytes
 *
 * Readers take the sRGB bytes as the color and may use the model
 * components to keep a swatch's color mode. Pattern swatches are not part
 * of the format (the JSON library format carries them).
 */
import { hexToRgb, rgbToHex, rgbToCmyk } from '../../lib/color.js';
import { paintCss } from '../../ui/widgets.js';

export const VSWX_MAGIC = 'VSWX';
const T_COLOR = 1;
const T_GROUP = 2;
const T_END = 3;
const T_GRADIENT = 4;
const KINDS = ['process', 'global', 'spot'];
const MODELS = ['rgb', 'cmyk', 'gray', 'lab'];

class Writer {
  constructor() {
    this.bytes = [];
  }
  u8(v) {
    this.bytes.push(v & 255);
  }
  u16(v) {
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v) {
    this.u16((v >>> 16) & 0xffff);
    this.u16(v & 0xffff);
  }
  f32(v) {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, Number.isFinite(v) ? v : 0);
    for (let i = 0; i < 4; i++) this.u8(b.getUint8(i));
  }
  str(s) {
    const b = new TextEncoder().encode(String(s ?? '')).slice(0, 0xffff);
    this.u16(b.length);
    for (const x of b) this.u8(x);
  }
  rgb(hex) {
    const { r, g, b } = hexToRgb(hex);
    this.u8(r);
    this.u8(g);
    this.u8(b);
  }
  result() {
    return new Uint8Array(this.bytes);
  }
}

class Reader {
  constructor(bytes) {
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }
  need(n) {
    if (this.at + n > this.v.byteLength) throw new Error('Truncated swatch file');
  }
  u8() {
    this.need(1);
    return this.v.getUint8(this.at++);
  }
  u16() {
    this.need(2);
    const x = this.v.getUint16(this.at);
    this.at += 2;
    return x;
  }
  u32() {
    this.need(4);
    const x = this.v.getUint32(this.at);
    this.at += 4;
    return x;
  }
  f32() {
    this.need(4);
    const x = this.v.getFloat32(this.at);
    this.at += 4;
    return x;
  }
  str() {
    const n = this.u16();
    this.need(n);
    const s = new TextDecoder().decode(new Uint8Array(this.v.buffer, this.v.byteOffset + this.at, n));
    this.at += n;
    return s;
  }
  rgb() {
    return rgbToHex({ r: this.u8(), g: this.u8(), b: this.u8() });
  }
}

const gray = (hex) => {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

function writeColor(w, s) {
  const hex = s.paint.color;
  w.u8(T_COLOR);
  w.str(s.name);
  w.u8(s.spot ? 2 : s.global ? 1 : 0);
  const model = s.mode === 'cmyk' ? 1 : s.mode === 'gray' ? 2 : 0;
  w.u8(model);
  if (model === 1) {
    const c = s.spotCmyk || rgbToCmyk(hexToRgb(hex));
    for (const k of ['c', 'm', 'y', 'k']) w.f32((c[k] ?? 0) / 100);
  } else if (model === 2) w.f32(gray(hex));
  else for (const v of Object.values(hexToRgb(hex))) w.f32(v / 255);
  w.rgb(hex);
}

function writeGradient(w, s) {
  const p = s.paint;
  w.u8(T_GRADIENT);
  w.str(s.name);
  w.u8(p.type === 'radial' ? 1 : 0);
  w.f32(p.angle || 0);
  w.f32(p.aspect ?? 1);
  const stops = p.stops || [];
  w.u16(stops.length);
  for (const st of stops) {
    w.f32(st.offset);
    w.f32(st.midpoint ?? 0.5);
    w.f32(st.opacity ?? 1);
    w.rgb(st.color);
  }
}

const writable = (s) => s?.paint && (s.paint.type === 'solid' || ((s.paint.type === 'linear' || s.paint.type === 'radial') && s.paint.stops?.length));

/**
 * Encode swatches ([{ name, paint, global?, spot?, mode?, group? }], group
 * = a group name; swatches of one group are written together, in the order
 * their groups first appear). Returns the file bytes.
 */
export function encodeSwatchExchange(swatches) {
  const list = swatches.filter(writable);
  const order = [];
  const byGroup = new Map();
  for (const s of list) {
    const g = s.group || '';
    if (!byGroup.has(g)) {
      byGroup.set(g, []);
      order.push(g);
    }
    byGroup.get(g).push(s);
  }
  const w = new Writer();
  for (const c of VSWX_MAGIC) w.u8(c.charCodeAt(0));
  w.u16(1);
  w.u16(0);
  let count = 0;
  for (const g of order) count += byGroup.get(g).length + (g ? 2 : 0);
  w.u32(count);
  for (const g of order) {
    if (g) {
      w.u8(T_GROUP);
      w.str(g);
    }
    for (const s of byGroup.get(g)) (s.paint.type === 'solid' ? writeColor : writeGradient)(w, s);
    if (g) w.u8(T_END);
  }
  return w.result();
}

export function isSwatchExchange(bytes) {
  return bytes?.length >= 12 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === VSWX_MAGIC;
}

/** Decode a .vswx file into { swatches: [{ name, paint, global?, spot?, mode?, group? }] }. Throws on a bad file. */
export function decodeSwatchExchange(bytes) {
  if (!isSwatchExchange(bytes)) throw new Error('Not a swatch exchange file');
  const r = new Reader(bytes);
  r.at = 4;
  const version = r.u16();
  if (version !== 1) throw new Error(`Unsupported swatch file version ${version}`);
  r.u16();
  const count = r.u32();
  const swatches = [];
  let group = null;
  for (let i = 0; i < count; i++) {
    const type = r.u8();
    if (type === T_GROUP) group = r.str() || null;
    else if (type === T_END) group = null;
    else if (type === T_COLOR) {
      const name = r.str();
      const kind = KINDS[r.u8()] || 'process';
      const model = MODELS[r.u8()] || 'rgb';
      const n = model === 'cmyk' ? 4 : model === 'gray' ? 1 : 3;
      const comps = Array.from({ length: n }, () => r.f32());
      const color = r.rgb();
      const sw = { name, paint: { type: 'solid', color } };
      if (kind !== 'process') sw.global = true;
      if (kind === 'spot') sw.spot = true;
      if (model === 'cmyk' || model === 'gray') sw.mode = model;
      if (kind === 'spot' && model === 'cmyk') sw.spotCmyk = { c: comps[0] * 100, m: comps[1] * 100, y: comps[2] * 100, k: comps[3] * 100 };
      if (group) sw.group = group;
      swatches.push(sw);
    } else if (type === T_GRADIENT) {
      const name = r.str();
      const shape = r.u8() === 1 ? 'radial' : 'linear';
      const angle = r.f32();
      const aspect = r.f32();
      const n = r.u16();
      const stops = [];
      for (let k = 0; k < n; k++) {
        const offset = r.f32();
        const midpoint = r.f32();
        const opacity = r.f32();
        const st = { offset, color: r.rgb(), opacity };
        if (Math.abs(midpoint - 0.5) > 1e-4) st.midpoint = midpoint;
        stops.push(st);
      }
      const paint = { type: shape, angle, stops };
      if (shape === 'radial' && Math.abs(aspect - 1) > 1e-4) paint.aspect = aspect;
      swatches.push({ name, paint, ...(group ? { group } : {}) });
    } else throw new Error(`Unknown swatch entry type ${type}`);
  }
  return { swatches };
}

/** A CSS custom property name for a swatch name ('Sky Blue' -> '--sky-blue'), unique within `used`. */
export function cssVarName(name, used = new Set()) {
  const base = `--${String(name || 'swatch')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'swatch'}`;
  let out = /^--[0-9]/.test(base) ? `--c-${base.slice(2)}` : base;
  for (let i = 2; used.has(out); i++) out = `${base}-${i}`;
  used.add(out);
  return out;
}

/** CSS custom properties for swatches: colors as hex, gradients as CSS gradients, grouped by color group. */
export function swatchesCss(name, swatches) {
  const used = new Set();
  const lines = [`/* ${String(name).replace(/\*\//g, '')} */`, ':root {'];
  let group = null;
  for (const s of swatches) {
    if (!s.paint || s.paint.type === 'pattern') continue;
    const value = s.paint.type === 'solid' ? s.paint.color : paintCss(s.paint);
    if (!value) continue;
    if ((s.group || null) !== group) {
      group = s.group || null;
      if (group) lines.push(`  /* ${String(group).replace(/\*\//g, '')} */`);
    }
    lines.push(`  ${cssVarName(s.name, used)}: ${value};`);
  }
  lines.push('}', '');
  return lines.join('\n');
}
