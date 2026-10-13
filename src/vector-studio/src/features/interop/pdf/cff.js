/**
 * CFF (Compact Font Format) font programs, as embedded in PDF files
 * (FontFile3 /Type1C and /CIDFontType0C, or inside OpenType): INDEX and
 * DICT structures, charsets, encodings, CID-keyed fonts (FDArray and
 * FDSelect) and a Type 2 charstring interpreter for the outlines.
 */
import { STANDARD } from './encodings.js';

// Standard strings 0..228 (the rest of the 391 are rarely used as glyph names).
const STD_STRINGS = ['.notdef', 'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quoteright', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash',
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less', 'equal', 'greater', 'question', 'at',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore', 'quoteleft',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'braceleft', 'bar', 'braceright', 'asciitilde',
  'exclamdown', 'cent', 'sterling', 'fraction', 'yen', 'florin', 'section', 'currency', 'quotesingle', 'quotedblleft', 'guillemotleft', 'guilsinglleft', 'guilsinglright', 'fi', 'fl', 'endash', 'dagger', 'daggerdbl',
  'periodcentered', 'paragraph', 'bullet', 'quotesinglbase', 'quotedblbase', 'quotedblright', 'guillemotright', 'ellipsis', 'perthousand', 'questiondown', 'grave', 'acute', 'circumflex', 'tilde', 'macron', 'breve',
  'dotaccent', 'dieresis', 'ring', 'cedilla', 'hungarumlaut', 'ogonek', 'caron', 'emdash', 'AE', 'ordfeminine', 'Lslash', 'Oslash', 'OE', 'ordmasculine', 'ae', 'dotlessi', 'lslash', 'oslash', 'oe', 'germandbls',
  'onesuperior', 'logicalnot', 'mu', 'trademark', 'Eth', 'onehalf', 'plusminus', 'Thorn', 'onequarter', 'divide', 'brokenbar', 'degree', 'thorn', 'threequarters', 'twosuperior', 'registered', 'minus', 'eth',
  'multiply', 'threesuperior', 'copyright', 'Aacute', 'Acircumflex', 'Adieresis', 'Agrave', 'Aring', 'Atilde', 'Ccedilla', 'Eacute', 'Ecircumflex', 'Edieresis', 'Egrave', 'Iacute', 'Icircumflex', 'Idieresis',
  'Igrave', 'Ntilde', 'Oacute', 'Ocircumflex', 'Odieresis', 'Ograve', 'Otilde', 'Scaron', 'Uacute', 'Ucircumflex', 'Udieresis', 'Ugrave', 'Yacute', 'Ydieresis', 'Zcaron', 'aacute', 'acircumflex', 'adieresis',
  'agrave', 'aring', 'atilde', 'ccedilla', 'eacute', 'ecircumflex', 'edieresis', 'egrave', 'iacute', 'icircumflex', 'idieresis', 'igrave', 'ntilde', 'oacute', 'ocircumflex', 'odieresis', 'ograve', 'otilde',
  'scaron', 'uacute', 'ucircumflex', 'udieresis', 'ugrave', 'yacute', 'ydieresis', 'zcaron'];

function readIndex(b, p) {
  const count = (b[p] << 8) | b[p + 1];
  if (!count) return { items: [], end: p + 2 };
  const offSize = b[p + 2];
  const offs = [];
  let q = p + 3;
  for (let i = 0; i <= count; i++) {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = v * 256 + b[q++];
    offs.push(v);
  }
  const base = q - 1;
  const items = [];
  for (let i = 0; i < count; i++) items.push(b.subarray(base + offs[i], base + offs[i + 1]));
  return { items, end: base + offs[count] };
}

