// Single-stroke sans-serif font for schematic, board and export text.
//
// Glyphs are polylines on a grid where the cap height is 20 units, the
// x-height 14 and descenders reach -6. Curves are elliptical arcs expanded
// procedurally. Text renders the same way on the canvas, in SVG and in
// Gerber silkscreen, so what you see is what gets manufactured.

const CAP = 20;
const GAP = 5; // space between glyph boxes
const OVERBAR_Y = 23.5;
const LINE_SPACING = 1.6;
const STROKE_RATIO = 0.12;

const DEG = Math.PI / 180;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Elliptical arc from a0 to a1 degrees (a1 < a0 runs clockwise). */
function A(cx, cy, rx, ry, a0, a1) {
  const span = a1 - a0;
  const n = Math.max(3, Math.ceil(Math.abs(span) / 7.5));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (a0 + (span * i) / n) * DEG;
    out.push(r3(cx + rx * Math.cos(a)), r3(cy + ry * Math.sin(a)));
  }
  return out;
}

const E = (cx, cy, rx, ry) => A(cx, cy, rx, ry, 0, 360);

/** Point on an ellipse. */
const ep = (cx, cy, rx, ry, a) => [r3(cx + rx * Math.cos(a * DEG)), r3(cy + ry * Math.sin(a * DEG))];

/** Joins polyline pieces into one, dropping repeated junction points. */
function cat(...parts) {
  const out = [];
  for (const p of parts) {
    let start = 0;
    const n = out.length;
    if (n >= 2 && p.length >= 2 && Math.abs(out[n - 2] - p[0]) < 1e-6 && Math.abs(out[n - 1] - p[1]) < 1e-6) start = 2;
    for (let i = start; i < p.length; i++) out.push(p[i]);
  }
  return out;
}

const mirrorX = (w, strokes) => strokes.map((s) => s.map((v, i) => (i % 2 === 0 ? r3(w - v) : v)));

const S_UPPER = [cat(A(6.5, 15, 6, 5, 30, 270), A(6.5, 5, 6.5, 5, 90, -150))];
const P_BOWL = cat([0, 0, 0, 20, 7, 20], A(7, 14.5, 5.5, 5.5, 90, -90), [7, 9, 0, 9]);
const O_RING = E(7, 10, 7, 10);
const LOWER_BOWL = E(5.5, 7, 5.5, 7);
const N_ARCH = cat(A(5.5, 8, 5.5, 6, 180, 0), [11, 8, 11, 0]);
const FIVE_START = ep(5.5, 6.5, 5.5, 6.5, 140);
const BRACE = [6, 22, 4.2, 21.4, 3.5, 19.5, 3.5, 11.5, 2.6, 10, 0, 9.5, 2.6, 9, 3.5, 7.5, 3.5, -0.5, 4.2, -2.4, 6, -3];

