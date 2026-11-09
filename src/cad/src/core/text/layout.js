/**
 * Text layout: turns 'text' and 'mtext' entities into world-space stroke
 * polylines using the single-stroke font in font.js.
 *
 * Local text space has the alignment point at the origin, x along the
 * baseline and y up. The local frame is then rotated by `rot` about the
 * alignment point. Glyph point (gx, gy) of a glyph whose pen position is p
 * (glyph units) lands at local (h * wf * (p + gx) + h * tan(oblique) * gy, h * gy).
 *
 * A text box spans the advance width horizontally and DESCENDER * h .. h
 * vertically, so it contains every glyph's ink.
 */
import {
  ADVANCES,
  COORDS,
  DESCENDER,
  GLYPH_STROKES,
  MONO_ADVANCE,
  MONO_SCALE,
  MONO_SHIFT,
  SPACE_GLYPH,
  STROKE_STARTS,
  glyphIndex,
} from './font.js';

/** Baseline-to-baseline distance of mtext lines, in text heights. */
export const LINE_PITCH = 5 / 3;

const SPECIAL = { d: '°', p: '±', c: '⌀', '%': '%', u: '', o: '', k: '' };
const SPECIAL_RE = /%%(?:([dDpPcC%uUoOkK])|(\d{3}))|\\[uU]\+([0-9a-fA-F]{4})/g;
/** Heights (glyph units) of the underline, overline and strike-through lines. */
const DECOR_Y = { u: -0.15, o: 1.12, k: 0.45 };

/**
 * Decode drafting control codes: %%d degree, %%p plus-minus, %%c diameter,
 * %%% percent, %%nnn decimal character code, and \U+XXXX escapes. The
 * underline, overline and strike-through toggles %%u, %%o and %%k are removed.
 */
export function decodeSpecial(str) {
  if (str == null) return '';
  const s = String(str);
  if (s.indexOf('%%') < 0 && s.indexOf('\\') < 0) return s;
  return s.replace(SPECIAL_RE, (m, k, n, hex) => {
    if (k) return SPECIAL[k.toLowerCase()];
    if (n) return String.fromCharCode(Number(n));
    return String.fromCodePoint(parseInt(hex, 16));
  });
}

/** Code point at index i of s, joining surrogate pairs (the caller skips the low half). */
function codeAt(s, i) {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo < 0xe000) return ((c - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
  }
  return c;
}

/** Sum of advances of a decoded string in glyph units. */
function advanceUnits(s, mono) {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = codeAt(s, i);
    if (cp > 0xffff) i++;
    w += mono ? MONO_ADVANCE : ADVANCES[glyphIndex(cp)];
  }
  return w;
}

/** Width of a text string in world units. */
export function measureText(value, h, widthFactor = 1, font = 'sans') {
  return advanceUnits(decodeSpecial(value), font === 'mono') * h * widthFactor;
}

/** Slant limit: obliquing angles are limited to ±85 degrees, as in AutoCAD. */
const MAX_TAN = Math.tan((85 * Math.PI) / 180);
const slant = (a) => {
  const t = Math.tan(a);
  return Number.isFinite(t) ? Math.max(-MAX_TAN, Math.min(MAX_TAN, t)) : 0;
};

/** Resolve font, width factor and oblique from the entity, then the style. */
function params(ent, style) {
  const font = typeof style === 'string' ? style : (style?.font ?? ent.font ?? 'sans');
  const so = typeof style === 'object' && style ? style : null;
  return {
    h: ent.h > 0 ? ent.h : 1,
    wf: ent.widthFactor > 0 ? ent.widthFactor : so?.widthFactor > 0 ? so.widthFactor : 1,
    tan: slant(ent.oblique ?? so?.oblique ?? 0),
    mono: font === 'mono',
    rot: ent.rot || 0,
  };
}

/**
 * Append the strokes of decoded string s. A glyph-space point (u, v), where u
 * includes the pen position, maps to (a*u + c*v + e, b*u + d*v + f).
 */
function emit(s, mono, a, b, c, d, e, f, out) {
  let pen = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = codeAt(s, i);
    if (cp > 0xffff) i++;
    const g = glyphIndex(cp);
    const k1 = GLYPH_STROKES[g + 1];
    let sc = 1,
      sh = pen;
    if (mono) {
      sc = MONO_SCALE[g];
      sh = pen + MONO_SHIFT[g];
    }
    for (let k = GLYPH_STROKES[g]; k < k1; k++) {
      const j0 = STROKE_STARTS[k],
        j1 = STROKE_STARTS[k + 1];
      const pts = new Array(j1 - j0);
      for (let j = j0, o = 0; j < j1; j += 2, o += 2) {
        const u = COORDS[j] * sc + sh,
          v = COORDS[j + 1];
        pts[o] = a * u + c * v + e;
        pts[o + 1] = b * u + d * v + f;
      }
      out.push(pts);
    }
    pen += mono ? MONO_ADVANCE : ADVANCES[g];
  }
}

