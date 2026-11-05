/**
 * Single-stroke (centerline) vector font for drafting text.
 *
 * Glyph space: the baseline is y = 0, cap height is 1, x-height is 0.7 and
 * descenders reach -0.3. Text of height h is drawn by scaling glyph space by
 * h. Every glyph is a list of open polylines; closed shapes repeat their
 * first point. Curves are generated from elliptical arcs when the module
 * loads, then everything is packed into typed arrays:
 *
 *   COORDS         Float32Array  all stroke points, flat [x, y, ...]; x already
 *                                includes the glyph's left side bearing
 *   STROKE_STARTS  Uint32Array   stroke k occupies COORDS[STROKE_STARTS[k] ..
 *                                STROKE_STARTS[k + 1])
 *   GLYPH_STROKES  Uint32Array   glyph g owns strokes GLYPH_STROKES[g] ..
 *                                GLYPH_STROKES[g + 1] - 1
 *   ADVANCES       Float32Array  proportional advance width per glyph
 *   GLYPH_BOUNDS   Float32Array  ink bounds per glyph [minX, minY, maxX, maxY]
 *   MONO_SCALE,    Float32Array  for the 'mono' variant a glyph point x maps to
 *   MONO_SHIFT                   x * MONO_SCALE[g] + MONO_SHIFT[g] inside a cell
 *                                of MONO_ADVANCE (wide glyphs are narrowed)
 */

export const CAP_HEIGHT = 1;
export const X_HEIGHT = 0.7;
export const DESCENDER = -0.3;
/** Fixed advance of the 'mono' variant. */
export const MONO_ADVANCE = 0.86;

/** Default side bearing. */
const SB = 0.12;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Build-time helpers. Angles are in degrees, counter-clockwise from +X; an arc
// runs from a0 to a1 in whichever direction the sign of (a1 - a0) gives.

/** Points along an elliptical arc; 3 to 8 segments per quarter turn by size. */
function arc(cx, cy, rx, ry, a0, a1) {
  const sweep = a1 - a0;
  const q = Math.max(3, Math.min(8, Math.round(Math.max(rx, ry) * 40)));
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / 90) * q));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (a0 + (sweep * i) / n) * DEG;
    out.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
  }
  return out;
}

/** Closed ellipse starting at the top. */
function ellipse(cx, cy, rx, ry) {
  return arc(cx, cy, rx, ry, 90, 450);
}

/** A small closed ring used for dots (i, j, punctuation). */
function dot(x, y) {
  return arc(x, y, 0.04, 0.04, 90, 450);
}

/** Concatenate flat point lists into one polyline, dropping repeated joints. */
function cat(...parts) {
  const out = [];
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 2) {
      const n = out.length;
      if (n && Math.abs(out[n - 2] - p[i]) < 1e-9 && Math.abs(out[n - 1] - p[i + 1]) < 1e-9) continue;
      out.push(p[i], p[i + 1]);
    }
  }
  return out;
}

/** Mirror strokes left to right within a body of width w. */
function mirror(strokes, w) {
  return strokes.map((s) => s.map((v, i) => (i & 1 ? v : w - v)));
}

/** Scale then translate strokes. */
function xform(strokes, k, dx, dy) {
  return strokes.map((s) => s.map((v, i) => (i & 1 ? v * k + dy : v * k + dx)));
}

// ---------------------------------------------------------------------------
// Glyph definitions. Body coordinates start at x = 0; the left side bearing is
// added when packing. def(char, bodyWidth, strokes, lsb, rsb).

const DEFS = [];
function def(ch, width, strokes, lsb = SB, rsb = SB) {
  DEFS.push({ cp: typeof ch === 'number' ? ch : ch.codePointAt(0), width, strokes, lsb, rsb });
}

