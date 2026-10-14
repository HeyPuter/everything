/**
 * Lengths are stored in millimetres. Projects display them either in
 * imperial feet and inches (with a fractional precision) or in metric
 * millimetres, centimetres or metres.
 *
 * units: { system: 'imperial' | 'metric', metric: 'mm' | 'cm' | 'm', fraction: 8, decimals: 0 }
 */

export const MM_PER_INCH = 25.4;
export const MM_PER_FOOT = 304.8;

export const DEFAULT_UNITS = Object.freeze({ system: 'metric', metric: 'mm', fraction: 8, decimals: 0 });

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Feet and inches, e.g. 10' - 6 1/2". `fraction` is the denominator of the rounding. */
export function formatImperial(mm, fraction = 8, { feet = true } = {}) {
  if (!Number.isFinite(mm)) return '';
  const neg = mm < 0;
  let totalUnits = Math.round((Math.abs(mm) / MM_PER_INCH) * fraction);
  const unitsPerFoot = 12 * fraction;
  let ft = feet ? Math.floor(totalUnits / unitsPerFoot) : 0;
  totalUnits -= ft * unitsPerFoot;
  const inches = Math.floor(totalUnits / fraction);
  let num = totalUnits - inches * fraction;
  let den = fraction;
  if (num) {
    const g = gcd(num, den);
    num /= g;
    den /= g;
  }
  const inchText = `${inches}${num ? ` ${num}/${den}` : ''}"`;
  const s = feet ? `${ft}' - ${inchText}` : inchText;
  return neg ? `-${s}` : s;
}

export function formatMetric(mm, unit = 'mm', decimals = 0) {
  if (!Number.isFinite(mm)) return '';
  const div = unit === 'm' ? 1000 : unit === 'cm' ? 10 : 1;
  const v = mm / div;
  const d = unit === 'm' ? Math.max(decimals, 3) : decimals;
  let s = v.toFixed(d);
  if (s.includes('.') && unit === 'm') s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return unit === 'mm' ? s : `${s} ${unit}`;
}

/** Display a length using the project's units. */
export function formatLength(mm, units = DEFAULT_UNITS) {
  return units.system === 'imperial' ? formatImperial(mm, units.fraction || 8) : formatMetric(mm, units.metric || 'mm', units.decimals || 0);
}

/** Dimension text: metric dimensions omit the unit, as on drawings. */
export function formatDimension(mm, units = DEFAULT_UNITS) {
  if (units.system === 'imperial') return formatImperial(mm, units.fraction || 8);
  const div = units.metric === 'm' ? 1000 : units.metric === 'cm' ? 10 : 1;
  const d = units.metric === 'm' ? Math.max(2, units.decimals || 0) : units.decimals || 0;
  return (mm / div).toFixed(d);
}

export function formatArea(mm2, units = DEFAULT_UNITS) {
  if (!Number.isFinite(mm2)) return '';
  if (units.system === 'imperial') return `${(mm2 / (MM_PER_FOOT * MM_PER_FOOT)).toFixed(0)} SF`;
  return `${(mm2 / 1e6).toFixed(2)} m²`;
}

export function formatVolume(mm3, units = DEFAULT_UNITS) {
  if (!Number.isFinite(mm3)) return '';
  if (units.system === 'imperial') return `${(mm3 / MM_PER_FOOT ** 3).toFixed(2)} CF`;
  return `${(mm3 / 1e9).toFixed(2)} m³`;
}

export function formatAngle(rad, decimals = 2) {
  let deg = (rad * 180) / Math.PI;
  deg = Math.round(deg * 10 ** decimals) / 10 ** decimals;
  return `${deg}°`;
}

export function formatSlope(deg) {
  return `${Math.round(deg * 100) / 100}°`;
}

/**
 * Parse a typed length. Accepts feet and inches (10' 6", 10'-6 1/2", 6",
 * 10.5'), metric with a unit (3.2m, 350cm, 2400mm) and bare numbers, which
 * are read in the project's default unit (inches never; bare numbers in
 * imperial projects are feet, as in most building tools). Sums and
 * differences are allowed: 3000 + 250, 10' - 6". Returns NaN when invalid.
 */
export function parseLength(text, units = DEFAULT_UNITS) {
  if (typeof text === 'number') return text;
  let s = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[’′]/g, "'")
    .replace(/[”″]/g, '"')
    .replace(/,/g, '.');
  if (!s) return NaN;
  // Feet-inch separators: 10'-6" and 10' - 6" both mean ten feet six inches.
  s = s.replace(/'\s*-\s*(?=\d)/g, "' ");
  const terms = [];
  let sign = 1;
  let rest = s;
  const re = /^\s*([+-])?\s*/;
  while (rest.length) {
    const m = re.exec(rest);
    if (m[1]) sign = m[1] === '-' ? -1 : 1;
    rest = rest.slice(m[0].length);
    if (!rest) break;
    const t = parseTerm(rest, units);
    if (!t) return NaN;
    terms.push(sign * t.value);
    rest = rest.slice(t.length);
    sign = 1;
    const op = /^\s*([+-])/.exec(rest);
    if (!op && rest.trim()) {
      // Two lengths without an operator: 10' 6" (feet then inches) add up.
      continue;
    }
  }
  if (!terms.length) return NaN;
  return terms.reduce((a, b) => a + b, 0);
}