/** Corners of local rectangle [x0, x1] x [y0, y1] rotated by (cs, sn) about (x, y), shear-free. */
function rectCorners(x, y, cs, sn, x0, y0, x1, y1) {
  return [
    x + cs * x0 - sn * y0,
    y + sn * x0 + cs * y0,
    x + cs * x1 - sn * y0,
    y + sn * x1 + cs * y0,
    x + cs * x1 - sn * y1,
    y + sn * x1 + cs * y1,
    x + cs * x0 - sn * y1,
    y + sn * x0 + cs * y1,
  ];
}

/**
 * Underline, overline and strike-through runs of a raw text value as
 * [kind, from, to] in glyph units along the decoded string, or null.
 */
function decorRuns(raw, mono) {
  if (raw.indexOf('%%') < 0) return null;
  const open = {};
  const runs = [];
  let pen = 0,
    last = 0;
  for (const m of raw.matchAll(SPECIAL_RE)) {
    pen += advanceUnits(raw.slice(last, m.index), mono);
    last = m.index + m[0].length;
    const k = m[1]?.toLowerCase();
    if (k in DECOR_Y) {
      if (open[k] === undefined) open[k] = pen;
      else {
        if (pen > open[k]) runs.push([k, open[k], pen]);
        delete open[k];
      }
    } else pen += advanceUnits(decodeSpecial(m[0]), mono);
  }
  pen += advanceUnits(raw.slice(last), mono);
  for (const k in open) if (pen > open[k]) runs.push([k, open[k], pen]);
  return runs.length ? runs : null;
}

/** Alignment, transform and box of a single-line text entity. */
function textFrame(ent, style) {
  const p = params(ent, style);
  const str = decodeSpecial(ent.value);
  const { h, wf, tan } = p;
  const units = advanceUnits(str, p.mono);
  const w = units * h * wf;
  const ax = ent.halign === 'center' ? w / 2 : ent.halign === 'right' ? w : 0;
  const va = ent.valign;
  const ay = va === 'bottom' ? DESCENDER * h : va === 'middle' ? h / 2 : va === 'top' ? h : 0;
  const cs = Math.cos(p.rot),
    sn = Math.sin(p.rot);
  const x = ent.x || 0,
    y = ent.y || 0;
  const a = cs * h * wf,
    b = sn * h * wf,
    c = (cs * tan - sn) * h,
    d = (sn * tan + cs) * h,
    e = x - cs * ax + sn * ay,
    f = y - sn * ax - cs * ay;
  // Box: advance width by descender..cap height, sheared like the glyphs.
  const box = [];
  for (const [u, v] of [
    [0, DESCENDER],
    [units, DESCENDER],
    [units, 1],
    [0, 1],
  ]) {
    box.push(a * u + c * v + e, b * u + d * v + f);
  }
  return { str, mono: p.mono, a, b, c, d, e, f, box };
}

/**
 * Lay out a 'text' entity. `style` is an optional text style object (or a
 * font name) supplying font, and widthFactor/oblique when the entity has none.
 * Returns { strokes: number[][] world polylines, box: flat 4 corners
 * (bottom-left, bottom-right, top-right, top-left) }.
 */
export function layoutText(ent, style) {
  const fr = textFrame(ent, style);
  const strokes = [];
  emit(fr.str, fr.mono, fr.a, fr.b, fr.c, fr.d, fr.e, fr.f, strokes);
  for (const [k, u0, u1] of decorRuns(String(ent.value ?? ''), fr.mono) ?? []) {
    const v = DECOR_Y[k];
    const { a, b, c, d, e, f } = fr;
    strokes.push([a * u0 + c * v + e, b * u0 + d * v + f, a * u1 + c * v + e, b * u1 + d * v + f]);
  }
  return { strokes, box: fr.box };
}

/**
 * Split decoded mtext into lines. Paragraphs break at '\n'; with limit > 0
 * (glyph units) words wrap at spaces and overlong words break between
 * characters. Returns { texts: string[], widths: number[] glyph units }.
 */