// Shared shapes.
const BOWL = ellipse(0.27, 0.35, 0.27, 0.35);
const ARCH = cat(arc(0.26, 0.44, 0.26, 0.26, 180, 0), [0.52, 0]);
const P_BOWL = cat([0, 1, 0.34, 1], arc(0.34, 0.74, 0.26, 0.26, 90, -90), [0, 0.48]);
const COMMA_TAIL = [0.08, 0.04, 0, -0.15];
const BRACE = [
  cat(
    arc(0.3, 0.88, 0.12, 0.12, 90, 180),
    arc(0, 0.52, 0.18, 0.12, 0, -90),
    arc(0, 0.28, 0.18, 0.12, 90, 0),
    arc(0.3, -0.08, 0.12, 0.12, 180, 270),
  ),
];
const PAREN = [arc(0.32, 0.4, 0.32, 0.66, 115, 245)];
const PAREN_W = 0.32 - 0.32 * Math.cos(115 * DEG);
const LESS = [[0.55, 0.85, 0, 0.5, 0.55, 0.15]];

const DIGITS = {
  0: [ellipse(0.28, 0.5, 0.28, 0.5)],
  1: [[0.1, 0.82, 0.3, 1, 0.3, 0]],
  2: [cat(arc(0.28, 0.72, 0.27, 0.28, 160, -40), [0, 0, 0.56, 0])],
  3: [cat(arc(0.27, 0.76, 0.25, 0.24, 150, -90), arc(0.28, 0.26, 0.28, 0.26, 90, -150)), [0.14, 0.52, 0.27, 0.52]],
  4: [[0.42, 0, 0.42, 1, 0, 0.3, 0.56, 0.3]],
  5: [cat([0.5, 1, 0.07, 1], arc(0.28, 0.33, 0.28, 0.33, 155, -150))],
  6: [cat(arc(0.28, 0.5, 0.28, 0.5, 55, 180), arc(0.28, 0.32, 0.28, 0.32, 180, 540))],
  7: [[0, 1, 0.56, 1, 0.18, 0]],
  8: [ellipse(0.28, 0.76, 0.24, 0.24), ellipse(0.28, 0.26, 0.28, 0.26)],
  9: [cat(arc(0.28, 0.5, 0.28, 0.5, 235, 360), arc(0.28, 0.68, 0.28, 0.32, 0, 360))],
};

// Space and punctuation.
def(' ', 0.26, []);
def('!', 0, [[0, 1, 0, 0.28], dot(0, 0.04)]);
def('"', 0.18, [[0, 1, 0, 0.75], [0.18, 1, 0.18, 0.75]]);
def('#', 0.68, [
  [0.18, 0.05, 0.28, 0.95],
  [0.4, 0.05, 0.5, 0.95],
  [0, 0.33, 0.62, 0.33],
  [0.06, 0.67, 0.68, 0.67],
]);
def('$', 0.58, [
  cat(arc(0.29, 0.67, 0.26, 0.18, 25, 270), arc(0.29, 0.32, 0.29, 0.17, 90, -155)),
  [0.29, 1, 0.29, 0],
]);
def('%', 0.66, [ellipse(0.14, 0.8, 0.14, 0.17), ellipse(0.52, 0.2, 0.14, 0.17), [0.62, 1, 0.04, 0]]);
def('&', 0.66, [
  cat([0.66, 0], arc(0.27, 0.8, 0.17, 0.2, 225, -45), arc(0.27, 0.24, 0.26, 0.24, 135, 370), [0.6, 0.42]),
]);
def("'", 0, [[0, 1, 0, 0.75]]);
def('(', PAREN_W, PAREN);
def(')', PAREN_W, mirror(PAREN, PAREN_W));
def('*', 0.5, [
  [0.25, 0.95, 0.25, 0.45],
  [0.0335, 0.825, 0.4665, 0.575],
  [0.0335, 0.575, 0.4665, 0.825],
]);
def('+', 0.6, [[0.3, 0.2, 0.3, 0.8], [0, 0.5, 0.6, 0.5]]);
def(',', 0.08, [dot(0.04, 0.04), COMMA_TAIL]);
def('-', 0.4, [[0, 0.45, 0.4, 0.45]]);
def('.', 0.08, [dot(0.04, 0.04)]);
def('/', 0.45, [[0, 0, 0.45, 1]]);
for (let d = 0; d <= 9; d++) def(String(d), 0.56, DIGITS[d]);
def(':', 0.08, [dot(0.04, 0.5), dot(0.04, 0.04)]);
def(';', 0.08, [dot(0.04, 0.5), dot(0.04, 0.04), COMMA_TAIL]);
def('<', 0.55, LESS);
def('=', 0.6, [[0, 0.36, 0.6, 0.36], [0, 0.64, 0.6, 0.64]]);
def('>', 0.55, mirror(LESS, 0.55));
def('?', 0.54, [cat(arc(0.27, 0.74, 0.27, 0.26, 160, -30), [0.27, 0.42, 0.27, 0.28]), dot(0.27, 0.04)]);
def('@', 0.9, [
  ellipse(0.42, 0.45, 0.17, 0.2),
  cat([0.59, 0.65, 0.59, 0.36], arc(0.7415, 0.36, 0.1515, 0.12, 180, 360), arc(0.45, 0.45, 0.45, 0.5, -10.37, 290)),
]);