function readDict(b) {
  const out = new Map();
  const ops = [];
  for (let i = 0; i < b.length; ) {
    const c = b[i];
    if (c <= 21) {
      let op = c;
      i++;
      if (c === 12) op = 1200 + b[i++];
      out.set(op, ops.splice(0));
    } else if (c === 28) {
      ops.push(((b[i + 1] << 24) >> 16) | b[i + 2]);
      i += 3;
    } else if (c === 29) {
      ops.push((b[i + 1] << 24) | (b[i + 2] << 16) | (b[i + 3] << 8) | b[i + 4]);
      i += 5;
    } else if (c === 30) {
      let s = '';
      i++;
      const nib = '0123456789.EE?-';
      outer: for (;;) {
        const v = b[i++];
        for (const n of [v >> 4, v & 15]) {
          if (n === 15) break outer;
          s += n === 12 ? 'E-' : nib[n];
        }
      }
      ops.push(parseFloat(s) || 0);
    } else if (c >= 32 && c <= 246) {
      ops.push(c - 139);
      i++;
    } else if (c >= 247 && c <= 250) {
      ops.push((c - 247) * 256 + b[i + 1] + 108);
      i += 2;
    } else if (c >= 251 && c <= 254) {
      ops.push(-(c - 251) * 256 - b[i + 1] - 108);
      i += 2;
    } else i++;
  }
  return out;
}

const bias = (n) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

export function parseCFF(bytes) {
  const b = bytes;
  const hdrSize = b[2];
  const names = readIndex(b, hdrSize);
  const tops = readIndex(b, names.end);
  const strings = readIndex(b, tops.end);
  const gsubrs = readIndex(b, strings.end);
  const top = readDict(tops.items[0] || new Uint8Array(0));
  const str = (sid) => {
    if (sid < STD_STRINGS.length) return STD_STRINGS[sid];
    if (sid >= 391) {
      const s = strings.items[sid - 391];
      return s ? String.fromCharCode(...s) : '';
    }
    return `sid${sid}`;
  };
  const csOff = top.get(17)?.[0];
  if (!csOff) throw new Error('No CharStrings');
  const charStrings = readIndex(b, csOff).items;
  const nGlyphs = charStrings.length;
  const isCID = top.has(1230);
  const privOf = (dict) => {
    const pr = dict.get(18);
    if (!pr || pr.length < 2) return { subrs: [], defaultWidthX: 0, nominalWidthX: 0 };
    const [size, off] = pr;
    const pd = readDict(b.subarray(off, off + size));
    const so = pd.get(19)?.[0];
    return { subrs: so ? readIndex(b, off + so).items : [], defaultWidthX: pd.get(20)?.[0] || 0, nominalWidthX: pd.get(21)?.[0] || 0 };
  };
  // charset: gid -> SID (or CID for CID-keyed fonts).
  const charset = new Array(nGlyphs).fill(0);
  const csetOff = top.get(15)?.[0] ?? 0;
  if (csetOff > 2) {
    const fmt = b[csetOff];
    let p = csetOff + 1;
    let g = 1;
    if (fmt === 0) {
      for (; g < nGlyphs; g++, p += 2) charset[g] = (b[p] << 8) | b[p + 1];
    } else {
      while (g < nGlyphs && p < b.length) {
        const first = (b[p] << 8) | b[p + 1];
        const left = fmt === 1 ? b[p + 2] : (b[p + 2] << 8) | b[p + 3];
        p += fmt === 1 ? 3 : 4;
        for (let k = 0; k <= left && g < nGlyphs; k++) charset[g++] = first + k;
      }
    }
  } else {
    // Predefined ISOAdobe charset: gid i -> SID i.
    for (let g = 0; g < nGlyphs; g++) charset[g] = g;
  }
  const nameToGid = new Map();
  const cidToGid = new Map();
  for (let g = 0; g < nGlyphs; g++) {
    if (isCID) cidToGid.set(charset[g], g);
    else nameToGid.set(str(charset[g]), g);
  }
  // Built-in encoding: code -> gid.
  const encoding = new Map();
  const encOff = top.get(16)?.[0] ?? 0;
  if (!isCID) {
    if (encOff > 1) {
      const fmt = b[encOff] & 0x7f;
      let p = encOff + 1;
      if (fmt === 0) {
        const n = b[p++];
        for (let g = 1; g <= n; g++) encoding.set(b[p++], g);
      } else if (fmt === 1) {
        const n = b[p++];
        let g = 1;
        for (let r = 0; r < n; r++) {
          const first = b[p];
          const left = b[p + 1];
          p += 2;
          for (let k = 0; k <= left; k++) encoding.set(first + k, g++);
        }
      }
      if (b[encOff] & 0x80) {
        const n = b[p++];
        for (let k = 0; k < n; k++) {
          const code = b[p];
          const sid = (b[p + 1] << 8) | b[p + 2];
          p += 3;
          const g = nameToGid.get(str(sid));
          if (g !== undefined) encoding.set(code, g);
        }
      }
    } else {
      // Standard encoding (0) by glyph name.
      for (let code = 0; code < 256; code++) {
        const g = nameToGid.get(STANDARD[code]);
        if (g !== undefined) encoding.set(code, g);
      }
    }
  }
  // Private data per glyph.
  let fds = null;
  let fdSelect = null;
  if (isCID) {
    const fdaOff = top.get(1236)?.[0];
    if (fdaOff) fds = readIndex(b, fdaOff).items.map((d) => privOf(readDict(d)));
    const fdsOff = top.get(1237)?.[0];
    if (fdsOff) {
      fdSelect = new Uint8Array(nGlyphs);
      const fmt = b[fdsOff];
      if (fmt === 0) for (let g = 0; g < nGlyphs; g++) fdSelect[g] = b[fdsOff + 1 + g];
      else if (fmt === 3) {
        const nr = (b[fdsOff + 1] << 8) | b[fdsOff + 2];
        let p = fdsOff + 3;
        for (let r = 0; r < nr; r++) {
          const first = (b[p] << 8) | b[p + 1];
          const fd = b[p + 2];
          const next = (b[p + 3] << 8) | b[p + 4];
          for (let g = first; g < next && g < nGlyphs; g++) fdSelect[g] = fd;
          p += 3;
        }
      }
    }
  }
  const priv = privOf(top);
  const matrix = top.get(1207) || [0.001, 0, 0, 0.001, 0, 0];
  const font = {
    isCID,
    nGlyphs,
    matrix,
    nameToGid,
    cidToGid,
    encoding,
    glyphName: (g) => (isCID ? '' : str(charset[g] ?? 0)),
    glyphPath(gid) {
      const cs = charStrings[gid];
      if (!cs) return [];
      const p = fds ? fds[fdSelect ? fdSelect[gid] : 0] || priv : priv;
      try {
        return runType2(cs, gsubrs.items, p.subrs, (code) => {
          const g = nameToGid.get(STANDARD[code]);
          return g === undefined ? [] : this.glyphPath(g);
        });
      } catch {
        return [];
      }
    },
  };
  return font;
}

