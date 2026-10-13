// Text layout: clusters -> lines -> positioned glyph runs, plus caret, hit
// testing and selection geometry. All coordinates are document pixels.
//
// Measurement is injected (`Measure`) so the same code runs against canvas
// metrics in the browser, font-file metrics for outlines, and a fake
// monospace measure in Node tests. Kerning and ligatures inside a word are
// captured by measuring prefixes of same-style spans; tracking, scaling and
// justification are applied on top as explicit advances.

import { breakOpportunities, hyphenationPoints, isSpace } from './breaks';
import { bidiLevels, hasRtl, lineLevels, shapeDigits, visualRuns } from './bidi';
import { featureFamily } from './fonts';
import { featureOn } from './feature-list';
import { graphemeBoundaries, ptToPx, type Align, type CharStyle, type TextLayerData } from './model';
import { layoutOnPath, pathGeometry, shapeSpans, type PathGeometry, type PathPlacement } from './path-text';
import { applyBlock } from './block-text';

export type FontMetrics = { width: number; ascent: number; descent: number };
// `font` is a CSS font shorthand; `kerning` false asks for unkerned advances.
export type Measure = (text: string, font: string, kerning?: boolean) => FontMetrics;
export type Rect = { x: number; y: number; width: number; height: number };

// Proportions used for synthesized variants (common typesetting defaults).
export const SMALL_CAPS_SCALE = 0.7;
export const SCRIPT_SIZE = 0.583;
export const SUPERSCRIPT_RISE = 0.333;
export const SUBSCRIPT_DROP = 0.333;
export const AUTO_LEADING = 1.2;

// Resolved drawing parameters for one style variant.
export type EffectiveStyle = {
  style: CharStyle;
  font: string; // CSS shorthand at the drawn size
  sizePx: number; // drawn em size (after super/subscript and small caps)
  emPx: number; // nominal em size of the run, for leading
  scaleX: number; // fraction
  scaleY: number;
  trackPx: number; // added after each cluster
  shiftPx: number; // baseline offset, positive raises
  ascent: number; // scaled, without shift
  descent: number;
  kerning: boolean;
};

export type GlyphRun = {
  x: number; // left of the first glyph
  y: number; // baseline
  text: string; // display text (case transforms applied, hyphen appended)
  font: string;
  style: CharStyle;
  width: number; // total advance including tracking and justification
  advances: number[]; // per cluster of `clusters`
  clusters: string[]; // display text split per cluster (sums to `text`)
  sizePx: number;
  scaleX: number;
  scaleY: number;
  letterSpacing: number; // unscaled px, for canvas letterSpacing
  start: number; // source index range
  end: number;
  ascent: number;
  descent: number;
  vertical: boolean;
  kerning: boolean;
  // Right-to-left run: `text` is in logical order and drawn right to left
  // (the canvas shapes and orders it); `x` is still its left edge.
  rtl?: boolean;
  // Text on a path: the run is one cluster rotated by `angle` (radians)
  // about (x, y), its baseline origin.
  angle?: number;
};
// `points`, when present, is the decoration's centerline along a path.
// `line` is the source start of the line the decoration belongs to.
export type Decoration = { kind: 'underline' | 'strikethrough'; x: number; y: number; width: number; thickness: number; color: [number, number, number]; vertical: boolean; line?: number; points?: [number, number][] };

export type LayoutLine = {
  paragraph: number;
  start: number; // source indices; `end` includes trailing spaces, excludes '\n'
  end: number;
  x: number; // horizontal: left of the line; vertical: column center
  y: number; // horizontal: baseline; vertical: top of the first cell
  width: number; // extent along the line, trailing spaces excluded
  ascent: number;
  descent: number;
  leading: number;
  hyphen: boolean;
  lastInParagraph: boolean;
  visible: boolean;
  hang: number; // trailing clusters (spaces, breaks) that hang past `width`
  // Caret stops: source index and position along the line (x, or y if vertical).
  stops: number[];
  stopPos: number[];
  // Lines with right-to-left text: each cluster's source range and visual
  // extent, since a logical range can then cover several visual pieces.
  boxes?: { start: number; end: number; x0: number; x1: number }[];
};

export type TextLayout = {
  lines: LayoutLine[];
  runs: GlyphRun[];
  decorations: Decoration[];
  bounds: Rect; // extent of visible lines (line boxes, not ink)
  box?: Rect; // paragraph frame in document pixels
  overflow: boolean; // paragraph text that does not fit the frame
  visibleEnd: number; // first hidden source index (== length when nothing overflows)
  length: number;
  vertical: boolean;
  caretRect(index: number, affinity?: 'up' | 'down'): Rect;
  hitTest(x: number, y: number): number;
  selectionRects(start: number, end: number): Rect[];
  lineIndexAt(index: number, affinity?: 'up' | 'down'): number;
  // Up/Down arrow: index on the neighbouring line nearest `pos` (x, or y vertical).
  moveLine(index: number, dir: -1 | 1, pos?: number): number;
  // Path text: lines, carets and hit testing are in straight coordinates;
  // `map` takes them to local space and `unmap` back. `runs`, `decorations`
  // and `bounds` are already in local space.
  map?: (x: number, y: number) => [number, number];
  unmap?: (x: number, y: number) => [number, number];
  path?: PathPlacement;
  // Area text: the outline lines flow inside (local space).
  shape?: PathGeometry;
};

export type LayoutOptions = {
  measure: Measure;
  resolution?: number; // document pixels per inch; type sizes are points
  fallback?: string; // generic family appended to every CSS font
  // Point text aligned within this length from the origin (path text).
  span?: number;
};