// Capitals.
def('A', 0.7, [[0, 0, 0.35, 1, 0.7, 0], [0.105, 0.3, 0.595, 0.3]]);
def('B', 0.615, [
  [0, 0, 0, 1],
  cat([0, 1, 0.32, 1], arc(0.32, 0.765, 0.235, 0.235, 90, -90), [0, 0.53]),
  cat([0, 0.53, 0.35, 0.53], arc(0.35, 0.265, 0.265, 0.265, 90, -90), [0, 0]),
]);
def('C', 0.65, [arc(0.36, 0.5, 0.36, 0.5, 42, 318)]);
def('D', 0.65, [cat([0, 0, 0, 1, 0.3, 1], arc(0.3, 0.5, 0.35, 0.5, 90, -90), [0, 0])]);
def('E', 0.56, [[0.56, 1, 0, 1, 0, 0, 0.56, 0], [0, 0.52, 0.46, 0.52]]);
def('F', 0.56, [[0.56, 1, 0, 1, 0, 0], [0, 0.52, 0.46, 0.52]]);
def('G', 0.72, [cat(arc(0.36, 0.5, 0.36, 0.5, 42, 360), [0.42, 0.5])]);
def('H', 0.62, [[0, 0, 0, 1], [0.62, 0, 0.62, 1], [0, 0.52, 0.62, 0.52]]);
def('I', 0, [[0, 0, 0, 1]]);
def('J', 0.46, [cat([0.46, 1], arc(0.23, 0.25, 0.23, 0.25, 0, -180))]);
def('K', 0.62, [[0, 0, 0, 1], [0.6, 1, 0, 0.38], [0.2, 0.587, 0.62, 0]]);
def('L', 0.54, [[0, 1, 0, 0, 0.54, 0]]);
def('M', 0.76, [[0, 0, 0, 1, 0.38, 0.22, 0.76, 1, 0.76, 0]]);
def('N', 0.62, [[0, 0, 0, 1, 0.62, 0, 0.62, 1]]);
def('O', 0.74, [ellipse(0.37, 0.5, 0.37, 0.5)]);
def('P', 0.6, [[0, 0, 0, 1], P_BOWL]);
def('Q', 0.76, [ellipse(0.37, 0.5, 0.37, 0.5), [0.44, 0.22, 0.76, -0.06]]);
def('R', 0.62, [[0, 0, 0, 1], P_BOWL, [0.3, 0.48, 0.62, 0]]);
def('S', 0.62, [cat(arc(0.31, 0.75, 0.28, 0.25, 25, 270), arc(0.31, 0.25, 0.31, 0.25, 90, -155))]);
def('T', 0.64, [[0, 1, 0.64, 1], [0.32, 1, 0.32, 0]]);
def('U', 0.62, [cat([0, 1], arc(0.31, 0.31, 0.31, 0.31, 180, 360), [0.62, 1])]);
def('V', 0.66, [[0, 1, 0.33, 0, 0.66, 1]]);
def('W', 0.9, [[0, 1, 0.22, 0, 0.45, 0.78, 0.68, 0, 0.9, 1]]);
def('X', 0.62, [[0, 1, 0.62, 0], [0, 0, 0.62, 1]]);
def('Y', 0.64, [[0, 1, 0.32, 0.5, 0.64, 1], [0.32, 0.5, 0.32, 0]]);
def('Z', 0.6, [[0, 1, 0.6, 1, 0, 0, 0.6, 0]]);

