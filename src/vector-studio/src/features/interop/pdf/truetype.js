/**
 * TrueType and OpenType (sfnt) font programs: the tables needed to draw
 * glyph outlines from fonts embedded in PDF files (which are often
 * subsets missing most tables). Outlines come back as path commands in
 * font units: ['M', x, y] | ['L', x, y] | ['C', x1, y1, x2, y2, x, y] | ['Z'].
 */
import { parseCFF } from './cff.js';

export class SfntFont {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.tables = new Map();
    let off = 0;
    const tag = this.tag(0);
    if (tag === 'ttcf') off = this.dv.getUint32(12);
    const n = this.dv.getUint16(off + 4);
    for (let i = 0; i < n; i++) {
      const p = off + 12 + i * 16;
      if (p + 16 > bytes.length) break;
      const t = this.tag(p);
      const o = this.dv.getUint32(p + 8);
      const l = this.dv.getUint32(p + 12);
      if (o < bytes.length) this.tables.set(t, { offset: o, length: Math.min(l, bytes.length - o) });
    }
    const head = this.tables.get('head');
    this.unitsPerEm = head ? this.dv.getUint16(head.offset + 18) || 1000 : 1000;
    this.indexToLoc = head ? this.dv.getInt16(head.offset + 50) : 0;
    const maxp = this.tables.get('maxp');
    this.numGlyphs = maxp ? this.dv.getUint16(maxp.offset + 4) : 0;
    const cff = this.tables.get('CFF ');
    if (cff) {
      try {
        this.cff = parseCFF(bytes.subarray(cff.offset, cff.offset + cff.length));
      } catch {
        this.cff = null;
      }
    }
    this.cmaps = this.readCmaps();
    this.post = this.readPost();
  }

  tag(p) {
    return String.fromCharCode(this.b[p], this.b[p + 1], this.b[p + 2], this.b[p + 3]);
  }

  /** cmap subtables keyed "platform,encoding" -> Map(code -> gid). */
  readCmaps() {
    const out = new Map();
    const t = this.tables.get('cmap');
    if (!t) return out;
    const dv = this.dv;
    try {
      const n = dv.getUint16(t.offset + 2);
      for (let i = 0; i < n; i++) {
        const rec = t.offset + 4 + i * 8;
        const key = `${dv.getUint16(rec)},${dv.getUint16(rec + 2)}`;
        const sub = t.offset + dv.getUint32(rec + 4);
        const format = dv.getUint16(sub);
        const map = new Map();
        if (format === 0) {
          for (let c = 0; c < 256; c++) map.set(c, this.b[sub + 6 + c]);
        } else if (format === 4) {
          const segX2 = dv.getUint16(sub + 6);
          const ends = sub + 14;
          const starts = ends + segX2 + 2;
          const deltas = starts + segX2;
          const ranges = deltas + segX2;
          for (let s = 0; s < segX2 / 2; s++) {
            const end = dv.getUint16(ends + s * 2);
            const start = dv.getUint16(starts + s * 2);
            const delta = dv.getInt16(deltas + s * 2);
            const ro = dv.getUint16(ranges + s * 2);
            if (start > end || end - start > 0xffff) continue;
            for (let c = start; c <= end && c !== 0xffff; c++) {
              let g;
              if (!ro) g = (c + delta) & 0xffff;
              else {
                const p = ranges + s * 2 + ro + (c - start) * 2;
                if (p + 2 > this.b.length) continue;
                g = dv.getUint16(p);
                if (g) g = (g + delta) & 0xffff;
              }
              if (g) map.set(c, g);
            }
          }
        } else if (format === 6) {
          const first = dv.getUint16(sub + 6);
          const count = dv.getUint16(sub + 8);
          for (let k = 0; k < count; k++) map.set(first + k, dv.getUint16(sub + 10 + k * 2));
        } else if (format === 12) {
          const groups = dv.getUint32(sub + 12);
          for (let k = 0; k < groups && k < 100000; k++) {
            const p = sub + 16 + k * 12;
            const s = dv.getUint32(p);
            const e = dv.getUint32(p + 4);
            const g = dv.getUint32(p + 8);
            for (let c = s; c <= e && c - s < 65536; c++) map.set(c, g + (c - s));
          }
        } else continue;
        out.set(key, map);
      }
    } catch {
      /* damaged cmap */
    }
    return out;
  }

  /** Glyph names from a version 2 post table (name -> gid). */
  readPost() {
    const t = this.tables.get('post');
    const out = new Map();
    if (!t) return out;
    try {
      const dv = this.dv;
      if (dv.getUint32(t.offset) !== 0x20000) return out;
      const n = dv.getUint16(t.offset + 32);
      const idx = [];
      for (let i = 0; i < n; i++) idx.push(dv.getUint16(t.offset + 34 + i * 2));
      let p = t.offset + 34 + n * 2;
      const names = [];
      while (p < t.offset + t.length) {
        const len = this.b[p];
        let s = '';
        for (let k = 1; k <= len; k++) s += String.fromCharCode(this.b[p + k]);
        names.push(s);
        p += len + 1;
      }
      idx.forEach((ni, gid) => {
        if (ni >= 258 && names[ni - 258]) out.set(names[ni - 258], gid);
      });
    } catch {
      /* ignore */
    }
    return out;
  }

  cmap(platform, encoding) {
    return this.cmaps.get(`${platform},${encoding}`) || null;
  }

  glyphOffset(gid) {
    const loca = this.tables.get('loca');
    if (!loca) return null;
    const dv = this.dv;
    if (this.indexToLoc === 0) {
      const p = loca.offset + gid * 2;
      if (p + 4 > loca.offset + loca.length) return null;
      return [dv.getUint16(p) * 2, dv.getUint16(p + 2) * 2];
    }
    const p = loca.offset + gid * 4;
    if (p + 8 > loca.offset + loca.length) return null;
    return [dv.getUint32(p), dv.getUint32(p + 4)];
  }

  /** Outline of a glyph index in font units (y up). */
  glyphPath(gid, depth = 0) {
    if (this.cff) return this.cff.glyphPath(gid);
    const glyf = this.tables.get('glyf');
    const range = this.glyphOffset(gid);
    if (!glyf || !range || range[1] <= range[0]) return [];
    const dv = this.dv;
    const start = glyf.offset + range[0];
    if (start + 10 > this.b.length) return [];
    const nContours = dv.getInt16(start);
    if (nContours < 0) {
      if (depth > 6) return [];
      // Composite glyph.
      const out = [];
      let p = start + 10;
      for (;;) {
        const flags = dv.getUint16(p);
        const g = dv.getUint16(p + 2);
        p += 4;
        let dx;
        let dy;
        if (flags & 1) {
          dx = dv.getInt16(p);
          dy = dv.getInt16(p + 2);
          p += 4;
        } else {
          dx = dv.getInt8(p);
          dy = dv.getInt8(p + 1);
          p += 2;
        }
        let a = 1;
        let b = 0;
        let c = 0;
        let d = 1;
        const f2 = (q) => dv.getInt16(q) / 16384;
        if (flags & 8) {
          a = d = f2(p);
          p += 2;
        } else if (flags & 0x40) {
          a = f2(p);
          d = f2(p + 2);
          p += 4;
        } else if (flags & 0x80) {
          a = f2(p);
          b = f2(p + 2);
          c = f2(p + 4);
          d = f2(p + 6);
          p += 8;
        }
        // Point-matching placement (flags & 2 clear) is rare; treated as no offset.
        if (!(flags & 2)) {
          dx = 0;
          dy = 0;
        }
        for (const cmd of this.glyphPath(g, depth + 1)) {
          const t = cmd.slice();
          for (let i = 1; i < t.length; i += 2) {
            const x = t[i];
            const y = t[i + 1];
            t[i] = a * x + c * y + dx;
            t[i + 1] = b * x + d * y + dy;
          }
          out.push(t);
        }
        if (!(flags & 0x20)) break;
      }
      return out;
    }
    let p = start + 10;
    const ends = [];
    for (let i = 0; i < nContours; i++, p += 2) ends.push(dv.getUint16(p));
    const nPts = nContours ? ends[nContours - 1] + 1 : 0;
    const insLen = dv.getUint16(p);
    p += 2 + insLen;
    const flags = new Uint8Array(nPts);
    for (let i = 0; i < nPts; ) {
      const f = this.b[p++];
      flags[i++] = f;
      if (f & 8) {
        let rep = this.b[p++];
        while (rep-- > 0 && i < nPts) flags[i++] = f;
      }
    }
    const xs = new Array(nPts);
    const ys = new Array(nPts);
    let v = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 2) {
        const dx = this.b[p++];
        v += f & 16 ? dx : -dx;
      } else if (!(f & 16)) {
        v += dv.getInt16(p);
        p += 2;
      }
      xs[i] = v;
    }
    v = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 4) {
        const dy = this.b[p++];
        v += f & 32 ? dy : -dy;
      } else if (!(f & 32)) {
        v += dv.getInt16(p);
        p += 2;
      }
      ys[i] = v;
    }
    const out = [];
    let s = 0;
    for (const e of ends) {
      quadContour(out, xs.slice(s, e + 1), ys.slice(s, e + 1), Array.from(flags.subarray(s, e + 1), (f) => f & 1));
      s = e + 1;
    }
    return out;
  }
}

