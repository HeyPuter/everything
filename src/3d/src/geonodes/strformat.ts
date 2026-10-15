// Text formatting for the string nodes: a `{name:spec}` template formatter, number → text with
// exact decimal rounding (ties to even, as printf does) and text → number parsing. Numbers are
// single-precision values, so the shortest representation is the shortest one that reads back to
// the same 32-bit float.

export type FormatValue = { name: string; type: 'FLOAT' | 'INT' | 'STRING'; value: number | string };

const cps = (s: string) => Array.from(s);

// ---------------------------------------------------------------------------
// Exact decimal digits of a double

/** Exact decimal expansion: value = 0.digits × 10^point (digits without leading zeros). */
function exactDigits(x: number): { digits: string; point: number } {
  x = Math.abs(x);
  if (x === 0) return { digits: '0', point: 1 };
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0),
    lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (expBits === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = expBits - 1075;
  }
  let digits: string;
  let point: number;
  if (e >= 0) {
    digits = (mant << BigInt(e)).toString();
    point = digits.length;
  } else {
    digits = (mant * 5n ** BigInt(-e)).toString();
    point = digits.length + e;
  }
  const stripped = digits.replace(/^0+/, '');
  point -= digits.length - stripped.length;
  return { digits: stripped.replace(/0+$/, '') || '0', point };
}

/** Round a digit string to `n` digits (ties to even); returns the new digits and point shift. */
function roundDigits(d: string, point: number, n: number): { digits: string; point: number } {
  if (n < 0) return { digits: '0', point: point + 1 };
  if (d.length <= n) return { digits: d.padEnd(n, '0'), point };
  const keep = d.slice(0, n);
  const rest = d.slice(n);
  const first = rest.charCodeAt(0) - 48;
  const tail = /[1-9]/.test(rest.slice(1));
  const last = n > 0 ? keep.charCodeAt(n - 1) - 48 : 0;
  const up = first > 5 || (first === 5 && (tail || last % 2 === 1));
  if (!up) return { digits: keep || '0', point: keep ? point : point };
  // increment
  const arr = (keep || '0').split('').map(Number);
  let i = arr.length - 1;
  if (!keep) {
    return { digits: '1', point: point + 1 };
  }
  while (i >= 0) {
    if (arr[i] < 9) {
      arr[i]++;
      break;
    }
    arr[i] = 0;
    i--;
  }
  if (i < 0) return { digits: `1${arr.join('')}`.slice(0, n), point: point + 1 };
  return { digits: arr.join(''), point };
}

/** Fixed notation with `prec` decimals (no sign). */
export function toFixedExact(x: number, prec: number): string {
  const { digits, point } = exactDigits(x);
  if (digits === '0') return prec > 0 ? `0.${'0'.repeat(prec)}` : '0';
  const n = point + prec;
  let r: { digits: string; point: number };
  if (n < 0) r = { digits: '0', point: 1 };
  else if (n === 0) {
    // only the rounding of the leading digit matters
    const first = digits.charCodeAt(0) - 48;
    const up = first > 5 || (first === 5 && digits.length > 1);
    r = up ? { digits: '1', point: point + 1 } : { digits: '0', point: 1 };
  } else r = roundDigits(digits, point, n);
  let s = r.digits;
  let p = r.point;
  if (s === '0' || /^0+$/.test(s)) {
    s = '0';
    p = 1;
  }
  // place the decimal point
  let intPart: string, frac: string;
  if (p <= 0) {
    intPart = '0';
    frac = '0'.repeat(-p) + s;
  } else if (p >= s.length) {
    intPart = s + '0'.repeat(p - s.length);
    frac = '';
  } else {
    intPart = s.slice(0, p);
    frac = s.slice(p);
  }
  frac = frac.padEnd(prec, '0').slice(0, prec);
  return prec > 0 ? `${intPart}.${frac}` : intPart;
}