def('[', 0.2, [[0.2, 1, 0, 1, 0, -0.2, 0.2, -0.2]]);
def('\\', 0.45, [[0, 1, 0.45, 0]]);
def(']', 0.2, [[0, 1, 0.2, 1, 0.2, -0.2, 0, -0.2]]);
def('^', 0.5, [[0, 0.7, 0.25, 1, 0.5, 0.7]]);
def('_', 0.6, [[0, -0.15, 0.6, -0.15]], 0.05, 0.05);
def('`', 0.12, [[0, 1, 0.12, 0.85]]);

// Lowercase.
def('a', 0.54, [BOWL, [0.54, 0.7, 0.54, 0]]);
def('b', 0.54, [[0, 1, 0, 0], BOWL]);
def('c', 0.5, [arc(0.27, 0.35, 0.27, 0.35, 40, 320)]);
def('d', 0.54, [BOWL, [0.54, 1, 0.54, 0]]);
def('e', 0.54, [cat([0, 0.35], arc(0.27, 0.35, 0.27, 0.35, 0, 320))]);
def('f', 0.44, [cat([0.14, 0], arc(0.32, 0.82, 0.18, 0.18, 180, 60)), [0, 0.7, 0.36, 0.7]]);
def('g', 0.54, [BOWL, cat([0.54, 0.7], arc(0.27, -0.1, 0.27, 0.2, 0, -155))]);
def('h', 0.52, [[0, 1, 0, 0], ARCH]);
def('i', 0, [[0, 0.7, 0, 0], dot(0, 0.92)]);
def('j', 0.2, [cat([0.2, 0.7], arc(0.05, -0.15, 0.15, 0.15, 0, -160)), dot(0.2, 0.92)], 0.06);
def('k', 0.52, [[0, 1, 0, 0], [0.5, 0.7, 0, 0.24], [0.17, 0.396, 0.52, 0]]);
def('l', 0, [[0, 1, 0, 0]]);
def('m', 0.8, [
  [0, 0.7, 0, 0],
  cat(arc(0.2, 0.5, 0.2, 0.2, 180, 0), [0.4, 0]),
  cat(arc(0.6, 0.5, 0.2, 0.2, 180, 0), [0.8, 0]),
]);
def('n', 0.52, [[0, 0.7, 0, 0], ARCH]);
def('o', 0.54, [BOWL]);
def('p', 0.54, [[0, 0.7, 0, -0.3], BOWL]);
def('q', 0.54, [BOWL, [0.54, 0.7, 0.54, -0.3]]);
def('r', 0.42, [[0, 0.7, 0, 0], arc(0.28, 0.42, 0.28, 0.28, 180, 60)]);
def('s', 0.5, [cat(arc(0.25, 0.53, 0.23, 0.17, 25, 270), arc(0.25, 0.18, 0.25, 0.18, 90, -155))]);
def('t', 0.4, [cat([0.14, 0.92], arc(0.32, 0.15, 0.18, 0.15, 180, 290)), [0, 0.7, 0.36, 0.7]]);
def('u', 0.52, [cat([0, 0.7], arc(0.26, 0.26, 0.26, 0.26, 180, 360)), [0.52, 0.7, 0.52, 0]]);
def('v', 0.56, [[0, 0.7, 0.28, 0, 0.56, 0.7]]);
def('w', 0.76, [[0, 0.7, 0.18, 0, 0.38, 0.55, 0.58, 0, 0.76, 0.7]]);
def('x', 0.52, [[0, 0.7, 0.52, 0], [0, 0, 0.52, 0.7]]);
def('y', 0.56, [[0, 0.7, 0.28, 0], [0.56, 0.7, 0.16, -0.3]]);
def('z', 0.5, [[0, 0.7, 0.5, 0.7, 0, 0, 0.5, 0]]);

