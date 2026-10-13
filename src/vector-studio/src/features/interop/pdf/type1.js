/**
 * Type 1 font programs (FontFile): the clear-text part (built-in
 * encoding, FontMatrix), eexec decryption of the private part (Subrs and
 * CharStrings) and a Type 1 charstring interpreter for the outlines
 * (including flex, hint replacement and seac accents).
 */
import { STANDARD } from './encodings.js';

function decrypt(bytes, r, skip) {
  const out = new Uint8Array(Math.max(0, bytes.length - skip));
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    const p = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
    if (i >= skip) out[i - skip] = p;
  }
  return out;
}

const latin = (b, s = 0, e = b.length) => {
  let out = '';
  for (let i = s; i < e; i += 0x8000) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 0x8000)));
  return out;
};

function isHex(b, p) {
  for (let i = p; i < p + 4 && i < b.length; i++) {
    const c = b[i];
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

function hexToBytes(b, p) {
  const out = [];
  let hi = -1;
  for (let i = p; i < b.length; i++) {
    const c = b[i];
    let v = -1;
    if (c >= 48 && c <= 57) v = c - 48;
    else if (c >= 65 && c <= 70) v = c - 55;
    else if (c >= 97 && c <= 102) v = c - 87;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push((hi << 4) | v);
      hi = -1;
    }
  }
  return Uint8Array.from(out);
}

/** Parse a Type 1 font program (PFA/PFB-like data from a PDF FontFile stream). */
export function parseType1(bytes, { length1 = 0 } = {}) {
  let b = bytes;
  // PFB segments.
  if (b[0] === 0x80 && b[1] === 1) {
    const parts = [];
    let p = 0;
    while (p + 6 <= b.length && b[p] === 0x80 && b[p + 1] !== 3) {
      const len = b[p + 2] | (b[p + 3] << 8) | (b[p + 4] << 16) | (b[p + 5] << 24);
      parts.push(b.subarray(p + 6, p + 6 + len));
      if (!length1) length1 = len;
      p += 6 + len;
    }
    const n = parts.reduce((s, x) => s + x.length, 0);
    b = new Uint8Array(n);
    let o = 0;
    for (const x of parts) {
      b.set(x, o);
      o += x.length;
    }
  }
  let clearEnd = length1 > 0 && length1 < b.length ? length1 : -1;
  const head = latin(b, 0, clearEnd > 0 ? clearEnd : Math.min(b.length, 1 << 20));
  if (clearEnd < 0) {
    const i = head.indexOf('eexec');
    clearEnd = i >= 0 ? i + 5 : b.length;
  }
  const clear = head.slice(0, clearEnd);
  // Built-in encoding.
  const encoding = new Map();
  if (/\/Encoding\s+StandardEncoding/.test(clear)) STANDARD.forEach((n, c) => n && encoding.set(c, n));
  else {
    const re = /dup\s+(\d+)\s*\/([^\s{}\[\]()<>/%]+)\s+put/g;
    let m;
    while ((m = re.exec(clear))) encoding.set(Number(m[1]), m[2]);
  }
  const fm = /\/FontMatrix\s*\[([^\]]*)\]/.exec(clear);
  const matrix = fm ? fm[1].trim().split(/\s+/).map(Number) : [0.001, 0, 0, 0.001, 0, 0];
  // eexec part.
  let p = clearEnd;
  while (p < b.length && (b[p] === 13 || b[p] === 10 || b[p] === 32 || b[p] === 9)) p++;
  const enc = isHex(b, p) ? hexToBytes(b, p) : b.subarray(p);
  const priv = decrypt(enc, 55665, 4);
  const text = latin(priv);
  const lenIVm = /\/lenIV\s+(-?\d+)/.exec(text);
  const lenIV = lenIVm ? Number(lenIVm[1]) : 4;
  const subrs = [];
  const charStrings = new Map();
  // Binary tokens: "dup <i> <n> RD <bytes>" for Subrs and "/<name> <n> RD <bytes>" for CharStrings.
  const subrStart = text.search(/\/Subrs\s+\d+\s+array/);
  const csStart = text.indexOf('/CharStrings');
  const readBin = (start, end, keyRe, store) => {
    keyRe.lastIndex = start;
    let m;
    while ((m = keyRe.exec(text)) && m.index < end) {
      const len = Number(m[2]);
      const dataStart = m.index + m[0].length;
      const data = priv.subarray(dataStart, dataStart + len);
      store(m[1], lenIV >= 0 ? decrypt(data, 4330, lenIV) : data);
      keyRe.lastIndex = dataStart + len;
    }
  };
  if (subrStart >= 0) readBin(subrStart, csStart >= 0 && csStart > subrStart ? csStart : text.length, /dup\s+(\d+)\s+(\d+)\s+\S+ /g, (k, d) => (subrs[Number(k)] = d));
  if (csStart >= 0) readBin(csStart, text.length, /\/([^\s{}\[\]()<>/%]+)\s+(\d+)\s+\S+ /g, (k, d) => charStrings.set(k, d));
  const font = {
    matrix,
    encoding,
    charStrings,
    has: (name) => charStrings.has(name),
    glyphPath(name, depth = 0) {
      const cs = charStrings.get(name);
      if (!cs || depth > 4) return [];
      try {
        return runType1(cs, subrs, (code) => font.glyphPath(STANDARD[code], depth + 1));
      } catch {
        return [];
      }
    },
  };
  return font;
}

