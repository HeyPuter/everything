// Minimal TrueType reader for text-to-shape conversion of the bundled fonts:
// WOFF 1.0 or raw TTF containers; tables head, hhea, maxp, hmtx, cmap
// (formats 4 and 12), loca, glyf (simple and composite), kern (format 0),
// GPOS pair adjustment (lookup types 2 and 9) and font variations
// (fvar, avar, gvar including phantom points for advances).
// References: OpenType 1.9 specification (Microsoft), WOFF 1.0 (W3C).
// CFF/CFF2 outlines and WOFF2 are not supported; GSUB (ligatures, small-caps
// glyphs) is not applied, so outlines use one glyph per character.

import { inflate } from 'pako';

export type GlyphPoint = { x: number; y: number; on: boolean };
export type GlyphOutline = { contours: GlyphPoint[][]; advance: number };
type Axis = { tag: string; min: number; def: number; max: number };
type Lookup = (left: number, right: number) => number | undefined;

export class SfntFont {
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number; // positive below the baseline
  readonly numGlyphs: number;
  readonly axes: Axis[];
  private tables = new Map<string, DataView>();
  private cmapLookup: (cp: number) => number;
  private advances: Uint16Array;
  private locaOffsets: Uint32Array;
  private kernPairs?: Map<number, number>;
  private gposLookups: Lookup[] = [];
  private avar?: [number, number][][];
  private glyphCache = new Map<string, GlyphOutline>();

  constructor(tables: Map<string, DataView>) {
    this.tables = tables;
    const head = this.need('head'), hhea = this.need('hhea'), maxp = this.need('maxp');
    this.unitsPerEm = head.getUint16(18);
    const longLoca = head.getInt16(50) === 1;
    this.ascent = hhea.getInt16(4);
    this.descent = -hhea.getInt16(6);
    this.numGlyphs = maxp.getUint16(4);
    const nh = hhea.getUint16(34);
    const hmtx = this.need('hmtx');
    this.advances = new Uint16Array(this.numGlyphs);
    for (let g = 0; g < this.numGlyphs; g++) this.advances[g] = hmtx.getUint16(Math.min(g, nh - 1) * 4);
    const loca = this.need('loca');
    this.locaOffsets = new Uint32Array(this.numGlyphs + 1);
    for (let g = 0; g <= this.numGlyphs; g++) this.locaOffsets[g] = longLoca ? loca.getUint32(g * 4) : loca.getUint16(g * 2) * 2;
    this.cmapLookup = parseCmap(this.need('cmap'));
    const kern = tables.get('kern');
    if (kern) this.kernPairs = parseKern(kern);
    const gpos = tables.get('GPOS');
    if (gpos) this.gposLookups = parseGposKerning(gpos);
    this.axes = [];
    const fvar = tables.get('fvar');
    if (fvar) {
      const off = fvar.getUint16(4), count = fvar.getUint16(8), size = fvar.getUint16(10);
      for (let i = 0; i < count; i++) {
        const o = off + i * size;
        this.axes.push({ tag: tag(fvar, o), min: fixed(fvar, o + 4), def: fixed(fvar, o + 8), max: fixed(fvar, o + 12) });
      }
      const avar = tables.get('avar');
      if (avar) {
        this.avar = [];
        let o = 8;
        for (let a = 0; a < avar.getUint16(6); a++) {
          const n = avar.getUint16(o);
          const segs: [number, number][] = [];
          for (let k = 0; k < n; k++) segs.push([f2dot14(avar, o + 2 + k * 4), f2dot14(avar, o + 4 + k * 4)]);
          this.avar.push(segs);
          o += 2 + n * 4;
        }
      }
    }
  }
  private need(name: string): DataView {
    const t = this.tables.get(name);
    if (!t) throw new Error(`Font is missing the ${name} table.`);
    return t;
  }

  glyphIndex(codePoint: number): number { return this.cmapLookup(codePoint); }
  hasGlyph(codePoint: number) { return this.cmapLookup(codePoint) !== 0; }
  /** Every code point the chosen cmap subtable maps to a glyph, ascending. */
  codePoints(): number[] { return cmapCodePoints(this.need('cmap')); }
  /** GSUB feature tags present in the font (deduplicated, sorted). */
  gsubFeatures(): string[] {
    const gsub = this.tables.get('GSUB');
    return gsub ? layoutFeatureTags(gsub) : [];
  }
  /** Raw table data by tag (decompressed). */
  table(name: string): DataView | undefined { return this.tables.get(name); }

