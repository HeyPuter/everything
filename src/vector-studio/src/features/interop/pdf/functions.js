/**
 * PDF functions (sampled, exponential, stitching and PostScript
 * calculator), used by shadings and by tint transforms of separation and
 * DeviceN color spaces. compileFunction(obj) returns (inputs[]) -> outputs[].
 */
import { PDFDict, PDFStream, Cmd, Ref, isCmd } from './primitives.js';
import { Lexer, EOF } from './lexer.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function interp(x, x0, x1, y0, y1) {
  return x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
}

/** A function, or an array of single-output functions combined. */
export function compileFunction(xref, obj, depth = 0) {
  if (depth > 8) return null;
  if (obj instanceof Ref) obj = xref ? xref.fetch(obj) : null;
  if (Array.isArray(obj)) {
    const fns = obj.map((f) => compileFunction(xref, f, depth + 1));
    if (fns.some((f) => !f)) return null;
    return (x) => fns.map((f) => f(x)[0]);
  }
  const dict = obj instanceof PDFStream ? obj.dict : obj;
  if (!(dict instanceof PDFDict)) return null;
  const type = dict.num('FunctionType', -1);
  const domain = dict.array('Domain') || [0, 1];
  const range = dict.array('Range');
  const clipIn = (x) => x.map((v, i) => clamp(v, domain[2 * i] ?? -Infinity, domain[2 * i + 1] ?? Infinity));
  const clipOut = (y) => (range ? y.map((v, i) => clamp(v, range[2 * i] ?? -Infinity, range[2 * i + 1] ?? Infinity)) : y);
  if (type === 2) {
    const c0 = dict.array('C0') || [0];
    const c1 = dict.array('C1') || [1];
    const n = dict.num('N', 1);
    return (x) => {
      const t = clipIn(x)[0];
      const p = n === 1 ? t : Math.pow(Math.max(t, 0), n);
      return clipOut(c0.map((a, i) => a + p * ((c1[i] ?? 1) - a)));
    };
  }
  if (type === 3) {
    const fns = (dict.array('Functions') || []).map((f) => compileFunction(xref, f, depth + 1));
    if (!fns.length || fns.some((f) => !f)) return null;
    const bounds = dict.array('Bounds') || [];
    const encode = dict.array('Encode') || fns.flatMap(() => [0, 1]);
    return (x) => {
      const t = clipIn(x)[0];
      let i = 0;
      while (i < bounds.length && t >= bounds[i]) i++;
      const lo = i === 0 ? domain[0] : bounds[i - 1];
      const hi = i === bounds.length ? domain[1] : bounds[i];
      const e = interp(t, lo, hi, encode[2 * i], encode[2 * i + 1]);
      return clipOut(fns[i]([e]));
    };
  }
  if (type === 0 && obj instanceof PDFStream) {
    const size = dict.array('Size') || [2];
    const bps = dict.num('BitsPerSample', 8);
    const encode = dict.array('Encode') || size.flatMap((s) => [0, s - 1]);
    const decode = dict.array('Decode') || range || [];
    const nOut = range ? range.length / 2 : 1;
    let data;
    try {
      data = obj.decoded();
    } catch {
      return null;
    }
    const max = 2 ** bps - 1;
    const sample = (index) => {
      // index: flat sample index; returns nOut values in 0..1.
      const out = [];
      for (let k = 0; k < nOut; k++) {
        const bit = (index * nOut + k) * bps;
        let v = 0;
        if (bps === 8) v = data[bit >> 3] ?? 0;
        else if (bps === 16) v = ((data[bit >> 3] ?? 0) << 8) | (data[(bit >> 3) + 1] ?? 0);
        else {
          for (let b = 0; b < bps; b++) {
            const bb = bit + b;
            v = (v << 1) | (((data[bb >> 3] ?? 0) >> (7 - (bb & 7))) & 1);
          }
        }
        out.push(v / max);
      }
      return out;
    };
    const m = size.length;
    return (x) => {
      const xin = clipIn(x);
      // Multilinear interpolation over the input dimensions.
      const e = xin.map((v, i) => clamp(interp(v, domain[2 * i], domain[2 * i + 1], encode[2 * i], encode[2 * i + 1]), 0, size[i] - 1));
      const out = new Array(nOut).fill(0);
      const corners = 1 << m;
      for (let c = 0; c < corners; c++) {
        let w = 1;
        let index = 0;
        let stride = 1;
        for (let i = 0; i < m; i++) {
          const lo = Math.floor(e[i]);
          const hi = Math.min(size[i] - 1, lo + 1);
          const f = e[i] - lo;
          const use = (c >> i) & 1;
          w *= use ? f : 1 - f;
          index += (use ? hi : lo) * stride;
          stride *= size[i];
        }
        if (!w) continue;
        const s = sample(index);
        for (let k = 0; k < nOut; k++) out[k] += w * s[k];
      }
      return clipOut(out.map((v, k) => (decode.length ? interp(v, 0, 1, decode[2 * k], decode[2 * k + 1]) : v)));
    };
  }
  if (type === 4 && obj instanceof PDFStream) {
    let code;
    try {
      code = parsePostScript(obj.decoded());
    } catch {
      return null;
    }
    return (x) => {
      const stack = clipIn(x).slice();
      try {
        runPostScript(code, stack, 0);
      } catch {
        /* keep what is on the stack */
      }
      const n = range ? range.length / 2 : stack.length;
      return clipOut(stack.slice(-n).map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)));
    };
  }
  return null;
}

