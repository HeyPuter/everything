// Dynamic text: type that refits a shape in its box. The content keeps its
// own sizes as proportions; every layout resolves the fit into ordinary text
// data that draws the same way (block text or text along a curve) with the
// sizes the box calls for, so editing the text or resizing the box refits it.
//
// - Block: each line is scaled to the box width and the lines are stacked
//   (block-text.ts). With automatic lines, paragraphs are broken at spaces
//   into the lines that best fill the box; a stack taller than the box
//   shrinks to fit and is centered vertically.
// - Arch, bow, wave and circle: the text is sized to run the length of the
//   curve (around most of the circle), and the curve with its glyphs is
//   scaled to the largest size that fits the box, centered in it.
//
// Releasing a fit keeps this resolved text (block lines baked into sizes).

import {
  applyParagraphStyle,
  plainText,
  replaceRange,
  textLength,
  type FitShape,
  type TextContent,
  type TextFit,
  type TextLayerData,
} from './model';
import type { LayoutOptions, Rect, TextLayout } from './layout';
import { arcPresetPath, offsetPoint, pathGeometry } from './path-text';
import { CAP, DESCENDER, hasDescender } from './block-text';

type Layout = (d: TextLayerData, o: LayoutOptions) => TextLayout;

export const FIT_SHAPES: FitShape[] = ['block', 'circle', 'arch', 'bow', 'wave'];
// Fraction of a curve the text runs along: just short of open ends (so the
// last glyph is never dropped by rounding) and leaving a gap in a circle.
const OPEN_FILL = 0.99;
const CIRCLE_FILL = 0.92;
// Automatic block lines: largest number of words considered, and of extra lines.
const AUTO_WORDS = 160;
const AUTO_EXTRA_LINES = 24;
// Reference length of the curve before it is scaled into the box.
const REF = 1000;