  // Normalized design coordinates for axis values like { wght: 700 }.
  normalize(values: Record<string, number>): number[] {
    return this.axes.map((a, i) => {
      const v = Math.min(a.max, Math.max(a.min, values[a.tag] ?? a.def));
      let n = v < a.def ? (v - a.def) / (a.def - a.min || 1) : v > a.def ? (v - a.def) / (a.max - a.def || 1) : 0;
      const segs = this.avar?.[i];
      if (segs && segs.length) {
        for (let k = 1; k < segs.length; k++) {
          const [f0, t0] = segs[k - 1], [f1, t1] = segs[k];
          if (n <= f1) { n = f1 === f0 ? t1 : t0 + ((n - f0) * (t1 - t0)) / (f1 - f0); break; }
        }
      }
      return n;
    });
  }

  // Outline in font units (y up) at the given normalized coordinates.
  glyph(gid: number, coords: number[] = []): GlyphOutline {
    const key = `${gid}|${coords.join(',')}`;
    let g = this.glyphCache.get(key);
    if (!g) this.glyphCache.set(key, (g = this.readGlyph(gid, coords, 0)));
    return g;
  }
  advance(gid: number, coords: number[] = []): number {
    if (!coords.some((c) => c) || !this.tables.has('gvar')) return this.advances[gid] ?? 0;
    return this.glyph(gid, coords).advance;
  }
  kerning(left: number, right: number): number {
    for (const l of this.gposLookups) {
      const v = l(left, right);
      if (v !== undefined) return v;
    }
    return this.kernPairs?.get(left * 65536 + right) ?? 0;
  }

  private readGlyph(gid: number, coords: number[], depth: number): GlyphOutline {
    const glyf = this.need('glyf');
    const start = this.locaOffsets[gid], end = this.locaOffsets[gid + 1];
    const adv = this.advances[gid] ?? 0;
    if (gid >= this.numGlyphs) return { contours: [], advance: 0 };
    if (end <= start || depth > 8) return this.applyAdvanceDelta(gid, { contours: [], advance: adv }, coords, 0);
    const nContours = glyf.getInt16(start);
    if (nContours >= 0) {
      const pts = parseSimple(glyf, start, nContours);
      const flat = pts.flat();
      const deltas = this.variationDeltas(gid, coords, flat.length, pts.map((c) => c.length));
      if (deltas) {
        flat.forEach((p, i) => { p.x += deltas.x[i]; p.y += deltas.y[i]; });
        return { contours: pts, advance: adv + deltas.x[flat.length + 1] - deltas.x[flat.length] };
      }
      return { contours: pts, advance: adv };
    }
    // Composite: components are placed by offsets that may themselves vary.
    const comps = parseComposite(glyf, start + 10);
    const deltas = this.variationDeltas(gid, coords, comps.length, null);
    const contours: GlyphPoint[][] = [];
    let advance = adv;
    comps.forEach((c, i) => {
      const sub = this.readGlyph(c.glyph, coords, depth + 1);
      const dx = c.dx + (deltas ? deltas.x[i] : 0), dy = c.dy + (deltas ? deltas.y[i] : 0);
      for (const contour of sub.contours)
        contours.push(contour.map((p) => ({ x: c.m[0] * p.x + c.m[2] * p.y + dx, y: c.m[1] * p.x + c.m[3] * p.y + dy, on: p.on })));
      if (c.useMetrics) advance = sub.advance;
    });
    if (deltas && !comps.some((c) => c.useMetrics)) advance = adv + deltas.x[comps.length + 1] - deltas.x[comps.length];
    return { contours, advance };
  }
  private applyAdvanceDelta(gid: number, g: GlyphOutline, coords: number[], n: number): GlyphOutline {
    const d = this.variationDeltas(gid, coords, n, []);
    if (d) g.advance += d.x[n + 1] - d.x[n];
    return g;
  }