/** [width, strokes] per character. */
const GLYPHS = {
  ' ': [5, []],
  '!': [3, [[1.5, 20, 1.5, 6], [1.5, 0.6, 1.5, 0]]],
  '"': [6, [[1, 20, 1, 15], [5, 20, 5, 15]]],
  '#': [12, [[3.5, 1, 3.5, 19], [8.5, 1, 8.5, 19], [0, 6.5, 12, 6.5], [0, 13.5, 12, 13.5]]],
  '$': [13, [...S_UPPER, [6.5, -2, 6.5, 22]]],
  '%': [12, [[0, 0, 12, 20], E(2.5, 16.5, 2.5, 3.5), E(9.5, 3.5, 2.5, 3.5)]],
  '&': [12, [cat([12, 0, 3.7, 13], A(5.6, 16.2, 3.6, 3.8, 238, -58), [7.5, 13, 2.3, 7.7], A(4.5, 4.5, 4.5, 4.5, 135, 360), [9, 4.5, 11, 7])]],
  '\'': [2, [[1, 20, 1, 15]]],
  '(': [4, [A(6, 9, 6, 14, 120, 240)]],
  ')': [4, [A(-2, 9, 6, 14, 60, -60)]],
  '*': [10, [[5, 19, 5, 9], [0.7, 16.5, 9.3, 11.5], [0.7, 11.5, 9.3, 16.5]]],
  '+': [12, [[6, 2, 6, 14], [0, 8, 12, 8]]],
  ',': [2, [[1.5, 1, 0, -3]]],
  '-': [8, [[0, 8, 8, 8]]],
  '.': [2, [[1, 0, 1, 0.6]]],
  '/': [10, [[0, 0, 10, 20]]],
  '0': [11, [E(5.5, 10, 5.5, 10), [9, 17.7, 2, 2.3]]],
  '1': [10, [[2, 16, 6, 20, 6, 0], [2, 0, 10, 0]]],
  '2': [11, [cat(A(5.5, 14.5, 5.5, 5.5, 160, -40), [0, 0, 11, 0])]],
  '3': [11, [cat(A(5.5, 15, 5, 5, 150, -90), A(5.5, 5, 5.5, 5, 90, -150))]],
  '4': [11, [[8, 0, 8, 20, 0, 6, 11, 6]]],
  '5': [11, [cat([10.5, 20, 1, 20, ...FIVE_START], A(5.5, 6.5, 5.5, 6.5, 140, -150))]],
  '6': [11, [cat(A(7, 10, 7, 10, 70, 180), [0, 10, 0, 6.5]), E(5.5, 6.5, 5.5, 6.5)]],
  '7': [11, [[0, 20, 11, 20, 3.5, 0]]],
  '8': [11, [E(5.5, 15, 5, 5), E(5.5, 5, 5.5, 5)]],
  '9': [11, [E(5.5, 13.5, 5.5, 6.5), cat([11, 13.5, 11, 10], A(4, 10, 7, 10, 0, -110))]],
  ':': [2, [[1, 14, 1, 13.4], [1, 0.6, 1, 0]]],
  ';': [2, [[1, 14, 1, 13.4], [1.5, 1, 0, -3]]],
  '<': [12, [[12, 16, 0, 8, 12, 0]]],
  '=': [12, [[0, 11, 12, 11], [0, 5, 12, 5]]],
  '>': [12, [[0, 16, 12, 8, 0, 0]]],
  '?': [11, [cat(A(5.5, 14.5, 5.5, 5.5, 160, -50), [5.5, 7, 5.5, 5]), [5.5, 0.6, 5.5, 0]]],
  '@': [14, [E(6.5, 9, 3, 4), cat([9.5, 13, 9.5, 7], A(11.75, 7, 2.25, 2.25, 180, 360), [14, 7, 14, 9], A(7, 9, 7, 10, 0, 300))]],
  'A': [13, [[0, 0, 6.5, 20, 13, 0], [2.3, 7, 10.7, 7]]],
  'B': [12.5, [cat([0, 0, 0, 20, 7, 20], A(7, 15, 5, 5, 90, -90), [7, 10, 0, 10]), cat([0, 10, 7.5, 10], A(7.5, 5, 5, 5, 90, -90), [7.5, 0, 0, 0])]],
  'C': [12, [A(7, 10, 7, 10, 45, 315)]],
  'D': [13, [cat([0, 0, 0, 20, 6, 20], A(6, 10, 7, 10, 90, -90), [6, 0, 0, 0])]],
  'E': [12, [[12, 20, 0, 20, 0, 0, 12, 0], [0, 10, 9, 10]]],
  'F': [12, [[12, 20, 0, 20, 0, 0], [0, 10, 9, 10]]],
  'G': [14, [cat(A(7, 10, 7, 10, 45, 360), [14, 10, 8, 10])]],
  'H': [12, [[0, 0, 0, 20], [12, 0, 12, 20], [0, 10, 12, 10]]],
  'I': [6, [[0, 20, 6, 20], [3, 20, 3, 0], [0, 0, 6, 0]]],
  'J': [10, [cat([10, 20, 10, 5], A(5, 5, 5, 5, 0, -180))]],
  'K': [12, [[0, 0, 0, 20], [12, 20, 0, 7], [4, 11.33, 12, 0]]],
  'L': [11, [[0, 20, 0, 0, 11, 0]]],
  'M': [14, [[0, 0, 0, 20, 7, 6, 14, 20, 14, 0]]],
  'N': [12, [[0, 0, 0, 20, 12, 0, 12, 20]]],
  'O': [14, [O_RING]],
  'P': [12.5, [P_BOWL]],
  'Q': [14, [O_RING, [8.5, 5, 14, -1]]],
  'R': [12.5, [P_BOWL, [6, 9, 12.5, 0]]],
  'S': [13, S_UPPER],
  'T': [12, [[0, 20, 12, 20], [6, 20, 6, 0]]],
  'U': [12, [cat([0, 20, 0, 6], A(6, 6, 6, 6, 180, 360), [12, 6, 12, 20])]],
  'V': [13, [[0, 20, 6.5, 0, 13, 20]]],
  'W': [16, [[0, 20, 4, 0, 8, 14, 12, 0, 16, 20]]],
  'X': [12, [[0, 20, 12, 0], [0, 0, 12, 20]]],
  'Y': [12, [[0, 20, 6, 10, 12, 20], [6, 10, 6, 0]]],
  'Z': [12, [[0, 20, 12, 20, 0, 0, 12, 0]]],
  '[': [5, [[5, 22, 0, 22, 0, -3, 5, -3]]],
  '\\': [10, [[0, 20, 10, 0]]],
  ']': [5, [[0, 22, 5, 22, 5, -3, 0, -3]]],
  '^': [10, [[0, 13, 5, 20, 10, 13]]],
  '_': [12, [[0, -3, 12, -3]]],
  '`': [3, [[0, 21, 3, 17]]],
  'a': [11, [LOWER_BOWL, [11, 14, 11, 0]]],
  'b': [11, [[0, 20, 0, 0], LOWER_BOWL]],
  'c': [10, [A(5.5, 7, 5.5, 7, 45, 315)]],
  'd': [11, [LOWER_BOWL, [11, 20, 11, 0]]],
  'e': [11, [cat([0.2, 7, 11, 7], A(5.5, 7, 5.5, 7, 0, 320))]],
  'f': [9, [cat([3, 0, 3, 16], A(7, 16, 4, 4, 180, 60)), [0, 14, 8, 14]]],
  'g': [11, [LOWER_BOWL, cat([11, 14, 11, -1], A(5.5, -1, 5.5, 5, 0, -150))]],
  'h': [11, [[0, 20, 0, 0], N_ARCH]],
  'i': [3, [[1.5, 0, 1.5, 14], [1.5, 18.4, 1.5, 19]]],
  'j': [5, [cat([4, 14, 4, -2.5], A(0.5, -2.5, 3.5, 3.5, 0, -130)), [4, 18.4, 4, 19]]],
  'k': [10, [[0, 20, 0, 0], [10, 14, 0, 4], [3.5, 7.5, 10, 0]]],
  'l': [5, [cat([1.5, 20, 1.5, 2.5], A(4, 2.5, 2.5, 2.5, 180, 270))]],
  'm': [16, [[0, 14, 0, 0], cat(A(4, 9, 4, 5, 180, 0), [8, 9, 8, 0]), cat(A(12, 9, 4, 5, 180, 0), [16, 9, 16, 0])]],
  'n': [11, [[0, 14, 0, 0], N_ARCH]],
  'o': [11, [LOWER_BOWL]],
  'p': [11, [[0, 14, 0, -6], LOWER_BOWL]],
  'q': [11, [LOWER_BOWL, [11, 14, 11, -6]]],
  'r': [9, [[0, 14, 0, 0], A(6.5, 8, 6.5, 6, 180, 70)]],
  's': [10, [cat(A(5, 10.5, 4.5, 3.5, 30, 270), A(5, 3.5, 5, 3.5, 90, -150))]],
  't': [8, [cat([3, 20, 3, 3], A(6, 3, 3, 3, 180, 270), [6, 0, 8, 0]), [0, 14, 8, 14]]],
  'u': [11, [cat([0, 14, 0, 6], A(5.5, 6, 5.5, 6, 180, 360)), [11, 14, 11, 0]]],
  'v': [11, [[0, 14, 5.5, 0, 11, 14]]],
  'w': [15, [[0, 14, 3.5, 0, 7.5, 11, 11.5, 0, 15, 14]]],
  'x': [11, [[0, 14, 11, 0], [0, 0, 11, 14]]],
  'y': [11, [[0, 14, 5.5, 0], [11, 14, 3.15, -6]]],
  'z': [11, [[0, 14, 11, 14, 0, 0, 11, 0]]],
  '{': [6, [BRACE]],
  '|': [3, [[1.5, 22, 1.5, -3]]],
  '}': [6, mirrorX(6, [BRACE])],
  '~': [12, [A(3, 7.5, 3, 2.5, 180, 0).concat(A(9, 7.5, 3, 2.5, 180, 360).slice(2))]],
  'µ': [11, [[0, 14, 0, -6], cat([0, 14, 0, 6], A(5.5, 6, 5.5, 6, 180, 360)), [11, 14, 11, 0]]],
  'Ω': [14, [cat([0, 0, 4, 0, ...ep(7, 11, 7, 9, 245)], A(7, 11, 7, 9, 245, -65), [10, 0, 14, 0])]],
  '°': [5, [E(2.5, 17.5, 2.5, 2.5)]],
  '±': [12, [[6, 8, 6, 18], [0, 13, 12, 13], [0, 3, 12, 3]]],
};
GLYPHS['μ'] = GLYPHS['µ']; // Greek mu and micro sign
GLYPHS['Ω'] = GLYPHS['Ω']; // ohm sign and Greek omega