/** A closed TrueType contour (on/off-curve points) as cubic path commands. */
function quadContour(out, xs, ys, on) {
  const n = xs.length;
  if (!n) return;
  // Start at an on-curve point (or the midpoint of two off-curve points).
  let start = on.indexOf(1);
  let sx;
  let sy;
  if (start < 0) {
    sx = (xs[0] + xs[n - 1]) / 2;
    sy = (ys[0] + ys[n - 1]) / 2;
    start = 0;
  } else {
    sx = xs[start];
    sy = ys[start];
  }
  out.push(['M', sx, sy]);
  let cx = sx;
  let cy = sy;
  const firstOn = on[start] === 1;
  let ctrl = firstOn ? null : [xs[start], ys[start]];
  const quad = (qx, qy, x, y) => {
    out.push(['C', cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y]);
    cx = x;
    cy = y;
  };
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (k === n && !firstOn) {
      // Close back to the synthesized start.
      break;
    }
    const x = xs[i];
    const y = ys[i];
    if (on[i]) {
      if (ctrl) {
        quad(ctrl[0], ctrl[1], x, y);
        ctrl = null;
      } else if (k < n) {
        out.push(['L', x, y]);
        cx = x;
        cy = y;
      }
    } else if (ctrl) {
      const mx = (ctrl[0] + x) / 2;
      const my = (ctrl[1] + y) / 2;
      quad(ctrl[0], ctrl[1], mx, my);
      ctrl = [x, y];
    } else ctrl = [x, y];
  }
  if (ctrl) quad(ctrl[0], ctrl[1], sx, sy);
  out.push(['Z']);
}
