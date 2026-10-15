// Text layout for text (FONT) objects: per-character styles (bold, italic, underline, small caps,
// kerning), word / character / line spacing, alignment, text boxes with word wrap, shear and
// offset. Pure: glyph metrics and outlines come from a GlyphSource (fonts.ts), so it can be tested.
import type { BezierPoint, CharFormat, CurveData, Spline, TextBox, Vec3 } from '../data/types';

export type FontStyle = 'REGULAR' | 'BOLD' | 'ITALIC' | 'BOLD_ITALIC';

export interface GlyphSource {
  /** advance width in em units */
  advance(ch: string, style: FontStyle): number;
  /** outline in em units (y up), cyclic Bézier splines; null when the glyph is missing */
  outline(ch: string, style: FontStyle): Spline[] | null;
  /** whether a real font for the style is loaded (otherwise bold is ignored and italic is slanted) */
  hasStyle(style: FontStyle): boolean;
}

export interface TextLine {
  /** first character (code unit index) */
  start: number;
  /** end (exclusive, without the line break) */
  end: number;
  y: number;
}

export interface TextLayout {
  splines: Spline[];
  /** caret positions (x, y of the baseline, in object units) for every character index 0..len */
  carets: [number, number][];
  lines: TextLine[];
  lineHeight: number;
  size: number;
}

/** Kerning unit (fraction of the text size per kerning step). */
export const KERNING_UNIT = 0.012;
/** Slant of synthesized italics. */
const OBLIQUE = 0.2;

export function styleOf(f: CharFormat | undefined): FontStyle {
  return f?.use_bold ? (f.use_italic ? 'BOLD_ITALIC' : 'BOLD') : f?.use_italic ? 'ITALIC' : 'REGULAR';
}

function boxesOf(cu: CurveData): TextBox[] {
  const b = cu.text_boxes?.filter(Boolean);
  return b?.length ? b : [{ x: 0, y: 0, width: 0, height: 0 }];
}

interface Glyph {
  /** code unit index */
  i: number;
  ch: string;
  /** visible glyph character (small caps substitute) */
  glyph: string;
  scale: number;
  style: FontStyle;
  width: number;
  isSpace: boolean;
  underline: boolean;
  material: number;
}

function rectSpline(x0: number, y0: number, x1: number, y1: number): Spline {
  const corner = (x: number, y: number, px: number, py: number, nx: number, ny: number): BezierPoint => ({
    co: [x, y, 0],
    handle_left: [x + (px - x) / 3, y + (py - y) / 3, 0],
    handle_right: [x + (nx - x) / 3, y + (ny - y) / 3, 0],
    handle_left_type: 'VECTOR',
    handle_right_type: 'VECTOR',
    radius: 1,
    tilt: 0,
  });
  // counter-clockwise like glyph outer contours
  const pts: [number, number][] = [
    [x0, y1],
    [x1, y1],
    [x1, y0],
    [x0, y0],
  ];
  return {
    type: 'BEZIER',
    bezier_points: pts.map((p, k) => {
      const prev = pts[(k + 3) % 4],
        next = pts[(k + 1) % 4];
      return corner(p[0], p[1], prev[0], prev[1], next[0], next[1]);
    }),
    points: [],
    use_cyclic_u: true,
    resolution_u: 0,
    order_u: 4,
    use_smooth: false,
    material_index: 0,
  };
}

/** Text layout including overflow handling of the last text box (scale to fit / truncate). */
export function layoutTextWith(cu: CurveData, src: GlyphSource | null): TextLayout {
  const first = layoutCore(cu, src);
  if (cu.overflow !== 'SCALE' || !first.overflowed || !src) return first;
  // shrink the size until everything fits in the boxes
  let lo = 0.02,
    hi = 1;
  let best = layoutCore({ ...cu, size: (cu.size ?? 1) * lo }, src);
  for (let it = 0; it < 12; it++) {
    const mid = (lo + hi) / 2;
    const l = layoutCore({ ...cu, size: (cu.size ?? 1) * mid }, src);
    if (l.overflowed) hi = mid;
    else {
      lo = mid;
      best = l;
    }
  }
  return best;
}