  // gvar deltas for n outline points plus four phantom points; `contourSizes`
  // drives interpolation of untouched points (null for composites).
  private variationDeltas(gid: number, coords: number[], n: number, contourSizes: number[] | null): { x: Float64Array; y: Float64Array } | undefined {
    const gvar = this.tables.get('gvar');
    if (!gvar || !coords.some((c) => c)) return undefined;
    const axisCount = gvar.getUint16(4), sharedCount = gvar.getUint16(6), sharedOff = gvar.getUint32(8);
    const longOffsets = (gvar.getUint16(14) & 1) === 1, dataBase = gvar.getUint32(16);
    const off = (i: number) => (longOffsets ? gvar.getUint32(20 + i * 4) : gvar.getUint16(20 + i * 2) * 2);
    const g0 = off(gid), g1 = off(gid + 1);
    if (g1 <= g0) return undefined;
    const base = dataBase + g0;
    const total = n + 4;
    const dx = new Float64Array(total), dy = new Float64Array(total);
    const countWord = gvar.getUint16(base);
    const tupleCount = countWord & 0x0fff;
    let ser = base + gvar.getUint16(base + 2);
    let sharedPoints: number[] | null = null;
    if (countWord & 0x8000) [sharedPoints, ser] = readPoints(gvar, ser, total);
    let hdr = base + 4;
    for (let t = 0; t < tupleCount; t++) {
      const size = gvar.getUint16(hdr), index = gvar.getUint16(hdr + 2);
      hdr += 4;
      let peak: number[];
      if (index & 0x8000) {
        peak = [];
        for (let a = 0; a < axisCount; a++) peak.push(f2dot14(gvar, hdr + a * 2));
        hdr += axisCount * 2;
      } else {
        const p = sharedOff + (index & 0x0fff) * axisCount * 2;
        peak = [];
        if ((index & 0x0fff) < sharedCount) for (let a = 0; a < axisCount; a++) peak.push(f2dot14(gvar, p + a * 2));
      }
      let startT: number[] | null = null, endT: number[] | null = null;
      if (index & 0x4000) {
        startT = []; endT = [];
        for (let a = 0; a < axisCount; a++) startT.push(f2dot14(gvar, hdr + a * 2));
        hdr += axisCount * 2;
        for (let a = 0; a < axisCount; a++) endT.push(f2dot14(gvar, hdr + a * 2));
        hdr += axisCount * 2;
      }
      const scalar = tupleScalar(peak, startT, endT, coords);
      const next = ser + size;
      if (scalar !== 0) {
        let p = ser;
        let points: number[] | null = sharedPoints;
        if (index & 0x2000) [points, p] = readPoints(gvar, p, total);
        const count = points ? points.length : total;
        let xs: number[], ys: number[];
        [xs, p] = readDeltas(gvar, p, count);
        [ys, p] = readDeltas(gvar, p, count);
        if (!points) for (let i = 0; i < total; i++) { dx[i] += xs[i] * scalar; dy[i] += ys[i] * scalar; }
        else if (contourSizes === null || points.length === total) points.forEach((pi, k) => { if (pi < total) { dx[pi] += xs[k] * scalar; dy[pi] += ys[k] * scalar; } });
        else this.interpolate(gid, contourSizes, points, xs, ys, scalar, dx, dy, n);
      }
      ser = next;
    }
    return { x: dx, y: dy };
  }

  // IUP: untouched points move with their touched neighbours on the contour,
  // interpolated (or shifted) per axis from the original coordinates.
  private interpolate(gid: number, sizes: number[], points: number[], xs: number[], ys: number[], scalar: number, dx: Float64Array, dy: Float64Array, n: number) {
    const glyf = this.need('glyf');
    const orig = n ? parseSimple(glyf, this.locaOffsets[gid], sizes.length).flat() : [];
    const tx = new Float64Array(n), ty = new Float64Array(n), touched = new Uint8Array(n);
    points.forEach((pi, k) => {
      if (pi < n) { tx[pi] = xs[k]; ty[pi] = ys[k]; touched[pi] = 1; }
      else if (pi < n + 4) { dx[pi] += xs[k] * scalar; dy[pi] += ys[k] * scalar; }
    });
    let s = 0;
    for (const len of sizes) {
      const idx: number[] = [];
      for (let i = s; i < s + len; i++) if (touched[i]) idx.push(i);
      if (idx.length) {
        for (let i = s; i < s + len; i++) {
          if (touched[i]) continue;
          // Nearest touched points before and after i around the contour.
          let prev = idx[idx.length - 1], next = idx[0];
          for (const t of idx) { if (t < i) prev = t; }
          for (const t of idx) { if (t > i) { next = t; break; } }
          tx[i] = iup(orig[i].x, orig[prev].x, orig[next].x, tx[prev], tx[next]);
          ty[i] = iup(orig[i].y, orig[prev].y, orig[next].y, ty[prev], ty[next]);
        }
        for (let i = s; i < s + len; i++) { dx[i] += tx[i] * scalar; dy[i] += ty[i] * scalar; }
      }
      s += len;
    }
  }
}

