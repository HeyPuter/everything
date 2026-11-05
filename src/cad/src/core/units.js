/**
 * Formatting and parsing of lengths and angles following the drawing header
 * (linearFormat, linearPrecision, angularFormat, angularPrecision, units).
 *
 * Architectural and engineering formats treat one drawing unit as one inch.
 * For the fractional formats the precision p selects the smallest fraction
 * 1 / 2^p (p = 0..8, so denominators 1, 2, 4, ... 256).
 */

const RAD_DEG = 180 / Math.PI;
const DEGREE = '°';

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/**
 * Fixed-point string with `precision` decimals. With trimZeros, trailing
 * zeros (and a bare decimal point) are removed. Never returns '-0'.
 */
export function formatNumber(value, precision = 4, trimZeros = false) {
  if (!Number.isFinite(value)) return String(value);
  let s = value.toFixed(clampInt(precision, 0, 12, 4));
  if (trimZeros && s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
  if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
  return s;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 'w n/d', 'n/d' or 'w' from a whole part and a reduced fraction. */
function fractionText(whole, num, den) {
  if (!num) return String(whole);
  const g = gcd(num, den);
  const f = `${num / g}/${den / g}`;
  return whole ? `${whole} ${f}` : f;
}

function linearOptions(o) {
  return {
    format: o?.format ?? o?.linearFormat ?? 'decimal',
    precision: o?.precision ?? o?.linearPrecision ?? 4,
    trimZeros: !!o?.trimZeros,
  };
}

/**
 * Format a length. `opts` is a drawing header or { format, precision,
 * trimZeros }. Formats: 'decimal' (12.5000), 'architectural' (3'-4 1/2"),
 * 'engineering' (3'-4.50"), 'fractional' (4 1/2), 'scientific' (1.2500E+01).
 * Feet are omitted below one foot in the architectural and engineering forms.
 */
export function formatLinear(value, opts) {
  const { format, precision, trimZeros } = linearOptions(opts);
  if (!Number.isFinite(value)) return String(value);
  const neg = value < 0;
  const v = Math.abs(value);
  switch (format) {
    case 'scientific': {
      const p = clampInt(precision, 0, 12, 4);
      const [m, e] = value.toExponential(p).split('e');
      const ex = Number(e);
      let mant = m;
      if (trimZeros && mant.indexOf('.') >= 0) mant = mant.replace(/\.?0+$/, '');
      return `${mant}E${ex < 0 ? '-' : '+'}${String(Math.abs(ex)).padStart(2, '0')}`;
    }
    case 'fractional': {
      const den = 2 ** clampInt(precision, 0, 8, 4);
      const n = Math.round(v * den);
      const whole = Math.floor(n / den);
      const s = fractionText(whole, n - whole * den, den);
      return neg && n ? '-' + s : s;
    }
    case 'architectural': {
      const den = 2 ** clampInt(precision, 0, 8, 4);
      const n = Math.round(v * den);
      const feet = Math.floor(n / (12 * den));
      const rem = n - feet * 12 * den;
      const whole = Math.floor(rem / den);
      const frac = rem - whole * den;
      const inch = fractionText(whole, frac, den);
      // After feet a bare fraction keeps its zero inches: 1'-0 1/2", not 1'-1/2".
      const s = feet ? `${feet}'-${!whole && frac ? '0 ' : ''}${inch}"` : `${inch}"`;
      return neg && n ? '-' + s : s;
    }
    case 'engineering': {
      const p = clampInt(precision, 0, 8, 4);
      const scale = 10 ** p;
      const n = Math.round(v * scale);
      const feet = Math.floor(n / (12 * scale));
      const inch = formatNumber((n - feet * 12 * scale) / scale, p, trimZeros);
      const s = feet ? `${feet}'-${inch}"` : `${inch}"`;
      return neg && n ? '-' + s : s;
    }
    default:
      return formatNumber(value, precision, trimZeros);
  }
}

/** Degrees as d/m/s text; precision 0 = degrees, 1..2 = minutes, 3..4 = seconds, more = decimal seconds. */
function formatDms(deg, precision, symbol) {
  const D = symbol ? DEGREE : 'd';
  const a = Math.abs(deg);
  const p = clampInt(precision, 0, 8, 0);
  let s;
  let zero;
  if (p === 0) {
    const t = Math.round(a);
    zero = t === 0;
    s = `${t}${D}`;
  } else if (p <= 2) {
    const t = Math.round(a * 60);
    zero = t === 0;
    s = `${Math.floor(t / 60)}${D}${t % 60}'`;
  } else {
    const sp = Math.max(0, p - 4);
    const k = 10 ** sp;
    const t = Math.round(a * 3600 * k);
    zero = t === 0;
    const d = Math.floor(t / (3600 * k));
    const rem = t - d * 3600 * k;
    const m = Math.floor(rem / (60 * k));
    const sec = (rem - m * 60 * k) / k;
    s = `${d}${D}${m}'${sec.toFixed(sp)}"`;
  }
  return deg < 0 && !zero ? '-' + s : s;
}

/**
 * Format an angle given in radians. `header` supplies angularFormat and
 * angularPrecision (or { format, precision }). Formats: 'deg' (30.5),
 * 'dms' (12d30'15"), 'rad' (0.5236r), 'grad' (13.89g).
 * opts.symbol uses the degree sign ('30.5°', 12°30'15"); opts.trimZeros trims
 * trailing decimal zeros.
 */
export function formatAngle(radians, header, opts = {}) {
  const fmt = header?.angularFormat ?? header?.format ?? 'deg';
  const p = header?.angularPrecision ?? header?.precision ?? 0;
  const trim = !!opts.trimZeros;
  switch (fmt) {
    case 'dms':
      return formatDms(radians * RAD_DEG, p, opts.symbol);
    case 'rad':
      return formatNumber(radians, p, trim) + 'r';
    case 'grad':
      return formatNumber((radians * 200) / Math.PI, p, trim) + 'g';
    default:
      return formatNumber(radians * RAD_DEG, p, trim) + (opts.symbol ? DEGREE : '');
  }
}

/**
 * A direction in [0, full turn) as displayed: one just below 0 reads 0, not
 * 360. Use formatAngle for measured angles, where a full turn is 360.
 */
export function formatDirection(radians, header, opts) {
  const tau = 2 * Math.PI;
  const text = formatAngle(((radians % tau) + tau) % tau, header, opts);
  return text === formatAngle(tau, header, opts) ? formatAngle(0, header, opts) : text;
}

const NUM_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const FRAC_RE = /^(\d+)\s*\/\s*(\d+)$/;
const MIXED_RE = /^(\d+)(?:\s*-\s*|\s+)(\d+)\s*\/\s*(\d+)$/;

/** Unsigned number, fraction (3/4) or mixed number (1-1/2, 1 1/2); NaN otherwise. */
function parseUnsigned(str) {
  const s = str.trim();
  if (NUM_RE.test(s)) return Number(s);
  let m = FRAC_RE.exec(s);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : NaN;
  m = MIXED_RE.exec(s);
  if (m) return Number(m[3]) ? Number(m[1]) + Number(m[2]) / Number(m[3]) : NaN;
  return NaN;
}

/** Strip a leading sign; returns [sign, rest]. */
function splitSign(str) {
  const s = String(str ?? '').trim();
  if (s[0] === '-') return [-1, s.slice(1).trim()];
  if (s[0] === '+') return [1, s.slice(1).trim()];
  return [1, s];
}

/** Feet and inch marks are accepted when a drawing unit is an inch. */
function feetInches(header) {
  const u = header?.units;
  if (u === 'in') return true;
  const f = header?.linearFormat ?? header?.format;
  return (u == null || u === 'unitless') && (f === 'architectural' || f === 'engineering');
}

/**
 * Parse a length typed by the user. Accepts plain and scientific numbers,
 * fractions (3/4) and mixed numbers (1-1/2, 1 1/2). In inch drawings it also
 * accepts feet and inches: 3'4", 3'-4 1/2", 5', 4.5". Returns NaN when invalid.
 */
export function parseLength(str, header) {
  if (typeof str === 'number') return Number.isFinite(str) ? str : NaN;
  const [sign, s] = splitSign(str);
  if (!s) return NaN;
  if (feetInches(header)) {
    const q = s.indexOf("'");
    if (q >= 0) {
      const feet = parseUnsigned(s.slice(0, q));
      let rest = s.slice(q + 1).trim();
      if (rest[0] === '-') rest = rest.slice(1).trim();
      if (rest.endsWith('"')) rest = rest.slice(0, -1).trim();
      const inches = rest ? parseUnsigned(rest) : 0;
      return sign * (feet * 12 + inches);
    }
    if (s.endsWith('"')) return sign * parseUnsigned(s.slice(0, -1));
  }
  return sign * parseUnsigned(s);
}

const DMS_RE =
  /^(\d+(?:\.\d*)?|\.\d+)\s*[d°]\s*(?:(\d+(?:\.\d*)?|\.\d+)\s*')?\s*(?:(\d+(?:\.\d*)?|\.\d+)\s*")?$/;

/**
 * Parse an angle and return radians (NaN when invalid). Accepts 30d15'10"
 * (or the degree sign), 1.2r (radians) and 50g (grads). A bare number is in
 * the header's angular unit: degrees unless angularFormat is 'rad' or 'grad'.
 */
export function parseAngle(str, header) {
  const [sign, raw] = splitSign(str);
  const s = raw.toLowerCase();
  if (!s) return NaN;
  const last = s[s.length - 1];
  if (last === 'r') return sign * parseUnsigned(s.slice(0, -1));
  if (last === 'g') return (sign * parseUnsigned(s.slice(0, -1)) * Math.PI) / 200;
  const m = DMS_RE.exec(s);
  if (m) {
    const deg = Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0) + (m[3] ? Number(m[3]) / 3600 : 0);
    return (sign * deg) / RAD_DEG;
  }
  const v = parseUnsigned(s);
  const fmt = header?.angularFormat;
  if (fmt === 'rad') return sign * v;
  if (fmt === 'grad') return (sign * v * Math.PI) / 200;
  return (sign * v) / RAD_DEG;
}