function layoutCore(cu: CurveData, src: GlyphSource | null): TextLayout & { overflowed: boolean } {
  const body = cu.body ?? '';
  const size = cu.size ?? 1;
  const lineHeight = 1.2 * size * (cu.space_line ?? 1);
  const spaceChar = cu.space_character ?? 1;
  const spaceWord = cu.space_word ?? 1;
  const scScale = cu.small_caps_scale ?? 0.75;
  const shear = cu.shear ?? 0;
  const ox = cu.offset_x ?? 0,
    oy = cu.offset_y ?? 0;
  const carets: [number, number][] = new Array(body.length + 1);
  const splines: Spline[] = [];
  const lines: TextLine[] = [];
  if (!src) {
    for (let i = 0; i <= body.length; i++) carets[i] = [ox, oy];
    return { splines, carets, lines: [{ start: 0, end: body.length, y: 0 }], lineHeight, size, overflowed: false };
  }
  // glyph runs per paragraph
  const spaceAdv = src.advance(' ', 'REGULAR');
  const paragraphs: Glyph[][] = [[]];
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < body.length;
    const ch = pair ? body.slice(i, i + 2) : body[i];
    if (ch === '\n') {
      paragraphs.push([]);
      continue;
    }
    const f = cu.body_format?.[i];
    const small = !!f?.use_small_caps && ch !== ch.toUpperCase();
    const glyph = small ? ch.toUpperCase() : ch;
    const scale = small ? scScale : 1;
    const style = styleOf(f);
    const isSpace = /\s/.test(ch);
    let width = src.advance(glyph, style) * scale * size * spaceChar;
    if (isSpace) width += (spaceWord - 1) * spaceAdv * size;
    width += (f?.kerning ?? 0) * KERNING_UNIT * size;
    paragraphs[paragraphs.length - 1].push({ i, ch, glyph, scale, style, width, isSpace, underline: !!f?.use_underline, material: f?.material_index ?? 0 });
    if (pair) i++;
  }
  const boxes = boxesOf(cu);
  // break paragraphs into visual lines, flowing from one text box into the next
  interface VLine {
    glyphs: Glyph[];
    width: number;
    last: boolean;
    start: number;
    end: number;
    box: number;
    row: number;
  }
  const vlines: VLine[] = [];
  let paraStart = 0;
  let box = 0,
    row = 0;
  /** box for the next line (moves on when the current box is full) */
  const nextSlot = () => {
    const b = boxes[box];
    if (b.height > 0 && row > 0 && (row + 1) * lineHeight > b.height + 1e-6 && box + 1 < boxes.length) {
      box++;
      row = 0;
    }
    return boxes[box];
  };
  for (const para of paragraphs) {
    let slot = nextSlot();
    let cur: Glyph[] = [];
    let x = 0;
    let lastSpace = -1;
    const flush = (gs: Glyph[], last: boolean, endIdx: number) => {
      const trimmed = [...gs];
      while (trimmed.length && trimmed[trimmed.length - 1].isSpace) trimmed.pop();
      vlines.push({ glyphs: gs, width: trimmed.reduce((sum, g) => sum + g.width, 0), last, start: gs.length ? gs[0].i : endIdx, end: endIdx, box, row });
      row++;
    };
    for (const g of para) {
      if (slot.width > 0 && !g.isSpace && x + g.width > slot.width && lastSpace >= 0) {
        // break after the last space of the line
        const head = cur.slice(0, lastSpace + 1);
        const tail = cur.slice(lastSpace + 1);
        flush(head, false, tail.length ? tail[0].i : g.i);
        slot = nextSlot();
        cur = tail;
        x = tail.reduce((sum, t) => sum + t.width, 0);
        lastSpace = -1;
      }
      cur.push(g);
      x += g.width;
      if (g.isSpace) lastSpace = cur.length - 1;
    }
    const paraEnd = para.length ? para[para.length - 1].i + para[para.length - 1].ch.length : paraStart;
    flush(cur, true, paraEnd);
    paraStart = paraEnd + 1;
  }
  // vertical placement (alignment applies to the first box)
  const firstBoxLines = vlines.filter((l) => l.box === 0).length;
  const total = (firstBoxLines - 1) * lineHeight;
  const ay = cu.align_y ?? 'TOP_BASELINE';
  const yOffset = ay === 'CENTER' ? total / 2 - size * 0.35 : ay === 'BOTTOM_BASELINE' ? total : ay === 'BOTTOM' ? total + size * 0.25 : ay === 'TOP' ? -size * 0.8 : 0;
  // lines past the bottom of the last (bounded) box overflow it
  const lastBox = boxes[boxes.length - 1];
  const overflows = (l: { box: number; row: number }) => l.box === boxes.length - 1 && lastBox.height > 0 && (l.row + 1) * lineHeight > lastBox.height + 1e-6 && l.row > 0;
  const overflowed = vlines.some(overflows);
  const kept = cu.overflow === 'TRUNCATE' ? vlines.filter((l) => !overflows(l)) : vlines;
  const placed = kept.map((l) => {
    const b = boxes[l.box];
    return { l, b, y: b.y - l.row * lineHeight + (l.box === 0 ? yOffset : 0) };
  });
  for (const { l, b, y } of placed) {
    const w = b.width;
    const align = cu.align_x ?? 'LEFT';
    let x = b.x;
    let extra = 0;
    const spaces = l.glyphs.filter((g, idx) => g.isSpace && idx < l.glyphs.length - 1).length;
    if (align === 'CENTER') x = w > 0 ? b.x + (w - l.width) / 2 : b.x - l.width / 2;
    else if (align === 'RIGHT') x = w > 0 ? b.x + w - l.width : b.x - l.width;
    else if ((align === 'JUSTIFY' && !l.last) || (align as string) === 'FLUSH') {
      if (w > 0 && spaces) extra = (w - l.width) / spaces;
    }
    lines.push({ start: l.start, end: l.end, y: y + oy });
    let run: { x0: number; x1: number } | null = null;
    const endRun = () => {
      if (run && run.x1 > run.x0) {
        const top = y + ((cu.underline_position ?? 0) - 0.1) * size;
        const bottom = top - (cu.underline_height ?? 0.05) * size;
        splines.push(rectSpline(run.x0 + ox, bottom + oy, run.x1 + ox, top + oy));
      }
      run = null;
    };
    l.glyphs.forEach((g, idx) => {
      carets[g.i] = [x + ox, y + oy];
      if (g.ch.length === 2) carets[g.i + 1] = [x + ox, y + oy];
      if (!g.isSpace) {
        const out = src.outline(g.glyph, g.style);
        const slant = shear + (g.style !== 'REGULAR' && (g.style === 'ITALIC' || g.style === 'BOLD_ITALIC') && !src.hasStyle(g.style) ? OBLIQUE : 0);
        const s = size * g.scale;
        const tr = (p: Vec3): Vec3 => [x + p[0] * s + p[1] * s * slant + ox, y + p[1] * s + oy, 0];
        for (const sp of out ?? []) splines.push({ ...sp, material_index: g.material, bezier_points: sp.bezier_points.map((b) => ({ ...b, co: tr(b.co), handle_left: tr(b.handle_left), handle_right: tr(b.handle_right) })) });
      }
      const adv = g.width + (g.isSpace && idx < l.glyphs.length - 1 ? extra : 0);
      if (g.underline) {
        if (run) run.x1 = x + adv;
        else run = { x0: x, x1: x + adv };
      } else endRun();
      x += adv;
    });
    endRun();
    // caret at the end of the visual line (line break / wrap position)
    if (carets[l.end] === undefined || l.last) carets[l.end] = [x + ox, y + oy];
  }
  for (let i = 0; i <= body.length; i++) carets[i] ??= [ox, oy];
  return { splines, carets, lines, lineHeight, size, overflowed };
}