function iup(v: number, a: number, b: number, da: number, db: number): number {
  if (a === b) return da === db ? da : 0;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const dlo = a < b ? da : db, dhi = a < b ? db : da;
  if (v <= lo) return dlo;
  if (v >= hi) return dhi;
  return dlo + ((v - lo) * (dhi - dlo)) / (hi - lo);
}

function tupleScalar(peak: number[], start: number[] | null, end: number[] | null, coords: number[]): number {
  let s = 1;
  for (let a = 0; a < peak.length; a++) {
    const p = peak[a], c = coords[a] ?? 0;
    if (p === 0) continue;
    if (c === 0) return 0;
    if (start && end) {
      const lo = start[a], hi = end[a];
      if (lo > p || p > hi || (lo < 0 && hi > 0)) continue;
      if (c < lo || c > hi) return 0;
      s *= c < p ? (c - lo) / (p - lo) : c > p ? (hi - c) / (hi - p) : 1;
    } else {
      if (c === p) continue;
      // Implicit region runs from 0 to the peak.
      if (c < Math.min(0, p) || c > Math.max(0, p)) return 0;
      s *= c / p;
    }
  }
  return s;
}

function readPoints(v: DataView, p: number, total: number): [number[] | null, number] {
  let count = v.getUint8(p++);
  if (count & 0x80) count = ((count & 0x7f) << 8) | v.getUint8(p++);
  if (count === 0) return [null, p];
  const out: number[] = [];
  let last = 0;
  while (out.length < count) {
    const ctl = v.getUint8(p++);
    const run = (ctl & 0x7f) + 1;
    const words = (ctl & 0x80) !== 0;
    for (let k = 0; k < run && out.length < count; k++) {
      last += words ? v.getUint16(p) : v.getUint8(p);
      p += words ? 2 : 1;
      out.push(last);
    }
  }
  void total;
  return [out, p];
}
function readDeltas(v: DataView, p: number, count: number): [number[], number] {
  const out: number[] = [];
  while (out.length < count) {
    const ctl = v.getUint8(p++);
    const run = (ctl & 0x3f) + 1;
    for (let k = 0; k < run && out.length < count; k++) {
      if (ctl & 0x80) out.push(0);
      else if (ctl & 0x40) { out.push(v.getInt16(p)); p += 2; }
      else { out.push(v.getInt8(p)); p += 1; }
    }
  }
  return [out, p];
}

function parseSimple(v: DataView, start: number, nContours: number): GlyphPoint[][] {
  const ends: number[] = [];
  let p = start + 10;
  for (let i = 0; i < nContours; i++) { ends.push(v.getUint16(p)); p += 2; }
  const n = nContours ? ends[nContours - 1] + 1 : 0;
  p += 2 + v.getUint16(p); // skip instructions
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; ) {
    const f = v.getUint8(p++);
    flags[i++] = f;
    if (f & 8) { let r = v.getUint8(p++); while (r-- > 0 && i < n) flags[i++] = f; }
  }
  const xs = new Int32Array(n), ys = new Int32Array(n);
  let x = 0;
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if (f & 2) { const d = v.getUint8(p++); x += f & 16 ? d : -d; }
    else if (!(f & 16)) { x += v.getInt16(p); p += 2; }
    xs[i] = x;
  }
  let y = 0;
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if (f & 4) { const d = v.getUint8(p++); y += f & 32 ? d : -d; }
    else if (!(f & 32)) { y += v.getInt16(p); p += 2; }
    ys[i] = y;
  }
  const out: GlyphPoint[][] = [];
  let s = 0;
  for (const e of ends) {
    const c: GlyphPoint[] = [];
    for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
    out.push(c);
    s = e + 1;
  }
  return out;
}