const quote = (family: string) => (/^[\w-]+$/.test(family) && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/.test(family) ? family : `"${family.replace(/"/g, '\\"')}"`);
export function cssFont(style: Pick<CharStyle, 'family' | 'weight' | 'italic'> & { features?: string }, sizePx: number, fallback = 'sans-serif'): string {
  const size = Math.round(sizePx * 1000) / 1000;
  // OpenType features use an alias family of the same file (see fonts.ts),
  // with the plain family behind it until the alias has loaded.
  const alias = style.features ? featureFamily(style.family, style.features) : undefined;
  return `${style.italic ? 'italic ' : ''}${Math.round(style.weight)} ${size}px ${alias ? `${quote(alias)}, ` : ''}${quote(style.family)}, ${fallback}`;
}

type Cluster = {
  start: number;
  end: number;
  src: string;
  text: string; // display text
  eff: EffectiveStyle;
  adv: number;
  space: boolean;
  breakAfter: boolean;
  forced: boolean;
  soft: boolean; // soft hyphen: invisible unless it ends a line
  tab: boolean;
  // Vertical text: upright, rotated sideways, or one cell of a short run set
  // horizontally ('first' starts it, 'rest' continues it).
  form?: 'up' | 'rot' | 'first' | 'rest';
};

const isLower = (s: string) => s !== s.toUpperCase() && s === s.toLowerCase();

export function layoutText(data: TextLayerData, opts: LayoutOptions): TextLayout {
  if (data.path?.kind === 'path' && data.path.knots.length >= 2) return layoutOnPath(data, opts, layoutText);
  return layoutFlow(data, opts);
}