def('{', 0.3, BRACE);
def('|', 0, [[0, 1, 0, -0.2]]);
def('}', 0.3, mirror(BRACE, 0.3));
def('~', 0.6, [cat(arc(0.15, 0.5, 0.15, 0.1, 180, 0), arc(0.45, 0.5, 0.15, 0.1, 180, 360))]);

// Drafting symbols and a few extras.
def(0x00b0, 0.26, [ellipse(0.13, 0.86, 0.13, 0.13)]);
def(0x00b1, 0.6, [[0.3, 0.3, 0.3, 0.9], [0, 0.6, 0.6, 0.6], [0, 0.1, 0.6, 0.1]]);
def(0x2300, 0.76, [ellipse(0.38, 0.5, 0.34, 0.34), [0, 0.05, 0.76, 0.95]]);
def(0x00b2, 0.31, xform(DIGITS[2], 0.55, 0, 0.45), 0.08, 0.08);
def(0x00b3, 0.31, xform(DIGITS[3], 0.55, 0, 0.45), 0.08, 0.08);
def(0x00d7, 0.5, [[0, 0.25, 0.5, 0.75], [0, 0.75, 0.5, 0.25]]);

// Latin letters with diacritics: the base letter plus a mark drawn above it
// (clear of its ink) or below the baseline. i and j lose their dot.
const MARKS = {
  0x300: (c, y) => [[c - 0.09, y + 0.17, c + 0.05, y]],
  0x301: (c, y) => [[c - 0.05, y, c + 0.09, y + 0.17]],
  0x302: (c, y) => [[c - 0.13, y, c, y + 0.15, c + 0.13, y]],
  0x303: (c, y) => [
    cat(arc(c - 0.07, y + 0.07, 0.07, 0.06, 180, 0), arc(c + 0.07, y + 0.07, 0.07, 0.06, 180, 360)),
  ],
  0x304: (c, y) => [[c - 0.14, y + 0.07, c + 0.14, y + 0.07]],
  0x306: (c, y) => [arc(c, y + 0.15, 0.12, 0.13, 180, 360)],
  0x307: (c, y) => [dot(c, y + 0.07)],
  0x308: (c, y) => [dot(c - 0.1, y + 0.07), dot(c + 0.1, y + 0.07)],
  0x30a: (c, y) => [ellipse(c, y + 0.09, 0.08, 0.08)],
  0x30b: (c, y) => [
    [c - 0.11, y, c - 0.01, y + 0.17],
    [c + 0.03, y, c + 0.13, y + 0.17],
  ],
  0x30c: (c, y) => [[c - 0.13, y + 0.15, c, y, c + 0.13, y + 0.15]],
};
const MARKS_BELOW = {
  0x326: (c) => [[c + 0.03, -0.07, c - 0.03, -0.2]],
  0x327: (c) => [[c, 0, c, -0.07, c + 0.08, -0.12, c + 0.03, -0.2, c - 0.06, -0.2]],
  0x328: (c, w) => [[w, 0, w - 0.08, -0.08, w - 0.06, -0.17, w + 0.04, -0.2]],
};
{
  const byCp = new Map(DEFS.map((d) => [d.cp, d]));
  const add = (cp) => {
    const [base, mark, more] = String.fromCodePoint(cp).normalize('NFD');
    const d = base && !more ? byCp.get(base.codePointAt(0)) : null;
    const m = mark?.charCodeAt(0);
    if (!d || base.codePointAt(0) > 0x7a || !(MARKS[m] || MARKS_BELOW[m])) return;
    let strokes = d.strokes;
    if (base === 'i' || base === 'j') strokes = strokes.slice(0, 1);
    let top = 0,
      bottom = 0;
    for (const st of strokes) {
      for (let k = 1; k < st.length; k += 2) {
        top = Math.max(top, st[k]);
        bottom = Math.min(bottom, st[k]);
      }
    }
    const c = d.width / 2;
    let extra;
    if (MARKS[m]) extra = MARKS[m](c, top + 0.08);
    else if (bottom < -0.01) return;
    else extra = MARKS_BELOW[m](c, d.width);
    def(cp, d.width, [...strokes, ...extra], d.lsb, d.rsb);
  };
  for (let cp = 0xc0; cp <= 0x17f; cp++) add(cp);
  for (let cp = 0x218; cp <= 0x21b; cp++) add(cp);
}