/** The text as plain horizontal point text, without fit, warp, path or block. */
function pointText(d: TextLayerData, content = d.content): TextLayerData {
  const { fit: _fit, block: _block, path: _path, warp: _warp, box: _box, ...rest } = d;
  return { ...rest, content, mode: 'point', orientation: 'horizontal', origin: { x: 0, y: 0 } };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** Content with every point size (type size, leading, shift, indents,
 * paragraph spacing) multiplied by `s`. */
export function scaleTextContent(c: TextContent, s: number): TextContent {
  const k = (v: number) => r3(v * s);
  return {
    paragraphs: c.paragraphs.map((p) => ({
      style: {
        ...p.style,
        indentLeft: k(p.style.indentLeft),
        indentRight: k(p.style.indentRight),
        indentFirst: k(p.style.indentFirst),
        spaceBefore: k(p.style.spaceBefore),
        spaceAfter: k(p.style.spaceAfter),
      },
      runs: p.runs.map((r) => ({
        text: r.text,
        style: {
          ...r.style,
          color: [...r.style.color] as [number, number, number],
          size: Math.max(0.01, Math.min(10000, k(r.style.size))),
          leading: r.style.leading === 'auto' ? 'auto' : k(r.style.leading),
          baselineShift: k(r.style.baselineShift),
        },
      })),
    })),
  };
}

/** The fit box in local space when its height is fixed. */
export function fixedFitBox(d: TextLayerData): Rect | undefined {
  const f = d.fit;
  if (!f || f.height === undefined) return;
  return { x: d.origin.x, y: d.origin.y, width: f.width, height: f.height };
}

/** Ordinary text data that draws the fit, and the fit box (for a block of
 * automatic height, the box its lines take). */
export function resolveFit(
  d: TextLayerData,
  opts: LayoutOptions,
  layout: Layout,
): { data: TextLayerData; box: Rect } {
  const f = d.fit!;
  return f.shape === 'block' ? resolveBlock(d, f, opts, layout) : resolveCurve(d, f, opts, layout);
}

// ------------------------------------------------------------ block

const anchorOf = (align: string, w: number) =>
  align === 'center' || align === 'justify-center'
    ? w / 2
    : align === 'right' || align === 'justify-right'
      ? w
      : 0;

/** Vertical extent of a block layout around its first baseline: capital
 * height above each line and descenders below, as the lines are stacked. */
export function blockExtent(l: TextLayout, text: string): { top: number; bottom: number } {
  let top = Infinity,
    bottom = -Infinity;
  for (const line of l.lines) {
    if (!line.visible) continue;
    let em = 0;
    for (const r of l.runs)
      if (r.start >= line.start && r.end <= line.end) em = Math.max(em, r.sizePx);
    if (!em) em = line.ascent;
    top = Math.min(top, line.y - CAP * em);
    bottom = Math.max(
      bottom,
      line.y + (hasDescender(text.slice(line.start, line.end)) ? DESCENDER * em : 0),
    );
  }
  return top === Infinity ? { top: 0, bottom: 0 } : { top, bottom };
}

function resolveBlock(
  d: TextLayerData,
  f: TextFit,
  opts: LayoutOptions,
  layout: Layout,
): { data: TextLayerData; box: Rect } {
  const W = Math.max(1, f.width);
  const gap = Number.isFinite(f.gap) ? f.gap : 0;
  const content = f.autoLines && f.height !== undefined ? autoLines(d, f, opts, layout) : d.content;
  const text = plainText(content);
  const align = content.paragraphs[0]?.style.align ?? 'left';
  const ax = anchorOf(align, W);
  const base = pointText(d, content);
  const first = layout({ ...base, origin: { x: ax, y: 0 }, block: { width: W, gap } }, opts);
  const ext = blockExtent(first, text);
  const Hs = Math.max(1e-6, ext.bottom - ext.top);
  if (f.height === undefined) {
    // The box follows the lines; the origin is the first baseline.
    const data = { ...base, origin: { ...d.origin }, block: { width: W, gap } };
    return { data, box: { x: d.origin.x - ax, y: d.origin.y + ext.top, width: W, height: Hs } };
  }
  const H = Math.max(1, f.height);
  const k = Hs > H ? H / Hs : 1;
  const y = d.origin.y + (H - Hs * k) / 2 - ext.top * k;
  const data = {
    ...base,
    origin: { x: d.origin.x + ax, y },
    block: { width: W * k, gap: gap * k },
  };
  return { data, box: { x: d.origin.x, y: d.origin.y, width: W, height: H } };
}

type Word = { start: number; end: number; para: number };
/** Paragraphs broken at spaces into the lines that, each scaled to the box
 * width and stacked, come closest to the box height. Index-preserving: a
 * break turns one space into a paragraph break. */
export function autoLines(
  d: TextLayerData,
  f: TextFit,
  opts: LayoutOptions,
  layout: Layout,
): TextContent {
  const W = Math.max(1, f.width),
    H = Math.max(1, f.height ?? 1);
  const nat = layout(pointText(d), opts);
  const text = plainText(d.content);
  const words: Word[] = [];
  const fixedLines: number[] = []; // heights (per unit width) of lines that hold no words
  const posAt = (line: TextLayout['lines'][number], i: number) => {
    const k = line.stops.indexOf(i);
    return k >= 0 ? line.stopPos[k] : line.stopPos[line.stopPos.length - 1];
  };
  const pos = new Map<number, number>();
  nat.lines.forEach((line) => {
    let w = -1;
    for (let i = line.start; i <= line.end; i++) {
      const space = i === line.end || text[i] === ' ';
      if (!space && w < 0) w = i;
      if (space && w >= 0) {
        words.push({ start: w, end: i, para: line.paragraph });
        pos.set(w, posAt(line, w));
        pos.set(i, posAt(line, i));
        w = -1;
      }
    }
    if (!words.length || words[words.length - 1].para !== line.paragraph) {
      const em = Math.max(line.ascent, 1);
      fixedLines.push((CAP * em) / Math.max(1, W));
    }
  });
  if (words.length < 2 || words.length > AUTO_WORDS) return d.content;
  const n = words.length;
  // Height of words a..b set as one line scaled to the box width, per unit of width.
  const emOf = (a: number, b: number) => {
    let em = 0;
    for (const r of nat.runs)
      if (r.end > words[a].start && r.start < words[b].end) em = Math.max(em, r.sizePx);
    return em || 1;
  };
  const heightOf = (a: number, b: number) => {
    const w = Math.abs((pos.get(words[b].end) ?? 0) - (pos.get(words[a].start) ?? 0));
    const em = emOf(a, b);
    const h =
      CAP * em + (hasDescender(text.slice(words[a].start, words[b].end)) ? DESCENDER * em : 0);
    return h / Math.max(1e-6, w);
  };
  const paras = new Set(words.map((w) => w.para)).size;
  const fixedH = fixedLines.reduce((a, b) => a + b, 0) * W;
  // Partitions into m word lines minimizing the tallest line (no word blown
  // up far past the others), for each m; the best m matches the box height.
  const maxLines = Math.min(n, paras + AUTO_EXTRA_LINES);
  // best[m][j]: lowest worst-line height for words 0..j-1 in m lines.
  const best: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let m = 0; m <= maxLines; m++) {
    best.push(new Float64Array(n + 1).fill(Infinity));
    from.push(new Int32Array(n + 1).fill(-1));
  }
  best[0][0] = 0;
  const h = new Map<number, number>();
  const cost = (a: number, b: number) => {
    const key = a * (n + 1) + b;
    let v = h.get(key);
    if (v === undefined) h.set(key, (v = heightOf(a, b)));
    return v;
  };
  // A line holds words i..j-1 of one paragraph, so paragraph ends always end lines.
  for (let m = 1; m <= maxLines; m++)
    for (let j = 1; j <= n; j++)
      for (let i = j - 1; i >= 0 && words[i].para === words[j - 1].para; i--) {
        const prev = best[m - 1][i];
        if (prev === Infinity) continue;
        const v = Math.max(prev, cost(i, j - 1));
        if (v < best[m][j]) {
          best[m][j] = v;
          from[m][j] = i;
        }
      }
  let choice: { m: number; score: number } | undefined;
  for (let m = paras; m <= maxLines; m++) {
    const starts = best[m][n] === Infinity ? undefined : trace(from, m, n);
    if (!starts) continue;
    let total = fixedH + (m + fixedLines.length - 1) * Math.max(0, f.gap);
    const ends = [...starts, n];
    for (let t = 0; t + 1 < ends.length; t++) total += cost(ends[t], ends[t + 1] - 1) * W;
    const score = Math.abs(Math.log(total / H));
    if (!choice || score < choice.score - 1e-9) choice = { m, score };
  }
  if (!choice) return d.content;
  let content = d.content;
  for (const b of trace(from, choice.m, n)!) {
    if (b === 0 || words[b - 1].para !== words[b].para) continue;
    const at = words[b - 1].end;
    if (text[at] === ' ') content = replaceRange(content, at, at + 1, '\n');
  }
  return content;
}
function trace(from: Int32Array[], m: number, n: number): number[] | undefined {
  const starts: number[] = [];
  let j = n;
  for (let k = m; k > 0; k--) {
    const i = from[k][j];
    if (i < 0) return;
    starts.push(i);
    j = i;
  }
  return j === 0 ? starts.reverse() : undefined;
}