function layoutFlow(data: TextLayerData, opts: LayoutOptions): TextLayout {
  const ppi = opts.resolution ?? 72;
  const fallback = opts.fallback ?? 'sans-serif';
  const measure = memoMeasure(opts.measure);
  // Area text flows inside a closed outline (horizontal only).
  const area = data.path?.kind === 'area' && data.path.knots.length >= 2 ? data.path : undefined;
  const shape = area ? pathGeometry(area.knots, true) : undefined;
  const vertical = data.orientation === 'vertical' && !shape;
  const paragraphMode = (data.mode === 'paragraph' && !!data.box) || !!shape;
  const effCache = new Map<CharStyle, Map<string, EffectiveStyle>>();

  const effective = (style: CharStyle, smallCap: boolean): EffectiveStyle => {
    let m = effCache.get(style);
    if (!m) effCache.set(style, (m = new Map()));
    const key = smallCap ? 'sc' : 'n';
    const hit = m.get(key);
    if (hit) return hit;
    const emPx = ptToPx(style.size, ppi);
    const script = style.superscript || style.subscript;
    const sizePx = emPx * (script ? SCRIPT_SIZE : 1) * (smallCap ? SMALL_CAPS_SCALE : 1);
    const font = cssFont(style, sizePx, fallback);
    const fm = measure('', font);
    const scaleX = style.scaleX / 100, scaleY = style.scaleY / 100;
    const shiftPx = ptToPx(style.baselineShift, ppi) + (style.superscript ? emPx * SUPERSCRIPT_RISE : style.subscript ? -emPx * SUBSCRIPT_DROP : 0);
    const eff: EffectiveStyle = {
      style, font, sizePx, emPx, scaleX, scaleY,
      trackPx: (style.tracking / 1000) * sizePx * scaleX,
      shiftPx, ascent: fm.ascent * scaleY, descent: fm.descent * scaleY,
      kerning: style.kerning !== 'none',
    };
    m.set(key, eff);
    return eff;
  };

  // ---- clusters per paragraph
  const paras = data.content.paragraphs;
  const paraClusters: Cluster[][] = [];
  const paraStarts: number[] = [];
  const paraBidi: ({ levels: Uint8Array; text: string; base: number } | null)[] = [];
  let base = 0;
  for (const para of paras) {
    paraStarts.push(base);
    const cl: Cluster[] = [];
    let pos = base;
    for (const run of para.runs) {
      const t = run.text;
      const b = graphemeBoundaries(t);
      for (let k = 0; k + 1 < b.length; k++) {
        const src = t.slice(b[k], b[k + 1]);
        let text = src;
        let sc = false;
        if (run.style.allCaps || run.style.smallCaps) {
          const up = src.toLocaleUpperCase(run.style.language || undefined);
          if (run.style.smallCaps && !run.style.allCaps && isLower(src)) sc = true;
          text = up;
        }
        if (run.style.digits) text = shapeDigits(text, run.style.digits);
        // Fractions: a slash between digits becomes the fraction slash, which
        // the shaper builds into a fraction with the font's own forms.
        if (src === '/' && /\d/.test(t[b[k] - 1] ?? '') && /\d/.test(t[b[k + 1]] ?? '') && featureOn(run.style.features, 'frac')) text = '\u2044';
        const ch = src[0];
        cl.push({
          start: pos + b[k], end: pos + b[k + 1], src, text, eff: effective(run.style, sc), adv: 0,
          space: isSpace(ch), breakAfter: false, forced: ch === ' ', soft: ch === '­', tab: ch === '\t',
        });
      }
      pos += t.length;
    }
    const bo = breakOpportunities(cl.map((c) => c.src));
    for (let i = 0; i < cl.length; i++) cl[i].breakAfter = bo[i];
    measureClusters(cl, measure, vertical);
    paraClusters.push(cl);
    // Bidirectional text: embedding levels for the paragraph (UAX #9 basics).
    const ptext = para.runs.map((r) => r.text).join('');
    const rtlBase = para.style.direction === 'rtl';
    paraBidi.push(!vertical && (rtlBase || hasRtl(ptext)) ? { levels: bidiLevels(ptext, rtlBase ? 'rtl' : 'ltr'), text: ptext, base: rtlBase ? 1 : 0 } : null);
    base = pos + 1;
  }
  const length = Math.max(0, base - 1);

  // ---- line breaking
  // Area lines carry their own placement (`place`; null when the shape is full).
  type RawLine = { p: number; from: number; to: number; hyphen: boolean; place?: { x: number; y: number; width: number } | null };
  const raw: RawLine[] = [];
  const shapeBox = shape ? geometryBounds(shape) : undefined;
  const boxAlong = shapeBox ? shapeBox.width : paragraphMode ? (vertical ? data.box!.height : data.box!.width) : Infinity;
  if (shape) {
    // Area text: each line takes the widest span of the shape across its
    // band, found by moving down until the line fits.
    const inset = Math.max(0, area!.inset ?? 0);
    const bottom = shapeBox!.y + shapeBox!.height - inset;
    let prevBase: number | undefined;
    let full = false;
    for (let p = 0; p < paras.length; p++) {
      const ps = paras[p].style;
      const cl = paraClusters[p];
      const indL = ptToPx(ps.indentLeft, ppi), indR = ptToPx(ps.indentRight, ppi), indF = ptToPx(ps.indentFirst, ppi);
      let gap = p > 0 ? ptToPx(paras[p - 1].style.spaceAfter, ppi) + ptToPx(ps.spaceBefore, ppi) : 0;
      const trailing = cl.length > 0 && cl[cl.length - 1].forced;
      let i = 0, n = 0;
      while (n === 0 || i < cl.length || (trailing && i === cl.length && raw[raw.length - 1].to !== raw[raw.length - 1].from && raw[raw.length - 1].p === p)) {
        const e = effective(caretStyleOf(paras[p], cl, i), false);
        const asc = e.ascent + Math.max(0, e.shiftPx), desc = e.descent + Math.max(0, -e.shiftPx);
        const lead = e.style.leading === 'auto' ? e.emPx * AUTO_LEADING : ptToPx(e.style.leading, ppi);
        const ind = indL + indR + (n === 0 ? indF : 0);
        let place: RawLine['place'] = null;
        if (!full) {
          let base = prevBase === undefined ? shapeBox!.y + inset + asc + gap : prevBase + lead + gap;
          while (base + desc <= bottom + 0.01) {
            let best: [number, number] | undefined;
            for (const sp of shapeSpans(shape, base - asc, base + desc, inset)) if (sp[1] - sp[0] - ind >= e.emPx && (!best || sp[1] - sp[0] > best[1] - best[0])) best = sp;
            if (best) {
              place = { x: best[0], y: base, width: best[1] - best[0] };
              break;
            }
            base += Math.max(1, lead / 4);
          }
          if (place) prevBase = place.y;
          else full = true;
        }
        gap = 0;
        const line = i < cl.length ? breakLine(cl, i, place ? place.width - ind : Infinity, ps.hyphenate, measure) : { to: i, hyphen: false };
        raw.push({ p, from: i, ...line, place });
        n++;
        i = line.to;
      }
    }
  } else
    for (let p = 0; p < paras.length; p++) {
      const ps = paras[p].style;
      const cl = paraClusters[p];
      const indL = ptToPx(ps.indentLeft, ppi), indR = ptToPx(ps.indentRight, ppi), indF = ptToPx(ps.indentFirst, ppi);
      const avail = (first: boolean) => boxAlong - indL - indR - (first ? indF : 0);
      const lines = breakParagraph(cl, avail, ps.hyphenate && paragraphMode, measure);
      if (!lines.length) lines.push({ from: 0, to: 0, hyphen: false });
      for (const l of lines) raw.push({ p, ...l });
    }

  // ---- line geometry
  const lines: LayoutLine[] = [];
  const runs: GlyphRun[] = [];
  const decorations: Decoration[] = [];
  const box: Rect | undefined = shapeBox ?? (paragraphMode ? { x: data.origin.x, y: data.origin.y, width: data.box!.width, height: data.box!.height } : undefined);
  let cursor = 0; // distance along the block axis (down for horizontal, leftward for vertical)
  let overflow = false;
  let visibleEnd = length;
  let prevPara = -1;
  let firstLeading = 0;

  for (let li = 0; li < raw.length; li++) {
    const r = raw[li];
    const para = paras[r.p];
    const ps = para.style;
    const cl = paraClusters[r.p];
    const firstInPara = r.p !== prevPara;
    const lastInParagraph = li + 1 === raw.length || raw[li + 1].p !== r.p;
    const seg = cl.slice(r.from, r.to);
    const forcedEnd = seg.length > 0 && seg[seg.length - 1].forced;
    // Metrics from the clusters, or from the caret style on an empty line.
    const metricsFrom = seg.length ? seg.map((c) => c.eff) : [effective(caretStyleOf(para, cl, r.from), false)];
    let ascent = 0, descent = 0, leading = 0;
    for (const e of metricsFrom) {
      ascent = Math.max(ascent, e.ascent + e.shiftPx);
      descent = Math.max(descent, e.descent - e.shiftPx);
      const lead = e.style.leading === 'auto' ? e.emPx * AUTO_LEADING : ptToPx(e.style.leading, ppi);
      leading = Math.max(leading, lead);
    }
    // Hanging trailing spaces and line-ending controls do not count toward width.
    let visEnd = seg.length;
    while (visEnd > 0 && (seg[visEnd - 1].space || seg[visEnd - 1].forced || seg[visEnd - 1].soft)) visEnd--;
    const hyphenEff = r.hyphen && visEnd > 0 ? seg[visEnd - 1].eff : undefined;
    const hyphenAdv = hyphenEff ? hyphenWidth(hyphenEff, measure, vertical) : 0;

    // Block-axis position.
    if (firstInPara && prevPara >= 0) cursor += ptToPx(paras[prevPara].style.spaceAfter, ppi) + ptToPx(ps.spaceBefore, ppi);
    let blockPos: number; // baseline (horizontal) or column center offset (vertical)
    if (lines.length === 0) {
      blockPos = vertical ? leading / 2 : paragraphMode ? ascent : 0;
      cursor = blockPos;
    } else {
      cursor += vertical ? (lines[lines.length - 1].leading + leading) / 2 : leading;
      blockPos = cursor;
    }

    // Inline extent and alignment.
    const indL = ptToPx(ps.indentLeft, ppi), indR = ptToPx(ps.indentRight, ppi), indF = firstInPara ? ptToPx(ps.indentFirst, ppi) : 0;
    let contentW = hyphenAdv;
    for (let i = 0; i < visEnd; i++) contentW += seg[i].adv;
    const justifyMode = ps.align.startsWith('justify');
    const justify = paragraphMode && justifyMode && (ps.align === 'justify-all' || (!lastInParagraph && !forcedEnd));
    const lineAlong = r.place ? r.place.width : boxAlong;
    const avail = paragraphMode ? lineAlong - indL - indR - indF : contentW;
    const advs = seg.map((c) => c.adv);
    if (justify && visEnd > 0 && avail > contentW) {
      const extra = avail - contentW;
      const gaps: number[] = [];
      for (let i = 0; i < visEnd; i++) if (seg[i].space) gaps.push(i);
      if (gaps.length) for (const i of gaps) advs[i] += extra / gaps.length;
      else if (visEnd > 1) for (let i = 0; i < visEnd - 1; i++) advs[i] += extra / (visEnd - 1);
      contentW = avail;
    }
    const baseAlign: Align = justifyMode ? (ps.align === 'justify-center' ? 'center' : ps.align === 'justify-right' ? 'right' : 'left') : ps.align;
    let inlineStart: number; // offset along the line from the frame/origin start
    if (paragraphMode) {
      const slack = avail - contentW;
      inlineStart = indL + indF + (justify ? 0 : baseAlign === 'center' ? slack / 2 : baseAlign === 'right' ? slack : 0);
    } else if (opts.span !== undefined && Number.isFinite(opts.span)) {
      // Aligned between two points (path text between its markers).
      const slack = opts.span - indL - indR - indF - contentW;
      inlineStart = indL + indF + (baseAlign === 'center' ? slack / 2 : baseAlign === 'right' ? slack : 0);
    } else {
      inlineStart = indL + indF - (baseAlign === 'center' ? contentW / 2 : baseAlign === 'right' ? contentW : 0);
    }

    // Map to document coordinates.
    let lx: number, ly: number;
    if (r.place !== undefined) {
      lx = (r.place ? r.place.x : data.origin.x) + inlineStart;
      ly = r.place ? r.place.y : data.origin.y + blockPos;
    } else if (!vertical) {
      lx = data.origin.x + inlineStart;
      ly = data.origin.y + blockPos;
    } else {
      if (lines.length === 0) firstLeading = leading;
      const right = paragraphMode ? data.origin.x + data.box!.width : data.origin.x + firstLeading / 2;
      lx = right - blockPos;
      ly = data.origin.y + inlineStart;
    }
    let visible = !overflow;
    if (shape) visible = visible && !!r.place;
    else if (paragraphMode && visible)
      visible = vertical ? lx - leading / 2 >= data.origin.x - 0.01 : ly + descent <= data.origin.y + data.box!.height + 0.01;
    if (paragraphMode && !visible && !overflow) {
      overflow = true;
      visibleEnd = seg.length ? seg[0].start : paraStarts[r.p];
    }

    // Caret stops.
    const stops: number[] = [], stopPos: number[] = [];
    const lineStart = seg.length ? seg[0].start : paraStarts[r.p] + (r.from > 0 ? cl[r.from - 1].end - paraStarts[r.p] : 0);
    let acc = vertical ? ly : lx;
    stops.push(lineStart);
    stopPos.push(acc);
    for (let i = 0; i < seg.length; i++) {
      acc += advs[i];
      stops.push(seg[i].end);
      stopPos.push(acc);
    }
    const line: LayoutLine = {
      paragraph: r.p, start: lineStart, end: stops[stops.length - 1], x: lx, y: ly, width: contentW,
      ascent, descent, leading, hyphen: r.hyphen, lastInParagraph, visible, hang: seg.length - visEnd, stops, stopPos,
    };
    const bidi = paraBidi[r.p] && seg.length ? reorderLine(line, seg, advs, paraBidi[r.p]!, paraStarts[r.p]) : undefined;
    lines.push(line);
    prevPara = r.p;
    if (visible) emitRuns(line, seg, advs, visEnd, hyphenEff, hyphenAdv, justify, vertical, runs, decorations, measure, bidi);
  }

  const visLines = lines.filter((l) => l.visible);
  const bounds = unionRects(visLines.map((l) => lineRect(l, vertical)));
  const core = { lines, runs, decorations, bounds, box, overflow, visibleEnd, length, vertical, ...(shape ? { shape } : {}) };
  if (data.block && !vertical && !paragraphMode && !shape) {
    // Block text: lines scaled to one width, stacked from the first baseline.
    const align = paras[0]?.style.align ?? 'left';
    const w = data.block.width;
    const left = data.origin.x - (align === 'center' || align === 'justify-center' ? w / 2 : align === 'right' || align === 'justify-right' ? w : 0);
    const plain = paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
    return makeLayout(applyBlock(core, data.block, left, data.origin.y, (a, b) => plain.slice(a, b)));
  }
  return makeLayout(core);
}