// Letters without a decomposition, Greek letters used in engineering, and
// common symbols and punctuation.
const E_TAIL = (x) => cat([x, 0.35, x + 0.54, 0.35], arc(x + 0.27, 0.35, 0.27, 0.35, 0, 320));
const C_OPEN = (x) => arc(x + 0.36, 0.5, 0.36, 0.5, 90, 270);
def(0x131, 0, [[0, 0.7, 0, 0]]);
def(0xdf, 0.54, [
  cat(
    [0, 0, 0, 0.76],
    arc(0.21, 0.76, 0.21, 0.24, 180, 0),
    [0.16, 0.52],
    arc(0.26, 0.26, 0.28, 0.26, 90, -140),
  ),
]);
def(0xc6, 1, [
  [0, 0, 0.5, 1, 1, 1],
  [0.5, 1, 0.5, 0, 1, 0],
  [0.5, 0.52, 0.92, 0.52],
  [0.2, 0.4, 0.5, 0.4],
]);
def(0xe6, 1.08, [BOWL, [0.54, 0.7, 0.54, 0], E_TAIL(0.54)]);
def(0x152, 1.1, [
  cat([0.62, 1, 0.36, 1], C_OPEN(0), [0.62, 0]),
  [1.1, 1, 0.62, 1, 0.62, 0, 1.1, 0],
  [0.62, 0.52, 1.02, 0.52],
]);
def(0x153, 1.08, [BOWL, E_TAIL(0.54)]);
def(0xd8, 0.74, [ellipse(0.37, 0.5, 0.37, 0.5), [0.04, 0, 0.7, 1]]);
def(0xf8, 0.54, [BOWL, [0.02, 0, 0.52, 0.7]]);
def(0x141, 0.54, [[0, 1, 0, 0, 0.54, 0], [-0.08, 0.4, 0.16, 0.58]]);
def(0x142, 0, [[0, 1, 0, 0], [-0.1, 0.42, 0.1, 0.62]]);
def(0x110, 0.65, [
  cat([0, 0, 0, 1, 0.3, 1], arc(0.3, 0.5, 0.35, 0.5, 90, -90), [0, 0]),
  [-0.08, 0.5, 0.2, 0.5],
]);
def(0x111, 0.6, [BOWL, [0.54, 1, 0.54, 0], [0.38, 0.86, 0.66, 0.86]]);
def(0xb5, 0.52, [[0, 0.7, 0, -0.3], arc(0.26, 0.26, 0.26, 0.26, 180, 360), [0.52, 0.7, 0.52, 0]]);
def(0x394, 0.7, [[0, 0, 0.35, 1, 0.7, 0, 0, 0]]);
def(0x3a3, 0.58, [[0.58, 1, 0, 1, 0.3, 0.5, 0, 0, 0.58, 0]]);
def(0x3a9, 0.72, [cat([0, 0, 0.24, 0], arc(0.36, 0.56, 0.36, 0.44, 238, -58), [0.48, 0, 0.72, 0])]);
def(0x3c0, 0.56, [[0, 0.7, 0.56, 0.7], [0.14, 0.7, 0.14, 0], [0.42, 0.7, 0.42, 0]]);
def(0x20ac, 0.66, [arc(0.4, 0.5, 0.34, 0.5, 42, 318), [0, 0.6, 0.5, 0.6], [0, 0.4, 0.46, 0.4]]);
def(0xa3, 0.58, [
  cat(arc(0.37, 0.78, 0.2, 0.22, 10, 180), [0.17, 0.25, 0.05, 0, 0.58, 0]),
  [0, 0.48, 0.42, 0.48],
]);
def(0xa5, 0.64, [
  [0, 1, 0.32, 0.5, 0.64, 1],
  [0.32, 0.5, 0.32, 0],
  [0.1, 0.38, 0.54, 0.38],
  [0.1, 0.2, 0.54, 0.2],
]);
def(0xa2, 0.5, [arc(0.27, 0.35, 0.27, 0.35, 40, 320), [0.27, 0.82, 0.27, -0.12]]);
def(0xa9, 0.9, [ellipse(0.45, 0.5, 0.45, 0.5), arc(0.47, 0.5, 0.2, 0.24, 42, 318)]);
def(0xae, 0.9, [
  ellipse(0.45, 0.5, 0.45, 0.5),
  [0.32, 0.24, 0.32, 0.76],
  cat([0.32, 0.76, 0.48, 0.76], arc(0.48, 0.64, 0.12, 0.12, 90, -90), [0.32, 0.52]),
  [0.46, 0.52, 0.6, 0.24],
]);
def(0x2122, 0.7, [
  [0, 1, 0.3, 1],
  [0.15, 1, 0.15, 0.6],
  [0.4, 0.6, 0.4, 1, 0.55, 0.75, 0.7, 1, 0.7, 0.6],
]);
const GUILLEMET = [
  [0.22, 0.6, 0, 0.35, 0.22, 0.1],
  [0.48, 0.6, 0.26, 0.35, 0.48, 0.1],
];
def(0xab, 0.48, GUILLEMET);
def(0xbb, 0.48, mirror(GUILLEMET, 0.48));
def(0xb7, 0.08, [dot(0.04, 0.45)]);
def(0xb9, 0.31, xform(DIGITS[1], 0.55, 0, 0.45), 0.08, 0.08);
def(0xf7, 0.6, [[0, 0.5, 0.6, 0.5], dot(0.3, 0.75), dot(0.3, 0.25)]);
def(0xa1, 0, [dot(0, 0.66), [0, 0.42, 0, -0.3]]);
// Inverted '?' turned about the middle of the x-height.
const QUESTION = DEFS.find((d) => d.cp === 0x3f).strokes;
def(0xbf, 0.54, QUESTION.map((st) => st.map((v, i) => (i & 1 ? 0.7 - v : 0.54 - v))));
def(0x2013, 0.5, [[0, 0.45, 0.5, 0.45]]);
def(0x2014, 0.9, [[0, 0.45, 0.9, 0.45]]);
def(0x2026, 0.56, [dot(0.04, 0.04), dot(0.28, 0.04), dot(0.52, 0.04)]);
def(0x2022, 0.2, [ellipse(0.1, 0.45, 0.1, 0.1)]);