// ------------------------------------------------------------ curves

type Curve = {
  content: TextContent;
  base: TextLayerData;
  shape: { knots: number[][]; closed: boolean };
  s: number;
  env: Rect;
};
/** The curve at its reference size, the text scale that makes the text run
 * its length, and the envelope of the glyph band along it. */
function curveOf(d: TextLayerData, f: TextFit, opts: LayoutOptions, layout: Layout): Curve {
  const preset = f.shape as Exclude<FitShape, 'block'>;
  const content = applyParagraphStyle(d.content, 0, textLength(d.content), { align: 'center' });
  const base = pointText(d, content);
  const nat = layout(base, opts);
  const lines = nat.lines.filter((l) => l.visible);
  const textW = Math.max(1, ...lines.map((l) => l.width));
  const ascent = lines[0]?.ascent ?? 1;
  const last = lines[lines.length - 1];
  const descent = last ? last.y + last.descent : 1;
  const shape = arcPresetPath(preset, REF, 0, 0, f.bend);
  const g = pathGeometry(shape.knots, shape.closed);
  const s = (g.length * (shape.closed ? CIRCLE_FILL : OPEN_FILL)) / textW;
  const span = textW * s;
  const a0 = (g.length - span) / 2;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const add = (p: [number, number]) => {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  };
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const at = a0 + (span * i) / steps;
    add(offsetPoint(g, at, -ascent * s));
    add(offsetPoint(g, at, descent * s));
  }
  return {
    content,
    base,
    shape,
    s,
    env: { x: x0, y: y0, width: Math.max(1e-6, x1 - x0), height: Math.max(1e-6, y1 - y0) },
  };
}

function resolveCurve(
  d: TextLayerData,
  f: TextFit,
  opts: LayoutOptions,
  layout: Layout,
): { data: TextLayerData; box: Rect } {
  const box = {
    x: d.origin.x,
    y: d.origin.y,
    width: Math.max(1, f.width),
    height: Math.max(1, f.height ?? f.width),
  };
  const { content, base, shape, s, env } = curveOf(d, f, opts, layout);
  const k = Math.min(box.width / env.width, box.height / env.height);
  const tx = box.x + box.width / 2 - k * (env.x + env.width / 2),
    ty = box.y + box.height / 2 - k * (env.y + env.height / 2);
  const knots = shape.knots.map((kn) => kn.map((v, i) => (i % 2 ? ty + k * v : tx + k * v)));
  const data: TextLayerData = {
    ...base,
    content: scaleTextContent(content, s * k),
    origin: { ...d.origin },
    path: {
      kind: 'path',
      knots,
      closed: shape.closed,
      start: 0,
      end: 1,
      flip: false,
      arc: {
        preset: f.shape as Exclude<FitShape, 'block'>,
        bend: f.bend,
        x: tx,
        y: ty,
        width: REF * k,
      },
    },
  };
  return { data, box };
}

// ------------------------------------------------------------ conversion