function geometryBounds(g: PathGeometry): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < g.xs.length; i++) {
    x0 = Math.min(x0, g.xs[i]); x1 = Math.max(x1, g.xs[i]);
    y0 = Math.min(y0, g.ys[i]); y1 = Math.max(y1, g.ys[i]);
  }
  return x0 === Infinity ? { x: 0, y: 0, width: 0, height: 0 } : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function caretStyleOf(para: { runs: { text: string; style: CharStyle }[] }, cl: Cluster[], from: number): CharStyle {
  if (cl.length) return cl[Math.min(from, cl.length - 1)].eff.style;
  return para.runs[0].style;
}

function hyphenWidth(eff: EffectiveStyle, measure: Measure, vertical: boolean) {
  if (vertical) return eff.sizePx * eff.scaleY + eff.trackPx;
  return measure('-', eff.font, eff.kerning).width * eff.scaleX + eff.trackPx;
}

// Characters that stay upright in vertical text whatever the style says:
// ideographs, kana, hangul and full-width forms.
const UPRIGHT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
// Most characters a short horizontal run may hold in one cell.
export const COMBINE_MAX = 3;
/** How each cluster of vertical text is set (CharStyle.vertical): upright
 * (default), rotated sideways ('rotate'), or for 'combine' a run of up to
 * COMBINE_MAX characters set horizontally in one cell, longer runs rotated. */
