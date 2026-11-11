// ICC binary writer for the profiles this module builds or parses: v2 and v4
// matrix/TRC (RGB and Gray) and LUT-based profiles with lut8, lut16 and (v4
// only) lutAtoB/lutBtoA tags, following the ICC.1 tag layouts. Identical tag
// objects share one payload, as the specification permits.
import type { Curve } from './profile';
import { curveValue } from './profile';
import { IccError, type Clut, type LutABTag, type LutTag, type Profile } from './icc-lut';
import { D50 } from './color-math';

class Bytes {
  buf = new Uint8Array(4096);
  view = new DataView(this.buf.buffer);
  length = 0;
  private grow(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) {
    this.grow(1);
    this.view.setUint8(this.length++, v);
  }
  u16(v: number) {
    this.grow(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
  }
  u32(v: number) {
    this.grow(4);
    this.view.setUint32(this.length, v >>> 0);
    this.length += 4;
  }
  s15(v: number) {
    this.grow(4);
    this.view.setInt32(this.length, Math.round(v * 65536));
    this.length += 4;
  }
  sig(s: string) {
    for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i) || 0x20);
  }
  pad4() {
    while (this.length % 4) this.u8(0);
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0);
  }
  bytes() {
    return this.buf.slice(0, this.length);
  }
}

const u16n = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 65535);
const u8n = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
const SRGB_PARA = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045];

function writeCurve(b: Bytes, c: Curve, v4: boolean) {
  if (c.kind === 'parametric' && c.type === 0 && (c.parameters[0] === 1 || !v4)) {
    b.sig('curv');
    b.u32(0);
    if (c.parameters[0] === 1) b.u32(0);
    else {
      b.u32(1);
      b.u16(Math.round(c.parameters[0] * 256));
    }
  } else if (v4 && (c.kind === 'parametric' || c.kind === 'srgb')) {
    const type = c.kind === 'srgb' ? 3 : c.type;
    const params = c.kind === 'srgb' ? SRGB_PARA : c.parameters;
    b.sig('para');
    b.u32(0);
    b.u16(type);
    b.u16(0);
    for (const p of params) b.s15(p);
  } else {
    // v2 has no parametric type: sample the curve densely.
    const values =
      c.kind === 'table' ? c.values : Array.from({ length: 1024 }, (_, i) => curveValue(c, i / 1023));
    b.sig('curv');
    b.u32(0);
    b.u32(values.length);
    for (const v of values) b.u16(u16n(v));
  }
  b.pad4();
}

function writeClutData(b: Bytes, clut: Clut, precision: 1 | 2) {
  if (precision === 2) for (const v of clut.data) b.u16(u16n(v));
  else for (const v of clut.data) b.u8(u8n(v));
}

function writeLut(b: Bytes, tag: LutTag, v4: boolean) {
  const start = b.length;
  if (tag.type === 'lut8' || tag.type === 'lut16') {
    const wide = tag.type === 'lut16';
    const g = tag.clut.grid[0];
    if (tag.clut.grid.some((n) => n !== g) || g < 2 || g > 255)
      throw new IccError('lut8/lut16 CLUTs need a uniform grid of 2-255 points.');
    b.sig(wide ? 'mft2' : 'mft1');
    b.u32(0);
    b.u8(tag.inputs);
    b.u8(tag.outputs);
    b.u8(g);
    b.u8(0);
    for (const m of tag.matrix) b.s15(m);
    const table = (t: Float32Array) => {
      if (wide) for (const v of t) b.u16(u16n(v));
      else {
        if (t.length !== 256) throw new IccError('lut8 tables have 256 entries.');
        for (const v of t) b.u8(u8n(v));
      }
    };
    if (wide) {
      // All input (and all output) tables of a lut16 share one length.
      if (new Set(tag.inCurves.map((t) => t.length)).size > 1 || new Set(tag.outCurves.map((t) => t.length)).size > 1)
        throw new IccError('lut16 tables of one side must have equal lengths.');
      b.u16(tag.inCurves[0].length);
      b.u16(tag.outCurves[0].length);
    }
    tag.inCurves.forEach(table);
    writeClutData(b, tag.clut, wide ? 2 : 1);
    tag.outCurves.forEach(table);
    b.pad4();
    return;
  }
  const ab = tag as LutABTag;
  if (!v4) throw new IccError('lutAtoB/lutBtoA tags require a v4 profile.');
  b.sig(ab.type === 'mAB' ? 'mAB ' : 'mBA ');
  b.u32(0);
  b.u8(ab.inputs);
  b.u8(ab.outputs);
  b.u16(0);
  const offsets = b.length;
  b.zeros(20);
  const setOffset = (slot: number) => b.view.setUint32(offsets + slot * 4, b.length - start);
  const curves = (list: Curve[]) => list.forEach((c) => writeCurve(b, c, true));
  // Element order in the file is B, matrix, M, CLUT, A for both directions.
  setOffset(0);
  curves(ab.B);
  if (ab.matrix) {
    setOffset(1);
    for (let i = 0; i < 12; i++) b.s15(ab.matrix[i] ?? 0);
  }
  if (ab.M) {
    setOffset(2);
    curves(ab.M);
  }
  if (ab.clut) {
    setOffset(3);
    for (let i = 0; i < 16; i++) b.u8(ab.clut.grid[i] ?? 0);
    b.u8(ab.clut.precision);
    b.zeros(3);
    writeClutData(b, ab.clut, ab.clut.precision);
    b.pad4();
  }
  if (ab.A) {
    setOffset(4);
    curves(ab.A);
  }
}