/** Interpret a Type 2 charstring into path commands. seac(code) returns a component's path. */
function runType2(code, gsubrs, lsubrs, seac) {
  const out = [];
  const st = [];
  let x = 0;
  let y = 0;
  let open = false;
  let nStems = 0;
  let haveWidth = false;
  const trans = [];
  const gb = bias(gsubrs.length);
  const lb = bias(lsubrs.length);
  const close = () => {
    if (open) out.push(['Z']);
    open = false;
  };
  const moveTo = (dx, dy) => {
    close();
    x += dx;
    y += dy;
    out.push(['M', x, y]);
    open = true;
  };
  const lineTo = (dx, dy) => {
    x += dx;
    y += dy;
    out.push(['L', x, y]);
  };
  const curveTo = (a, b, c, d, e, f) => {
    const x1 = x + a;
    const y1 = y + b;
    const x2 = x1 + c;
    const y2 = y1 + d;
    x = x2 + e;
    y = y2 + f;
    out.push(['C', x1, y1, x2, y2, x, y]);
  };
  const stems = () => {
    if (st.length % 2 && !haveWidth) st.shift();
    haveWidth = true;
    nStems += st.length >> 1;
    st.length = 0;
  };
  let depth = 0;
  const exec = (cs) => {
    if (++depth > 12) throw new Error('Subr depth');
    for (let i = 0; i < cs.length; ) {
      const v = cs[i++];
      if (v >= 32 || v === 28) {
        if (v === 28) {
          st.push(((cs[i] << 24) >> 16) | cs[i + 1]);
          i += 2;
        } else if (v <= 246) st.push(v - 139);
        else if (v <= 250) st.push((v - 247) * 256 + cs[i++] + 108);
        else if (v <= 254) st.push(-(v - 251) * 256 - cs[i++] - 108);
        else {
          st.push(((cs[i] << 24) | (cs[i + 1] << 16) | (cs[i + 2] << 8) | cs[i + 3]) / 65536);
          i += 4;
        }
        continue;
      }
      switch (v) {
        case 1:
        case 3:
        case 18:
        case 23:
          stems();
          break;
        case 19:
        case 20:
          stems();
          i += (nStems + 7) >> 3;
          break;
        case 21:
          if (st.length > 2 && !haveWidth) st.shift();
          haveWidth = true;
          moveTo(st[0] || 0, st[1] || 0);
          st.length = 0;
          break;
        case 22:
          if (st.length > 1 && !haveWidth) st.shift();
          haveWidth = true;
          moveTo(st[0] || 0, 0);
          st.length = 0;
          break;
        case 4:
          if (st.length > 1 && !haveWidth) st.shift();
          haveWidth = true;
          moveTo(0, st[0] || 0);
          st.length = 0;
          break;
        case 5:
          for (let k = 0; k + 1 < st.length; k += 2) lineTo(st[k], st[k + 1]);
          st.length = 0;
          break;
        case 6:
        case 7: {
          let horiz = v === 6;
          for (let k = 0; k < st.length; k++) {
            if (horiz) lineTo(st[k], 0);
            else lineTo(0, st[k]);
            horiz = !horiz;
          }
          st.length = 0;
          break;
        }
        case 8:
          for (let k = 0; k + 5 < st.length; k += 6) curveTo(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]);
          st.length = 0;
          break;
        case 24: {
          let k = 0;
          for (; k + 7 < st.length; k += 6) curveTo(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]);
          lineTo(st[k], st[k + 1]);
          st.length = 0;
          break;
        }
        case 25: {
          let k = 0;
          for (; k + 7 < st.length; k += 2) lineTo(st[k], st[k + 1]);
          curveTo(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]);
          st.length = 0;
          break;
        }
        case 26: {
          let k = 0;
          let dx1 = 0;
          if (st.length % 2) dx1 = st[k++];
          for (; k + 3 < st.length; k += 4) {
            curveTo(dx1, st[k], st[k + 1], st[k + 2], 0, st[k + 3]);
            dx1 = 0;
          }
          st.length = 0;
          break;
        }
        case 27: {
          let k = 0;
          let dy1 = 0;
          if (st.length % 2) dy1 = st[k++];
          for (; k + 3 < st.length; k += 4) {
            curveTo(st[k], dy1, st[k + 1], st[k + 2], st[k + 3], 0);
            dy1 = 0;
          }
          st.length = 0;
          break;
        }
        case 30:
        case 31: {
          let horiz = v === 31;
          for (let k = 0; k + 3 < st.length; k += 4) {
            const last = k + 5 === st.length ? st[k + 4] : 0;
            if (horiz) curveTo(st[k], 0, st[k + 1], st[k + 2], last, st[k + 3]);
            else curveTo(0, st[k], st[k + 1], st[k + 2], st[k + 3], last);
            horiz = !horiz;
          }
          st.length = 0;
          break;
        }
        case 10: {
          const n = st.pop() + lb;
          if (lsubrs[n]) exec(lsubrs[n]);
          break;
        }
        case 29: {
          const n = st.pop() + gb;
          if (gsubrs[n]) exec(gsubrs[n]);
          break;
        }
        case 11:
          depth--;
          return;
        case 14: {
          if ((st.length === 1 || st.length === 5) && !haveWidth) st.shift();
          if (st.length === 4) {
            // seac: base and accent glyphs by standard code.
            const [adx, ady, bchar, achar] = st;
            close();
            out.push(...seac(bchar));
            for (const cmd of seac(achar)) {
              const t = cmd.slice();
              for (let k = 1; k < t.length; k += 2) {
                t[k] += adx;
                t[k + 1] += ady;
              }
              out.push(t);
            }
            st.length = 0;
            throw new EndChar();
          }
          close();
          throw new EndChar();
        }
        case 12: {
          const e = cs[i++];
          switch (e) {
            case 35: {
              // flex
              curveTo(st[0], st[1], st[2], st[3], st[4], st[5]);
              curveTo(st[6], st[7], st[8], st[9], st[10], st[11]);
              break;
            }
            case 34: {
              const y0 = y;
              curveTo(st[0], 0, st[1], st[2], st[3], 0);
              curveTo(st[4], 0, st[5], y0 - y, st[6], 0);
              break;
            }
            case 36: {
              const y0 = y;
              curveTo(st[0], st[1], st[2], st[3], st[4], 0);
              curveTo(st[5], 0, st[6], st[7], st[8], y0 - y);
              break;
            }
            case 37: {
              const x0 = x;
              const y0 = y;
              let dx = 0;
              let dy = 0;
              for (let k = 0; k < 10; k += 2) {
                dx += st[k];
                dy += st[k + 1];
              }
              curveTo(st[0], st[1], st[2], st[3], st[4], st[5]);
              const horizontal = Math.abs(dx) > Math.abs(dy);
              curveTo(st[6], st[7], st[8], st[9], horizontal ? st[10] : x0 - x - st[6] - st[8], horizontal ? y0 - y - st[7] - st[9] : st[10]);
              break;
            }
            case 3: { const b2 = st.pop(); const a = st.pop(); st.push(a && b2 ? 1 : 0); break; }
            case 4: { const b2 = st.pop(); const a = st.pop(); st.push(a || b2 ? 1 : 0); break; }
            case 5: st.push(st.pop() ? 0 : 1); break;
            case 9: st.push(Math.abs(st.pop())); break;
            case 10: { const b2 = st.pop(); st.push(st.pop() + b2); break; }
            case 11: { const b2 = st.pop(); st.push(st.pop() - b2); break; }
            case 12: { const b2 = st.pop(); st.push(b2 ? st.pop() / b2 : 0); break; }
            case 14: st.push(-st.pop()); break;
            case 15: { const b2 = st.pop(); st.push(st.pop() === b2 ? 1 : 0); break; }
            case 18: st.pop(); break;
            case 20: { const k = st.pop(); trans[k] = st.pop(); break; }
            case 21: st.push(trans[st.pop()] ?? 0); break;
            case 22: { const v2 = st.pop(); const v1 = st.pop(); const s2 = st.pop(); const s1 = st.pop(); st.push(v1 <= v2 ? s1 : s2); break; }
            case 23: st.push(Math.random()); break;
            case 24: { const b2 = st.pop(); st.push(st.pop() * b2); break; }
            case 26: st.push(Math.sqrt(st.pop())); break;
            case 27: st.push(st[st.length - 1]); break;
            case 28: { const b2 = st.pop(); const a = st.pop(); st.push(b2, a); break; }
            case 29: { const k = st.pop(); st.push(st[st.length - 1 - Math.max(0, k)]); break; }
            case 30: {
              const j = st.pop();
              const n = st.pop();
              if (n > 0 && n <= st.length) {
                const part = st.splice(st.length - n, n);
                const r = ((j % n) + n) % n;
                st.push(...part.slice(n - r), ...part.slice(0, n - r));
              }
              break;
            }
            default:
              break;
          }
          if (![3, 4, 5, 9, 10, 11, 12, 14, 15, 20, 21, 22, 23, 24, 26, 27, 28, 29, 30].includes(e)) st.length = 0;
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
    if (!(err instanceof EndChar)) throw err;
  }
  close();
  return out;
}

class EndChar extends Error {}
