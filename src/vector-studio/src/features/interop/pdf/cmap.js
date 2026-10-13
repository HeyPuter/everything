/**
 * CMaps: the code-to-CID maps of composite (Type 0) fonts and ToUnicode
 * maps. Embedded CMaps are parsed (codespace ranges, cidchar/cidrange,
 * bfchar/bfrange); of the predefined CMaps, Identity-H/V are built in and
 * any other name falls back to two-byte identity codes.
 */
import { Lexer, EOF } from './lexer.js';
import { Name, Cmd, isCmd, PDFStream } from './primitives.js';

const strNum = (s) => {
  let v = 0;
  for (let i = 0; i < s.length; i++) v = v * 256 + s.charCodeAt(i);
  return v;
};

/** UTF-16BE byte string to JS text. */
function utf16(s) {
  let out = '';
  for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  if (s.length === 1) out += String.fromCharCode(s.charCodeAt(0));
  return out;
}

export class CMap {
  constructor() {
    this.codespace = []; // [{ bytes, lo, hi }]
    this.map = new Map(); // code -> cid or unicode string
    this.ranges = []; // [{ lo, hi, start (number|string|array), bytes }]
    this.vertical = false;
    this.identity = false;
  }

  static identity(vertical = false) {
    const c = new CMap();
    c.identity = true;
    c.vertical = vertical;
    c.codespace.push({ bytes: 2, lo: 0, hi: 0xffff });
    return c;
  }

  /** Split a byte string into codes: [{ code, bytes }]. */
  codes(s) {
    const out = [];
    const cs = this.codespace;
    for (let i = 0; i < s.length; ) {
      let matched = 0;
      if (cs.length) {
        let v = 0;
        for (let n = 1; n <= 4 && i + n <= s.length; n++) {
          v = v * 256 + s.charCodeAt(i + n - 1);
          if (cs.some((r) => r.bytes === n && v >= r.lo && v <= r.hi)) {
            matched = n;
            break;
          }
        }
      }
      if (!matched) {
        // Fall back to the shortest codespace length (or one byte).
        matched = Math.min(s.length - i, cs.length ? Math.min(...cs.map((r) => r.bytes)) : 1);
      }
      out.push({ code: strNum(s.slice(i, i + matched)), bytes: matched });
      i += matched;
    }
    return out;
  }

  /** CID (number) or Unicode text for a code, or undefined. */
  lookup(code) {
    if (this.identity) return code;
    if (this.map.has(code)) return this.map.get(code);
    for (const r of this.ranges) {
      if (code < r.lo || code > r.hi) continue;
      const k = code - r.lo;
      if (typeof r.start === 'number') return r.start + k;
      if (Array.isArray(r.start)) return r.start[k];
      // bfrange with a string destination: increment its last byte(s).
      const s = r.start;
      if (!s.length) return '';
      const text = utf16(s);
      const last = text.charCodeAt(text.length - 1) + k;
      return text.slice(0, -1) + String.fromCharCode(last);
    }
    return undefined;
  }
}

/**
 * Parse an embedded CMap (stream bytes). `toUnicode` selects bf* entries
 * as Unicode text; otherwise cid* entries give CIDs.
 */