type Component = { glyph: number; dx: number; dy: number; m: [number, number, number, number]; useMetrics: boolean };
function parseComposite(v: DataView, p: number): Component[] {
  const out: Component[] = [];
  for (;;) {
    const flags = v.getUint16(p), glyph = v.getUint16(p + 2);
    p += 4;
    let a: number, b: number;
    if (flags & 1) { a = flags & 2 ? v.getInt16(p) : v.getUint16(p); b = flags & 2 ? v.getInt16(p + 2) : v.getUint16(p + 2); p += 4; }
    else { a = flags & 2 ? v.getInt8(p) : v.getUint8(p); b = flags & 2 ? v.getInt8(p + 1) : v.getUint8(p + 1); p += 2; }
    let m: [number, number, number, number] = [1, 0, 0, 1];
    if (flags & 8) { const s = f2dot14(v, p); m = [s, 0, 0, s]; p += 2; }
    else if (flags & 0x40) { m = [f2dot14(v, p), 0, 0, f2dot14(v, p + 2)]; p += 4; }
    else if (flags & 0x80) { m = [f2dot14(v, p), f2dot14(v, p + 2), f2dot14(v, p + 4), f2dot14(v, p + 6)]; p += 8; }
    // Point-matching placement (args are point indices) is rare; treat as no offset.
    out.push({ glyph, dx: flags & 2 ? a : 0, dy: flags & 2 ? b : 0, m, useMetrics: (flags & 0x200) !== 0 });
    if (!(flags & 0x20)) break;
  }
  return out;
}

// Offset of the preferred cmap subtable (format 12, else Unicode format 4), or -1.
function bestCmapSubtable(v: DataView): number {
  const n = v.getUint16(2);
  let best = -1, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const pid = v.getUint16(4 + i * 8), eid = v.getUint16(6 + i * 8), off = v.getUint32(8 + i * 8);
    const fmt = v.getUint16(off);
    const score = fmt === 12 ? 3 : fmt === 4 && (pid === 3 || pid === 0) ? (eid === 1 || pid === 0 ? 2 : 1) : 0;
    if (score > bestScore) { bestScore = score; best = off; }
  }
  return bestScore > 0 ? best : -1;
}

function cmapCodePoints(v: DataView): number[] {
  const off = bestCmapSubtable(v);
  if (off < 0) return [];
  const lookup = parseCmap(v);
  const out: number[] = [];
  if (v.getUint16(off) === 12) {
    const groups = v.getUint32(off + 12);
    for (let i = 0; i < groups; i++) {
      const g = off + 16 + i * 12;
      const s = v.getUint32(g), e = Math.min(v.getUint32(g + 4), 0x10ffff);
      for (let cp = s; cp <= e; cp++) if (v.getUint32(g + 8) + cp - s !== 0) out.push(cp);
    }
    return out;
  }
  const segX2 = v.getUint16(off + 6), ends = off + 14, starts = ends + segX2 + 2;
  for (let i = 0; i < segX2 / 2; i++) {
    const s = v.getUint16(starts + i * 2), e = v.getUint16(ends + i * 2);
    if (s === 0xffff) continue;
    for (let cp = s; cp <= e; cp++) if (lookup(cp)) out.push(cp);
  }
  return out;
}

/** Feature tags of a GSUB or GPOS table's FeatureList (deduplicated, sorted). */
export function layoutFeatureTags(v: DataView): string[] {
  const fl = v.getUint16(6);
  const tags = new Set<string>();
  for (let i = 0; i < v.getUint16(fl); i++) tags.add(tag(v, fl + 2 + i * 6));
  return [...tags].sort();
}

/** UI name IDs of a GSUB table's stylistic sets (ss01–ss20 FeatureParams). */
export function stylisticSetNameIds(v: DataView): Map<string, number> {
  const out = new Map<string, number>();
  const fl = v.getUint16(6);
  for (let i = 0; i < v.getUint16(fl); i++) {
    const rec = fl + 2 + i * 6;
    const t = tag(v, rec);
    if (!/^ss(0[1-9]|1\d|20)$/.test(t) || out.has(t)) continue;
    const feature = fl + v.getUint16(rec + 4);
    const params = v.getUint16(feature);
    if (!params || feature + params + 4 > v.byteLength) continue;
    // FeatureParams for stylistic sets: version 0, then the UI name ID.
    if (v.getUint16(feature + params) !== 0) continue;
    out.set(t, v.getUint16(feature + params + 2));
  }
  return out;
}
/** A string of a `name` table by ID: Windows English first, then any Windows
 * or Unicode record, then a Macintosh Roman one. */