/** Characters with a defined glyph. */
export const GLYPH_CHARS = Object.keys(GLYPHS);

const FALLBACK = [12, [[0, 0, 12, 0, 12, 20, 0, 20, 0, 0], [0, 0, 12, 20]]];
// Accented letters without a glyph draw their base letter (é as e) rather
// than the missing-glyph box.
const glyph = (ch) => GLYPHS[ch] || GLYPHS[ch.normalize('NFD')[0]] || FALLBACK;

const ALIGN_DEFAULT = { h: 'left', v: 'bottom' };

/**
 * Parses text into lines of { ch, over } runs. '~' toggles the overbar and
 * '~~' prints a literal tilde.
 */
function parseLines(text) {
  const lines = [[]];
  let over = false;
  // By code point, so a character outside the BMP is one glyph, not two.
  const s = Array.from(String(text ?? ''));
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '~') {
      if (s[i + 1] === '~') { lines[lines.length - 1].push({ ch: '~', over }); i++; continue; }
      over = !over;
      continue;
    }
    if (ch === '\n') { lines.push([]); continue; }
    if (ch === '\r') continue;
    lines[lines.length - 1].push({ ch, over });
  }
  return lines;
}

function lineWidthUnits(line) {
  if (!line.length) return 0;
  let w = 0;
  for (const { ch } of line) w += glyph(ch)[0] + GAP;
  return w - GAP;
}