function wrapLines(str, limit, mono) {
  const texts = [];
  const widths = [];
  const spaceW = mono ? MONO_ADVANCE : ADVANCES[SPACE_GLYPH];
  const eps = 1e-9;
  for (const para of str.split('\n')) {
    if (!(limit > 0)) {
      texts.push(para);
      widths.push(advanceUnits(para, mono));
      continue;
    }
    let line = null,
      lw = 0;
    for (let word of para.split(' ')) {
      let ww = advanceUnits(word, mono);
      if (line !== null) {
        if (lw + spaceW + ww <= limit + eps) {
          line += ' ' + word;
          lw += spaceW + ww;
          continue;
        }
        // Spaces at a break belong to neither line: one that does not fit
        // does not start a new line, and the line ends without them.
        if (!word) continue;
        const trimmed = line.replace(/ +$/, '');
        texts.push(trimmed);
        widths.push(lw - (line.length - trimmed.length) * spaceW);
      }
      if (ww > limit + eps) {
        // Break the word: fill each line with as many characters as fit (at least one).
        const chars = Array.from(word);
        let piece = '',
          pw = 0;
        for (const ch of chars) {
          const cw = mono ? MONO_ADVANCE : ADVANCES[glyphIndex(ch.codePointAt(0))];
          if (piece && pw + cw > limit + eps) {
            texts.push(piece);
            widths.push(pw);
            piece = '';
            pw = 0;
          }
          piece += ch;
          pw += cw;
        }
        word = piece;
        ww = pw;
      }
      line = word;
      lw = ww;
    }
    texts.push(line ?? '');
    widths.push(lw);
  }
  return { texts, widths };
}

const ATTACH_X = { l: 0, c: 0.5, r: 1 };
const ATTACH_Y = { t: 0, m: 0.5, b: 1 };

/** Lines, line placement and box of an mtext entity. */
function mtextFrame(ent, style) {
  const p = params(ent, style);
  const { h, wf } = p;
  // Paragraph breaks are '\n' in the model (readers turn MTEXT's \P into
  // it); a backslash left in the value is a real one, as in C:\Projects.
  const str = decodeSpecial(String(ent.value ?? '').replace(/\r\n?/g, '\n'));
  const width = ent.width > 0 ? ent.width : 0;
  const { texts, widths } = wrapLines(str, width / (h * wf), p.mono);
  const n = texts.length;
  const pitch = LINE_PITCH * h * (ent.lineSpacing > 0 ? ent.lineSpacing : 1);
  const boxH = (n - 1) * pitch + h * (1 - DESCENDER);
  let maxW = 0;
  for (const w of widths) if (w > maxW) maxW = w;
  maxW *= h * wf;
  const frameW = Math.max(width, maxW);
  const at = ent.attach || 'tl';
  const fx = ATTACH_X[at[1]] ?? 0;
  const fy = ATTACH_Y[at[0]] ?? 0;
  const left = -fx * frameW;
  const top = fy * boxH;
  const cs = Math.cos(p.rot),
    sn = Math.sin(p.rot);
  const x = ent.x || 0,
    y = ent.y || 0;
  const box = rectCorners(x, y, cs, sn, left, top - boxH, left + frameW, top);
  return { p, texts, widths, n, pitch, frameW, fx, left, top, cs, sn, x, y, box };
}

/**
 * Lay out an 'mtext' entity: word wrap at `width` (0 = none), paragraphs at
 * '\n', placement by `attach` and line pitch LINE_PITCH * h * lineSpacing.
 * Returns { strokes, box, lines } where box is the frame (wrap width or the
 * widest line, by the full height including the last line's descenders).
 */
export function layoutMText(ent, style) {
  const fr = mtextFrame(ent, style);
  const { p, cs, sn, x, y } = fr;
  const { h, wf, tan } = p;
  const strokes = [];
  const a = cs * h * wf,
    b = sn * h * wf,
    c = (cs * tan - sn) * h,
    d = (sn * tan + cs) * h;
  for (let i = 0; i < fr.n; i++) {
    const lx = fr.left + fr.fx * (fr.frameW - fr.widths[i] * h * wf);
    const ly = fr.top - h - i * fr.pitch;
    emit(fr.texts[i], p.mono, a, b, c, d, x + cs * lx - sn * ly, y + sn * lx + cs * ly, strokes);
  }
  return { strokes, box: fr.box, lines: fr.n };
}

/**
 * Each line of an 'mtext' entity as single-line text placement:
 * [{ value, x, y, halign }], (x, y) being the alignment point on the line's
 * baseline. Laying these out as 'text' reproduces layoutMText's strokes.
 */
export function mtextLines(ent, style) {
  const fr = mtextFrame(ent, style);
  const halign = fr.fx === 0.5 ? 'center' : fr.fx === 1 ? 'right' : 'left';
  const lx = fr.left + fr.fx * fr.frameW;
  return fr.texts.map((value, i) => {
    const ly = fr.top - fr.p.h - i * fr.pitch;
    return { value, x: fr.x + fr.cs * lx - fr.sn * ly, y: fr.y + fr.sn * lx + fr.cs * ly, halign };
  });
}

/** Axis-aligned [minX, minY, maxX, maxY] of a flat point list. */
function extent(pts) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const px = pts[i],
      py = pts[i + 1];
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  return [x0, y0, x1, y1];
}

/**
 * Quick bounds [minX, minY, maxX, maxY] of a 'text' or 'mtext' entity from
 * its box, without building strokes.
 */
export function textBounds(ent, style) {
  return extent(ent.type === 'mtext' ? mtextFrame(ent, style).box : textFrame(ent, style).box);
}