export function nameString(v: DataView, id: number): string | undefined {
  const count = v.getUint16(2),
    strings = v.getUint16(4);
  let best: { rank: number; text: string } | undefined;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    if (o + 12 > v.byteLength) break;
    const platform = v.getUint16(o),
      language = v.getUint16(o + 4);
    if (v.getUint16(o + 6) !== id) continue;
    const length = v.getUint16(o + 8),
      start = strings + v.getUint16(o + 10);
    if (start + length > v.byteLength) continue;
    const rank = platform === 3 && language === 0x409 ? 0 : platform === 3 || platform === 0 ? 1 : platform === 1 ? 2 : 3;
    if (rank > 2 || (best && best.rank <= rank)) continue;
    let text = '';
    if (rank < 2) for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(v.getUint16(start + k));
    else for (let k = 0; k < length; k++) text += String.fromCharCode(v.getUint8(start + k));
    if (text.trim()) best = { rank, text: text.trim() };
  }
  return best?.text;
}

function parseCmap(v: DataView): (cp: number) => number {
  const off = bestCmapSubtable(v);
  if (off < 0) return () => 0;
  if (v.getUint16(off) === 12) {
    const groups = v.getUint32(off + 12);
    return (cp) => {
      let lo = 0, hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, g = off + 16 + mid * 12;
        const s = v.getUint32(g), e = v.getUint32(g + 4);
        if (cp < s) hi = mid - 1;
        else if (cp > e) lo = mid + 1;
        else return v.getUint32(g + 8) + cp - s;
      }
      return 0;
    };
  }
  const segX2 = v.getUint16(off + 6), ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    let lo = 0, hi = segX2 / 2 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const end = v.getUint16(ends + mid * 2);
      const st = v.getUint16(starts + mid * 2);
      if (cp > end) lo = mid + 1;
      else if (cp < st) hi = mid - 1;
      else {
        const delta = v.getInt16(deltas + mid * 2), ro = v.getUint16(ranges + mid * 2);
        if (!ro) return (cp + delta) & 0xffff;
        const gi = v.getUint16(ranges + mid * 2 + ro + (cp - st) * 2);
        return gi ? (gi + delta) & 0xffff : 0;
      }
    }
    return 0;
  };
}

function parseKern(v: DataView): Map<number, number> {
  const out = new Map<number, number>();
  if (v.getUint16(0) !== 0) return out;
  let p = 4;
  for (let t = 0; t < v.getUint16(2); t++) {
    const len = v.getUint16(p + 2), cov = v.getUint16(p + 4);
    if (cov >> 8 === 0 && (cov & 1)) {
      const n = v.getUint16(p + 6);
      for (let i = 0; i < n; i++) {
        const q = p + 14 + i * 6;
        out.set(v.getUint16(q) * 65536 + v.getUint16(q + 2), v.getInt16(q + 4));
      }
    }
    p += len;
  }
  return out;
}

function coverage(v: DataView, off: number): (g: number) => number {
  const fmt = v.getUint16(off), n = v.getUint16(off + 2);
  if (fmt === 1) return (g) => {
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, x = v.getUint16(off + 4 + mid * 2);
      if (x === g) return mid;
      if (x < g) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  };
  return (g) => {
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, r = off + 4 + mid * 6;
      const s = v.getUint16(r), e = v.getUint16(r + 2);
      if (g < s) hi = mid - 1;
      else if (g > e) lo = mid + 1;
      else return v.getUint16(r + 4) + g - s;
    }
    return -1;
  };
}
function classDef(v: DataView, off: number): (g: number) => number {
  const fmt = v.getUint16(off);
  if (fmt === 1) {
    const first = v.getUint16(off + 2), n = v.getUint16(off + 4);
    return (g) => (g >= first && g < first + n ? v.getUint16(off + 6 + (g - first) * 2) : 0);
  }
  const n = v.getUint16(off + 2);
  return (g) => {
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, r = off + 4 + mid * 6;
      const s = v.getUint16(r), e = v.getUint16(r + 2);
      if (g < s) hi = mid - 1;
      else if (g > e) lo = mid + 1;
      else return v.getUint16(r + 4);
    }
    return 0;
  };
}
const bitCount = (x: number) => { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };
// X advance adjustment of a value record (0 when the format has none).
function xAdvance(v: DataView, p: number, fmt: number): number {
  if (!(fmt & 4)) return 0;
  return v.getInt16(p + bitCount(fmt & 3) * 2);
}