/** Ordinary text that looks like the fit now: text along the curve (still
 * adjustable as arc text), or point text whose block lines became paragraphs
 * with their sizes and line spacing baked in. */
export function releaseFit(d: TextLayerData, opts: LayoutOptions, layout: Layout): TextLayerData {
  if (!d.fit) return d;
  const { data } = resolveFit(d, opts, layout);
  if (!data.block) return data;
  return bakeBlock(data, opts, layout);
}

/** Block text as point text: line i's sizes scaled by its block scale, its
 * leading set to the distance from the previous baseline. */
export function bakeBlock(d: TextLayerData, opts: LayoutOptions, layout: Layout): TextLayerData {
  const block = d.block!;
  const plain = { ...d, block: undefined };
  const nat = layout(plain, opts);
  const placed = layout(d, opts);
  const ppi = opts.resolution ?? 72;
  const pt = (px: number) => (px * 72) / ppi;
  const align = d.content.paragraphs[0]?.style.align ?? 'left';
  const left = d.origin.x - anchorOf(align, block.width);
  const paragraphs = d.content.paragraphs.map((p, i) => {
    const natural = nat.lines.find((l) => l.paragraph === i);
    const line = placed.lines.find((l) => l.paragraph === i);
    const prev = placed.lines.find((l) => l.paragraph === i - 1);
    const s = natural && natural.width > 0.5 ? block.width / natural.width : 1;
    const scaled = scaleTextContent({ paragraphs: [p] }, s).paragraphs[0];
    const lead = line && prev ? r3(pt(line.y - prev.y)) : undefined;
    return {
      style: {
        ...scaled.style,
        align: 'left' as const,
        indentLeft: 0,
        indentRight: 0,
        indentFirst: 0,
        spaceBefore: 0,
        spaceAfter: 0,
      },
      runs: scaled.runs.map((r) => ({
        text: r.text,
        style: { ...r.style, leading: lead !== undefined && lead > 0 ? lead : r.style.leading },
      })),
    };
  });
  const firstY = placed.lines[0]?.y ?? d.origin.y;
  return { ...plain, content: { paragraphs }, origin: { x: left, y: firstY } };
}

export const DEFAULT_BEND = 50;
/** Dynamic text in `shape` from any horizontal text. `current` is the text's
 * box now (local space): new fits are centered on it and keep the type at
 * about its current size; paragraph text keeps its frame as the box; an
 * existing fit keeps its box and changes shape. */
export function fitFrom(
  d: TextLayerData,
  shape: FitShape,
  current: Rect,
  opts: LayoutOptions,
  layout: Layout,
): TextLayerData {
  const f = d.fit;
  if (f) {
    if (f.shape === shape) return d;
    if (shape === 'block')
      return {
        ...d,
        origin: { x: current.x, y: current.y },
        fit: {
          ...f,
          shape,
          height: current.height,
          gap: Math.round(current.width * 0.03),
          autoLines: true,
        },
      };
    return {
      ...d,
      origin: { x: current.x, y: current.y },
      fit: {
        ...f,
        shape,
        height: current.height,
        bend: f.shape === 'block' ? DEFAULT_BEND : f.bend,
      },
    };
  }
  const bend = d.path?.arc?.bend ?? DEFAULT_BEND;
  const flat = pointText(d);
  const make = (box: Rect, extra: Partial<TextFit> = {}): TextLayerData => ({
    ...flat,
    origin: { x: box.x, y: box.y },
    fit: {
      shape,
      width: Math.max(1, box.width),
      height: Math.max(1, box.height),
      bend,
      gap: Math.round(box.width * 0.03),
      autoLines: shape === 'block',
      ...extra,
    },
  });
  if (d.mode === 'paragraph' && d.box && !d.path)
    return make({ x: d.origin.x, y: d.origin.y, ...d.box });
  const cx = current.x + current.width / 2,
    cy = current.y + current.height / 2;
  const centered = (w: number, h: number) => ({
    x: cx - w / 2,
    y: cy - h / 2,
    width: w,
    height: h,
  });
  if (shape === 'block') {
    // Lines scaled to the widest one, as tall as they then stack.
    const nat = layout(flat, opts);
    const W = Math.max(8, ...nat.lines.map((l) => l.width));
    const probe: TextLayerData = {
      ...flat,
      fit: { shape, width: W, bend, gap: Math.round(W * 0.03), autoLines: false },
    };
    const { box } = resolveFit(probe, opts, layout);
    return make(centered(W, Math.max(8, box.height)));
  }
  // The box in which the fitted type keeps its current size.
  const { s, env } = curveOf(
    flat,
    { shape, width: 1, height: 1, bend, gap: 0, autoLines: false },
    opts,
    layout,
  );
  return make(centered(Math.max(8, env.width / s), Math.max(8, env.height / s)));
}