// Unit layouts (cap height 1) keyed by text and alignment.
const cache = new Map();
const CACHE_LIMIT = 4000;

function unitLayout(text, align) {
  const h = align?.h || 'left', v = align?.v || 'bottom';
  const key = `${h}${v}\u0000${text}`;
  let lay = cache.get(key);
  if (lay) return lay;
  const lines = parseLines(text);
  const n = lines.length;
  const lineH = LINE_SPACING * CAP;
  const blockH = CAP + (n - 1) * lineH;
  const strokes = [];
  let maxW = 0;
  for (let li = 0; li < n; li++) {
    const line = lines[li];
    const lw = lineWidthUnits(line);
    maxW = Math.max(maxW, lw);
    let base;
    if (v === 'top') base = -CAP - li * lineH;
    else if (v === 'middle') base = (n - 1 - li) * lineH - blockH / 2;
    else base = (n - 1 - li) * lineH;
    let x = h === 'center' ? -lw / 2 : h === 'right' ? -lw : 0;
    let barStart = null;
    for (let ci = 0; ci <= line.length; ci++) {
      const item = line[ci];
      if (barStart !== null && (!item || !item.over)) {
        strokes.push([barStart / CAP, (base + OVERBAR_Y) / CAP, (x - GAP) / CAP, (base + OVERBAR_Y) / CAP]);
        barStart = null;
      }
      if (!item) break;
      if (item.over && barStart === null) barStart = x;
      const [w, gs] = glyph(item.ch);
      for (const g of gs) {
        const s = new Array(g.length);
        for (let i = 0; i < g.length; i += 2) { s[i] = (g[i] + x) / CAP; s[i + 1] = (g[i + 1] + base) / CAP; }
        strokes.push(s);
      }
      x += w + GAP;
    }
  }
  lay = { strokes, width: maxW / CAP, height: blockH / CAP };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, lay);
  return lay;
}