function verticalForms(cl: Cluster[]) {
  const mode = (c: Cluster) => (c.forced || c.soft || UPRIGHT.test(c.src) ? '' : (c.eff.style.vertical ?? ''));
  for (let i = 0; i < cl.length; ) {
    const m = mode(cl[i]);
    if (m === 'rotate') {
      cl[i++].form = 'rot';
      continue;
    }
    if (m !== 'combine' || cl[i].space) {
      // Spaces inside rotated text keep their own width.
      cl[i].form = m === 'combine' && cl[i - 1]?.form === 'rot' ? 'rot' : 'up';
      i++;
      continue;
    }
    let j = i;
    while (j < cl.length && mode(cl[j]) === 'combine' && !cl[j].space) j++;
    const short = j - i <= COMBINE_MAX;
    for (let k = i; k < j; k++) cl[k].form = short ? (k === i ? 'first' : 'rest') : 'rot';
    i = j;
  }
}

// Advances for every cluster: the cluster's own width plus the kerning
// against the previous same-style cluster, where kerning is measured as
// w(ab) - w(a) - w(b). With the persistent measure cache this needs one
// measurement per distinct character and pair, so re-layout while typing is
// almost free, and it equals prefix measurement for pairwise (GPOS) kerning.
function measureClusters(cl: Cluster[], measure: Measure, vertical: boolean) {
  if (vertical) {
    // Upright stacked glyphs advance one em plus tracking; text rotated
    // sideways advances by its width; a short run set horizontally takes one cell.
    verticalForms(cl);
    let prev: Cluster | undefined;
    let prevW = 0;
    for (const c of cl) {
      const e = c.eff;
      if (c.forced || c.soft || c.form === 'rest') { c.adv = 0; prev = undefined; continue; }
      if (c.form !== 'rot') { c.adv = e.sizePx * e.scaleY + e.trackPx; prev = undefined; continue; }
      const w = measure(c.text, e.font, e.kerning).width;
      let kern = 0;
      if (e.kerning && prev && prev.eff === e) kern = measure(prev.text + c.text, e.font, true).width - prevW - w;
      c.adv = (w + kern) * e.scaleX + e.trackPx;
      prev = c;
      prevW = w;
    }
    return;
  }
  let prev: Cluster | undefined;
  let prevW = 0;
  for (const c of cl) {
    const eff = c.eff;
    if (c.forced || c.soft) { c.adv = 0; prev = undefined; continue; }
    if (c.tab) {
      // Tabs advance four spaces' width.
      c.adv = measure(' ', eff.font, eff.kerning).width * eff.scaleX * 4 + eff.trackPx;
      prev = undefined;
      continue;
    }
    const w = measure(c.text, eff.font, eff.kerning).width;
    let kern = 0;
    if (eff.kerning && prev && prev.eff === eff) {
      const sep = eff.style.ligatures ? '' : '\u200c';
      kern = measure(prev.text + sep + c.text, eff.font, true).width - prevW - w;
    }
    c.adv = (w + kern) * eff.scaleX + eff.trackPx;
    prev = c;
    prevW = w;
  }
}

type BrokenLine = { from: number; to: number; hyphen: boolean };
// Greedy line filling (first fit), with optional hyphenation of the word that
// overflows and character breaks for words longer than the line.
function breakParagraph(cl: Cluster[], avail: (first: boolean) => number, hyphenate: boolean, measure: Measure): BrokenLine[] {
  const out: BrokenLine[] = [];
  let i = 0;
  while (i < cl.length) {
    const { to, hyphen } = breakLine(cl, i, avail(out.length === 0), hyphenate, measure);
    out.push({ from: i, to, hyphen });
    i = to;
  }
  // A paragraph ending in a forced break gets an empty last line for the caret.
  if (cl.length && cl[cl.length - 1].forced) out.push({ from: cl.length, to: cl.length, hyphen: false });
  return out;
}

// One line starting at cluster `i` within `max` pixels.
function breakLine(cl: Cluster[], i: number, max: number, hyphenate: boolean, measure: Measure): { to: number; hyphen: boolean } {
  let width = 0;
  let lastBreak = -1;
  let j = i;
  let end = -1;
  let hyphen = false;
  for (; j < cl.length; j++) {
    const c = cl[j];
    if (c.forced) { end = j + 1; break; }
    if (c.space) {
      width += c.adv;
      if (c.breakAfter) lastBreak = j;
      continue;
    }
    if (j > i && width + c.adv > max + 1e-6) {
      if (hyphenate) {
        const h = tryHyphenate(cl, i, lastBreak, j, width, max, measure);
        if (h > 0) { end = h; hyphen = true; break; }
      }
      // Soft hyphen chosen as the break: show it.
      end = lastBreak >= i ? lastBreak + 1 : j;
      hyphen = lastBreak >= i && cl[lastBreak].soft;
      break;
    }
    width += c.adv;
    if (c.breakAfter) lastBreak = j;
  }
  if (end < 0) end = cl.length;
  return { to: end, hyphen };
}

function tryHyphenate(cl: Cluster[], lineStart: number, lastBreak: number, over: number, widthBefore: number, max: number, measure: Measure): number {
  const ws = Math.max(lineStart, lastBreak + 1);
  let we = over;
  while (we < cl.length && !cl[we].space && !cl[we - 1].breakAfter && !cl[we].forced) we++;
  const word = cl.slice(ws, we).map((c) => c.src).join('');
  if (word.length !== we - ws) return 0; // clusters must be single code units for offsets to line up
  const pts = hyphenationPoints(word);
  if (!pts.length) return 0;
  // Width of the line up to the word start.
  let base = widthBefore;
  for (let k = ws; k < over; k++) base -= cl[k].adv;
  for (let p = pts.length - 1; p >= 0; p--) {
    const cut = ws + pts[p];
    if (cut > over) continue;
    let w = base;
    for (let k = ws; k < cut; k++) w += cl[k].adv;
    const eff = cl[cut - 1].eff;
    w += measure('-', eff.font, eff.kerning).width * eff.scaleX + eff.trackPx;
    if (w <= max + 1e-6) return cut;
  }
  return 0;
}