// Fallback box for characters the font does not cover.
const FALLBACK_CP = -1;
def(FALLBACK_CP, 0.6, [[0, 0, 0.6, 0, 0.6, 1, 0, 1, 0, 0]]);

/** Code points drawn with another glyph. */
const ALIASES = [
  [0x00a0, 0x20],
  [0x2205, 0x2300],
  [0x2009, 0x20],
  [0x202f, 0x20],
  [0x2010, 0x2d],
  [0x2011, 0x2d],
  [0x2212, 0x2d],
  [0x2018, 0x27],
  [0x2019, 0x27],
  [0x201a, 0x2c],
  [0x2032, 0x27],
  [0x201c, 0x22],
  [0x201d, 0x22],
  [0x2033, 0x22],
  [0x3bc, 0xb5],
  [0x2126, 0x3a9],
  [0x2206, 0x394],
  [0xd0, 0x110],
];

// ---------------------------------------------------------------------------
// Packing.

export const GLYPH_COUNT = DEFS.length;
/** Code point of each glyph (-1 for the fallback box). */
export const GLYPH_CODES = new Int32Array(GLYPH_COUNT);
export const ADVANCES = new Float32Array(GLYPH_COUNT);
export const GLYPH_BOUNDS = new Float32Array(GLYPH_COUNT * 4);
export const GLYPH_STROKES = new Uint32Array(GLYPH_COUNT + 1);
export const MONO_SCALE = new Float32Array(GLYPH_COUNT);
export const MONO_SHIFT = new Float32Array(GLYPH_COUNT);