/**
 * Lays out text at the origin. size is the cap height in output units.
 * Returns polylines (flat [x, y, ...]) relative to the anchor, unrotated.
 */
export function layoutText(text, size, align = ALIGN_DEFAULT) {
  const u = unitLayout(text, align);
  return {
    strokes: u.strokes.map((s) => s.map((v) => v * size)),
    width: u.width * size,
    height: u.height * size,
  };
}

/**
 * World-space polylines for text anchored at (x, y), rotated by rot degrees.
 * mirror flips the text horizontally about the anchor before rotating
 * (bottom-side silkscreen reads correctly when the board is turned over).
 */
export function textStrokes(text, x, y, size, rot = 0, align = ALIGN_DEFAULT, mirror = false) {
  const u = unitLayout(text, align);
  const r = ((rot % 360) + 360) % 360;
  let c = 1, s = 0;
  if (r === 90) { c = 0; s = 1; } else if (r === 180) { c = -1; s = 0; } else if (r === 270) { c = 0; s = -1; } else if (r) { c = Math.cos(r * DEG); s = Math.sin(r * DEG); }
  const m = mirror ? -1 : 1;
  const out = new Array(u.strokes.length);
  for (let k = 0; k < u.strokes.length; k++) {
    const src = u.strokes[k];
    const dst = new Array(src.length);
    for (let i = 0; i < src.length; i += 2) {
      const lx = src[i] * size * m, ly = src[i + 1] * size;
      dst[i] = x + lx * c - ly * s;
      dst[i + 1] = y + lx * s + ly * c;
    }
    out[k] = dst;
  }
  return out;
}

/** Width of the widest line, in output units. */
export const textWidth = (text, size) => unitLayout(text, ALIGN_DEFAULT).width * size;

/** Height of the text block (cap height for one line). */
export const textHeight = (text, size) => unitLayout(text, ALIGN_DEFAULT).height * size;

/**
 * Keeps text readable: a rotation in (90, 270] becomes a half turn less with
 * the alignment flipped, which covers the same box but reads upright. Used
 * by the canvas, the exporters and the bounds so they all agree.
 */
export function uprightText(rot = 0, align) {
  const r = ((rot % 360) + 360) % 360;
  if (r > 90 && r <= 270) return { rot: (r + 180) % 360, align: flipAlign(align) };
  return { rot: r, align };
}

/** The alignment that keeps a text's box when it turns a half turn. */
export function flipAlign(align = {}) {
  const h = align.h === 'left' || !align.h ? 'right' : align.h === 'right' ? 'left' : 'center';
  const v = align.v === 'bottom' || !align.v ? 'top' : align.v === 'top' ? 'bottom' : 'middle';
  return { h, v };
}

/** Default stroke width for text of the given cap height. */
export const strokeWidthFor = (size) => size * STROKE_RATIO;

/** Strips overbar markers, for search and display in plain text UI. */
export const plainText = (text) => String(text ?? '').replace(/~~/g, '\u0000').replace(/~/g, '').replace(/\u0000/g, '~');