type LineBidi = { vx: number[]; order: { start: number; end: number; level: number }[] };
// Reorders a horizontal line's clusters visually (L2): positions each
// cluster, then places caret stops on the leading edge of the cluster that
// follows them in logical order.
function reorderLine(line: LayoutLine, seg: Cluster[], advs: number[], bidi: { levels: Uint8Array; text: string; base: number }, paraStart: number): LineBidi | undefined {
  const a = seg[0].start - paraStart,
    b = seg[seg.length - 1].end - paraStart;
  const lv = lineLevels(bidi.levels, bidi.text, a, b, bidi.base);
  const levels = seg.map((c) => lv[c.start - paraStart - a] ?? bidi.base);
  if (levels.every((l) => l === 0)) return undefined;
  const order = visualRuns(levels, 0, seg.length);
  const vx = new Array<number>(seg.length);
  let x = line.x;
  for (const r of order) {
    const idx: number[] = [];
    for (let i = r.start; i < r.end; i++) idx.push(i);
    if (r.level & 1) idx.reverse();
    for (const i of idx) {
      vx[i] = x;
      x += advs[i];
    }
  }
  const n = seg.length;
  for (let k = 0; k <= n; k++) {
    if (k < n) line.stopPos[k] = levels[k] & 1 ? vx[k] + advs[k] : vx[k];
    else line.stopPos[k] = levels[n - 1] & 1 ? vx[n - 1] : vx[n - 1] + advs[n - 1];
  }
  line.boxes = seg.map((c, i) => ({ start: c.start, end: c.end, x0: vx[i], x1: vx[i] + advs[i] }));
  return { vx, order };
}