// Pair-positioning lookups referenced by any 'kern' feature.
function parseGposKerning(v: DataView): Lookup[] {
  const featureList = v.getUint16(6), lookupList = v.getUint16(8);
  const lookupIdx = new Set<number>();
  const nf = v.getUint16(featureList);
  for (let i = 0; i < nf; i++) {
    const r = featureList + 2 + i * 6;
    if (tag(v, r) !== 'kern') continue;
    const f = featureList + v.getUint16(r + 4);
    for (let k = 0; k < v.getUint16(f + 2); k++) lookupIdx.add(v.getUint16(f + 4 + k * 2));
  }
  const out: Lookup[] = [];
  for (const li of [...lookupIdx].sort((a, b) => a - b)) {
    const l = lookupList + v.getUint16(lookupList + 2 + li * 2);
    let type = v.getUint16(l);
    const subs: number[] = [];
    for (let s = 0; s < v.getUint16(l + 4); s++) subs.push(l + v.getUint16(l + 6 + s * 2));
    const pairSubs: number[] = [];
    for (let st of subs) {
      if (type === 9) { const t = v.getUint16(st + 2); st = st + v.getUint32(st + 4); if (t !== 2) continue; }
      else if (type !== 2) continue;
      pairSubs.push(st);
    }
    if (type === 9) type = 2;
    const fns = pairSubs.map((st) => pairSubtable(v, st));
    out.push((a, b) => {
      for (const f of fns) {
        const r = f(a, b);
        if (r !== undefined) return r;
      }
      return undefined;
    });
  }
  return out;
}
function pairSubtable(v: DataView, st: number): Lookup {
  const fmt = v.getUint16(st), cov = coverage(v, st + v.getUint16(st + 2));
  const vf1 = v.getUint16(st + 4), vf2 = v.getUint16(st + 6);
  const s1 = bitCount(vf1) * 2, s2 = bitCount(vf2) * 2;
  if (fmt === 1) {
    return (a, b) => {
      const ci = cov(a);
      if (ci < 0) return undefined;
      const ps = st + v.getUint16(st + 10 + ci * 2);
      const n = v.getUint16(ps), rec = 2 + s1 + s2;
      let lo = 0, hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, r = ps + 2 + mid * rec;
        const g = v.getUint16(r);
        if (g === b) return xAdvance(v, r + 2, vf1);
        if (g < b) lo = mid + 1; else hi = mid - 1;
      }
      return undefined;
    };
  }
  const cd1 = classDef(v, st + v.getUint16(st + 8)), cd2 = classDef(v, st + v.getUint16(st + 10));
  const c2n = v.getUint16(st + 14);
  return (a, b) => {
    if (cov(a) < 0) return undefined;
    const r = st + 16 + (cd1(a) * c2n + cd2(b)) * (s1 + s2);
    return xAdvance(v, r, vf1);
  };
}

const tag = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
const fixed = (v: DataView, o: number) => v.getInt32(o) / 65536;
const f2dot14 = (v: DataView, o: number) => v.getInt16(o) / 16384;

// Decompressed tables of a WOFF 1.0 or TrueType font file, by tag.
export function fontTables(input: ArrayBuffer | Uint8Array): Map<string, DataView> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = tag(v, 0);
  const tables = new Map<string, DataView>();
  if (sig === 'wOFF') {
    const n = v.getUint16(12);
    for (let i = 0; i < n; i++) {
      const r = 44 + i * 20;
      const t = tag(v, r), off = v.getUint32(r + 4), comp = v.getUint32(r + 8), orig = v.getUint32(r + 12);
      const raw = bytes.subarray(off, off + comp);
      const data = comp < orig ? inflate(raw) : raw.slice();
      tables.set(t, new DataView(data.buffer, data.byteOffset, data.byteLength));
    }
  } else if (sig === 'wOF2') {
    throw new Error('WOFF2 fonts cannot be read for outlines; use the WOFF or TTF file.');
  } else if (sig === 'OTTO') {
    throw new Error('CFF-flavoured OpenType fonts are not supported for outlines.');
  } else if (v.getUint32(0) === 0x00010000 || sig === 'true') {
    const n = v.getUint16(4);
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      const off = v.getUint32(r + 8), len = v.getUint32(r + 12);
      tables.set(tag(v, r), new DataView(bytes.buffer, bytes.byteOffset + off, len));
    }
  } else throw new Error('Unrecognized font file.');
  return tables;
}

// Parses a WOFF 1.0 or TrueType font file.
export function parseFont(input: ArrayBuffer | Uint8Array): SfntFont {
  return new SfntFont(fontTables(input));
}
