/**
 * Units and numeric field parsing. Documents store lengths in points
 * (1/72 inch); fields show and accept the document's units. Fields accept
 * a unit suffix ("10 mm", "1in", "3p6" picas) and simple arithmetic
 * ("100/3", "2*36pt + 4").
 */

export const UNITS = {
  pt: { label: 'Points', factor: 1, digits: 3 },
  px: { label: 'Pixels', factor: 1, digits: 2 },
  in: { label: 'Inches', factor: 72, digits: 4 },
  mm: { label: 'Millimeters', factor: 72 / 25.4, digits: 3 },
  cm: { label: 'Centimeters', factor: 72 / 2.54, digits: 4 },
  pc: { label: 'Picas', factor: 12, digits: 3 },
};

export function toUnit(pt, unit) {
  return pt / (UNITS[unit]?.factor || 1);
}

export function fromUnit(v, unit) {
  return v * (UNITS[unit]?.factor || 1);
}

/** Format points in a unit: "12.5 mm". */
export function formatLength(pt, unit = 'pt', { suffix = true, digits } = {}) {
  const u = UNITS[unit] || UNITS.pt;
  const d = digits ?? Math.min(u.digits, 3);
  const v = Number(toUnit(pt, unit).toFixed(d));
  return suffix ? `${Object.is(v, -0) ? 0 : v} ${unit}` : String(Object.is(v, -0) ? 0 : v);
}

const TOKEN = /\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:\s*(pt|px|inches|inch|in|"|mm|cm|pc|p(?=\d)|deg|°|%))?|([-+*/()]))/y;

/**
 * Parse a length expression into points. Bare numbers use `unit`.
 * Returns NaN when the text is not a valid expression.
 */
/** Global parsing options: `bareUnit` reads numbers typed without a unit in that unit (Preferences). */
export const unitOptions = { bareUnit: null };

export function parseLength(text, unit = 'pt') {
  return evaluate(String(text ?? ''), (num, suffix, rest) => {
    let u = suffix;
    if (u === 'inch' || u === 'inches' || u === '"') u = 'in';
    if (u === 'p') {
      // Picas-and-points notation: 3p6 = 3 picas + 6 points.
      const m = /^(\d+(?:\.\d*)?)/.exec(rest.value);
      const pts = m ? parseFloat(m[1]) : 0;
      if (m) rest.advance(m[0].length);
      return num * 12 + pts;
    }
    if (u === 'deg' || u === '°' || u === '%') return num;
    return fromUnit(num, u || unitOptions.bareUnit || unit);
  });
}

/** Parse a plain number expression (angles, percentages, counts). */
export function parseNumber(text) {
  return evaluate(String(text ?? ''), (num) => num);
}

/** Tiny recursive-descent evaluator for + - * / and parentheses. */
function evaluate(src, valueOf) {
  let pos = 0;
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) return NaN;
    pos = TOKEN.lastIndex;
    if (m[3]) tokens.push({ op: m[3] });
    else {
      const rest = {
        get value() {
          return src.slice(pos);
        },
        advance(n) {
          pos += n;
        },
      };
      tokens.push({ v: valueOf(parseFloat(m[1]), m[2], rest) });
    }
  }
  let i = 0;
  const peek = () => tokens[i];
  const expr = () => {
    let v = term();
    while (peek() && (peek().op === '+' || peek().op === '-')) {
      const op = tokens[i++].op;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const term = () => {
    let v = factor();
    while (peek() && (peek().op === '*' || peek().op === '/')) {
      const op = tokens[i++].op;
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const factor = () => {
    const t = tokens[i++];
    if (!t) return NaN;
    if (t.op === '-') return -factor();
    if (t.op === '+') return factor();
    if (t.op === '(') {
      const v = expr();
      if (peek()?.op === ')') i++;
      return v;
    }
    return t.v ?? NaN;
  };
  if (!tokens.length) return NaN;
  const v = expr();
  return i === tokens.length && Number.isFinite(v) ? v : NaN;
}
