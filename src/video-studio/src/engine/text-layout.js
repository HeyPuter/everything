/**
 * Text layout math shared by the renderer: word wrapping to a box width,
 * per-glyph positions within a line, and bending lines around a circle
 * (curved text). Pure functions over a measure callback so they can be
 * tested without a canvas.
 */

/**
 * Split text into lines. Explicit newlines always break; when maxW > 0,
 * words wrap to fit and a word wider than the box breaks between letters.
 * measure(str) returns the drawn width of str.
 */
export function wrapLines(text, maxW, measure) {
  const paragraphs = String(text).split('\n');
  if (!(maxW > 0)) return paragraphs;
  const out = [];
  // Pieces of a word wider than the box: all but the last become lines.
  const breakWord = (word) => {
    let piece = '';
    for (const ch of word) {
      if (piece && measure(piece + ch) > maxW) {
        out.push(piece);
        piece = '';
      }
      piece += ch;
    }
    return piece;
  };
  for (const para of paragraphs) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) {
        if (line) line += word;
        continue;
      }
      if (line && measure(line + word) > maxW) {
        out.push(line.replace(/\s+$/, ''));
        line = '';
      }
      line = line ? line + word : measure(word) > maxW ? breakWord(word) : word;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

/**
 * Glyphs of one line: { ch, x, adv, w } where x is the left edge relative to
 * the line start, adv the advance to the next glyph (letter spacing
 * included) and w the ink width of the glyph alone.
 *  measureSpaced(str)  width with letter spacing (prefix widths, keeps kerning)
 *  measurePlain(ch)    width of a single glyph without spacing
 */
export function lineGlyphs(line, measureSpaced, measurePlain) {
  const chars = [...line];
  const out = [];
  let prev = 0;
  let prefix = '';
  for (let i = 0; i < chars.length; i++) {
    prefix += chars[i];
    const end = measureSpaced(prefix);
    out.push({ ch: chars[i], x: prev, adv: end - prev, w: measurePlain(chars[i]) });
    prev = end;
  }
  return out;
}

// Letters of right-to-left scripts (Hebrew, Arabic, Syriac, Thaana, NKo, ...) and of left-to-right ones.
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_CHAR = /[0-9A-Za-z\u00C0-\u024F\u0370-\u052F\u1E00-\u1FFF]/;

/**
 * Left edges, in drawing order, of a line's glyphs (from lineGlyphs, in the
 * order they are typed) when the line holds right-to-left letters: a line
 * that starts with one is laid out from the right, with its Hebrew or Arabic
 * runs right to left and Latin words and numbers inside it left to right;
 * right-to-left words inside a left-to-right line read right to left too
 * (a simple form of the Unicode bidi rules). Returns null for a line without
 * right-to-left letters, whose glyph x positions stand as they are.
 */
export function bidiPositions(glyphs) {
  const n = glyphs.length;
  if (!glyphs.some((g) => RTL_CHAR.test(g.ch))) return null;
  const type = glyphs.map((g) => (RTL_CHAR.test(g.ch) ? 'R' : LTR_CHAR.test(g.ch) ? 'L' : 'N'));
  const base = type.find((t) => t !== 'N');
  // Spaces and punctuation between two runs of one direction join them, else follow the line.
  const prev = new Array(n);
  let last = null;
  for (let i = 0; i < n; i++) {
    prev[i] = last;
    if (type[i] !== 'N') last = type[i];
  }
  let next = null;
  for (let i = n - 1; i >= 0; i--) {
    if (type[i] === 'N') type[i] = prev[i] && prev[i] === next ? next : base;
    else next = type[i];
  }
  const xs = new Array(n);
  let total = 0;
  for (const g of glyphs) total += g.adv;
  let cursor = base === 'R' ? total : 0;
  for (let i = 0; i < n;) {
    let j = i;
    let w = 0;
    while (j < n && type[j] === type[i]) w += glyphs[j++].adv;
    const left = base === 'R' ? cursor - w : cursor;
    let pos = type[i] === 'R' ? left + w : left;
    for (let k = i; k < j; k++) {
      if (type[i] === 'R') {
        pos -= glyphs[k].adv;
        xs[k] = pos;
      } else {
        xs[k] = pos;
        pos += glyphs[k].adv;
      }
    }
    cursor = base === 'R' ? left : left + w;
    i = j;
  }
  return xs;
}

/** Word and letter indices for glyphs across lines (spaces get no index). */
export function indexGlyphs(lines) {
  let ci = 0;
  let wi = -1;
  let inWord = false;
  const wordLens = [];
  for (const line of lines) {
    inWord = false;
    for (const g of line.glyphs) {
      if (/\s/.test(g.ch)) {
        g.ci = -1;
        g.wi = -1;
        inWord = false;
        continue;
      }
      if (!inWord) {
        wi++;
        wordLens.push(0);
        inWord = true;
      }
      g.ci = ci++;
      g.wi = wi;
      wordLens[wi]++;
    }
  }
  return { chars: ci, words: wi + 1, wordLens };
}

/** Widest line spans this many radians at arc = 100 (a half circle). */
export const MAX_ARC = Math.PI;

/**
 * Bend lines around a circle. Positions are relative to the text block
 * center (x) and the block center (y).
 *  lines: [{ y, glyphs: [{ cx, w }] }]   cx relative to the block center
 *  arc:   -100..100; positive bows the middle up (ends fall away), negative bows it down
 *  maxW:  width of the widest line
 * Returns per line an array of { x, y, rot } (rot in radians) and the
 * radius used for the first line.
 */
export function arcLayout(lines, arc, maxW, lineH) {
  const a = Math.max(-100, Math.min(100, Number(arc) || 0));
  if (!a || !(maxW > 0) || !lines.length) {
    return { radius: Infinity, lines: lines.map((l) => l.glyphs.map((g) => ({ x: g.cx, y: l.y, rot: 0 }))) };
  }
  const theta = (Math.abs(a) / 100) * MAX_ARC;
  const R = maxW / theta;
  const y0 = lines[0].y;
  const out = lines.map((l) => {
    const dy = l.y - y0;
    return l.glyphs.map((g) => {
      if (a > 0) {
        // Circle center below the first line; lower lines sit on smaller circles.
        const r = Math.max(lineH * 0.5, R - dy);
        const phi = g.cx / r;
        return { x: r * Math.sin(phi), y: y0 + R - r * Math.cos(phi), rot: phi };
      }
      // Circle center above the first line; lower lines sit on larger circles.
      const r = R + dy;
      const phi = g.cx / r;
      return { x: r * Math.sin(phi), y: y0 - R + r * Math.cos(phi), rot: -phi };
    });
  });
  return { radius: R, lines: out };
}

/** Bounds of rotated glyph boxes (half width hw, half height hh) at placed points. */
export function placedBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const c = Math.abs(Math.cos(p.rot || 0));
    const s = Math.abs(Math.sin(p.rot || 0));
    const ex = p.hw * c + p.hh * s;
    const ey = p.hw * s + p.hh * c;
    minX = Math.min(minX, p.x - ex);
    maxX = Math.max(maxX, p.x + ex);
    minY = Math.min(minY, p.y - ey);
    maxY = Math.max(maxY, p.y + ey);
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}