export function parseCMap(bytes, { toUnicode = false, resolveUse = null } = {}) {
  const cmap = new CMap();
  const lx = new Lexer(bytes);
  const stack = [];
  const val = (t) => (t && typeof t === 'object' && 'str' in t ? t.str : t);
  for (;;) {
    const t = lx.next();
    if (t === EOF) break;
    if (!(t instanceof Cmd)) {
      stack.push(val(t));
      if (stack.length > 4096) stack.splice(0, 2048);
      continue;
    }
    switch (t.cmd) {
      case 'begincodespacerange':
      case 'begincidrange':
      case 'beginbfrange':
      case 'begincidchar':
      case 'beginbfchar':
      case 'beginnotdefrange':
      case 'beginnotdefchar': {
        const kind = t.cmd.slice(5);
        const items = [];
        for (;;) {
          const x = lx.next();
          if (x === EOF || (x instanceof Cmd && x.cmd.startsWith('end'))) break;
          if (isCmd(x, '[')) {
            const arr = [];
            for (;;) {
              const y = lx.next();
              if (y === EOF || isCmd(y, ']')) break;
              arr.push(val(y));
            }
            items.push(arr);
          } else items.push(val(x));
        }
        if (kind === 'codespacerange') {
          for (let i = 0; i + 1 < items.length; i += 2) {
            const lo = items[i];
            const hi = items[i + 1];
            if (typeof lo !== 'string' || typeof hi !== 'string') continue;
            cmap.codespace.push({ bytes: hi.length, lo: strNum(lo), hi: strNum(hi) });
          }
        } else if (kind === 'cidrange' && !toUnicode) {
          for (let i = 0; i + 2 < items.length; i += 3) {
            if (typeof items[i] !== 'string') continue;
            cmap.ranges.push({ lo: strNum(items[i]), hi: strNum(items[i + 1]), start: items[i + 2] });
          }
        } else if (kind === 'cidchar' && !toUnicode) {
          for (let i = 0; i + 1 < items.length; i += 2) if (typeof items[i] === 'string') cmap.map.set(strNum(items[i]), items[i + 1]);
        } else if (kind === 'bfrange' && toUnicode) {
          for (let i = 0; i + 2 < items.length; i += 3) {
            if (typeof items[i] !== 'string') continue;
            const dst = items[i + 2];
            cmap.ranges.push({ lo: strNum(items[i]), hi: strNum(items[i + 1]), start: Array.isArray(dst) ? dst.map((d) => (typeof d === 'string' ? utf16(d) : '')) : typeof dst === 'string' ? dst : '' });
          }
        } else if (kind === 'bfchar' && toUnicode) {
          for (let i = 0; i + 1 < items.length; i += 2) {
            if (typeof items[i] !== 'string') continue;
            const d = items[i + 1];
            cmap.map.set(strNum(items[i]), typeof d === 'string' ? utf16(d) : d instanceof Name ? d.name : '');
          }
        }
        break;
      }
      case 'usecmap': {
        const name = stack.pop();
        if (name instanceof Name && resolveUse) {
          const base = resolveUse(name.name);
          if (base) {
            cmap.codespace.push(...base.codespace);
            for (const [k, v] of base.map) if (!cmap.map.has(k)) cmap.map.set(k, v);
            cmap.ranges.push(...base.ranges);
            if (base.identity) cmap.identity = true;
          }
        }
        break;
      }
      case 'def': {
        const v = stack.pop();
        const k = stack.pop();
        if (k instanceof Name && k.name === 'WMode' && v === 1) cmap.vertical = true;
        break;
      }
      default:
        break;
    }
  }
  return cmap;
}

/** The encoding CMap of a Type 0 font (a predefined name or an embedded stream). */
export function encodingCMap(enc) {
  if (enc instanceof Name) {
    const n = enc.name;
    return { cmap: CMap.identity(/-V$/.test(n)), known: n === 'Identity-H' || n === 'Identity-V' };
  }
  if (enc instanceof PDFStream) {
    try {
      const use = enc.dict.get('UseCMap');
      const cmap = parseCMap(enc.decoded(), { resolveUse: (name) => (/^Identity-[HV]$/.test(name) ? CMap.identity(name.endsWith('V')) : null) });
      if (use instanceof Name && /^Identity-[HV]$/.test(use.name) && !cmap.map.size && !cmap.ranges.length) cmap.identity = true;
      if (!cmap.codespace.length) cmap.codespace.push({ bytes: 2, lo: 0, hi: 0xffff });
      return { cmap, known: true };
    } catch {
      return { cmap: CMap.identity(), known: false };
    }
  }
  return { cmap: CMap.identity(), known: false };
}