function writeText(b: Bytes, text: string, v4: boolean, kind: 'desc' | 'cprt') {
  const ascii = text.replace(/[^\x20-\x7e]/g, '?');
  if (v4) {
    b.sig('mluc');
    b.u32(0);
    b.u32(1);
    b.u32(12);
    b.sig('enUS');
    b.u32(text.length * 2);
    b.u32(28);
    // UTF-16 code units, so characters outside the BMP keep both halves.
    for (let i = 0; i < text.length; i++) b.u16(text.charCodeAt(i));
  } else if (kind === 'desc') {
    b.sig('desc');
    b.u32(0);
    b.u32(ascii.length + 1);
    for (const ch of ascii) b.u8(ch.charCodeAt(0));
    b.u8(0);
    b.zeros(4 + 4 + 2 + 1 + 67);
  } else {
    b.sig('text');
    b.u32(0);
    for (const ch of ascii) b.u8(ch.charCodeAt(0));
    b.u8(0);
  }
  b.pad4();
}

const SPACE_SIG: Record<string, string> = { RGB: 'RGB ', CMYK: 'CMYK', GRAY: 'GRAY', Lab: 'Lab ', XYZ: 'XYZ ', CMY: 'CMY ' };

export type SerializeOptions = { version?: 2 | 4; date?: Date };

export function serializeIcc(p: Profile, opts: SerializeOptions = {}): Uint8Array {
  const version = opts.version ?? (p.version >= 4 ? 4 : 2);
  const v4 = version === 4;
  type Entry = { sig: string; key: object | string; write: (b: Bytes) => void };
  const entries: Entry[] = [];
  const add = (sig: string, key: object | string, write: (b: Bytes) => void) => entries.push({ sig, key, write });
  const xyz = (v: number[]) => (b: Bytes) => {
    b.sig('XYZ ');
    b.u32(0);
    v.forEach((n) => b.s15(n));
  };
  add('desc', 'desc', (b) => writeText(b, p.name, v4, 'desc'));
  add('cprt', 'cprt', (b) => writeText(b, p.copyright ?? 'No copyright, use freely.', v4, 'cprt'));
  add('wtpt', 'wtpt', xyz(p.mediaWhite));
  if (p.mediaBlack && !v4) add('bkpt', 'bkpt', xyz(p.mediaBlack));
  if (p.chad) {
    const chad = p.chad;
    add('chad', 'chad', (b) => {
      b.sig('sf32');
      b.u32(0);
      chad.forEach((n) => b.s15(n));
    });
  }
  if (p.matrix && p.trc?.length === 3) {
    const m = p.matrix;
    ['r', 'g', 'b'].forEach((c, i) => add(`${c}XYZ`, `${c}XYZ`, xyz([m[i], m[3 + i], m[6 + i]])));
    ['r', 'g', 'b'].forEach((c, i) => {
      const curve = p.trc![i];
      add(`${c}TRC`, curve, (b) => writeCurve(b, curve, v4));
    });
  } else if (p.colorSpace === 'GRAY' && p.trc) {
    const curve = p.trc[0];
    add('kTRC', curve, (b) => writeCurve(b, curve, v4));
  }
  const lut = (sig: string, tag: LutTag | undefined) => tag && add(sig, tag, (b) => writeLut(b, tag, v4));
  p.a2b.forEach((t, i) => lut(`A2B${i}`, t));
  p.b2a.forEach((t, i) => lut(`B2A${i}`, t));
  lut('gamt', p.gamut);

  const b = new Bytes();
  b.zeros(128);
  b.u32(entries.length);
  const table = b.length;
  b.zeros(entries.length * 12);
  const written = new Map<object | string, [number, number]>();
  entries.forEach((e, i) => {
    let place = written.get(e.key);
    if (!place) {
      b.pad4();
      const at = b.length;
      e.write(b);
      place = [at, b.length - at];
      written.set(e.key, place);
    }
    const t = table + i * 12;
    for (let k = 0; k < 4; k++) b.view.setUint8(t + k, e.sig.charCodeAt(k));
    b.view.setUint32(t + 4, place[0]);
    b.view.setUint32(t + 8, place[1]);
  });
  b.pad4();
  const v = b.view;
  v.setUint32(0, b.length);
  v.setUint32(8, v4 ? 0x04300000 : 0x02100000);
  const sig = (at: number, s: string) => {
    for (let k = 0; k < 4; k++) v.setUint8(at + k, s.charCodeAt(k) || 0x20);
  };
  sig(12, p.deviceClass);
  sig(16, SPACE_SIG[p.colorSpace] ?? `${p.channels.toString(16).toUpperCase()}CLR`);
  sig(20, p.pcs === 'XYZ' ? 'XYZ ' : 'Lab ');
  const d = opts.date ?? new Date(Date.UTC(2026, 0, 1));
  [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].forEach(
    (n, i) => v.setUint16(24 + i * 2, n),
  );
  sig(36, 'acsp');
  v.setUint32(64, p.renderingIntent);
  D50.forEach((n, i) => v.setInt32(68 + i * 4, Math.round(n * 65536)));
  sig(80, 'PhSt');
  return b.bytes();
}