/** Scientific notation with `prec` decimals (no sign), exponent with at least two digits. */
export function toExpExact(x: number, prec: number, upper = false): string {
  const { digits, point } = exactDigits(x);
  let d: string, exp: number;
  if (digits === '0') {
    d = '0'.repeat(prec + 1);
    exp = 0;
  } else {
    const r = roundDigits(digits, point, prec + 1);
    d = r.digits;
    exp = r.point - 1;
  }
  const mant = prec > 0 ? `${d[0]}.${d.slice(1)}` : d[0];
  const es = `${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  return `${mant}${upper ? 'E' : 'e'}${es}`;
}

/** %g style: `prec` significant digits, trailing zeros removed. */
export function toGeneral(x: number, prec: number, upper = false): string {
  if (prec === 0) prec = 1;
  const { digits, point } = exactDigits(x);
  let exp = 0;
  if (digits !== '0') exp = roundDigits(digits, point, prec).point - 1;
  let s: string;
  if (exp < -4 || exp >= prec) {
    s = toExpExact(x, prec - 1, upper);
    s = s.replace(/\.?0+(?=[eE])/, '');
  } else {
    s = toFixedExact(x, Math.max(0, prec - 1 - exp));
    if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return s;
}

/** Shortest text that reads back to the same 32-bit float (fixed between 1e-4 and 1e7). */
export function shortestFloat(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
  const neg = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  if (a === 0) return neg ? '-0' : '0';
  let p = 1;
  let s = a.toPrecision(1);
  for (; p <= 9; p++) {
    s = a.toPrecision(p);
    if (Math.fround(parseFloat(s)) === Math.fround(a)) break;
  }
  const v = parseFloat(s);
  const exp = Math.floor(Math.log10(v) + 1e-12);
  const e2 = Number(v.toExponential().split('e')[1]);
  const ex = Number.isFinite(e2) ? e2 : exp;
  let out: string;
  if (ex < -4 || ex >= 7) {
    const [m, e] = v.toExponential(Math.max(0, p - 1)).split('e');
    const mm = m.includes('.') ? m.replace(/\.?0+$/, '') : m;
    const en = Number(e);
    out = `${mm}e${en < 0 ? '-' : '+'}${String(Math.abs(en)).padStart(2, '0')}`;
  } else {
    out = v.toFixed(Math.max(0, p - 1 - ex));
    if (out.includes('.')) out = out.replace(/\.?0+$/, '');
  }
  return (neg ? '-' : '') + out;
}

// ---------------------------------------------------------------------------
// Template formatting

interface Spec {
  fill: string;
  align: '' | '<' | '>' | '^';
  sign: '' | '+' | '-' | ' ';
  zero: boolean;
  width: number;
  precision: number;
  type: string;
}

class FormatError extends Error {}

function pad(s: string, spec: Spec, numeric: boolean): string {
  const len = cps(s).length;
  if (spec.width <= len) return s;
  const n = spec.width - len;
  const align = spec.align || (numeric ? '>' : '<');
  if (!spec.align && spec.zero && numeric) {
    const m = /^[+\- ]/.exec(s);
    const signStr = m ? m[0] : '';
    return signStr + '0'.repeat(n) + s.slice(signStr.length);
  }
  const f = spec.fill;
  if (align === '<') return s + f.repeat(n);
  if (align === '>') return f.repeat(n) + s;
  const left = Math.floor(n / 2);
  return f.repeat(left) + s + f.repeat(n - left);
}

function signed(neg: boolean, body: string, sign: Spec['sign']) {
  return (neg ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : '') + body;
}

function formatValue(v: FormatValue, spec: Spec, raw: string): string {
  if (v.type === 'STRING') {
    if (spec.sign || spec.zero) throw new FormatError(`Invalid format: "${raw}"`);
    if (spec.type && spec.type !== 's') throw new FormatError(`Format contains unsupported "${spec.type}" character: "${raw}"`);
    let s = String(v.value);
    if (spec.precision >= 0) s = cps(s).slice(0, spec.precision).join('');
    return pad(s, spec, false);
  }
  const x = Number(v.value);
  if (v.type === 'INT') {
    if (spec.precision >= 0) throw new FormatError(`Invalid format: "${raw}"`);
    const t = spec.type || 'd';
    const base: Record<string, number> = { d: 10, x: 16, X: 16, b: 2, B: 2, o: 8 };
    if (t === 'c') return pad(String.fromCodePoint(Math.max(0, x)), spec, false);
    if (!(t in base)) throw new FormatError(`Format contains unsupported "${t}" character: "${raw}"`);
    let body = Math.abs(x).toString(base[t]);
    if (t === 'X') body = body.toUpperCase();
    return pad(signed(x < 0, body, spec.sign), spec, true);
  }
  // float
  const neg = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  const t = spec.type;
  let body: string;
  if (!Number.isFinite(a)) body = Number.isNaN(a) ? 'nan' : 'inf';
  else if (t === '' && spec.precision < 0) body = shortestFloat(a);
  else if (t === '' || t === 'g' || t === 'G') body = toGeneral(a, spec.precision < 0 ? 6 : spec.precision, t === 'G');
  else if (t === 'f' || t === 'F') body = toFixedExact(a, spec.precision < 0 ? 6 : spec.precision);
  else if (t === 'e' || t === 'E') body = toExpExact(a, spec.precision < 0 ? 6 : spec.precision, t === 'E');
  else if (t === 'd' || t === 'x' || t === 'X' || t === 'b' || t === 'o' || t === 'c') throw new FormatError(`Invalid format: "${raw}"`);
  else throw new FormatError(`Format contains unsupported "${t}" character: "${raw}"`);
  return pad(signed(neg && !Number.isNaN(a), body, spec.sign), spec, true);
}

/** Format a template: `{}` / `{0}` / `{name}` with an optional `:spec`; `{{` and `}}` escape. */
export function formatString(template: string, values: FormatValue[]): { text: string; error?: string } {
  let out = '';
  let auto = 0;
  let mode: '' | 'auto' | 'manual' = '';
  const lookup = (id: string): FormatValue => {
    if (id === '') {
      if (mode === 'manual') throw new FormatError('Automatic and explicit input references cannot be mixed');
      mode = 'auto';
      const v = values[auto++];
      if (!v) throw new FormatError('The format refers to more inputs than there are');
      return v;
    }
    if (mode === 'auto') throw new FormatError('Automatic and explicit input references cannot be mixed');
    mode = 'manual';
    const v = /^\d+$/.test(id) ? values[Number(id)] : values.find((x) => x.name === id);
    if (!v) throw new FormatError(`There is no input named "${id}"`);
    return v;
  };
  const numberOf = (id: string): number => {
    const v = lookup(id);
    if (v.type !== 'INT') throw new FormatError(`Input "${v.name}" must be an integer to be used as a width or precision`);
    return Number(v.value);
  };
  try {
    const s = template;
    for (let i = 0; i < s.length;) {
      const ch = s[i];
      if (ch === '{') {
        if (s[i + 1] === '{') {
          out += '{';
          i += 2;
          continue;
        }
        // find the closing brace, allowing one level of nested {…}
        let j = i + 1,
          depth = 1;
        while (j < s.length && depth) {
          if (s[j] === '{') depth++;
          else if (s[j] === '}') depth--;
          if (depth) j++;
        }
        if (depth) throw new FormatError(`Unclosed format field: "${s.slice(i)}"`);
        const field = s.slice(i + 1, j);
        const colon = field.indexOf(':');
        const id = colon < 0 ? field : field.slice(0, colon);
        const specText = colon < 0 ? '' : field.slice(colon + 1);
        const v = lookup(id);
        const spec = parseSpec(specText, numberOf);
        let text = formatValue(v, spec, `{${field}}`);
        if (v.type === 'FLOAT' && specText === '' && /^-?\d+$/.test(text)) text += '.0';
        out += text;
        i = j + 1;
      } else if (ch === '}') {
        if (s[i + 1] === '}') {
          out += '}';
          i += 2;
          continue;
        }
        throw new FormatError(`Unmatched "}" in format: "${s}"`);
      } else {
        out += ch;
        i++;
      }
    }
  } catch (e) {
    if (e instanceof FormatError) return { text: '', error: e.message };
    throw e;
  }
  return { text: out };
}

function parseSpec(spec: string, numberOf: (id: string) => number): Spec {
  const r: Spec = { fill: ' ', align: '', sign: '', zero: false, width: 0, precision: -1, type: '' };
  const c = cps(spec);
  let i = 0;
  const isAlign = (x: string | undefined) => x === '<' || x === '>' || x === '^' || x === '=';
  if (c.length > 1 && isAlign(c[1]) && c[0] !== '{') {
    r.fill = c[0];
    if (c[1] === '=') throw new FormatError(`Format contains unsupported "=" character: "{${spec}}"`);
    r.align = c[1] as Spec['align'];
    i = 2;
  } else if (isAlign(c[0])) {
    if (c[0] === '=') throw new FormatError(`Format contains unsupported "=" character: "{${spec}}"`);
    r.align = c[0] as Spec['align'];
    i = 1;
  }
  if (c[i] === '+' || c[i] === '-' || c[i] === ' ') r.sign = c[i++] as Spec['sign'];
  if (c[i] === '#') throw new FormatError(`Invalid format specifier: "${spec}"`);
  if (c[i] === '0') {
    r.zero = true;
    i++;
  }
  const readNum = (): number => {
    if (c[i] === '{') {
      const j = c.indexOf('}', i);
      const n = numberOf(c.slice(i + 1, j).join(''));
      i = j + 1;
      return n;
    }
    let s = '';
    while (i < c.length && /\d/.test(c[i])) s += c[i++];
    return s ? Number(s) : -1;
  };
  const w = readNum();
  if (w >= 0) r.width = w;
  if (c[i] === '.') {
    i++;
    const p = readNum();
    if (p < 0) throw new FormatError(`Invalid format: "{${spec}}"`);
    r.precision = p;
  }
  if (i < c.length) {
    r.type = c[i++];
    if (r.type === 'L' || r.type === '%' || r.type === ',' || r.type === '_') throw new FormatError(`Format contains unsupported "${r.type}" character: "{${spec}}"`);
  }
  if (i < c.length) throw new FormatError(`Invalid format: "{${spec}}"`);
  return r;
}

// ---------------------------------------------------------------------------
// Number ↔ text

/** Integer in a base (2…36), zero-padded to `padding` characters including the sign. */
export function intToString(v: number, base: number, padding: number): string {
  if (base < 2 || base > 36) return '';
  const body = Math.abs(v).toString(base);
  const sign = v < 0 ? '-' : '';
  return sign + body.padStart(Math.max(0, padding - sign.length), '0');
}

/** Parse a float at the start of the text: optional minus, digits, fraction, exponent. */
export function parseFloatPrefix(s: string): { value: number; length: number } {
  const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s) ?? /^-?(?:inf(?:inity)?|nan)/i.exec(s);
  if (!m) return { value: 0, length: 0 };
  return { value: Math.fround(Number(m[0].replace(/^(-?)inf(inity)?$/i, '$1Infinity').replace(/^-?nan$/i, 'NaN'))), length: m[0].length };
}

/** Parse an integer in a base (2…36) at the start of the text: optional minus and digits. */
export function parseIntPrefix(s: string, base: number): { value: number; length: number } {
  if (base < 2 || base > 36) return { value: 0, length: 0 };
  let i = s[0] === '-' ? 1 : 0;
  let v = 0;
  const start = i;
  for (; i < s.length; i++) {
    const d = parseInt(s[i], 36);
    if (Number.isNaN(d) || d >= base) break;
    v = v * base + d;
  }
  if (i === start) return { value: 0, length: 0 };
  v = s[0] === '-' ? -v : v;
  if (v > 2147483647 || v < -2147483648) return { value: 0, length: 0 };
  return { value: v, length: i };
}