// ---------------------------------------------------------------- PostScript calculator

function parsePostScript(bytes) {
  const lx = new Lexer(bytes);
  const read = () => {
    const out = [];
    for (;;) {
      const t = lx.next();
      if (t === EOF) return out;
      if (isCmd(t, '{')) out.push({ proc: read() });
      else if (isCmd(t, '}')) return out;
      else out.push(t);
    }
  };
  const first = lx.next();
  if (!isCmd(first, '{')) throw new Error('Bad calculator function');
  return read();
}

function runPostScript(code, st, depth) {
  if (depth > 50) throw new Error('Too deep');
  for (let i = 0; i < code.length; i++) {
    const t = code[i];
    if (typeof t === 'number') {
      st.push(t);
      continue;
    }
    if (t.proc) {
      // "{...} if" or "{...} {...} ifelse"
      const next = code[i + 1];
      if (next?.proc && isCmd(code[i + 2], 'ifelse')) {
        const c = st.pop();
        runPostScript(c ? t.proc : next.proc, st, depth + 1);
        i += 2;
      } else if (isCmd(next, 'if')) {
        if (st.pop()) runPostScript(t.proc, st, depth + 1);
        i += 1;
      }
      continue;
    }
    if (!(t instanceof Cmd)) continue;
    const b = () => st.pop();
    switch (t.cmd) {
      case 'abs': st.push(Math.abs(b())); break;
      case 'add': { const y = b(); st.push(b() + y); break; }
      case 'atan': { const den = b(); const num = b(); let a = (Math.atan2(num, den) * 180) / Math.PI; if (a < 0) a += 360; st.push(a); break; }
      case 'ceiling': st.push(Math.ceil(b())); break;
      case 'cos': st.push(Math.cos((b() * Math.PI) / 180)); break;
      case 'cvi': st.push(Math.trunc(b())); break;
      case 'cvr': break;
      case 'div': { const y = b(); st.push(y ? b() / y : 0); break; }
      case 'exp': { const e = b(); st.push(Math.pow(b(), e)); break; }
      case 'floor': st.push(Math.floor(b())); break;
      case 'idiv': { const y = b(); st.push(y ? Math.trunc(b() / y) : 0); break; }
      case 'ln': st.push(Math.log(b())); break;
      case 'log': st.push(Math.log10(b())); break;
      case 'mod': { const y = b(); st.push(y ? b() % y : 0); break; }
      case 'mul': { const y = b(); st.push(b() * y); break; }
      case 'neg': st.push(-b()); break;
      case 'round': st.push(Math.round(b())); break;
      case 'sin': st.push(Math.sin((b() * Math.PI) / 180)); break;
      case 'sqrt': st.push(Math.sqrt(b())); break;
      case 'sub': { const y = b(); st.push(b() - y); break; }
      case 'truncate': st.push(Math.trunc(b())); break;
      case 'and': { const y = b(); const x = b(); st.push(typeof x === 'boolean' ? x && y : x & y); break; }
      case 'or': { const y = b(); const x = b(); st.push(typeof x === 'boolean' ? x || y : x | y); break; }
      case 'xor': { const y = b(); const x = b(); st.push(typeof x === 'boolean' ? x !== y : x ^ y); break; }
      case 'not': { const x = b(); st.push(typeof x === 'boolean' ? !x : ~x); break; }
      case 'bitshift': { const s = b(); const x = b(); st.push(s >= 0 ? x << s : x >> -s); break; }
      case 'eq': { const y = b(); st.push(b() === y); break; }
      case 'ne': { const y = b(); st.push(b() !== y); break; }
      case 'gt': { const y = b(); st.push(b() > y); break; }
      case 'ge': { const y = b(); st.push(b() >= y); break; }
      case 'lt': { const y = b(); st.push(b() < y); break; }
      case 'le': { const y = b(); st.push(b() <= y); break; }
      case 'true': st.push(true); break;
      case 'false': st.push(false); break;
      case 'copy': { const n = b(); st.push(...st.slice(st.length - n)); break; }
      case 'dup': st.push(st[st.length - 1]); break;
      case 'exch': { const y = b(); const x = b(); st.push(y, x); break; }
      case 'index': { const n = b(); st.push(st[st.length - 1 - n]); break; }
      case 'pop': b(); break;
      case 'roll': {
        const j = b();
        const n = b();
        if (n > 0) {
          const part = st.splice(st.length - n, n);
          const k = ((j % n) + n) % n;
          st.push(...part.slice(n - k), ...part.slice(0, n - k));
        }
        break;
      }
      default:
        break;
    }
  }
}