function emitRuns(
  line: LayoutLine, seg: Cluster[], advs: number[], visEnd: number, hyphenEff: EffectiveStyle | undefined, hyphenAdv: number,
  justify: boolean, vertical: boolean, runs: GlyphRun[], decorations: Decoration[], measure: Measure, bidi?: LineBidi,
) {
  const pos = line.stopPos;
  if (bidi) {
    // Visual pieces: same style and level, adjacent in visual order.
    for (const vr of bidi.order) {
      const rtl = (vr.level & 1) === 1;
      let i = vr.start;
      while (i < vr.end) {
        if (i >= visEnd || (seg[i].space && justify) || seg[i].soft || seg[i].forced) { i++; continue; }
        let j = i + 1;
        while (j < vr.end && j < visEnd && seg[j].eff === seg[i].eff && !seg[j].soft && !seg[j].forced && !(justify && seg[j].space)) j++;
        const e = seg[i].eff;
        const clusters = seg.slice(i, j).map((c) => c.text);
        const advances = advs.slice(i, j);
        const width = advances.reduce((a, b) => a + b, 0);
        let x0 = Infinity;
        for (let k = i; k < j; k++) x0 = Math.min(x0, bidi.vx[k]);
        if (j === visEnd && hyphenEff === e) {
          clusters.push('-');
          advances.push(hyphenAdv);
        }
        runs.push({
          x: x0, y: line.y - e.shiftPx, text: clusters.join(''), font: e.font, style: e.style, width, advances, clusters,
          sizePx: e.sizePx, scaleX: e.scaleX, scaleY: e.scaleY, letterSpacing: e.scaleX ? e.trackPx / e.scaleX : 0,
          start: seg[i].start, end: seg[j - 1].end, ascent: e.ascent, descent: e.descent, vertical: false, kerning: e.kerning, rtl,
        });
        i = j;
      }
    }
    decorate(line, seg, advs, visEnd, hyphenEff ? hyphenAdv : 0, vertical, decorations, bidi.vx);
    return;
  }
  if (vertical) {
    for (let i = 0; i < visEnd; i++) {
      const c = seg[i];
      if (c.form === 'rot' && !c.soft && !c.forced) {
        // Sideways: one run along the column, tops facing right, centered on it.
        const e = c.eff;
        let j = i + 1;
        while (j < visEnd && seg[j].form === 'rot' && seg[j].eff === e && !seg[j].soft && !seg[j].forced) j++;
        const advances = advs.slice(i, j);
        runs.push({
          x: line.x - (e.ascent - e.descent) / 2, y: pos[i], text: seg.slice(i, j).map((x) => x.text).join(''), font: e.font, style: e.style,
          width: advances.reduce((a, b) => a + b, 0), advances, clusters: seg.slice(i, j).map((x) => x.text), sizePx: e.sizePx, scaleX: e.scaleX, scaleY: e.scaleY,
          letterSpacing: e.scaleX ? e.trackPx / e.scaleX : 0, start: c.start, end: seg[j - 1].end, ascent: e.ascent, descent: e.descent, vertical: false, kerning: e.kerning,
          angle: Math.PI / 2,
        });
        i = j - 1;
        continue;
      }
      if (c.form === 'first') {
        // A short run set horizontally in one cell, condensed to fit it.
        const e = c.eff;
        let j = i + 1;
        while (j < visEnd && seg[j].form === 'rest') j++;
        const widths = seg.slice(i, j).map((x) => measure(x.text, x.eff.font, x.eff.kerning).width * e.scaleX);
        const total = widths.reduce((a, b) => a + b, 0) || 1;
        const fit = Math.min(1, e.sizePx / total);
        const glyphH = e.ascent + e.descent;
        runs.push({
          x: line.x - (total * fit) / 2, y: pos[i] + (advs[i] - e.trackPx - glyphH) / 2 + e.ascent, text: seg.slice(i, j).map((x) => x.text).join(''), font: e.font, style: e.style,
          width: total * fit, advances: widths.map((w) => w * fit), clusters: seg.slice(i, j).map((x) => x.text), sizePx: e.sizePx, scaleX: e.scaleX * fit, scaleY: e.scaleY,
          letterSpacing: 0, start: c.start, end: seg[j - 1].end, ascent: e.ascent, descent: e.descent, vertical: false, kerning: e.kerning,
        });
        i = j - 1;
        continue;
      }
      if (c.space || c.soft || c.forced) continue;
      const e = c.eff;
      const w = measure(c.text, e.font, e.kerning).width * e.scaleX;
      const cellTop = pos[i];
      const glyphH = e.ascent + e.descent;
      runs.push({
        x: line.x - w / 2 + 0, y: cellTop + (advs[i] - e.trackPx - glyphH) / 2 + e.ascent, text: c.text, font: e.font, style: e.style,
        width: w, advances: [w], clusters: [c.text], sizePx: e.sizePx, scaleX: e.scaleX, scaleY: e.scaleY, letterSpacing: 0,
        start: c.start, end: c.end, ascent: e.ascent, descent: e.descent, vertical: true, kerning: e.kerning,
      });
    }
    if (hyphenEff && visEnd > 0) {
      const top = pos[visEnd];
      runs.push({
        x: line.x - hyphenEff.sizePx * 0.1, y: top + hyphenEff.ascent, text: '|', font: hyphenEff.font, style: hyphenEff.style,
        width: hyphenEff.sizePx * 0.2, advances: [hyphenEff.sizePx * 0.2], clusters: ['|'], sizePx: hyphenEff.sizePx, scaleX: 1, scaleY: 1,
        letterSpacing: 0, start: seg[visEnd - 1].end, end: seg[visEnd - 1].end, ascent: hyphenEff.ascent, descent: hyphenEff.descent, vertical: true, kerning: true,
      });
    }
    decorate(line, seg, advs, visEnd, 0, vertical, decorations);
    return;
  }
  let i = 0;
  while (i < visEnd) {
    const c = seg[i];
    if ((c.space && justify) || c.soft || c.forced) { i++; continue; }
    let j = i + 1;
    while (j < visEnd && seg[j].eff === c.eff && !seg[j].soft && !seg[j].forced && !(justify && seg[j].space)) j++;
    const clusters = seg.slice(i, j).map((s) => s.text);
    const advances = advs.slice(i, j);
    let width = pos[j] - pos[i];
    const e = c.eff;
    if (j === visEnd && hyphenEff === e) {
      clusters.push('-');
      advances.push(hyphenAdv);
      width += hyphenAdv;
    }
    runs.push({
      x: pos[i], y: line.y - e.shiftPx, text: clusters.join(''), font: e.font, style: e.style, width, advances, clusters,
      sizePx: e.sizePx, scaleX: e.scaleX, scaleY: e.scaleY, letterSpacing: e.scaleX ? e.trackPx / e.scaleX : 0,
      start: seg[i].start, end: seg[j - 1].end, ascent: e.ascent, descent: e.descent, vertical: false, kerning: e.kerning,
    });
    i = j;
  }
  // A hyphen whose style differs from the last run's gets its own run.
  if (hyphenEff && visEnd > 0 && runs.length && runs[runs.length - 1].clusters[runs[runs.length - 1].clusters.length - 1] !== '-') {
    const e = hyphenEff;
    runs.push({
      x: pos[visEnd], y: line.y - e.shiftPx, text: '-', font: e.font, style: e.style, width: hyphenAdv, advances: [hyphenAdv], clusters: ['-'],
      sizePx: e.sizePx, scaleX: e.scaleX, scaleY: e.scaleY, letterSpacing: e.scaleX ? e.trackPx / e.scaleX : 0,
      start: seg[visEnd - 1].end, end: seg[visEnd - 1].end, ascent: e.ascent, descent: e.descent, vertical: false, kerning: e.kerning,
    });
  }
  decorate(line, seg, advs, visEnd, hyphenEff ? hyphenAdv : 0, vertical, decorations);
}

// Underline and strikethrough segments, continuous across inner spaces.
function decorate(line: LayoutLine, seg: Cluster[], advs: number[], visEnd: number, hyphenAdv: number, vertical: boolean, out: Decoration[], xs?: number[]) {
  for (const kind of ['underline', 'strikethrough'] as const) {
    for (let i = 0; i < visEnd; i++) {
      const st = seg[i].eff.style;
      if (kind === 'underline' ? !st.underline : !st.strikethrough) continue;
      const e = seg[i].eff;
      const thickness = Math.max(1, e.emPx / 16);
      const has = (c: Cluster | undefined) => !!c && (kind === 'underline' ? c.eff.style.underline : c.eff.style.strikethrough);
      let len = advs[i] + (i === visEnd - 1 ? hyphenAdv : 0);
      // No tracking tail after the last decorated glyph.
      if ((i === visEnd - 1 && !hyphenAdv) || (i < visEnd - 1 && !has(seg[i + 1]))) len -= e.trackPx;
      const color = st.color;
      let d: Decoration;
      if (!vertical) {
        const y = kind === 'underline' ? line.y - e.shiftPx + e.emPx * 0.1 : line.y - e.shiftPx - e.ascent * 0.3;
        d = { kind, x: xs ? xs[i] : line.stopPos[i], y, width: len, thickness, color, vertical, line: line.start };
      } else {
        const x = kind === 'underline' ? line.x + e.sizePx * 0.6 : line.x;
        d = { kind, x, y: line.stopPos[i], width: len, thickness, color, vertical, line: line.start };
      }
      const last = out[out.length - 1];
      const contiguous = last && last.kind === kind && last.thickness === d.thickness && last.color.every((v, k) => v === color[k])
        && (vertical
          ? Math.abs(last.x - d.x) < 1e-6 && Math.abs(last.y + last.width - d.y) < 1e-3
          : Math.abs(last.y - d.y) < 1e-6 && Math.abs(last.x + last.width - d.x) < 1e-3);
      if (contiguous) last.width += d.width;
      else out.push(d);
    }
  }
}