const NUM = String.raw`(\d+(?:\.\d*)?|\.\d+)`;
const FRAC = String.raw`(?:\s+(\d+)\/(\d+)|\s*(\d+)\/(\d+))`;

function parseTerm(s, units) {
  let m;
  // Inches with an optional fraction: 6", 6 1/2", 1/2"
  if ((m = new RegExp(`^${NUM}(?:\\s+(\\d+)\\/(\\d+))?\\s*(?:"|in(?:ch(?:es)?)?\\b)`).exec(s))) {
    let v = parseFloat(m[1]);
    if (m[2]) v += parseInt(m[2], 10) / parseInt(m[3], 10);
    return { value: v * MM_PER_INCH, length: m[0].length };
  }
  if ((m = /^(\d+)\/(\d+)\s*(?:"|in\b)/.exec(s))) {
    return { value: (parseInt(m[1], 10) / parseInt(m[2], 10)) * MM_PER_INCH, length: m[0].length };
  }
  // Feet: 10', 10.5ft
  if ((m = new RegExp(`^${NUM}\\s*(?:'|ft\\b|feet\\b|foot\\b)`).exec(s))) {
    return { value: parseFloat(m[1]) * MM_PER_FOOT, length: m[0].length };
  }
  // Metric with unit
  if ((m = new RegExp(`^${NUM}\\s*(mm|cm|m)\\b`).exec(s))) {
    const f = m[2] === 'm' ? 1000 : m[2] === 'cm' ? 10 : 1;
    return { value: parseFloat(m[1]) * f, length: m[0].length };
  }
  // Bare number, possibly with a fraction (imperial inches after feet are handled above).
  if ((m = new RegExp(`^${NUM}${FRAC}?`).exec(s))) {
    let v = parseFloat(m[1]);
    const fn = m[2] || m[4];
    const fd = m[3] || m[5];
    if (fn) v += parseInt(fn, 10) / parseInt(fd, 10);
    if (units.system === 'imperial') v *= MM_PER_FOOT;
    else v *= units.metric === 'm' ? 1000 : units.metric === 'cm' ? 10 : 1;
    return { value: v, length: m[0].length };
  }
  return null;
}

/** Parse an angle in degrees ("45", "45°", "-30 deg"). Returns radians or NaN. */
export function parseAngle(text) {
  const m = /^\s*(-?\d+(?:\.\d*)?|-?\.\d+)\s*(?:°|deg|degrees)?\s*$/i.exec(String(text ?? ''));
  return m ? (parseFloat(m[1]) * Math.PI) / 180 : NaN;
}

/** Common drawing scales: value is the ratio denominator. */
export const SCALES_METRIC = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
export const SCALES_IMPERIAL = [
  { label: '12" = 1\'-0"', value: 1 },
  { label: '6" = 1\'-0"', value: 2 },
  { label: '3" = 1\'-0"', value: 4 },
  { label: '1 1/2" = 1\'-0"', value: 8 },
  { label: '1" = 1\'-0"', value: 12 },
  { label: '3/4" = 1\'-0"', value: 16 },
  { label: '1/2" = 1\'-0"', value: 24 },
  { label: '3/8" = 1\'-0"', value: 32 },
  { label: '1/4" = 1\'-0"', value: 48 },
  { label: '3/16" = 1\'-0"', value: 64 },
  { label: '1/8" = 1\'-0"', value: 96 },
  { label: '1/16" = 1\'-0"', value: 192 },
  { label: '1/32" = 1\'-0"', value: 384 },
];

export function scaleLabel(value, units = DEFAULT_UNITS) {
  if (units.system === 'imperial') {
    const s = SCALES_IMPERIAL.find((x) => x.value === value);
    if (s) return s.label;
  }
  return `1 : ${value}`;
}

export function scaleOptions(units = DEFAULT_UNITS) {
  return units.system === 'imperial' ? SCALES_IMPERIAL : SCALES_METRIC.map((v) => ({ label: `1 : ${v}`, value: v }));
}

/** Round a model length to a sensible increment for snapping while drawing. */
export function snapIncrement(mmPerPixel, units = DEFAULT_UNITS) {
  if (units.system === 'imperial') {
    const steps = [MM_PER_INCH / 8, MM_PER_INCH / 4, MM_PER_INCH / 2, MM_PER_INCH, MM_PER_INCH * 3, MM_PER_INCH * 6, MM_PER_FOOT, MM_PER_FOOT * 5, MM_PER_FOOT * 10];
    return steps.find((s) => s >= mmPerPixel * 4) ?? steps.at(-1);
  }
  const steps = [1, 5, 10, 50, 100, 500, 1000, 5000];
  return steps.find((s) => s >= mmPerPixel * 4) ?? steps.at(-1);
}