class End extends Error {}

function runType1(code, subrs, seac) {
  const out = [];
  const st = [];
  const ps = [];
  let x = 0;
  let y = 0;
  let sbx = 0;
  let open = false;
  let flex = null;
  const close = () => {
    if (open) out.push(['Z']);
    open = false;
  };
  const moveTo = (nx, ny) => {
    if (flex) {
      flex.push([nx, ny]);
      x = nx;
      y = ny;
      return;
    }
    close();
    x = nx;
    y = ny;
    out.push(['M', x, y]);
    open = true;
  };
  const lineTo = (nx, ny) => {
    x = nx;
    y = ny;
    out.push(['L', x, y]);
  };
  const curve = (a, b, c, d, e, f) => {
    out.push(['C', a, b, c, d, e, f]);
    x = e;
    y = f;
  };
  let depth = 0;
  const exec = (cs) => {
    if (++depth > 12) throw new Error('Too deep');
    for (let i = 0; i < cs.length; ) {
      const v = cs[i++];
      if (v >= 32) {
        if (v <= 246) st.push(v - 139);
        else if (v <= 250) st.push((v - 247) * 256 + cs[i++] + 108);
        else if (v <= 254) st.push(-(v - 251) * 256 - cs[i++] - 108);
        else {
          st.push((cs[i] << 24) | (cs[i + 1] << 16) | (cs[i + 2] << 8) | cs[i + 3]);
          i += 4;
        }
        continue;
      }
      switch (v) {
        case 13: // hsbw
          sbx = st[0];
          x = sbx;
          y = 0;
          st.length = 0;
          break;
        case 21:
          moveTo(x + st[0], y + st[1]);
          st.length = 0;
          break;
        case 22:
          moveTo(x + st[0], y);
          st.length = 0;
          break;
        case 4:
          moveTo(x, y + st[0]);
          st.length = 0;
          break;
        case 5:
          lineTo(x + st[0], y + st[1]);
          st.length = 0;
          break;
        case 6:
          lineTo(x + st[0], y);
          st.length = 0;
          break;
        case 7:
          lineTo(x, y + st[0]);
          st.length = 0;
          break;
        case 8: {
          const x1 = x + st[0];
          const y1 = y + st[1];
          const x2 = x1 + st[2];
          const y2 = y1 + st[3];
          curve(x1, y1, x2, y2, x2 + st[4], y2 + st[5]);
          st.length = 0;
          break;
        }
        case 30: {
          const x1 = x;
          const y1 = y + st[0];
          const x2 = x1 + st[1];
          const y2 = y1 + st[2];
          curve(x1, y1, x2, y2, x2 + st[3], y2);
          st.length = 0;
          break;
        }
        case 31: {
          const x1 = x + st[0];
          const y1 = y;
          const x2 = x1 + st[1];
          const y2 = y1 + st[2];
          curve(x1, y1, x2, y2, x2, y2 + st[3]);
          st.length = 0;
          break;
        }
        case 9:
          close();
          st.length = 0;
          break;
        case 10: {
          const n = st.pop();
          if (subrs[n]) exec(subrs[n]);
          break;
        }
        case 11:
          depth--;
          return;
        case 14:
          close();
          throw new End();
        case 1:
        case 3:
          st.length = 0;
          break;
        case 12: {
          const e = cs[i++];
          if (e === 6) {
            // seac: asb adx ady bchar achar
            const [asb, adx, ady, bchar, achar] = st;
            close();
            out.push(...seac(bchar));
            const dx = sbx - asb + adx;
            for (const cmd of seac(achar)) {
              const t = cmd.slice();
              for (let k = 1; k < t.length; k += 2) {
                t[k] += dx;
                t[k + 1] += ady;
              }
              out.push(t);
            }
            throw new End();
          } else if (e === 7) {
            // sbw
            sbx = st[0];
            x = st[0];
            y = st[1];
            st.length = 0;
          } else if (e === 12) {
            const b2 = st.pop();
            st.push(b2 ? st.pop() / b2 : 0);
          } else if (e === 16) {
            // callothersubr
            const n = st.pop();
            const count = st.pop();
            const args = st.splice(st.length - count, count);
            if (n === 1) {
              flex = [];
            } else if (n === 0 && flex) {
              // Flex: 7 points (reference + 6 control/end points).
              const pts = flex;
              flex = null;
              if (pts.length >= 7) {
                curve(pts[1][0], pts[1][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1]);
                curve(pts[4][0], pts[4][1], pts[5][0], pts[5][1], pts[6][0], pts[6][1]);
              }
              ps.push(args[2] ?? y, args[1] ?? x);
            } else if (n === 2) {
              // Collect a flex point (moveTo already stored it).
            } else if (n === 3) {
              ps.push(3);
            } else for (let k = args.length - 1; k >= 0; k--) ps.push(args[k]);
          } else if (e === 17) {
            st.push(ps.length ? ps.pop() : 0);
          } else if (e === 33) {
            x = st[0];
            y = st[1];
            st.length = 0;
          } else st.length = 0;
          break;
        }
        default:
          st.length = 0;
      }
    }
    depth--;
  };
  try {
    exec(code);
  } catch (err) {
    if (!(err instanceof End)) throw err;
  }
  close();
  return out;
}