function lineRect(l: LayoutLine, vertical: boolean): Rect {
  if (!vertical) return { x: l.x, y: l.y - l.ascent, width: l.width, height: l.ascent + l.descent };
  return { x: l.x - l.leading / 2, y: l.y, width: l.leading, height: l.width };
}
function unionRects(rs: Rect[]): Rect {
  if (!rs.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Measurements persist across layouts (per measure function) until fonts
// change; `invalidateMeasurements` is called when a font face finishes loading.
let measureGeneration = 0;
const measureCaches = new WeakMap<Measure, { gen: number; map: Map<string, FontMetrics> }>();
export function invalidateMeasurements() { measureGeneration++; }
function memoMeasure(m: Measure): Measure {
  let entry = measureCaches.get(m);
  if (!entry || entry.gen !== measureGeneration || entry.map.size > 200_000) measureCaches.set(m, (entry = { gen: measureGeneration, map: new Map() }));
  const cache = entry.map;
  return (text, font, kerning = true) => {
    const key = `${kerning ? 1 : 0}\u0000${font}\u0000${text}`;
    let r = cache.get(key);
    if (!r) cache.set(key, (r = m(text, font, kerning)));
    return r;
  };
}

type LayoutCore = Omit<TextLayout, 'caretRect' | 'hitTest' | 'selectionRects' | 'lineIndexAt' | 'moveLine'>;
function makeLayout(core: LayoutCore): TextLayout {
  const { lines, vertical } = core;
  const lineIndexAt = (index: number, affinity: 'up' | 'down' = 'down') => {
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (index < l.start) break;
      if (index <= l.end) {
        found = i;
        // At a soft wrap the downstream caret belongs to the next line.
        if (index === l.end && !l.lastInParagraph && affinity === 'down') continue;
        break;
      }
    }
    return found < 0 ? Math.max(0, lines.length - 1) : found;
  };
  const posOf = (l: LayoutLine, index: number) => {
    for (let k = 0; k < l.stops.length; k++) if (l.stops[k] >= index) return l.stopPos[k];
    return l.stopPos[l.stopPos.length - 1];
  };
  const caretRect = (index: number, affinity: 'up' | 'down' = 'down'): Rect => {
    const l = lines[lineIndexAt(index, affinity)];
    const p = posOf(l, index);
    if (!vertical) return { x: p, y: l.y - l.ascent, width: 0, height: l.ascent + l.descent };
    return { x: l.x - l.leading / 2, y: p, width: l.leading, height: 0 };
  };
  const indexInLine = (l: LayoutLine, pos: number) => {
    // Clicking past a soft-wrapped line's trailing space lands before it: the
    // stop after the space is the next line's start.
    let last = l.stops.length - 1;
    if (!l.lastInParagraph && l.hang > 0) last--;
    let best = 0, bestD = Infinity;
    for (let k = 0; k <= last; k++) {
      const d = Math.abs(l.stopPos[k] - pos);
      if (d < bestD) { bestD = d; best = k; }
    }
    return l.stops[best];
  };
  const visibleLines = lines.filter((l) => l.visible);
  const hitPool = visibleLines.length ? visibleLines : lines;
  const hitTest = (x: number, y: number) => {
    let best = hitPool[0], bestD = Infinity;
    for (const l of hitPool) {
      const d = vertical
        ? Math.max(l.x - l.leading / 2 - x, 0, x - (l.x + l.leading / 2))
        : Math.max(l.y - l.ascent - y, 0, y - (l.y + l.descent));
      if (d < bestD - 1e-9) { bestD = d; best = l; }
    }
    return indexInLine(best, vertical ? y : x);
  };
  const selectionRects = (start: number, end: number): Rect[] => {
    const a = Math.min(start, end), b = Math.max(start, end);
    const out: Rect[] = [];
    if (a === b) return out;
    for (const l of lines) {
      if (!l.visible || l.end < a || l.start > b || (l.end === a && l.start !== l.end)) continue;
      if (l.boxes && !vertical) {
        // Right-to-left text: one rectangle per visually contiguous piece.
        const spans = l.boxes.filter((x) => x.start >= a && x.end <= b).map((x) => [x.x0, x.x1]).sort((p, q) => p[0] - q[0]);
        for (const [x0, x1] of spans) {
          const last = out[out.length - 1];
          if (last && last.y === l.y - l.ascent && Math.abs(last.x + last.width - x0) < 0.5) last.width = x1 - last.x;
          else out.push({ x: x0, y: l.y - l.ascent, width: x1 - x0, height: l.ascent + l.descent });
        }
        continue;
      }
      const p0 = posOf(l, Math.max(a, l.start));
      // A selection that continues past the line covers its trailing spaces.
      const p1 = b > l.end ? l.stopPos[l.stopPos.length - 1] : posOf(l, Math.min(b, l.end));
      const lo = Math.min(p0, p1), hi = Math.max(p0, p1);
      if (hi - lo <= 0 && !(b > l.end)) continue;
      const w = Math.max(hi - lo, b > l.end ? 4 : 0);
      if (!vertical) out.push({ x: lo, y: l.y - l.ascent, width: w, height: l.ascent + l.descent });
      else out.push({ x: l.x - l.leading / 2, y: lo, width: l.leading, height: w });
    }
    return out;
  };
  const moveLine = (index: number, dir: -1 | 1, pos?: number) => {
    const li = lineIndexAt(index);
    const target = li + dir;
    const l = lines[li];
    const at = pos ?? posOf(l, index);
    if (target < 0) return lines[0].start;
    if (target >= lines.length) return lines[lines.length - 1].end;
    return indexInLine(lines[target], at);
  };
  return { ...core, caretRect, hitTest, selectionRects, lineIndexAt, moveLine };
}