let strokeTotal = 0;
let coordTotal = 0;
for (const d of DEFS) {
  strokeTotal += d.strokes.length;
  for (const s of d.strokes) coordTotal += s.length;
}
export const STROKE_STARTS = new Uint32Array(strokeTotal + 1);
export const COORDS = new Float32Array(coordTotal);

const ASCII = new Int16Array(128).fill(-1);
const EXTRA = new Map();

{
  let k = 0;
  let c = 0;
  DEFS.forEach((d, g) => {
    GLYPH_CODES[g] = d.cp;
    const adv = d.lsb + d.width + d.rsb;
    ADVANCES[g] = adv;
    GLYPH_STROKES[g] = k;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const s of d.strokes) {
      STROKE_STARTS[k++] = c;
      for (let i = 0; i < s.length; i += 2) {
        const x = s[i] + d.lsb,
          y = s[i + 1];
        COORDS[c++] = x;
        COORDS[c++] = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x0 === Infinity) x0 = y0 = x1 = y1 = 0;
    GLYPH_BOUNDS.set([x0, y0, x1, y1], g * 4);
    // Narrow glyphs whose ink would crowd the fixed cell, then center them.
    const room = MONO_ADVANCE - 2 * SB;
    const scale = x1 - x0 > room ? room / (x1 - x0) : 1;
    MONO_SCALE[g] = scale;
    MONO_SHIFT[g] = (MONO_ADVANCE - adv * scale) / 2;
    if (d.cp >= 0 && d.cp < 128) ASCII[d.cp] = g;
    else if (d.cp >= 0) EXTRA.set(d.cp, g);
  });
  GLYPH_STROKES[GLYPH_COUNT] = k;
  STROKE_STARTS[strokeTotal] = c;
}

/** Glyph index of the fallback box. */
export const FALLBACK_GLYPH = GLYPH_COUNT - 1;
/** Glyph index of the space. */
export const SPACE_GLYPH = ASCII[32];

for (let i = 0; i < 32; i++) ASCII[i] = SPACE_GLYPH;
for (const [from, to] of ALIASES) EXTRA.set(from, to < 128 ? ASCII[to] : EXTRA.get(to));

/** Glyph index for a code point; control characters map to the space, unknown ones to the box. */
export function glyphIndex(cp) {
  if (cp < 128 && cp >= 0) {
    const g = ASCII[cp];
    return g < 0 ? FALLBACK_GLYPH : g;
  }
  const g = EXTRA.get(cp);
  return g === undefined ? FALLBACK_GLYPH : g;
}

/** True when the font draws this code point with its own glyph. */
export function hasGlyph(cp) {
  return glyphIndex(cp) !== FALLBACK_GLYPH;
}

/** Advance width of glyph g in glyph units for font 'sans' or 'mono'. */
export function glyphAdvance(g, font = 'sans') {
  return font === 'mono' ? MONO_ADVANCE : ADVANCES[g];
}

/**
 * Strokes of a code point as Float32Array views into COORDS (glyph units,
 * proportional placement). For inspection and tests; layout reads the packed
 * arrays directly.
 */
export function glyphStrokes(cp) {
  const g = glyphIndex(cp);
  const out = [];
  for (let k = GLYPH_STROKES[g]; k < GLYPH_STROKES[g + 1]; k++) {
    out.push(COORDS.subarray(STROKE_STARTS[k], STROKE_STARTS[k + 1]));
  }
  return out;
}
